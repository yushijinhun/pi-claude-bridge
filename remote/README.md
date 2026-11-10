# pi-claude-bridge-remote

Run Claude Code for [pi-claude-bridge](https://github.com/yushijinhun/pi-claude-bridge/tree/feat/remote-mode) on another machine. pi, its tools, files and session history stay on your machine (A); the machine with the Claude login (B) runs `claude` through this package's daemon. The model is shown A's working directory, git state, platform, shell and OS version, and none of B's paths.

Experimental. The design, what crosses the connection and the test results are in [REPORT.md](REPORT.md).

## On B

The daemon runs from a checkout of this repository. Log in with `claude auth login`, then:

```sh
git clone -b feat/remote-mode https://github.com/yushijinhun/pi-claude-bridge && cd pi-claude-bridge
npm install --omit=dev --workspace remote    # the daemon's one dependency, ws
umask 077; head -c 32 /dev/urandom | base64 > ~/.config/claude-remote-token
./remote/daemon.mjs --token-file ~/.config/claude-remote-token --claude "$(command -v claude)"
```

After a `git pull`, restart the daemon, and run the `npm install` line again if `remote/package.json` changed.

The daemon speaks plain `ws://` on the address `--listen` gives (default `127.0.0.1:7878`) or on a Unix socket. Reach it in one of these ways:

- **ssh tunnel between Unix sockets**, when other users share A or B. Any user can listen on a loopback port that nothing holds, such as the daemon's while it is down or the tunnel's end while ssh is down, and gets the token of whoever connects there; a socket in a directory only you can change cannot be taken that way. Start the daemon with `--listen unix:$HOME/.claude-remote/daemon.sock`, and on A run `mkdir -m 700 -p ~/.claude-remote` and `ssh -N -o StreamLocalBindUnlink=yes -L ~/.claude-remote/b.sock:/home/you/.claude-remote/daemon.sock B` (B's path, written out). Use `ws+unix:///home/you/.claude-remote/b.sock` (A's path). The sockets protect only in directories no other user can write to.
- **ssh tunnel between loopback ports**, when nobody else uses A or B: `ssh -N -L 7878:127.0.0.1:7878 B`, and use `ws://127.0.0.1:7878`.
- **Directly**: `--listen 0.0.0.0:7878` (or one of B's addresses), and use `ws://B:7878`. The token and everything else cross unencrypted, and anyone who can reach the port can keep pi out: connections that have not shown the token count toward the daemon's connection limit (`--max-runs` plus 32) for up to 10 seconds each, and the daemon logs every one it refuses. Use it on a network you trust.
- **TLS reverse proxy on B** (nginx, Caddy, ...) in front of the daemon. Pass the `Upgrade`, `Connection` and `Authorization` headers and keep idle connections open for longer than 20 seconds. Use `wss://your-host/`. A checks the proxy's certificate as any Node TLS client does; for a certificate from a private CA, start pi with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

Options take `--name value` or `--name=value`, and an unknown option stops the daemon. `--listen` takes `host:port` (default `127.0.0.1:7878`; an IPv6 host in brackets, `[::1]:7878`), or `unix:` and a socket's absolute path (its directory is created if missing). Other options: `--max-runs` (concurrent runs, default 8), `--keepalive-seconds` (default 20, at most 30), `--path` (default `/`), `--keep-days` (how long B keeps a session file, default 30), `--spawn-cwd` and `--tmp-dir` (defaults under `/tmp/claude-remote-<uid>/`; created again before each run, and refused if another user could change them; one daemon at a time per spawn directory), `--agent-sdk-version` (the Agent SDK the bridge pins). The token can also come from `CLAUDE_REMOTE_TOKEN`.

B's own Claude Code settings (`settings.json`, hooks, `CLAUDE.md`, rules, skills) are not loaded. Put anything Claude Code needs besides the login, such as a proxy or Bedrock variables, in the daemon's environment.

## Multiple subscriptions

Account selection and quota recovery run entirely in the daemon. Use the same setup for a daemon on your own machine or on another machine; local pi instances connect over a Unix socket or loopback URL using `provider.remote`. Clients keep one provider, one connection per query, and their existing session IDs. `pi-limits-wait` needs no changes.

Log in separately for each subscription:

```sh
mkdir -m 700 -p ~/.claude-accounts/personal ~/.claude-accounts/work
CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/personal" claude auth login
CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/work" claude auth login
```

Create `~/.config/claude-accounts.json`:

```json
{
  "accounts": [
    { "id": "personal", "configDir": "~/.claude-accounts/personal", "priority": 100 },
    { "id": "work", "configDir": "~/.claude-accounts/work", "priority": 50 }
  ],
  "scheduling": "priority",
  "exhausted": "error",
  "fallbackCooldownSeconds": 60
}
```

All supported top-level options:

| Option | Default | Meaning |
| --- | --- | --- |
| `accounts` | Required | Nonempty array of account definitions. |
| `scheduling` | `"priority"` | `"priority"` selects the highest-priority available account; `"sticky"` keeps the session's previous account while it remains eligible and available. |
| `exhausted` | `"error"` | `"error"` returns a rate limit when all eligible accounts are cooling down; `"wait"` keeps the query open until an account becomes available. |
| `fallbackCooldownSeconds` | `60` | Seconds to block an account after a quota failure without a usable future reset time. Must be at least `1`; fractions are allowed. A reported future reset takes precedence, plus one second. |

All supported account fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `id` | Required | Unique, nonempty string used in daemon logs. No character or format restrictions. |
| `configDir` | Required | Directory holding the Claude Code login. Supports absolute paths, `~/` on the daemon machine, and paths relative to the accounts file. Accounts must resolve to distinct real directories owned by the daemon user and protected from other users' writes. |
| `priority` | `0` | Higher numbers win when choosing among accounts. Must be a safe integer; negative values are allowed. |
| `models` | All models assumed supported | Optional nonempty list of exact Claude Code model IDs. Bare IDs and `[1m]` variants are separate entries; aliases and wildcards are unsupported. This filters eligibility, without granting model access. |

Unknown keys are rejected. Both scheduling policies exclude accounts that are ineligible for the model or still cooling down.

Start the daemon with the account file:

```sh
./remote/daemon.mjs \
  --token-file ~/.config/claude-remote-token \
  --accounts-file ~/.config/claude-accounts.json \
  --listen "unix:$HOME/.claude-remote/daemon.sock" \
  --spawn-cwd "$HOME/.claude-remote/worker" \
  --tmp-dir "$HOME/.claude-remote/tmp"
```

Then use `ws+unix:///home/you/.claude-remote/daemon.sock` in pi's existing `provider.remote.url` setting. Remote clients can reach this daemon through the tunnels described above.

- With `scheduling: "priority"` (the default), higher `priority` wins among eligible accounts with quota available. With the example above, personal is used first, then work. After personal's quota resets, the next query prefers it again even if the session last used work. At equal priority, the daemon prefers the session's previous account, then fewer active workers, then configuration order.
- With `scheduling: "sticky"`, the session's previous account wins while it remains eligible and available, even if another account has a higher priority or has recovered quota. When that account cannot serve the request, or a session has no previous account, selection falls back to priority, then fewer active workers, then configuration order.
- When a request hits a quota limit, the daemon records the reset, stops that worker, and continues the unfinished turn with another eligible account. Completed tool calls and their results remain in the transcript. The new worker resumes the session and, once the client's tools are registered, gets Claude Code's own "Continue from where you left off." prompt. The model keeps the email address it was first shown: the daemon hides the change of login from Claude Code, which would otherwise announce the other address in the middle of the turn.
- `exhausted: "error"` (the default) returns `Claude quota exceeded: rate limit (retry-after-ms=N)` when every eligible account is drained; the delay names the earliest reset. `pi-limits-wait` can handle this as an ordinary rate limit. Set `exhausted: "wait"` to keep the query open until a reset; cancellation and WebSocket keepalives still work.
- An account can restrict eligibility with `"models": ["claude-opus-5-5", "claude-sonnet-5-5[1m]"]`. These are exact Claude Code model IDs; extended context is a separate entry. Without `models`, the daemon assumes the account supports every requested model.
- Reset times apply to their reported window: an Opus weekly limit does not block Sonnet. A failed 429 without a reset uses `fallbackCooldownSeconds`. Per-account usage percentages are not forwarded as pool usage. Claude Code's Extra Usage settings still control billing.
- Text and thinking stream immediately. Tool-call frames and completed assistant records wait until the model response completes, so tools from an abandoned response never run. Frames after a tool call wait too, preserving their order. If a stream is interrupted, its partial text may briefly appear before Claude Code's usual retry replaces it. Pending prompts and held messages are each limited to 32 MiB per query.

Several daemons can use the same account directories simultaneously. Give each daemon its own listener, `--spawn-cwd`, and `--tmp-dir`. They share cooldowns through files under each account's `claude-remote/limits/`; use the same real config directory wherever you use the same login. Different directories logged into the same subscription are not automatically recognized as one account. On different machines, cooldowns are local to each machine.

The accounts file reloads automatically, including when an editor replaces it by rename. Each account selection also re-reads it. Account additions, removals, priorities, scheduling policy, model eligibility and exhaustion settings apply to new queries and failovers; waiting queries recheck within one second. A running worker keeps its account until it finishes or needs to switch, so edits do not interrupt tools. Invalid or temporarily missing files are logged and the last valid config stays active. Cooldowns survive reloads.

The daemon's session cache is kept in `<real-spawn-cwd>.sessions`, separate from account working copies. Account config paths can be absolute, start with `~/`, or be relative to the accounts file. Account settings and hooks are not loaded. Environment credentials such as `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are removed from pooled workers so they use the selected directory's login.

Verified with Claude Code 2.1.321 and Agent SDK 0.3.321 against a local mock API, including immediate text/thinking delivery, quota failures after tool results, the client's tools and the account email after a switch, preserved thinking signatures, interrupted streams, non-streaming fallback, queued prompts, summaries, forks, cancellation, priority and sticky scheduling, hot reload, and simultaneous daemons. Run `npm run test:remote-pool` from the checkout; it uses isolated dummy logins and makes no subscription requests.

## On A

pi needs the bridge from this repository; the `pi-claude-bridge` release on npm has no remote mode. Run `npm install` in a checkout and `pi install /path/to/checkout`, or `pi install git:github.com/yushijinhun/pi-claude-bridge@feat/remote-mode`, which makes pi clone that branch and run `npm install` there. That install links this package into the bridge.

Put the token in `~/.config/claude-remote-token` and add to `~/.pi/agent/claude-bridge.json`:

```json
{ "provider": { "remote": { "url": "ws://127.0.0.1:7878", "tokenFile": "~/.config/claude-remote-token" } } }
```

Behind a reverse proxy, use its `wss://` URL instead. A `ws+unix://` URL gives a socket's absolute path. `CLAUDE_BRIDGE_REMOTE` and `CLAUDE_BRIDGE_REMOTE_TOKEN` set the same from the environment.

In this mode the bridge ignores `autoMemoryEnabled: true`, `strictMcpConfig: false` and `pathToClaudeCodeExecutable`, and pi shows a warning when they are set: auto memory would be kept on B for every project at once, MCP servers from Claude Code's config would run on B, and the daemon picks the binary. A provider `env` (in `auth.json` or per request) does not reach Claude Code either.
