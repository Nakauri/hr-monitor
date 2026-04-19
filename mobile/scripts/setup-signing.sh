#!/usr/bin/env bash
# setup-signing.sh — one-shot Android signing keystore generator (bash version).
# Works in Git Bash on Windows, macOS Terminal, or any Linux shell.
#
# Usage (from the repo root):
#   cd mobile
#   bash scripts/setup-signing.sh
#
# Output files (gitignored):
#   hr-monitor-release.keystore       (the keystore itself — back it up)
#   hr-monitor-release.keystore.b64   (base64 text for the GH secret)
#   sha1.txt                          (the SHA-1 fingerprint)

set -e

cd "$(dirname "$0")/.."

echo
echo "=== HR Monitor Android signing setup ==="
echo

# Find keytool: PATH first, then common Windows JDK install locations so the
# user doesn't have to fight stale PATH after a fresh JDK install.
find_keytool() {
    if command -v keytool >/dev/null 2>&1; then
        command -v keytool
        return 0
    fi
    # Windows common paths (Git Bash sees them at /c/Program Files/...).
    local roots=(
        "/c/Program Files/Eclipse Adoptium"
        "/c/Program Files/Java"
        "/c/Program Files/Microsoft"
        "/c/Program Files/Amazon Corretto"
        "/c/Program Files/Zulu"
        "/c/Program Files (x86)/Java"
    )
    for root in "${roots[@]}"; do
        [ -d "$root" ] || continue
        local found
        found=$(find "$root" -maxdepth 4 -name keytool.exe -type f 2>/dev/null | head -n 1)
        if [ -n "$found" ]; then
            echo "$found"
            return 0
        fi
    done
    # JAVA_HOME fallback.
    if [ -n "$JAVA_HOME" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then
        echo "$JAVA_HOME/bin/keytool"
        return 0
    fi
    return 1
}

KEYTOOL=$(find_keytool) || {
    echo "ERROR: keytool not found." >&2
    echo >&2
    echo "Install a JDK (not the Eclipse IDE). Windows one-liner in PowerShell:" >&2
    echo "  winget install --id EclipseAdoptium.Temurin.21.JDK -e" >&2
    echo >&2
    echo "Then close Git Bash, reopen it, and rerun this script." >&2
    exit 1
}
echo "keytool: $KEYTOOL"

KEYSTORE="hr-monitor-release.keystore"
if [ -f "$KEYSTORE" ]; then
    echo
    echo "WARNING: $KEYSTORE already exists."
    read -rp "Overwrite? typing yes destroys the old keystore and invalidates all APKs signed with it (y/N) " ans
    case "$ans" in
        y|Y|yes|YES) rm -f "$KEYSTORE" ;;
        *) echo "Aborted."; exit 0 ;;
    esac
fi

echo
echo "--- Step 1: generating keystore ---"

# Read the pre-generated password file if present (created by Claude or by
# the user); fall back to interactive prompts if the file isn't there.
# Running this way avoids Git Bash's MinTTY stdin issue — keytool prompts
# freeze in Git Bash because MinTTY can't talk to native Windows binaries.
PASSWORD_FILE="keystore-password.txt"
if [ -f "$PASSWORD_FILE" ]; then
    PASSWORD=$(tr -d '\r\n' < "$PASSWORD_FILE")
    if [ -z "$PASSWORD" ]; then
        echo "ERROR: $PASSWORD_FILE is empty." >&2
        exit 1
    fi
    echo "using password from $PASSWORD_FILE"
    "$KEYTOOL" -genkey \
        -keystore "$KEYSTORE" \
        -alias hr-monitor \
        -keyalg RSA \
        -keysize 2048 \
        -validity 10000 \
        -storepass "$PASSWORD" \
        -keypass "$PASSWORD" \
        -dname "CN=HR Monitor, OU=Dev, O=nakauri, L=Toronto, ST=ON, C=CA"
else
    echo "No $PASSWORD_FILE found — falling back to interactive prompts."
    echo "(Note: in Git Bash on Windows, prefix this command with winpty if typing is blocked.)"
    echo
    "$KEYTOOL" -genkey -v \
        -keystore "$KEYSTORE" \
        -alias hr-monitor \
        -keyalg RSA \
        -keysize 2048 \
        -validity 10000
fi

echo
echo "--- Step 2: extracting SHA-1 fingerprint ---"

if [ -n "${PASSWORD:-}" ]; then
    SHA1_LINE=$("$KEYTOOL" -list -v -keystore "$KEYSTORE" -alias hr-monitor -storepass "$PASSWORD" 2>/dev/null | grep -E '^\s*SHA1:' | head -n 1 | sed 's/^[[:space:]]*//')
else
    SHA1_LINE=$("$KEYTOOL" -list -v -keystore "$KEYSTORE" -alias hr-monitor 2>/dev/null | grep -E '^\s*SHA1:' | head -n 1 | sed 's/^[[:space:]]*//')
fi
if [ -z "$SHA1_LINE" ]; then
    echo "ERROR: could not parse SHA-1 from keytool output." >&2
    exit 1
fi
SHA1=${SHA1_LINE#SHA1: }
SHA1=${SHA1#SHA1:}
SHA1=$(echo "$SHA1" | sed 's/^[[:space:]]*//')
echo "$SHA1" > sha1.txt
echo "SHA-1: $SHA1"
echo "saved to: sha1.txt"

echo
echo "--- Step 3: base64 encoding keystore ---"
base64 -w 0 "$KEYSTORE" > hr-monitor-release.keystore.b64 2>/dev/null \
    || base64 "$KEYSTORE" | tr -d '\n' > hr-monitor-release.keystore.b64
echo "base64 keystore written to: hr-monitor-release.keystore.b64"

cat <<SUMMARY

=== Setup complete. Do these two web steps next ===

1) Google Cloud Console — register the SHA-1
   https://console.cloud.google.com/apis/credentials
   -> your HR Monitor project
   -> Create Credentials -> OAuth 2.0 Client ID -> Android
   -> Package name: com.nakauri.hrmonitor
   -> SHA-1: $SHA1
   -> Save

2) GitHub repo Secrets — add four secrets
   https://github.com/Nakauri/hr-monitor/settings/secrets/actions
   New repository secret x 4:

     ANDROID_KEYSTORE_BASE64
       value: entire contents of hr-monitor-release.keystore.b64
     ANDROID_KEYSTORE_PASSWORD
       value: the store password you chose above
     ANDROID_KEY_ALIAS
       value: hr-monitor
     ANDROID_KEY_PASSWORD
       value: the key password you chose above

After both are done, push any change to main. Next APK build is signed with
this keystore and Google Sign-In on the phone will work.

KEEP hr-monitor-release.keystore SAFE. Back it up.
Losing it means you can never push updates to installed phones.

SUMMARY
