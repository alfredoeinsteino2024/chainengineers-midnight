/*
 * network.c — ChainEngineers Payment Terminal
 * Raw socket HTTP client. No libcurl. No extra DLLs.
 * Works on Windows (Winsock2) and Linux/Mac (POSIX).
 * Phase 4: Midnight Network — renamed SOL→DUST, tx_signature→tx_hash
 */

#include "network.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/* ─────────────────────────────────────────────
   PLATFORM SOCKET SETUP
───────────────────────────────────────────── */
#ifdef _WIN32
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #pragma comment(lib, "ws2_32.lib")
    typedef SOCKET sock_t;
    #define SOCK_INVALID  INVALID_SOCKET
    #define SOCK_ERR      SOCKET_ERROR
    #define sock_close(s) closesocket(s)
    #define sock_errno    WSAGetLastError()
#else
    #include <sys/socket.h>
    #include <netinet/in.h>
    #include <arpa/inet.h>
    #include <unistd.h>
    #include <errno.h>
    typedef int sock_t;
    #define SOCK_INVALID  (-1)
    #define SOCK_ERR      (-1)
    #define sock_close(s) close(s)
    #define sock_errno    errno
#endif

/* ─────────────────────────────────────────────
   INTERNAL CONSTANTS
───────────────────────────────────────────── */
#define HTTP_BUF_SIZE    4096
#define POLL_INTERVAL_MS 2000
#define POLL_MAX_TRIES   60

/* ─────────────────────────────────────────────
   PUBLIC: network_init
───────────────────────────────────────────── */
int network_init(void)
{
#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2,2), &wsa) != 0) {
        fprintf(stderr, "[NET] WSAStartup failed: %d\n", WSAGetLastError());
        return -1;
    }
#endif
    printf("[NET] Network layer initialized (%s:%d)\n", NET_HOST, NET_PORT);
    return 0;
}

/* ─────────────────────────────────────────────
   PUBLIC: network_cleanup
───────────────────────────────────────────── */
void network_cleanup(void)
{
#ifdef _WIN32
    WSACleanup();
#endif
    printf("[NET] Network layer shut down\n");
}

/* ─────────────────────────────────────────────
   INTERNAL: open a TCP socket to backend
───────────────────────────────────────────── */
static sock_t open_connection(void)
{
    sock_t s = socket(AF_INET, SOCK_STREAM, 0);
    if (s == SOCK_INVALID) return SOCK_INVALID;

#ifdef _WIN32
    DWORD tv = NET_TIMEOUT_SEC * 1000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tv, sizeof(tv));
#else
    struct timeval tv = { NET_TIMEOUT_SEC, 0 };
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_port        = htons(NET_PORT);
    addr.sin_addr.s_addr = inet_addr(NET_HOST);

    if (connect(s, (struct sockaddr*)&addr, sizeof(addr)) == SOCK_ERR) {
        fprintf(stderr, "[NET] Connection refused — is the backend running?\n");
        sock_close(s);
        return SOCK_INVALID;
    }
    return s;
}

/* ─────────────────────────────────────────────
   INTERNAL: send HTTP request and read response
───────────────────────────────────────────── */
static int http_request(const char *method, const char *path,
                         const char *body,
                         char *response_out, int response_max)
{
    sock_t s = open_connection();
    if (s == SOCK_INVALID) return -1;

    char request[HTTP_BUF_SIZE];
    if (body && strlen(body) > 0) {
        snprintf(request, sizeof(request),
            "%s %s HTTP/1.0\r\n"
            "Host: %s:%d\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: %d\r\n"
            "Connection: close\r\n"
            "\r\n"
            "%s",
            method, path, NET_HOST, NET_PORT, (int)strlen(body), body);
    } else {
        snprintf(request, sizeof(request),
            "%s %s HTTP/1.0\r\n"
            "Host: %s:%d\r\n"
            "Connection: close\r\n"
            "\r\n",
            method, path, NET_HOST, NET_PORT);
    }

    if (send(s, request, (int)strlen(request), 0) == SOCK_ERR) {
        fprintf(stderr, "[NET] Send failed\n");
        sock_close(s);
        return -1;
    }

    char raw[HTTP_BUF_SIZE * 2];
    memset(raw, 0, sizeof(raw));
    int total = 0, bytes;
    while ((bytes = recv(s, raw + total, sizeof(raw) - total - 1, 0)) > 0) {
        total += bytes;
    }
    sock_close(s);

    if (total == 0) return -1;

    int status_code = 0;
    sscanf(raw, "HTTP/%*s %d", &status_code);

    char *body_start = strstr(raw, "\r\n\r\n");
    if (!body_start) return status_code;
    body_start += 4;

    strncpy(response_out, body_start, response_max - 1);
    response_out[response_max - 1] = '\0';

    return status_code;
}

/* ─────────────────────────────────────────────
   INTERNAL: minimal JSON string extractor
───────────────────────────────────────────── */
static int json_extract_string(const char *json, const char *key,
                                char *out, int out_len)
{
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);

    const char *pos = strstr(json, pattern);
    if (!pos) return 0;

    pos += strlen(pattern);
    while (*pos == ' ') pos++;

    if (*pos == '"') {
        pos++;
        int i = 0;
        while (*pos && *pos != '"' && i < out_len - 1) {
            out[i++] = *pos++;
        }
        out[i] = '\0';
        return i > 0;
    } else {
        int i = 0;
        while (*pos && *pos != ',' && *pos != '}' && *pos != '\n'
               && i < out_len - 1) {
            out[i++] = *pos++;
        }
        while (i > 0 && (out[i-1] == ' ' || out[i-1] == '\r')) i--;
        out[i] = '\0';
        return i > 0;
    }
}

/* ─────────────────────────────────────────────
   INTERNAL: parse status string to NetStatus
───────────────────────────────────────────── */
static NetStatus parse_status(const char *s)
{
    if (strcmp(s, "pending")   == 0) return NET_STATUS_PENDING;
    if (strcmp(s, "confirmed") == 0) return NET_STATUS_CONFIRMED;
    if (strcmp(s, "failed")    == 0) return NET_STATUS_FAILED;
    if (strcmp(s, "expired")   == 0) return NET_STATUS_EXPIRED;
    return NET_STATUS_ERROR;
}

/* ─────────────────────────────────────────────
   INTERNAL: parse a single history entry
───────────────────────────────────────────── */
static void parse_history_entry(const char *json, HistoryEntry *entry)
{
    memset(entry, 0, sizeof(HistoryEntry));

    char naira_str[16] = {0};
    json_extract_string(json, "payment_id",   entry->payment_id,  NET_ID_LEN);
    json_extract_string(json, "amount_naira", naira_str,          sizeof(naira_str));
    json_extract_string(json, "amount_dust",  entry->amount_dust, NET_DUST_LEN); /* was amount_sol */
    json_extract_string(json, "tx_hash",      entry->tx_hash,     NET_SIG_LEN);  /* was tx_signature */
    json_extract_string(json, "timestamp",    entry->timestamp,   NET_TIME_LEN);

    entry->amount_naira = naira_str[0] ? atoi(naira_str) : 0;
}

/* ─────────────────────────────────────────────
   PUBLIC: network_health_check
───────────────────────────────────────────── */
int network_health_check(void)
{
    char body[256];
    int code = http_request("GET", "/health", NULL, body, sizeof(body));
    return (code == 200);
}

/* ─────────────────────────────────────────────
   PUBLIC: network_create_payment
───────────────────────────────────────────── */
int network_create_payment(int amount_naira, PaymentResponse *out)
{
    memset(out, 0, sizeof(PaymentResponse));
    out->status = NET_STATUS_ERROR;

    char post_body[64];
    snprintf(post_body, sizeof(post_body), "{\"amount\":%d}", amount_naira);

    char response[HTTP_BUF_SIZE];
    int code = http_request("POST", "/payment/create",
                             post_body, response, sizeof(response));

    if (code != 200) {
        snprintf(out->error_msg, sizeof(out->error_msg),
                 "HTTP %d from /payment/create", code);
        fprintf(stderr, "[NET] create_payment failed: %s\n", out->error_msg);
        return -1;
    }

    printf("[NET] /payment/create response:\n%s\n", response);

    char status_str[32] = {0};
    json_extract_string(response, "payment_id",  out->payment_id,  NET_ID_LEN);
    json_extract_string(response, "qr_data",     out->qr_data,     NET_QR_LEN);
    json_extract_string(response, "amount_dust", out->amount_dust, NET_DUST_LEN); /* was amount_sol */
    json_extract_string(response, "status",      status_str,       sizeof(status_str));

    out->status = parse_status(status_str);

    printf("[NET] Payment created: ID=%s DUST=%s\n",
           out->payment_id, out->amount_dust);
    return 0;
}

/* ─────────────────────────────────────────────
   PUBLIC: network_poll_status
───────────────────────────────────────────── */
int network_poll_status(const char *payment_id, PaymentResponse *out)
{
    memset(out, 0, sizeof(PaymentResponse));
    out->status = NET_STATUS_ERROR;
    strncpy(out->payment_id, payment_id, NET_ID_LEN - 1);

    char path[128];
    snprintf(path, sizeof(path), "/payment/%s/status", payment_id);

    char response[HTTP_BUF_SIZE];
    int code = http_request("GET", path, NULL, response, sizeof(response));

    if (code != 200) {
        snprintf(out->error_msg, sizeof(out->error_msg),
                 "HTTP %d from %s", code, path);
        fprintf(stderr, "[NET] poll_status failed: %s\n", out->error_msg);
        return -1;
    }

    char status_str[32] = {0};
    json_extract_string(response, "status",      status_str,      sizeof(status_str));
    json_extract_string(response, "tx_hash",     out->tx_hash,    NET_SIG_LEN);  /* was tx_signature */
    json_extract_string(response, "amount_dust", out->amount_dust,NET_DUST_LEN); /* was amount_sol   */

    out->status = parse_status(status_str);

    printf("[NET] Poll: ID=%s status=%s\n", payment_id, status_str);
    return 0;
}

/* ─────────────────────────────────────────────
   PUBLIC: network_fetch_history
   GET /history
───────────────────────────────────────────── */
int network_fetch_history(HistoryResponse *out)
{
    memset(out, 0, sizeof(HistoryResponse));

    char response[HTTP_BUF_SIZE * 2];
    int code = http_request("GET", "/history", NULL, response, sizeof(response));

    if (code != 200) {
        fprintf(stderr, "[NET] fetch_history failed: HTTP %d\n", code);
        out->error = 1;
        return -1;
    }

    printf("[NET] /history response received\n");

    char count_str[8] = {0};
    json_extract_string(response, "count", count_str, sizeof(count_str));
    int count = count_str[0] ? atoi(count_str) : 0;
    if (count > NET_MAX_HISTORY) count = NET_MAX_HISTORY;
    out->count = count;

    if (count == 0) { out->ready = 1; return 0; }

    const char *arr = strstr(response, "\"transactions\":");
    if (!arr) { out->ready = 1; return 0; }
    arr = strchr(arr, '[');
    if (!arr) { out->ready = 1; return 0; }
    arr++;

    int idx = 0;
    while (idx < count && *arr)
    {
        const char *obj_start = strchr(arr, '{');
        if (!obj_start) break;

        int depth = 0;
        const char *p = obj_start;
        const char *obj_end = NULL;
        while (*p) {
            if (*p == '{') depth++;
            else if (*p == '}') {
                depth--;
                if (depth == 0) { obj_end = p; break; }
            }
            p++;
        }
        if (!obj_end) break;

        int obj_len = (int)(obj_end - obj_start + 1);
        if (obj_len < (int)sizeof(response)) {
            char obj_buf[512];
            int copy_len = obj_len < (int)sizeof(obj_buf) - 1
                           ? obj_len : (int)sizeof(obj_buf) - 1;
            memcpy(obj_buf, obj_start, copy_len);
            obj_buf[copy_len] = '\0';
            parse_history_entry(obj_buf, &out->entries[idx]);
            idx++;
        }
        arr = obj_end + 1;
    }

    out->count = idx;
    out->ready = 1;
    printf("[NET] History parsed: %d transactions\n", idx);
    return 0;
}

/* ─────────────────────────────────────────────
   PUBLIC: network_fetch_balance
   GET /balance  — now reads balance_dust + balance_night
───────────────────────────────────────────── */
int network_fetch_balance(BalanceResponse *out)
{
    memset(out, 0, sizeof(BalanceResponse));

    char response[HTTP_BUF_SIZE];
    int code = http_request("GET", "/balance", NULL, response, sizeof(response));

    if (code != 200) {
        fprintf(stderr, "[NET] fetch_balance failed: HTTP %d\n", code);
        out->error = 1;
        return -1;
    }

    json_extract_string(response, "address",       out->address,       NET_ADDR_LEN);
    json_extract_string(response, "balance_dust",  out->balance_dust,  NET_BAL_LEN); /* was balance_sol */
    json_extract_string(response, "balance_night", out->balance_night, NET_BAL_LEN); /* new: NIGHT token */

    out->ready = 1;
    printf("[NET] Balance: %s DUST | %s NIGHT | addr=%s\n",
           out->balance_dust, out->balance_night, out->address);
    return 0;
}

/* ─────────────────────────────────────────────
   PUBLIC: network_thread_create
───────────────────────────────────────────── */
int network_thread_create(void *data)
{
    CreateThreadData *d = (CreateThreadData*)data;
    PaymentResponse result;

    int ok = network_create_payment(d->amount_naira, &result);

    SDL_LockMutex(d->result->mutex);
    d->result->response = result;
    d->result->ready    = 1;
    if (ok != 0)
        d->result->response.status = NET_STATUS_ERROR;
    SDL_UnlockMutex(d->result->mutex);

    free(d);
    return 0;
}

/* ─────────────────────────────────────────────
   PUBLIC: network_thread_poll
───────────────────────────────────────────── */
int network_thread_poll(void *data)
{
    PollThreadData *d = (PollThreadData*)data;
    int tries = 0;

    while (tries < POLL_MAX_TRIES)
    {
        SDL_LockMutex(d->result->mutex);
        int should_stop = d->result->stop;
        SDL_UnlockMutex(d->result->mutex);
        if (should_stop) break;

        SDL_Delay(POLL_INTERVAL_MS);
        tries++;

        PaymentResponse poll_result;
        int ok = network_poll_status(d->payment_id, &poll_result);

        SDL_LockMutex(d->result->mutex);
        if (ok != 0) { SDL_UnlockMutex(d->result->mutex); continue; }

        d->result->response.status = poll_result.status;
        if (poll_result.tx_hash[0])
            strncpy(d->result->response.tx_hash,
                    poll_result.tx_hash, NET_SIG_LEN - 1); /* was tx_signature */

        int done = (poll_result.status == NET_STATUS_CONFIRMED ||
                    poll_result.status == NET_STATUS_FAILED    ||
                    poll_result.status == NET_STATUS_EXPIRED);
        if (done) d->result->ready = 1;
        SDL_UnlockMutex(d->result->mutex);
        if (done) break;
    }

    SDL_LockMutex(d->result->mutex);
    if (!d->result->ready) {
        d->result->response.status = NET_STATUS_EXPIRED;
        d->result->ready = 1;
        printf("[NET] Poll timeout — payment expired after %d tries\n", tries);
    }
    SDL_UnlockMutex(d->result->mutex);

    d->result->polling = 0;
    free(d);
    return 0;
}

/* ─────────────────────────────────────────────
   PUBLIC: network_thread_history
───────────────────────────────────────────── */
int network_thread_history(void *data)
{
    HistoryThreadData *d = (HistoryThreadData*)data;
    HistoryResponse result;
    network_fetch_history(&result);
    SDL_LockMutex(d->mutex);
    *(d->result) = result;
    SDL_UnlockMutex(d->mutex);
    free(d);
    return 0;
}

/* ─────────────────────────────────────────────
   PUBLIC: network_thread_balance
───────────────────────────────────────────── */
int network_thread_balance(void *data)
{
    BalanceThreadData *d = (BalanceThreadData*)data;
    BalanceResponse result;
    network_fetch_balance(&result);
    SDL_LockMutex(d->mutex);
    *(d->result) = result;
    SDL_UnlockMutex(d->mutex);
    free(d);
    return 0;
}

/* ─────────────────────────────────────────────
   PUBLIC: network_status_name
───────────────────────────────────────────── */
const char *network_status_name(NetStatus status)
{
    switch (status) {
        case NET_STATUS_NONE:      return "NONE";
        case NET_STATUS_PENDING:   return "PENDING";
        case NET_STATUS_CONFIRMED: return "CONFIRMED";
        case NET_STATUS_FAILED:    return "FAILED";
        case NET_STATUS_EXPIRED:   return "EXPIRED";
        case NET_STATUS_ERROR:     return "ERROR";
        default:                   return "UNKNOWN";
    }
}

int network_get_balance(char *response_out, int response_max)
{
    return http_request("GET", "/wallet/balance", NULL,
                        response_out, response_max);
}

void network_parse_field(const char *json, const char *key,
                          char *out, int out_len)
{
    memset(out, 0, out_len);
    json_extract_string(json, key, out, out_len);
}
