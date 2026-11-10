#!/usr/bin/env node
// End-to-end check of the remote setup against a mock Anthropic API (no usage).
//
// Machine B is simulated with bubblewrap: the daemon runs with A's whole
// project tree hidden (an empty tmpfs over its parent) and its own Claude
// config dir. The Agent SDK, the MCP tool and the session store run here, as A.
//
//   node remote/test/e2e-mock.mjs
//
//   mkdir -m 700 /tmp/claude-b
//   B_CLAUDE_CONFIG_DIR=/tmp/claude-b ANTHROPIC_API_KEY=sk-ant-dummy node remote/test/e2e-mock.mjs
//
// Env: B_CLAUDE_CONFIG_DIR (required): B's Claude config dir, outside the
//      checkout's parent directory. The mock API takes any key, so an empty
//      directory and a dummy ANTHROPIC_API_KEY will do.
//      CLAUDE_BIN (default: the Agent SDK's bundled binary).
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect as netConnect, createServer as netCreateServer } from "node:net";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { getSessionPath } from "cc-session-io";
import { z } from "zod";
import { createRequire } from "node:module";
import WebSocket, { WebSocketServer } from "ws";
import { createRemoteSpawner } from "../spawner.mjs";
import { environmentRecord, localSnapshot } from "../env-block.mjs";
import { CHANNEL, channelMessage, claudeArgs, claudeCodeEnv, keepAlive, sha256, SUBPROTOCOL, toJsonl } from "../protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REMOTE_DIR = resolve(here, "..");
const A_PROJECT = resolve(REMOTE_DIR, ".."); // the repo checkout: a git repo B cannot see
const HIDDEN_ON_B = dirname(A_PROJECT);
const require = createRequire(import.meta.url);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "..", "claude-agent-sdk-linux-x64", "claude");
const B_CFG = process.env.B_CLAUDE_CONFIG_DIR;
if (!B_CFG || !existsSync(B_CFG)) { console.error("set B_CLAUDE_CONFIG_DIR to a Claude config dir (empty, with ANTHROPIC_API_KEY=sk-ant-dummy, will do)"); process.exit(2); }
const work = mkdtempSync(join(tmpdir(), "claude-remote-e2e-"));
const A_CFG = join(work, "a-claude");
const CAP = join(work, "capture");
const B_INSTALL = join(work, "b-install");
const B_SPAWN_CWD = join(work, "b-spawn-cwd");
const B_TMP = join(work, "b-tmp");
const TOKEN = "e2e-token";
const TOKEN_FILE = join(work, "token");
writeFileSync(TOKEN_FILE, `${TOKEN}\n`, { mode: 0o600 });
const MOCK_PORT = 18000 + Math.floor(Math.random() * 1000);
const DAEMON_PORT = MOCK_PORT + 1000;
const DAEMON_URL = `ws://127.0.0.1:${DAEMON_PORT}`;

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

function waitFor(child, pattern, label) {
	console.log(`Waiting for ${label} PID ${child.pid} to become ready`);
	return new Promise((resolve, reject) => {
		let seen = "";
		const timer = setTimeout(() => reject(new Error(`${label} did not start: ${seen.slice(-800)}`)), 60000);
		child.stderr.on("data", (d) => {
			seen += d;
			if (process.env.E2E_VERBOSE) process.stderr.write(`[${label}] ${d}`);
			if (pattern.test(seen)) { clearTimeout(timer); resolve(); }
		});
		child.on("exit", (c) => reject(new Error(`${label} exited ${c}: ${seen.slice(-800)}`)));
	});
}

// --- B: mock API + daemon in a sandbox that cannot see A's project ---
// B installs the package: its files and its one dependency.
mkdirSync(B_INSTALL, { recursive: true });
for (const f of ["daemon.mjs", "protocol.mjs", "env-block.mjs", "accounts.mjs", "pooled-process.mjs", "package.json"]) copyFileSync(join(REMOTE_DIR, f), join(B_INSTALL, f));
cpSync(dirname(require.resolve("ws/package.json")), join(B_INSTALL, "node_modules", "ws"), { recursive: true });
// A binary inside the checkout's node_modules is hidden on B too.
let claudeOnB = execFileSync("realpath", [CLAUDE_BIN], { encoding: "utf8" }).trim();
if (claudeOnB.startsWith(HIDDEN_ON_B + "/")) {
	copyFileSync(claudeOnB, join(B_INSTALL, "claude"));
	execFileSync("chmod", ["+x", join(B_INSTALL, "claude")]);
	claudeOnB = join(B_INSTALL, "claude");
}
const mock = spawn(process.execPath, [join(here, "mock-api.mjs"), "--port", String(MOCK_PORT), "--out", CAP], { stdio: ["ignore", "ignore", "pipe"] });
await waitFor(mock, /mock-api on/, "mock");
process.on("exit", () => mock.kill());
// The main daemon takes the token from its environment (CLAUDE_REMOTE_TOKEN),
// the second one from --token-file.
function startDaemon(listen, spawnCwd, tmpDir, extra = []) {
	const proc = spawn("bwrap", [
		"--dev-bind", "/", "/",
		"--tmpfs", HIDDEN_ON_B,
		"--die-with-parent",
		process.execPath, join(B_INSTALL, "daemon.mjs"),
		`--listen=${listen}`, "--claude", claudeOnB, "--spawn-cwd", spawnCwd, "--tmp-dir", tmpDir, ...extra,
	], {
		stdio: ["ignore", "ignore", "pipe"],
		detached: true, // own process group: killing bwrap alone leaves the daemon running
		env: { ...process.env, CLAUDE_CONFIG_DIR: B_CFG, ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1", ...(extra.includes("--token-file") ? {} : { CLAUDE_REMOTE_TOKEN: TOKEN }) },
	});
	// Also when a check throws: a detached daemon would otherwise outlive the test.
	process.on("exit", () => { try { process.kill(-proc.pid, "SIGTERM"); } catch {} });
	return proc;
}
// Signal a process and wait until it has exited.
const stopped = (proc, signal) => new Promise((resolve) => {
	if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
	console.log(`Waiting for PID ${proc.pid} to exit after its stop signal`);
	proc.once("exit", resolve);
	try { signal(); } catch { resolve(); }
});
// A daemon run to its end, outside the sandbox, for what stops it at start-up.
// B's config dir even so: one that started would write to its CLAUDE_CONFIG_DIR.
const runDaemon = (args) => spawnSync(process.execPath, [join(B_INSTALL, "daemon.mjs"), ...args], { encoding: "utf8", timeout: 20000, env: { ...process.env, CLAUDE_CONFIG_DIR: B_CFG, CLAUDE_REMOTE_TOKEN: TOKEN } });
// T9 and T11 open more connections at once than the default --max-runs.
const daemon = startDaemon(`127.0.0.1:${DAEMON_PORT}`, B_SPAWN_CWD, B_TMP, ["--max-runs", "32"]);
let daemonLog = "";
daemon.stderr.on("data", (d) => { daemonLog += d; });
await waitFor(daemon, /listening on/, "daemon");

// What B sees: the project path must not exist there.
const bSeesProject = execFileSync("bwrap", ["--dev-bind", "/", "/", "--tmpfs", HIDDEN_ON_B, "sh", "-c", `test -e '${A_PROJECT}' && echo yes || echo no`], { encoding: "utf8" }).trim();
check("A's project path does not exist on B", bSeesProject === "no", `${A_PROJECT} on B: ${bSeesProject}`);

// --- A: the SDK with pi-like options and a remote spawner ---
const leaks = [];
const A_PRETEND = process.env.E2E_REAL_A ? {} : { platform: "darwin", shell: "zsh", osVersion: "Darwin 25.1.0" };
const spawner = createRemoteSpawner({ url: DAEMON_URL, token: TOKEN, claudeDir: A_CFG, snapshotOverride: A_PRETEND, onLeak: (l) => leaks.push(...l) });
const toolCalls = [];
// A TCP relay to `port` on this machine that passes `bytesPerSecond` each way,
// like a slow link. It reads all it is given at once, so a side that closes is
// seen at once, and what was still on its way is lost, as on a reset.
async function slowLink(port, bytesPerSecond) {
	const step = Math.ceil(bytesPerSecond / 10); // per 100 ms
	const relay = netCreateServer((a) => {
		const b = netConnect(port, "127.0.0.1");
		for (const [from, to] of [[a, b], [b, a]]) {
			const queued = [];
			let timer = null;
			const pass = () => {
				let room = step;
				while (room > 0 && queued.length && !to.destroyed) {
					const part = queued[0].subarray(0, room);
					to.write(part);
					room -= part.length;
					if (part.length === queued[0].length) queued.shift(); else queued[0] = queued[0].subarray(part.length);
				}
				timer = queued.length && !to.destroyed ? setTimeout(pass, 100) : null;
			};
			from.on("data", (chunk) => { queued.push(chunk); timer ??= setTimeout(pass, 0); });
			from.on("close", () => { clearTimeout(timer); to.destroy(); });
			from.on("error", () => {});
		}
	});
	await new Promise((r) => relay.listen(0, "127.0.0.1", r));
	return relay;
}
// A solid-colour PNG, base64.
function png(width, height, rgb) {
	const crc = (buf) => { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
	const chunk = (type, data) => { const td = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length); td.copy(out, 4); out.writeUInt32BE(crc(td), 8 + data.length); return out; };
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
	const row = Buffer.alloc(1 + width * 3); for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const mcp = () => createSdkMcpServer({
	name: "custom-tools",
	tools: [tool("bash", "Run a bash command", { command: z.string() }, async ({ command }) => {
		const out = execFileSync("bash", ["-c", command], { cwd: A_PROJECT, encoding: "utf8" });
		toolCalls.push({ command, out });
		return { content: [{ type: "text", text: out }] };
	}), tool("screenshot", "Take a screenshot", {}, async () => ({
		// Larger than Claude Code's 2000px limit, so it shrinks this one.
		content: [{ type: "text", text: "screenshot taken" }, { type: "image", data: png(3000, 2000, [20, 60, 220]), mimeType: "image/png" }],
	}))],
});

// The bridge's provider options (src/index.ts streamClaudeAgentSdk), at pi's
// --thinking high.
const bridgeOptions = (extra = {}) => ({
	cwd: A_PROJECT,
	env: { ...process.env },
	tools: [],
	permissionMode: "bypassPermissions",
	includePartialMessages: true,
	settingSources: ["user"],
	settings: { autoMemoryEnabled: false, claudeMdExcludes: ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"], includeGitInstructions: false, outputStyle: "default" },
	systemPrompt: { type: "preset", preset: "claude_code", append: "<project_context>pi's forwarded parts</project_context>" },
	model: process.env.E2E_MODEL ?? "claude-opus-5-5",
	strictMcpConfig: true,
	mcpServers: { "custom-tools": mcp() },
	extraArgs: { "replay-user-messages": null, "thinking-display": "summarized" },
	effort: "high",
	spawnClaudeCodeProcess: spawner,
	...extra,
});
// pi's --thinking off
const THINKING_OFF = { effort: undefined, thinking: { type: "disabled" }, extraArgs: { "replay-user-messages": null } };

async function turn(prompt, extra = {}) {
	const q = query({ prompt, options: bridgeOptions(extra) });
	let session, result, uuids = [];
	for await (const m of q) {
		if (m.type === "system" && m.subtype === "init") session = m.session_id;
		if (m.type === "result") result = m;
		if ((m.type === "user" || m.type === "assistant") && m.uuid) uuids.push({ type: m.type, uuid: m.uuid });
	}
	return { session, result, uuids };
}

const captures = () => readdirSync(CAP).filter((f) => f.startsWith("req-")).sort().map((f) => JSON.parse(readFileSync(join(CAP, f), "utf8")).body);
const text = (body) => JSON.stringify(body);
const envText = (body) => {
	for (const m of body.messages) for (const b of Array.isArray(m.content) ? m.content : [{ text: m.content }]) if (b.text?.includes("# Environment")) return b.text;
	return "";
};
const B_REAL = existsSync(B_SPAWN_CWD) ? execFileSync("realpath", [B_SPAWN_CWD], { encoding: "utf8" }).trim() : B_SPAWN_CWD;
// B's directories, as paths and as Claude Code's folder name for the spawn directory.
const B_PATHS = [B_REAL, B_REAL.replace(/[^a-zA-Z0-9]/g, "-"), B_CFG, B_TMP];
const namesB = (body) => B_PATHS.some((p) => text(body).includes(p));
const bProjectDir = join(B_CFG, "projects", B_REAL.replace(/[^a-zA-Z0-9]/g, "-"));
const bNotesDir = join(B_CFG, "claude-remote", B_REAL.replace(/[^a-zA-Z0-9]/g, "-"));
// The session files B keeps, and those without the daemon's note (a note marks
// a file as the stored copy of a finished run).
const bSessions = () => existsSync(bProjectDir) ? readdirSync(bProjectDir).filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -6)) : [];
const unnoted = () => bSessions().filter((id) => !existsSync(join(bNotesDir, `${id}.json`)));
const lastLog = (marker) => daemonLog.split("\n").filter((l) => l.includes(marker)).at(-1) ?? "";
const records = (path) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// T0: the environment record the daemon writes (env-block.mjs: B's snapshot
// computed, the text copied) is what this Claude Code writes itself, in a plain
// directory, a git repository and a git worktree.
const envCheck = join(work, "env-check");
const ccConfig = join(envCheck, "config");
const ccEnv = { ...process.env, ...claudeCodeEnv({ agentSdkVersion: "0.3.308", tmpDir: join(envCheck, "tmp") }), CLAUDE_CONFIG_DIR: ccConfig, ANTHROPIC_API_KEY: "sk-ant-e2e", ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" };
for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SSE_PORT"]) delete ccEnv[name];
const envDirs = { plain: join(envCheck, "plain"), repo: join(envCheck, "repo"), worktree: join(envCheck, "worktree") };
for (const dir of [ccConfig, join(envCheck, "tmp"), envDirs.plain, envDirs.repo]) mkdirSync(dir, { recursive: true });
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd, stdio: "ignore" });
git(envDirs.repo, "init", "-q");
git(envDirs.repo, "commit", "-q", "--allow-empty", "-m", "init");
git(envDirs.repo, "worktree", "add", "-q", envDirs.worktree);
const envMismatch = [];
for (const [name, cwd] of Object.entries(envDirs)) {
	const id = crypto.randomUUID();
	execFileSync(CLAUDE_BIN, ["-p", "environment check", "--output-format=json", "--model=claude-haiku-4-5", "--tools=", "--setting-sources=", "--strict-mcp-config", `--session-id=${id}`], { cwd, env: ccEnv, stdio: "ignore", timeout: 60000 });
	const theirs = records(getSessionPath(id, cwd, ccConfig)).find((r) => r.attachment?.type === "environment");
	const snapshot = localSnapshot(cwd, ccEnv);
	const ours = environmentRecord({ sessionId: id, cwd: theirs.cwd, version: theirs.version, snapshot, shown: snapshot });
	const fields = (r) => JSON.stringify(Object.keys(r).filter((k) => k !== "gitBranch").sort().map((k) => [k, ["uuid", "timestamp", "parentUuid"].includes(k) ? typeof r[k] : r[k]]));
	if (JSON.stringify(theirs.attachment.snapshot) !== JSON.stringify(snapshot)) envMismatch.push(`${name}: snapshot ${JSON.stringify(theirs.attachment.snapshot)}`);
	else if (theirs.rendered[0].content !== ours.rendered[0].content) envMismatch.push(`${name}: text ${JSON.stringify(theirs.rendered[0].content).slice(0, 300)}`);
	else if (fields({ ...theirs, parentUuid: null }) !== fields(ours)) envMismatch.push(`${name}: fields ${fields(theirs).slice(0, 300)}`);
}
check("the daemon's environment record is what Claude Code writes (plain directory, git repository, worktree)", envMismatch.length === 0, envMismatch.join(" | "));

// T1: a fresh conversation
const t1 = await turn("first turn");
const calls1 = captures();
const env1 = envText(calls1.at(-1));
check("fresh turn completes", t1.result?.subtype === "success" && !t1.result.is_error, t1.result?.result);
check("model sees A's working directory", env1.includes(`Primary working directory: ${A_PROJECT}`));
check("model sees A's git state", env1.includes(`Is a git repository: ${localSnapshot(A_PROJECT).isGitRepo}`));
if (!process.env.E2E_REAL_A) check("model sees A's platform/shell/OS", env1.includes("Platform: darwin") && env1.includes("Shell: zsh") && env1.includes("OS Version: Darwin 25.1.0"));
check("B's directories never reach the model", !calls1.some(namesB));
const ENV_HEAD = /You have been invoked in the following environment/g;
check("one environment block per request", calls1.every((b) => (text(b).match(ENV_HEAD) ?? []).length === 1));
const aFile1 = getSessionPath(t1.session, A_PROJECT, A_CFG);
check("transcript stored on A", existsSync(aFile1), aFile1);
const recs1 = existsSync(aFile1) ? readFileSync(aFile1, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const envRec = recs1.find((r) => r.attachment?.type === "environment");
check("A's copy records A's snapshot and cwd", envRec?.attachment.snapshot.workingDirectory === A_PROJECT && recs1.filter((r) => r.cwd).every((r) => r.cwd === A_PROJECT));
check("B keeps the session it ran, with its note, and returned all of it", JSON.stringify(bSessions()) === JSON.stringify([t1.session]) && unnoted().length === 0 && new RegExp(`returned=${t1.session}\\(\\d+\\)`).test(lastLog("exit pid=")), `${bSessions().join(",")} | ${lastLog("exit pid=").trim()}`);

// T2: resume, and a tool call that runs on A
const before = captures().length;
const t2 = await turn("MOCK_TOOL:bash:{\"command\":\"pwd && ls package.json\"}", { resume: t1.session });
const calls2 = captures().slice(before);
check("resumed turn with a tool call completes", t2.result?.subtype === "success" && !t2.result.is_error, t2.result?.result);
check("tool ran on A, in A's project", toolCalls.length === 1 && toolCalls[0].out.includes(A_PROJECT), toolCalls[0]?.out.trim());
check("tool result reached the model", calls2.some((b) => text(b).includes("package.json")));
check("no environment update after resume", calls2.every((b) => !text(b).includes("Environment update") && (text(b).match(ENV_HEAD) ?? []).length === 1));
const first2 = calls2[0];
check("resumed request keeps the first turn's prefix", JSON.stringify(first2.messages[0].content.map(({ cache_control, ...b }) => b)) === JSON.stringify(calls1.at(-1).messages[0].content.map(({ cache_control, ...b }) => b)));
check("resume runs B's copy, sends no transcript, and gets back only the appended lines", /copy=stored/.test(lastLog("spawn pid=")) && new RegExp(`returned=${t1.session}\\(\\+\\d+ after \\d+\\)`).test(lastLog("exit pid=")), `${lastLog("spawn pid=").trim()} | ${lastLog("exit pid=").trim()}`);
const aRecs2 = records(aFile1);
const bRecs2 = records(join(bProjectDir, `${t1.session}.jsonl`));
check("A's copy and B's file hold the same records", aRecs2.length === bRecs2.length && aRecs2.every((r, i) => r.uuid === bRecs2[i].uuid && r.type === bRecs2[i].type), `A ${aRecs2.length}, B ${bRecs2.length}`);

// T3: fork at the first turn's assistant message (what /tree and pi's fork use)
const forkAt = t1.uuids.filter((u) => u.type === "assistant").at(-1)?.uuid;
const forkId = crypto.randomUUID();
const before3 = captures().length;
const t3 = await turn("forked turn", { resume: t1.session, forkSession: true, resumeSessionAt: forkAt, sessionId: forkId });
const calls3 = captures().slice(before3);
check("fork completes into a new session", t3.result?.subtype === "success" && t3.session === forkId, `session=${t3.session}`);
check("fork stored on A, parent untouched", existsSync(getSessionPath(forkId, A_PROJECT, A_CFG)) && readFileSync(aFile1, "utf8").includes("MOCK_TOOL"));
check("fork drops the cut-off tool turn", calls3.length > 0 && !text(calls3[0]).includes("MOCK_TOOL") && envText(calls3[0]).includes(A_PROJECT));
check("fork runs B's copy of the parent and returns the new file whole", /copy=stored/.test(lastLog("spawn pid=")) && new RegExp(`returned=${forkId}\\(\\d+\\)`).test(lastLog("exit pid=")), lastLog("exit pid=").trim());

// T4: no environment variable from A reaches Claude Code on B; then abort
// while the API call is in flight
const ac = new AbortController();
const remoteProcs = [];
const watched = (o) => { const p = spawner(o); remoteProcs.push(p); return p; };
const aEnv = { ...process.env, TZ: "Etc/GMT+12", LANG: "xx_XX.UTF-8", A_ONLY_SENTINEL: "from-a", CLAUDE_CODE_SENTINEL_FROM_A: "1", DISABLE_AUTO_COMPACT: "0" };
const q4 = query({ prompt: "MOCK_SLOW abort me", options: bridgeOptions({ resume: t1.session, spawnClaudeCodeProcess: watched, abortController: ac, env: aEnv }) });
let bEnv = null;
setTimeout(() => {
	try { bEnv = Object.fromEntries(readFileSync(`/proc/${remoteProcs[0].pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)])); } catch {}
}, 1500);
setTimeout(() => ac.abort(), 3000);
const t4start = Date.now();
let aborted = false;
try { for await (const _ of q4) {} } catch { aborted = true; }
await new Promise((r) => setTimeout(r, 3000));
const killedLine = daemonLog.split("\n").filter((l) => l.includes("exit pid=")).at(-1) ?? "";
check("Claude Code on B has none of A's variables", bEnv !== null && !("A_ONLY_SENTINEL" in bEnv) && !("CLAUDE_CODE_SENTINEL_FROM_A" in bEnv) && bEnv.TZ !== aEnv.TZ && bEnv.LANG !== aEnv.LANG && bEnv.DISABLE_AUTO_COMPACT === "1",
	bEnv ? `TZ=${bEnv.TZ ?? "(unset)"} LANG=${bEnv.LANG ?? "(unset)"}` : "could not read the remote process environment");
check("B sets what an SDK launch sets, and keeps its token from Claude Code", bEnv?.CLAUDE_CODE_ENTRYPOINT === "sdk-ts" && bEnv?.CLAUDE_CODE_SDK_READS_SESSION_STATE === "1" && bEnv?.CLAUDE_AGENT_SDK_VERSION === "0.3.308" && bEnv?.CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS === "1" && bEnv !== null && !("CLAUDE_REMOTE_TOKEN" in bEnv));
check("abort stops the remote Claude Code and leaves B consistent", aborted && Date.now() - t4start < 12000 && /signal=SIG|code=(1|143)/.test(killedLine) && unnoted().length === 0, killedLine.trim());

// T5: a transcript the bridge imported from pi history (no environment record yet)
const { createSession } = await import("cc-session-io");
const imported = createSession({ projectPath: A_PROJECT, claudeDir: A_CFG, model: "claude-opus-5-5" });
imported.addUserMessage("imported question from pi history");
imported.addAssistantMessage([{ type: "text", text: "imported answer" }]);
imported.save();
const before5 = captures().length;
const t5 = await turn("turn after import", { resume: imported.sessionId });
const calls5 = captures().slice(before5);
const roles5 = calls5[0]?.messages.map((m) => `${m.role}:${(Array.isArray(m.content) ? m.content : [{ text: m.content }]).map((b) => (b.text ?? b.type ?? "").slice(0, 24).replace(/\n/g, " ")).join("|")}`);
check("imported transcript resumes with A's environment", t5.result?.subtype === "success" && envText(calls5[0] ?? { messages: [] }).includes(A_PROJECT) && !calls5.some(namesB), JSON.stringify(roles5));

// T6: the date comes from B's clock and time zone, whatever A's TZ is
// (the daemon inherited this process's environment, so B's zone is ours)
const dateIn = (timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const bDate = dateIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
// UTC-12 and UTC+14 are 26 hours apart, so one of them is on another date than B.
const aZone = ["Etc/GMT+12", "Etc/GMT-14"].find((z) => dateIn(z) !== bDate);
const before6 = captures().length;
await turn("date check", { env: { ...process.env, TZ: aZone }, ...THINKING_OFF });
check("date follows B, not A's TZ", text(captures()[before6]).includes(`Today's date is ${bDate}`), `B ${bDate}, A's TZ ${aZone} would give ${dateIn(aZone)}`);

// T7: the bridge's isolated summary query (no persistence, custom prompt)
const before7 = captures().length;
const kept7 = bSessions().sort().join(",");
// runIsolatedSummary's options (src/index.ts)
const s7 = query({ prompt: "Summarize: nothing happened.", options: { cwd: A_PROJECT, env: { ...process.env }, settings: { autoMemoryEnabled: false }, tools: [], strictMcpConfig: true, settingSources: [], skills: [], persistSession: false, systemPrompt: "You are a summarizer.", model: "claude-opus-5-5", maxTurns: 1, effort: "high", verbatimPrompts: true, spawnClaudeCodeProcess: spawner } });
let r7; for await (const m of s7) if (m.type === "result") r7 = m;
const calls7 = captures().slice(before7);
const roles7 = calls7[0]?.messages.map((m) => m.role).join(",");
check("summary query shows A's environment, no extra turns", r7?.subtype === "success" && envText(calls7[0]).includes(A_PROJECT) && !text(calls7[0]).includes("No response requested") && !namesB(calls7[0]), roles7);
check("summary query leaves nothing on B", bSessions().sort().join(",") === kept7 && unnoted().length === 0);

// T8: B marks every prompt client_composed, so a client that leaves out
// verbatimPrompts still cannot have `@path` read B's files or run B's commands
const bFile = join(B_SPAWN_CWD, "b-only.txt");
const bAbsFile = join(work, "b-only-abs.txt");
const bCommand = join(B_CFG, "commands", "remote-leak-probe.md");
writeFileSync(bFile, "SECRET-ON-B\n");
writeFileSync(bAbsFile, "ABS-SECRET-ON-B\n");
mkdirSync(dirname(bCommand), { recursive: true });
writeFileSync(bCommand, "LEAK-COMMAND-RAN\n");
const read8 = [];
for (const [prompt, extra] of [["look at @b-only.txt", {}], [`look at @${bAbsFile}`, {}], ["look at @b-only.txt", { verbatimPrompts: true }]]) {
	const before = captures().length;
	const t8 = await turn(prompt, extra);
	const sent = captures().slice(before).map(text).join("\n");
	const back = existsSync(getSessionPath(t8.session, A_PROJECT, A_CFG)) ? readFileSync(getSessionPath(t8.session, A_PROJECT, A_CFG), "utf8") : "";
	read8.push(sent.includes("SECRET-ON-B") || back.includes("SECRET-ON-B"));
}
const before8c = captures().length;
await turn("/remote-leak-probe");
const ranCommand = captures().slice(before8c).map(text).join("\n").includes("LEAK-COMMAND-RAN");
rmSync(bFile);
rmSync(bAbsFile);
rmSync(bCommand);
check("@path never reads B's files, with or without verbatimPrompts on A", read8.every((r) => !r), JSON.stringify(read8));
check("a slash command never runs B's custom command", !ranCommand);

// T9: the daemon accepts only the request fields, with valid values
const { requestFromSdkArgs } = await import("../spawner.mjs");
const validRequest = { type: "spawn", kind: "provider", model: "claude-opus-5-5", thinking: "high", session: { sessionId: crypto.randomUUID() }, a: { snapshot: { workingDirectory: "/a", isWorktree: false, isGitRepo: false, additionalWorkingDirectories: [], platform: "linux", shell: "bash", osVersion: "Linux 1" } } };
const spawnMessage = (extra = {}) => JSON.stringify({ ...validRequest, session: { sessionId: crypto.randomUUID() }, ...extra });
const stdinLine = (message) => channelMessage(CHANNEL.stdin, `${JSON.stringify(message)}\n`);
// A client that speaks the protocol by hand. Resolves when the connection ends
// or is refused, or with `holding: true` once Claude Code has spawned. A
// message given as [data, options] is sent with those ws options.
function rawSession({ messages = [], afterNeed = [], afterSpawned = [], token = TOKEN, protocol = SUBPROTOCOL, headers = {}, url = DAEMON_URL, holding = false } = {}) {
	return new Promise((resolve) => {
		const ws = new WebSocket(url, protocol, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
		const result = { ws, status: null, opened: false, exit: null, stderr: "", code: null, reason: "" };
		const send = (list) => { for (const m of list) Array.isArray(m) ? ws.send(...m) : ws.send(m); };
		ws.on("unexpected-response", (req, res) => { result.status = res.statusCode; req.destroy(); resolve(result); });
		ws.on("open", () => { result.opened = true; send(messages); });
		ws.on("message", (data, isBinary) => {
			if (isBinary) { if (data[0] === CHANNEL.stderr) result.stderr += data.subarray(1); return; }
			const m = JSON.parse(data);
			if (m.type === "need") send(afterNeed);
			if (m.type === "spawned") { send(afterSpawned); if (holding) resolve(result); }
			if (m.type === "exit") result.exit = m;
		});
		ws.on("error", () => {});
		ws.on("close", (code, reason) => { result.code = code; result.reason = String(reason); resolve(result); });
	});
}
const refusals = await Promise.all([
	rawSession({ messages: [spawnMessage({ args: ["--tools=Bash"] })] }),
	rawSession({ messages: [spawnMessage({ env: { TZ: "UTC" } })] }),
	rawSession({ messages: [spawnMessage({ cwd: "/home/a" })] }),
	rawSession({ messages: [spawnMessage({ model: "claude-opus-5-5 --add-dir=/" })] }),
	rawSession({ messages: [spawnMessage({ thinking: "ultra" })] }),
	rawSession({ messages: [spawnMessage({ session: { resume: "../../../../tmp/evil" } })] }),
	rawSession({ messages: [spawnMessage({ a: { snapshot: validRequest.a.snapshot, extra: 1 } })] }),
	rawSession({ messages: [spawnMessage({ session: { resume: crypto.randomUUID() } })] }),
	rawSession({ messages: [spawnMessage({ have: "0".repeat(64) })] }),
	rawSession({ messages: [spawnMessage({ session: { resume: crypto.randomUUID() }, have: "../x" })] }),
	rawSession({ messages: [JSON.stringify({ type: "kill" })] }),
]);
check("daemon refuses arguments, environment, unknown fields and bad values", refusals.every((r) => r.exit?.code === 1 && r.exit.error && r.code === 4000), refusals.map((r) => r.exit?.error).join(" | "));

// T10: the spawner reads only the four values and refuses a command line B would not reproduce
const sdkArgs = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--effort=high", "--model=claude-opus-5-5[1m]", "--debug-file=/home/a/.pi/agent/cc-cli-logs/x.log", "--tools=", "--setting-sources=user", "--strict-mcp-config", "--permission-mode=bypassPermissions", "--include-partial-messages", "--session-id=9b048c34-850e-4537-b6c7-db7e08b77c0f", "--replay-user-messages", "--thinking-display", "summarized", "--settings", "{\"autoMemoryEnabled\":false,\"claudeMdExcludes\":[\"**/CLAUDE.md\",\"**/AGENTS.md\",\"**/.claude/rules/**\"],\"includeGitInstructions\":false,\"outputStyle\":\"default\"}"];
const parsed = requestFromSdkArgs(sdkArgs);
check("a captured bridge command line becomes four values, without the debug path", JSON.stringify(parsed) === JSON.stringify({ kind: "provider", model: "claude-opus-5-5[1m]", thinking: "high", session: { sessionId: "9b048c34-850e-4537-b6c7-db7e08b77c0f" } }), JSON.stringify(parsed));
const spawnsBefore = (daemonLog.match(/spawn pid=/g) ?? []).length;
// What the SDK reports for a run that fails, as pi shows it.
const failure = async (prompt, extra) => {
	try { const r = await turn(prompt, extra); return r.result?.is_error ? String(r.result.result) : "(no error)"; }
	catch (error) { return error.message; }
};
const refusedOnA = await failure("x", { extraArgs: { "replay-user-messages": null, "thinking-display": "summarized", "add-dir": "/etc" } });
check("an unexpected SDK flag fails on A with the reason and never reaches B", /^Failed to spawn Claude Code process: the remote daemon cannot run this Claude Code command line \(unexpected: [^)]*--add-dir/.test(refusedOnA) && (daemonLog.match(/spawn pid=/g) ?? []).length === spawnsBefore, refusedOnA.slice(0, 200));

// T11: stdin passes only what the bridge's SDK sends. Claude Code would run the
// first two on B (checked by hand against 2.1.308 without the daemon's filter).
const marker = (n) => join(work, `stdin-probe-${n}`);
const rawRun = (lines) => rawSession({ messages: [spawnMessage()], afterSpawned: lines.map(stdinLine) });
const init = (extra = {}) => ({ type: "control_request", request_id: "r1", request: { subtype: "initialize", ...extra } });
const control = (request) => ({ type: "control_request", request_id: "r2", request });
// [what the refusal names, message]
const probes = [
	["bash_command", { type: "bash_command", command: `touch ${marker(1)}` }],
	["mcp_set_servers", control({ subtype: "mcp_set_servers", servers: { probe: { type: "stdio", command: "sh", args: ["-c", `touch ${marker(2)}`] } } })],
	["update_environment_variables", { type: "update_environment_variables", variables: { PROBE: "1" } }],
	["read_file", control({ subtype: "read_file", path: "/etc/hostname" })],
	["set_cwd", control({ subtype: "set_cwd", path: "/" })],
	["keep_alive", { type: "keep_alive" }],
	["plugins", init({ plugins: [{ type: "local", path: work }] })],
	["hooks", init({ hooks: { PreToolUse: [{ hookCallbackIds: ["hook_0"] }] } })],
	["origin", { type: "user", message: { role: "user", content: "hi" }, parent_tool_use_id: null, origin: { kind: "task-notification" } }],
	["control response", { type: "control_response", response: { subtype: "success", request_id: "x", response: { behavior: "allow", updatedPermissions: [{ type: "addDirectories", directories: ["/"], destination: "userSettings" }] } } }],
];
const runs11 = await Promise.all(probes.map(([, p]) => rawRun([init(), p])));
await new Promise((r) => setTimeout(r, 1000));
const notRefused = probes.filter(([what], i) => runs11[i].exit?.code === 0 || !new RegExp(`stdin message refused \\([^)]*${what}`).test(runs11[i].exit?.error ?? "")).map(([what]) => what);
check("daemon refuses stdin messages the bridge does not send, and tells A why", notRefused.length === 0, notRefused.length ? `not refused: ${notRefused.join(", ")}` : runs11.map((r) => r.exit?.signal ?? r.exit?.code).join(","));
check("refused messages have no effect on B", !existsSync(marker(1)) && !existsSync(marker(2)) && unnoted().length === 0);
// Through the SDK: a call the bridge never makes, while Claude Code waits for the API.
const q11 = query({ prompt: "MOCK_SLOW switch models", options: bridgeOptions() });
setTimeout(() => q11.setModel("claude-haiku-4-5").catch(() => {}), 1500);
let stopped11 = "";
try { for await (const _ of q11) {} } catch (error) { stopped11 = error.message; }
check("A shows why the daemon stopped a running Claude Code", /^Failed to spawn Claude Code process: the remote daemon stopped the run: stdin message refused \(control request "set_model"\)/.test(stopped11), stopped11.slice(0, 200));

// T12: B's stored copies. A copy that no longer matches A's is sent again, and
// no session's file reaches another session's requests.
await turn("SIBLING-MARKER-7f3a");
const afterSibling = captures().length;
const lost = await turn("lost-result base");
const lostFile = getSessionPath(lost.session, A_PROJECT, A_CFG);
const keptBytes = readFileSync(lostFile);
// A run whose result never reached A: B's copy moves on, A's does not.
await turn("LOST-TURN-MARKER-91c2", { resume: lost.session });
writeFileSync(lostFile, keptBytes);
const before12 = captures().length;
const t12 = await turn("after the lost result", { resume: lost.session });
const spawn12 = lastLog("spawn pid=");
check("a copy B holds that A does not is replaced by A's", t12.result?.subtype === "success" && /copy=sent/.test(spawn12) && !captures().slice(before12).some((b) => text(b).includes("LOST-TURN-MARKER")), spawn12.trim());
const t12b = await turn("and once more", { resume: lost.session });
check("the turn after that runs B's copy again", t12b.result?.subtype === "success" && /copy=stored/.test(lastLog("spawn pid=")), lastLog("spawn pid=").trim());
check("no session's file reaches another session's requests", !captures().slice(afterSibling).some((b) => text(b).includes("SIBLING-MARKER")));

// T13: images. Claude Code saves each image it is given and names the saved
// file to the model, which on B would be a path on B.
const promptImage = png(3000, 2000, [220, 20, 60]);
async function* imagePrompt() {
	yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "MOCK_TOOL:screenshot:{}" }, { type: "image", source: { type: "base64", media_type: "image/png", data: promptImage } }] } };
}
const before13 = captures().length;
const t13 = await turn(imagePrompt(), { resume: t1.session });
const calls13 = captures().slice(before13);
const images13 = (calls13.at(-1)?.messages ?? []).flatMap((m) => Array.isArray(m.content) ? m.content : [])
	.flatMap((b) => b.type === "tool_result" ? b.content : [b]).filter((b) => b.type === "image")
	.map((b) => { const d = Buffer.from(b.source.data, "base64"); return `${d.readUInt32BE(16)}x${d.readUInt32BE(20)}`; });
check("the prompt image and the tool's image reach the model", t13.result?.subtype === "success" && images13.join(",") === "2000x1333,2000x1333", images13.join(","));
check("no request names a file on B", !calls13.some(namesB) && !calls13.some((b) => text(b).includes("[Image: source:")));
check("the prompt image keeps Claude Code's resize note", calls13.some((b) => text(b).includes("[Image: original 3000x2000, displayed at 2000x1333")));
const bImages = execFileSync("find", [B_CFG, B_TMP, "-name", "*.png"], { encoding: "utf8" }).trim();
check("B keeps no image files", bImages === "", bImages);

// T14: a transcript whose chain does not reach an environment record (its
// first record's parent is not in the file). Claude Code would describe its own
// machine on that chain; B hangs the chain from a record describing A.
const orphanId = crypto.randomUUID();
const orphanFile = getSessionPath(orphanId, A_PROJECT, A_CFG);
const orphanBase = { isSidechain: false, userType: "external", cwd: A_PROJECT, sessionId: orphanId, version: recs1[0]?.version, gitBranch: "", timestamp: new Date().toISOString() };
const orphanUser = crypto.randomUUID();
writeFileSync(orphanFile, toJsonl([
	{ ...orphanBase, parentUuid: crypto.randomUUID(), type: "user", uuid: orphanUser, message: { role: "user", content: "ORPHAN-CHAIN question" } },
	{ ...orphanBase, parentUuid: orphanUser, type: "assistant", uuid: crypto.randomUUID(), message: { id: "msg_orphan", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
]));
const before15 = captures().length;
const t15 = await turn("after the orphan chain", { resume: orphanId });
const calls15 = captures().slice(before15);
check("a chain without an environment record still shows A's environment", t15.result?.subtype === "success" && text(calls15[0] ?? {}).includes("ORPHAN-CHAIN") && envText(calls15[0] ?? { messages: [] }).includes(A_PROJECT) && !calls15.some(namesB));

// T15: B's own Claude Code settings stay out of remote runs. Its hooks would
// run on B with A's prompt and show their output to the model; its rules and
// skills describe B.
const bSettings = join(B_CFG, "settings.json");
const savedSettings = existsSync(bSettings) ? readFileSync(bSettings) : null;
const hookRan = join(work, "b-hook-ran");
const bProbes = [join(B_CFG, "rules", "e2e-probe.md"), join(B_CFG, "skills", "e2e-probe-skill", "SKILL.md")];
const newDirs = [join(B_CFG, "rules"), join(B_CFG, "skills")].filter((d) => !existsSync(d));
const seen16 = [];
try {
	writeFileSync(bSettings, JSON.stringify({ hooks: {
		UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch ${hookRan}; echo B-HOOK-OUTPUT` }] }],
		SessionStart: [{ hooks: [{ type: "command", command: "echo B-SESSION-HOOK-OUTPUT" }] }],
	} }));
	mkdirSync(dirname(bProbes[0]), { recursive: true });
	writeFileSync(bProbes[0], "B-RULE-TEXT\n");
	mkdirSync(dirname(bProbes[1]), { recursive: true });
	writeFileSync(bProbes[1], "---\nname: e2e-probe-skill\ndescription: B-SKILL-TEXT\n---\nbody\n");
	const before16 = captures().length;
	const q16 = query({ prompt: "settings check", options: bridgeOptions() });
	let session16;
	for await (const m of q16) { seen16.push(JSON.stringify(m)); if (m.type === "system" && m.subtype === "init") session16 = m.session_id; }
	seen16.push(...captures().slice(before16).map(text), readFileSync(getSessionPath(session16, A_PROJECT, A_CFG), "utf8"));
} finally {
	if (savedSettings) writeFileSync(bSettings, savedSettings); else rmSync(bSettings, { force: true });
	for (const p of bProbes) rmSync(p, { force: true });
	for (const d of [dirname(bProbes[1]), ...newDirs]) rmSync(d, { recursive: true, force: true });
}
const found16 = ["B-HOOK-OUTPUT", "B-SESSION-HOOK-OUTPUT", "B-RULE-TEXT", "B-SKILL-TEXT", "e2e-probe-skill"].filter((m) => seen16.some((s) => s.includes(m)));
check("B's hooks, rules and skills stay out of remote runs", seen16.length > 2 && found16.length === 0 && !existsSync(hookRan), found16.join(", ") || (existsSync(hookRan) ? "the hook ran" : ""));

// Every run so far: Claude Code never announced B's environment (the daemon's
// leak check), and nothing it wrote names B's directories.
check("Claude Code never described B's environment", leaks.length === 0 && !daemonLog.includes("LEAK"), leaks.length ? JSON.stringify(leaks).slice(0, 300) : "");
const aTranscripts = readdirSync(join(A_CFG, "projects"), { recursive: true }).filter((n) => n.endsWith(".jsonl")).map((n) => readFileSync(join(A_CFG, "projects", n), "utf8"));
const naming = [...captures().map(text), ...aTranscripts].filter((t) => B_PATHS.some((p) => t.includes(p)));
check("no request and no transcript kept on A names B's directories", aTranscripts.length > 0 && naming.length === 0, `${naming.length} of ${captures().length} requests and ${aTranscripts.length} transcripts`);

// T16: who gets a WebSocket, and what a bad message does. A client without the
// token gets an HTTP status and never a WebSocket.
const { get: httpGet } = await import("node:http");
const plainGet = (headers = {}) => new Promise((resolve) => {
	httpGet({ host: "127.0.0.1", port: DAEMON_PORT, path: "/", headers }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", () => resolve(null));
});
const refused17 = await Promise.all([
	rawSession({ token: null }),
	rawSession({ token: "not-the-token" }),
	rawSession({ headers: { Origin: "https://example.com" } }),
	rawSession({ url: `${DAEMON_URL}/other` }),
	rawSession({ protocol: "claude-remote.v0" }),
]);
const statuses17 = [...refused17.map((r) => r.status), await plainGet(), await plainGet({ Authorization: `Bearer ${TOKEN}` })];
check("only a request with the token, no Origin, the path and the subprotocol becomes a WebSocket", JSON.stringify(statuses17) === "[401,401,403,404,400,401,426]" && refused17.every((r) => !r.opened), JSON.stringify(statuses17));
// Nothing listens on port 1.
const wrongToken = await failure("wrong token", { spawnClaudeCodeProcess: createRemoteSpawner({ url: DAEMON_URL, token: "not-the-token", claudeDir: A_CFG }) });
const noDaemon = await failure("no daemon", { spawnClaudeCodeProcess: createRemoteSpawner({ url: "ws://127.0.0.1:1", token: TOKEN, claudeDir: A_CFG }) });
check("A shows why a run could not start", /^Failed to spawn Claude Code process: the remote daemon at ws:\/\/127\.0\.0\.1:\d+ refused the connection: 401 Unauthorized; check the token$/.test(wrongToken) && /^Failed to spawn Claude Code process: cannot reach the remote daemon at ws:\/\/127\.0\.0\.1:1 \(connect ECONNREFUSED/.test(noDaemon), `${wrongToken} | ${noDaemon}`);
// A frame header announcing 2 GiB, sent by hand after a valid upgrade.
function oversizedMessage() {
	return new Promise((resolve) => {
		const sock = netConnect(DAEMON_PORT, "127.0.0.1");
		let buf = Buffer.alloc(0);
		let upgraded = false;
		sock.on("connect", () => sock.write([
			"GET / HTTP/1.1", `Host: 127.0.0.1:${DAEMON_PORT}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13",
			`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`, `Sec-WebSocket-Protocol: ${SUBPROTOCOL}`, `Authorization: Bearer ${TOKEN}`, "", "",
		].join("\r\n")));
		sock.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			if (!upgraded) {
				const end = buf.indexOf("\r\n\r\n");
				if (end < 0) return;
				upgraded = true;
				buf = buf.subarray(end + 4);
				const header = Buffer.alloc(14); // binary, masked, 64-bit length, zero mask key
				header[0] = 0x82;
				header[1] = 0x80 | 127;
				header.writeBigUInt64BE(2n ** 31n, 2);
				sock.write(header);
			}
			if (buf.length >= 4 && buf[0] === 0x88) resolve(buf.readUInt16BE(2)); // the close frame's code
		});
		sock.on("error", () => {});
		sock.on("close", () => resolve(null));
	});
}
// A connection that sends nothing at all.
const silent = new Promise((resolve) => {
	const start = Date.now();
	netConnect(DAEMON_PORT, "127.0.0.1").on("error", () => {}).on("close", () => resolve(Date.now() - start));
});
// The daemon asks for A's copy of a session it does not hold.
const asksForCopy = () => ({ session: { resume: crypto.randomUUID() }, have: "0".repeat(64) });
// Where nothing of the copy comes, the daemon waits a minute for its first
// piece; checked at the end, so the tests go on meanwhile.
const noCopyStart = Date.now();
const noCopy = rawSession({ messages: [spawnMessage(asksForCopy())] }).then((r) => ({ ...r, ms: Date.now() - noCopyStart }));
// A side whose ping waits behind its own bytes, toward a peer that stopped
// reading, as one that is gone does. It cannot tell that from a slow link, so
// it waits up to a minute; TCP alone would take about 15. Checked at the end too.
const behindStart = Date.now();
const behindDrop = new Promise((resolve) => {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	server.on("connection", (ws, req) => {
		ws.send(Buffer.alloc(64 * 1024 * 1024));
		keepAlive(ws, req.socket, 1000);
		ws.on("close", () => { server.close(); resolve(Date.now() - behindStart); });
	});
	server.on("listening", () => {
		const peer = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
		peer.on("open", () => peer.pause());
		peer.on("error", () => {});
	});
	setTimeout(resolve, 90_000, Infinity).unref();
});
const bad17 = await Promise.all([
	rawSession({ messages: ["not json"] }),
	rawSession({ messages: [spawnMessage(), JSON.stringify({ type: "kill", signal: "SIGSTOP" })] }),
	rawSession({ messages: [spawnMessage(), JSON.stringify({ type: "dance" })] }),
	rawSession({ messages: [spawnMessage(), channelMessage(7, "x")] }),
	rawSession(),
	rawSession({ messages: [spawnMessage(asksForCopy()), stdinLine(init())] }),
	// A copy that stops after its first piece.
	rawSession({ messages: [spawnMessage(asksForCopy())], afterNeed: [[channelMessage(CHANNEL.transcript, randomBytes(4096)), { fin: false }]] }),
]);
const errors17 = bad17.map((r) => r.exit?.error ?? "");
const oversized = await oversizedMessage();
check("a bad message ends its connection with the reason", /^bad message: /.test(errors17[0]) && /SIGSTOP/.test(errors17[1]) && /message type "dance"/.test(errors17[2]) && /channel 7/.test(errors17[3]) && errors17[4] === "no spawn message"
	&& errors17[5] === "bad message: stdin before Claude Code started" && errors17[6] === "the session file did not arrive" && bad17.every((r) => r.code === 4000) && oversized === 1009, `${errors17.join(" | ")} | oversized: ${oversized}`);
const silentMs = await silent;
check("a connection that sends nothing is closed after 10 seconds", silentMs > 9000 && silentMs < 13000, `${silentMs} ms`);
const t17 = await turn("still serving");
check("the daemon keeps serving after them", t17.result?.subtype === "success" && daemon.exitCode === null);

// T17: a fake B. A stores only the session file it asked for, fails a turn
// without one, sends its copy of a session at most once and in pieces, and
// ignores what B sends after the run ends.
// The fake sends `spawned`, then what `reply` returns for the run's session
// id, and closes the connection a second later if A has not.
async function fromFakeB(reply, resume) {
	const fake = new WebSocketServer({ host: "127.0.0.1", port: 0, handleProtocols: () => SUBPROTOCOL });
	await new Promise((r) => fake.on("listening", r));
	const sessionId = resume ?? crypto.randomUUID();
	let uploads = 0;
	fake.on("connection", (ws) => ws.on("message", (data, isBinary) => {
		if (isBinary) { if (data[0] === CHANNEL.transcript) uploads++; return; }
		if (JSON.parse(data).type !== "spawn") return;
		ws.send(JSON.stringify({ type: "spawned", pid: 1 }));
		for (const message of reply(sessionId)) ws.send(message);
		setTimeout(() => ws.close(1000), 1000).unref();
	}));
	const proc = createRemoteSpawner({ url: `ws://127.0.0.1:${fake.address().port}`, token: TOKEN, claudeDir: A_CFG })({
		args: claudeArgs({ kind: "provider", model: "claude-opus-5-5", thinking: "high", ...(resume ? { resume } : { sessionId }) }), cwd: A_PROJECT, env: {},
	});
	let stderr = "";
	proc.stderr.on("data", (d) => { stderr += d; });
	const code = await new Promise((r) => proc.on("close", r));
	await new Promise((r) => setTimeout(r, 200)); // whatever comes after the run
	fake.close();
	return { code, stderr, sessionId, uploads };
}
// The end of a run as the daemon sends it: what A lacks of the session file
// `id` on its channel, then the exit message naming it (no file for no id).
const exitWith = (id, text = "") => [
	...(id ? [channelMessage(CHANNEL.file, text)] : []),
	JSON.stringify({ type: "exit", code: 0, signal: null, files: id ? { [id]: { from: 0, length: Buffer.byteLength(text) } } : {}, leaks: [] }),
];
const otherSession = crypto.randomUUID();
const evil = join(work, "fake-b-wrote-this");
const fake17 = [
	await fromFakeB(() => exitWith(otherSession, "{}\n")),
	await fromFakeB(() => exitWith(relative(dirname(getSessionPath(otherSession, A_PROJECT, A_CFG)), evil), "{}\n")),
];
check("A refuses session files it did not ask for", fake17.every((r) => r.code === 1 && /did not ask for/.test(r.stderr)) && !existsSync(getSessionPath(otherSession, A_PROJECT, A_CFG)) && !existsSync(`${evil}.jsonl`), fake17.map((r) => r.stderr.trim()).join(" | "));
// The bridge reads the session file after every turn.
const noFile = await fromFakeB(() => exitWith(null));
check("A fails a turn that brings no session file back", noFile.code === 1 && /the remote daemon returned no session file/.test(noFile.stderr), noFile.stderr.trim());
// Each answer to `need` queues A's whole copy, so a B that kept asking would fill pi's memory.
const resumed = crypto.randomUUID();
writeFileSync(getSessionPath(resumed, A_PROJECT, A_CFG), "{}\n");
const need = JSON.stringify({ type: "need" });
const asked = [await fromFakeB(() => [need, need], resumed), await fromFakeB(() => [need])];
check("A sends its copy of a session once, and only for a run that resumes one", asked[0].uploads === 1 && /asked for the session file twice/.test(asked[0].stderr) && asked[1].uploads === 0 && /resumes none/.test(asked[1].stderr), asked.map((r) => `${r.uploads} upload(s): ${r.stderr.trim()}`).join(" | "));
// A sends its copy in pieces. ws compresses a message whole before sending any
// of it, and holds pings and pongs until then; in pieces, A's answer to a ping
// comes before the whole copy has.
const bigCopy = crypto.randomUUID();
const bigCopyBytes = Buffer.from(`${JSON.stringify({ text: randomBytes(6_000_000).toString("base64") })}\n`);
writeFileSync(getSessionPath(bigCopy, A_PROJECT, A_CFG), bigCopyBytes);
const piecewise = await new Promise((resolve) => {
	const fake = new WebSocketServer({ host: "127.0.0.1", port: 0, handleProtocols: () => SUBPROTOCOL });
	fake.on("listening", () => {
		const proc = createRemoteSpawner({ url: `ws://127.0.0.1:${fake.address().port}`, token: TOKEN, claudeDir: A_CFG })({
			args: claudeArgs({ kind: "provider", model: "claude-opus-5-5", thinking: "high", resume: bigCopy }), cwd: A_PROJECT, env: {},
		});
		proc.on("error", () => {});
		proc.stderr.resume();
	});
	fake.on("connection", (ws) => {
		let ponged = false;
		ws.on("pong", () => { ponged = true; });
		ws.on("message", (data, isBinary) => {
			if (!isBinary) { ws.send(JSON.stringify({ type: "need" })); ws.ping(); return; }
			resolve({ ponged, intact: data[0] === CHANNEL.transcript && data.subarray(1).equals(bigCopyBytes) });
			ws.terminate();
			fake.close();
		});
	});
});
check("A sends its copy of a session in pieces: it answers a ping before the whole copy has come", piecewise.ponged && piecewise.intact, JSON.stringify(piecewise));
// Output after a bad message used to be written to ended streams, an error
// thrown outside any handler, which ends pi; a second exit stored the file again.
const uncaught = [];
const onUncaught = (error) => uncaught.push(error.code ?? error.message);
process.on("uncaughtException", onUncaught);
const late = [
	await fromFakeB(() => [channelMessage(9, "x"), channelMessage(CHANNEL.stdout, "{}\n"), channelMessage(CHANNEL.stderr, "late\n")]),
	await fromFakeB((id) => [...exitWith(id, "first\n"), ...exitWith(id, "second\n")]),
];
process.off("uncaughtException", onUncaught);
const kept = readFileSync(getSessionPath(late[1].sessionId, A_PROJECT, A_CFG), "utf8");
check("A ignores what B sends after the run ends", uncaught.length === 0 && late[0].code === 1 && /channel 9/.test(late[0].stderr) && late[1].code === 0 && kept === "first\n", `uncaught: ${uncaught.join(",") || "none"}; stored: ${JSON.stringify(kept)}`);

// T18: plain ws:// to and on any address. 192.0.2.1 is no address of this
// machine, so listening there fails; a daemon that refused addresses other
// than loopback would stop before trying.
let anyHost = true;
try { createRemoteSpawner({ url: "ws://192.0.2.10:7878", token: TOKEN }); } catch { anyHost = false; }
const elsewhere = runDaemon(["--listen", "192.0.2.1:7878", "--claude", claudeOnB, "--spawn-cwd", join(work, "b-elsewhere-cwd"), "--tmp-dir", join(work, "b-elsewhere-tmp")]);
check("both sides take ws:// to and on an address other than loopback", anyHost && elsewhere.status === 2 && /cannot listen on 192\.0\.2\.1:7878/.test(elsewhere.stderr), elsewhere.stderr.trim());
// Every daemon here gets --listen=...; an option the daemon does not know,
// such as the removed --token, stops it.
const unknownOption = runDaemon(["--token", TOKEN]);
check("the daemon refuses an option it does not know", unknownOption.status === 2 && /unknown option --token/.test(unknownOption.stderr), unknownOption.stderr.trim().split("\n")[0]);
// One daemon per spawn directory: a second one on the main daemon's would sweep
// away its running sessions.
const twin = runDaemon(["--claude", claudeOnB, "--spawn-cwd", B_SPAWN_CWD, "--tmp-dir", join(work, "b-twin-tmp")]);
check("a second daemon on the same spawn directory does not start", twin.status === 2 && /another claude-remote-daemon \(pid \d+\) runs Claude Code in/.test(twin.stderr), twin.stderr.trim().split("\n")[0]);
const hasIpv6 = await new Promise((resolve) => { const s = netCreateServer().on("error", () => resolve(false)); s.listen(0, "::1", () => s.close(() => resolve(true))); });
if (!hasIpv6) console.log("SKIP a daemon on [::1]: no IPv6 loopback");
else {
	const V6_PORT = DAEMON_PORT + 3;
	const v6Daemon = startDaemon(`[::1]:${V6_PORT}`, join(work, "b-v6-cwd"), join(work, "b-v6-tmp"));
	let v6Log = "";
	v6Daemon.stderr.on("data", (d) => { v6Log += d; });
	await waitFor(v6Daemon, /listening on/, "IPv6 daemon");
	const v6 = await rawSession({ url: `ws://[::1]:${V6_PORT}`, token: null });
	check("a daemon listens on an IPv6 loopback address", v6Log.includes(`listening on ws://[::1]:${V6_PORT}/`) && v6.status === 401, `${v6.status} | ${v6Log.split("\n").find((l) => l.includes("listening"))?.slice(0, 120)}`);
	process.kill(-v6Daemon.pid, "SIGTERM");
}

// T19: B's limits. A second daemon (token from --token-file) runs one session
// at a time and pings every second. It starts over the lock of a daemon on its
// spawn directory from before a reboot, whose pid another process (this one)
// has now.
const LIMITS_PORT = DAEMON_PORT + 1;
const LIMITS_URL = `ws://127.0.0.1:${LIMITS_PORT}`;
const BOOT_ID = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const limitsLock = `${join(realpathSync(work), "b-limits-cwd")}.lock`;
writeFileSync(limitsLock, `${process.pid}\nan-earlier-boot\n`);
const limitsDaemon = startDaemon(`127.0.0.1:${LIMITS_PORT}`, join(work, "b-limits-cwd"), join(work, "b-limits-tmp"), ["--token-file", TOKEN_FILE, "--max-runs", "1", "--keepalive-seconds", "1"]);
let limitsLog = "";
limitsDaemon.stderr.on("data", (d) => { limitsLog += d; });
await waitFor(limitsDaemon, /listening on/, "second daemon");
check("a daemon takes over a lock left before a reboot, whose pid another process has now", Number.parseInt(readFileSync(limitsLock, "utf8"), 10) !== process.pid);
const limitsSpawns = () => [...limitsLog.matchAll(/spawn pid=(\d+)/g)].map((m) => m[1]);
const holder = await rawSession({ url: LIMITS_URL, messages: [spawnMessage()], holding: true });
const heldPid = limitsSpawns().at(-1);
const second = await rawSession({ url: LIMITS_URL, messages: [spawnMessage()] });
check("a daemon at --max-runs turns the next connection away", holder.opened && heldPid !== undefined && second.status === 503, `second connection: ${second.status}`);
// The holder stops reading, so it answers no ping.
holder.ws.pause();
await new Promise((r) => setTimeout(r, 4000));
check("a client that stops answering pings is dropped, and its Claude Code stopped", new RegExp(`exit pid=${heldPid} `).test(limitsLog), limitsLog.split("\n").filter((l) => l.includes(`pid=${heldPid}`)).join(" / "));
holder.ws.terminate();
// Messages slower than the ping interval: A's copy of a session that holds
// text that does not compress, through a link that passes 200 KB a second.
// A's answers to the daemon's pings wait behind it.
const relay = await slowLink(LIMITS_PORT, 200_000);
const viaSlowLink = createRemoteSpawner({ url: `ws://127.0.0.1:${relay.address().port}`, token: TOKEN, claudeDir: A_CFG, snapshotOverride: A_PRETEND });
const bigSession = (bytes) => {
	const session = createSession({ projectPath: A_PROJECT, claudeDir: A_CFG, model: "claude-opus-5-5" });
	session.addUserMessage(randomBytes(bytes).toString("base64"));
	session.addAssistantMessage([{ type: "text", text: "noted" }]);
	session.save();
	return session.sessionId;
};
// An abort 1 second into a copy that takes about 10 seconds. The SDK stops
// Claude Code 2 seconds after an abort; a second later the daemon, which runs
// one session at a time, has a free slot again and has started nothing.
const abortedSession = bigSession(2_000_000);
const ac19 = new AbortController();
setTimeout(() => ac19.abort(), 1000);
const abortStart = Date.now();
const aborted19 = await failure("stopped on the way", { resume: abortedSession, spawnClaudeCodeProcess: viaSlowLink, abortController: ac19 });
await new Promise((r) => setTimeout(r, abortStart + 4000 - Date.now()));
const slotFree = await new Promise((resolve) => {
	const ws = new WebSocket(LIMITS_URL, SUBPROTOCOL, { headers: { Authorization: `Bearer ${TOKEN}` } });
	ws.on("open", () => ws.terminate());
	ws.on("close", () => setTimeout(resolve, 200, true)); // the daemon frees the slot again
	ws.on("unexpected-response", (req) => { req.destroy(); resolve(false); });
	ws.on("error", () => {});
});
check("an abort while A's copy of the session is on its way drops the connection, and the daemon starts nothing", slotFree && !limitsLog.includes(`opened=${abortedSession}`), `${aborted19.slice(0, 80)}; slot free: ${slotFree}`);
const slowSession = bigSession(900_000);
const t19 = await turn("after a slow upload", { resume: slowSession, spawnClaudeCodeProcess: viaSlowLink }).catch((error) => ({ error }));
check("a message slower than the ping interval keeps the connection", t19.result?.subtype === "success" && new RegExp(`opened=${slowSession} target=\\S+ copy=sent`).test(limitsLog), t19.error?.message ?? limitsLog.split("\n").filter((l) => l.includes(slowSession)).join(" / "));
relay.close();
// B sends a large session file in pieces too: a fork, which comes back whole,
// of a session holding 2 MB of text in a script of three bytes a character.
const wideText = "汉字测试".repeat(180_000);
const wide = createSession({ projectPath: A_PROJECT, claudeDir: A_CFG, model: "claude-opus-5-5" });
wide.addUserMessage(wideText);
const wideAnswer = wide.addAssistantMessage([{ type: "text", text: "noted" }]);
wide.save();
const wideFork = crypto.randomUUID();
const t19w = await turn("forked from a large session", { resume: wide.sessionId, forkSession: true, resumeSessionAt: wideAnswer, sessionId: wideFork }).catch((error) => ({ error }));
const wideBack = existsSync(getSessionPath(wideFork, A_PROJECT, A_CFG)) ? readFileSync(getSessionPath(wideFork, A_PROJECT, A_CFG), "utf8") : "";
check("B sends a large session file back in pieces, whole", t19w.result?.subtype === "success" && wideBack.includes(wideText) && new RegExp(`returned=${wideFork}\\(\\d{7,}\\)`).test(daemonLog), lastLog(`returned=${wideFork}`).trim() || t19w.error?.message.slice(0, 200) || t19w.result?.result);

// T20: the spawn and temporary directories. A /tmp cleaner removes them while
// the daemon idles, and the next run puts them back. A directory other users
// can write to is refused, before a run and at startup.
const viaLimits = createRemoteSpawner({ url: LIMITS_URL, token: TOKEN, claudeDir: A_CFG, snapshotOverride: A_PRETEND });
// The cleaner removes the daemon's lock beside them too.
const limitsPid = readFileSync(limitsLock, "utf8").trim();
for (const path of ["b-limits-cwd", "b-limits-tmp", limitsLock]) rmSync(resolve(work, path), { recursive: true, force: true });
const t20 = await turn("after a /tmp cleaner", { spawnClaudeCodeProcess: viaLimits });
check("a run puts back the directories and the lock a /tmp cleaner removed", t20.result?.subtype === "success" && existsSync(join(work, "b-limits-cwd")) && existsSync(join(work, "b-limits-tmp")) && existsSync(limitsLock) && readFileSync(limitsLock, "utf8").trim() === limitsPid);
// The daemon's notes on the sessions it keeps, removed while it runs.
const limitsNotes = join(B_CFG, "claude-remote", realpathSync(join(work, "b-limits-cwd")).replace(/[^a-zA-Z0-9]/g, "-"));
rmSync(limitsNotes, { recursive: true, force: true });
const t20n = await turn("after its notes were removed", { spawnClaudeCodeProcess: viaLimits }).catch((error) => ({ error }));
check("a run still returns its session file after the daemon's notes were removed", t20n.result?.subtype === "success" && existsSync(getSessionPath(t20n.session, A_PROJECT, A_CFG)) && existsSync(limitsNotes), t20n.error?.message.slice(0, 200));
const spawns20 = limitsSpawns().length;
chmodSync(join(work, "b-limits-cwd"), 0o777);
const openDir = await failure("into a directory others can write to", { spawnClaudeCodeProcess: viaLimits });
const shared = join(work, "shared");
mkdirSync(shared);
chmodSync(shared, 0o777);
const sharedDaemon = runDaemon(["--claude", claudeOnB, "--spawn-cwd", join(shared, "cwd"), "--tmp-dir", join(work, "b-shared-tmp")]);
check("a directory other users can write to is refused, before a run and at startup", /^Failed to spawn Claude Code process: the remote daemon stopped the run: other users can write to/.test(openDir) && limitsSpawns().length === spawns20 && sharedDaemon.status === 2 && /other users can write to/.test(sharedDaemon.stderr), `${openDir.slice(0, 200)} | ${sharedDaemon.stderr.trim()}`);
// Claude Code that cannot start: the binary the daemon was given went away
// after it started, as an update can do.
const wrapper = join(work, "claude-wrapper");
writeFileSync(wrapper, `#!/bin/sh\nexec '${claudeOnB}' "$@"\n`, { mode: 0o755 });
const GONE_PORT = DAEMON_PORT + 4;
// It starts over the lock of a daemon on its spawn directory that died.
const goneLock = `${join(realpathSync(work), "b-gone-cwd")}.lock`;
const deadPid = spawnSync("true").pid;
writeFileSync(goneLock, `${deadPid}\n${BOOT_ID}\n`);
const goneDaemon = startDaemon(`127.0.0.1:${GONE_PORT}`, join(work, "b-gone-cwd"), join(work, "b-gone-tmp"), ["--claude", wrapper]);
await waitFor(goneDaemon, /listening on/, "daemon whose claude goes away");
check("a daemon takes over the lock a daemon that died left on its spawn directory", Number.parseInt(readFileSync(goneLock, "utf8"), 10) !== deadPid);
rmSync(wrapper);
const noClaude = await failure("with no claude", { spawnClaudeCodeProcess: createRemoteSpawner({ url: `ws://127.0.0.1:${GONE_PORT}`, token: TOKEN, claudeDir: A_CFG, snapshotOverride: A_PRETEND }) });
check("A shows why Claude Code could not start on B", /^Failed to spawn Claude Code process: the remote daemon stopped the run: could not start Claude Code: spawn \S+ ENOENT/.test(noClaude), noClaude.slice(0, 200));
// Stopped from a terminal (Ctrl-C), a daemon removes its lock as well. The
// signal goes to the daemon itself: bubblewrap would kill it on its own exit.
const gonePid = Number.parseInt(readFileSync(goneLock, "utf8"), 10);
await stopped(goneDaemon, () => process.kill(gonePid, "SIGINT"));
check("a daemon stopped with Ctrl-C removes its lock", gonePid > 0 && !existsSync(goneLock), `pid ${gonePid}`);

// T21: B behind a TLS-terminating reverse proxy, with the daemon on loopback.
// A checks the proxy's certificate as Node does for any TLS client: this one
// is added to the trusted certificates and names 127.0.0.1 only.
if (spawnSync("sh", ["-c", "command -v nginx"]).status !== 0) console.log("SKIP B behind a TLS proxy: nginx is not installed");
else {
	const ngx = join(work, "nginx");
	mkdirSync(ngx);
	execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc", "-days", "1", "-subj", "/CN=claude-remote-proxy",
		"-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(ngx, "proxy.key"), "-out", join(ngx, "proxy.pem")], { stdio: "ignore" });
	const { getCACertificates, setDefaultCACertificates } = await import("node:tls");
	setDefaultCACertificates([...getCACertificates("default"), readFileSync(join(ngx, "proxy.pem"), "utf8")]);
	const PROXY_PORT = DAEMON_PORT + 2;
	writeFileSync(join(ngx, "nginx.conf"), `daemon off;
pid ${ngx}/nginx.pid;
error_log ${ngx}/error.log;
events {}
http {
	access_log off;
	${["client_body", "proxy", "fastcgi", "uwsgi", "scgi"].map((t) => `${t}_temp_path ${ngx}/${t};`).join("\n\t")}
	server {
		listen 127.0.0.1:${PROXY_PORT} ssl;
		ssl_certificate ${join(ngx, "proxy.pem")};
		ssl_certificate_key ${join(ngx, "proxy.key")};
		location / {
			proxy_pass http://127.0.0.1:${DAEMON_PORT};
			proxy_http_version 1.1;
			proxy_set_header Upgrade $http_upgrade;
			proxy_set_header Connection "upgrade";
			proxy_read_timeout 1h;
		}
	}
}
`);
	const nginx = spawn("nginx", ["-p", ngx, "-e", join(ngx, "error.log"), "-c", join(ngx, "nginx.conf")], { stdio: "ignore" });
	process.on("exit", () => nginx.kill());
	for (let i = 0; i < 50 && !(await new Promise((r) => netConnect(PROXY_PORT, "127.0.0.1").on("connect", function () { this.destroy(); r(true); }).on("error", () => r(false)))); i++) await new Promise((r) => setTimeout(r, 100));
	const spawnCount = () => (daemonLog.match(/spawn pid=/g) ?? []).length;
	const viaProxy = (host) => createRemoteSpawner({ url: `wss://${host}:${PROXY_PORT}`, token: TOKEN, claudeDir: A_CFG, snapshotOverride: A_PRETEND });
	const spawns21 = spawnCount();
	const t21 = await turn("through the proxy", { spawnClaudeCodeProcess: viaProxy("127.0.0.1") });
	check("a turn runs through a TLS-terminating proxy to a loopback daemon", t21.result?.subtype === "success" && spawnCount() === spawns21 + 1);
	const wrongName = await failure("certificate for another name", { spawnClaudeCodeProcess: viaProxy("localhost") });
	check("a certificate that does not name the host fails the connection and nothing runs", /^Failed to spawn Claude Code process: cannot reach the remote daemon at wss:\/\/localhost:\d+ \(Hostname\/IP does not match certificate's altnames/.test(wrongName) && spawnCount() === spawns21 + 1, wrongName.slice(0, 200));
	await stopped(nginx, () => nginx.kill());
}

// T22: A's next run on a session replaces a run whose connection stopped
// answering (a dead ssh tunnel leaves it open on B until the keepalive drops
// it), and is turned away while that connection still answers.
const takeover = await turn("takeover base");
const takeoverCopy = readFileSync(getSessionPath(takeover.session, A_PROJECT, A_CFG));
const resumeTakeover = () => spawnMessage({ session: { resume: takeover.session }, have: sha256(takeoverCopy) });
const sendTakeoverCopy = [[channelMessage(CHANNEL.transcript, takeoverCopy)]];
const holding = await rawSession({ messages: [resumeTakeover()], afterNeed: sendTakeoverCopy, holding: true });
const turnedAway = await rawSession({ messages: [resumeTakeover()], afterNeed: sendTakeoverCopy });
check("a run whose connection still answers keeps its session", holding.code === null && turnedAway.exit?.error === "session in use by another run", turnedAway.exit?.error ?? "");
holding.ws.pause(); // from here on it answers no ping
const replaceStart = Date.now();
const replacing = await rawSession({ messages: [resumeTakeover()], afterNeed: sendTakeoverCopy, holding: true });
const replaceMs = Date.now() - replaceStart;
check("A's next run on a session replaces a run whose connection stopped answering", replacing.code === null && !replacing.exit && replaceMs < 15_000 && /replaced pid=\d+: its connection stopped answering/.test(daemonLog), `${replaceMs} ms ${replacing.exit?.error ?? ""}`);
replacing.ws.terminate();
holding.ws.terminate();

// T23: Unix sockets. Any user can listen on a loopback port nothing holds (the
// daemon's while it is down, the ssh tunnel's end on A while ssh is down) and
// gets the token of whoever connects; a socket in a directory only its user
// can change cannot be taken that way.
const sockDir = join(realpathSync(work), "sock");
mkdirSync(sockDir, { mode: 0o700 });
const SOCK = join(sockDir, "daemon.sock");
const sockDaemon = startDaemon(`unix:${SOCK}`, join(work, "b-sock-cwd"), join(work, "b-sock-tmp"));
let sockLog = "";
sockDaemon.stderr.on("data", (d) => { sockLog += d; });
await waitFor(sockDaemon, /listening on/, "daemon on a Unix socket");
const viaSocket = createRemoteSpawner({ url: `ws+unix://${SOCK}`, token: TOKEN, claudeDir: A_CFG, snapshotOverride: A_PRETEND });
const t23 = await turn("over a Unix socket", { spawnClaudeCodeProcess: viaSocket }).catch((error) => ({ error }));
check("a turn runs over a Unix socket, which other users may not connect to", t23.result?.subtype === "success" && sockLog.includes(`listening on ws+unix://${SOCK},`) && (statSync(SOCK).mode & 0o777) === 0o600, t23.error?.message ?? t23.result?.result);
// A daemon that died leaves its socket behind; the next one on that path takes
// it over, and one on a path where a daemon runs does not start.
const sockPid = Number.parseInt(readFileSync(`${join(realpathSync(work), "b-sock-cwd")}.lock`, "utf8"), 10);
await stopped(sockDaemon, () => process.kill(sockPid, "SIGKILL"));
const socketLeft = existsSync(SOCK);
const sockDaemon2 = startDaemon(`unix:${SOCK}`, join(work, "b-sock2-cwd"), join(work, "b-sock2-tmp"));
await waitFor(sockDaemon2, /listening on/, "daemon on a socket left behind");
const sockTwin = runDaemon(["--listen", `unix:${SOCK}`, "--claude", claudeOnB, "--spawn-cwd", join(work, "b-sock3-cwd"), "--tmp-dir", join(work, "b-sock3-tmp")]);
check("a daemon takes over the socket of one that died, and does not start on one in use", socketLeft && sockTwin.status === 2 && /another process listens on/.test(sockTwin.stderr), sockTwin.stderr.trim().split("\n").at(-1));
const sock2Pid = Number.parseInt(readFileSync(`${join(realpathSync(work), "b-sock2-cwd")}.lock`, "utf8"), 10);
await stopped(sockDaemon2, () => process.kill(sock2Pid, "SIGTERM"));
check("a daemon removes its socket when it stops", !existsSync(SOCK));

// T16, continued: nothing at all of A's copy.
const nothing = await noCopy;
check("the daemon gives up on A's copy of a session when none of it came for a minute", nothing.exit?.error === "the session file did not arrive" && nothing.code === 4000 && nothing.ms > 58_000 && nothing.ms < 66_000, `${nothing.exit?.error} after ${nothing.ms} ms`);
const behindMs = await behindDrop;
check("a side whose own bytes wait toward a peer that stopped reading drops it after a minute", behindMs > 58_000 && behindMs < 66_000, `${behindMs} ms`);

// Stop the daemons (their process groups) and the mock, and wait: a daemon
// that is still stopping changes the work dir while it is being removed, which
// left parts of it behind.
await Promise.all([
	stopped(limitsDaemon, () => process.kill(-limitsDaemon.pid, "SIGTERM")),
	stopped(daemon, () => process.kill(-daemon.pid, "SIGTERM")),
	stopped(mock, () => mock.kill()),
]);
if (process.env.E2E_KEEP) console.log(`kept ${work}`);
else for (let attempt = 0; attempt < 3 && existsSync(work); attempt++) rmSync(work, { recursive: true, force: true, maxRetries: 3 });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
