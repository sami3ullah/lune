#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

# =============================================================================
# package-dmg.sh - Builds the signed, hardened-runtime, notarized Lune DMG
# end-to-end (ticket 15): build the whisper-server binary -> compile the app ->
# sign + notarize + staple -> emit a DMG that opens on a clean machine without a
# Gatekeeper warning.
#
# One command, the whole chain. The model weights are never bundled (Provisioning
# downloads them on first run); only the whisper-server binary and the native addons
# (onnxruntime-node, uiohook-napi, phonemizer/espeak) travel inside the app, deep-signed.
#
# Usage:
#   scripts/package-dmg.sh              Full release: build, sign, notarize, staple, DMG.
#   scripts/package-dmg.sh --dir        Unpacked .app only - no DMG, no signing, no
#                                       notarization. For fast local verification that the
#                                       bundle assembles and the native addons stage.
#
# Signing + notarization credentials (full release only; read from the environment):
#   - A "Developer ID Application" certificate in the login keychain (electron-builder
#     auto-discovers it), OR CSC_LINK (path/base64 to a .p12) + CSC_KEY_PASSWORD.
#   - Notarization, either:
#       APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or
#       APPLE_API_KEY (path to .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER.
#
# Build machine only (never the end user): Node >= 20, pnpm, and - for the whisper-server
# build - git, cmake, and the Xcode Command Line Tools.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WHISPER_BINARY="${REPO_DIR}/build/whisper-server"

DIR_ONLY=0
if [ "${1:-}" = "--dir" ]; then
    DIR_ONLY=1
fi

# ── Step 1: whisper-server binary ────────────────────────────────────────────
# Built from pinned source and staged into the app (electron-builder.yml extraResources).
# Reuse an existing build; rebuild with scripts/build-whisper-server.sh if absent.
if [ -f "${WHISPER_BINARY}" ]; then
    echo "🧩 Reusing whisper-server binary at ${WHISPER_BINARY}"
else
    echo "🧩 whisper-server binary missing - building from pinned source…"
    "${SCRIPT_DIR}/build-whisper-server.sh" "${WHISPER_BINARY}"
fi

# Verify it is an arm64 Mach-O executable - a wrong-arch binary would notarize but fail
# to run on the target, so catch it here rather than on a user's machine.
file "${WHISPER_BINARY}" | grep -q "arm64" || {
    echo "❌ ${WHISPER_BINARY} is not an arm64 binary. Rebuild with scripts/build-whisper-server.sh."
    exit 1
}

# ── Step 2: build + package ──────────────────────────────────────────────────
cd "${REPO_DIR}"

if [ "${DIR_ONLY}" -eq 1 ]; then
    echo "📦 Building unpacked .app (--dir: no DMG, no signing, no notarization)…"
    pnpm --filter @lune/desktop package:dir
    echo ""
    echo "✅ Unpacked app built under apps/desktop/release/. Native addons staged in"
    echo "   Contents/Resources/app.asar.unpacked; whisper-server in Contents/Resources."
    exit 0
fi

echo "📦 Building, signing, notarizing, and stapling the DMG…"
echo "   (electron-builder reads signing/notarization credentials from the environment)"
pnpm --filter @lune/desktop package

echo ""
echo "✅ Signed, notarized DMG built under apps/desktop/release/."
echo "   Verify on a clean machine: the DMG opens with no Gatekeeper warning, and"
echo "   onboarding + the voice loop work from the installed app."
