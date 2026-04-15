#!/usr/bin/env bash
#
# Download Piper TTS voice models used by Mantle.
#
# These .onnx models are ~60MB each and are intentionally NOT tracked in git.
# Running this script fetches them into apps/mantle/scripts/piper-voices/
# (next to the .onnx.json config files already in the repo).
#
# Source: https://huggingface.co/rhasspy/piper-voices
#
# Usage:
#   ./apps/mantle/scripts/download-piper-voices.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VOICES_DIR="${SCRIPT_DIR}/piper-voices"

mkdir -p "${VOICES_DIR}"

BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main"

declare -a FILES=(
  "en/en_US/lessac/medium/en_US-lessac-medium.onnx"
  "zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx"
)

for rel in "${FILES[@]}"; do
  filename="$(basename "${rel}")"
  dest="${VOICES_DIR}/${filename}"
  if [[ -f "${dest}" ]]; then
    echo "✓ ${filename} already present, skipping"
    continue
  fi
  echo "⇣ downloading ${filename} ..."
  curl -L --fail --progress-bar -o "${dest}" "${BASE_URL}/${rel}"
done

echo ""
echo "All voice models ready at: ${VOICES_DIR}"
