/*
 * midnightAdapter.js — ChainEngineers × Midnight
 *
 * Replaces the old Solana sender script entirely.
 * This file does two things:
 *
 *   1. MODULE — export a clean API that server.js imports:
 *        initialize(), deployContract(), callPay(),
 *        monitorPayment(), getBalance(), getNetworkStatus()
 *
 *   2. STANDALONE SCRIPT — run directly to test your setup:
 *        node midnightAdapter.js
 *      This checks connectivity, prints your wallet address,
 *      requests faucet DUST, and fires a test payment.
 *
 * Install dependencies:
 *   npm install node-fetch@2 @midnight-ntwrk/midnight-js-network-id
 *
 * When your Compact contract is compiled, also install:
 *   npm install @midnight-ntwrk/compact-runtime
 *   (and import the generated contract API — see CONTRACT SETUP below)
 */

'use strict';

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

/* ══════════════════════════════════════════════
   NETWORK CONFIG
   Mirrors the same env-switch pattern in server.js
   so both files always talk to the same stack.
══════════════════════════════════════════════ */
const MIDNIGHT_ENV = process.env.MIDNIGHT_ENV || 'local';

const ENDPOINTS = {
    local: {
        node    : 'ws://localhost:9944',
        indexer : 'http://localhost:8088/api/v1/graphql',
        prover  : 'http://localhost:6300',
        faucet  : 'http://localhost:8081',          // Docker faucet service
        explorer: 'http://localhost:3000',
    },
    preprod: {
        node    : process.env.MIDNIGHT_NODE_URL    || 'https://rpc.preprod-02.midnight.network',
        indexer : process.env.MIDNIGHT_INDEXER_URL || 'https://indexer.preprod-02.midnight.network/api/v1/graphql',
        prover  : process.env.MIDNIGHT_PROVER_URL  || 'https://prover.preprod-02.midnight.network',
        faucet  : 'https://faucet.preprod-02.midnight.network',
        explorer: 'https://explorer.preprod-02.midnight.network',
    },
};

const EP = ENDPOINTS[MIDNIGHT_ENV] || ENDPOINTS.local;

/* ══════════════════════════════════════════════
   WALLET MANAGEMENT
   Midnight uses a mnemonic seed phrase (BIP-39),
   not a raw secret key array like Solana.

   The wallet file stores ONLY the address and seed.
   The private key is derived on-demand by the Wallet SDK.

   wallet_seed.json format:
   {
     "address" : "mn1xxxxxxxxxxxxxxxxxx",
     "mnemonic": "word1 word2 ... word24"
   }

   ⚠️  Keep wallet_seed.json out of git (.gitignore it).
   ⚠️  For a receive-only terminal the backend never
       signs transactions — the customer's wallet does.
       The mnemonic is only needed if the backend itself
       needs to call contract circuits (e.g. for setup).
══════════════════════════════════════════════ */
const WALLET_FILE = path.join(__dirname, 'wallet_seed.json');

/*
 * loadOrCreateWallet()
 * Returns { address, mnemonic }
 *
 * Full SDK path (uncomment when ready):
 *   const { WalletBuilder }   = require('@midnight-ntwrk/midnight-js-wallet');
 *   const { NetworkId }       = require('@midnight-ntwrk/midnight-js-network-id');
 *   const wallet = await WalletBuilder.buildFromSeed(
 *       EP.node, EP.indexer, EP.prover,
 *       seedBytes,
 *       MIDNIGHT_ENV === 'local' ? NetworkId.TestNet : NetworkId.MainNet
 *   );
 *   return { address: wallet.state.address, wallet };
 */
function loadOrCreateWallet() {
    if (fs.existsSync(WALLET_FILE)) {
        const data = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
        console.log('[Wallet] Loaded existing address:', data.address);
        return data;
    }

    /*
     * In production: generate a real BIP-39 mnemonic with the Wallet SDK.
     * For the hackathon, use a placeholder and replace it with your
     * real Lace/Midnight wallet address + seed.
     *
     * Quick path to get a real address:
     *   1. Install the Midnight Lace wallet extension
     *   2. Create a wallet on preprod
     *   3. Export seed phrase and copy your address
     *   4. Paste them here or set TERMINAL_ADDRESS + TERMINAL_MNEMONIC env vars
     */
    const walletData = {
        address  : process.env.TERMINAL_ADDRESS  || 'mn1_REPLACE_WITH_REAL_MIDNIGHT_ADDRESS',
        mnemonic : process.env.TERMINAL_MNEMONIC || 'REPLACE WITH YOUR 24-WORD SEED PHRASE',
    };

    fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2));
    console.log('[Wallet] Created wallet_seed.json — fill in a real address/mnemonic');
    return walletData;
}

/* ══════════════════════════════════════════════
   CONTRACT SETUP
   After you write and compile payment.compact:
     npx compact-compiler payment.compact
   This generates:
     managed/payment/index.cjs       ← CommonJS API
     managed/payment/index.d.ts      ← TypeScript types
     managed/payment/*.zkey           ← ZK proving keys

   Then uncomment the import below and remove the
   CONTRACT_STUB block.
══════════════════════════════════════════════ */

// ── Uncomment once payment.compact is compiled ──
// const PaymentContract = require('./managed/payment/index.cjs');

/*
 * CONTRACT STUB — used when no compiled contract exists yet.
 * Lets you run server.js and demo the full terminal UI
 * without a live contract.
 */
const CONTRACT_STUB = {
    deployed : false,
    address  : process.env.CONTRACT_ADDRESS || null,
};

// In-memory store for deployed contract handle (set by deployContract())
let _deployedContract = null;

/* ══════════════════════════════════════════════
   GRAPHQL HELPER
   Same helper as server.js — all Indexer queries
   go through here.
══════════════════════════════════════════════ */
async function gql(query, variables = {}) {
    const res = await fetch(EP.indexer, {
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

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

/* ══════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════ */

/*
 * initialize()
 * Call this once at server startup.
 * Checks all three Midnight services are reachable.
 * Returns { node, indexer, prover, blockHeight }
 */
async function initialize() {
    log('[Midnight] Initializing connections...');
    const results = { node: false, indexer: false, prover: false, blockHeight: null };

    // Check Indexer (GraphQL)
    try {
        const data = await gql(`query { block(order: { height: DESC }, first: 1) { nodes { height } } }`);
        results.blockHeight = data?.block?.nodes?.[0]?.height ?? null;
        results.indexer     = true;
        log(`[Indexer] ONLINE — block ${results.blockHeight}`);
    } catch (e) {
        log(`[Indexer] OFFLINE — ${e.message}`);
        log(`[Indexer] Run: docker compose up`);
    }

    // Check Proof Server (HTTP ping)
    try {
        const res = await fetch(`${EP.prover}/health`, { timeout: 4000 });
        results.prover = res.ok;
        log(`[Prover]  ${res.ok ? 'ONLINE' : `HTTP ${res.status}`}`);
    } catch (e) {
        log(`[Prover]  OFFLINE — ${e.message}`);
    }

    // Node (WebSocket — just check the URL is reachable)
    // Full WebSocket check needs the Wallet SDK; for now log intent
    log(`[Node]    Configured → ${EP.node}`);
    results.node = true; // optimistic; real check happens when wallet connects

    return results;
}

/*
 * getNetworkStatus()
 * Lightweight check used by GET /health in server.js
 */
async function getNetworkStatus() {
    try {
        const data = await gql(`
            query {
                block(order: { height: DESC }, first: 1) {
                    nodes { height hash }
                }
            }
        `);
        const block = data?.block?.nodes?.[0];
        return { online: true, blockHeight: block?.height, blockHash: block?.hash };
    } catch (e) {
        return { online: false, error: e.message };
    }
}

/*
 * getBalance(address)
 * Returns { dust, night } for the given Midnight address.
 * Adjust the query shape to match your Indexer version.
 */
async function getBalance(address) {
    try {
        const data = await gql(`
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
    } catch (e) {
        log(`[Balance] Query failed: ${e.message}`);
        return { dust: 0, night: 0 };
    }
}

/*
 * requestFaucet(address)
 * Requests test DUST from the local/preprod faucet.
 * Equivalent to going to https://faucet.solana.com in the old flow.
 *
 * Local Docker faucet: POST http://localhost:8081/api/faucet/v1/midnight
 * Preprod faucet: use the web UI at EP.faucet or the TypeScript faucet client
 *   npm install @midnight-ntwrk/midnight-js-testing
 */
async function requestFaucet(address) {
    log(`[Faucet] Requesting DUST for ${address}`);
    try {
        const res = await fetch(`${EP.faucet}/api/faucet/v1/midnight`, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify({ address }),
            timeout : 15000,
        });
        if (!res.ok) throw new Error(`Faucet HTTP ${res.status}`);
        const json = await res.json();
        log(`[Faucet] Success: ${JSON.stringify(json)}`);
        return json;
    } catch (e) {
        log(`[Faucet] Failed: ${e.message}`);
        if (MIDNIGHT_ENV === 'preprod') {
            log(`[Faucet] Visit manually: ${EP.faucet}`);
        }
        throw e;
    }
}

/*
 * deployContract()
 * Deploys the Compact payment contract and saves the address.
 *
 * ── STUB (no compiled contract yet) ──────────────────────
 * Returns the CONTRACT_ADDRESS from .env if set, else null.
 *
 * ── FULL SDK PATH (uncomment after compiling) ────────────
 * const { WalletBuilder }        = require('@midnight-ntwrk/midnight-js-wallet');
 * const { NodeZkConfigProvider } = require('@midnight-ntwrk/midnight-js-zk-config-provider');
 * const PaymentContract          = require('./managed/payment/index.cjs');
 *
 * const wallet    = await WalletBuilder.buildFromSeed(...);
 * const providers = {
 *     privateStateProvider : wallet.privateStateProvider,
 *     zkConfigProvider     : new NodeZkConfigProvider(EP.prover),
 *     walletProvider       : wallet,
 *     midnightProvider     : wallet.midnight,
 * };
 *
 * const contract   = new PaymentContract.Contract({ status: 'IDLE' });
 * _deployedContract = await contract.deploy(providers);
 * const addr = _deployedContract.deployTxData.public.contractAddress;
 * log(`[Contract] Deployed at ${addr}`);
 * fs.writeFileSync('contract_address.json', JSON.stringify({ address: addr }));
 * CONTRACT_STUB.address = addr;
 * return addr;
 * ─────────────────────────────────────────────────────────
 */
async function deployContract() {
    // Load saved address if it exists
    const addrFile = path.join(__dirname, 'contract_address.json');
    if (fs.existsSync(addrFile)) {
        const { address } = JSON.parse(fs.readFileSync(addrFile, 'utf8'));
        log(`[Contract] Loaded existing address: ${address}`);
        CONTRACT_STUB.address   = address;
        CONTRACT_STUB.deployed  = true;
        return address;
    }

    if (CONTRACT_STUB.address) {
        log(`[Contract] Using address from env: ${CONTRACT_STUB.address}`);
        CONTRACT_STUB.deployed = true;
        return CONTRACT_STUB.address;
    }

    log(`[Contract] Not deployed yet — compile payment.compact first`);
    log(`[Contract] Running in demo mode (no on-chain confirmation)`);
    return null;
}

/*
 * callPay(paymentId, dustAmount)
 * Calls the pay() circuit on the deployed contract.
 *
 * In the real flow, the CUSTOMER's wallet calls this —
 * not the merchant terminal. The terminal just monitors
 * for the state change after the customer scans the QR.
 *
 * This function is useful for:
 *   - Testing during development (simulate a customer)
 *   - Integration tests against the local Docker stack
 *
 * ── STUB ──────────────────────────────────────────────────
 * Returns a fake tx hash for demo purposes.
 *
 * ── FULL SDK PATH (uncomment after compiling) ────────────
 * if (!_deployedContract) throw new Error('Contract not deployed');
 * const result = await _deployedContract.callTx.pay(
 *     BigInt(dustAmount),
 *     paymentId              // passed as the public payment_ref
 * );
 * const txHash = result.public.txHash;
 * log(`[Contract] pay() confirmed | tx=${txHash}`);
 * return txHash;
 * ─────────────────────────────────────────────────────────
 */
async function callPay(paymentId, dustAmount) {
    if (!CONTRACT_STUB.address) {
        // Demo mode — simulate a payment confirmation
        log(`[Contract] DEMO pay() | ID=${paymentId} | ${dustAmount} DUST`);
        await new Promise(r => setTimeout(r, 2000));
        const demoHash = 'DEMO_' + crypto.randomBytes(16).toString('hex').toUpperCase();
        log(`[Contract] DEMO tx hash: ${demoHash}`);
        return demoHash;
    }

    // TODO: replace stub with real SDK call (see full SDK path above)
    log(`[Contract] callPay() stub — plug in SDK call here`);
    return null;
}

/*
 * monitorPayment(paymentId, onConfirmed, onExpired)
 * Polls the Midnight Indexer for the contract state change
 * that marks a payment as PAID.
 *
 * onConfirmed(txHash) — called when the ZK proof lands
 * onExpired()         — called after MAX_POLLS without confirmation
 *
 * This is the same logic that was inline in server.js monitorPayment(),
 * now centralised here and decoupled from Express.
 */
async function monitorPayment(paymentId, onConfirmed, onExpired) {
    const MAX_POLLS  = 60;
    const POLL_DELAY = 5_000;

    if (!CONTRACT_STUB.address) {
        log(`[Monitor] Demo mode — auto-confirming ${paymentId} in 10s`);
        setTimeout(async () => {
            const txHash = await callPay(paymentId, 0);
            onConfirmed && onConfirmed(txHash);
        }, 10_000);
        return;
    }

    log(`[Monitor] Watching ${CONTRACT_STUB.address.slice(0, 20)}… for ${paymentId}`);

    for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, POLL_DELAY));

        try {
            const data = await gql(`
                query ContractTxs($addr: String!) {
                    contractTransactions(contractAddress: $addr, last: 20) {
                        nodes {
                            txHash
                            blockHeight
                            contractState
                        }
                    }
                }
            `, { addr: CONTRACT_STUB.address });

            const txs = data?.contractTransactions?.nodes || [];

            for (const tx of txs) {
                if (!tx.contractState) continue;
                let state;
                try { state = JSON.parse(tx.contractState); } catch { continue; }

                // Match: our payment_id is in the public ledger AND status is PAID
                const matches = state?.payment_ref === paymentId ||
                                JSON.stringify(state).includes(paymentId);
                const isPaid  = state?.payment_status === 'PAID' ||
                                JSON.stringify(state).includes('PAID');

                if (matches && isPaid) {
                    log(`[Monitor] CONFIRMED | ID=${paymentId} | tx=${tx.txHash.slice(0, 20)}…`);
                    onConfirmed && onConfirmed(tx.txHash);
                    return;
                }
            }
        } catch (err) {
            log(`[Monitor] Poll error: ${err.message}`);
        }

        log(`[Monitor] Poll ${i + 1}/${MAX_POLLS} | waiting for ${paymentId}…`);
    }

    log(`[Monitor] Expired | ID=${paymentId}`);
    onExpired && onExpired();
}

/* ══════════════════════════════════════════════
   EXPORTS — used by server.js
══════════════════════════════════════════════ */
module.exports = {
    initialize,
    getNetworkStatus,
    getBalance,
    requestFaucet,
    deployContract,
    callPay,
    monitorPayment,
    loadOrCreateWallet,
    ENDPOINTS: EP,
};

/* ══════════════════════════════════════════════
   STANDALONE TEST SCRIPT
   Run: node midnightAdapter.js
   Mirrors what the old Solana sender script did:
     - Check connections
     - Print wallet address + balance
     - Request faucet DUST if balance is low
     - Fire a test payment (calls callPay stub)
══════════════════════════════════════════════ */
if (require.main === module) {
    (async () => {
        console.log('\n╔══════════════════════════════════════════╗');
        console.log(`║  Midnight Adapter — setup test           ║`);
        console.log(`║  Environment: ${MIDNIGHT_ENV.padEnd(27)}║`);
        console.log('╚══════════════════════════════════════════╝\n');

        // 1. Load wallet
        const wallet = loadOrCreateWallet();
        console.log(`  Address  : ${wallet.address}`);

        // 2. Check services
        const status = await initialize();
        console.log(`\n  Indexer  : ${status.indexer ? `ONLINE (block ${status.blockHeight})` : 'OFFLINE'}`);
        console.log(`  Prover   : ${status.prover  ? 'ONLINE' : 'OFFLINE'}`);
        console.log(`  Explorer : ${EP.explorer}\n`);

        // 3. Check balance
        const bal = await getBalance(wallet.address);
        console.log(`  DUST  balance : ${bal.dust}`);
        console.log(`  NIGHT balance : ${bal.night}\n`);

        // 4. Request faucet if needed
        if (bal.dust < 100) {
            console.log('  DUST balance low — requesting from faucet...');
            try {
                await requestFaucet(wallet.address);
                console.log('  Faucet request sent — wait ~30s then re-run\n');
                return;
            } catch (e) {
                console.log(`  Faucet failed: ${e.message}`);
                console.log(`  Fund manually: ${EP.faucet}\n`);
                if (MIDNIGHT_ENV === 'local') {
                    console.log('  Make sure your Docker stack is running:');
                    console.log('    docker compose up\n');
                }
            }
        }

        // 5. Try loading/deploying contract
        const contractAddr = await deployContract();
        console.log(`  Contract : ${contractAddr || 'not deployed'}\n`);

        // 6. Fire a test payment
        const testId = 'TEST_' + crypto.randomBytes(4).toString('hex').toUpperCase();
        console.log(`  Sending test payment | ID=${testId} | 10 DUST`);
        const txHash = await callPay(testId, 10);
        console.log(`  Result   : ${txHash || 'no tx (deploy contract first)'}\n`);

        if (contractAddr) {
            console.log(`  View contract on Explorer:`);
            console.log(`  ${EP.explorer}/contracts/${contractAddr}\n`);
        }

        console.log('  Setup complete — start your backend:');
        console.log('    node server.js\n');
    })();
}
