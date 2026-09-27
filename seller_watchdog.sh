#!/usr/bin/env bash
# seller_watchdog.sh -- keeps seller.js running on this machine.
#
# Restarts seller.js if its node process dies, and kills + restarts it if
# its heartbeat file (written every 30s by seller.js itself) goes stale.
# Every restart is appended to watchdog_restarts.log, with the last
# heartbeat's status. See doc/seller_and_swapservice_watchdogs.md.
#
# Run:   nohup ./seller_watchdog.sh >> seller_watchdog.out 2>&1 &
# Stop:  kill <watchdog pid>   (it stops seller.js first, then exits)
#
# Before the first run: seller.config filled in (no blank seller_id_key or
# allow_ephemeral_swapservice), and seller.env created from
# seller.env.example with chmod 600.

set -u

# ---- settings ----
NAME=seller
NODE_BIN=node
NODE_SCRIPT=seller.js
CONFIG_FILE=seller.config
ENV_FILE=seller.env                 # KEY=VALUE lines, sourced before every start
NODE_LOG=seller.log                 # seller.js stdout/stderr, appended
RESTART_LOG=watchdog_restarts.log
PID_FILE=seller.pid                 # pid of the seller.js this watchdog started
LOCK_FILE=.seller_watchdog.lock     # one watchdog per directory
CHECK_INTERVAL=15                   # seconds between checks
STARTUP_GRACE=120                   # seconds a new process gets to write its first heartbeat
STALE_AFTER=180                     # heartbeat older than this (seconds) = unresponsive; written every 30s
TERM_WAIT=15                        # seconds to wait after SIGTERM before SIGKILL
HEALTHY_RUNTIME=300                 # a run shorter than this (seconds) counts as a quick failure
BACKOFF_START=10                    # first restart delay after a quick failure (seconds), doubles each time
BACKOFF_MAX=300
MAX_QUICK_FAILURES=5                # consecutive quick failures before giving up

cd "$(dirname "$0")" || exit 1

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ${NAME}_watchdog: $*"; }
die() { log "FATAL: $*"; exit 1; }
banner() {
    log "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    local line; for line in "$@"; do log "!!! $line"; done
    log "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
}

# value of KEY in the KEY=VALUE config file (last occurrence wins, like the
# node side's parser); empty if missing or blank
config_value() {
    grep -E "^$1=" "$CONFIG_FILE" | tail -n 1 | sed -e 's/^[^=]*=//' -e 's/[[:space:]]*$//'
}

# true while pid $1 exists and isn't a zombie (a child that exited but
# hasn't been reaped yet still answers kill -0)
is_running() {
    local state
    state=$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null) || return 1
    [ -n "$state" ] && [ "$state" != "Z" ]
}

# ---- preflight: the watchdog prerequisites (see the doc) ----
[ -f "$NODE_SCRIPT" ] || die "$NODE_SCRIPT not found in $(pwd)"
[ -f "$CONFIG_FILE" ] || die "$CONFIG_FILE not found -- cp $CONFIG_FILE.example $CONFIG_FILE and fill it in"
[ -d node_modules ] || die "node_modules missing -- run npm ci in $(pwd) first"
command -v flock >/dev/null || die "flock not found (util-linux) -- needed to keep one watchdog per directory"

# prerequisite 1: nothing may prompt for keyboard input at startup -- under a
# watchdog there's no keyboard, so the process would hang at the prompt
[ -n "$(config_value seller_id_key)" ] || die "seller_id_key is blank in $CONFIG_FILE -- seller.js would stop at startup and prompt for it. Set a fixed key (or 'random')."
[ -n "$(config_value allow_ephemeral_swapservice)" ] || die "allow_ephemeral_swapservice is blank in $CONFIG_FILE -- seller.js would stop at startup and prompt for it. Set yes or no."

# prerequisite 2: a random identity survives restarts badly -- warned, not refused
if [ "$(config_value seller_id_key)" = "random" ]; then
    banner "seller_id_key=random: EVERY RESTART GIVES THIS SELLER A NEW NOSTR IDENTITY." \
           "Its swapservice drops the old identity only after ~10 minutes of silence; no offers are posted until then." \
           "Set a fixed key for unattended running."
fi

# prerequisite 5: environment variables, from the env file
if [ -f "$ENV_FILE" ]; then
    perms=$(stat -c %a "$ENV_FILE")
    case "$perms" in
        600|400) ;;
        *) banner "$ENV_FILE is mode $perms -- it holds SELLER_PRIV_KEY. Run: chmod 600 $ENV_FILE" ;;
    esac
    set -a
    # shellcheck disable=SC1090
    . "./$ENV_FILE"
    set +a
fi
[ -n "${SELLER_PRIV_KEY:-}" ] || die "SELLER_PRIV_KEY not set -- put it in $ENV_FILE (see $ENV_FILE.example)"
[ -n "${EVR_PER_BTC:-}" ] || die "EVR_PER_BTC not set -- put it in $ENV_FILE (see $ENV_FILE.example)"
if [ -n "$(config_value asset_name)" ] && [ -z "${ASSET_PER_BTC:-}" ]; then
    die "asset_name is set in $CONFIG_FILE, so ASSET_PER_BTC is required -- put it in $ENV_FILE"
fi

HEARTBEAT_FILE=$(config_value heartbeat_file)
HEARTBEAT_FILE=${HEARTBEAT_FILE:-seller-heartbeat.json}

# prerequisite 4: never two instances -- one watchdog per directory, and no
# seller.js already running from this directory (started by hand, or left
# behind by a watchdog that died)
exec 9>"$LOCK_FILE"
flock -n 9 || die "another ${NAME}_watchdog is already running in $(pwd)"
# true if pid $1 is a node process running $NODE_SCRIPT from this directory
is_our_node() {
    local args
    [ "$(readlink "/proc/$1/cwd" 2>/dev/null)" = "$(pwd)" ] || return 1
    args=$(tr '\0' '\n' < "/proc/$1/cmdline" 2>/dev/null) || return 1
    [[ "$(basename "$(head -n 1 <<< "$args")")" == node* ]] || return 1
    grep -qxF -e "$NODE_SCRIPT" -e "./$NODE_SCRIPT" -e "$(pwd)/$NODE_SCRIPT" <<< "$args"
}
for pid in $(pgrep -f "$NODE_SCRIPT" || true); do
    if is_our_node "$pid"; then
        die "$NODE_SCRIPT is already running from this directory (pid $pid) -- stop it before starting the watchdog"
    fi
done

# ---- process control ----
CHILD=""
STARTED_AT=0

start_node() {
    # a heartbeat left over from the previous run must not count for this one
    rm -f "$HEARTBEAT_FILE"
    # stdin from /dev/null: an unexpected prompt gets EOF instead of a keyboard
    # 9>&-: the child must not inherit the watchdog's lock, or an orphaned
    # seller.js would keep it held after the watchdog itself died
    "$NODE_BIN" "$NODE_SCRIPT" "$CONFIG_FILE" < /dev/null >> "$NODE_LOG" 2>&1 9>&- &
    CHILD=$!
    STARTED_AT=$(date +%s)
    echo "$CHILD" > "$PID_FILE"
    HALT_REPORTED=0
    log "started $NODE_SCRIPT (pid $CHILD), output in $NODE_LOG"
}

# kill-then-wait: SIGTERM, up to TERM_WAIT seconds, then SIGKILL, then wait
# until the process is really gone before returning -- a new instance must
# never start while the old one could still be signing
stop_node() {
    [ -n "$CHILD" ] || return 0
    if is_running "$CHILD"; then
        kill -TERM "$CHILD" 2>/dev/null
        local i
        for (( i = 0; i < TERM_WAIT; i++ )); do
            is_running "$CHILD" || break
            sleep 1
        done
        if is_running "$CHILD"; then
            log "pid $CHILD still running ${TERM_WAIT}s after SIGTERM -- sending SIGKILL"
            kill -KILL "$CHILD" 2>/dev/null
        fi
        while is_running "$CHILD"; do sleep 1; done
    fi
    wait "$CHILD" 2>/dev/null
    rm -f "$PID_FILE"
}

record_restart() {
    local reason=$1 heartbeat="none"
    [ -f "$HEARTBEAT_FILE" ] && heartbeat=$(tr -d '\n' < "$HEARTBEAT_FILE")
    printf '%s %s pid=%s run_s=%s reason="%s" heartbeat=%s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NAME" "$CHILD" "$(( $(date +%s) - STARTED_AT ))" "$reason" "$heartbeat" >> "$RESTART_LOG"
}

on_signal() {
    log "stopping: stopping $NODE_SCRIPT (pid $CHILD) first"
    stop_node
    log "stopped"
    exit 0
}
trap on_signal TERM INT HUP

# ---- main loop ----
QUICK_FAILURES=0
HALT_REPORTED=0
start_node

while true; do
    # sleep in the background so a TERM/INT is handled immediately; 9>&- so
    # an orphaned sleep can't keep holding the lock after the watchdog exits
    sleep "$CHECK_INTERVAL" 9>&- & wait $!

    now=$(date +%s)
    reason=""
    if ! is_running "$CHILD"; then
        wait "$CHILD" 2>/dev/null
        code=$?
        reason="process exited (exit code $code)"
        log "$reason"
        record_restart "$reason"
        rm -f "$PID_FILE"
    else
        hb_pid=""
        hb_age=0
        if [ -f "$HEARTBEAT_FILE" ]; then
            hb_pid=$(grep -o '"pid":[0-9]*' "$HEARTBEAT_FILE" | cut -d: -f2)
            hb_age=$(( now - $(stat -c %Y "$HEARTBEAT_FILE") ))
        fi
        if [ "$hb_pid" != "$CHILD" ]; then
            # no heartbeat from this process yet
            if (( now - STARTED_AT > STARTUP_GRACE )); then
                reason="no heartbeat within ${STARTUP_GRACE}s of start (stuck during startup?)"
            fi
        elif (( hb_age > STALE_AFTER )); then
            reason="heartbeat stale (${hb_age}s old, limit ${STALE_AFTER}s)"
        elif [ "$HALT_REPORTED" = 0 ] && grep -q '"halted_due_to_inconsistency":true' "$HEARTBEAT_FILE"; then
            # deliberately NOT a restart reason -- see the doc
            banner "seller.js HALTED: it saw an unrecognized spend from its own address and refuses all new leases." \
                   "This needs a human: check for a second instance using the same SELLER_PRIV_KEY. NOT restarting."
            HALT_REPORTED=1
        fi
        if [ -n "$reason" ]; then
            log "$reason -- stopping pid $CHILD"
            record_restart "$reason"
            stop_node
        fi
    fi
    [ -n "$reason" ] || continue

    # prerequisite 6: back off on repeated quick failures, then give up
    # (run time measured up to when the problem was detected, not including
    # the kill wait)
    if (( now - STARTED_AT < HEALTHY_RUNTIME )); then
        QUICK_FAILURES=$(( QUICK_FAILURES + 1 ))
    else
        QUICK_FAILURES=0
    fi
    if (( QUICK_FAILURES >= MAX_QUICK_FAILURES )); then
        printf '%s %s GAVE UP after %s consecutive quick failures (each ran < %ss) -- not restarting\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NAME" "$QUICK_FAILURES" "$HEALTHY_RUNTIME" >> "$RESTART_LOG"
        banner "GIVING UP: $NODE_SCRIPT failed $QUICK_FAILURES times in a row, each within ${HEALTHY_RUNTIME}s of starting." \
               "It is NOT running now. Check the end of $NODE_LOG, fix the cause, then start the watchdog again."
        exit 1
    fi
    delay=$BACKOFF_START
    if (( QUICK_FAILURES > 0 )); then
        delay=$(( BACKOFF_START * (1 << (QUICK_FAILURES - 1)) ))
        (( delay > BACKOFF_MAX )) && delay=$BACKOFF_MAX
    fi
    log "restarting in ${delay}s (quick failures in a row: $QUICK_FAILURES)"
    sleep "$delay" 9>&- & wait $!
    start_node
done
