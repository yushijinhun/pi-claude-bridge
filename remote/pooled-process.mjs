import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { quotaInfo } from "./accounts.mjs";

const MAX_BUFFER = 32 * 1024 * 1024;
const encode = (m) => `${JSON.stringify(m)}\n`;
// Claude Code's own text for resuming an interrupted turn.
const CONTINUE_PROMPT = "Continue from where you left off.";

/** One logical stream-json process, with replaceable account workers. */
export class PooledProcess extends EventEmitter {
	constructor({ pool, model, sessionId, persistent, preferred, records, launch, checkpoint, log, onAccount }) {
		super();
		Object.assign(this, { pool, model, sessionId, persistent, preferred, launch, checkpoint, log, onAccount });
		this.pid = process.pid;
		this.exitCode = this.signalCode = null;
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();
		this.pending = new Map();
		this.seen = new Set(records.map((r) => r.uuid).filter(Boolean));
		this.complete = new Set(records.filter((r) => r.type === "assistant").map((r) => r.message?.id).filter((id) => typeof id === "string"));
		this.tools = new Set(records.filter((r) => r.type === "assistant").flatMap((r) => r.message?.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.id));
		this.controls = new Map();
		this.mcpCache = new Map();
		this.continuations = new Set();
		this.generation = 0;
		this.tail = [];
		this.buffered = 0;
		this.stdin = new Writable({
			write: (line, _encoding, done) => {
				try {
					this.input(JSON.parse(line.toString("utf8")));
					const stream = this.worker?.stdin;
					if (!stream?.writableNeedDrain) return done();
					const drained = () => { stream.off("drain", drained); stream.off("close", drained); done(); };
					stream.once("drain", drained); stream.once("close", drained);
				} catch (error) { done(); this.fail(error); }
			},
			final: (done) => { this.inputEnded = true; this.endWorkerInput(); done(); },
		});
		queueMicrotask(() => { this.emit("spawn"); this.choose(); });
	}

	input(m) {
		if (this.closed) return;
		if (m.type === "user") {
			m.uuid ??= randomUUID();
			this.pending.set(m.uuid, { message: m, sent: false });
			if (this.pending.size > 1024 || [...this.pending.values()].reduce((n, p) => n + Buffer.byteLength(encode(p.message)), 0) > MAX_BUFFER) throw new Error("too many queued prompt bytes");
			this.flushPrompts();
			return;
		}
		if (m.type === "control_request") {
			if (m.request.subtype === "initialize") {
				if (this.initialize) throw new Error("already initialized");
				this.initialize = m;
				this.initializeWorker();
			} else if (this.worker && !this.switching && !this.waitingForQuota) this.write(m);
			else {
				this.output({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
				this.terminal("", false, "interrupted");
				this.stopping = true;
				clearTimeout(this.timer);
				if (this.worker) this.stopWorker("SIGTERM");
				else this.finish(0, null);
			}
			return;
		}
		const route = this.controls.get(m.response.request_id);
		if (!route) return; // A late answer belongs to a discarded worker.
		this.controls.delete(m.response.request_id);
		const reply = structuredClone(m);
		reply.response.request_id = route.original;
		const rpc = reply.response.response?.mcp_response;
		if (rpc && route.rpcId !== undefined) rpc.id = route.rpcId;
		if (route.cacheKey && m.response.subtype === "success") this.mcpCache.set(route.cacheKey, structuredClone(reply.response.response));
		if (route.generation === this.generation && !this.switching) this.write(reply);
	}

	choose() {
		if (this.closed || this.stopping) return;
		try {
			let { account, until } = this.pool.select(this.model, this.preferred);
			this.waitingForQuota = !account;
			if (!account) {
				if (this.pool.exhausted === "error") return this.fail(new Error(`Claude quota exceeded: rate limit (retry-after-ms=${Math.max(0, Math.ceil(until - Date.now()))})`));
				if (this.generation) {
					// The client is already initialized. Re-read shared state while
					// waiting; another daemon may discover a later reset.
					this.timer = setTimeout(() => this.choose(), Math.max(1, Math.min(until - Date.now(), 1000)));
					return;
				}
				// Initialize even when every account is blocked, without sending
				// prompts. Otherwise the SDK's initialization deadline can expire
				// long before quota resets. The worker starts no turn until the
				// daemon sends it a prompt.
				account = this.pool.eligible(this.model).sort((a, b) => this.pool.blockedUntil(a, this.model) - this.pool.blockedUntil(b, this.model))[0];
			}
			this.account = account;
			this.generation++;
			this.resumeTurn = !!this.recover;
			this.switching = false;
			this.ready = false;
			this.rejected = null;
			this.startedAt = Date.now();
			this.adapter = this.launch(account, this.recover);
			account.active++;
			const child = this.worker = this.adapter.child;
			this.log(`worker pid=${child.pid ?? "-"} account=${account.id} session=${this.sessionId} recovery=${!!this.recover}`);
			const decoder = new StringDecoder("utf8");
			let buffered = "";
			child.stdout.on("data", (chunk) => {
				if (this.stopping) return;
				buffered += decoder.write(chunk);
				let end;
				try {
					while ((end = buffered.indexOf("\n")) >= 0) {
						const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
						if (line.trim()) this.message(JSON.parse(line));
					}
					if (Buffer.byteLength(buffered) > MAX_BUFFER) throw new Error("Claude output line is too large");
				} catch (error) { this.fail(error); }
			});
			child.stderr.on("data", (d) => { if (this.stopping || this.switching) return; if (!this.stderr.write(d)) { child.stderr.pause(); this.stderr.once("drain", () => child.stderr.resume()); } });
			child.stdin.on("error", () => {});
			child.on("error", (error) => this.fail(error));
			child.on("close", (code, signal) => {
				try {
					const last = buffered + decoder.end();
					if (last.trim() && !this.closed && !this.stopping && !this.switching) this.message(JSON.parse(last));
					this.workerClosed(code, signal);
				} catch (error) { this.fail(error); this.finish(1, null); }
			});
			this.initializeWorker();
		} catch (error) { this.fail(error); }
	}

	initializeWorker() {
		if (!this.worker || !this.initialize || this.initSent) return;
		this.initSent = true;
		const m = structuredClone(this.initialize);
		if (this.generation > 1) m.request_id = this.internalInit = randomUUID();
		this.write(m);
	}

	write(m) {
		if (this.worker && !this.worker.stdin.destroyed) this.worker.stdin.write(encode(m));
	}

	flushPrompts() {
		if (!this.ready || this.switching || !this.worker) return;
		clearTimeout(this.timer);
		if (this.waitingForQuota) {
			const { account, until } = this.pool.select(this.model, this.preferred);
			if (!account) {
				if (this.pool.exhausted === "error") return this.fail(new Error(`Claude quota exceeded: rate limit (retry-after-ms=${Math.max(0, Math.ceil(until - Date.now()))})`));
				this.timer = setTimeout(() => { try { this.flushPrompts(); } catch (error) { this.fail(error); } }, Math.max(1, Math.min(until - Date.now(), 1000)));
				return;
			}
			this.waitingForQuota = false;
			if (account !== this.account) { this.switching = true; this.stopWorker("SIGTERM"); return; }
		}
		if (this.resumeTurn) {
			// The replacement worker continues the interrupted turn. Claude Code's
			// own resume (CLAUDE_CODE_RESUME_INTERRUPTED_TURN) sends that request
			// before it registers the client's MCP servers, so it can go out with
			// no tools. A prompt sent after initialization waits for them.
			this.resumeTurn = false;
			const uuid = randomUUID();
			this.continuations.add(uuid);
			this.write({ type: "user", message: { role: "user", content: [{ type: "text", text: CONTINUE_PROMPT }] }, parent_tool_use_id: null, origin: { kind: "auto-continuation" }, uuid });
		}
		for (const item of this.pending.values()) if (!item.sent) { item.sent = true; this.write(item.message); }
		this.endWorkerInput();
	}

	endWorkerInput() {
		if (this.inputEnded && this.ready && this.worker && !this.switching && ![...this.pending.values()].some((p) => !p.sent)) this.worker.stdin.end();
	}

	message(m) {
		if (this.closed || this.stopping) return;
		if (this.switching) {
			if (m.type === "user") this.user(m);
			return;
		}
		if (m.type === "control_response") {
			if (m.response.request_id === (this.internalInit ?? this.initialize?.request_id)) {
				if (m.response.subtype !== "success") throw new Error(`Claude initialization failed: ${m.response.error}`);
				if (!this.internalInit) this.output(m);
				this.ready = true;
				this.flushPrompts();
			} else this.output(m);
			return;
		}
		if (m.type === "control_cancel_request") {
			const route = [...this.controls].find(([, r]) => r.original === m.request_id && r.generation === this.generation);
			if (route) { m.request_id = route[0]; this.controls.delete(route[0]); this.output(m); }
			return;
		}
		if (m.type === "control_request") {
			if (m.request?.message?.method === "tools/call") {
				if (this.draft) return this.hold(this.draft.frames, m);
				// A non-streaming response has no message_stop. Its completed
				// assistant records must reach the host before its MCP call.
				this.flush(this.tail); this.tail = [];
			}
			return this.control(m);
		}
		if (m.type === "rate_limit_event") {
			this.rejected = quotaInfo(m);
			return;
		}
		const failed = (m.type === "result" && m.is_error) || (m.type === "assistant" && m.message?.model === "<synthetic>" && m.api_error_status === 429);
		const info = (failed ? this.rejected : null) ?? quotaInfo(m, failed || m.subtype === "api_retry" ? this.adapter.read().filter((r) => Date.parse(r.timestamp) >= this.startedAt) : []);
		if (info) return this.switchAccount(info);
		if (m.type === "system" && m.subtype === "init") {
			if (this.initSeen) return;
			this.initSeen = true;
		}
		if (this.generation > 1 && m.type === "command_lifecycle") return;
		if (m.type === "user") return this.user(m);
		if (m.type === "stream_event") {
			if (m.event.type === "message_start") {
				this.discardDraft();
				this.draft = { id: m.event.message.id, frames: [], gated: false, duplicate: this.complete.has(m.event.message.id) };
			}
			if (this.draft) {
				if (this.draft.duplicate) {
					if (m.event.type === "message_stop") this.discardDraft();
					return;
				}
				if (m.event.type === "message_stop") {
					// Leave the client's partial stream open across a retry. The
					// next message_start replaces it using ordinary CC semantics.
					if (m.abandoned_blocks) { this.hold(this.draft.frames, m); this.abandoned = this.draft; this.draft = null; return; }
					this.complete.add(this.draft.id);
					this.flush(this.draft.frames);
					this.draft = null;
				} else {
					// A completed tool block can be dispatched before inference
					// finishes. Gate it and subsequent frames to preserve their
					// order, including normalized arguments before block_stop.
					if (m.event.type === "content_block_start" && m.event.content_block.type === "tool_use") this.draft.gated = true;
					if (this.draft.gated) return this.hold(this.draft.frames, m);
				}
			}
			return this.output(m);
		}
		if (m.type === "assistant") {
			if (this.seen.has(m.uuid) || this.draft?.duplicate || (!this.draft && this.complete.has(m.message?.id))) return;
			// A new API id without a message_start is CC's non-streaming
			// fallback. It replaces the abandoned stream in the same way.
			if (this.draft && m.message?.model !== "<synthetic>" && m.message?.id !== this.draft.id) this.discardDraft();
			// Keep uncommitted UUIDs out of the client's durable recording;
			// text and thinking deltas have already been streamed above.
			this.hold(this.draft?.frames ?? this.tail, m);
			return;
		}
		if (m.type === "result") {
			this.rejected = null;
			if (this.abandoned) { this.flush(this.abandoned.frames); this.abandoned = null; }
			if (this.draft) { this.flush(this.draft.frames); this.draft = null; }
			this.flush(this.tail); this.tail = [];
			const reported = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : [...this.pending].filter(([, p]) => p.sent).map(([id]) => id));
			const answered = [...new Set([...(this.recoveredUserIds ?? []), ...reported])].filter((id) => !this.continuations.has(id));
			if (this.recoveredUserIds?.size || reported.some((id) => this.continuations.has(id))) {
				m.user_message_uuids = answered;
				m.user_message_uuid = answered.at(-1);
			}
			this.recoveredUserIds = null;
			for (const id of answered) this.pending.delete(id);
			this.preferred = this.account.configDir;
			this.onAccount(this.preferred);
			if (m.result_index !== undefined) m.result_index = this.resultIndex = (this.resultIndex ?? -1) + 1;
		}
		this.output(m);
	}

	user(m) {
		if (this.seen.has(m.uuid)) return;
		if (Array.isArray(m.message?.content) && m.message.content.some((b) => b.type === "tool_result" && !this.tools.has(b.tool_use_id))) {
			if (!this.switching) this.hold(this.draft?.frames ?? this.abandoned?.frames ?? this.tail, m);
			return;
		}
		if (m.isReplay && !this.pending.has(m.uuid)) return;
		if (m.isMeta || m.message?.is_meta) return;
		this.seen.add(m.uuid);
		this.output(m);
	}

	control(m) {
		const request = m.request;
		const rpc = request?.subtype === "mcp_message" ? request.message : null;
		const toolId = rpc?.params?._meta?.["claudecode/toolUseId"];
		const cacheKey = rpc && (["initialize", "tools/list"].includes(rpc.method) ? `${request.server_name}:${rpc.method}` : toolId ? `tool:${toolId}` : null);
		const cached = cacheKey && this.mcpCache.get(cacheKey);
		if (cached) {
			const response = structuredClone(cached);
			if (response.mcp_response) response.mcp_response.id = rpc.id;
			return this.write({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
		}
		const original = m.request_id;
		m.request_id = `daemon-${this.generation}-${randomUUID()}`;
		const rpcId = rpc?.id;
		if (rpcId !== undefined) rpc.id = `daemon-${this.generation}-${randomUUID()}`;
		this.controls.set(m.request_id, { original, rpcId, generation: this.generation, cacheKey });
		this.output(m);
	}

	discardDraft() {
		for (const draft of [this.draft, this.abandoned]) if (draft) {
			for (const frame of draft.frames) this.buffered -= Buffer.byteLength(encode(frame));
		}
		this.draft = this.abandoned = null;
	}

	hold(frames, m) {
		this.buffered += Buffer.byteLength(encode(m));
		if (this.buffered > MAX_BUFFER) throw new Error("too many held Claude message bytes");
		frames.push(m);
	}

	flush(frames) {
		for (const m of frames) {
			this.buffered -= Buffer.byteLength(encode(m));
			if (m.type === "assistant" || m.type === "user") this.seen.add(m.uuid);
			if (m.type === "assistant") for (const b of m.message?.content ?? []) if (b.type === "tool_use") this.tools.add(b.id);
			if (m.type === "control_request") this.control(m);
			else this.output(m);
		}
	}

	output(m) {
		delete m.resume_reason;
		if (!this.stdout.write(encode(m)) && this.worker) {
			const child = this.worker;
			child.stdout.pause();
			this.stdout.once("drain", () => child.stdout.resume());
		}
	}

	switchAccount(info) {
		this.pool.reject(this.account, this.model, info);
		this.switching = true;
		this.draft = null; this.abandoned = null; this.tail = []; this.buffered = 0;
		this.stopWorker("SIGTERM");
	}

	workerClosed(code, signal) {
		clearTimeout(this.killTimer);
		this.account.active--;
		const records = this.adapter.read();
		if (this.switching || this.stopping) {
			const removed = new Map();
			const byUuid = new Map(records.filter((r) => r.uuid).map((r) => [r.uuid, r]));
			const uncommitted = (r) => r.type === "assistant" && !this.seen.has(r.uuid) && (r.message?.model === "<synthetic>" || !this.complete.has(r.message?.id));
			const abandonedTools = new Set(records.filter(uncommitted).flatMap((r) => r.message?.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.id));
			const committedAncestors = new Set();
			for (let r of records.filter((r) => (r.type === "assistant" && this.complete.has(r.message?.id)) || (r.type === "user" && Array.isArray(r.message?.content) && r.message.content.some((b) => b.type === "tool_result" && !abandonedTools.has(b.tool_use_id))))) {
				while (r && !committedAncestors.has(r.uuid)) { committedAncestors.add(r.uuid); r = byUuid.get(r.parentUuid); }
			}
			const safe = records.filter((r) => {
				const unfinishedRescue = r.type === "user" && (this.continuations.has(r.uuid) || (r.isMeta && r.promptSource === "system")) && !committedAncestors.has(r.uuid);
				if (r.type === "user" && Array.isArray(r.message?.content)) r.message.content = r.message.content.filter((b) => b.type !== "tool_result" || !abandonedTools.has(b.tool_use_id));
				const empty = r.type === "user" && Array.isArray(r.message?.content) && !r.message.content.length;
				const keep = !["queue-operation", "last-prompt"].includes(r.type) && !unfinishedRescue && !empty && !(r.type === "system" && r.subtype === "api_error") && !uncommitted(r);
				if (!keep && r.uuid) removed.set(r.uuid, r.parentUuid);
				return keep;
			});
			for (const r of safe) {
				const visited = new Set();
				while (removed.has(r.parentUuid) && !visited.has(r.parentUuid)) { visited.add(r.parentUuid); r.parentUuid = removed.get(r.parentUuid); }
			}
			this.checkpoint(safe);
			const consumed = new Set(safe.flatMap((r) => [r.type === "user" ? r.uuid : undefined, r.attachment?.source_uuid]).filter(Boolean));
			this.recoveredUserIds = new Set([...this.pending.keys()].filter((id) => consumed.has(id)));
			for (const [id, p] of this.pending) p.sent = this.persistent && consumed.has(id);
			this.recover = this.persistent && [...this.pending].some(([id]) => consumed.has(id));
		} else this.checkpoint(records);
		this.adapter.cleanup();
		this.worker = null;
		this.initSent = false;
		this.internalInit = null;
		this.ready = false;
		this.controls.clear();
		if (this.switching && !this.stopping) this.choose();
		else this.finish(code, signal);
	}

	terminal(text, error, reason) {
		this.output({ type: "result", subtype: "success", is_error: error, result: text, duration_ms: 0, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: {}, permission_denials: [], stop_reason: null, terminal_reason: reason, uuid: randomUUID(), session_id: this.sessionId });
		this.output({ type: "system", subtype: "session_state_changed", state: "idle", sdk_host_only: true, uuid: randomUUID(), session_id: this.sessionId });
	}

	stopWorker(signal) {
		if (!this.worker) return;
		const child = this.worker;
		child.stdout.resume(); child.stderr.resume();
		child.kill(signal);
		if (signal !== "SIGKILL") this.killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000);
	}

	kill(signal = "SIGTERM") {
		if (this.closed) return false;
		this.stopping = true;
		clearTimeout(this.timer);
		if (this.worker) this.stopWorker(signal);
		else this.finish(null, signal);
		return true;
	}

	fail(error) {
		if (this.closed) return;
		this.poolError = error.message;
		this.emit("error", error);
		if (this.worker) this.kill("SIGTERM");
		else this.finish(1, null);
	}

	finish(code, signal) {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.timer); clearTimeout(this.killTimer);
		this.exitCode = code; this.signalCode = signal;
		this.stdout.end(); this.stderr.end();
		this.emit("exit", code, signal);
		this.emit("close", code, signal);
	}
}
