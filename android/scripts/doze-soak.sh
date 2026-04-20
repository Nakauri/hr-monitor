#!/usr/bin/env bash
# Force Android into Doze mode to verify the foreground service keeps the
# heart rate stream alive with the screen off. Run with the phone connected
# via USB and HR Monitor already streaming.
#
# Usage: ./doze-soak.sh [minutes]
# Default: 5 minutes.
#
# What it does:
#   1. Pushes the device into Doze immediately (no idle-wait).
#   2. Tails logcat filtered to HR Monitor so you see whether HR ticks keep
#      arriving from the BLE layer and whether the relay stays live.
#   3. After the soak window, restores normal power state and prints a
#      one-line verdict (service still running, last HR timestamp, etc).
#
# Requires:
#   - adb installed and on PATH.
#   - USB debugging enabled on the phone.
#   - App already streaming (Live screen showing an HR number).

set -euo pipefail

MINUTES="${1:-5}"
PACKAGE="com.nakauri.hrmonitor"

if ! command -v adb >/dev/null 2>&1; then
    echo "error: adb not found on PATH" >&2
    exit 1
fi

if ! adb shell "pidof $PACKAGE" >/dev/null 2>&1; then
    echo "error: $PACKAGE is not running on the device. Start a session first." >&2
    exit 1
fi

echo "[soak] ${MINUTES}-minute Doze test starting"
echo "[soak] package: $PACKAGE"
echo "[soak] start: $(date -Iseconds)"

echo "[soak] forcing Doze"
adb shell dumpsys deviceidle enable >/dev/null
adb shell dumpsys deviceidle force-idle >/dev/null

# Clear logcat so the tail shows only post-Doze output.
adb logcat -c

# Tail logcat for the soak window in the background.
TMP_LOG=$(mktemp -t hr-doze-XXXX.log)
adb logcat -v time HRMonitor:* HrBleManager:* AndroidRuntime:E *:S >"$TMP_LOG" &
TAIL_PID=$!

SLEEP_S=$((MINUTES * 60))
echo "[soak] logging to $TMP_LOG for ${SLEEP_S}s"
sleep "$SLEEP_S"

kill "$TAIL_PID" 2>/dev/null || true

echo "[soak] restoring power state"
adb shell dumpsys deviceidle unforce >/dev/null

SERVICE_RUNNING="no"
if adb shell "dumpsys activity services $PACKAGE" 2>/dev/null | grep -q "HrSessionService"; then
    SERVICE_RUNNING="yes"
fi

TICK_COUNT=$(grep -c 'HRMonitor/ble' "$TMP_LOG" 2>/dev/null || echo 0)
LAST_TICK=$(grep 'HRMonitor/ble' "$TMP_LOG" 2>/dev/null | tail -1 || true)

echo "[verdict] service still running: $SERVICE_RUNNING"
echo "[verdict] BLE log lines during soak: $TICK_COUNT"
echo "[verdict] last ble log line: $LAST_TICK"
echo "[verdict] end: $(date -Iseconds)"
echo "[verdict] full log kept at: $TMP_LOG"
