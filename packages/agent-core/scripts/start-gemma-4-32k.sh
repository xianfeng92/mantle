#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
MODE="${1:-serve}"
WORKSPACE_SELECTOR="${2:-${AGENT_CORE_WORKSPACE_SELECTOR:-${AGENT_CORE_WORKSPACE_MODE:-repo}}}"
ENV_FILE="${AGENT_CORE_ENV_FILE:-$ROOT_DIR/.env.gemma-4-32k}"

load_env_file() {
  local file_path="$1"
  local line key value

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *"="* ]] && continue

    key="${line%%=*}"
    value="${line#*=}"

    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value%$'\r'}"

    if [[ -n "${!key+x}" ]]; then
      continue
    fi

    export "$key=$value"
  done < "$file_path"
}

resolve_workspace() {
  local selector="$1"
  case "$selector" in
    repo|"")
      printf '%s\n' "$ROOT_DIR"
      ;;
    workspace)
      printf '%s\n' "$WORKSPACE_ROOT"
      ;;
    *)
      if [[ "$selector" == /* ]]; then
        printf '%s\n' "$selector"
      else
        (
          cd "$PWD"
          cd "$selector"
          pwd
        )
      fi
      ;;
  esac
}

cd "$ROOT_DIR"

if [[ -f "$ENV_FILE" ]]; then
  load_env_file "$ENV_FILE"
fi

export AGENT_CORE_MODEL="${AGENT_CORE_MODEL:-google/gemma-4-26b-a4b}"
export AGENT_CORE_BASE_URL="${AGENT_CORE_BASE_URL:-http://127.0.0.1:1234/v1}"
export AGENT_CORE_API_KEY="${AGENT_CORE_API_KEY:-lm-studio}"
export AGENT_CORE_PROMPT_PROFILE="${AGENT_CORE_PROMPT_PROFILE:-compact}"
export AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT="${AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT:-28000}"
export AGENT_CORE_TEMPERATURE="${AGENT_CORE_TEMPERATURE:-0}"
export AGENT_CORE_AGENT_GRAPH_VERSION="${AGENT_CORE_AGENT_GRAPH_VERSION:-v2}"
export AGENT_CORE_DATA_DIR="${AGENT_CORE_DATA_DIR:-.agent-core}"
export AGENT_CORE_HTTP_HOST="${AGENT_CORE_HTTP_HOST:-127.0.0.1}"
export AGENT_CORE_HTTP_PORT="${AGENT_CORE_HTTP_PORT:-8787}"
export AGENT_CORE_VIRTUAL_MODE="${AGENT_CORE_VIRTUAL_MODE:-1}"
export AGENT_CORE_COMMAND_TIMEOUT_SEC="${AGENT_CORE_COMMAND_TIMEOUT_SEC:-120}"
export AGENT_CORE_MAX_OUTPUT_BYTES="${AGENT_CORE_MAX_OUTPUT_BYTES:-100000}"
export AGENT_CORE_MAX_INPUT_CHARS="${AGENT_CORE_MAX_INPUT_CHARS:-20000}"
export AGENT_CORE_MAX_OUTPUT_CHARS="${AGENT_CORE_MAX_OUTPUT_CHARS:-80000}"
export AGENT_CORE_LOG_LEVEL="${AGENT_CORE_LOG_LEVEL:-info}"
export AGENT_CORE_VERBOSE="${AGENT_CORE_VERBOSE:-1}"

if [[ -n "${AGENT_CORE_WORKSPACE_DIR+x}" ]]; then
  export AGENT_CORE_WORKSPACE_MODE="custom"
else
  case "$WORKSPACE_SELECTOR" in
    repo|"")
      export AGENT_CORE_WORKSPACE_MODE="repo"
      ;;
    workspace)
      export AGENT_CORE_WORKSPACE_MODE="workspace"
      ;;
    *)
      export AGENT_CORE_WORKSPACE_MODE="custom"
      ;;
  esac
  export AGENT_CORE_WORKSPACE_DIR="$(resolve_workspace "$WORKSPACE_SELECTOR")"
fi

echo "[agent-core] Gemma 32K preset"
echo "[agent-core] mode=${MODE} workspace_mode=${AGENT_CORE_WORKSPACE_MODE} model=${AGENT_CORE_MODEL} context_hint=${AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT}"
echo "[agent-core] workspace=${AGENT_CORE_WORKSPACE_DIR}"
echo "[agent-core] base_url=${AGENT_CORE_BASE_URL} port=${AGENT_CORE_HTTP_PORT} log_level=${AGENT_CORE_LOG_LEVEL}"

case "$MODE" in
  serve)
    exec npm run serve
    ;;
  cli)
    exec npm run dev
    ;;
  *)
    echo "Usage: $0 [serve|cli] [repo|workspace|/custom/path]" >&2
    exit 1
    ;;
esac
