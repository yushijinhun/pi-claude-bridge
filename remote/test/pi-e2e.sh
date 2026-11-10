#!/usr/bin/env bash
# pi + the bridge (this checkout) on "A", Claude Code via the daemon on "B".
# B is bubblewrap with A's checkout hidden. By default the API is the mock
# (no usage); REAL=1 sends real requests through diag/capture-proxy.mjs so the
# exact bodies are still recorded.
#
#   remote/test/pi-e2e.sh            # mock API
#   REAL=1 MODEL=claude-haiku-4-5 remote/test/pi-e2e.sh
#
# B_CLAUDE_CONFIG_DIR (required): B's Claude config dir, outside the checkout's
# parent directory. With the mock API an empty directory and
# ANTHROPIC_API_KEY=sk-ant-dummy will do; REAL=1 needs a login there (see
# remote/REPORT.md, "How to run"). pi gets its own agent directory in the work
# dir unless PI_CODING_AGENT_DIR is set, so your ~/.pi/agent stays out of it.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d /tmp/claude-remote-pi-e2e.XXXXXX)"
B_CFG="${B_CLAUDE_CONFIG_DIR:?set B_CLAUDE_CONFIG_DIR to a Claude config dir}"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$WORK/pi-agent}"
mkdir -p "$PI_CODING_AGENT_DIR"
CLAUDE_BIN="${CLAUDE_BIN:-$(readlink -f "$REPO/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude")}"
MODEL="${MODEL:-claude-opus-5-5}"
API_PORT=$((19000 + RANDOM % 500)); DAEMON_PORT=$((API_PORT + 500)); TOKEN="pi-e2e-$RANDOM"
PIDS=()
# The daemon runs in its own session (setsid); killing bwrap alone would leave it running.
cleanup() { for p in "${PIDS[@]}"; do kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

mkdir -p "$WORK/b" "$WORK/sessions"
# B installs the package: its files and its one dependency.
cp "$REPO"/remote/{daemon,protocol,env-block,accounts,pooled-process}.mjs "$REPO"/remote/package.json "$WORK/b/"
mkdir -p "$WORK/b/node_modules" && cp -r "$REPO/node_modules/ws" "$WORK/b/node_modules/"
# A binary inside the checkout's node_modules is hidden on B too.
case "$CLAUDE_BIN" in "$(dirname "$REPO")"/*) cp "$CLAUDE_BIN" "$WORK/b/claude"; CLAUDE_BIN="$WORK/b/claude" ;; esac
if [[ -n "${REAL:-}" ]]; then
  node "$REPO/diag/capture-proxy.mjs" --port "$API_PORT" --out "$WORK/capture" >"$WORK/api.log" 2>&1 &
else
  node "$REPO/remote/test/mock-api.mjs" --port "$API_PORT" --out "$WORK/capture" >"$WORK/api.log" 2>&1 &
fi
PIDS+=($!)
setsid bwrap --dev-bind / / --tmpfs "$(dirname "$REPO")" --die-with-parent \
  env CLAUDE_CONFIG_DIR="$B_CFG" CLAUDE_REMOTE_TOKEN="$TOKEN" ANTHROPIC_BASE_URL="http://127.0.0.1:$API_PORT" _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 \
  node "$WORK/b/daemon.mjs" --listen "127.0.0.1:$DAEMON_PORT" --claude "$CLAUDE_BIN" --spawn-cwd "$WORK/b-cwd" --tmp-dir "$WORK/b-tmp" \
  >"$WORK/daemon.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 60); do grep -q "listening on" "$WORK/daemon.log" 2>/dev/null && break; sleep 0.5; done
grep -q "listening on" "$WORK/daemon.log" || { cat "$WORK/daemon.log"; exit 1; }

export CLAUDE_CONFIG_DIR="$WORK/a-claude" CLAUDE_BRIDGE_REMOTE="ws://127.0.0.1:$DAEMON_PORT" CLAUDE_BRIDGE_REMOTE_TOKEN="$TOKEN"
export CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH="$WORK/bridge.log"
cd "$REPO"
PI=(pi -ne -e "$REPO" --session-dir "$WORK/sessions" --tools bash,read --model "claude-bridge/$MODEL")
P1="${P1:-Say hello.}"
DEFAULT_P2='MOCK_TOOL:bash:{"command":"pwd; ls package.json"}'
P2="${P2:-$DEFAULT_P2}"
P3="${P3:-Thanks.}"
echo "--- turn 1"; timeout 180 "${PI[@]}" -p "$P1" | tee "$WORK/turn1.txt"
echo "--- turn 2"; timeout 180 "${PI[@]}" -c -p "$P2" | tee "$WORK/turn2.txt"
echo "--- turn 3 (model switch -> full import)"; timeout 180 pi -ne -e "$REPO" --session-dir "$WORK/sessions" --tools bash,read --model "claude-bridge/${MODEL3:-claude-haiku-4-5}" -c -p "$P3" | tee "$WORK/turn3.txt"
echo "--- daemon"; cat "$WORK/daemon.log"
echo "--- work dir: $WORK"
