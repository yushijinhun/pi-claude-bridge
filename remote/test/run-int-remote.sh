#!/usr/bin/env bash
# Run the bridge's own integration tests (real API) with Claude Code on "B":
# the daemon runs in bubblewrap with the checkout's parent directory hidden.
#
#   remote/test/run-int-remote.sh tests/int-tool-message.mjs [more test files]
#
# BRIDGE_DIR: checkout with dev dependencies installed (default: this one).
# B_CLAUDE_CONFIG_DIR (required): B's Claude config with a login, outside the
# checkout's parent directory (see remote/REPORT.md, "How to run").
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BRIDGE_DIR="${BRIDGE_DIR:-$REPO}"
WORK="$(mktemp -d /tmp/claude-remote-int.XXXXXX)"
B_CFG="${B_CLAUDE_CONFIG_DIR:?set B_CLAUDE_CONFIG_DIR to a Claude config dir with a login}"
CLAUDE_BIN="${CLAUDE_BIN:-$(readlink -f "$BRIDGE_DIR/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude")}"
PORT=$((20000 + RANDOM % 1000)); TOKEN="int-$RANDOM$RANDOM"
mkdir -p "$WORK/b"
# B installs the package: its files and its one dependency.
cp "$REPO"/remote/{daemon,protocol,env-block,accounts,pooled-process}.mjs "$REPO"/remote/package.json "$WORK/b/"
mkdir -p "$WORK/b/node_modules" && cp -r "$BRIDGE_DIR/node_modules/ws" "$WORK/b/node_modules/"
# A binary inside the checkout's node_modules is hidden on B too.
case "$CLAUDE_BIN" in "$(dirname "$BRIDGE_DIR")"/*) cp "$CLAUDE_BIN" "$WORK/b/claude"; CLAUDE_BIN="$WORK/b/claude" ;; esac
setsid bwrap --dev-bind / / --tmpfs "$(dirname "$BRIDGE_DIR")" --die-with-parent \
  env CLAUDE_CONFIG_DIR="$B_CFG" CLAUDE_REMOTE_TOKEN="$TOKEN" \
  node "$WORK/b/daemon.mjs" --listen "127.0.0.1:$PORT" --claude "$CLAUDE_BIN" --spawn-cwd "$WORK/b-cwd" --tmp-dir "$WORK/b-tmp" \
  >"$WORK/daemon.log" 2>&1 &
DAEMON=$!
# The daemon runs in its own session (setsid); killing bwrap alone would leave it running.
trap 'kill -- "-$DAEMON" 2>/dev/null || true' EXIT
for _ in $(seq 60); do grep -q "listening on" "$WORK/daemon.log" 2>/dev/null && break; sleep 0.5; done
grep -q "listening on" "$WORK/daemon.log" || { cat "$WORK/daemon.log"; exit 1; }
export CLAUDE_CONFIG_DIR="$WORK/a-claude" CLAUDE_BRIDGE_REMOTE="ws://127.0.0.1:$PORT" CLAUDE_BRIDGE_REMOTE_TOKEN="$TOKEN"
export CLAUDE_BRIDGE_TEST_LOG_DIR="$WORK/logs"
cd "$BRIDGE_DIR"
status=0
node --import tsx --test "$@" || status=$?
echo "--- daemon log: $WORK/daemon.log ($(grep -c 'spawn pid' "$WORK/daemon.log") spawns, $(grep -c LEAK "$WORK/daemon.log" || true) leaks, $(grep -c 'refused pid' "$WORK/daemon.log" || true) refused stdin messages)"
exit $status
