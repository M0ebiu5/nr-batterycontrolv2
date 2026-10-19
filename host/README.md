# Host services on big

## batmon-watchdog

Repairs a JK pack that batmon has lost over Bluetooth (stale BlueZ GATT cache:
`NotPermitted Notify acquired`, or no readings) with `bluetoothctl remove <MAC>`
plus an add-on restart, long before the Node-RED temperature guard's 30 min
blind limit stops the battery. Triggers: a pack has logged no reading for 5 min,
or >= 2 BLE errors in 3 min. At most one repair per 15 min, no action in the
first 5 min after an add-on start. If the repair fails the guard trips and
alarms as before. Does not cover a wedged USB adapter (all packs dark).

Install / update:

```sh
sudo install -m 755 host/batmon-watchdog.sh /usr/local/bin/
sudo install -m 644 host/batmon-watchdog.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now batmon-watchdog.timer
```

Check: `journalctl -u batmon-watchdog` (empty = nothing to repair),
`sudo /usr/local/bin/batmon-watchdog.sh --dry-run`.
