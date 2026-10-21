# Host services on big

## batmon-watchdog

Repairs a JK pack that batmon has lost over Bluetooth (stale BlueZ GATT cache:
`NotPermitted Notify acquired`, or no readings) with `bluetoothctl remove <MAC>`
plus an add-on restart, long before the Node-RED temperature guard's 30 min
blind limit stops the battery. Triggers: a pack has logged no reading for 5 min,
or >= 2 BLE errors in 3 min. At most one repair per 15 min, no action in the
first 5 min after an add-on start. If the repair fails the guard trips and
alarms as before. Does not cover a wedged USB adapter (all packs dark).

Since 2026-10-21 batmon uses `ble_stack: esphome` via the ESP32-C6 proxy
`bt-proxy-batterie` (192.168.4.105) at the Cerbo. The watchdog reads the stack from
batmon's `BLE stack:` log line; with esphome it skips `bluetoothctl remove` (BlueZ on big
is not involved) and only restarts the add-on, logging if the proxy does not answer ping.

Install / update:

```sh
sudo install -m 755 host/batmon-watchdog.sh /usr/local/bin/
sudo install -m 644 host/batmon-watchdog.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now batmon-watchdog.timer
```

Check: `journalctl -u batmon-watchdog` (empty = nothing to repair),
`sudo /usr/local/bin/batmon-watchdog.sh --dry-run`.

## bt-oops-watchdog

Reboots big when the kernel Bluetooth stack crashes (an `Oops`/`BUG` whose trace
names `[bluetooth]`, `[btusb]` or an `hci` workqueue). After such a crash hci0
stays locked and HA core, bluetoothd and batmon hang in D state until a reboot
(2026-10-21: 2 h without HA). Userspace `bluetoothd` segfaults do not trigger it.

- `bt-oops-watchdog.service` follows `journalctl -k`; on a match it stops the
  supervisor and all containers (max 150 s, HA itself cannot stop), then
  `systemctl reboot --force` (a plain reboot hangs on bluetooth.service).
  At most one reboot per 6 h (`/var/lib/bt-oops-watchdog/last_reboot`).
- `bt-oops-watchdog-recover.service` runs only after such a reboot
  (`/var/lib/bt-oops-watchdog/pending`): before docker it removes HA's
  `.ha_run.lock` (else HA starts in safe mode), then waits for HA, restarts core
  if it is in safe mode anyway, and posts an HA notification (id `bt_oops_watchdog`).

Install / update:

```sh
sudo install -m 755 host/bt-oops-watchdog.sh /usr/local/bin/
sudo install -m 644 host/bt-oops-watchdog{,-recover}.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bt-oops-watchdog.service
sudo systemctl enable bt-oops-watchdog-recover.service
```

Check: `journalctl -u bt-oops-watchdog -u bt-oops-watchdog-recover`.
Test the detector without rebooting:
`journalctl -k -b -1 -o cat > /tmp/k.log; bt-oops-watchdog.sh test /tmp/k.log`.
Never test by writing an Oops into `/dev/kmsg`: that reboots big.
