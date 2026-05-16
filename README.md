# ChainEngineers Midnight Terminal

A privacy-preserving embedded payment terminal for small merchants in Nigeria,
built with C, SDL2, Node.js, and the Midnight Network.

Submitted to the MLH Midnight Hackathon (May 15–17, 2026) - DeFi Track.

---

## The Problem

Small merchants in Nigeria using cryptocurrency payments today have zero
financial privacy. Every transaction - the amount paid, the merchant's
address, and their full revenue history - is publicly visible on-chain
to anyone in the world.

A competitor can watch your wallet and know exactly how much you made today.
A bad actor can track which customers visit your shop.
Your entire business history is permanently readable by anyone.

## The Solution

ChainEngineers is a point-of-sale payment terminal that accepts DUST payments
on the Midnight Network with full transaction privacy.

The merchant enters an amount in Nigerian Naira. The terminal converts it to
DUST, generates a QR code, and waits for the customer to pay. When payment
is confirmed, the terminal shows a confirmation screen.

On-chain, only a cryptographic commitment is stored. The actual amount,
merchant identity, and customer details never touch the public ledger.
A zero-knowledge proof mathematically guarantees the payment was correct
without revealing what was paid or to whom.

---

## Privacy Architecture

### What is public on-chain
- Payment reference ID
- Commitment hash: hash(amount + merchant_id + salt)
- Payment status: PENDING, CONFIRMED, or EXPIRED
- Block timestamp

### What stays private
- The actual DUST amount charged
- The merchant identity
- The customer identity
- Running revenue totals

### How it works

```
Merchant enters ₦5000
        ↓
Backend converts to 5 DUST
        ↓
commitmentService computes hash(5 + merchant_id + salt)
        ↓
submit_payment() writes commitment to Midnight ledger
        ↓
Customer scans QR with Lace wallet
        ↓
confirm_payment() generates ZK proof off-chain
        ↓
Proof verified on-chain - status flips to CONFIRMED
        ↓
monitorService detects confirmation
        ↓
Terminal shows PAYMENT CONFIRMED
```

## Stack

| Layer | Technology |
|---|---|
| Terminal UI | C + SDL2 |
| QR Code | Nayuki qrcodegen |
| Network | Raw TCP sockets (Winsock2 / POSIX) |
| Backend | Node.js + Express |
| Blockchain monitor | Custom EventEmitter service |
| ZK commitment | SHA-256 commitment scheme |
| Smart contract | Compact (Midnight DSL) |
| Chain | Midnight Network (DUST token) |
| Target hardware | ESP32 with OLED, NFC, keypad |

---

## Project Structure

```
chainengineers-midnight/
  midnight.c              - main terminal loop, SDL2 event handling
  backend/
    server.js             - Express HTTP API server
    midnightAdapter.js    - Midnight network integration layer
    monitorService.js     - blockchain payment watcher
    commitmentService.js  - ZK commitment lifecycle manager
    package.json          - Node.js dependencies
  network/
    network.h             - HTTP client interface
    network.c             - raw socket HTTP client
  states/
    states.h              - terminal state machine + data structs
    states.c              - amount input helpers
  ui/
    ui.h                  - render function declarations
    ui.c                  - all eight SDL2 screen renderers
  qr/
    qrcodegen.h           - Nayuki QR library header
    qrcodegen.c           - Nayuki QR library source
  payment.compact         - Midnight ZK smart contract
  assets/
    Roboto_Condensed-Regular.ttf
```

## Smart Contract

`payment.compact` defines three circuits:

**submit_payment(payment_ref, [amount, merchant_id, salt])**
Called by the backend when a QR is generated. Computes and stores
the commitment on-chain with status PENDING.

**confirm_payment(payment_ref, [amount, merchant_id, salt])**
Called by the customer's Lace wallet after scanning. Recomputes the
commitment from private witnesses and asserts it matches. Transitions
status to CONFIRMED.

**expire_payment(payment_ref)**
Called by the backend after TTL elapses. Marks the payment EXPIRED.
No private witnesses needed.

To compile:
```bash
npx compact-compiler payment.compact
```

---

## Running the Project

### Backend

```bash
cd backend
npm install
node server.js
```

The backend runs on port 3000 in demo mode by default.
Demo mode auto-confirms payments after 10 seconds without
requiring Docker or a live Midnight contract.

### Terminal (Windows)

```bash
gcc midnight.c ui/ui.c network/network.c states/states.c qr/qrcodegen.c \
  -I. -L. -lmingw32 -lSDL2main -lSDL2 -lSDL2_ttf -lws2_32 \
  -o chainengineers-midnight.exe

chainengineers-midnight.exe
```

SDL2.dll and SDL2_ttf.dll must be in the project root.

### Controls

| Key | Action |
|---|---|
| ENTER | Start new payment |
| 0-9 | Enter amount in Naira |
| BACKSPACE | Delete last digit |
| ENTER | Confirm amount |
| H | View transaction history |
| B | View terminal balance |
| ESC | Cancel / go back |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| MIDNIGHT_ENV | local | local or preprod |
| TERMINAL_ADDRESS | mn1qqq... | Merchant Bech32m address |
| CONTRACT_ADDRESS | null | Deployed contract address |
| DUST_PER_NAIRA | 0.001 | Conversion rate |
| PAYMENT_TTL_MS | 300000 | Payment expiry (5 min) |

---

## Demo Mode

The full terminal UI works without Docker or a live Midnight contract.

- Payment creation generates a real midnight: URI and QR code
- monitorService auto-confirms after 10 seconds
- CONFIRMED screen shows amount in DUST and demo TX hash
- History screen records all confirmed transactions
- Balance screen shows terminal wallet address

This demonstrates the complete merchant flow end to end.

---

## Roadmap

- [ ] Compile payment.compact and deploy to Midnight preprod
- [ ] Integrate Midnight Wallet SDK for real ZK proof generation
- [ ] Port to ESP32 hardware with OLED display and NFC reader
- [ ] Add multi-merchant support via merchant_id routing
- [ ] Add NGN/DUST exchange rate feed
- [ ] Add receipt printing via thermal printer GPIO

---

## Why Midnight

Midnight is the only production blockchain with native ZK privacy
built into the smart contract layer via the Compact language.

Every other chain requires complex off-chain ZK infrastructure bolted on.
Midnight makes confidential payments a first-class primitive.

For Nigerian merchants who need financial privacy without sacrificing
on-chain verifiability, Midnight is the only credible answer.

---

## Built With

- [Midnight Network](https://midnight.network)
- [SDL2](https://libsdl.org)
- [Nayuki QR Code generator](https://www.nayuki.io/page/qr-code-generator-library)
- [Node.js](https://nodejs.org)
- [Express](https://expressjs.com)

---

## Toluwanimi Alfred FADIPE 

Built solo for the MLH Midnight Hackathon 2026.
