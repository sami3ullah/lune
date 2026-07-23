#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

# =============================================================================
# build-whisper-server.sh - Compiles the whisper.cpp `whisper-server` binary Lune
# uses for on-device Transcription (ticket 10, ADR-0003).
#
# whisper.cpp ships as source only - there is no hosted, prebuilt macOS arm64
# Metal `whisper-server` binary to download (the upstream releases carry only
# Linux/Windows/CUDA binaries and an Apple xcframework). So Lune owns and builds
# the binary here; it is bundled at release time (packaging, ticket 15) and pointed
# at in dev via LUNE_WHISPER_SERVER_PATH. Only the model *weights* are downloaded
# during first-run Provisioning (ADR-0009), never bundled.
#
# The build is deliberately self-contained so the result is notarizable and needs
# no external files at runtime:
#   - GGML_METAL_EMBED_LIBRARY=ON embeds the Metal shader into the binary (no
#     separate .metal file to locate).
#   - BUILD_SHARED_LIBS=OFF links ggml/whisper statically, so the binary depends
#     only on system frameworks (Metal, Accelerate, Foundation) - no Homebrew
#     dylibs to bundle or fix rpaths for.
#
# Usage:
#   scripts/build-whisper-server.sh [OUTPUT_PATH]
#     OUTPUT_PATH defaults to <repo>/build/whisper-server
#
# Requires (build machine only, never the end user): git, cmake, and a C++
# toolchain (Xcode Command Line Tools). Installs cmake via Homebrew if missing.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_PATH="${1:-${REPO_DIR}/build/whisper-server}"

# Pinned whisper.cpp revision (ADR-0009: pin what we ship). This exact commit was
# verified to build a self-contained arm64 + Metal `whisper-server`.
WHISPER_CPP_REPO="https://github.com/ggml-org/whisper.cpp"
WHISPER_CPP_COMMIT="080bbbe85230f624f0b52127f1ae1218247989f9"

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "${BUILD_DIR}"' EXIT

# ── Preconditions ────────────────────────────────────────────────────────────

if ! command -v git >/dev/null 2>&1; then
    echo "❌ git is required to fetch whisper.cpp."
    exit 1
fi
if ! command -v cmake >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
        echo "🍺 cmake not found - installing via Homebrew…"
        brew install cmake
    else
        echo "❌ cmake is required to build whisper-server (and Homebrew isn't available to install it)."
        exit 1
    fi
fi

echo "🧩 Building whisper-server → ${OUTPUT_PATH}"

# ── Step 1: Fetch the pinned source ──────────────────────────────────────────

echo "📥 Cloning whisper.cpp @ ${WHISPER_CPP_COMMIT}…"
git clone --filter=blob:none --no-checkout "${WHISPER_CPP_REPO}" "${BUILD_DIR}/whisper.cpp"
( cd "${BUILD_DIR}/whisper.cpp" && git checkout --quiet "${WHISPER_CPP_COMMIT}" )

# ── Step 2: Configure + build (self-contained, Metal embedded) ───────────────

echo "🛠  Configuring…"
cmake -S "${BUILD_DIR}/whisper.cpp" -B "${BUILD_DIR}/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_METAL=ON \
    -DGGML_METAL_EMBED_LIBRARY=ON \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DBUILD_SHARED_LIBS=OFF

echo "🔨 Building whisper-server…"
cmake --build "${BUILD_DIR}/build" -j --config Release --target whisper-server

# ── Step 3: Stage the binary ─────────────────────────────────────────────────

BUILT_BINARY="$(find "${BUILD_DIR}/build" -name 'whisper-server' -type f -perm +111 | head -1 || true)"
if [ -z "${BUILT_BINARY}" ]; then
    echo "❌ whisper-server binary not found after build."
    exit 1
fi

mkdir -p "$(dirname "${OUTPUT_PATH}")"
cp "${BUILT_BINARY}" "${OUTPUT_PATH}"
chmod +x "${OUTPUT_PATH}"

echo ""
echo "✅ whisper-server built: ${OUTPUT_PATH}"
file "${OUTPUT_PATH}"
