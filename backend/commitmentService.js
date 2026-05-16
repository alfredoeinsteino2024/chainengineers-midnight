'use strict';

/*
 * commitmentService.js — ChainEngineers × Midnight Hackathon
 *
 * Manages the ZK commitment lifecycle for each payment session.
 * A "commitment" is a record that ties together:
 *   - The merchant's expected amount (dustAmount)
 *   - A unique payment_ref (payment_id from server.js)
 *   - The on-chain proof result once the customer pays
 *
 * This sits between server.js and the Midnight network:
 *
 *   server.js
 *     └── POST /payment/create
 *           └── commitmentService.createCommitment()   ← before QR shown
 *     └── monitor 'confirmed' event
 *           └── commitmentService.verifyCommitment()   ← validate proof
 *           └── commitmentService.finalizeCommitment() ← mark spent
 *
 * Commitment states
 * ─────────────────
 *   PENDING   → created, QR shown, waiting for customer to pay
 *   VERIFIED  → on-chain ZK proof received and validated
 *   FINALIZED → spent flag set; archived; cannot be replayed
 *   EXPIRED   → TTL elapsed with no confirmation
 *   INVALID   → proof validation failed (wrong amount, bad ref, replay)
 *
 * Design notes
 * ────────────
 * • Pure CommonJS — no ESM, no top-level await.
 * • No network I/O — that lives in midnightAdapter / monitorService.
 * • Demo mode works with no Docker and no compiled contract.
 * • Each SDK upgrade path is marked ── FULL SDK PATH ──
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

/* ══════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════ */
const COMMITMENT_TTL_MS = Number(process.env.PAYMENT_TTL_MS) || 300_000; // 5 min
const DEMO_MODE         = !process.env.CONTRACT_ADDRESS;
const ARCHIVE_FILE      = path.join(__dirname, 'commitment_archive.json');

/* ══════════════════════════════════════════════
   IN-MEMORY STORE
   Map<payment_id → CommitmentRecord>
══════════════════════════════════════════════ */
const _store = new Map();

/*
 * CommitmentRecord shape:
 * {
 *   payment_id      : string        — matches server.js payment key
 *   dust_amount     : number        — expected DUST from customer
 *   merchant_address: string        — terminal Bech32m address
 *   commitment_hash : string        — SHA-256(payment_id + dust_amount + salt)
 *   salt            : string        — random hex, never sent on-chain
 *   state           : string        — PENDING | VERIFIED | FINALIZED | EXPIRED | INVALID
 *   created_at      : number        — Date.now()
 *   expires_at      : number        — created_at + TTL
 *   tx_hash         : string | null — filled on VERIFIED
 *   verified_at     : number | null
 *   finalized_at    : number | null
 *   error           : string | null — set on INVALID
 * }
 */

/* ══════════════════════════════════════════════
   INTERNAL HELPERS
══════════════════════════════════════════════ */

/*
 * _makeCommitmentHash(payment_id, dustAmount, salt)
 * Produces a deterministic fingerprint for a payment session.
 *
 * In the full Compact contract this hash becomes the public witness input —
 * the ZK circuit verifies it without revealing the underlying values.
 *
 * ── FULL SDK PATH ───────────────────────────────────────────────────────────
 * When payment.compact is compiled the circuit's pay() function will expect:
 *   witness dustAmount  : Uint64
 *   witness paymentRef  : Bytes<32>    (this hash, padded)
 * The proof server derives the same hash internally.
 * ────────────────────────────────────────────────────────────────────────────
 */
function _makeCommitmentHash(payment_id, dustAmount, salt) {
    return crypto
        .createHash('sha256')
        .update(`${payment_id}:${dustAmount}:${salt}`)
        .digest('hex');
}

function _log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] [Commitment] ${msg}`);
}

/*
 * _archive(record)
 * Appends a finalized/expired/invalid record to commitment_archive.json.
 * Keeps a permanent audit trail for the merchant — useful for disputes.
 */
function _archive(record) {
    try {
        let existing = [];
        if (fs.existsSync(ARCHIVE_FILE)) {
            existing = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
        }
        existing.push({ ...record, archived_at: Date.now() });
        fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(existing, null, 2));
    } catch (e) {
        _log(`Archive write failed: ${e.message}`);
    }
}

/* ══════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════ */

/*
 * createCommitment(payment_id, dustAmount, merchantAddress)
 * Call this immediately after generating a payment_id in server.js,
 * before returning the QR code to the terminal.
 *
 * Returns the CommitmentRecord (cloned, safe to expose).
 */
function createCommitment(payment_id, dustAmount, merchantAddress) {
    if (_store.has(payment_id)) {
        _log(`Duplicate create ignored | ID=${payment_id}`);
        return getCommitment(payment_id);
    }

    const salt            = crypto.randomBytes(16).toString('hex');
    const commitment_hash = _makeCommitmentHash(payment_id, dustAmount, salt);
    const now             = Date.now();

    const record = {
        payment_id,
        dust_amount      : Number(dustAmount),
        merchant_address : merchantAddress || process.env.TERMINAL_ADDRESS || '',
        commitment_hash,
        salt,                   // kept server-side only — never sent to customer
        state            : 'PENDING',
        created_at       : now,
        expires_at       : now + COMMITMENT_TTL_MS,
        tx_hash          : null,
        verified_at      : null,
        finalized_at     : null,
        error            : null,
    };

    _store.set(payment_id, record);

    _log(
        `Created | ID=${payment_id} | ${dustAmount} DUST` +
        ` | hash=${commitment_hash.slice(0, 16)}…` +
        (DEMO_MODE ? ' | DEMO MODE' : '')
    );

    return { ...record };
}

/*
 * verifyCommitment(payment_id, txHash, onChainState)
 * Call this when monitorService emits 'confirmed'.
 *
 * Checks:
 *   1. Commitment exists and is still PENDING
 *   2. Not expired
 *   3. On-chain state references the correct payment_id (payment_ref match)
 *   4. On-chain status is PAID
 *   5. Amount matches (if on-chain state exposes it — ZK proofs may hide it)
 *
 * In demo mode, all checks pass automatically.
 *
 * Returns { valid: bool, reason: string }
 *
 * ── FULL SDK PATH ───────────────────────────────────────────────────────────
 * When the Compact contract exposes public ledger fields:
 *   onChainState.payment_ref    — must === payment_id
 *   onChainState.payment_status — must === 'PAID'
 *   onChainState.dust_amount    — optional; compare to record.dust_amount
 *                                 (may be hidden by ZK if private witness)
 * ────────────────────────────────────────────────────────────────────────────
 */
function verifyCommitment(payment_id, txHash, onChainState = {}) {
    const record = _store.get(payment_id);

    if (!record) {
        _log(`Verify FAIL — not found | ID=${payment_id}`);
        return { valid: false, reason: 'commitment_not_found' };
    }

    if (record.state !== 'PENDING') {
        _log(`Verify FAIL — wrong state (${record.state}) | ID=${payment_id}`);
        return { valid: false, reason: `wrong_state:${record.state}` };
    }

    if (Date.now() > record.expires_at) {
        record.state = 'EXPIRED';
        record.error = 'expired_before_verification';
        _archive(record);
        _store.delete(payment_id);
        _log(`Verify FAIL — expired | ID=${payment_id}`);
        return { valid: false, reason: 'expired' };
    }

    // Demo mode — skip on-chain checks
    if (DEMO_MODE || !txHash || txHash.startsWith('DEMO_')) {
        record.state       = 'VERIFIED';
        record.tx_hash     = txHash || 'DEMO_' + crypto.randomBytes(8).toString('hex').toUpperCase();
        record.verified_at = Date.now();
        _store.set(payment_id, record);
        _log(`Verified (demo) | ID=${payment_id} | tx=${record.tx_hash.slice(0, 20)}…`);
        return { valid: true, reason: 'demo_auto_verified' };
    }

    // On-chain state checks
    const stateStr    = JSON.stringify(onChainState);
    const refMatches  = onChainState?.payment_ref === payment_id
                     || stateStr.includes(payment_id);
    const isPaid      = onChainState?.payment_status === 'PAID'
                     || stateStr.includes('"PAID"');

    if (!refMatches) {
        record.state = 'INVALID';
        record.error = 'payment_ref_mismatch';
        _log(`Verify FAIL — ref mismatch | ID=${payment_id}`);
        _archive(record);
        _store.delete(payment_id);
        return { valid: false, reason: 'payment_ref_mismatch' };
    }

    if (!isPaid) {
        record.state = 'INVALID';
        record.error = 'status_not_paid';
        _log(`Verify FAIL — status not PAID | ID=${payment_id}`);
        _archive(record);
        _store.delete(payment_id);
        return { valid: false, reason: 'status_not_paid' };
    }

    // Optional amount check (only if on-chain state exposes it)
    if (onChainState?.dust_amount !== undefined) {
        const onChainAmt = Number(onChainState.dust_amount);
        if (onChainAmt < record.dust_amount) {
            record.state = 'INVALID';
            record.error = `underpaid: expected ${record.dust_amount}, got ${onChainAmt}`;
            _log(`Verify FAIL — underpaid | ID=${payment_id}`);
            _archive(record);
            _store.delete(payment_id);
            return { valid: false, reason: record.error };
        }
    }

    record.state       = 'VERIFIED';
    record.tx_hash     = txHash;
    record.verified_at = Date.now();
    _store.set(payment_id, record);

    _log(`Verified | ID=${payment_id} | tx=${txHash.slice(0, 20)}…`);
    return { valid: true, reason: 'on_chain_verified' };
}

/*
 * finalizeCommitment(payment_id)
 * Call this after verifyCommitment() succeeds and server.js has
 * updated its payment store. Marks the commitment as spent and
 * archives it so it cannot be replayed.
 *
 * Returns the archived record, or null if not found/wrong state.
 */
function finalizeCommitment(payment_id) {
    const record = _store.get(payment_id);

    if (!record) {
        _log(`Finalize — not found | ID=${payment_id}`);
        return null;
    }

    if (record.state !== 'VERIFIED') {
        _log(`Finalize — wrong state (${record.state}) | ID=${payment_id}`);
        return null;
    }

    record.state        = 'FINALIZED';
    record.finalized_at = Date.now();

    _archive(record);
    _store.delete(payment_id);

    _log(`Finalized | ID=${payment_id} | tx=${record.tx_hash?.slice(0, 20)}…`);
    return { ...record };
}

/*
 * pruneExpired()
 * Sweep the store and expire any commitments past their TTL.
 * Called by monitorService when it emits 'expired', or on a
 * periodic interval if you want belt-and-suspenders cleanup.
 *
 * Returns the count of records pruned.
 */
function pruneExpired() {
    const now   = Date.now();
    let   count = 0;

    for (const [id, record] of _store) {
        if (now >= record.expires_at && record.state === 'PENDING') {
            record.state = 'EXPIRED';
            record.error = 'ttl_elapsed';
            _archive(record);
            _store.delete(id);
            count++;
            _log(`Pruned expired | ID=${id}`);
        }
    }

    return count;
}

/*
 * getCommitment(payment_id)
 * Returns a clone of the record, or null if not found.
 * Safe to pass to client — salt is stripped.
 */
function getCommitment(payment_id) {
    const record = _store.get(payment_id);
    if (!record) return null;
    const { salt, ...safe } = record; // never expose salt
    return { ...safe };
}

/*
 * status()
 * Returns a snapshot of the current store — useful for /health endpoint.
 */
function status() {
    return {
        demo_mode   : DEMO_MODE,
        pending     : [..._store.values()].filter(r => r.state === 'PENDING').length,
        verified    : [..._store.values()].filter(r => r.state === 'VERIFIED').length,
        total_active: _store.size,
    };
}

/* ══════════════════════════════════════════════
   EXPORTS
══════════════════════════════════════════════ */
module.exports = {
    createCommitment,
    verifyCommitment,
    finalizeCommitment,
    pruneExpired,
    getCommitment,
    status,
};

/* ══════════════════════════════════════════════
   STANDALONE TEST
   node commitmentService.js
══════════════════════════════════════════════ */
if (require.main === module) {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  commitmentService — self test           ║');
    console.log('╚══════════════════════════════════════════╝\n');

    const id  = 'TEST_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const amt = 50;

    console.log(`1. createCommitment(${id}, ${amt} DUST)`);
    const created = createCommitment(id, amt, 'mn1_test_address');
    console.log(`   hash=${created.commitment_hash.slice(0, 32)}…`);
    console.log(`   state=${created.state}\n`);

    console.log(`2. verifyCommitment (demo mode)`);
    const result = verifyCommitment(id, null, {});
    console.log(`   valid=${result.valid} | reason=${result.reason}\n`);

    console.log(`3. finalizeCommitment`);
    const final = finalizeCommitment(id);
    console.log(`   state=${final?.state} | tx=${final?.tx_hash?.slice(0, 20)}…\n`);

    console.log(`4. getCommitment (should be null after finalize)`);
    console.log(`   result=${getCommitment(id)}\n`);

    console.log(`5. status()`);
    console.log(`   ${JSON.stringify(status())}\n`);

    console.log('Self test complete.\n');
}
