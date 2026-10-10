#!/usr/bin/env bash
# The only way the build agent installs the APK on the phone.
#   1. engine-boundary.test.cjs must pass (coherence included), so a half-landed step never installs.
#   2. Prints the build's BuildConfig.TEST_HOOKS and warns when it is true.
#   3. Refuses while a session records (prefs sessionActive=true AND NativeHrService in the
#      foreground): an install kills the process mid-recording. The one override is the flag
#      printed below, passed on the command line for that one install.
#   4. adb install -r. Never force-stops, never clears data.
# Usage: bash scripts/install-gated.sh [--allow-live-session] [path/to/app-debug.apk]
# Env: ADB (adb binary), ANDROID_SERIAL (device), HRM_BUILDCONFIG (generated BuildConfig.java to read).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADB="${ADB:-$(command -v adb || echo "${LOCALAPPDATA:-$HOME/AppData/Local}/Android/Sdk/platform-tools/adb.exe")}"
PKG="com.nakauri.hrmonitor"
APK="$ROOT/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
BC="${HRM_BUILDCONFIG:-$ROOT/mobile/android/app/build/generated/source/buildConfig/debug/com/nakauri/hrmonitor/BuildConfig.java}"
ALLOW=0
for a in "$@"; do
  case "$a" in
    --allow-live-session) ALLOW=1 ;;
    -*) echo "install-gated: unknown option $a"; exit 2 ;;
    *) APK="$a" ;;
  esac
done

[ -f "$APK" ] || { echo "install-gated: REFUSED, no APK at $APK"; exit 2; }

echo "install-gated: engine boundary checks"
if ! node "$ROOT/scripts/engine-boundary.test.cjs" > /dev/null 2>&1; then
  node "$ROOT/scripts/engine-boundary.test.cjs" 2>&1 | grep -E '^FAIL|FAILED' | head -20
  echo "install-gated: REFUSED, engine-boundary.test.cjs fails (a partial step 2 never installs)"
  exit 1
fi

# U3: what this build does with the device-test prefs.
if [ -f "$BC" ]; then
  TH="$(grep -oE 'TEST_HOOKS = (true|false)' "$BC" | awk '{print $3}')"
  [ -n "$TH" ] || TH="missing"
else
  TH="unknown"
fi
echo "install-gated: BuildConfig.TEST_HOOKS=$TH, read from $BC"
# The generated BuildConfig belongs to the last local gradle build; say so when the APK is not that build's.
DEFAULT_APK="$ROOT/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$BC" ] && [ "$APK" -ef "$DEFAULT_APK" ] && [ "$BC" -nt "$APK" ]; then
  echo "install-gated: WARNING, that BuildConfig is newer than the APK; the APK may be from an older build."
elif ! [ "$APK" -ef "$DEFAULT_APK" ]; then
  echo "install-gated: WARNING, $APK is not the local build output; its TEST_HOOKS is unknown."
  TH="unknown"
fi
if [ "$TH" = "true" ]; then
  echo "install-gated: WARNING, a TEST_HOOKS=true build honours the test_* prefs. Reinstall an HRM_TEST_HOOKS=0 build after the test series."
elif [ "$TH" != "false" ]; then
  echo "install-gated: WARNING, could not read TEST_HOOKS for this build."
fi

PREFS="$("$ADB" shell run-as "$PKG" cat shared_prefs/hr_monitor_session.xml 2>&1)"
SVC="$("$ADB" shell dumpsys activity services "$PKG/.NativeHrService" 2>&1)"

if printf '%s' "$PREFS" | grep -q 'name="sessionActive" value="true"'; then
  ACTIVE=true
elif printf '%s' "$PREFS" | grep -qE '<map|No such file|not installed|[Uu]nknown package'; then
  ACTIVE=false
else
  echo "install-gated: REFUSED, could not read the session prefs:"
  printf '%s\n' "$PREFS" | head -3
  exit 1
fi
if printf '%s' "$SVC" | grep -q 'isForeground=true'; then
  FG=true
elif printf '%s' "$SVC" | grep -qE 'ACTIVITY MANAGER SERVICES|\(nothing\)'; then
  FG=false
else
  echo "install-gated: REFUSED, could not read the service state:"
  printf '%s\n' "$SVC" | head -3
  exit 1
fi
echo "install-gated: prefs sessionActive=$ACTIVE, NativeHrService foreground=$FG"

if [ "$ACTIVE" = "true" ] && [ "$FG" = "true" ]; then
  if [ "$ALLOW" -ne 1 ]; then
    echo "install-gated: REFUSED, a session is recording: prefs sessionActive=true AND NativeHrService is in the foreground."
    echo "install-gated: an install kills that recording. To install anyway, rerun with: --allow-live-session"
    exit 3
  fi
  echo "install-gated: --allow-live-session given; installing over a live recording."
fi

echo "install-gated: adb install -r $APK"
"$ADB" install -r "$APK"
