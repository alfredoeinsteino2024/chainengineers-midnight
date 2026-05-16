#ifndef NETWORK_H
#define NETWORK_H

/*
 * network.h — ChainEngineers Payment Terminal
 * HTTP client layer: SDL2 Terminal <-> Node.js Backend <-> Midnight Network
 *
 * Uses raw Winsock2 (Windows) or POSIX sockets (Linux/Mac).
 * Zero external dependencies beyond what you already have.
 *
 * THREAD SAFETY:
 *   network_create_payment() and network_poll_status() are blocking.
 *   Call them from a background SDL_Thread — never from the render loop.
 *   Use the NetworkResult shared struct + mutex pattern shown below.
 */

#include <SDL2/SDL.h>

/* ─────────────────────────────────────────────
   BACKEND CONFIG
───────────────────────────────────────────── */
#define NET_HOST        "127.0.0.1"
#define NET_PORT        3000
#define NET_TIMEOUT_SEC 8

/* ─────────────────────────────────────────────
   PAYMENT STATUS — mirrors backend response
───────────────────────────────────────────── */
typedef enum
{
    NET_STATUS_NONE = 0,
    NET_STATUS_PENDING,
    NET_STATUS_CONFIRMED,
    NET_STATUS_FAILED,
    NET_STATUS_EXPIRED,
    NET_STATUS_ERROR
} NetStatus;

/* ─────────────────────────────────────────────
   BUFFER SIZES
   Midnight values are larger than Solana:
     Addresses  : Bech32m  ~65 chars  (vs base58 ~44)
     TX hashes  : hex 64+  ~128 chars (vs base58 ~88)
     QR URIs    : midnight:<addr>?amount=X&memo=ID → up to 512 chars
───────────────────────────────────────────── */
#define NET_ID_LEN    32
#define NET_QR_LEN    512   /* bumped from 256 — Midnight URIs are longer */
#define NET_SIG_LEN   128   /* bumped from 96  — Midnight tx hashes       */
#define NET_DUST_LEN  16    /* was NET_SOL_LEN */
#define NET_TIME_LEN  16
#define NET_ADDR_LEN  96    /* bumped from 48  — Bech32m addresses        */
#define NET_BAL_LEN   20

/* Legacy alias — keeps stray NET_SOL_LEN references building */
#define NET_SOL_LEN   NET_DUST_LEN

/* ─────────────────────────────────────────────
   PAYMENT RESPONSE
───────────────────────────────────────────── */
typedef struct
{
    char      payment_id[NET_ID_LEN];
    char      qr_data[NET_QR_LEN];
    char      tx_hash[NET_SIG_LEN];      /* was tx_signature */
    char      amount_dust[NET_DUST_LEN]; /* was amount_sol   */
    NetStatus status;
    char      error_msg[64];
} PaymentResponse;

/* ─────────────────────────────────────────────
   HISTORY ENTRY — one confirmed transaction
───────────────────────────────────────────── */
typedef struct
{
    char payment_id[NET_ID_LEN];
    int  amount_naira;
    char amount_dust[NET_DUST_LEN];  /* was amount_sol   */
    char tx_hash[NET_SIG_LEN];       /* was tx_signature */
    char timestamp[NET_TIME_LEN];
} HistoryEntry;

/* ─────────────────────────────────────────────
   HISTORY RESPONSE — up to 10 transactions
───────────────────────────────────────────── */
#define NET_MAX_HISTORY 10

typedef struct
{
    HistoryEntry entries[NET_MAX_HISTORY];
    int          count;
    int          ready;     /* 1 = data available */
    int          error;     /* 1 = fetch failed   */
} HistoryResponse;

/* ─────────────────────────────────────────────
   BALANCE RESPONSE
───────────────────────────────────────────── */
typedef struct
{
    char address[NET_ADDR_LEN];
    char balance_dust[NET_BAL_LEN];  /* was balance_sol */
    char balance_night[NET_BAL_LEN]; /* NIGHT token — governance/staking */
    int  ready;     /* 1 = data available */
    int  error;     /* 1 = fetch failed   */
} BalanceResponse;

/* ─────────────────────────────────────────────
   SHARED RESULT — thread-safe bridge between
   network thread and render loop.
───────────────────────────────────────────── */
typedef struct
{
    PaymentResponse response;
    SDL_mutex      *mutex;
    int             ready;
    int             polling;
    int             stop;
    int             poll_start;
} NetworkResult;

/* ─────────────────────────────────────────────
   THREAD DATA
───────────────────────────────────────────── */
typedef struct
{
    int            amount_naira;
    NetworkResult *result;
} CreateThreadData;

typedef struct
{
    char           payment_id[NET_ID_LEN];
    NetworkResult *result;
} PollThreadData;

typedef struct
{
    HistoryResponse *result;
    SDL_mutex       *mutex;
} HistoryThreadData;

typedef struct
{
    BalanceResponse *result;
    SDL_mutex       *mutex;
} BalanceThreadData;

/* ─────────────────────────────────────────────
   PUBLIC API
───────────────────────────────────────────── */

/* Call once at startup */
int  network_init(void);

/* Call once at shutdown */
void network_cleanup(void);

/* Check if backend is reachable — returns 1 if ok */
int  network_health_check(void);

/* Blocking: POST /payment/create */
int  network_create_payment(int amount_naira, PaymentResponse *out);

/* Blocking: GET /payment/:id/status */
int  network_poll_status(const char *payment_id, PaymentResponse *out);

/* Blocking: GET /history */
int  network_fetch_history(HistoryResponse *out);

/* Blocking: GET /balance */
int  network_fetch_balance(BalanceResponse *out);

/* SDL_Thread entry points */
int  network_thread_create(void *data);   /* CreateThreadData*  */
int  network_thread_poll(void *data);     /* PollThreadData*    */
int  network_thread_history(void *data);  /* HistoryThreadData* */
int  network_thread_balance(void *data);  /* BalanceThreadData* */

/* Convert NetStatus to display string */
const char *network_status_name(NetStatus status);

int  network_get_balance(char *response_out, int response_max);
void network_parse_field(const char *json, const char *key,
                          char *out, int out_len);

#endif /* NETWORK_H */
