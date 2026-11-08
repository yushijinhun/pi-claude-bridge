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

## On A

pi needs the bridge from this repository; the `pi-claude-bridge` release on npm has no remote mode. Run `npm install` in a checkout and `pi install /path/to/checkout`, or `pi install git:github.com/yushijinhun/pi-claude-bridge@feat/remote-mode`, which makes pi clone that branch and run `npm install` there. That install links this package into the bridge.

Put the token in `~/.config/claude-remote-token` and add to `~/.pi/agent/claude-bridge.json`:

```json
{ "provider": { "remote": { "url": "ws://127.0.0.1:7878", "tokenFile": "~/.config/claude-remote-token" } } }
```

Behind a reverse proxy, use its `wss://` URL instead. A `ws+unix://` URL gives a socket's absolute path. `CLAUDE_BRIDGE_REMOTE` and `CLAUDE_BRIDGE_REMOTE_TOKEN` set the same from the environment.

In this mode the bridge ignores `autoMemoryEnabled: true`, `strictMcpConfig: false` and `pathToClaudeCodeExecutable`, and pi shows a warning when they are set: auto memory would be kept on B for every project at once, MCP servers from Claude Code's config would run on B, and the daemon picks the binary. A provider `env` (in `auth.json` or per request) does not reach Claude Code either.
