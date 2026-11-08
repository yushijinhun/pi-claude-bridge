// Machine A side: a `spawnClaudeCodeProcess` for the Agent SDK that runs
// Claude Code through the daemon on machine B (daemon.mjs), over one
// WebSocket per process (protocol.mjs).
//
// The SDK keeps running here, so pi's tools (served over the SDK's in-process
// MCP server), hooks, steering and interrupts all travel inside Claude Code's
// stdio, which this relays once B reports that Claude Code runs (the SDK's
// first writes wait until then). The process it returns emits `exit`/`close`
// only after the session file Claude Code wrote on B has been stored back
// under A's CLAUDE_CONFIG_DIR, where the bridge's session sync reads it.
//
// When the run fails outside Claude Code (B cannot be reached or refuses the
// connection, the daemon stops the run, the connection drops, or the returned
// session file cannot be stored), the process reports it as Node reports a
// process that could not start: `error`, then `close` without `exit`. The SDK
// then shows the reason ("Failed to spawn Claude Code process: <reason>"). It
// adds stderr only to processes it starts itself, so after an `exit` it would
// show only the exit code.
//
// B keeps the session files it ran. A resume sends the SHA-256 of A's copy;
// B runs its own copy when that matches and asks for the file otherwise. B
// returns only what A lacks: the lines Claude Code appended, or the whole file
// for a new session.
//
// Neither the SDK's spawn environment (options.env) nor its command line is
// sent. B runs Claude Code with its own environment and builds the command
// line itself from four values read here (requestFromSdkArgs).
//
// What B sends back drives pi's tools (Claude Code's tool calls arrive on its
// stdout), so the connection must reach the real B: `ws://` to the daemon or
// to the near end of an `ssh -L` tunnel, `ws+unix://` to a socket, or `wss://`
// to a TLS reverse proxy in front of B's daemon, with Node's usual certificate
// checks. Any user here can listen on a loopback port the tunnel is not
// holding, and would get the token and drive pi's tools; a socket in a
// directory no other user can write to cannot be taken that way. B may only
// return the session file this run was asked to write.

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { CHANNEL, channelMessage, claudeArgs, dropFlag, hasFlag, json, keepAlive, MAX_MESSAGE_BYTES, parseFlag, projectDirName, sendChannel, sending, sha256, SUBPROTOCOL, UUID } from "./protocol.mjs";
import { localSnapshot } from "./env-block.mjs";

// A pings B as well, so a dead B is noticed during a long tool call.
const KEEPALIVE_MS = 20_000;

// What to check when the daemon, or the proxy in front of it, refuses the connection.
const REFUSAL_HINTS = {
	400: "; the daemon may run another version of pi-claude-bridge-remote",
	401: "; check the token",
	404: "; check the URL's path",
	502: "; is the daemon running behind the proxy?",
	503: "; it is running its maximum number of sessions (--max-runs)",
};

/**
 * @param {{ url: string, token: string, claudeDir?: string,
 *   snapshotOverride?: object, onLeak?: (leaks: object[]) => void }} config
 *   `url`: `ws://`, `wss://`, or `ws+unix://` and a socket's absolute path
 *   (`ws+unix:///home/you/.claude-remote/b.sock`).
 */
export function createRemoteSpawner(config) {
	let url;
	try { url = new URL(config.url); } catch { throw new Error(`claude-remote: ${config.url} is not a URL`); }
	if (url.protocol === "ws+unix:") {
		if (url.host || !url.pathname.startsWith("/")) throw new Error(`claude-remote: ${config.url} must give the socket's absolute path, as in ws+unix:///home/you/.claude-remote/b.sock`);
	} else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`claude-remote: ${config.url} must be ws://, wss:// or ws+unix://`);
	}
	return (options) => new RemoteClaudeProcess(options, config);
}

/**
 * The values B needs from the SDK's command line: query kind, model, thinking
 * and session. Throws when the command line holds anything B's rebuild would
 * not reproduce, so a bridge or SDK change fails here instead of being dropped.
 * The debug log path is A's and is left out.
 */
export function requestFromSdkArgs(sdkArgs) {
	const args = dropFlag(dropFlag(sdkArgs, "--debug-file"), "--debug");
	const kind = hasFlag(args, "--no-session-persistence") ? "summary" : "provider";
	const thinking = parseFlag(args, "--thinking") === "disabled" ? "off" : parseFlag(args, "--effort");
	const session = { resume: parseFlag(args, "--resume"), sessionId: parseFlag(args, "--session-id"), forkAt: parseFlag(args, "--resume-session-at") };
	const request = { kind, model: parseFlag(args, "--model"), ...(thinking ? { thinking } : {}), session };
	const rebuilt = claudeArgs({ ...request, ...session });
	const count = (list) => list.reduce((m, a) => m.set(a, (m.get(a) ?? 0) + 1), new Map());
	const want = count(rebuilt);
	const got = count(args);
	const extra = [...got].filter(([a, n]) => (want.get(a) ?? 0) < n).map(([a]) => a);
	const missing = [...want].filter(([a, n]) => (got.get(a) ?? 0) < n).map(([a]) => a);
	if (extra.length || missing.length) {
		throw new Error(`the remote daemon cannot run this Claude Code command line (unexpected: ${extra.join(" ") || "-"}; missing: ${missing.join(" ") || "-"})`);
	}
	return request;
}

/** Where A keeps a session file: Claude Code's layout, as cc-session-io computes it. */
function sessionPath(id, cwd, claudeDir) {
	let real = cwd;
	try { real = realpathSync(cwd); } catch {}
	const dir = claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(os.homedir(), ".claude");
	return join(dir, "projects", projectDirName(real.normalize("NFC")), `${id}.jsonl`);
}

class RemoteClaudeProcess extends EventEmitter {
	killed = false;
	exitCode = null;
	signalCode = null;
	pid = undefined;
	#connection = null;
	/** Whether Claude Code runs on B; what the SDK writes for it waits until then. */
	#spawned = false;
	#queue = [];
	#done = false;
	/** A's copy of the session being resumed, as hashed for the request. */
	#base = null;
	/** Whether B asked for #base; it may ask once. */
	#uploaded = false;
	/** What B sent of the session file (channel 4), stored when its exit comes. */
	#file = null;
	/** Reading from B waits for the SDK to catch up on Claude Code's output. */
	#held = false;

	constructor(options, config) {
		super();
		this.options = options;
		this.config = config;
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();
		this.stderr.resume(); // nobody may read it; listeners attached before data arrives still see it
		this.stdin = new Writable({
			write: (chunk, _enc, cb) => this.#send(channelMessage(CHANNEL.stdin, chunk), cb),
			final: (cb) => this.#send(JSON.stringify({ type: "stdin-end" }), cb),
		});
		options.signal?.addEventListener("abort", () => this.kill("SIGTERM"), { once: true });
		// The SDK wants the process object synchronously; connect after returning it.
		setImmediate(() => this.#start().catch((error) => this.#fail(error.message)));
	}

	/** Stdin bytes or a control message for Claude Code; held until it runs,
	 *  and while A's copy of the session is still on its way. */
	#send(data, cb) {
		if (this.#done) return cb?.();
		const ws = this.#connection;
		if (!this.#spawned || sending(ws)) { this.#queue.push(data); return cb?.(); }
		if (ws.readyState !== ws.OPEN) return cb?.();
		// A failed send ends the connection, and the close reports it.
		ws.send(data, () => cb?.());
	}

	/** Send what waited for Claude Code to run. */
	#flush() {
		if (this.#done || !this.#spawned || sending(this.#connection)) return;
		for (const queued of this.#queue.splice(0)) this.#connection.send(queued);
	}

	async #start() {
		if (this.#done) return;
		const { options, config } = this;
		const request = requestFromSdkArgs(options.args);
		if (request.session.resume) {
			const path = sessionPath(request.session.resume, options.cwd, config.claudeDir);
			if (!existsSync(path)) throw new Error(`no local transcript for --resume ${request.session.resume} at ${path}`);
			this.#base = { id: request.session.resume, bytes: readFileSync(path) };
		}
		const spawnMessage = {
			type: "spawn",
			...request,
			a: { snapshot: { ...localSnapshot(options.cwd), ...config.snapshotOverride } },
			...(this.#base ? { have: sha256(this.#base.bytes) } : {}),
		};
		// Loaded here, so the bridge loads it only when it runs Claude Code remotely.
		const { default: WebSocket } = await import("ws");
		if (this.#done) return;
		const ws = new WebSocket(config.url, SUBPROTOCOL, {
			headers: { Authorization: `Bearer ${config.token}` },
			maxPayload: MAX_MESSAGE_BYTES,
			perMessageDeflate: true,
			handshakeTimeout: 10_000,
		});
		this.#connection = ws;
		ws.on("unexpected-response", (req, res) => {
			req.destroy();
			this.#fail(`the remote daemon at ${config.url} refused the connection: ${res.statusCode} ${res.statusMessage}${REFUSAL_HINTS[res.statusCode] ?? ""}`);
		});
		let socket;
		let opened = false;
		ws.on("upgrade", (res) => { socket = res.socket; });
		ws.on("open", () => {
			opened = true;
			ws.send(JSON.stringify(spawnMessage));
			keepAlive(ws, socket, KEEPALIVE_MS, (seconds) => this.#fail(`the remote daemon at ${config.url} stopped answering: nothing came from it for ${seconds} seconds`));
		});
		ws.on("message", (data, isBinary) => {
			// After the run ends stdout and stderr are closed and the session file is
			// stored; a later message would write to ended streams, which throws
			// outside any handler and ends pi, or store the file again.
			if (this.#done) return;
			try { this.#message(data, isBinary, request); }
			catch (error) { this.#fail(`bad message from the remote daemon: ${error.message}`); }
		});
		ws.on("error", (error) => this.#fail(`${opened ? "lost the connection to" : "cannot reach"} the remote daemon at ${config.url} (${error.message})`));
		ws.on("close", (code, reason) => this.#fail(`the connection to the remote daemon closed before Claude Code exited (${code}${reason.length ? ` ${reason}` : ""})`));
	}

	#message(data, isBinary, request) {
		if (isBinary) {
			const bytes = data.subarray(1);
			if (data[0] === CHANNEL.stdout) this.#stdout(bytes);
			else if (data[0] === CHANNEL.stderr) this.stderr.write(bytes);
			else if (data[0] === CHANNEL.file && !this.#file) this.#file = bytes;
			else throw new Error(data[0] === CHANNEL.file ? "it sent a second session file" : `channel ${data[0]}`);
			return;
		}
		const m = json(data);
		if (m?.type === "need") this.#upload();
		else if (m?.type === "spawned") {
			this.pid = m.pid;
			this.#spawned = true;
			this.#flush();
			this.emit("spawn");
		}
		else if (m?.type === "exit") this.#exited(m, request);
		else throw new Error(`message type ${JSON.stringify(m?.type)}`);
	}

	// B asks for A's copy once, when it holds none matching `have`. Each answer
	// queues the whole file, so a B that kept asking would fill pi's memory.
	// Nothing else goes to B while it travels: what the SDK writes waits for
	// `spawned`, which B sends once it has the whole copy, and for the copy's
	// last fragment from a B that does not.
	#upload() {
		if (!this.#base) throw new Error("it asked for a session file, but this run resumes none");
		if (this.#uploaded) throw new Error("it asked for the session file twice");
		this.#uploaded = true;
		sendChannel(this.#connection, CHANNEL.transcript, this.#base.bytes, () => this.#flush());
	}

	// While the SDK is behind on Claude Code's output, stop reading from B; B
	// then holds Claude Code's output too.
	#stdout(bytes) {
		if (this.stdout.write(bytes) || this.#held) return;
		this.#held = true;
		this.#connection.pause();
		this.stdout.once("drain", () => { this.#held = false; this.#connection.resume(); });
	}

	#exited(exit, request) {
		const { resume, sessionId, forkAt } = request.session;
		// The one session this run writes. A query that names none lets Claude
		// Code pick the id, so then any single session id is taken.
		const target = request.kind !== "provider" ? null : forkAt ? sessionId : resume ?? sessionId;
		// The daemon names why it stopped the run.
		let failure = typeof exit.error === "string" ? `the remote daemon stopped the run: ${exit.error}` : undefined;
		let stored = 0;
		try {
			const files = Object.entries(exit.files ?? {});
			if (files.length > (request.kind === "provider" ? 1 : 0)) throw new Error(`it returned ${files.length} session files`);
			if (files.length !== (this.#file ? 1 : 0)) throw new Error("the session file it sent and its exit message do not match");
			for (const [id, { from, length }] of files) {
				if (!UUID.test(id) || (target !== undefined && id !== target)) throw new Error(`it returned session ${JSON.stringify(id).slice(0, 60)}, which this run did not ask for`);
				if (length !== this.#file.length) throw new Error(`it named ${length} bytes of ${id} and sent ${this.#file.length}`);
				// `from` is how much of A's copy B's file still starts with.
				if (from && (id !== this.#base?.id || from !== this.#base.bytes.length)) throw new Error(`it returned ${id} as a continuation of a copy this machine did not send`);
				const path = sessionPath(id, this.options.cwd, this.config.claudeDir);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(`${path}.tmp`, from ? Buffer.concat([this.#base.bytes, this.#file]) : this.#file, { mode: 0o600 });
				renameSync(`${path}.tmp`, path);
				stored++;
			}
		} catch (error) {
			// The bridge reads the transcript after the run; without it the run failed.
			failure ??= `could not store the session file the remote daemon returned: ${error.message}`;
		}
		// A turn that ended well always brings its session file back.
		if (request.kind === "provider" && !stored && exit.code === 0) failure ??= "the remote daemon returned no session file";
		if (Array.isArray(exit.leaks) && exit.leaks.length) this.config.onLeak?.(exit.leaks);
		if (failure) this.#fail(failure);
		else this.#finish(exit.code, exit.signal);
	}

	#fail(reason) {
		this.#finish(1, null, reason);
	}

	/** `failure` says why the run failed outside Claude Code (see the file
	 *  header). Only a listener gets `error`, as the SDK has one; without one,
	 *  stderr carries the reason. */
	#finish(code, signal, failure) {
		if (this.#done) return;
		this.#done = true;
		this.exitCode = code;
		this.signalCode = signal;
		if (failure) {
			this.stderr.write(`claude-remote: ${failure}\n`);
			if (this.listenerCount("error")) this.emit("error", new Error(failure));
		}
		this.stdout.end();
		this.stderr.end();
		const ws = this.#connection;
		if (ws && ws.readyState === ws.OPEN) ws.close(1000);
		else if (ws && ws.readyState === ws.CONNECTING) ws.terminate();
		if (!failure) this.emit("exit", code, signal);
		this.emit("close", code, signal);
	}

	kill(signal = "SIGTERM") {
		if (this.#done) return false;
		this.killed = true;
		if (this.#spawned) {
			this.#send(JSON.stringify({ type: "kill", signal }));
			return true;
		}
		// Nothing runs yet: the run ends as a process stopped by the signal. The
		// connection is dropped, bytes still queued for B included (A's copy of the
		// session, say), so B starts nothing.
		this.#connection?.terminate();
		this.#finish(null, signal);
		return true;
	}
}
