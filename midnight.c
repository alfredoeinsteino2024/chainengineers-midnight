/*
 * midnight.c — ChainEngineers Payment Terminal
 * Phase 4: Midnight Network Integration
 * Passive monitor watches for incoming DUST (Midnight) even when IDLE.
 */

#include <SDL2/SDL.h>
#include <SDL2/SDL_ttf.h>
#include <stdio.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "ui/ui.h"
#include "states/states.h"
#include "network/network.h"

#define WIDTH  800
#define HEIGHT 480

/* ─────────────────────────────────────────────
   GLOBALS
───────────────────────────────────────────── */
NetworkResult g_net;
TxHistory     g_history;
char          g_balance_dust[32]  = "";   /* was g_balance_sol */
char          g_balance_naira[32] = "";

/* Passive monitor shared state */
SDL_mutex    *g_monitor_mutex      = NULL;
char          g_incoming_tx[TX_SIG_LEN]   = "";
char          g_incoming_dust[TX_DUST_LEN] = "";  /* was g_incoming_sol / TX_SOL_LEN */
int           g_incoming_ready             = 0;

/* ─────────────────────────────────────────────
   INTERNAL: record a confirmed transaction
───────────────────────────────────────────── */
static void record_transaction(const char *naira,
                                const char *dust,       /* was: sol */
                                const char *tx,
                                const char *pay_id)
{
    if (g_history.count >= MAX_HISTORY)
    {
        memmove(&g_history.records[0], &g_history.records[1],
                sizeof(TxRecord) * (MAX_HISTORY - 1));
        g_history.count = MAX_HISTORY - 1;
    }

    TxRecord *r = &g_history.records[g_history.count];
    memset(r, 0, sizeof(TxRecord));

    strncpy(r->naira,       naira,   15);
    strncpy(r->amount_dust, dust,    TX_DUST_LEN - 1); /* was amount_sol */
    strncpy(r->tx_hash,     tx,      TX_SIG_LEN  - 1); /* was tx_signature */
    strncpy(r->payment_id,  pay_id,  TX_ID_LEN   - 1);

    Uint32 t = SDL_GetTicks() / 1000;
    snprintf(r->timestamp, sizeof(r->timestamp), "%02d:%02d:%02d",
             (t / 3600) % 24, (t / 60) % 60, t % 60);

    g_history.count++;
    printf("[MAIN] Transaction recorded. Total: %d\n", g_history.count);
    fflush(stdout);
}

/* ─────────────────────────────────────────────
   PASSIVE CONFIDENTIAL PAYMENT MONITOR
   Polls backend every 10 seconds for newly
   confirmed Midnight transactions.
───────────────────────────────────────────── */
int passive_monitor_thread(void *data)
{
    (void)data;

    printf("[MONITOR] Midnight monitor started\n");
    fflush(stdout);

    while (1)
    {
        SDL_Delay(10000);

        char response[4096];

        int code = network_get_balance(response, sizeof(response));

        if (code != 200)
            continue;

        /* Parse Midnight payment fields from /wallet/balance response */
        char incoming_amount[TX_DUST_LEN] = "";  /* was TX_SOL_LEN */
        char incoming_tx[TX_SIG_LEN]      = "";

        /* Field names now match what server.js /wallet/balance returns */
        network_parse_field(response,
                            "balance_dust",   /* was "incoming_confidential" */
                            incoming_amount,
                            sizeof(incoming_amount));

        network_parse_field(response,
                            "last_tx",        /* was "confidential_tx" — matches GET /wallet/balance */
                            incoming_tx,
                            sizeof(incoming_tx));

        if (incoming_amount[0] && incoming_tx[0])
        {
            SDL_LockMutex(g_monitor_mutex);

            if (strcmp(incoming_tx, g_incoming_tx) != 0)
            {
                strncpy(g_incoming_tx,
                        incoming_tx,
                        TX_SIG_LEN - 1);

                strncpy(g_incoming_dust,       /* was g_incoming_sol */
                        incoming_amount,
                        TX_DUST_LEN - 1);

                strncpy(g_balance_dust,        /* was g_balance_sol */
                        incoming_amount,
                        31);

                g_incoming_ready = 1;

                printf("[MONITOR] Midnight TX confirmed: %s\n",
                       incoming_tx);

                fflush(stdout);
            }

            SDL_UnlockMutex(g_monitor_mutex);
        }
    }

    return 0;
}

/* ─────────────────────────────────────────────
   INTERNAL: kick off payment creation thread
───────────────────────────────────────────── */
static void start_create_payment(int amount_naira)
{
    SDL_LockMutex(g_net.mutex);
    memset(&g_net.response, 0, sizeof(PaymentResponse));
    g_net.ready      = 0;
    g_net.stop       = 0;
    g_net.polling    = 0;
    g_net.poll_start = 0;
    SDL_UnlockMutex(g_net.mutex);

    CreateThreadData *data = malloc(sizeof(CreateThreadData));
    data->amount_naira     = amount_naira;
    data->result           = &g_net;

    SDL_Thread *t = SDL_CreateThread(network_thread_create,
                                     "CreatePayment", data);
    SDL_DetachThread(t);

    printf("[MAIN] Payment creation thread started for N%d\n", amount_naira);
    fflush(stdout);
}

/* ─────────────────────────────────────────────
   INTERNAL: kick off polling thread
───────────────────────────────────────────── */
static void start_poll_payment(const char *payment_id)
{
    SDL_LockMutex(g_net.mutex);
    g_net.ready      = 0;
    g_net.stop       = 0;
    g_net.polling    = 1;
    g_net.poll_start = 1;
    SDL_UnlockMutex(g_net.mutex);

    PollThreadData *data = malloc(sizeof(PollThreadData));
    strncpy(data->payment_id, payment_id, NET_ID_LEN - 1);
    data->payment_id[NET_ID_LEN - 1] = '\0';
    data->result = &g_net;

    SDL_Thread *t = SDL_CreateThread(network_thread_poll,
                                     "PollPayment", data);
    SDL_DetachThread(t);

    printf("[MAIN] Poll thread started for ID=%s\n", payment_id);
    fflush(stdout);
}

/* ─────────────────────────────────────────────
   MAIN
───────────────────────────────────────────── */
int main(int argc, char *argv[])
{
    if (SDL_Init(SDL_INIT_VIDEO) != 0)
    { printf("SDL Init Error: %s\n", SDL_GetError()); return 1; }

    if (TTF_Init() != 0)
    { printf("TTF Init Error: %s\n", TTF_GetError()); return 1; }

    SDL_Window *window = SDL_CreateWindow(
        "ChainEngineers Midnight Terminal",
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
        WIDTH, HEIGHT, 0
    );
    if (!window) { printf("Window Error: %s\n", SDL_GetError()); return 1; }

    SDL_Renderer *renderer = SDL_CreateRenderer(
        window, -1, SDL_RENDERER_ACCELERATED);
    if (!renderer) { printf("Renderer Error: %s\n", SDL_GetError()); return 1; }

    TTF_Font *font = TTF_OpenFont("assets/Roboto_Condensed-Regular.ttf", 28);
    if (!font) { printf("Font Error: %s\n", TTF_GetError()); return 1; }

    TTF_Font *fontLarge = TTF_OpenFont("assets/Roboto_Condensed-Regular.ttf", 56);
    if (!fontLarge) { printf("Font Large Error: %s\n", TTF_GetError()); return 1; }

    /* ── Init globals ────────────────────── */
    memset(&g_net,     0, sizeof(NetworkResult));
    memset(&g_history, 0, sizeof(TxHistory));

    g_net.mutex     = SDL_CreateMutex();
    g_monitor_mutex = SDL_CreateMutex();

    if (!g_net.mutex || !g_monitor_mutex) {
        printf("Mutex Error: %s\n", SDL_GetError());
        return 1;
    }

    /* ── Network init ────────────────────── */
    if (network_init() != 0) {
        printf("[MAIN] WARNING: Network init failed.\n");
    } else {
        printf("[MAIN] Backend health: %s\n",
               network_health_check() ? "ONLINE" : "OFFLINE");
        fflush(stdout);
    }

    /* ── Start passive monitor thread ───── */
    SDL_Thread *monitor = SDL_CreateThread(passive_monitor_thread,
                                           "PassiveMonitor", NULL);
    SDL_DetachThread(monitor);

    /* ── Terminal state ──────────────────── */
    TerminalState currentState = STATE_IDLE;
    AmountInput   amount;
    clearAmount(&amount);

    bool running = true;
    SDL_Event event;
    SDL_StartTextInput();

    printf("ChainEngineers Midnight Terminal Started\n");
    printf("Keys: ENTER=pay  H=history  B=balance  ESC=back\n");
    fflush(stdout);

    /* ── Main loop ───────────────────────── */
    while (running)
    {
        /* ── Events ─────────────────────── */
        while (SDL_PollEvent(&event))
        {
            if (event.type == SDL_QUIT)
                running = false;

            if (event.type == SDL_TEXTINPUT
                && currentState == STATE_ENTER_AMOUNT)
            {
                char c = event.text.text[0];
                if (c >= '0' && c <= '9') {
                    appendDigit(&amount, c);
                }
            }

            if (event.type == SDL_KEYDOWN)
            {
                SDL_Keycode key = event.key.keysym.sym;

                if (key == SDLK_ESCAPE)
                {
                    if (currentState == STATE_IDLE) {
                        running = false;
                    } else if (currentState == STATE_HISTORY ||
                               currentState == STATE_BALANCE) {
                        currentState = STATE_IDLE;
                    } else {
                        SDL_LockMutex(g_net.mutex);
                        g_net.stop = 1;
                        SDL_UnlockMutex(g_net.mutex);
                        clearAmount(&amount);
                        currentState = STATE_IDLE;
                    }
                }
                else if (currentState == STATE_IDLE)
                {
                    if (key == SDLK_RETURN) {
                        clearAmount(&amount);
                        currentState = STATE_ENTER_AMOUNT;
                    }
                    else if (key == SDLK_h) {
                        currentState = STATE_HISTORY;
                    }
                    else if (key == SDLK_b) {
                        currentState = STATE_BALANCE;
                    }
                }
                else if (currentState == STATE_ENTER_AMOUNT)
                {
                    if (key == SDLK_RETURN && amount.len > 0) {
                        int naira = atoi(amount.digits);
                        start_create_payment(naira);
                        currentState = STATE_PROCESSING;
                    }
                    else if (key == SDLK_BACKSPACE) {
                        backspaceAmount(&amount);
                    }
                    else if (key >= SDLK_KP_0 && key <= SDLK_KP_9) {
                        appendDigit(&amount, '0' + (key - SDLK_KP_0));
                    }
                }
                else if (currentState == STATE_PROCESSING)
                {
                    if (key == SDLK_p) {
                        currentState = STATE_CONFIRMED;
                        printf("[DEBUG] Manual confirm\n");
                    }
                    if (key == SDLK_f) {
                        currentState = STATE_FAILED;
                        printf("[DEBUG] Manual fail\n");
                    }
                }
                else if (currentState == STATE_CONFIRMED)
                {
                    if (key == SDLK_RETURN) {
                        clearAmount(&amount);
                        currentState = STATE_IDLE;
                    }
                    else if (key == SDLK_h) {
                        currentState = STATE_HISTORY;
                    }
                }
                else if (currentState == STATE_FAILED)
                {
                    if (key == SDLK_RETURN) {
                        clearAmount(&amount);
                        currentState = STATE_IDLE;
                    }
                }
                else if (currentState == STATE_HISTORY)
                {
                    if (key == SDLK_UP && g_history.selected > 0)
                        g_history.selected--;
                    else if (key == SDLK_DOWN &&
                             g_history.selected < g_history.count - 1)
                        g_history.selected++;
                }

                printf("[MAIN] State: %s\n", getStateName(currentState));
                fflush(stdout);
            }
        }

        /* ── Passive monitor check ───────── */
        {
            SDL_LockMutex(g_monitor_mutex);
            int  inc_ready = g_incoming_ready;
            char inc_tx[TX_SIG_LEN]    = "";
            char inc_dust[TX_DUST_LEN] = "";   /* was inc_sol / TX_SOL_LEN */
            strncpy(inc_tx,   g_incoming_tx,   TX_SIG_LEN  - 1);
            strncpy(inc_dust, g_incoming_dust, TX_DUST_LEN - 1); /* was g_incoming_sol */
            if (inc_ready) g_incoming_ready = 0;
            SDL_UnlockMutex(g_monitor_mutex);

            if (inc_ready)
            {
                printf("[MAIN] Passive: incoming %s DUST | TX=%s\n", /* was SOL */
                       inc_dust, inc_tx);
                fflush(stdout);

                record_transaction("?", inc_dust, inc_tx, "PASSIVE");

                snprintf(g_balance_dust, sizeof(g_balance_dust),
                         "%s DUST", inc_dust);                      /* was g_balance_sol / SOL */

                if (currentState == STATE_IDLE)
                    currentState = STATE_CONFIRMED;
            }
        }

        /* ── Network state check ─────────── */
        {
            NetStatus net_status;
            int       net_poll_start;
            char      snap_id[NET_ID_LEN];
            char      snap_tx[NET_SIG_LEN];
            char      snap_dust[NET_DUST_LEN];  /* was snap_sol / NET_SOL_LEN */

            SDL_LockMutex(g_net.mutex);
            net_status     = g_net.response.status;
            net_poll_start = g_net.poll_start;
            strncpy(snap_id,   g_net.response.payment_id,  NET_ID_LEN   - 1);
            strncpy(snap_tx,   g_net.response.tx_hash,     NET_SIG_LEN  - 1); /* was tx_signature */
            strncpy(snap_dust, g_net.response.amount_dust, NET_DUST_LEN - 1); /* was amount_sol */
            snap_id[NET_ID_LEN   - 1] = '\0';
            snap_tx[NET_SIG_LEN  - 1] = '\0';
            snap_dust[NET_DUST_LEN-1] = '\0';
            SDL_UnlockMutex(g_net.mutex);

            if (currentState == STATE_PROCESSING)
            {
                if (net_status == NET_STATUS_ERROR)
                {
                    printf("[MAIN] Create payment failed -> FAILED\n");
                    fflush(stdout);
                    currentState = STATE_FAILED;
                }
                else if (net_status == NET_STATUS_PENDING
                         && snap_id[0] != '\0'
                         && !net_poll_start)
                {
                    printf("[MAIN] Payment created. ID=%s -> WAITING\n", snap_id);
                    fflush(stdout);
                    currentState = STATE_WAITING_PAYMENT;
                    start_poll_payment(snap_id);
                }
            }
            else if (currentState == STATE_WAITING_PAYMENT)
            {
                static NetStatus last_printed = NET_STATUS_NONE;
                if (net_status != last_printed) {
                    printf("[NET POLL] status=%s\n",
                           network_status_name(net_status));
                    fflush(stdout);
                    last_printed = net_status;
                }

                if (net_status == NET_STATUS_CONFIRMED)
                {
                    printf("[MAIN] *** PAYMENT CONFIRMED *** TX=%.24s...\n",
                           snap_tx);
                    fflush(stdout);

                    record_transaction(amount.digits, snap_dust,  /* was snap_sol */
                                       snap_tx, snap_id);

                    snprintf(g_balance_dust, sizeof(g_balance_dust),
                             "%s DUST", snap_dust);               /* was g_balance_sol / SOL */

                    currentState = STATE_CONFIRMED;
                }
                else if (net_status == NET_STATUS_FAILED  ||
                         net_status == NET_STATUS_EXPIRED ||
                         net_status == NET_STATUS_ERROR)
                {
                    printf("[MAIN] Payment failed/expired -> FAILED\n");
                    fflush(stdout);
                    currentState = STATE_FAILED;
                }
            }
        }

        /* ── Render ──────────────────────── */
        renderScreen[currentState](renderer, font, fontLarge, &amount);
        SDL_RenderPresent(renderer);
        SDL_Delay(16);
    }

    /* ── Cleanup ────────────────────────── */
    SDL_LockMutex(g_net.mutex);
    g_net.stop = 1;
    SDL_UnlockMutex(g_net.mutex);
    SDL_Delay(100);

    network_cleanup();
    SDL_DestroyMutex(g_net.mutex);
    SDL_DestroyMutex(g_monitor_mutex);

    TTF_CloseFont(fontLarge);
    TTF_CloseFont(font);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    TTF_Quit();
    SDL_Quit();

    return 0;
}
