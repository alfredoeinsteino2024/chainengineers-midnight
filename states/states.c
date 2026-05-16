#include "states.h"

const char* getStateName(TerminalState state)
{
    switch(state)
    {
        case STATE_IDLE:            return "IDLE";
        case STATE_ENTER_AMOUNT:    return "ENTER_AMOUNT";
        case STATE_PROCESSING:      return "PROCESSING";
        case STATE_WAITING_PAYMENT: return "WAITING_PAYMENT";
        case STATE_CONFIRMED:       return "CONFIRMED";
        case STATE_FAILED:          return "FAILED";
        case STATE_HISTORY:         return "HISTORY";
        case STATE_BALANCE:         return "BALANCE";
        default:                    return "UNKNOWN";
    }
}

void clearAmount(AmountInput *amount)
{
    memset(amount->digits, 0, sizeof(amount->digits));
    amount->len = 0;
}

void appendDigit(AmountInput *amount, char digit)
{
    if(amount->len < 10)
    {
        amount->digits[amount->len++] = digit;
        amount->digits[amount->len]   = '\0';
    }
}

void backspaceAmount(AmountInput *amount)
{
    if(amount->len > 0)
    {
        amount->digits[--amount->len] = '\0';
    }
}

void formatAmount(const AmountInput *amount, char *out, int outLen)
{
    if(amount->len == 0)
    {
        snprintf(out, outLen, "N0");
        return;
    }
    long value = atol(amount->digits);
    snprintf(out, outLen, "N%ld", value);
}
