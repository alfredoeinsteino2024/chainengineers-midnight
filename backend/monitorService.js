/*
 * monitorService.js — ChainEngineers × Midnight
 *
 * Dedicated blockchain monitor: watches the Midnight Indexer for
 * payment confirmations and emits events back to server.js.
 *
 * Why this exists instead of inline polling in server.js:
 *   - Manages multiple payments simultaneously (queue-based)
 *   - Single GraphQL connection shared across all watchers
 *   - Survives Indexer blips with automatic reconnect + backoff
 *   - Clean EventEmitter interface keeps server.js uncluttered
 *
 * Usage in server.js:
 *   const monitor = require('./monitorService');
 *   monitor.start();
 *   monitor.watch(payment_id, { dustAmount, contractAddress });
 *   monitor.on('confirmed', ({ payment_id, txHash }) => { ... });
 *   monitor.on('expired',   ({ payment_id }) => { ... });
 *   monitor.on('error',     ({ payment_id, message }) => { ... });
 *
 * Install:
 *   npm install node-fetch@2   (already in package.json from server.js)
 */

'use strict';

const EventEmitter = require('events');
const fetch        = require('node-fetch');

/* ══════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════ */
const MIDNIGHT_ENV = process.env.MIDNIGHT_ENV || 'local';

const INDEXER_URL = MIDNIGHT_ENV === 'preprod'
    ? (process.env.MIDNIGHT_INDEXER_URL || 'https://indexer.preprod-02.midnight.network/api/v1/graphql')
    : 'http://localhost:8088/api/v1/graphql';

const POLL_INTERVAL_MS  = Number(process.env.MONITOR_POLL_MS)  || 5_000;   // how often to poll
const PAYMENT_TTL_MS    = Number(process.env.PAYMENT_TTL_MS)   || 300_000; // 5 min expiry
const MAX_BACKOFF_MS    = 60_000;  // max wait between retries on indexer failure
const DEMO_CONFIRM_MS   = 10_000; // demo mode: auto-confirm after this delay

/* ══════════════════════════════════════════════
   MONITOR SERVICE CLASS
══════════════════════════════════════════════ */
class MonitorService extends EventEmitter {
    constructor() {
        super();

        /*
         * pending: Map<payment_id → WatchEntry>
         * WatchEntry: {
         *   payment_id      : string
         *   dustAmount      : number
         *   contractAddress : string | null
         *   createdAt       : number  (Date.now())
         *   expiresAt       : number
         *   seenTxHashes    : Set<string>   (avoid double-firing)
         *   demoTimer       : Timeout | null
         * }
         */
        this.pending      = new Map();
        this._pollTimer   = null;
        this._running     = false;
        this._backoff     = POLL_INTERVAL_MS;
        this._failStreak  = 0;
        this._lastBlock   = null;
    }

    /* ────────────────────────────────────────
       start() / stop()
    ──────────────────────────────────────── */
    start() {
        if (this._running) return;
        this._running = true;
        this._log('Monitor started');
        this._schedulePoll();
    }

    stop() {
        this._running = false;
        if (this._pollTimer) clearTimeout(this._pollTimer);
        this._log('Monitor stopped');
    }

    /* ────────────────────────────────────────
       watch(payment_id, opts)
       Register a payment to watch.
       opts.contractAddress — if null, runs in demo mode
       opts.dustAmount      — for logging only
    ──────────────────────────────────────── */
    watch(payment_id, opts = {}) {
        if (this.pending.has(payment_id)) return; // already watching

        const entry = {
            payment_id,
            dustAmount      : opts.dustAmount      || 0,
            contractAddress : opts.contractAddress || process.env.CONTRACT_ADDRESS || null,
            createdAt       : Date.now(),
            expiresAt       : Date.now() + PAYMENT_TTL_MS,
            seenTxHashes    : new Set(),
            demoTimer       : null,
        };

        this.pending.set(payment_id, entry);
        this._log(`Watching | ID=${payment_id} | ${entry.dustAmount} DUST | contract=${entry.contractAddress ? entry.contractAddress.slice(0, 16) + '…' : 'DEMO'}`);

        // Demo mode: no contract deployed → auto-confirm after delay
        if (!entry.contractAddress) {
            this._log(`Demo mode | ID=${payment_id} | auto-confirm in ${DEMO_CONFIRM_MS / 1000}s`);
            entry.demoTimer = setTimeout(() => {
                if (this.pending.has(payment_id)) {
                    this._confirm(payment_id, 'DEMO_TX_' + payment_id);
                }
            }, DEMO_CONFIRM_MS);
        }
    }

    /* ────────────────────────────────────────
       unwatch(payment_id)
       Remove from queue (call after confirmed/expired)
    ──────────────────────────────────────── */
    unwatch(payment_id) {
        const entry = this.pending.get(payment_id);
        if (entry?.demoTimer) clearTimeout(entry.demoTimer);
        this.pending.delete(payment_id);
    }

    /* ────────────────────────────────────────
       status()
       Returns a snapshot of what's being watched.
    ──────────────────────────────────────── */
    status() {
        return {
            running    : this._running,
            lastBlock  : this._lastBlock,
            pendingCount: this.pending.size,
            pending    : Array.from(this.pending.values()).map(e => ({
                payment_id  : e.payment_id,
                dustAmount  : e.dustAmount,
                ageSeconds  : Math.floor((Date.now() - e.createdAt) / 1000),
                expiresIn   : Math.max(0, Math.floor((e.expiresAt - Date.now()) / 1000)),
                demo        : !e.contractAddress,
            })),
        };
    }

    /* ══════════════════════════════════════
       INTERNAL — POLL LOOP
    ══════════════════════════════════════ */
    _schedulePoll() {
        if (!this._running) return;
        this._pollTimer = setTimeout(() => this._poll(), this._backoff);
    }

    async _poll() {
        if (!this._running) return;

        // Skip if nothing to watch
        const activePending = Array.from(this.pending.values())
            .filter(e => e.contractAddress); // demo entries handled by timer

        if (activePending.length === 0) {
            this._checkExpiry();
            this._backoff = POLL_INTERVAL_MS;
            this._schedulePoll();
            return;
        }

        try {
            // Fetch latest block to detect if indexer is alive
            const blockData = await this._gql(`
                query {
                    block(order: { height: DESC }, first: 1) {
                        nodes { height }
                    }
                }
            `);
            const height = blockData?.block?.nodes?.[0]?.height;
            if (height && height !== this._lastBlock) {
                this._lastBlock = height;
                this._log(`Block ${height} | watching ${activePending.length} payment(s)`);
            }

            // Group payments by contract address (one query per unique contract)
            const byContract = new Map();
            for (const entry of activePending) {
                if (!byContract.has(entry.contractAddress)) {
                    byContract.set(entry.contractAddress, []);
                }
                byContract.get(entry.contractAddress).push(entry);
            }

            for (const [contractAddr, entries] of byContract) {
                await this._checkContract(contractAddr, entries);
            }

            // Reset backoff on success
            this._failStreak = 0;
            this._backoff    = POLL_INTERVAL_MS;

        } catch (err) {
            this._failStreak++;
            // Exponential backoff: 5s → 10s → 20s → ... → 60s max
            this._backoff = Math.min(POLL_INTERVAL_MS * Math.pow(2, this._failStreak), MAX_BACKOFF_MS);
            this._log(`Indexer error (streak ${this._failStreak}, next poll in ${this._backoff / 1000}s): ${err.message}`);
            this.emit('indexer_error', { message: err.message, streak: this._failStreak });
        }

        this._checkExpiry();
        this._schedulePoll();
    }

    /* ══════════════════════════════════════
       INTERNAL — CONTRACT STATE CHECK
    ══════════════════════════════════════ */
    async _checkContract(contractAddr, entries) {
        /*
         * Query the last 20 transactions for this contract address.
         * The Compact payment contract's public ledger stores:
         *   { payment_ref: string, payment_status: 'PENDING' | 'PAID' }
         *
         * When a customer calls pay() and the ZK proof is verified,
         * the ledger transitions to PAID. We look for that here.
         *
         * ⚠ Adjust query field names to match your Indexer version.
         *   Introspect at: http://localhost:8088/api/v1/graphql
         */
        const data = await this._gql(`
            query ContractTxs($addr: String!) {
                contractTransactions(contractAddress: $addr, last: 20) {
                    nodes {
                        txHash
                        blockHeight
                        contractState
                    }
                }
            }
        `, { addr: contractAddr });

        const txs = data?.contractTransactions?.nodes || [];
        if (txs.length === 0) return;

        for (const tx of txs) {
            if (!tx.contractState || !tx.txHash) continue;

            // Parse public ledger state
            let state;
            try {
                state = typeof tx.contractState === 'string'
                    ? JSON.parse(tx.contractState)
                    : tx.contractState;
            } catch {
                continue;
            }

            const stateStr = JSON.stringify(state);

            for (const entry of entries) {
                if (entry.seenTxHashes.has(tx.txHash)) continue;

                /*
                 * Match conditions — adjust to your Compact ledger field names:
                 *   state.payment_ref    === entry.payment_id
                 *   state.payment_status === 'PAID'
                 *
                 * The fallback string search handles different serialisation formats.
                 */
                const refMatches  = state?.payment_ref === entry.payment_id
                                 || stateStr.includes(entry.payment_id);
                const isPaid      = state?.payment_status === 'PAID'
                                 || stateStr.includes('"PAID"');

                if (refMatches && isPaid) {
                    entry.seenTxHashes.add(tx.txHash);
                    this._confirm(entry.payment_id, tx.txHash);
                }
            }
        }
    }

    /* ══════════════════════════════════════
       INTERNAL — EXPIRY CHECK
    ══════════════════════════════════════ */
    _checkExpiry() {
        const now = Date.now();
        for (const [id, entry] of this.pending) {
            if (now >= entry.expiresAt) {
                this._log(`Expired | ID=${id}`);
                this.emit('expired', { payment_id: id });
                this.unwatch(id);
            }
        }
    }

    /* ══════════════════════════════════════
       INTERNAL — CONFIRM
    ══════════════════════════════════════ */
    _confirm(payment_id, txHash) {
        this._log(`Confirmed | ID=${payment_id} | tx=${txHash.slice(0, 20)}…`);
        this.emit('confirmed', { payment_id, txHash });
        this.unwatch(payment_id);
    }

    /* ══════════════════════════════════════
       INTERNAL — GRAPHQL HELPER
    ══════════════════════════════════════ */
    async _gql(query, variables = {}) {
        const res = await fetch(INDEXER_URL, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify({ query, variables }),
            timeout : 8000,
        });
        if (!res.ok) throw new Error(`Indexer HTTP ${res.status}`);
        const json = await res.json();
        if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
        return json.data;
    }

    _log(msg) {
        console.log(`[${new Date().toLocaleTimeString()}] [Monitor] ${msg}`);
    }
}

/* ══════════════════════════════════════════════
   SINGLETON EXPORT
   Import the same instance everywhere:
     const monitor = require('./monitorService');
══════════════════════════════════════════════ */
module.exports = new MonitorService();
