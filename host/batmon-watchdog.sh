#!/usr/bin/env bash
# Repairs a JK pack that batmon has lost over Bluetooth, before the Node-RED
# temperature guard (cb_tempguard, 30 min blind limit) has to stop the battery.
#
# A JK BMS takes one BLE client; when BlueZ keeps a stale GATT session the pack
# stops reporting and batmon logs "NotPermitted Notify acquired" every cycle.
# batmon's own "power cycle bluetooth" does not clear it (the cache is on disk);
# `bluetoothctl remove <MAC>` plus an add-on restart does (2026-09-14 bat_west,
# 2026-10-19 bat_ost: data back 49 s after the restart).
#
# Runs every minute from batmon-watchdog.timer on big. A pack is bad when it has
# logged no reading for STALE_S, or logged >= ERR_N BLE errors within ERR_WIN.
# At most one repair per COOLDOWN_S; if it does not help, the guard trips and
# alarms as before. `--dry-run` only prints the decision.
set -u
CONTAINER=app_2af0a32d_batmon
ADDON=2af0a32d_batmon
declare -A MAC=([bat_ost]=20:22:09:27:33:9B [bat_west]=20:22:09:27:46:7F [bat_big]=C8:47:80:12:0C:20)
STALE_S=300          # packs report every ~1.5-3 min
ERR_WIN=3m ERR_N=2
GRACE_S=300          # after an add-on (re)start, give the first poll round time
COOLDOWN_S=900
STATE=/var/lib/batmon-watchdog/last_repair
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

log() { echo "$*"; }
run() { if [ $DRY = 1 ]; then log "dry-run: $*"; else "$@"; fi; }

if [ "$(docker inspect -f '{{.State.Running}}' $CONTAINER 2>/dev/null)" != true ]; then
    log "batmon is not running - starting it"
    run docker exec hassio_cli ha apps start $ADDON
    exit 0
fi
started=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' $CONTAINER)" +%s)
now=$(date +%s)
if [ $((now - started)) -lt $GRACE_S ]; then exit 0; fi

recent=$(docker logs --since ${STALE_S}s $CONTAINER 2>&1)
errs=$(docker logs --since $ERR_WIN $CONTAINER 2>&1)
bad=()
for p in "${!MAC[@]}"; do
    m=${MAC[$p]}
    if ! grep -q "\[sampling\] $p volt=" <<<"$recent"; then
        bad+=("$p"); log "$p ($m): no reading for ${STALE_S}s"
        continue
    fi
    n=$(grep -cE "\[sampling\] $p error .*NotPermitted|Device $m not discovered" <<<"$errs")
    if [ "$n" -ge $ERR_N ]; then bad+=("$p"); log "$p ($m): $n BLE errors in $ERR_WIN"; fi
done
[ ${#bad[@]} -eq 0 ] && exit 0

last=$(cat $STATE 2>/dev/null || echo 0)
if [ $((now - last)) -lt $COOLDOWN_S ]; then
    log "repair needed for ${bad[*]}, but the last one was $(( (now - last) / 60 )) min ago - waiting"
    exit 0
fi
for p in "${bad[@]}"; do
    log "removing $p (${MAC[$p]}) from BlueZ"
    run bluetoothctl remove "${MAC[$p]}"
done
log "restarting batmon"
run docker exec hassio_cli ha apps restart $ADDON
[ $DRY = 1 ] || { mkdir -p "$(dirname $STATE)"; echo "$now" > $STATE; }
