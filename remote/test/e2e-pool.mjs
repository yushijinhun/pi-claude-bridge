// Real Claude Code + Agent SDK + unchanged remote client against a local API.
// No subscription traffic or credentials are used. Run: node --test remote/test/e2e-pool.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { getSessionPath } from "cc-session-io";
import { createRemoteSpawner } from "../spawner.mjs";
import { AccountPool } from "../accounts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const binary = process.env.CLAUDE_BIN ?? join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "..", "claude-agent-sdk-linux-x64", "claude");
const model = "claude-haiku-4-5";
const parse = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const resultText = (body) => body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === "tool_result");
const toolNames = (call) => (call.body.tools ?? []).map((t) => t.name).sort();

async function success(res, body, blocks = [{ type: "text", text: "OK" }], { partial = false, headers = {}, afterDelta } = {}) {
	if (!body.stream) {
		res.writeHead(200, { "content-type": "application/json", ...headers });
		return res.end(JSON.stringify({ id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", content: blocks, model: body.model, stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 } }));
	}
	const send = (m) => res.write(`event: ${m.type}\ndata: ${JSON.stringify(m)}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream", ...headers });
	send({ type: "message_start", message: { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
	for (const [index, b] of blocks.entries()) {
		send({ type: "content_block_start", index, content_block: b.type === "tool_use" ? { ...b, input: {} } : b.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" } });
		if (b.type === "thinking") {
			send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } });
			send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
		} else send({ type: "content_block_delta", index, delta: b.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(b.input) } : { type: "text_delta", text: b.text } });
		if (afterDelta) await afterDelta(b);
		send({ type: "content_block_stop", index });
	}
	if (partial) send({ type: "error", error: { type: "rate_limit_error", message: "usage limit" } });
	else {
		send({ type: "message_delta", delta: { stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
		send({ type: "message_stop" });
	}
	res.end();
}
function quota(res, seconds = 60, type = "five_hour") {
	res.writeHead(429, { "content-type": "application/json", "retry-after": "0", "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + seconds), "anthropic-ratelimit-unified-representative-claim": type });
	res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Your usage limit has been reached" } }));
}
async function fixture(reply, config = {}) {
	const dir = mkdtempSync(join(tmpdir(), "remote-pool-test-"));
	const accounts = ["first", "second"].map((id) => {
		const configDir = join(dir, id); mkdirSync(configDir, { mode: 0o700 });
		writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat01-${id}`, refreshToken: "dummy", expiresAt: Date.now() + 86400_000, scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } }), { mode: 0o600 });
		// Two logins of one person in one organization, as Claude Code reads them.
		writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: crypto.randomUUID(), emailAddress: `${id}@example.com`, organizationUuid: "00000000-0000-4000-8000-000000000001", organizationRole: "user", billingType: "stripe_subscription" } }), { mode: 0o600 });
		return { id, configDir };
	});
	const accountsFile = join(dir, "accounts.json");
	writeFileSync(accountsFile, JSON.stringify({ accounts, ...config }));
	const calls = [], daemons = [], children = [], apiErrors = [], pools = [];
	const started = new EventEmitter();
	const api = createServer(async (req, res) => {
		try {
			let raw = ""; for await (const c of req) raw += c;
			if (!/^\/v1\/messages(\?|$)/.test(req.url)) return res.writeHead(404).end();
			const body = JSON.parse(raw), account = String(req.headers.authorization).split("-").at(-1);
			const call = { body, account }; calls.push(call);
			await reply({ res, body, account, calls, call });
		} catch (error) { apiErrors.push(error); res.destroy(); }
	});
	await new Promise((r) => api.listen(0, "127.0.0.1", r));
	let log = "";
	async function daemon() {
		const index = daemons.length;
		const socket = join(dir, `daemon-${index}.sock`);
		const proc = spawn(process.execPath, [resolve(here, "../daemon.mjs"), "--listen", `unix:${socket}`, "--claude", binary, "--spawn-cwd", join(dir, `cwd-${index}`), "--tmp-dir", join(dir, `tmp-${index}`), "--accounts-file", accountsFile], {
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, CLAUDE_REMOTE_TOKEN: "test", CLAUDE_CONFIG_DIR: join(dir, "daemon-config"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1", ANTHROPIC_API_KEY: "must-be-removed", CLAUDE_CODE_OAUTH_TOKEN: "must-be-removed" },
		});
		daemons.push(proc);
		console.log(`Waiting for daemon PID ${proc.pid} to listen`);
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`daemon startup timeout: ${log}`)); }, 15000);
			proc.stderr.on("data", (d) => { log += d; appendFileSync(join(dir, "daemon.log"), d); if (process.env.E2E_VERBOSE) process.stderr.write(d); if (String(d).includes("listening on")) { clearTimeout(timer); resolve(); } });
			proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`daemon exited ${code}: ${log}`)); });
		});
		return createRemoteSpawner({ url: `ws+unix://${socket}`, token: "test", claudeDir: join(dir, "client-config") });
	}
	const spawner = await daemon();
	let toolCalls = 0, onEffect = async () => {};
	const server = () => createSdkMcpServer({ name: "custom-tools", tools: [tool("effect", "Perform an effect", {}, async () => { toolCalls++; await onEffect(); return { content: [{ type: "text", text: "EFFECT DONE" }] }; })] });
	const frames = [];
	async function run(prompt, extra = {}, via = spawner) {
		const messages = [];
		const q = query({ prompt, options: {
			cwd: dir, model, tools: [], permissionMode: "bypassPermissions", strictMcpConfig: true, settingSources: ["user"], includePartialMessages: true,
			settings: { autoMemoryEnabled: false, claudeMdExcludes: ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"], includeGitInstructions: false, outputStyle: "default" },
			mcpServers: { "custom-tools": server() }, extraArgs: { "replay-user-messages": null },
			spawnClaudeCodeProcess: (options) => {
				const child = via(options); children.push(child);
				child.spawnCount = 0; child.on("spawn", () => { child.spawnCount++; started.emit("spawn", child); });
				let buffered = "";
				child.stdout.on("data", (d) => { buffered += d; let end; while ((end = buffered.indexOf("\n")) >= 0) { const s = buffered.slice(0, end); buffered = buffered.slice(end + 1); if (s.trim()) { const frame = JSON.parse(s); frames.push(frame); started.emit("frame", frame); } } });
				return child;
			}, ...extra,
		} });
		const timer = setTimeout(() => q.close(), 15000);
		try { for await (const m of q) messages.push(m); if (apiErrors.length) throw apiErrors[0]; }
		catch (error) { error = apiErrors[0] ?? error; error.message += `\nDaemon log:\n${log}\nLast frames:\n${JSON.stringify(frames.slice(-5))}`; throw error; }
		finally { clearTimeout(timer); }
		return { messages, result: messages.findLast((m) => m.type === "result"), session: messages.find((m) => m.type === "system" && m.subtype === "init")?.session_id };
	}
	function nextFrame(predicate) {
		const found = frames.find(predicate);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { started.off("frame", receive); reject(new Error("client did not receive the expected frame within five seconds")); }, 5000);
			function receive(frame) { if (predicate(frame)) { clearTimeout(timer); started.off("frame", receive); resolve(frame); } }
			started.on("frame", receive);
		});
	}
	function pool() {
		const p = new AccountPool(accountsFile, (path) => { mkdirSync(path, { recursive: true }); return path; });
		pools.push(p);
		return p;
	}
	return { dir, accounts, accountsFile, calls, frames, children, daemon, run, nextFrame, pool, nextSpawn: () => once(started, "spawn"), set onEffect(fn) { onEffect = fn; }, get toolCalls() { return toolCalls; }, get log() { return log; },
		file: (id) => getSessionPath(id, dir, join(dir, "client-config")),
		async close() {
			for (const p of pools) p.close();
			for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			for (const proc of daemons) if (proc.exitCode === null && proc.signalCode === null) {
				console.log(`Waiting for daemon PID ${proc.pid} to exit after SIGTERM`);
				const exited = once(proc, "exit"); proc.kill("SIGTERM"); await exited;
			}
			api.closeAllConnections(); await new Promise((r) => api.close(r));
			if (!process.env.E2E_KEEP) rmSync(dir, { recursive: true, force: true });
		},
	};
}
function transparent(f, run) {
	assert.equal(run.result?.is_error, false, JSON.stringify(run.result) ?? "no result");
	assert.equal(run.messages.filter((m) => m.type === "result").length, 1);
	assert.equal(run.messages.filter((m) => m.type === "system" && m.subtype === "init").length, 1);
	assert.equal(f.children.at(-1).spawnCount, 1);
	assert.ok(!JSON.stringify(f.frames).includes("<synthetic>"));
	assert.ok(!f.frames.some((m) => m.type === "rate_limit_event"));
	assert.ok(!f.frames.some((m) => m.resume_reason));
	const records = parse(f.file(run.session));
	const uuids = new Set(records.flatMap((r) => [r.uuid, r.attachment?.source_uuid]).filter(Boolean));
	for (const m of run.messages) if (["assistant", "user"].includes(m.type)) assert.ok(uuids.has(m.uuid), `missing forwarded UUID ${m.uuid}`);
	assert.ok(!records.some((r) => r.message?.model === "<synthetic>"));
	assert.ok(records.filter((r) => r.cwd).every((r) => r.cwd === f.dir));
	// A replacement worker offers the client's tools and keeps the session's
	// account context.
	for (const call of f.calls) assert.deepEqual(toolNames(call), toolNames(f.calls[0]), `request ${f.calls.indexOf(call)} on ${call.account}`);
	assert.ok(!f.calls.some((c) => JSON.stringify(c.body.messages).includes("was re-read")), "Claude Code announced a changed session context");
}

test("quota before inference: one logical process, sticky resume, shared limits across daemons", { timeout: 60000 }, async () => {
	const f = await fixture(({ res, body, account }) => account === "first" ? quota(res) : success(res, body), { scheduling: "sticky" });
	try {
		const first = await f.run("FIRST REQUEST"); transparent(f, first);
		const original = parse(f.file(first.session));
		const cut = original.findLast((r) => r.type === "assistant").uuid;
		assert.deepEqual(f.calls.map((c) => c.account), ["first", "second"]);
		const second = await f.run("RESUMED REQUEST", { resume: first.session }); transparent(f, second);
		assert.equal(second.session, first.session);
		const otherDaemon = await f.daemon();
		const third = await f.run("OTHER DAEMON", {}, otherDaemon); transparent(f, third);
		assert.deepEqual(f.calls.map((c) => c.account), ["first", "second", "second", "second"]);
		const ancestor = readFileSync(f.file(first.session), "utf8");
		const fork = await f.run("FORK REQUEST", { resume: first.session, forkSession: true, resumeSessionAt: cut, sessionId: crypto.randomUUID() }); transparent(f, fork);
		assert.notEqual(fork.session, first.session);
		assert.equal(readFileSync(f.file(first.session), "utf8"), ancestor);
		assert.ok(parse(f.file(fork.session)).some((r) => r.uuid === cut));
		const [local, remote] = await Promise.all([f.run("CONCURRENT LOCAL CLIENT"), f.run("CONCURRENT REMOTE CLIENT", {}, otherDaemon)]);
		transparent(f, local); transparent(f, remote);
		assert.notEqual(local.session, remote.session);
		assert.ok(!readFileSync(f.file(local.session), "utf8").includes("CONCURRENT REMOTE CLIENT"));
		assert.ok(!readFileSync(f.file(remote.session), "utf8").includes("CONCURRENT LOCAL CLIENT"));
	} finally { await f.close(); }
});

test("quota after a signed thinking/tool response resumes without repeating the tool", { timeout: 60000 }, async () => {
	const f = await fixture(({ res, body, account }) => {
		if (!resultText(body).length) success(res, body, [{ type: "thinking", thinking: "Plan an effect", signature: "opaque-signature-to-preserve" }, { type: "tool_use", id: "toolu_effect", name: "mcp__custom-tools__effect", input: {} }]);
		else if (account === "first") quota(res);
		else success(res, body);
	});
	try {
		const run = await f.run("DO ONE EFFECT"); transparent(f, run);
		assert.equal(f.toolCalls, 1);
		assert.deepEqual(f.calls.map((c) => c.account), ["first", "first", "second"]);
		assert.equal(run.messages.filter((m) => m.type === "assistant").flatMap((m) => m.message.content).filter((b) => b.type === "tool_use").length, 1);
		const recovered = f.calls.at(-1).body;
		assert.ok(JSON.stringify(recovered.messages).includes("EFFECT DONE"));
		assert.ok(JSON.stringify(recovered.messages).includes("opaque-signature-to-preserve"));
		assert.ok(toolNames(f.calls.at(-1)).includes("mcp__custom-tools__effect"));
		assert.equal(JSON.stringify(recovered.messages).split("Continue from where you left off.").length, 2);
		assert.ok(JSON.stringify(recovered.messages).includes("first@example.com"));
		assert.ok(!JSON.stringify(recovered.messages).includes("second@example.com"));
	} finally { await f.close(); }
});

test("all accounts drained: wait inside the daemon, then continue on reset", { timeout: 60000 }, async () => {
	const rejected = new Set();
	const f = await fixture(({ res, body, account }) => {
		if (!rejected.has(account)) { rejected.add(account); quota(res, 1); }
		else success(res, body);
	}, { exhausted: "wait" });
	try {
		const run = await f.run("WAIT FOR RESET"); transparent(f, run);
		assert.equal(rejected.size, 2);
		assert.equal(f.calls.length, 3);
	} finally { await f.close(); }
});


test("text and thinking reach the client before the API finishes each block", { timeout: 30000 }, async () => {
 const f = await fixture(({ res, body }) => success(res, body, [
  { type: "thinking", thinking: "THINKING IN PROGRESS", signature: "opaque-streaming-signature" },
  { type: "text", text: "TEXT IN PROGRESS" },
 ], { afterDelta: async (block) => {
  await f.nextFrame((m) => m.type === "stream_event" && m.event.type === "content_block_delta" && (block.type === "thinking" ? m.event.delta.thinking === block.thinking : m.event.delta.text === block.text));
  assert.equal(res.writableEnded, false);
  assert.ok(!f.frames.some((m) => m.type === "stream_event" && m.event.type === "message_stop"));
 } }));
 try {
  const run = await f.run("STREAM BEFORE COMPLETION"); transparent(f, run);
  assert.equal(f.calls.length, 1);
 } finally { await f.close(); }
});

test("an interrupted text stream is replaced when switching accounts", { timeout: 30000 }, async () => {
 let partial = false;
 const f = await fixture(({ res, body, account }) => {
  if (account === "second") return success(res, body);
  if (!partial) { partial = true; return success(res, body, [{ type: "text", text: "DISCARDED PARTIAL" }], { partial: true, headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 60), "anthropic-ratelimit-unified-representative-claim": "five_hour" } }); }
  quota(res);
 });
 try {
  const run = await f.run("RECOVER PARTIAL"); transparent(f, run);
  assert.ok(f.frames.some((m) => m.type === "stream_event" && m.event.delta?.text === "DISCARDED PARTIAL"));
  const firstStart = f.frames.findIndex((m) => m.type === "stream_event" && m.event.type === "message_start");
  const nextStart = f.frames.findIndex((m, i) => i > firstStart && m.type === "stream_event" && m.event.type === "message_start");
  assert.ok(nextStart > firstStart);
  assert.ok(!f.frames.slice(firstStart, nextStart).some((m) => m.type === "stream_event" && m.event.type === "message_stop"));
  assert.ok(!readFileSync(f.file(run.session), "utf8").includes("DISCARDED PARTIAL"));
  assert.equal(f.calls.at(-1).account, "second");
 } finally { await f.close(); }
});

test("a tool in an abandoned response never executes", { timeout: 30000 }, async () => {
 const f = await fixture(({ res, body, account }) => {
  if (account === "first") return success(res, body, [{ type: "tool_use", id: "toolu_discarded", name: "mcp__custom-tools__effect", input: {} }], { partial: true });
  if (!resultText(body).length) return success(res, body, [{ type: "tool_use", id: "toolu_recovered", name: "mcp__custom-tools__effect", input: {} }]);
  success(res, body);
 });
 try {
  const run = await f.run("RECOVER ABANDONED TOOL"); transparent(f, run);
  assert.equal(f.toolCalls, 1);
  assert.ok(!JSON.stringify(f.frames).includes("toolu_discarded"));
  assert.ok(!readFileSync(f.file(run.session), "utf8").includes("toolu_discarded"));
 } finally { await f.close(); }
});

test("a non-streaming fallback still delivers its tool call", { timeout: 30000 }, async () => {
 let interrupted = false;
 const f = await fixture(({ res, body }) => {
  if (!interrupted) {
   interrupted = true;
   return success(res, body, [{ type: "text", text: "STREAM BEFORE FALLBACK" }], { afterDelta: () => { res.write('event: content_block_delta\ndata: {"invalid":\n\n'); } });
  }
  if (!resultText(body).length) return success(res, body, [{ type: "tool_use", id: "toolu_fallback", name: "mcp__custom-tools__effect", input: {} }]);
  return success(res, body);
 });
 try {
  const run = await f.run("RECOVER WITHOUT STREAMING"); transparent(f, run);
  assert.equal(f.toolCalls, 1);
  assert.ok(f.calls.some((c) => !c.body.stream), JSON.stringify(f.calls.map((c) => ({ account: c.account, stream: c.body.stream }))));
  assert.ok(f.calls.every((c) => c.account === "first"));
 } finally { await f.close(); }
});

test("summary retries without persisting a session", { timeout: 30000 }, async () => {
 const f = await fixture(({ res, body, account }) => account === "first" ? quota(res) : success(res, body));
 try {
  const run = await f.run("SUMMARIZE THIS", {
   settings: { autoMemoryEnabled: false }, permissionMode: undefined, includePartialMessages: false,
   settingSources: [], skills: [], persistSession: false, systemPrompt: "You are a summarizer.",
   mcpServers: undefined, extraArgs: undefined, maxTurns: 1,
  });
  assert.equal(run.result?.is_error, false);
  assert.equal(run.messages.filter((m) => m.type === "result").length, 1);
  assert.deepEqual(f.calls.map((c) => c.account), ["first", "second"]);
  assert.ok(!existsSync(f.file(run.session)));
  assert.ok(!JSON.stringify(f.frames).includes("<synthetic>"));
 } finally { await f.close(); }
});

test("a fresh query initializes while blocked, then uses the first available account", { timeout: 30000 }, async () => {
 const f = await fixture(({ res, body }) => success(res, body), { exhausted: "wait" });
 try {
  const pool = f.pool();
  for (const account of pool.accounts) pool.reject(account, model, { resetsAt: Math.floor(Date.now() / 1000) + 2 });
  const run = f.run("WAIT BEFORE THE FIRST REQUEST");
  run.catch(() => {});
  await f.nextFrame((m) => m.type === "control_response" && m.response.subtype === "success");
  assert.equal(f.calls.length, 0);
  // Another daemon discovers a longer window for the initialized account.
  pool.reject(pool.accounts[0], model, { resetsAt: Math.floor(Date.now() / 1000) + 60 });
  const result = await run; transparent(f, result);
  assert.deepEqual(f.calls.map((c) => c.account), ["second"]);
 } finally { await f.close(); }
});

test("initialization and cancellation work while every account is cooling down", { timeout: 30000 }, async () => {
 const f = await fixture(() => assert.fail("a blocked account reached the API"), { exhausted: "wait" });
 try {
  const pool = f.pool();
  for (const account of pool.accounts) pool.reject(account, model, { resetsAt: Date.now() / 1000 + 60 });
  const abortController = new AbortController();
  const spawned = f.nextSpawn();
  const run = f.run("CANCEL THIS WAIT", { abortController });
  run.catch(() => {});
  const [child] = await spawned;
  await f.nextFrame((m) => m.type === "control_response" && m.response.subtype === "success");
  assert.equal(f.calls.length, 0);
  const closed = once(child, "close");
  console.log(`Waiting for logical PID ${child.pid} to close after cancellation`);
  abortController.abort();
  await Promise.allSettled([run, closed]);
  assert.equal(f.calls.length, 0);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
 } finally { await f.close(); }
});

test("steering absorbed at a tool boundary survives a quota switch once", { timeout: 30000 }, async () => {
 const f = await fixture(({ res, body, account }) => {
  if (!resultText(body).length) return success(res, body, [{ type: "tool_use", id: "toolu_steer", name: "mcp__custom-tools__effect", input: {} }]);
  if (account === "first") return quota(res);
  success(res, body);
 });
 let reachedTool, wroteSteer;
 const atTool = new Promise((resolve) => { reachedTool = resolve; });
 const submitted = new Promise((resolve) => { wroteSteer = resolve; });
 const steer = crypto.randomUUID();
 f.onEffect = async () => { reachedTool(); await submitted; };
 async function* prompts() {
  yield { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: "DO EFFECT BEFORE STEERING" }, parent_tool_use_id: null };
  await atTool;
  yield { type: "user", uuid: steer, priority: "next", message: { role: "user", content: "STEER_AT_TOOL" }, parent_tool_use_id: null };
  wroteSteer();
 }
 try {
  const run = await f.run(prompts()); transparent(f, run);
  assert.equal(f.toolCalls, 1);
  assert.deepEqual(f.calls.map((c) => c.account), ["first", "first", "second"]);
  assert.equal((JSON.stringify(f.calls.at(-1).body.messages).match(/STEER_AT_TOOL/g) ?? []).length, 1);
  const records = parse(f.file(run.session));
  assert.equal(records.filter((r) => r.uuid === steer || r.attachment?.source_uuid === steer).length, 1);
 } finally { wroteSteer(); reachedTool(); await f.close(); }
});

test("queued user messages survive a worker replacement", { timeout: 30000 }, async () => {
 const f = await fixture(({ res, body, account }) => account === "first" ? quota(res) : success(res, body));
 const ids = [crypto.randomUUID(), crypto.randomUUID()];
 async function* prompts() {
  yield { type: "user", uuid: ids[0], message: { role: "user", content: "FIRST QUEUED PROMPT" }, parent_tool_use_id: null };
  yield { type: "user", uuid: ids[1], priority: "next", message: { role: "user", content: "SECOND QUEUED PROMPT" }, parent_tool_use_id: null };
 }
 try {
  const run = await f.run(prompts());
  assert.equal(run.result?.is_error, false);
  const records = parse(f.file(run.session));
  for (const id of ids) assert.equal(records.filter((r) => r.uuid === id).length, 1);
  const delivered = f.calls.filter((c) => c.account === "second").map((c) => JSON.stringify(c.body.messages)).join("\n");
  assert.ok(delivered.includes("FIRST QUEUED PROMPT"));
  assert.ok(delivered.includes("SECOND QUEUED PROMPT"));
  assert.equal(f.children[0].spawnCount, 1);
 } finally { await f.close(); }
});

test("a successful response with a rejected window is delivered once", { timeout: 30000 }, async () => {
 const f = await fixture(({ res, body }) => success(res, body, undefined, { headers: {
  "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 60), "anthropic-ratelimit-unified-representative-claim": "five_hour",
 } }));
 try {
  const run = await f.run("LAST ALLOWED RESPONSE"); transparent(f, run);
  assert.equal(f.calls.length, 1);
 } finally { await f.close(); }
});

test("ordinary API errors reach the client without switching accounts", { timeout: 30000 }, async () => {
 const f = await fixture(({ res }) => res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "invalid model request" } })));
 try {
  await assert.rejects(f.run("INVALID REQUEST"), /exited with code 1/);
  assert.equal(f.frames.findLast((m) => m.type === "result")?.is_error, true);
  assert.ok(f.calls.length > 0 && f.calls.every((c) => c.account === "first"));
  assert.equal((f.log.match(/worker pid=/g) ?? []).length, 1);
 } finally { await f.close(); }
});

test("pi replaces partial output after a tool result and resumes after restart", { timeout: 60000 }, async () => {
 const f = await fixture(({ res, body, account }) => {
  const hasEffect = resultText(body).some((b) => JSON.stringify(b.content).includes("EFFECT DONE"));
  if (!hasEffect) return success(res, body, [{ type: "tool_use", id: "toolu_pi_effect", name: "mcp__custom-tools__bash", input: { command: `printf X >> '${join(f.dir, "effect")}' ; printf 'EFFECT DONE'` } }]);
  if (account === "first") return success(res, body, [
   { type: "text", text: "DISCARDED PI PARTIAL" },
   { type: "tool_use", id: "toolu_pi_discarded", name: "mcp__custom-tools__bash", input: { command: `printf Y >> '${join(f.dir, "effect")}'` } },
  ], { partial: true });
  success(res, body);
 });
 const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
 async function pi(prompt, continued = false) {
  const proc = spawn(process.execPath, [cli, "-ne", "-e", resolve(here, "../.."), "--session-dir", join(f.dir, "pi-sessions"), "--tools", "bash", "--model", `claude-bridge/${model}`, ...(continued ? ["-c"] : []), "-p", prompt], {
   cwd: f.dir, stdio: ["ignore", "pipe", "pipe"],
   env: { ...process.env, PI_CODING_AGENT_DIR: join(f.dir, "pi-agent"), CLAUDE_CONFIG_DIR: join(f.dir, "client-config"), CLAUDE_BRIDGE_REMOTE: `ws+unix://${join(f.dir, "daemon-0.sock")}`, CLAUDE_BRIDGE_REMOTE_TOKEN: "test", CLAUDE_BRIDGE_DEBUG: "1", CLAUDE_BRIDGE_DEBUG_PATH: join(f.dir, "bridge.log") },
  });
  let output = ""; proc.stdout.on("data", (d) => { output += d; }); proc.stderr.on("data", (d) => { output += d; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 20000);
  console.log(`Waiting for pi PID ${proc.pid} to complete its prompt`);
  const [code] = await once(proc, "close"); clearTimeout(timer);
  assert.ok(!timedOut, output + f.log);
  assert.equal(code, 0, output + f.log);
  assert.match(output, /OK/);
 }
 try {
  await pi("Do the effect once.");
  assert.equal(readFileSync(join(f.dir, "effect"), "utf8"), "X");
  await pi("Thanks.", true);
  assert.equal(readFileSync(join(f.dir, "effect"), "utf8"), "X");
  assert.deepEqual(f.calls.map((c) => c.account), ["first", "first", "second", "second"]);
  assert.doesNotMatch(readFileSync(join(f.dir, "bridge.log"), "utf8"), /recording gap|WARNING: Claude Code's finished tool_use/);
  const sessions = readdirSync(join(f.dir, "pi-sessions")).filter((name) => name.endsWith(".jsonl"));
  assert.ok(sessions.length > 0);
  for (const name of sessions) assert.doesNotMatch(readFileSync(join(f.dir, "pi-sessions", name), "utf8"), /DISCARDED PI PARTIAL|toolu_pi_discarded/);
 } finally { await f.close(); }
});

test("sticky keeps the session's account until scheduling reloads to priority", { timeout: 30000 }, async () => {
 const f = await fixture(({ res, body }) => success(res, body));
 const configure = (scheduling, primaryPriority) => writeFileSync(f.accountsFile, JSON.stringify({
  accounts: f.accounts.map((a, i) => ({ ...a, priority: i === 0 ? primaryPriority : 100 })), scheduling,
 }));
 try {
  configure("sticky", 50);
  const first = await f.run("START ON SECOND"); transparent(f, first);
  configure("sticky", 200);
  const resumed = await f.run("KEEP SECOND DESPITE THE NEW PRIORITY", { resume: first.session }); transparent(f, resumed);
  const fresh = await f.run("A NEW SESSION USES THE HIGHEST PRIORITY"); transparent(f, fresh);
  configure("priority", 200);
  const switched = await f.run("PRIORITY NOW OVERRIDES STICKINESS", { resume: first.session }); transparent(f, switched);
  assert.equal(resumed.session, first.session);
  assert.equal(switched.session, first.session);
  assert.deepEqual(f.calls.map((c) => c.account), ["second", "second", "first", "first"]);
 } finally { await f.close(); }
});

test("priority reload reaches both daemons, preserves active work, and overrides sticky resume", { timeout: 30000 }, async () => {
 let release;
 const held = new Promise((resolve) => { release = resolve; });
 const f = await fixture(({ res, body, calls }) => calls.length === 1
  ? success(res, body, [{ type: "text", text: "PRIMARY STILL RUNNING" }], { afterDelta: () => held })
  : success(res, body));
 try {
  writeFileSync(f.accountsFile, JSON.stringify({ accounts: f.accounts.map((a, i) => ({ ...a, priority: i === 0 ? 100 : 50 })), exhausted: "error" }));
  const otherDaemon = await f.daemon();
  const running = f.run("KEEP THE ACTIVE WORKER");
  running.catch(() => {});
  await f.nextFrame((m) => m.type === "stream_event" && m.event.delta?.text === "PRIMARY STILL RUNNING");
  writeFileSync(`${f.accountsFile}.new`, JSON.stringify({ accounts: f.accounts.map((a, i) => ({ ...a, priority: i === 0 ? 50 : 100 })), exhausted: "error" }));
  renameSync(`${f.accountsFile}.new`, f.accountsFile);
  const other = await f.run("USE THE NEW PRIORITY", {}, otherDaemon); transparent(f, other);
  release();
  const first = await running; transparent(f, first);
  assert.equal(first.result.result, "PRIMARY STILL RUNNING");
  const resumed = await f.run("USE THE NEW PRIORITY IN THE SAME SESSION", { resume: first.session }); transparent(f, resumed);
  assert.equal(resumed.session, first.session);
  assert.deepEqual(f.calls.map((c) => c.account), ["first", "second", "second"]);
 } finally { release(); await f.close(); }
});

test("reload adds an account and resumes a waiting query without restarting the daemon", { timeout: 30000 }, async () => {
 const f = await fixture(({ res, body }) => success(res, body));
 try {
  writeFileSync(f.accountsFile, JSON.stringify({ accounts: [f.accounts[0]], exhausted: "wait" }));
  const pool = f.pool();
  pool.reject(pool.accounts[0], model, { resetsAt: Math.floor(Date.now() / 1000) + 60 });
  const running = f.run("CONTINUE WHEN AN ACCOUNT IS ADDED");
  running.catch(() => {});
  await f.nextFrame((m) => m.type === "control_response" && m.response.subtype === "success");
  assert.equal(f.calls.length, 0);
  writeFileSync(`${f.accountsFile}.new`, JSON.stringify({ accounts: [{ ...f.accounts[1], priority: 100, models: [model] }], exhausted: "error" }));
  renameSync(`${f.accountsFile}.new`, f.accountsFile);
  const result = await running; transparent(f, result);
  assert.deepEqual(f.calls.map((c) => c.account), ["second"]);
 } finally { await f.close(); }
});

test("reload from wait to error returns a rate limit for an already waiting query", { timeout: 30000 }, async () => {
 const f = await fixture(() => assert.fail("a blocked account reached the API"), { exhausted: "wait" });
 try {
  const pool = f.pool();
  for (const account of pool.accounts) pool.reject(account, model, { resetsAt: Math.floor(Date.now() / 1000) + 60 });
  const failed = assert.rejects(f.run("STOP WAITING AFTER CONFIG RELOAD"), /Claude quota exceeded: rate limit \(retry-after-ms=\d+\)/);
  failed.catch(() => {});
  await f.nextFrame((m) => m.type === "control_response" && m.response.subtype === "success");
  writeFileSync(f.accountsFile, JSON.stringify({ accounts: f.accounts, exhausted: "error" }));
  await failed;
  assert.equal(f.calls.length, 0);
  assert.equal(f.children[0].spawnCount, 1);
 } finally { await f.close(); }
});

test("exhaustion defaults to error and reports the earliest reset", { timeout: 30000 }, async () => {
 const f = await fixture(({ res }) => quota(res));
 try {
  await assert.rejects(f.run("EXHAUST ALL ACCOUNTS"), /Claude quota exceeded: rate limit \(retry-after-ms=\d+\)/);
  assert.deepEqual(f.calls.map((c) => c.account), ["first", "second"]);
  assert.equal(f.children[0].spawnCount, 1);
 } finally { await f.close(); }
});
