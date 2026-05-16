/*
 * server.js — ChainEngineers Payment Terminal Backend
 * Phase 4: Midnight Network Integration
 * Adapted from Solana Devnet (Phase 3.1)
 *
 * What changed from the Solana version:
 *   - @solana/web3.js removed → Midnight Indexer GraphQL (via node-fetch)
 *   - SOL keypair → Bech32m terminal address (receive-only; no secret key in backend)
 *   - SOL_PER_NAIRA → DUST_PER_NAIRA
 *   - Signature polling → contract state polling via Indexer
 *   - QR scheme: solana:… → midnight:…
 *   - tx_signature → tx_hash throughout
 *
 * Endpoints (same API surface as v3.1 — C terminal unchanged):
 *   GET  /health              → health check
 *   POST /payment/create      → create payment session
 *   GET  /payment/:id/status  → poll payment status
 *   GET  /history             → last 10 confirmed transactions
 *   GET  /balance             → terminal DUST/NIGHT balance
 *   GET  /wallet/balance      → full wallet info + last tx
 *
 * Dependencies:
 *   npm install express node-fetch@2
 *   (remove @solana/web3.js from package.json)
 */

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const fetch   = require('node-fetch');   // use node-fetch@2 (CommonJS-compatible)
const app     = express();
const PORT    = 3000;
const monitor  = require('./monitorService');   
const midnight = require('./midnightAdapter');  

app.use(express.json());


/* ─────────────────────────────────────────────
   MIDNIGHT NETWORK ENDPOINTS
   Local Docker stack (for dev/hackathon):
     docker compose up   ← spins up all 4 services
     Node    ws://localhost:9944
     Indexer http://localhost:8088/api/v1/graphql
     Prover  http://localhost:6300
     Explorer http://localhost:3000  ← use PORT=3001 then

   Preprod (if you want to test against the live testnet):
     Set MIDNIGHT_ENV=preprod in your shell or .env
───────────────────────────────────────────── */
const MIDNIGHT_ENV = process.env.MIDNIGHT_ENV || 'local';

const ENDPOINTS = {
    local: {
        node    : 'ws://localhost:9944',
        indexer : 'http://localhost:8088/api/v1/graphql',
        prover  : 'http://localhost:6300',
    },
    preprod: {
        node    : process.env.MIDNIGHT_NODE_URL    || 'https://rpc.preprod-02.midnight.network',
        indexer : process.env.MIDNIGHT_INDEXER_URL || 'https://indexer.preprod-02.midnight.network/api/v1/graphql',
        prover  : process.env.MIDNIGHT_PROVER_URL  || 'https://prover.preprod-02.midnight.network',
    },
};

const { node: NODE_URL, indexer: INDEXER_URL, prover: PROVER_URL } =
    ENDPOINTS[MIDNIGHT_ENV] || ENDPOINTS.local;

/* ─────────────────────────────────────────────
   CONVERSION RATE
   DUST is Midnight's spendable resource token.
   Set a sensible rate or pull from an exchange API.
   For the hackathon, a fixed env var is fine.

   Example: 1 NGN = 0.001 DUST  (adjust as needed)
───────────────────────────────────────────── */
const DUST_PER_NAIRA = Number(process.env.DUST_PER_NAIRA) || 0.001;

/* ─────────────────────────────────────────────
   TERMINAL WALLET
   Midnight addresses are Bech32m strings, e.g.:
     mn1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

   The backend only needs the address to:
     1. Build QR codes  (midnight:<address>?amount=...)
     2. Query the Indexer for balance

   Private keys live in the Lace wallet / Wallet SDK —
   NOT in this file. The keypair file now stores just
   the address string.

   To get a real address:
     1. Install Lace wallet + Midnight extension
     2. Create a wallet on preprod
     3. Copy your address and paste below or set
        TERMINAL_ADDRESS in your .env
───────────────────────────────────────────── */
const KEYPAIR_FILE = 'terminal_keypair.json';
let terminalAddress;

if (fs.existsSync(KEYPAIR_FILE)) {
    const data = JSON.parse(fs.readFileSync(KEYPAIR_FILE, 'utf8'));
    terminalAddress = data.address;
    console.log('Loaded terminal address:', terminalAddress);
} else {
    // Fallback: use env var or a placeholder
    terminalAddress = process.env.TERMINAL_ADDRESS || 'mn1_REPLACE_WITH_YOUR_MIDNIGHT_BECH32_ADDRESS';
    fs.writeFileSync(KEYPAIR_FILE, JSON.stringify({ address: terminalAddress }, null, 2));
    console.log('Saved terminal address →', KEYPAIR_FILE);
}

/* ─────────────────────────────────────────────
   COMPACT CONTRACT ADDRESS
   After you compile and deploy payment.compact,
   paste the deployed contract address here or
   set CONTRACT_ADDRESS in your .env.

   Until then, monitorPayment() falls back to a
   10-second demo confirmation so you can demo
   the full UI flow without a live contract.
───────────────────────────────────────────── */
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || null;

/* ─────────────────────────────────────────────
   IN-MEMORY PAYMENT STORE
───────────────────────────────────────────── */
const payments = {};

/* ─────────────────────────────────────────────
   TRANSACTION HISTORY (last 10 confirmed)
───────────────────────────────────────────── */
const txHistory   = [];
const MAX_HISTORY = 10;

function addToHistory(payment_id, payment) {
    txHistory.unshift({
        payment_id,
        amount_naira : payment.amount_naira,
        amount_dust  : payment.amount_dust,
        tx_hash      : payment.tx_hash,
        timestamp    : new Date().toLocaleTimeString(),
        status       : 'confirmed',
    });
    if (txHistory.length > MAX_HISTORY) txHistory.pop();
}

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */
function generatePaymentId() {
    return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function nairaToDust(naira) {
    // Round up — always charge at least 1 DUST
    return Math.max(1, Math.ceil(naira * DUST_PER_NAIRA));
}

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

/* ─────────────────────────────────────────────
   MIDNIGHT INDEXER — GraphQL helper
   The Indexer exposes a GraphQL API.
   All on-chain queries go through here.

   NOTE: Verify exact field names against your
   running Indexer's schema introspection at:
     http://localhost:8088/api/v1/graphql
───────────────────────────────────────────── */
async function indexerQuery(query, variables = {}) {
    const res = await fetch(INDEXER_URL, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Indexer HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
}

/* ─────────────────────────────────────────────
   MIDNIGHT: get latest indexed block
───────────────────────────────────────────── */
async function getLatestBlock() {
    const data = await indexerQuery(`
        query {
            block(order: { height: DESC }, first: 1) {
                nodes { height hash }
            }
        }
    `);
    return data?.block?.nodes?.[0] || null;
}

/* ─────────────────────────────────────────────
   MIDNIGHT: get DUST / NIGHT balance
   Adjust query shape to match your Indexer version.
───────────────────────────────────────────── */
async function getBalance(address) {
    const data = await indexerQuery(`
        query GetBalance($addr: String!) {
            tokenBalance(address: $addr) {
                dust
                night
            }
        }
    `, { addr: address });
    return {
        dust  : data?.tokenBalance?.dust  ?? 0,
        night : data?.tokenBalance?.night ?? 0,
    };
}

/* ─────────────────────────────────────────────
   MONITOR — event listeners
   monitorService.js handles all blockchain polling.
   These handlers update the in-memory payment store
   when events fire.
───────────────────────────────────────────── */

monitor.start();

monitor.on('confirmed', ({ payment_id, txHash }) => {
    const p = payments[payment_id];
    if (!p) return;
    p.status  = 'confirmed';
    p.tx_hash = txHash;
    addToHistory(payment_id, p);
    log(`Payment CONFIRMED | ID=${payment_id} | tx=${txHash.slice(0, 20)}…`);
});

monitor.on('expired', ({ payment_id }) => {
    const p = payments[payment_id];
    if (p) p.status = 'expired';
    log(`Payment expired | ID=${payment_id}`);
});

    

/* ═════════════════════════════════════════════
   ROUTES
═════════════════════════════════════════════ */

/* GET /health */
app.get('/health', async (req, res) => {
    let networkStatus = 'unknown';
    let blockHeight   = null;
    try {
        const block = await getLatestBlock();
        if (block) {
            blockHeight   = block.height;
            networkStatus = `block ${block.height}`;
        }
    } catch (e) {
        networkStatus = `unreachable (${e.message})`;
    }

    log(`Health | Midnight Indexer: ${networkStatus}`);
    res.json({
        status           : 'ok',
        service          : 'ChainEngineers Backend (Midnight)',
        midnight_network : MIDNIGHT_ENV,
        midnight_indexer : networkStatus,
        monitor_status   : monitor.status(),
        block_height     : blockHeight,
        terminal_address : terminalAddress,
        contract_address : CONTRACT_ADDRESS || 'not deployed',
    });
});

/* POST /payment/create */
app.post('/payment/create', (req, res) => {
    const { amount } = req.body;
    if (!amount || isNaN(amount) || Number(amount) <= 0)
        return res.status(400).json({ status: 'error', error_msg: 'Invalid amount' });

    const naira      = Number(amount);
    const dust       = nairaToDust(naira);
    const payment_id = generatePaymentId();

    /*
     * Midnight payment URI scheme:
     *   midnight:<address>?amount=<DUST>&memo=<payment_id>
     *
     * The customer scans this with their Midnight-compatible
     * wallet (e.g. Lace), which calls pay() on the contract.
     */
    const qr_data = `midnight:${terminalAddress}?amount=${dust}&memo=${payment_id}`;

    payments[payment_id] = {
        amount_naira    : naira,
        amount_dust     : dust,
        qr_data,
        receive_address : terminalAddress,
        created_at      : Date.now(),
        status          : 'pending',
        tx_hash         : null,
    };

    log(`Payment created | ID=${payment_id} | ₦${naira} → ${dust} DUST`);
    monitor.watch(payment_id, {
    dustAmount      : dust,
    contractAddress : CONTRACT_ADDRESS,
    });
    res.json({
        payment_id,
        qr_data,
        amount_dust     : dust,
        receive_address : terminalAddress,
        status          : 'pending',
    });
});

/* GET /payment/:id/status */
app.get('/payment/:id/status', (req, res) => {
    const { id } = req.params;
    const payment = payments[id];
    if (!payment)
        return res.status(404).json({ status: 'error', error_msg: 'Payment not found' });

    const elapsed  = Date.now() - payment.created_at;
    const response = {
        payment_id  : id,
        status      : payment.status,
        amount_dust : payment.amount_dust,
    };
    if (payment.status === 'confirmed') response.tx_hash = payment.tx_hash;

    log(`Poll | ID=${id} | status=${payment.status} | ${(elapsed / 1000).toFixed(1)}s`);
    res.json(response);
});

/* GET /history */
app.get('/history', (req, res) => {
    log(`History | ${txHistory.length} transactions`);
    res.json({ count: txHistory.length, transactions: txHistory });
});

/* GET /balance */
app.get('/balance', async (req, res) => {
    try {
        const bal = await getBalance(terminalAddress);
        log(`Balance | ${bal.dust} DUST | ${bal.night} NIGHT`);
        res.json({
            address       : terminalAddress,
            balance_dust  : bal.dust,
            balance_night : bal.night,
        });
    } catch (err) {
        log(`Balance error: ${err.message}`);
        res.status(500).json({ status: 'error', error_msg: 'Failed to fetch balance' });
    }
});

/* GET /wallet/balance */
app.get('/wallet/balance', async (req, res) => {
    try {
        const bal = await getBalance(terminalAddress);

        const txData = await indexerQuery(`
            query LastTx($addr: String!) {
                transactions(
                    filter: { involvedAddress: $addr }
                    last: 1
                ) {
                    nodes { txHash blockHeight }
                }
            }
        `, { addr: terminalAddress }).catch(() => null);

        const lastTx = txData?.transactions?.nodes?.[0]?.txHash || '';

        res.json({
            address       : terminalAddress,
            balance_dust  : bal.dust,
            balance_night : bal.night,
            last_tx       : lastTx,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */
app.listen(PORT, async () => {
    await midnight.initialize();
    await midnight.deployContract();
    console.log(`\n╔════════════════════════════════════════════╗`);
    console.log(`║  ChainEngineers Backend  v4.0 — Midnight   ║`);
    console.log(`║  http://localhost:${PORT}                  ║`);
    console.log(`╚════════════════════════════════════════════╝\n`);
    console.log(`  Terminal address : ${terminalAddress}`);
    console.log(`  Network          : ${MIDNIGHT_ENV}`);
    console.log(`  Node             : ${NODE_URL}`);
    console.log(`  Indexer          : ${INDEXER_URL}`);
    console.log(`  Prover           : ${PROVER_URL}`);
    console.log(`  Contract         : ${CONTRACT_ADDRESS || '(not deployed yet — demo mode active)'}\n`);
    console.log(`  GET  /health`);
    console.log(`  POST /payment/create`);
    console.log(`  GET  /payment/:id/status`);
    console.log(`  GET  /history`);
    console.log(`  GET  /balance`);
    console.log(`  GET  /wallet/balance\n`);

    try {
        const block = await getLatestBlock();
        if (block) {
            console.log(`  Midnight Indexer : ONLINE (block ${block.height})\n`);
        } else {
            console.log(`  Midnight Indexer : reachable but no blocks yet\n`);
        }
    } catch (e) {
        console.log(`  Midnight Indexer : OFFLINE\n`);
        console.log(`  → Run: docker compose up   (in your Midnight devkit folder)`);
        console.log(`  → Or set MIDNIGHT_ENV=preprod for testnet\n`);
    }
});
