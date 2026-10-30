/* Trusted POSIX exec substrate for the Node adapter. No workspace imports,
 * shell parsing, policy decisions or scheduling. Build before distribution;
 * never compile at install time. See local-process-manifest.json. */
#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE 1
#define _DEFAULT_SOURCE 1
#include <errno.h>
#include <inttypes.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <unistd.h>

#define CONTRACT "agentkit.local-process-control/v1"
#define MAX_EXACT UINT64_C(9007199254740991)
struct limit { const char *name; int resource; uint64_t requested; rlim_t effective; int status; };
static int number(const char *text, uint64_t *value) {
    if (!text || !*text || *text == '0') return -1;
    uint64_t n = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p; ++p) {
        if (*p < '0' || *p > '9' || n > (MAX_EXACT - (*p - '0')) / 10) return -1;
        n = n * 10 + (*p - '0');
    }
    *value = n; return 0;
}
static int write_all(int fd, const char *text, size_t length) {
    while (length) {
        ssize_t n = write(fd, text, length);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        text += n; length -= (size_t)n;
    }
    return 0;
}
static void watch_owner(int owner, int report, pid_t group) {
    close(report);
    close(STDIN_FILENO); close(STDOUT_FILENO); close(STDERR_FILENO);
    /* Hold the owned group through the caller's TERM->KILL cleanup window. */
    signal(SIGTERM, SIG_IGN);
    char byte;
    for (;;) {
        ssize_t n = read(owner, &byte, 1);
        if (n > 0) continue;
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            struct pollfd item = { .fd = owner, .events = POLLIN | POLLHUP };
            if (poll(&item, 1, -1) < 0 && errno != EINTR) break;
            continue;
        }
        break;
    }
    kill(-group, SIGKILL);
    _exit(0);
}
int main(int argc, char **argv) {
    /* cpu, address bytes, process count, open files, file bytes, report fd,
     * owner fd, --, executable, ... . All numbers are strict decimal data. */
    if (argc < 10 || strcmp(argv[8], "--") != 0) return 125;
    uint64_t values[7];
    for (int i = 0; i < 7; ++i) if (number(argv[i + 1], &values[i]) < 0) return 125;
    if (values[5] < 3 || values[5] > 1024 || values[6] < 3 || values[6] > 1024 || values[5] == values[6]) return 125;
    int report = (int)values[5], owner = (int)values[6];
    if (getpgrp() != getpid()) return 125;
    signal(SIGPIPE, SIG_IGN);
    struct limit limits[5] = {
        { "cpuSeconds", RLIMIT_CPU, values[0], 0, 0 },
        { "addressSpaceBytes", RLIMIT_AS, values[1], 0, 0 },
        { "maxProcesses", RLIMIT_NPROC, values[2], 0, 0 },
        { "maxOpenFiles", RLIMIT_NOFILE, values[3], 0, 0 },
        { "maxFileBytes", RLIMIT_FSIZE, values[4], 0, 0 },
    };
    int failed = 0, unsupported = 0;
    for (int i = 0; i < 5; ++i) {
        struct limit *item = &limits[i];
#if defined(__APPLE__)
        /* Match the reference's declared Darwin exceptions exactly. */
        if (i == 1 || i == 2) { item->status = 2; unsupported++; continue; }
#endif
        struct rlimit before, after;
        if (getrlimit(item->resource, &before) < 0) { item->status = 1; failed++; continue; }
        item->effective = (rlim_t)item->requested;
        if ((uint64_t)item->effective != item->requested) { item->status = 1; failed++; continue; }
        if (before.rlim_max != RLIM_INFINITY && before.rlim_max < item->effective) item->effective = before.rlim_max;
        struct rlimit desired = { .rlim_cur = item->effective, .rlim_max = item->effective };
        if (setrlimit(item->resource, &desired) < 0 || getrlimit(item->resource, &after) < 0
            || after.rlim_cur != item->effective || after.rlim_max != item->effective) { item->status = 1; failed++; }
    }
    pid_t watcher = -1;
    if (!failed) {
        watcher = fork();
        if (watcher == 0) watch_owner(owner, report, getpgrp());
        if (watcher < 0) failed++;
    }
    char buffer[4096];
    int at = snprintf(buffer, sizeof buffer, "{\"schemaVersion\":\"%s\",\"status\":\"%s\",\"watcherPid\":%ld,\"applied\":{",
        CONTRACT, failed ? "failed" : unsupported ? "partial" : "applied", (long)watcher);
    int count = 0;
    for (int i = 0; i < 5; ++i) if (limits[i].status == 0)
        at += snprintf(buffer + at, sizeof buffer - (size_t)at, "%s\"%s\":%" PRIu64,
            count++ ? "," : "", limits[i].name, (uint64_t)limits[i].effective);
    at += snprintf(buffer + at, sizeof buffer - (size_t)at, "},\"unsupported\":["); count = 0;
    for (int i = 0; i < 5; ++i) if (limits[i].status == 2)
        at += snprintf(buffer + at, sizeof buffer - (size_t)at, "%s\"%s\"", count++ ? "," : "", limits[i].name);
    at += snprintf(buffer + at, sizeof buffer - (size_t)at, "],\"failed\":["); count = 0;
    for (int i = 0; i < 5; ++i) if (limits[i].status == 1)
        at += snprintf(buffer + at, sizeof buffer - (size_t)at, "%s\"%s\"", count++ ? "," : "", limits[i].name);
    if (watcher < 0 && !count && failed) at += snprintf(buffer + at, sizeof buffer - (size_t)at, "\"owner_watchdog\"");
    at += snprintf(buffer + at, sizeof buffer - (size_t)at, "]}\n");
    if (at <= 0 || (size_t)at >= sizeof buffer || write_all(report, buffer, (size_t)at) < 0) return 125;
    close(report); close(owner);
    if (failed) return 125;
    /* SIGPIPE was changed only for the trusted report write. Restore default
     * before executing a program; its own signal behavior remains its choice. */
    signal(SIGPIPE, SIG_DFL);
    execvp(argv[9], &argv[9]);
    fputs("local-process launcher exec failed\n", stderr);
    return 126;
}
