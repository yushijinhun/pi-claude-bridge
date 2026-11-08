# Running Claude Code on another machine

Goal: pi and everything it touches (tools, files, conversation history) stay on machine A. Machine B holds the Claude login and runs `claude`. B gets no copy of A's project, no sshfs/NFS mount and no shadow folders, and the model still sees A's working directory, git state, platform, shell and OS version. A sends B no environment variables and no command-line arguments; B runs Claude Code with its own environment and builds its command line itself. B may keep the session files it ran, but must never return a transcript A does not already have.

## Result

It works. The code is the `pi-claude-bridge-remote` package in `remote/`, plus about 90 changed lines in three `src/` files and a new 37-line `src/remote-results.ts`:

- **A (bridge):** the Agent SDK still runs here. Its documented `spawnClaudeCodeProcess` hook hands Claude Code's stdio to a WebSocket instead of a local child process.
- **B (daemon):** `claude-remote-daemon` starts `claude` in one fixed empty directory and relays its stdio.
- **Connection:** one WebSocket per run, authenticated with a bearer token on the upgrade request. The daemon speaks plain `ws://` on any address or a Unix socket; A reaches it directly, through an ssh tunnel (between Unix sockets when other users share A or B), or through a TLS reverse proxy on B with `wss://`.
- **Tool calls:** pi's tools reach Claude Code as an in-process MCP server over the SDK control channel, which already travels inside that stdio. Steering and interrupts take the same path, so none of them needed changes. The daemon passes only the stdin messages the bridge sends; anything else ends the run before Claude Code sees it.
- **History:** A's copy of each transcript is the one that counts. B keeps the files it ran, so a turn sends only a hash of A's copy, and B returns only the lines Claude Code appended (see "Stored sessions on B").
- **Injected prompt:** Claude Code builds its `# Environment` block from its own machine. A behavior found by reverse engineering makes it show A's values instead, with no change to Claude Code (see "Making the injected prompt describe A").
- **Images:** the model gets every image. Claude Code's line naming the copy it saved, which would be a path on B, is suppressed (see "Images").
- **B's own configuration:** B's Claude Code settings, hooks and instructions are not loaded.

What was validated, with B simulated as a bubblewrap sandbox in which A's checkout path does not exist:

| Check | Result |
|---|---|
| `remote/test/e2e-mock.mjs` (mock API, no usage) | 83/83 on Claude Code 2.1.308 and 2.1.317 |
| `remote/test/pi-e2e.sh`, real API | Claude Haiku 4.5 then Haiku 5.5 reported A's directory; pi's bash ran on A; after a pi restart the next request read all 6,932 cached tokens back |
| The bridge's own integration tests in remote mode (real API) | 12 of 15 pass in one run, 40 remote runs, no leak, no refused message; one steer test times out, as it does without remote mode, and the two after it pass when run alone |
| Traffic for 5 prompts in one pi process | 144 KB with the connection's compression, 507 KB without |
| Latency of a fresh turn on one host (mock API) | median 229 ms through the daemon, 219 ms with a local Claude Code |
| Unit tests and typecheck | 456/456; `tsc --noEmit` clean |

The rows for `pi-e2e.sh` on the real API, the integration tests, traffic and latency were measured on the first WebSocket version. The changes since (B's snapshot computed instead of learned from a run of Claude Code, the keepalive, the wait limits, failure reports, session files sent in pieces) were checked with the mock tests, `pi-e2e.sh` on the mock API and the unit tests.

## Architecture

```
machine A (pi, files, tools)                          machine B (claude login)
┌───────────────────────────────────────┐            ┌──────────────────────────────────┐
│ pi ── bridge ── Agent SDK query()     │    one     │ claude-remote-daemon             │
│        │  spawnClaudeCodeProcess ─────┼─WebSocket──┼─▶ spawn claude                   │
│        │  (pi-claude-bridge-remote)   │  per run   │     cwd = fixed empty directory  │
│        │                              │            │     env = B's own + fixed values │
│        │◀── stream-json, SDK control ─┼────────────┼── stdout/stderr                  │
│        │    (MCP tool calls, steers,  │            │                                  │
│        │     interrupts, rate limits) │            │ transcript: B's stored copy when │
│ pi tools ◀── in-process MCP server    │            │ A's hash matches, else sent;     │
│ transcripts: $CLAUDE_CONFIG_DIR/      │◀── exit ───┼── appended lines come back       │
│   projects/<A cwd>/<id>.jsonl         │            │                                  │
└───────────────────────────────────────┘            └──────────────────────────────────┘
```

The WebSocket uses the subprotocol `claude-remote.v1`, and its upgrade request carries `Authorization: Bearer <token>`. Control messages are JSON text; byte streams are binary messages whose first byte names the channel:

| Direction | Message |
|---|---|
| A → B | `spawn` (first message): query kind, model, thinking level, session ids, A's environment snapshot, and the SHA-256 of A's copy of the session to resume; never environment variables or arguments |
| B → A | `need`: B has no matching copy of the session |
| A → B | channel 3: A's copy of the session, only after `need` |
| B → A | `spawned` with the process id |
| A → B | channel 0: stdin bytes, checked line by line on B; `stdin-end`; `kill` with `SIGTERM` or `SIGKILL`; all only after `spawned` (before it, A stops a run by dropping the connection) |
| B → A | channels 1 and 2: stdout and stderr |
| B → A | channel 4: what A lacks of the transcript Claude Code wrote, the appended lines or the whole file for a new session |
| B → A | `exit`: exit status, the session id, offset and length of that file part, and the reason when the daemon stopped the run; then B closes |

Session files, A's copy on channel 3 and B's on channel 4, go in 1 MiB fragments, so pings and pongs get through while they travel (see "Keepalive and slow links").

The process object on A emits `close` only after that transcript is stored, so the bridge's existing wait for child exit (`QueryProcess.exited`) still guards every read of the file.

## Blockers

These are the places where Claude Code reads its own machine, or where the bridge assumes that machine is its own.

| # | Blocker | Evidence | Resolution |
|---|---|---|---|
| 1 | The bridge starts Claude Code as a local child process | `QueryProcess.spawn` calls Node's `spawn`; the summary path uses the SDK's default spawn | Both use `spawnClaudeCodeProcess`, which the SDK documents for "VMs, containers, or remote environments" (`sdk.d.ts`) |
| 2 | Transcripts live on Claude Code's machine, and the bridge reads and writes them directly | `syncSharedSession` uses `createSession`, `importHistory`, `savePrefixSession`, `readTranscript`, `deleteSession` and `statSync`; Claude Code resumes from `~/.claude/projects/<cwd>/<id>.jsonl` | A keeps every transcript at its usual path. B keeps the files it ran and resumes its own copy when A's copy hashes the same; otherwise A sends its copy. B returns the lines Claude Code appended, and A appends them. Bridge session logic is unchanged |
| 3 | The working directory must exist on B | Node `spawn` fails with ENOENT for a missing cwd. Claude Code's working directory is `process.cwd()` at start-up (`Xvn=yZo()`), with no flag or environment override | The daemon uses one fixed empty directory (default `/tmp/claude-remote-<uid>/cwd`). It creates it again before each run, since a /tmp cleaner removes it after days without runs, and refuses it, and Claude Code's temporary directory, if another user could change either (test T20) |
| 4 | The `# Environment` block describes B: directory, git state, platform, shell, OS version | Built every turn by `Hbt()` and announced by `QEn()` (next section) | Seeded environment record; this is the main result of the reverse engineering |
| 5 | The date is in B's time zone | The `date` attachment uses local time | Left as B's. A's `TZ` would expose A's local setting, so it is not sent (test T6 checks that A's `TZ` has no effect) |
| 6 | `@path` in a prompt reads B's files, and a slash command runs B's custom commands | Measured: relative and absolute `@path` put B's file contents into the request and into the transcript returned to A; `/name` ran B's `~/.claude/commands/name.md` | The daemon marks every prompt and steer it relays `client_composed`, which turns off `@path` expansion and slash commands whatever A sends. The bridge also sets `verbatimPrompts` |
| 7 | Tool results over 50,000 characters are replaced by a path on B | Measured: 50,000 characters inline; 50,001 became `<persisted-output>… saved to <B session dir>/tool-results/…`. pi's read tool on A cannot open that path | `src/remote-results.ts` cuts results to 49,700 characters from the middle (pi's own trailing truncation note survives) and saves the full text on A, in a new file only the user can read, as pi saves its own truncated output |
| 8 | pi's environment would be passed through whole | The SDK hands the spawn function `ccChildEnv(process.env)` plus its own variables: about 100 entries, including `PATH`, `HOME`, `PI_SESSION_FILE` and any exported keys | The spawner never sends it, and the daemon refuses a request that carries `env`. Claude Code runs with B's environment plus fixed values the daemon sets (see "Claude Code's environment on B"); test T4 reads `/proc/<pid>/environ` of the remote process |
| 9 | A's command line, including A's paths, would reach B | `--debug-file=<A path>` when `CLAUDE_BRIDGE_DEBUG` is set; every flag the SDK builds on A | A sends no arguments. B builds the command line from four request fields (see "Claude Code's command line on B") |
| 10 | Possession of the token would give a shell on B | Claude Code's own tools, stdio MCP servers, plugins and settings hooks all run where Claude Code runs | A cannot pass flags at all. The daemon accepts only the request fields, checks each value (model id pattern, thinking level, UUIDs, snapshot types), and refuses any other field (test T9) |
| 11 | Claude Code's stdin takes commands that act on B | Measured on 2.1.308 through the daemon: a `bash_command` message ran a shell command on B and returned its output; an `mcp_set_servers` control request started a stdio MCP server, which is any command; `read_file` read files under the spawn directory; Claude Code also handles `set_cwd`, `update_settings`, `set_model` and other control requests there | The daemon passes only what the bridge's SDK sends (below) and ends the run on anything else (test T11) |
| 12 | Claude Code tells the model where it saved each image, on B | Measured on 2.1.308: a prompt image is followed by `[Image: source: <temp dir>/<spawn directory>/<session>/images/1.png]`, an image in a tool result by `[Image: source: <B's config>/projects/<spawn directory>/<session>/tool-results/mcp-….png]`. The model's tools run on A, where neither file exists | The daemon puts a plain file where each folder goes, so the save fails and Claude Code sends the image alone (see "Images") |
| 13 | B's own Claude Code settings would reach remote runs | Measured with `--setting-sources=user`, as a local bridge child uses: hooks in B's `settings.json` ran on B for every prompt, and their output reached the model; B's `rules/` did too when B's config directory is not named `.claude` | Claude Code on B runs with `--setting-sources=` (test T15) |
| 14 | A transcript can leave Claude Code without an environment record on the chain it resumes | Measured: a file whose first record names a parent missing from the file made Claude Code send B's environment block | The daemon checks every chain and hangs each one without a record from a record describing A (test T14) |
| 15 | Claude Code's output, including the tool calls pi runs on A, comes from B over the network | Whoever can pose as B can have pi's tools run commands on A | With `wss://` through a TLS reverse proxy, A checks the proxy's certificate as Node does for any client; `ws://` and `ws+unix://` rely on the way to B, such as an ssh tunnel or a socket. A stores only the session file it asked for (see "The connection", tests T16–T19, T21 and T23) |

These already worked over stdio and needed no changes: MCP tool calls, parallel tool results, steering (stdin messages with `priority: "next"`), followUps, interrupts and aborts, rate-limit events, partial-message streaming, and forks (`--fork-session --resume-session-at`).

### What the daemon lets through on stdin

The list comes from what Claude Code received during the integration tests (a wrapper on B copied its stdin) and from the SDK's own writers in `sdk.mjs`. The SDK also sends `control_cancel_request` for an aborted request that carries a signal, and none of the bridge's requests do.

| Message | Allowed content | Sent by the bridge for |
|---|---|---|
| `user` | fields `type`, `message` (`role: "user"`; text blocks, and image blocks with inline base64 data), `parent_tool_use_id: null`, `uuid`, `session_id`, `priority`; the daemon sets `client_composed` | prompts and steers |
| `control_request` `initialize` | `sdkMcpServers`, `sdkMcpServerManifests` (each with only `initializeResult`, `toolsListResult`), `appendSystemPrompt`, `systemPrompt` (strings), `skills` (empty) | provider queries (pi's tools and the forwarded system prompt), summary queries (own system prompt, no skills) |
| `control_request` `interrupt` | no other field | aborts |
| `control_response` | `success` whose response holds only `mcp_response`, or `error` with a string | answers to Claude Code's calls into pi's tools |

Everything else is refused: other message types (`bash_command`, `update_environment_variables`, `keep_alive`, ...), other control requests (`mcp_set_servers`, `read_file`, `set_cwd`, `update_settings`, `set_model`, ...), `initialize` fields such as `hooks`, `agents` and `plugins`, extra fields on a prompt (such as `origin`) or on its blocks, images given by URL or file id (the API would fetch them, a file id from B's account), and permission answers. The daemon logs `refused pid=…`, stops Claude Code and names the reason in the run's `exit` message, which pi shows (see "Failures" under "The connection").

## Making the injected prompt describe A

### How Claude Code 2.1.308 builds and announces the environment

Function names are from the minified bundled binary. Behavior was confirmed against 2.1.317 with the same tests.

- **The live snapshot, `Hbt()`,** is rebuilt every turn:
  - `workingDirectory` is the state cwd from start-up.
  - `isGitRepo` and `isWorktree` come from git in that directory.
  - `platform` is `process.platform`.
  - `shell` is `$SHELL` reduced to `bash`/`zsh` (`Hro()`).
  - `osVersion` is the OS type plus release (`jro()`).
  - `scratchpadDirectory` and `githubCli` are added only when feature flags turn them on. They stay off under `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, which the daemon sets.

  None of these can be overridden from outside the process. Claude Code has an internal override for exactly this case, `lde()` → `host.launchOptions.toolsMachine()`, which describes a separate machine that runs the tools. Its setter `replaceToolsMachine` appears only in its own definition in both 2.1.308 and 2.1.317, so public builds never set it.
- **Rendering, `Kro()`,** produces `Primary working directory: …`, `Is a git repository: …`, `Platform: …`, `Shell: …`, `OS Version: …` and a fixed line about untrusted downloads. In a git worktree two lines about worktrees follow the directory.
- **Announcing, `QEn()`,** compares the live snapshot with the `snapshot` field of the newest `environment` attachment in the transcript:
  - a different `platform`, `shell` or `osVersion` (`pFe()`) re-sends the whole block;
  - a different directory, git state, extra directories or one of the flag-gated fields (`Wbt()`) sends an `# Environment update`;
  - equal snapshots send nothing.
- **On resume,** each stored attachment goes to the API as its stored `rendered` text. The `snapshot` field is never re-rendered. Measured: editing `rendered` in a transcript changed the request; leaving `snapshot` equal to the live machine produced no update.

### The seeding mechanism

An `environment` record whose `snapshot` equals B's live snapshot and whose `rendered` text describes A is accepted as current and sent to the model verbatim. In the daemon:

1. **B's snapshot and Claude Code's text.** `remote/env-block.mjs` computes a snapshot the way `Hbt()` does (`localSnapshot`), and renders a block the way `Kro()` does from a copy of Claude Code 2.1.308's text (`renderEnvironment`). The daemon computes B's snapshot for its spawn directory before each run. A computes its own with the same function and sends it.
   - Test T0 checks both against what Claude Code writes itself, in a plain directory, a git repository and a git worktree: the snapshot, the text and the record's fields are the same on 2.1.308 and 2.1.317, whose text is byte-identical. Run it when Claude Code changes.
   - At start-up the daemon logs a warning when `claude --version` is not one of the tested versions. Nothing else runs Claude Code outside a request, so a proxy or Bedrock/Vertex variables in the daemon's environment only affect real runs.
2. **For each run:**
   - Every environment record in the transcript gets B's snapshot; its `rendered` text is kept.
   - Every chain Claude Code could resume, up from each leaf and up from the fork point, must hold an environment record; on a chain without one Claude Code announces its own machine. The top of each such chain hangs from a new record whose snapshot is B's and whose text is rendered from A's snapshot. A transcript the bridge imported has one chain from a root with no parent, so it gets one record above that root. A chain whose top names a parent missing from the file gets one too (test T14). None of 155 of Claude Code's own transcripts on A with an environment record needed one.
   - A new conversation starts from a file that holds only this record, so for a requested new session X the daemon runs `--resume X`. A file that holds only an attachment resumes cleanly on both versions.
   - The daemon sets `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS=1`, as the bridge does for a local child. Without it, one configuration inserted a "No response requested." assistant turn after the seed.
3. **On the way back,** records get A's snapshot and A's cwd. A's copy then matches what a local Claude Code on A would have written: resuming it with a local Claude Code on A produced no environment update, so switching between local and remote mode is seamless.
4. **Leak check.** An environment record the daemon did not seed means Claude Code described B to the model. The daemon logs it and pi shows a warning; it never fired in the tests. Paths on B in what Claude Code writes are checked by the tests only: no request and no transcript kept on A may name B's spawn directory (as a path or as Claude Code's folder name for it), Claude Code's temporary directory or B's config directory. At runtime that check would also match A's own paths, because B's config directory (`/home/<user>/.claude`) starts the same as A's when both machines have the same user name.

The values are A's at the time the record was written. A later change on A during a session (the directory becoming a git repository, a new kernel or `$SHELL`) is not announced, where a local Claude Code would announce it.

What the model sees matches a native session:

- Haiku 4.5 gets the block folded into the first user message.
- Opus 5.5 and Haiku 5.5 get the system turn after the first user message.
- In imported transcripts the block also sits after the first user message.
- Requests are byte-identical across turns apart from moving `cache_control` markers.

On the real API, the request after a pi restart (a fork) read back everything its ancestor had cached.

### Approaches that did not work

- **Recreating A's path on B** with mkdir, a mount namespace or bubblewrap creates shadow folders or needs user namespaces. Platform and OS version stay B's, and git state needs a fake `.git`.
- **`--bare` / `CLAUDE_CODE_SIMPLE`** drops the environment block, but "OAuth and keychain are never read" in that mode.
- **`excludeDynamicSections: true`** (tested) still sends the environment block with B's directory.
- **A request-rewriting proxy on B** requires `ANTHROPIC_BASE_URL`, after which Claude Code treats the connection as not first-party, unless the internal `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` is set. Per-turn reminders still differ, and every request would be rewritten as text.
- **The SDK's `sessionStore`** loads a transcript on the SDK's machine (A) into a temporary `CLAUDE_CONFIG_DIR`, together with a copy of the credentials with the refresh token removed (`CJ()`/`s9e()` in `sdk.mjs`). That is the wrong machine, and a token that cannot refresh. The daemon does the same steps on B with B's real config.

## Images

The model always gets the image itself. What comes with it:

| Where the image comes from | What the bridge gives Claude Code | What the model gets, local mode | What the model gets, remote mode |
|---|---|---|---|
| A prompt or steer | base64 image blocks in the stdin user message | the image, then `[Image: source: <Claude Code's temp dir>/…/images/N.png]` | the image |
| A tool result: pi's `read` of an image file, or any tool that returns image content | MCP image content | the image, then `[Image: source: <config>/projects/…/tool-results/mcp-….png]` | the image |
| pi history the bridge writes into a session (import, rebuild) | base64 image blocks in the transcript; for a tool result pi still holds unchanged, the block Claude Code recorded, its line included | what was written | what was written |
| An isolated summary query | text only; the bridge leaves images out | no image | no image |

More details:

- **Paths the model has.** For pi's `read`, the path on A is in the model's own tool call. A pasted image in pi's TUI is saved to `/tmp/pi-clipboard-<uuid>.png` on A and its path put in the prompt, and an `@image.png` on pi's command line comes with `<file name="…">` naming the file on A. An image from another tool or an RPC client, with no file named, has no path in remote mode; in local mode the model would have Claude Code's copy.
- **Shrinking.** Claude Code shrinks an image over 2000 px on its longest side and then adds `original WxH, displayed at wxh. Multiply coordinates by k to map to original image.`, in the same line as the path. pi's `read` tool and pi's `@image.png` attachments are already shrunk to 2000 px by pi, which adds the same note itself, so Claude Code rarely shrinks them again.
- **Lines in the transcript.** The line goes into the transcript with the image: in its own record after a prompt, inside the `tool_result` block for a tool. On resume Claude Code sends both again.
- **When an image is left out.** Claude Code's own compaction replaces images with `[image]`, but the bridge turns it off (`DISABLE_AUTO_COMPACT`). In a tool result each image counts as 1,600 of the MCP output limit of 25,000 tokens, and images past the limit become `[Image left out: it did not fit in the tool output limit]`.

**On B.** Both files would be on B, where pi's tools cannot open them, and the paths name B's config directory and spawn directory. In 2.1.308 the save is the only thing that produces the line: when it fails, Claude Code sends the image without it. Before each run the daemon puts an empty file where the session's `images/` folder (under Claude Code's temporary directory, which the daemon sets with `CLAUDE_CODE_TMPDIR`) and its `tool-results/` folder go. The `tool-results/` folder also receives other binary tool output and oversized results. pi's tools return no other binary content, and the bridge's cap keeps text results under Claude Code's 50,000-character threshold; if either still reached that folder, the result would name a path on B, which T13 checks no request does.

Measured on 2.1.308 and 2.1.317 (test T13), with a 3000×2000 prompt image and a tool returning a 3000×2000 image:

- Both images reached the model at 2000×1333.
- The prompt image kept Claude Code's `[Image: original 3000x2000, displayed at 2000x1333. …]` line, without a source.
- No request named any of B's directories, and B kept no image file.

## Claude Code's environment on B

A sends no environment variables, and the daemon refuses a spawn request that has an `env` field. Claude Code inherits the daemon's own environment, without the daemon's token (`CLAUDE_REMOTE_TOKEN`), and with these fixed values on top. All but the last are what a local bridge child gets, and none of them describes A:

| Variable | Value | Why |
|---|---|---|
| `ENABLE_CLAUDEAI_MCP_SERVERS` | `0` | the bridge's `CC_CHILD_ENV`: no claude.ai connectors |
| `DISABLE_AUTO_COMPACT` | `1` | `CC_CHILD_ENV`: pi owns compaction |
| `CLAUDE_CODE_ELEGANT_MEADOW` | `0` | `CC_CHILD_ENV`: no API request records in the transcript |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | `CC_CHILD_ENV`; also keeps feature flags at their defaults, which keeps B's snapshot stable |
| `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS` | `1` | `CC_CHILD_ENV`; also needed for seeded files |
| `CLAUDE_CODE_SILENT_TURN_REMINDER` | `0` | `CC_CHILD_ENV` |
| `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` | `16384` | `CC_CHILD_ENV` |
| `CLAUDE_CODE_ENTRYPOINT` | `sdk-ts` | Agent SDK 0.3.308 sets it on every spawn; it is in Claude Code's User-Agent |
| `CLAUDE_AGENT_SDK_VERSION` | `0.3.308` (`--agent-sdk-version`) | the SDK sets it on every spawn; it is in the User-Agent as `agent-sdk/<version>`. It is B's setting, matched to the SDK version the bridge pins |
| `CLAUDE_CODE_SDK_READS_SESSION_STATE` | `1` | the SDK sets it on every spawn; Claude Code then emits `session_state_changed` events, which the SDK on A uses to end a run |
| `CLAUDE_CODE_TMPDIR` | `--tmp-dir` (default `/tmp/claude-remote-<uid>/tmp`) | Claude Code saves prompt images there; the daemon blocks that save and removes a session's folder with the session (see "Images") |

A's `TZ` and `LANG` are not passed either, so the date and the locale are B's. Passing any variable from A would need a dedicated spawn-request field; none is needed for Claude Code to run correctly.

**B's own settings.** Claude Code on B loads no settings file and none of the instructions, rules, skills, agents or commands in B's config directory (`--setting-sources=`). With `--setting-sources=user`, as a local bridge child uses, and hooks in B's `settings.json` that echo a marker:

- the `SessionStart` and `UserPromptSubmit` hooks ran on B for every remote prompt, and their output reached the model;
- A's transcript received the output and the hook command lines, and A's SDK received the output as `hook_response` events;
- B's `rules/*.md` reached the model when B's config directory was not named `.claude`, because the bridge's exclude pattern is `**/.claude/rules/**`;
- Claude Code's startup message on A listed B's custom skill, command and agent names.

With no setting sources none of these appear (test T15). OAuth login needs no settings file. Anything else Claude Code needs on B, such as a proxy or Bedrock and Vertex variables, goes in the daemon's own environment; an `apiKeyHelper` is not available. Managed (policy) settings still apply, as they do for any Claude Code on B.

## Claude Code's command line on B

A sends no arguments. The spawner reads four values from the command line the SDK built on A and sends only those:

| Field | Values | Reason |
|---|---|---|
| `kind` | `provider` or `summary` | The two query types use different fixed flags: setting sources, saved session or not, `--max-turns=1` |
| `model` | `claude-[a-z0-9-]+` with an optional `[1m]` | You choose the model in pi, and the bridge decides whether to ask for 1M context |
| `thinking` | `low`, `medium`, `high`, `xhigh`, `max` or `off`; absent for Claude Code's default | pi's thinking level |
| `session` | `{ resume?, sessionId?, forkAt? }`, all UUIDs | The bridge's session sync: resume, fork, or start fresh |

`claudeArgs()` in `protocol.mjs` produces the same flags, in the same order, as Agent SDK 0.3.308 does from the bridge's options:

```
normal query:  --output-format stream-json --verbose --input-format stream-json
               [--effort=<level> | --thinking=disabled] --model=<model> [--resume=<id>]
               --tools= --setting-sources=user --strict-mcp-config --permission-mode=bypassPermissions
               --include-partial-messages [--fork-session --resume-session-at=<id>] [--session-id=<id>]
               --replay-user-messages [--thinking-display summarized]
               --settings {"autoMemoryEnabled":false,"claudeMdExcludes":[...],"includeGitInstructions":false,"outputStyle":"default"}
summary query: --output-format stream-json --verbose --input-format stream-json [--effort=<level> | --thinking=disabled]
               --max-turns=1 --model=<model> --resume=<seed> --tools= --setting-sources= --strict-mcp-config
               --no-session-persistence --settings {"autoMemoryEnabled":false}
```

The spawner runs the same function on the four values it read and compares the result with the SDK's command line. Any flag left over or missing fails the query on A before anything is sent. A bridge or SDK change to the flags therefore stops remote runs until `claudeArgs()` is updated, instead of being dropped silently (test T10). The debug log path is the only flag skipped on purpose: it names a file on A.

Two bridge settings change these flags: `autoMemoryEnabled: true` and `strictMcpConfig: false`. Neither can apply on B: auto memory would be kept on B for every project at once, and MCP servers from Claude Code's config would run on B. In remote mode the bridge drops them, together with `pathToClaudeCodeExecutable`, and pi shows a warning at session start. `tests/unit-remote.mjs` sets all three, builds a provider query through the real SDK, and checks that the spawner accepts its command line; with the settings kept, it fails on the `--settings` value and the missing `--strict-mcp-config`.

B runs the same command line with one change: a normal query gets `--setting-sources=` instead of `--setting-sources=user`, so B's own Claude Code settings stay out. The `--settings` values still apply; auto memory, for one, stays off.

## What A exposes to B

**Once per run:**

- The token, in the `Authorization` header of the upgrade request.
- `kind`, `model`, `thinking`, `session`: the four request fields.
- `a.snapshot`, which becomes the environment block the model sees:
  - A's working directory as an absolute real path (so A's username, for a directory under `/home/<user>`);
  - whether it is a git repository or worktree;
  - the platform;
  - the shell name (`bash` or `zsh`; for any other shell, the full `$SHELL` path, as Claude Code itself does);
  - the OS type and kernel release.
- `have` (resume and fork only): the SHA-256 of A's copy of the session.
- The session file kept on A, only when B lacks a matching copy. It holds:
  - every prompt, reply, thinking block, tool call and tool result so far;
  - the environment block rendered for A;
  - records Claude Code wrote during earlier runs on B: the model, B's date, B's account email and organization id, costs and timings (including `totalToolDuration`, how long tools ran on A);
  - A's working directory in each record's `cwd` field.

**Claude Code's stdin, during the run:**

- The `initialize` request:
  - the system-prompt text pi forwards: AGENTS.md/CLAUDE.md contents with their absolute paths on A, the skills list with skill file paths on A, extension sections;
  - pi's tool list: names, descriptions and input schemas.
- Each prompt and each steer, as text and images.
- Each tool result: the output of pi's tools run on A (file contents, command output, paths). A result cut by the 50,000-character cap names the file on A that keeps the full text.
- Control messages: interrupts on abort, then stdin close and the kill signal.

The daemon checks each line against the list in "What the daemon lets through on stdin".

**Connection metadata:** A's IP address, seen by the reverse proxy on B (with `ssh -L`, B sees the SSH session instead), and timing: when turns start and how long tools run on A.

**Not sent:** environment variables (including `TZ`, `LANG`, `PATH`, `HOME` and any exported keys), the SDK's command line, debug log paths, and any file other than the session transcript.

B keeps what it receives: the session files stay on B's disk after the run (see "Stored sessions on B").

Apart from the token, the session ids, the transcript's metadata fields and the connection metadata, all of this is content Claude Code puts into its API requests; B needs it to build them.

## The connection

Claude Code's output, including the tool calls pi runs on A, comes back over this connection, so both ends check it.

- **Reaching B.** The daemon speaks plain `ws://` on the address `--listen` gives, or on a Unix socket. A accepts `ws://` to any address, directly or through an `ssh -L` tunnel (test T18), `ws+unix://` to a socket, and `wss://` to a TLS reverse proxy on B in front of the daemon. Plain `ws://` carries the token and everything else unencrypted, and A cannot tell B from whoever answers at the address. Whoever can reach the daemon's port can also keep pi out: connections that have not shown the token count toward the daemon's connection limit (`--max-runs` plus 32) for up to 10 seconds each. Measured with `--max-runs 1`: with 33 idle connections open, a client with the token got `socket hang up`. The daemon also logs every connection it refuses. A socket in a directory other users cannot change keeps them out, and a TLS proxy passes on only complete requests, which the daemon answers at once. A checks the proxy's certificate as any Node TLS client does: trusted by the system's authorities (or `NODE_EXTRA_CA_CERTS` for a private CA) and naming the host. Test T21 runs a turn through nginx, and a connection to a name the certificate does not list fails before anything runs.
- **Unix sockets.** Any user on a machine can listen on a loopback port that nothing holds: B's port while the daemon is down, or the near end of the ssh tunnel on A while ssh is down. Whoever connects there sends that user the token, and on A the impostor's answers would drive pi's tools. A socket in a directory only its user can change cannot be taken that way. That depends on where the socket is, and neither side checks it: a socket in a directory other users can write to, such as /tmp, is as open as a loopback port. With `--listen unix:/path/to/socket`, the daemon creates the socket's directory if it is missing, makes the socket mode 600, removes it when it stops, and takes over a socket left by a daemon that died but not one that still answers. ssh forwards between sockets (`-L /path/on/A.sock:/path/on/B.sock`) and creates its end with mode 600. Test T23 runs a turn over a socket, and stops and restarts daemons on one.
- **Who gets a WebSocket.** The daemon checks the upgrade request before upgrading and answers with an HTTP status otherwise: `401` without the token (checked first, so a client without it learns nothing else), `403` with an `Origin` header (a browser; the bridge sends none), `404` for another path, `400` without the subprotocol `claude-remote.v1`, and `503` when `--max-runs` runs (default 8) have not ended. A request that is not an upgrade gets `401`, or `426` with the token. Before the token is checked, a client gets Node's header limit (16 KiB) and 10 seconds to send its request, whether it sends slowly or nothing at all, and room for 32 such connections beside the runs. Node alone keeps a connection that sends nothing, and checks its request timeouts only every 30 seconds (test T16).
- **After the upgrade.** The spawn message must come within 10 seconds. When B asks for A's copy of the session, its first KB must come within a minute, and then at least 1 KB per 10 seconds. Stdin, `stdin-end` and `kill` come only once Claude Code runs, so B holds nothing for one that has not started; before that, A stops a run by dropping the connection, and an abort while its copy is on its way ends the run there and starts nothing on B (test T19). A message that fails (JSON that does not parse, an unknown type or channel, a kill signal other than `SIGTERM` or `SIGKILL`, a transcript B did not ask for, stdin before Claude Code runs, a request field that is not allowed) ends its connection with an `exit` message giving the reason and close code 4000; the daemon keeps serving the others (test T16). A message may hold up to 1 GiB, and a larger one closes the connection with 1009, but a session file can be at most about 512 MiB: B reads it as one string, and Node's strings stop there. Past that, the run fails with Node's error about the string length.
- **Keepalive and slow links.** Both ends ping every 20 seconds (`--keepalive-seconds` on B) and drop a connection from which nothing at all came for a whole interval; B then stops that run's Claude Code (test T19). Any bytes count, so a message that takes longer than the interval to arrive keeps the connection. An interval in which a side was not reading does not count against the other side, nor, for up to a minute, one in which its ping waited behind its own unsent bytes: a peer that is gone leaves those bytes unsent for good, and TCP takes about 15 minutes to give up on them, while a live peer pings within the minute (A every 20 seconds, B every `--keepalive-seconds`, at most 30; test T16). Session files go in 1 MiB fragments, each once the one before has left. ws compresses a message whole before its first byte goes out, and holds pings and pongs until then: that took 2 seconds for a real 91 MB session file and 8 seconds for 381 MB, and A's copy of a 500 MB session used to fail B's wait for it. In fragments the copy starts at once, and the 500 MB copy reached B, which started Claude Code after 13 seconds. B closes the connection only once its `exit` message has left, since closing starts a 30-second timer that would cut off what is still unsent. When A drops a silent connection, its error says so (`the remote daemon at … stopped answering: nothing came from it for … seconds`); B logs the connections it drops. Test T19 sends A's copy of a 1.2 MB session through a link that passes 200 KB a second while the daemon pings every second; T17 checks that A answers a ping while its copy of a session is on its way, and T19 that a fork of a 2 MB session comes back whole. The pings also keep proxies from closing a connection that is quiet during a long tool call.
- **A run that went quiet.** A connection that died without closing, such as an ssh tunnel that went away, stays open on B until the keepalive drops it, and its run holds its session until then. A runs one query per session at a time, so A's next run of that session means A has given up on the old one. B pings the old run's connection: if nothing comes back within 5 seconds, B stops that run (its Claude Code gets SIGTERM, and its session file is kept as after any run) and starts the new one; if the connection answers, the new run is refused (`session in use by another run`). The bridge's next turn after a failed one forks from the same session, so it meets the old run. Measured with an SDK turn whose connection was cut mid-run: the next turn used to fail for 40 seconds with that refusal, and now starts after 5.4 seconds (test T22).
- **Backpressure.** B holds Claude Code's output while more than 8 MB waits for A, and A stops reading while the SDK is behind on that output. A line for Claude Code's stdin waits until Claude Code reads it.
- **Compression.** Messages are compressed (permessage-deflate). For the 5-prompt measurement in one pi process (Claude Haiku 4.5, read and bash tools, a counting relay between A and B), the connection carried 144 KB with compression and 507 KB without: 31 KB up and 113 KB down, against 66 KB and 440 KB. Per prompt that was 18–48 KB instead of 59–151 KB.
- **Failures.** When a run fails outside Claude Code, A reports it as Node reports a process that could not start: an `error` event, and no `exit`. The Agent SDK then shows the reason, for example `Failed to spawn Claude Code process: the remote daemon at ws://127.0.0.1:7878 refused the connection: 401 Unauthorized; check the token`. This covers a daemon A cannot reach, an HTTP refusal (with a hint for 400, 401, 404, 502 and 503), a run the daemon stops (its `exit` message names the reason: a refused stdin message, Claude Code that could not start, a session file B could not send back, a new run of the session that replaced it), a connection that dropped or went silent, and a session file A cannot store or did not get: a turn that ended well always brings one back. The SDK adds stderr only to processes it starts itself, and the bridge always passes its own spawn function, so each of these used to read `Claude Code process exited with code 1`. The prefix is the SDK's, also for a run that failed after Claude Code started. An exit of Claude Code itself is still an exit (tests T10, T11, T16, T17, T20, T21 and `tests/unit-remote.mjs`).
- **What A accepts back.** A stores only the session file the run was asked to write: the resumed session, the fork's new id or the new session's id. A file for another session, or an id that is not a UUID, fails the run, and so does a file part whose length does not match what `exit` gives. A sends its copy of a session once, and only for a run that resumes one, since a B that kept asking would have A queue the whole file each time. Anything B sends after the run has ended is ignored; written to the ended streams, it would throw outside any handler, which ends pi (test T17). B drives pi's tools through Claude Code's tool calls in any case, so A depends on reaching the real B. A B that misbehaves can still take much of pi's memory: one message may hold 1 GiB, and Claude Code's output has no limit.

## Data flow per run

| Bridge decision | Request | Daemon on B | Returned to A |
|---|---|---|---|
| clean start (row 1) | `session: { sessionId: X }` | seed file X with only the environment record; run `--resume X` | X, whole |
| reuse (row 4) | `session: { resume: X }`, `have` | run B's copy of X | the lines appended to X |
| a transcript the bridge wrote: import, rebuild, prefix-write (rows 2, 3, 5, 7) | `session: { resume: X }`, `have`; then X after `need` | write A's X with B's snapshot | the lines appended to X, or X whole when B had to add an environment record |
| fork (row 6) | `session: { resume: P, sessionId: X, forkAt: U }`, `have` | run B's copy of P with `--fork-session` | X, whole (P is unchanged on A) |
| isolated summary | `kind: summary`, no session | seed a temporary file T; run `--resume T --no-session-persistence`; delete T | nothing |

Claude Code's normal global state in B's `~/.claude` (for example the project entry for the spawn directory in `~/.claude.json`) is updated as for any run.

## Stored sessions on B

After a provider run, B keeps the session file Claude Code wrote in `~/.claude/projects/<spawn directory>/`, and the daemon writes a note in `~/.claude/claude-remote/<spawn directory>/<id>.json`:

- the SHA-256 and length of A's copy (B's file mapped back for A: A's directory in `cwd`, A's snapshot in the environment records);
- A's working directory and A's snapshot for each environment record the daemon placed, so that mapping gives the same bytes on every run;
- B's snapshot when the file was made, which the file's environment records hold.

**A resume.** The spawner hashes its copy and sends the hash as `have`. B runs its own file only when a note exists, its hash equals `have`, A's directory and B's snapshot are unchanged, and the file has the noted length. Otherwise B sends `need`, A sends its copy, and B writes it as above. After the run B maps the whole file for A, writes a new note, and returns what follows A's copy if the mapped file still starts with it (checked by hash), or the whole file if not. A appends or replaces atomically.

**Nothing irrelevant reaches A:**

- B runs a stored file only when A proves it holds the same bytes: the hash goes only from A to B, and a miss reveals nothing A could not compute. B never runs a session A does not already have, and never resumes a file the daemon did not place (B's own Claude Code sessions live in other project directories).
- B returns only the target session of the run, and only what Claude Code wrote into it during this run, or the whole file when it is new (a fork, from a parent A just proved it holds).
- A session holding a marker string stayed in the same project directory while later sessions ran; the marker appeared in none of their API requests (test T12). A record whose parent was the last reply of another session B held did not pull that session into the request.
- A run whose result never reached A (a dropped connection, pi exiting mid-run) leaves B's copy ahead of A's. The next resume does not match, so A's copy replaces B's and B's records of the lost turn never reach the model (test T12). The bridge's next turn keeps A's records up to the lost turn and writes the rest from pi's history.

**Housekeeping.** A note exists only between runs: the daemon removes it when a run starts and writes it when the run ends, so a run that dies leaves a file without a note. At start and every 6 hours the daemon removes files without a note, notes without a file, notes unused for `--keep-days` (default 30) and notes made with another B snapshot. Removing a session also removes its folders in B's project directory, under Claude Code's temporary directory and in `~/.claude/session-env/`. A second run on a session that another run holds replaces that run when its connection no longer answers, and is refused otherwise (see "A run that went quiet"). The notes folder is created again whenever a note is written, so removing `~/.claude/claude-remote/` while the daemon runs only drops the stored copies (test T20). Only one daemon at a time may use a spawn directory: a second one would sweep away the first one's running sessions, which have no note yet. The daemon holds `<spawn directory>.lock` while it runs, and removes it when it exits or gets SIGTERM, SIGINT or SIGHUP. Before every run and every 6 hours it refreshes the lock's times, which a /tmp cleaner goes by, and puts the lock back if something removed it. A second daemon on the same directory does not start. A lock left by a daemon that died is taken over, and so is one written before the last reboot, since the lock names the boot as well as the pid and a pid from an earlier boot may belong to any process now; of two daemons that take over the same one at once, the one whose lock is gone half a second later stops (tests T18, T19 and T20).

**What it saves.** A turn sends only the hash, and gets back only the lines Claude Code appended: in the 5-prompt measurement above, each prompt after the first moved 18–33 KB in all, and the amount does not grow with the session. A new pi process continues from a fork of the last session (the bridge's row 6), so its first prompt downloads the whole new file.

## Code

The package `pi-claude-bridge-remote` (`remote/`, an npm workspace of the bridge, not published to npm; its only dependency is `ws`):

- `daemon.mjs` (`claude-remote-daemon`) runs on B. It handles the WebSocket server and its checks, request checks, Claude Code's command line and fixed environment, the stdin allowlist, stored sessions and their notes, blocking image saves, preparing and returning transcripts, the leak check and the relay.
- `spawner.mjs` is the `spawnClaudeCodeProcess` for A. It turns the SDK's command line into the four request fields, sends them with A's environment snapshot and the hash of A's copy (the copy itself when B asks), and stores the returned lines before emitting `exit`/`close`. A failure outside Claude Code becomes an `error` event that names the reason. It stores only the session file the run asked for.
- `env-block.mjs` computes the snapshot as Claude Code would, and builds the environment record from a copy of Claude Code's text.
- `protocol.mjs` has the subprotocol, the messages and channels, the request fields, keepalive, sending session files in fragments, `claudeArgs()` and Claude Code's project-directory naming.
- `test/`: `e2e-mock.mjs`, `mock-api.mjs`, `pi-e2e.sh`, `run-int-remote.sh`.

In the bridge, `src/`:

- `config.ts`: `provider.remote` (`url`, `token` or `tokenFile`), or `CLAUDE_BRIDGE_REMOTE=<url>` with `CLAUDE_BRIDGE_REMOTE_TOKEN`; and the provider settings remote mode drops.
- `query-process.ts`: takes an injected spawn function. It still waits for `close`, which a remote process emits after its transcript is stored.
- `index.ts`: creates the remote spawner from config and uses it for provider queries and summary queries. In remote mode it sets `verbatimPrompts`, caps tool results, and warns about the dropped settings.
- `remote-results.ts`: the 50,000-character cap.

## Validation details

B in every test is `bwrap --dev-bind / / --tmpfs <parent of A's checkout>`. Inside it, A's project path does not exist and B uses its own `CLAUDE_CONFIG_DIR`. A uses a separate `CLAUDE_CONFIG_DIR` as its transcript store. A and B are the same host, so the mock test pretends A is `darwin`/`zsh`/`Darwin 25.1.0` to show those fields come from A.

**`node remote/test/e2e-mock.mjs`** runs 83 checks with no usage:

- T0 the environment record the daemon builds is what Claude Code writes itself (snapshot, text and fields), in a plain directory, a git repository and a git worktree.

- T1 fresh turn: A's directory, git state, platform, shell and OS; none of B's directories in any request (spawn directory as a path or folder name, config directory, temporary directory); one block per request; transcript stored on A with A's snapshot and cwd; B keeps only that session, with its note.
- T2 resume with a tool call that ran on A: the result reached the model; no environment update; the prefix is unchanged; B ran its stored copy and returned only the appended lines; A's copy and B's file hold the same records.
- T3 fork: stored as a new session; the parent is untouched; the cut-off turn is dropped; B ran its copy of the parent and returned the new file whole.
- T4 the remote Claude Code's environment, read from `/proc/<pid>/environ`: none of A's variables (A set `TZ`, `LANG`, a sentinel and `DISABLE_AUTO_COMPACT=0`), B's fixed values present, and the daemon's token absent. Then abort while the API call is in flight: Claude Code was killed (exit 143) and every file B keeps has its note.
- T5 transcript imported by the bridge (no environment record yet).
- T6 the date is B's even when A's `TZ` puts A on another date.
- T7 isolated summary query.
- T8 `@path` (relative and absolute) never reads B's files and a slash command never runs B's custom command, even when A leaves out `verbatimPrompts`. With the daemon's marking removed, the same checks fail: both files were read and the command ran.
- T9 the daemon refuses spawn requests carrying `args`, `env`, `cwd` or any other unknown field, a model id with extra text, an unknown thinking level, a path as a session id, extra fields next to the snapshot, a resume without `have` or `have` without a resume, a `have` that is not a SHA-256 digest, and a first message that is not a spawn request.
- T10 a captured bridge command line (with a debug path) becomes the four values without the path; an extra SDK flag fails the query on A, with the flag named in the error the SDK reports, and never reaches B.
- T11 after a valid `initialize`, each of these ends the run, and the daemon's `exit` message names it: `bash_command`, `mcp_set_servers` with a stdio server, `update_environment_variables`, `read_file`, `set_cwd`, `keep_alive`, `initialize` with `plugins` or with `hooks`, a prompt with an `origin` field, and a permission answer that adds a directory to user settings. The `bash_command` and the MCP server would each have created a file on B; neither file exists. Through the SDK, a `setModel()` call while Claude Code waits for the API ends the run, and the error names the refused `set_model` request. T1–T8 cover what the bridge does send, including a tool call, an abort and a summary query.
- T12 stored sessions: after a run whose result A drops (A's file is put back), the next resume sends A's copy, and the lost turn's prompt reaches no request; the turn after that runs B's copy again. A session holding a marker stays in B's project directory while 4 later runs of another session go on, and the marker appears in none of their requests.
- T13 images: a prompt with a 3000×2000 image whose text makes the mock call a tool that returns another. Both images reach the model at 2000×1333; no request names B's directories or holds `[Image: source:`; the prompt image keeps Claude Code's resize note; B has no image file.
- T14 a transcript whose first record names a parent missing from the file: the model sees A's environment, and no request names B.
- T15 hooks in B's `settings.json`, a rule and a skill in B's config directory: no request, SDK message or returned transcript holds their text or name, and the hook did not run.
- T16 requests without the token, with a wrong token, with an `Origin` header, to another path and with another subprotocol get 401, 401, 403, 404 and 400 and never a WebSocket; plain requests get 401, or 426 with the token. JSON that does not parse, a `kill` asking for `SIGSTOP`, an unknown message type, an unknown channel, no spawn message within 10 seconds, stdin where the daemon asked for A's copy of a session, and a copy that stops after its first piece each end their connection with the reason and close code 4000; a frame announcing 2 GiB closes with 1009. Where none of the copy comes, the daemon gives up after a minute, and a side whose ping waits behind its own unsent bytes, toward a peer that stopped reading, drops that peer after a minute (both checked at the end of the run, so the other tests go on meanwhile). A TCP connection that sends nothing is closed after 10 seconds. The daemon then serves the next turn. A turn with a wrong token, and one to an address where no daemon listens, fail with an error that says so.
- T17 a fake B. It returns another session's file, then a relative path as the id: A stores neither and fails the run. It asks for A's copy twice, and in a run that resumes nothing: A sends the copy once and fails both runs. It ends a turn without a session file: A fails it. It asks for A's copy of an 8 MB session and pings at once: A's pong comes before the copy has, since the copy goes in pieces, and the copy arrives whole. After the run ends it sends output following a bad message, and a second `exit`: no error escapes, and the stored file keeps what came with the first `exit`.
- T18 A takes `ws://` to an address other than loopback, and B tries to listen on one (192.0.2.1, which this machine does not have, so the listen fails). The daemon refuses an option it does not know (the removed `--token`); every daemon in the test gets `--listen=…`, and one listens on `[::1]` (skipped without IPv6 loopback). A second daemon on the main daemon's spawn directory does not start.
- T19 a second daemon, with the token from `--token-file`, `--max-runs 1` and `--keepalive-seconds 1`, which starts over a lock on its spawn directory written before a reboot, whose pid another process has now: a second connection gets 503 while one session runs, and a client that stops reading, so answers no ping, is dropped within 2 seconds and its Claude Code stopped. Through a relay that passes 200 KB a second each way: an abort 1 second into A's copy of a 2.7 MB session leaves the daemon with a free slot 3 seconds later and nothing started, and A's copy of a 1.2 MB session, about 5 seconds on its way while A's answers to the daemon's pings wait behind a piece of it, keeps the connection and the turn completes. On the main daemon, a fork of a session holding 2 MB of text in a script of three bytes a character comes back whole.
- T20 on that daemon: after its spawn and temporary directories and its lock are deleted, as a /tmp cleaner would, the next run creates them again and succeeds. After the daemon's notes folder is removed, the next run still returns its session file. A run is refused once the spawn directory is writable by other users, with the reason in the error A reports, and a daemon whose spawn directory sits in a folder other users can write to does not start. A daemon that starts over the lock of a daemon that died takes it over. When its `claude` went away after it started, it fails the next run, and A reports `could not start Claude Code: spawn … ENOENT`; stopped with SIGINT, as Ctrl-C does, that daemon removes its lock.
- T21 nginx terminating TLS in front of the loopback daemon, with a certificate for 127.0.0.1 added to Node's trusted certificates: a turn runs through it, and the same proxy reached as `localhost` fails the hostname check, named in the error, and nothing runs. Skipped when nginx is not installed.
- T22 on the main daemon: a client holds a session's run; a second run of that session is refused while the first one's connection answers pings, and once that client stops reading, a third run replaces it within 15 seconds (about 5 here).
- T23 a daemon listening on a Unix socket in a directory only this user can enter: a turn runs over `ws+unix://`, and the socket has mode 600. After a daemon on the socket is killed, the next one takes over the socket it left; a third on the same path does not start while that one runs; stopped with SIGTERM, a daemon removes its socket.

After T15, two checks cover every run so far: the daemon reported no leak, and no request and no transcript kept on A names B's directories. With B's settings loaded or with a single seed per file, T14 and T15 fail. It passes on 2.1.308 (bundled with SDK 0.3.308) and on 2.1.317.

**`remote/test/pi-e2e.sh`** runs real pi with this checkout over three turns. The second turn has pi's bash tool run on A, and the third switches model, which makes the bridge rebuild the transcript. That covers the clean-start, fork and rebuild paths.

- **Mock API:** one environment block per request, all showing A, no B path. With a 3000×2000 PNG attached with `@` and pi's `read` of a 2500×1800 PNG on A, the model got both images at 2000 px with pi's notes, in turn 2 and again after the model switch, with no `[Image: source:` line, no B path and no image file left on B.
- **`REAL=1`, real API through `diag/capture-proxy.mjs`** (Claude Haiku 4.5, then Haiku 5.5 for the third turn):
  - Turn 1 answered "I'm working in `/home/yushijinhun/repos/pi-claude-bridge`, which is a git repository on Linux."
  - Turn 2 answered "Git top-level: `/home/yushijinhun/repos/pi-claude-bridge`, hostname: `yushijinhun-laptop`, and `package.json` exists in the working directory."
  - Cache: request 1 wrote 6,932 tokens; request 2, from a new pi process, read 6,932; request 3 read 7,087; request 4 was the new model, so a cold cache was expected.
  - Every request held one environment block naming A's directory and no B path. Spawn to exit took 1.1–3.0 s per turn.
- **Tool-result cap (mock API):** pi's bash returned 51,298 characters, its own truncation note included. The model got 49,814 characters inline: the start, the cap's note naming the file on A with the full text (`/tmp/pi-claude-bridge-<random>.txt`, mode 0600), and the end with pi's note. After the model switch, the rebuilt transcript carried the same capped result. Without the cap, Claude Code would have shown a path on B.

**`remote/test/run-int-remote.sh`** runs the bridge's integration tests in remote mode, on the real API with Claude Haiku 4.5:

- In one run, `int-session-compact`, `int-compact-splitturn`, `int-compact-midturn-rebuild`, `int-compact-second-compact`, `int-branch-summary` and `int-session-new` pass, and 6 of the 9 tests in `int-tool-message`: the tool call, the followUp, the three steer-during-tool tests and the steer during a text response. "Steer is drained at the tool boundary" timed out waiting for the agent to finish: after the steer told it to stop, the model called the tool 9 more times, which also happens without remote mode. The two tests after it failed because the agent was still busy, and pass when run alone.
- The 40 remote runs: 16 used B's stored copy, 4 received A's copy after a bridge rebuild or prefix-write, 9 started from a seed, and 11 were summaries. 15 returned only appended lines. No run reported a leak, and the daemon refused no stdin message.
- Not run: `int-session-resume` and `int-image-session` need an OpenRouter key, and the second test of `int-parallel-tool-results` drives a local Claude Code directly, without the bridge.

**Latency:** a fresh-session turn on one host against the mock API took a median of 229 ms through the daemon and 219 ms with a local Claude Code given the bridge's child environment (7 turns each).

## Limitations and risks

- **Undocumented Claude Code behavior.** The approach relies on four things:
  - the snapshot comparison in `QEn()`;
  - resume sending stored `rendered` text;
  - an attachment-only file resuming cleanly;
  - the snapshot and text in `env-block.mjs` matching the Claude Code on B.

  A Claude Code that computes its snapshot differently would announce B on every run; the leak check reports it, but after the model has seen it. A changed text alone only shows the model older wording. The daemon warns at start-up when Claude Code is not a tested version. Run `e2e-mock.mjs`, which costs no usage, whenever Claude Code on B or the pinned version changes.
- **Snapshot fields behind feature flags** (scratchpad directory, `gh` stand-in, agent proxy) are off with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. If one turns on, B's snapshot could differ per session. Claude Code would then announce B, and the leak check would report it.
- **B owns the command line.** A bridge or SDK change to the flags makes the spawner refuse remote runs until `claudeArgs()` is updated in the package, and the daemon's `--agent-sdk-version` has to follow the SDK the bridge pins.
- **The date is B's.** Near midnight, or with A and B in different time zones, the model's date can differ from A's local date.
- **Where Claude Code saves images.** The suppressed path line depends on the save locations of 2.1.308 (also checked on 2.1.317). If they move, the path line comes back. Nothing reports that at runtime, but T13 fails.
- **A tool-result image that Claude Code shrinks loses its note.** With the save blocked, Claude Code sends such an image without `original WxH, displayed at …`. pi's read tool shrinks images and adds the note itself, so this affects only tools that return images over 2000 px.
- **The stdin allowlist follows the bridge and the SDK.** A bridge feature or SDK update that sends a new message, control request or `initialize` field (for example `hooks`, `agents`, or an SDK that starts sending `keep_alive`) makes the daemon stop those runs until the list is extended. Answers to MCP elicitation and permission requests are refused too; the bridge's settings produce neither.
- **What the allowlist does not cover.** The content A is allowed to send still reaches the model and Claude Code: the system prompt, pi's tool definitions and results, and prompt text. Claude Code's own tools stay off (`--tools=`), so that content cannot make Claude Code act on B, but a token holder can still spend B's subscription, up to `--max-runs` sessions at a time.
- **No `@path` expansion in remote mode.** The model sees the path text and can read the file with pi's read tool. With `verbatimPrompts`, a fresh session's first request also lacked the `<total_tokens>` reminder. Expanding mentions on A would restore parity.
- **One connection per run.** Each turn opens a new WebSocket. Through a TLS reverse proxy to a distant B that adds about two round trips for TLS and the upgrade.
- **Transfer that remains.** A fork returns the whole new file, and a bridge rebuild or prefix-write uploads the whole file it wrote. For a prefix-write B already holds the kept part (the parent's lines up to the cut, with a new `sessionId`), so A could send only the cut point and the imported lines; that takes new request fields. Jumping back to an older branch does not reuse that branch's session; the bridge remembers only the latest one per pi session (TODO.md, idea 16).
- **Session files over about 512 MiB** do not work remotely: B reads a session file as one string, and Node's strings stop there.
- **B keeps transcripts.** Every session B ran stays on B's disk for up to `--keep-days` after its last use, in B's `~/.claude`. Remove `~/.claude/projects/<spawn directory>/` and `~/.claude/claude-remote/` on B to drop them.
- **B's settings are not used.** Claude Code on B needs everything beyond the OAuth login in the daemon's environment; an `apiKeyHelper` in B's `settings.json` has no effect.
- **What B still tells A outside the transcript.** Claude Code's startup message, which reaches A's SDK but not the model, names B's spawn directory and Claude Code version. stderr from Claude Code on B goes to the bridge's debug log.
- **Not yet done:**
  - AskClaude is not wired.
  - A dropped connection ends the query, and the bridge reports a failed turn. Its next turn replaces the old run on B within about 5 seconds when that run's connection no longer answers (see "A run that went quiet"); when B's copy has moved on, A sends its own.
  - Only a Linux B has been tested, never a separate physical machine. Keep B's Claude Code close to the SDK version on A (SDK 0.3.308 pairs with 2.1.308).

## How to run

The daemon runs from a checkout of this repository. On B, with `claude auth login` done and Node ≥ 20, in the checkout:

```sh
npm install --omit=dev --workspace remote    # the daemon's one dependency, ws
umask 077; head -c 32 /dev/urandom | base64 > ~/.config/claude-remote-token
./remote/daemon.mjs --token-file ~/.config/claude-remote-token --claude "$(command -v claude)" \
  --agent-sdk-version 0.3.308   # the Agent SDK version the bridge pins
```

The daemon listens on `ws://127.0.0.1:7878` unless `--listen` gives another address. On A, pi runs the bridge from this repository (a checkout after `npm install`, or `pi install git:github.com/yushijinhun/pi-claude-bridge@feat/remote-mode`, which clones that branch and runs `npm install`); that install links the package through the npm workspace. Put the same token in `~/.config/claude-remote-token`, forward the port and add the remote to `~/.pi/agent/claude-bridge.json`:

```sh
ssh -N -L 7878:127.0.0.1:7878 B &
```

When other users share A or B, use Unix sockets at both ends instead: give the daemon `--listen unix:$HOME/.claude-remote/daemon.sock`, run `mkdir -m 700 -p ~/.claude-remote` on A, forward with `ssh -N -o StreamLocalBindUnlink=yes -L ~/.claude-remote/b.sock:/home/you/.claude-remote/daemon.sock B &`, and use `ws+unix:///home/you/.claude-remote/b.sock` as the URL (see "Unix sockets" under "The connection").

```json
{ "provider": { "remote": { "url": "ws://127.0.0.1:7878", "tokenFile": "~/.config/claude-remote-token" } } }
```

Without a tunnel, put a TLS reverse proxy on B in front of the daemon and use its `wss://` URL. It must pass the `Upgrade`, `Connection` and `Authorization` headers and keep idle connections open for more than 20 seconds (nginx: `proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade`, `proxy_set_header Connection "upgrade"`, a long `proxy_read_timeout`). A checks the proxy's certificate as any Node TLS client does; for a private CA, start pi with `NODE_EXTRA_CA_CERTS`. On a network you trust, the daemon can also listen on one of B's addresses (`--listen 0.0.0.0:7878`), with `ws://B:7878` as the URL (see "Reaching B" under "The connection").

Daemon options take `--name value` or `--name=value`, and an unknown option stops the daemon; `--listen` takes `host:port`, an IPv6 host in brackets (`[::1]:7878`), or `unix:` and a socket's absolute path. Other daemon options: `--max-runs` (default 8), `--keepalive-seconds` (default 20, at most 30), `--path` (default `/`), `--keep-days` (default 30), and `--spawn-cwd` and `--tmp-dir` for the empty working directory and Claude Code's temporary directory (defaults under `/tmp/claude-remote-<uid>/`; created again before each run, and refused if another user could change them). One daemon at a time may use a spawn directory. The token can also come from `CLAUDE_REMOTE_TOKEN`. On A, `CLAUDE_BRIDGE_REMOTE` and `CLAUDE_BRIDGE_REMOTE_TOKEN` set the URL and token from the environment.

To run the tests, install the checkout's dependencies (`npm install` at the root; `remote/` is a workspace) and give the simulated B its own config dir. For the mock API an empty one and a dummy key are enough:

```sh
mkdir -m 700 /tmp/claude-b
export B_CLAUDE_CONFIG_DIR=/tmp/claude-b ANTHROPIC_API_KEY=sk-ant-dummy
```

The tests on the real API (`REAL=1`, the integration tests) need your login there, without the dummy key. Copy the login without the refresh token, as the SDK does for its own temporary config dirs, so the copy can never rotate your real token. The access token lasts a few hours:

```sh
unset ANTHROPIC_API_KEY
python3 -c 'import json,os; h=os.path.expanduser("~"); c=json.load(open(h+"/.claude/.credentials.json")); c["claudeAiOauth"].pop("refreshToken",None); g=json.load(open(h+"/.claude.json")); open("/tmp/claude-b/.credentials.json","w").write(json.dumps(c)); open("/tmp/claude-b/.claude.json","w").write(json.dumps({k:g[k] for k in ("oauthAccount","userID") if k in g}))'
```

Then:

- `node remote/test/e2e-mock.mjs`: no usage. It needs `bwrap`, and uses `nginx` and `openssl` if installed.
- `remote/test/pi-e2e.sh`, or with `REAL=1`. pi runs with its own agent directory in the test's work dir unless `PI_CODING_AGENT_DIR` is set.
- `remote/test/run-int-remote.sh tests/int-tool-message.mjs` (`BRIDGE_DIR` selects another checkout with dependencies).

`B_CLAUDE_CONFIG_DIR` must not live under the checkout's parent directory, which is hidden on B.

## Next steps

1. Let a prefix-write send only the cut point and the imported lines.
2. Report a dropped connection to the bridge so it can retry instead of failing the query.
3. Expand `@path` on A.
4. Wire AskClaude through the same spawner.
5. Run `e2e-mock.mjs` in CI against the pinned Claude Code, and on every pin bump.
