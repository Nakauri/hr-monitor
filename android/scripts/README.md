# Android test scripts

Scripted reliability checks for the native build. Run from the repo root with the phone connected via USB debugging.

## doze-soak.sh

Forces the phone into Doze mode immediately (no 10-minute idle wait) and watches whether the foreground service + BLE stream survive. Run with the app already streaming — pair a strap, open the Live screen, confirm the big HR number is updating, then plug in USB and run:

```sh
./android/scripts/doze-soak.sh 5   # 5 minute soak
```

Prints a verdict:
- Whether HrSessionService is still running in `dumpsys activity services`.
- Number of BLE log lines during the window (should be dozens for a 5 minute run — one per HR notification).
- Where the full logcat was saved for post-mortem.

Pass with: service running, BLE log lines > 0, no CRASH / ANR / AndroidRuntime errors.

## What this doesn't cover

- Relay-side state (WebSocket connection in Doze). Test manually: open `overlay.html?key=<your relay key>` on desktop before the soak and confirm it stays live.
- OEM-specific kill behaviour (Samsung Device Care, Xiaomi autostart). Those run on top of Doze; test separately on each OEM.
- Reboot resume. Test manually: reboot the phone with a session running and the boot-restart toggle enabled, confirm the session resumes.
