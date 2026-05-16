#ifndef STATES_H
#define STATES_H

#include <string.h>
#include <stdio.h>
#include <stdlib.h>

typedef enum
{
    STATE_IDLE,
    STATE_ENTER_AMOUNT,
    STATE_PROCESSING,
    STATE_WAITING_PAYMENT,
    STATE_CONFIRMED,
    STATE_FAILED,
    STATE_HISTORY,
    STATE_BALANCE,
    STATE_COUNT
} TerminalState;

typedef struct
{
    char digits[12];
    int  len;
} AmountInput;

/* ─────────────────────────────────────────────
   TRANSACTION HISTORY
───────────────────────────────────────────── */
#define MAX_HISTORY  10
#define TX_DUST_LEN  16   /* was TX_SOL_LEN  */
#define TX_SIG_LEN   128  /* bumped: Midnight tx hashes are longer than Solana sigs */
#define TX_ID_LEN    32

/* Legacy alias — keeps any stray TX_SOL_LEN references building */
#define TX_SOL_LEN   TX_DUST_LEN

typedef struct
{
    char naira[16];
    char amount_dust[TX_DUST_LEN];   /* was amount_sol */
    char tx_hash[TX_SIG_LEN];        /* was tx_signature */
    char payment_id[TX_ID_LEN];
    char timestamp[32];
} TxRecord;

typedef struct
{
    TxRecord records[MAX_HISTORY];
    int      count;
    int      selected;
} TxHistory;

const char* getStateName(TerminalState state);
void clearAmount(AmountInput *amount);
void appendDigit(AmountInput *amount, char digit);
void backspaceAmount(AmountInput *amount);
void formatAmount(const AmountInput *amount, char *out, int outLen);

#endif /* STATES_H */
