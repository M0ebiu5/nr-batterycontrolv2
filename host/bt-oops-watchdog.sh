#!/usr/bin/env bash
# Reboots big when the kernel Bluetooth stack crashes, and cleans up after it.
#
# 2026-10-21 05:22 the bluetooth module oopsed in hci_rx_work (NULL deref in
# hci_connect_le_scan_cleanup). The dead worker kept the hci0 lock, so HA core
# (its Bluetooth integration uses hci0), bluetoothd and batmon hung in D state
# for 2 h: no HA, no pack data. Nothing short of a reboot recovers that, and a
# plain `systemctl reboot` hangs on bluetooth.service, so it has to be forced.
#
#   watch        (bt-oops-watchdog.service) follow the kernel log; on an Oops/BUG
#                whose trace names [bluetooth] or an hci workqueue: stop the
#                containers (bounded), force a reboot. At most one per COOLDOWN_S.
#   unlock       (bt-oops-watchdog-recover.service, ExecStartPre, before docker)
#                if the last reboot was ours: drop HA's .ha_run.lock so HA does
#                not start in safe mode.
#   recover      (same unit, main process) once HA answers: restart core if it
#                is in safe mode anyway, post an HA notification.
#   test FILE    feed a saved kernel log through the detector, never reboots.
#
# userspace bluetoothd crashes ("traps: bluetoothd ... general protection
# fault", ~200 since 2026-10-18) are not kernel oopses and do not match.
set -u
STATE_DIR=/var/lib/bt-oops-watchdog
LAST=$STATE_DIR/last_reboot      # epoch of our last reboot
PENDING=$STATE_DIR/pending       # set before a reboot, cleared after recovery
COOLDOWN_S=21600                 # 6 h: an oops right after boot must not loop
WINDOW=40                        # lines after Oops/BUG that belong to the trace
STOP_TIMEOUT=150                 # bounded clean container stop (HA itself hangs)
HA_LOCK=/usr/share/hassio/homeassistant/.ha_run.lock
HA_URL=http://localhost:8123
HA_TOKEN_FILE=/mnt/duo1/WinWalter/projects/lotto/.ha_token

log() { echo "$*"; }

ha_api() {  # ha_api METHOD PATH [JSON]
    local data=(); [ $# -ge 3 ] && data=(-d "$3")
    curl -sf -m 10 -X "$1" -H "Authorization: Bearer $(cat $HA_TOKEN_FILE)" \
        -H 'Content-Type: application/json' "${data[@]}" "$HA_URL$2"
}

reboot_now() {  # reboot_now SUMMARY DRY
    local now last; now=$(date +%s); last=$(cat $LAST 2>/dev/null || echo 0)
    if [ $((now - last)) -lt $COOLDOWN_S ]; then
        log "Bluetooth kernel crash ($1), but the last watchdog reboot was $(( (now - last) / 60 )) min ago - not rebooting again"
        return
    fi
    if [ "$2" = 1 ]; then log "test: would reboot for: $1"; return; fi
    log "Bluetooth kernel crash: $1 - rebooting"
    mkdir -p $STATE_DIR
    echo "$now" >$LAST
    printf '%s\t%s\n' "$(date '+%F %T')" "$1" >$PENDING
    # supervisor first, so it does not restart the add-ons we are stopping
    timeout 60 docker stop hassio_supervisor >/dev/null 2>&1
    timeout $STOP_TIMEOUT docker stop $(docker ps -q) >/dev/null 2>&1
    sync
    systemctl reboot --force
}

detect() {  # detect DRY  - reads kernel log lines on stdin
    local left=0 hit=0 head="" line
    while IFS= read -r line; do
        if [[ $line =~ ^(BUG:|Oops:|general\ protection\ fault|kernel\ BUG\ at) ]]; then
            [ $left -eq 0 ] && { head=$line; hit=0; }
            left=$WINDOW
            continue
        fi
        [ $left -eq 0 ] && continue
        left=$((left - 1))
        if [ $hit = 0 ] && [[ $line =~ \[bluetooth\]|\[btusb\]|Workqueue:\ hci[0-9] ]]; then
            hit=1
            reboot_now "$head / ${line# }" "$1"
        fi
    done
}

unlock() {  # before docker: keep HA out of safe mode after our forced reboot
    [ -f $PENDING ] || exit 0
    log "last reboot was by bt-oops-watchdog ($(cut -f1 $PENDING)): $(cut -f2 $PENDING)"
    rm -f $HA_LOCK && log "removed $HA_LOCK so HA starts normally"
}

recover() {  # after docker: wait for HA, fix safe mode if it happened anyway, notify
    [ -f $PENDING ] || exit 0
    local cfg="" msg
    for _ in $(seq 1 90); do
        cfg=$(ha_api GET /api/config 2>/dev/null)
        grep -q '"state":"RUNNING"' <<<"$cfg" && break
        sleep 10
    done
    if grep -q '"safe_mode":true' <<<"$cfg"; then
        log "HA came up in safe mode anyway - restarting core"
        docker exec hassio_cli ha core restart
    fi
    msg=$(python3 -c 'import json,sys; print(json.dumps({"notification_id": "bt_oops_watchdog", "title": "big: Neustart nach Bluetooth-Kernelabsturz",
        "message": "bt-oops-watchdog hat big am " + sys.argv[1] + " neu gestartet.\n\n" + sys.argv[2] +
        "\n\nDetails: journalctl -u bt-oops-watchdog -b -1"}))' "$(cut -f1 $PENDING)" "$(cut -f2 $PENDING)")
    ha_api POST /api/services/persistent_notification/create "$msg" >/dev/null && log "HA notified"
    rm -f $PENDING
}

case "${1:-watch}" in
    watch)      journalctl -k -f -n0 -o cat | detect 0 ;;
    unlock)     unlock ;;
    recover)    recover ;;
    test)       detect 1 <"${2:?usage: $0 test FILE}" ;;
    *)          echo "usage: $0 [watch|unlock|recover|test FILE]" >&2; exit 2 ;;
esac
