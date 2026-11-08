// Wire protocol between the bridge (machine A) and the daemon (machine B).
//
// One WebSocket per Claude Code process, with the subprotocol SUBPROTOCOL. The
// upgrade request carries `Authorization: Bearer <token>`; without the token B
// answers 401 and no WebSocket opens. Messages:
//
//   text, JSON control
//     A -> B   spawn       the first message: the request (REQUEST_KEYS)
//              stdin-end   Claude Code's stdin is closed
//              kill        { signal: "SIGTERM" | "SIGKILL" }
//     B -> A   need        B has no copy matching `have`: send it (once, for a resume)
//              spawned     { pid }
//              exit        { code, signal, files: { [id]: { from, length } },
//                          leaks, error? }; B then closes, and A ignores
//                          anything after it
//   binary, the first byte names the channel and the rest is its bytes
//     A -> B   0 stdin     3 transcript (A's copy of the session, only after need)
//     B -> A   1 stdout    2 stderr
//              4 file      what A lacks of the session file, right before exit
//                          (exit.files gives its id, length and offset)
//
// A sends stdin, stdin-end and kill only after spawned, so B holds nothing for
// a Claude Code that has not started; before spawned, A stops a run by
// dropping the connection.
//
// Session files, A's copy on channel 3 and B's on channel 4, go as bytes in
// fragments (sendChannel), so pings and pongs get through while they travel.
//
// Claude Code's stream-json protocol, including the SDK control channel that
// carries pi's MCP tool calls, rides on stdin and stdout. On the way in the
// daemon passes only the messages the bridge sends (daemon.mjs stdinRefusal).

import { createHash } from "node:crypto";

export const SUBPROTOCOL = "claude-remote.v1";
export const CHANNEL = { stdin: 0, stdout: 1, stderr: 2, transcript: 3, file: 4 };
// A message can hold A's copy of a long session.
export const MAX_MESSAGE_BYTES = 1024 ** 3;

/** A binary message for `channel`. */
export const channelMessage = (channel, bytes) => Buffer.concat([Buffer.from([channel]), typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes]);

// The longest a side waits on a silent peer while its own ping is stuck behind
// bytes it has queued. A live peer pings within it (A every 20 seconds, B at
// most every half of it); a peer that is gone leaves those bytes queued for
// good, and TCP takes about 15 minutes to give up on them.
export const BEHIND_LIMIT_MS = 60_000;

/** Ping the peer every `ms`, and drop the connection when nothing at all came
 *  from it for a whole interval: a dead peer or network otherwise goes
 *  unnoticed through a long tool call, and proxies close connections that stay
 *  quiet. Any bytes on `socket` count, so a long message on its way does too.
 *  An interval does not count against the peer while this side is not reading
 *  `socket`, or, up to BEHIND_LIMIT_MS (three intervals at least), when its
 *  ping had to wait behind bytes still queued here: the peer cannot answer a
 *  ping it has not received. Once a side starts closing, the closing handshake
 *  has its own timeout. `onSilent` runs before a silent connection is dropped,
 *  with the seconds since anything came. */
export function keepAlive(ws, socket, ms, onSilent) {
	const behindLimit = Math.max(3 * ms, BEHIND_LIMIT_MS);
	let heard = true;
	let heardAt = Date.now();
	let behind = false;
	let excused = 0;
	const hear = () => { heard = true; heardAt = Date.now(); };
	socket.on("data", hear);
	const timer = setInterval(() => {
		if (ws.readyState !== ws.OPEN) return;
		if (heard) {
			heard = false;
			excused = 0;
			behind = ws.bufferedAmount > 0;
			ws.ping();
		} else if (socket.isPaused() || (behind && (excused += ms) < behindLimit)) {
			behind = ws.bufferedAmount > 0;
		} else {
			onSilent?.(Math.round((Date.now() - heardAt) / 1000));
			ws.terminate();
		}
	}, ms);
	timer.unref();
	ws.on("close", () => {
		clearInterval(timer);
		socket.off("data", hear);
	});
}

// ws compresses a message whole before its first byte goes out, and holds
// pings and pongs until it has, so a large message sent at once leaves the
// connection silent that long (2 seconds for a 91 MB session file, 8 for
// 381 MB). Sent in fragments, each once the one before has left, it starts at
// once and lets pings and pongs through between fragments.
export const FRAGMENT_BYTES = 1024 * 1024;

const inFlight = new WeakSet();

/** Whether `ws` is in the middle of sendChannel: a message sent now would be
 *  taken for the next fragment. */
export const sending = (ws) => inFlight.has(ws);

/** Send `bytes` on `channel` as one binary message, in fragments; then call
 *  `done`, with an error if the connection went away first. Nothing else may
 *  be sent on `ws` until then (see `sending`). */
export function sendChannel(ws, channel, bytes, done) {
	inFlight.add(ws);
	const finish = (error) => {
		inFlight.delete(ws);
		done?.(error);
	};
	let offset = 0;
	const next = (error) => {
		if (error || ws.readyState !== ws.OPEN) return finish(error ?? new Error("the connection closed"));
		const first = offset === 0;
		const part = bytes.subarray(offset, offset + FRAGMENT_BYTES - (first ? 1 : 0));
		offset += part.length;
		const fin = offset >= bytes.length;
		ws.send(first ? channelMessage(channel, part) : part, { binary: true, fin }, fin ? finish : next);
	};
	next();
}

// The spawn request. B builds Claude Code's command line from `kind`, `model`,
// `thinking` and `session`; `a` carries A's environment snapshot for the
// environment block the model sees; `have` is the SHA-256 of A's copy of the
// session to resume, so B can run its own copy when it matches.
export const REQUEST_KEYS = new Set(["type", "kind", "model", "thinking", "session", "a", "have"]);
export const THINKING = new Set(["low", "medium", "high", "xhigh", "max", "off"]);
export const MODEL = /^claude-[a-z0-9-]+(\[1m\])?$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256 = /^[0-9a-f]{64}$/;

// The bridge's settings for each query type (src/index.ts).
const SETTINGS = {
	provider: { autoMemoryEnabled: false, claudeMdExcludes: ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"], includeGitInstructions: false, outputStyle: "default" },
	summary: { autoMemoryEnabled: false },
};

/**
 * Claude Code's command line for a bridge query, as Agent SDK 0.3.308 builds it
 * from the bridge's options (same flags, same order). `provider` is a pi turn;
 * `summary` is the bridge's isolated compaction/branch summary. `thinking` is
 * an effort level, "off", or undefined for Claude Code's default.
 */
export function claudeArgs({ kind, model, thinking, resume, forkAt, sessionId }) {
	const provider = kind === "provider";
	const args = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
	if (thinking === "off") args.push("--thinking=disabled");
	else if (thinking) args.push(`--effort=${thinking}`);
	if (!provider) args.push("--max-turns=1");
	args.push(`--model=${model}`);
	if (resume) args.push(`--resume=${resume}`);
	args.push("--tools=", provider ? "--setting-sources=user" : "--setting-sources=", "--strict-mcp-config");
	if (provider) args.push("--permission-mode=bypassPermissions", "--include-partial-messages");
	if (forkAt) args.push("--fork-session", `--resume-session-at=${forkAt}`);
	if (sessionId) args.push(`--session-id=${sessionId}`);
	if (!provider) args.push("--no-session-persistence");
	if (provider) {
		args.push("--replay-user-messages");
		if (thinking && thinking !== "off") args.push("--thinking-display", "summarized");
	}
	args.push("--settings", JSON.stringify(SETTINGS[kind]));
	return args;
}

/**
 * What B sets for Claude Code on top of the daemon's own environment: what a
 * local bridge child gets. `agentSdkVersion` is the Agent SDK the bridge pins;
 * `tmpDir` is Claude Code's temporary directory.
 */
export function claudeCodeEnv({ agentSdkVersion, tmpDir }) {
	return {
		// The bridge's CC_CHILD_ENV (src/cc-child.ts).
		ENABLE_CLAUDEAI_MCP_SERVERS: "0",
		DISABLE_AUTO_COMPACT: "1",
		CLAUDE_CODE_ELEGANT_MEADOW: "0",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		// Also keeps a seeded file, which ends at an attachment, from getting a
		// "No response requested." turn.
		CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
		CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
		CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "16384",
		// What Agent SDK 0.3.308 sets on every Claude Code it spawns. Claude Code
		// reports the SDK version in its User-Agent, and the SDK on A reads the
		// session_state_changed events the last one turns on to end a run.
		CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
		CLAUDE_AGENT_SDK_VERSION: agentSdkVersion,
		CLAUDE_CODE_SDK_READS_SESSION_STATE: "1",
		CLAUDE_CODE_TMPDIR: tmpDir,
	};
}

export const json = (data) => JSON.parse(typeof data === "string" ? data : data.toString("utf8"));

/** `--name=value` or `--name value`, the two shapes the Agent SDK emits. */
export function parseFlag(args, name) {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === name) return args[i + 1];
		if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
	}
	return undefined;
}

export function hasFlag(args, name) {
	return args.some((a) => a === name || a.startsWith(`${name}=`));
}

/** Remove a flag and, for the two-argument form, its value. */
export function dropFlag(args, name) {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === name) {
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("--")) i++;
			continue;
		}
		if (args[i].startsWith(`${name}=`)) continue;
		out.push(args[i]);
	}
	return out;
}

/** Claude Code's project directory name for a cwd (same rule as cc-session-io). */
export function projectDirName(realCwd) {
	const sanitized = realCwd.replace(/[^a-zA-Z0-9]/g, "-");
	if (sanitized.length <= 200) return sanitized;
	let h = 0;
	for (let i = 0; i < realCwd.length; i++) h = (h << 5) - h + realCwd.charCodeAt(i) | 0;
	return `${sanitized.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

export function parseJsonl(text) {
	const records = [];
	for (const line of text.split("\n")) if (line.trim()) records.push(JSON.parse(line));
	return records;
}

export const toJsonl = (records) => records.map((r) => JSON.stringify(r) + "\n").join("");

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
