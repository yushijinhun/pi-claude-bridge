#!/usr/bin/env node
// Runs on machine B, which holds the Claude login. Spawns `claude` for the
// bridge on machine A and relays its stdio over one WebSocket per process
// (protocol.mjs). Tools, files and conversation history stay on A. B keeps a
// copy of each session it ran so the next turn need not send it again (see
// "Stored sessions"); A's copy stays the one that counts.
//
//   claude-remote-daemon --token-file ~/.config/claude-remote-token
//       [--listen 127.0.0.1:7878 | --listen unix:/path/to/socket] [--path /]
//       [--max-runs 8] [--keepalive-seconds 20] [--claude /path/to/claude]
//       [--spawn-cwd DIR] [--tmp-dir DIR] [--agent-sdk-version 0.3.308] [--keep-days 30]
//
// Options take `--name value` or `--name=value`; an unknown option stops the
// daemon. --listen takes host:port, an IPv6 host in brackets ([::1]:7878), or
// unix: and a socket's absolute path. One daemon at a time may use a spawn
// directory; it holds <spawn-cwd>.lock. The token can also come from
// CLAUDE_REMOTE_TOKEN. The daemon speaks plain ws://; A comes in directly,
// through `ssh -L`, or through a TLS-terminating reverse proxy. Any user on
// this machine can listen on a port the daemon is not using, and gets the
// token of whoever connects to it; a socket in a directory only this user can
// change cannot be taken that way.
//
// Claude Code's environment is the daemon's own plus fixed values
// (protocol.mjs claudeCodeEnv).
// Nothing in it comes from A, and a request that carries environment variables
// is refused. B's own Claude Code settings are not loaded. Of what A writes to
// Claude Code's stdin, only the messages the bridge sends get through.

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, STATUS_CODES } from "node:http";
import { connect } from "node:net";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { basename, dirname, isAbsolute, join } from "node:path";
import { WebSocketServer } from "ws";
import { BEHIND_LIMIT_MS, CHANNEL, channelMessage, claudeArgs, claudeCodeEnv, json, keepAlive, MAX_MESSAGE_BYTES, MODEL, projectDirName, parseJsonl, REQUEST_KEYS, sendChannel, sending, SHA256, sha256, SUBPROTOCOL, THINKING, toJsonl, UUID } from "./protocol.mjs";
import { environmentRecord, localSnapshot, TESTED_CLAUDE_VERSIONS } from "./env-block.mjs";

const USAGE = `usage: claude-remote-daemon --token-file FILE [--listen 127.0.0.1:7878 | --listen unix:/path/to/socket] [--path /]
    [--max-runs 8] [--keepalive-seconds 20] [--claude PATH] [--spawn-cwd DIR] [--tmp-dir DIR] [--agent-sdk-version 0.3.308] [--keep-days 30]`;
const fatal = (message) => { console.error(`claude-remote: ${message}`); process.exit(2); };
// A typo or a removed option (--token, --tls-cert) stops the daemon instead of
// being ignored.
const OPTIONS = new Set(["listen", "path", "token-file", "claude", "spawn-cwd", "tmp-dir", "agent-sdk-version", "keep-days", "max-runs", "keepalive-seconds"]);
const options = new Map();
for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === "--help" || arg === "-h") { console.log(USAGE); process.exit(0); }
	const [, name, inline] = /^--([^=]+)(?:=(.*))?$/s.exec(arg) ?? [];
	if (!OPTIONS.has(name)) fatal(`unknown option ${arg}\n${USAGE}`);
	const value = inline ?? process.argv[++i];
	if (value === undefined) fatal(`${arg} needs a value`);
	options.set(name, value);
}
const flag = (name, fallback) => options.get(name) ?? fallback;
const LISTEN = flag("listen", "127.0.0.1:7878");
let SOCKET, HOST, PORT;
if (LISTEN.startsWith("unix:")) {
	SOCKET = LISTEN.slice("unix:".length);
	if (!isAbsolute(SOCKET)) fatal("--listen unix: takes the socket's absolute path");
} else {
	const listen = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(LISTEN);
	if (!listen || Number(listen[3]) > 65535) fatal("--listen takes host:port, an IPv6 host in brackets ([::1]:7878), or unix:/path/to/socket");
	HOST = listen[1] ?? listen[2];
	PORT = Number(listen[3]);
}
const PATH = flag("path", "/");
let TOKEN = process.env.CLAUDE_REMOTE_TOKEN;
if (flag("token-file")) {
	try { TOKEN = readFileSync(flag("token-file"), "utf8").trim(); }
	catch (error) { fatal(`cannot read --token-file: ${error.message}`); }
}
const CLAUDE = flag("claude", process.env.CLAUDE_REMOTE_CLAUDE ?? "claude");
const UID = process.getuid?.() ?? "u";
const RUN_DIR = join(os.tmpdir(), `claude-remote-${UID}`);
const SPAWN_CWD = flag("spawn-cwd", join(RUN_DIR, "cwd"));
// The Agent SDK the bridge pins (package.json).
const AGENT_SDK_VERSION = flag("agent-sdk-version", "0.3.308");
const KEEP_DAYS = Number(flag("keep-days", "30"));
const MAX_RUNS = Number(flag("max-runs", "8"));
const KEEPALIVE_MS = Number(flag("keepalive-seconds", "20")) * 1000;
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(os.homedir(), ".claude");
if (!TOKEN) fatal("give --token-file or set CLAUDE_REMOTE_TOKEN");
if (!PATH.startsWith("/")) fatal("--path must start with /");
if (!(KEEP_DAYS > 0)) fatal("--keep-days must be a positive number");
if (!(MAX_RUNS >= 1)) fatal("--max-runs must be at least 1");
// A waits that long for a sign of B while its own bytes are queued.
if (!(KEEPALIVE_MS > 0 && KEEPALIVE_MS <= BEHIND_LIMIT_MS / 2)) fatal(`--keepalive-seconds must be more than 0 and at most ${BEHIND_LIMIT_MS / 2000}`);

const log = (...a) => console.error(new Date().toISOString(), ...a);

// Claude Code's working directory and temporary directory (it saves prompt
// images there, see blockSavedFiles) default to /tmp. A /tmp cleaner removes
// them after a while without runs (systemd-tmpfiles: 10 days), and another
// user can create the path first, then rename or replace what the daemon puts
// in it. So both are created again before every run, and each, with every
// directory above it, must belong to this user or root and be closed to other
// users' writes; a sticky directory such as /tmp may be open.
const TMP_DIR = flag("tmp-dir", join(RUN_DIR, "tmp"));

let owners;
/** Users whose directories may hold this user's files: this user and root. In
 *  a user namespace (bubblewrap, rootless containers) root, like every user
 *  outside it, shows as the overflow uid. */
function trustedOwners() {
	if (owners) return owners;
	owners = new Set([process.getuid(), 0]);
	try {
		if (readFileSync("/proc/self/uid_map", "utf8").trim().split(/\s+/).join(" ") !== "0 0 4294967295") owners.add(Number(readFileSync("/proc/sys/kernel/overflowuid", "utf8")));
	} catch {}
	return owners;
}

/** Why another user could change or replace `path`, or undefined. `path` must
 *  belong to this user, and every directory above it to this user or root,
 *  all closed to other users' writes. A sticky directory above it, such as
 *  /tmp, may be open: others cannot remove or rename what this user has in it. */
function othersCanChange(path) {
	if (!process.getuid) return undefined;
	for (let at = path; ; at = dirname(at)) {
		const { uid, mode } = statSync(at);
		if (at === path ? uid !== process.getuid() : !trustedOwners().has(uid)) return `${at} belongs to uid ${uid}`;
		if (mode & 0o022 && (at === path || !(mode & 0o1000))) return `other users can write to ${at} (mode ${(mode & 0o7777).toString(8)})`;
		if (dirname(at) === at) return undefined;
	}
}

/** Create `path` if missing and return its real path, or throw if other users
 *  could change it. */
function privateDir(path) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const real = realpathSync(path);
	const problem = othersCanChange(real);
	if (problem) throw new Error(problem);
	return real;
}

let SPAWN_CWD_REAL, CC_TMPDIR;
try { [SPAWN_CWD_REAL, CC_TMPDIR] = [privateDir(SPAWN_CWD), privateDir(TMP_DIR)]; }
catch (error) { fatal(`${error.message}; give --spawn-cwd and --tmp-dir directories only you can change`); }
if (SOCKET) {
	mkdirSync(dirname(SOCKET), { recursive: true, mode: 0o700 });
	SOCKET = join(realpathSync(dirname(SOCKET)), basename(SOCKET));
}
const checkDirs = () => {
	if (privateDir(SPAWN_CWD) !== SPAWN_CWD_REAL || privateDir(TMP_DIR) !== CC_TMPDIR) throw new Error(`${SPAWN_CWD} or ${TMP_DIR} now leads elsewhere`);
	holdLock();
};

// One daemon per spawn directory. Another one's sweep would delete this one's
// running sessions (a session has no note until its run ends) and the files
// that block their image saves. A lock left by a daemon that died is taken over.
// The lock names the daemon's pid and the boot it started in: after a reboot
// that pid may belong to any process.
const LOCK = `${SPAWN_CWD_REAL}.lock`;
const BOOT_ID = (() => { try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return ""; } })();
const LOCK_TEXT = `${process.pid}\n${BOOT_ID}\n`;
const readLock = () => {
	try { const [pid, boot = ""] = readFileSync(LOCK, "utf8").split("\n"); return { pid: Number.parseInt(pid, 10), boot }; }
	catch { return { pid: NaN, boot: "" }; }
};
const lockHolder = () => readLock().pid;
const isRunning = (pid) => {
	if (!(pid > 0)) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
/** Take the lock; true when it took over one that a dead daemon left. */
function lockSpawnDir() {
	for (let attempt = 0; attempt < 2; attempt++) {
		try { writeFileSync(LOCK, LOCK_TEXT, { flag: "wx", mode: 0o600 }); return attempt > 0; }
		catch (error) { if (error.code !== "EEXIST") throw new Error(`cannot create ${LOCK}: ${error.message}`); }
		const { pid, boot } = readLock();
		if (boot === BOOT_ID && isRunning(pid)) throw new Error(`another claude-remote-daemon (pid ${pid}) runs Claude Code in ${SPAWN_CWD_REAL}; give this one its own --spawn-cwd and --tmp-dir, or delete ${LOCK} if pid ${pid} is no such daemon`);
		rmSync(LOCK, { force: true });
	}
	throw new Error(`could not lock ${SPAWN_CWD_REAL}`);
}
let tookOver = false;
try { tookOver = lockSpawnDir(); } catch (error) { fatal(error.message); }
// The socket the daemon listens on, once it does (see the end of this file).
let removeSocket = () => {};
const cleanUp = () => {
	try { if (lockHolder() === process.pid) rmSync(LOCK); } catch {}
	removeSocket();
};
process.on("exit", cleanUp);
// A service manager stops the daemon with SIGTERM, a terminal with SIGINT
// (Ctrl-C) or SIGHUP (closed).
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => { cleanUp(); process.kill(process.pid, signal); });
// Two daemons that find the same dead lock can each remove it and write their
// own. The one whose lock is gone a moment later stops.
if (tookOver) {
	await new Promise((resolve) => setTimeout(resolve, 500));
	if (lockHolder() !== process.pid) fatal(`another claude-remote-daemon (pid ${lockHolder()}) took over ${LOCK} at the same time`);
}

/** Keep the lock while the daemon runs: refresh its times, which a /tmp cleaner
 *  goes by (the default spawn directory is in /tmp), and put it back if
 *  something removed it. Called before every run and every 6 hours. */
function holdLock() {
	try {
		if (lockHolder() === process.pid) {
			const now = new Date();
			return utimesSync(LOCK, now, now);
		}
		writeFileSync(LOCK, LOCK_TEXT, { flag: "wx", mode: 0o600 });
		log(`put back ${LOCK}, which something removed`);
	} catch (error) {
		log(`warning: cannot hold ${LOCK}: ${error.code === "EEXIST" ? `it names pid ${lockHolder()}, so another daemon may use ${SPAWN_CWD_REAL}` : error.message}`);
	}
}

const CLAUDE_ENV = claudeCodeEnv({ agentSdkVersion: AGENT_SDK_VERSION, tmpDir: CC_TMPDIR });

// Set by a Claude Code session on its children. When the daemon itself was
// started from one they describe that session (same list as src/cc-child.ts).
const PARENT_SESSION_VARS = [
	"CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
	"CLAUDE_PID", "CLAUDE_EFFORT", "TRACEPARENT", "CLAUDE_CODE_INVOKED_SKILLS", "CLAUDE_ENV_FILE",
	"CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EXECPATH",
	"CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
];

function claudeEnv() {
	const env = { ...process.env };
	if (env.CLAUDECODE) for (const name of PARENT_SESSION_VARS) delete env[name];
	// The daemon's own secret.
	delete env.CLAUDE_REMOTE_TOKEN;
	return { ...env, ...CLAUDE_ENV };
}

// The snapshot Claude Code computes on B: its spawn directory, B's machine and
// the $SHELL Claude Code gets. Computed before each run, so a change on B
// (a git repository above the spawn directory, a new kernel) is picked up.
const bSnapshot = () => localSnapshot(SPAWN_CWD_REAL, claudeEnv());

// Claude Code's version, which seeded records carry as the ones it writes do.
// The snapshot and text in env-block.mjs are checked against the tested
// versions only.
let CLAUDE_VERSION;
try { CLAUDE_VERSION = /^\S+/.exec(execFileSync(CLAUDE, ["--version"], { env: claudeEnv(), encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim())[0]; }
catch (error) { fatal(`could not run ${CLAUDE} --version: ${String(error.message).split("\n")[0]}`); }
if (!TESTED_CLAUDE_VERSIONS.includes(CLAUDE_VERSION)) {
	log(`warning: Claude Code ${CLAUDE_VERSION} is untested (tested: ${TESTED_CLAUDE_VERSIONS.join(", ")}); if it shows the model this machine's environment, the bridge warns about a leak`);
}

const PROJECT_DIR = join(CLAUDE_DIR, "projects", projectDirName(SPAWN_CWD_REAL));
// Claude Code's temporary files for the spawn directory, one folder per session.
const PROJECT_TMP = join(CC_TMPDIR, `claude-${UID}`, projectDirName(SPAWN_CWD_REAL));
// The daemon's notes on the session files it keeps (see "Stored sessions").
const NOTES_DIR = join(CLAUDE_DIR, "claude-remote", projectDirName(SPAWN_CWD_REAL));

const sessionFile = (id) => join(PROJECT_DIR, `${id}.jsonl`);
function removeSession(id) {
	rmSync(sessionFile(id), { force: true });
	for (const dir of [join(PROJECT_DIR, id), join(PROJECT_TMP, id), join(CLAUDE_DIR, "session-env", id)]) rmSync(dir, { recursive: true, force: true });
}

// B's own settings.json, and the CLAUDE.md, rules, skills, agents and commands
// in B's config directory, stay out of every run: hooks there would run on B
// with A's prompts and show their output to the model, and the rest describes
// B. OAuth login needs none of it. Anything else Claude Code needs (a proxy,
// Bedrock or Vertex variables) goes in the daemon's own environment.
const B_SETTING_SOURCES = "--setting-sources=";
const argsOnB = (args) => args.map((a) => (a.startsWith("--setting-sources=") ? B_SETTING_SOURCES : a));

// Claude Code 2.1.308 saves every image it is given and adds a line after it
// for the model, "[Image: source: <path>]": prompt images go to the session's
// images/ folder under its temporary directory, images in tool results to the
// session's tool-results/ folder, which also takes other binary tool output and
// oversized results. Those paths are on B, where the model's tools do not run.
// A plain file in place of each folder makes the save fail, and Claude Code
// then sends the image without the line. A prompt image it had to shrink keeps
// the "original WxH" note; an image in a tool result loses it (pi's read tool
// shrinks images and adds the same note itself).
function blockSavedFiles(id) {
	for (const path of [join(PROJECT_DIR, id, "tool-results"), join(PROJECT_TMP, id, "images")]) {
		try { if (statSync(path).isFile()) continue; } catch {}
		rmSync(path, { recursive: true, force: true });
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, "", { mode: 0o400 });
	}
}

// --- Session files ---

function envRecords(records) {
	return records.filter((r) => r.type === "attachment" && r.attachment?.type === "environment");
}

// Claude Code compares B's snapshot with its own, so it takes the record as
// current; the text describes A.
const seededEnvRecord = (sessionId, bSnap, aSnapshot) => environmentRecord({ sessionId, cwd: SPAWN_CWD_REAL, version: CLAUDE_VERSION, snapshot: bSnap, shown: aSnapshot });

/** The top record of each chain Claude Code could resume (up from a leaf, or
 *  from `forkAt`) that holds no environment record. On such a chain Claude
 *  Code would describe its own machine to the model. A parent that is not in
 *  the file, or a loop, ends a chain. */
function chainsWithoutEnvironment(records, forkAt) {
	const byUuid = new Map(records.filter((r) => typeof r.uuid === "string").map((r) => [r.uuid, r]));
	const parents = new Set(records.map((r) => r.parentUuid));
	const starts = [...byUuid.values()].filter((r) => !parents.has(r.uuid));
	if (byUuid.has(forkAt)) starts.push(byUuid.get(forkAt));
	const tops = new Set();
	for (let r of starts) {
		const seen = new Set();
		while (!(r.type === "attachment" && r.attachment?.type === "environment")) {
			seen.add(r);
			const parent = byUuid.get(r.parentUuid);
			if (!parent || seen.has(parent)) { tops.add(r); break; }
			r = parent;
		}
	}
	return [...tops];
}

/** A's transcript as B's Claude Code must see it. Returns the records and A's
 *  snapshot for every environment record the daemon vouched for, by uuid. */
function prepareForB(records, bSnap, sessionId, aSnapshot, forkAt) {
	const snapshots = {};
	for (const r of records) if (typeof r.cwd === "string") r.cwd = SPAWN_CWD_REAL;
	for (const r of envRecords(records)) {
		snapshots[r.uuid] = r.attachment.snapshot;
		r.attachment.snapshot = structuredClone(bSnap);
	}
	// Each chain without one hangs from a new record describing A. A file with
	// no chain at all starts from that record alone, like a new session.
	const tops = chainsWithoutEnvironment(records, forkAt);
	if (tops.length || !records.some((r) => typeof r.uuid === "string")) {
		const seed = seededEnvRecord(sessionId, bSnap, aSnapshot);
		for (const top of tops) top.parentUuid = seed.uuid;
		records.unshift(seed);
		snapshots[seed.uuid] = aSnapshot;
	}
	return { records, snapshots };
}

/** B's session file as A keeps it: as if Claude Code had run on A. Each line
 *  maps on its own, so A's copy plus the mapped appended lines is the mapping
 *  of the longer file. An environment record the daemon did not vouch for is a
 *  leak: Claude Code described B to the model. Leaks are listed with their byte
 *  offset in the result. */
function toA(bText, snapshots, aCwd) {
	const leaks = [];
	let offset = 0;
	let text = "";
	for (const r of parseJsonl(bText)) {
		if (r.cwd === SPAWN_CWD_REAL) r.cwd = aCwd;
		if (r.type === "attachment" && r.attachment?.type === "environment") {
			if (Object.hasOwn(snapshots, r.uuid)) r.attachment.snapshot = structuredClone(snapshots[r.uuid]);
			else leaks.push({ offset, uuid: r.uuid, rendered: r.rendered });
		}
		const line = toJsonl([r]);
		text += line;
		offset += Buffer.byteLength(line);
	}
	return { bytes: Buffer.from(text, "utf8"), leaks };
}

// --- Stored sessions ---

// After a provider run B keeps the session file Claude Code wrote, and a note
// of what A holds: the hash and length of A's copy (B's file as returned,
// toA), A's directory, A's snapshot for each vouched environment record, and
// B's snapshot, which the file's environment records hold.
// The next resume runs B's file only when A's copy hashes the same, which A
// can only show by holding the same bytes, so B never runs or returns a
// session A does not already have. A copy that differs, for example after a
// run whose result never reached A, is sent again (the transcript message).
//
// A note exists only between runs: it is removed when a run starts and written
// when it ends. Files without a note (a run that died, a summary) are swept.

const notePath = (id) => join(NOTES_DIR, `${id}.json`);
function readNote(id) {
	try { return JSON.parse(readFileSync(notePath(id), "utf8")); } catch { return null; }
}
function forget(id) {
	rmSync(notePath(id), { force: true });
	removeSession(id);
}

/** B's copy of `id`, if it is the copy A holds and B's snapshot is unchanged
 *  since (otherwise Claude Code would announce the change). */
function storedCopy(id, have, aCwd, bSnap) {
	const note = readNote(id);
	if (!note || note.aHash !== have || note.aCwd !== aCwd || JSON.stringify(note.bSnapshot) !== JSON.stringify(bSnap)) return null;
	try { if (statSync(sessionFile(id)).size !== note.bLength) return null; } catch { return null; }
	return note;
}

/** Note what A will hold of `id` and return the part A lacks: what follows
 *  `base` (A's copy when the run started) if B's file, mapped for A, still
 *  starts with it; otherwise all of it. */
function store(id, base, snapshots, aCwd, bSnap) {
	const b = readFileSync(sessionFile(id));
	const { bytes, leaks } = toA(b.toString("utf8"), snapshots, aCwd);
	const from = base && base.length <= bytes.length && sha256(bytes.subarray(0, base.length)) === base.hash ? base.length : 0;
	// Someone may have removed the notes while the daemon runs.
	mkdirSync(NOTES_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(notePath(id), JSON.stringify({ aHash: sha256(bytes), aLength: bytes.length, bLength: b.length, aCwd, bSnapshot: bSnap, snapshots }), { mode: 0o600 });
	return { from, bytes: bytes.subarray(from), leaks: leaks.filter((l) => l.offset >= from).map(({ offset, ...l }) => l) };
}

/** Remove files without a note, notes without a file, and sessions unused for
 *  --keep-days or made with another B snapshot. */
function sweep(bSnap) {
	mkdirSync(NOTES_DIR, { recursive: true, mode: 0o700 });
	const old = Date.now() - KEEP_DAYS * 86400_000;
	for (const name of readdirSync(NOTES_DIR)) {
		const id = name.replace(/\.json$/, "");
		if (busy.has(id)) continue;
		const note = readNote(id);
		if (!note || !existsSync(sessionFile(id)) || statSync(notePath(id)).mtimeMs < old || JSON.stringify(note.bSnapshot) !== JSON.stringify(bSnap)) forget(id);
	}
	for (const dir of [PROJECT_DIR, PROJECT_TMP]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			const id = name.replace(/\.jsonl$/, "");
			if (busy.has(id) || existsSync(notePath(id))) continue;
			if (UUID.test(id)) removeSession(id);
			else rmSync(join(dir, name), { recursive: true, force: true });
		}
	}
}

/** Sessions a run is using, each with that run (see takeOver). */
const busy = new Map();

// --- What a client may ask for ---

// The request is data, not a command line: B builds Claude Code's arguments
// itself (protocol.mjs claudeArgs), so A cannot turn on Claude Code's own
// tools, MCP servers, plugins or hooks here. Anything outside REQUEST_KEYS is
// refused, environment variables and arguments included.
const SNAPSHOT_KEYS = { workingDirectory: "string", isWorktree: "boolean", isGitRepo: "boolean", additionalWorkingDirectories: "object", platform: "string", shell: "string", osVersion: "string" };
function validateRequest(hello) {
	const unknown = Object.keys(hello).filter((k) => !REQUEST_KEYS.has(k));
	if (unknown.length) throw new Error(`request fields not accepted: ${unknown.join(", ")}`);
	if (hello.kind !== "provider" && hello.kind !== "summary") throw new Error("kind must be provider or summary");
	if (typeof hello.model !== "string" || !MODEL.test(hello.model)) throw new Error("model is not a Claude model id");
	if (hello.thinking !== undefined && !THINKING.has(hello.thinking)) throw new Error("thinking must be low, medium, high, xhigh, max or off");
	const session = hello.session ?? {};
	const sessionKeys = Object.keys(session).filter((k) => session[k] !== undefined);
	for (const k of sessionKeys) {
		if (!["resume", "sessionId", "forkAt"].includes(k)) throw new Error(`session.${k} not accepted`);
		if (typeof session[k] !== "string" || !UUID.test(session[k])) throw new Error(`session.${k} must be a UUID`);
	}
	const snapshot = hello.a?.snapshot;
	if (typeof snapshot !== "object" || snapshot === null || Object.keys(hello.a).length !== 1) throw new Error("a must hold only the environment snapshot");
	for (const [k, v] of Object.entries(snapshot)) {
		if (SNAPSHOT_KEYS[k] === undefined) throw new Error(`snapshot field ${k} not accepted`);
		if (typeof v !== SNAPSHOT_KEYS[k] || (k === "additionalWorkingDirectories" && (!Array.isArray(v) || v.some((d) => typeof d !== "string")))) throw new Error(`snapshot field ${k} has the wrong type`);
	}
	const missing = Object.keys(SNAPSHOT_KEYS).filter((k) => !Object.hasOwn(snapshot, k));
	if (missing.length) throw new Error(`snapshot needs ${missing.join(", ")}`);
	if ((hello.have !== undefined) !== (session.resume !== undefined)) throw new Error("have goes with session.resume, and only with it");
	if (hello.have !== undefined && (typeof hello.have !== "string" || !SHA256.test(hello.have))) throw new Error("have must be a SHA-256 hex digest");
}

// --- Claude Code's stdin ---

// stdin carries the Agent SDK's stream-json from A: prompts, the control
// channel, and A's answers to Claude Code's calls into pi's tools. Claude Code
// takes much more there, and acts on B: `bash_command` runs a shell command,
// control requests add MCP servers (a stdio server is a command), change
// settings, the working directory or the model, read files, load plugins and
// hooks. The daemon passes only what the bridge's SDK sends and ends the run
// on anything else, before Claude Code sees it.
//
// Claude Code also expands `@path` in a prompt from its own machine and
// dispatches slash commands, B's custom commands included. A prompt marked
// `client_composed` is delivered as written. The bridge sets it on A
// (verbatimPrompts), but B cannot rely on that, so every prompt and steer A
// sends is marked here.

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const otherKeys = (o, allowed) => Object.keys(o).filter((k) => !allowed.includes(k));
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
const quoted = (v) => JSON.stringify(String(v).slice(0, 40));

// A pi prompt or steer: text and images. The bridge sends images inline
// (base64); one given by URL or file id would be fetched by the API, the file
// from B's account.
const USER_KEYS = ["type", "message", "parent_tool_use_id", "uuid", "session_id", "priority", "client_composed"];
const PRIORITY = ["now", "next", "later"];
const promptBlock = (b) => isObject(b) && (
	b.type === "text" ? !otherKeys(b, ["type", "text"]).length && typeof b.text === "string"
	: b.type === "image" && !otherKeys(b, ["type", "source"]).length && isObject(b.source) && b.source.type === "base64"
		&& !otherKeys(b.source, ["type", "media_type", "data"]).length && typeof b.source.media_type === "string" && typeof b.source.data === "string");
// The SDK's initialize request, as the bridge fills it: a provider query names
// pi's tool server and lists its tools and appends to the system prompt; a
// summary query sets its own system prompt and no skills. The rest of the
// request (hooks, agents, plugins, ...) is refused.
const INITIALIZE = {
	subtype: () => true,
	sdkMcpServers: strings,
	sdkMcpServerManifests: (v) => isObject(v) && Object.values(v).every((m) => isObject(m) && !otherKeys(m, ["initializeResult", "toolsListResult"]).length),
	appendSystemPrompt: (v) => typeof v === "string",
	systemPrompt: strings,
	skills: (v) => Array.isArray(v) && v.length === 0,
};

/** Why a stdin message may not reach Claude Code, or undefined if it may. */
function stdinRefusal(m) {
	if (!isObject(m)) return "not a JSON object";
	if (m.type === "user") {
		const extra = otherKeys(m, USER_KEYS);
		if (extra.length) return `user message field ${quoted(extra[0])}`;
		const { message } = m;
		if (!isObject(message) || message.role !== "user" || otherKeys(message, ["role", "content"]).length) return "user message shape";
		if (typeof message.content !== "string" && !(Array.isArray(message.content) && message.content.every(promptBlock))) return "user message content";
		if (m.parent_tool_use_id !== null || (m.priority !== undefined && !PRIORITY.includes(m.priority))) return "user message fields";
		if ([m.uuid, m.session_id].some((v) => v !== undefined && typeof v !== "string")) return "user message fields";
		return undefined;
	}
	if (m.type === "control_request") {
		const { request } = m;
		if (otherKeys(m, ["type", "request_id", "request"]).length || typeof m.request_id !== "string" || !isObject(request)) return "control request shape";
		if (request.subtype === "interrupt") return otherKeys(request, ["subtype"]).length ? "interrupt fields" : undefined;
		if (request.subtype !== "initialize") return `control request ${quoted(request.subtype)}`;
		const bad = Object.keys(request).find((k) => !Object.hasOwn(INITIALIZE, k) || !INITIALIZE[k](request[k]));
		return bad === undefined ? undefined : `initialize field ${quoted(bad)}`;
	}
	if (m.type === "control_response") {
		// The SDK answers Claude Code's calls into pi's tools (mcp_message), or
		// reports an error.
		const r = m.response;
		if (otherKeys(m, ["type", "response"]).length || !isObject(r) || typeof r.request_id !== "string") return "control response shape";
		if (r.subtype === "success" && !otherKeys(r, ["subtype", "request_id", "response"]).length && isObject(r.response) && !otherKeys(r.response, ["mcp_response"]).length) return undefined;
		if (r.subtype === "error" && !otherKeys(r, ["subtype", "request_id", "error"]).length && typeof r.error === "string") return undefined;
		return "control response other than a tool server answer or an error";
	}
	return `message type ${quoted(m.type)}`;
}

// stdin is JSON lines. A line that does not parse, or that stdinRefusal turns
// down, ends the run; nothing after it reaches Claude Code.
function composedStdin(write, refuse) {
	const text = new StringDecoder("utf8");
	let buffered = "";
	let stopped = false;
	const line = (raw) => {
		if (stopped || !raw.trim()) return;
		let message;
		try { message = JSON.parse(raw); }
		catch { stopped = true; refuse("stdin line is not JSON"); return; }
		const refusal = stdinRefusal(message);
		if (refusal) { stopped = true; refuse(`stdin message refused (${refusal})`); return; }
		if (message.type === "user") message.client_composed = true;
		write(`${JSON.stringify(message)}\n`);
	};
	return {
		push(chunk) {
			buffered += text.write(chunk);
			let newline;
			while ((newline = buffered.indexOf("\n")) >= 0) {
				line(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
			}
		},
		end() {
			line(buffered + text.end());
			buffered = "";
		},
	};
}

// --- Connections ---

// What the Agent SDK stops Claude Code with.
const KILL_SIGNALS = new Set(["SIGTERM", "SIGKILL"]);
// How long B waits for A: for the spawn message once the connection opens,
// and between pieces of A's copy of the session once it is coming.
const WAIT_MS = 10_000;
// How long B waits for the first piece of A's copy after asking for it.
const FIRST_PIECE_MS = 60_000;
// Claude Code's output waits while this much is queued for A.
const HIGH_WATER_BYTES = 8 * 1024 * 1024;
const TOKEN_DIGEST = createHash("sha256").update(TOKEN).digest();
// Connections whose run has not ended: --max-runs caps these.
let runs = 0;
// How long the connection of a run that holds a session has to answer a ping
// before A's new run of that session replaces it, and how long the old run
// then has to end.
const REPLY_MS = 5_000;
const RELEASE_MS = 15_000;

/** Free `ids` for a new run. A runs one query per session at a time, so a run
 *  that still holds one of them belongs to a connection A has given up on: one
 *  that died without closing (an ssh tunnel that went away) stays open here
 *  until the keepalive drops it, 20 to 40 seconds later. A holder whose
 *  connection answers a ping keeps its session; the others are stopped.
 *  Resolves true once the ids are free. */
async function takeOver(holders, ids) {
	const answers = await Promise.all([...holders].map((holder) => holder.answers(REPLY_MS)));
	if (answers.some(Boolean)) return false;
	for (const holder of holders) holder.replace();
	for (const deadline = Date.now() + RELEASE_MS; ids.some((id) => busy.has(id));) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return true;
}

/** [HTTP status, reason] when an upgrade request may not become a WebSocket.
 *  The token comes first, so a client without it learns nothing else. */
function upgradeRefusal(req) {
	const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
	if (!timingSafeEqual(createHash("sha256").update(bearer).digest(), TOKEN_DIGEST)) return [401, "no valid token"];
	// Browsers send an Origin and the bridge does not: no web page gets in.
	if (req.headers.origin !== undefined) return [403, `origin ${quoted(req.headers.origin)}`];
	let path = null;
	try { path = new URL(req.url, "http://b").pathname; } catch {}
	if (path !== PATH) return [404, `path ${quoted(req.url)}`];
	const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
	if (!offered.includes(SUBPROTOCOL)) return [400, `subprotocol ${quoted(offered.join(","))}`];
	if (runs >= MAX_RUNS) return [503, `${runs} runs already`];
	return undefined;
}

// ws compresses every message: with context takeover it applies no size threshold.
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: true, handleProtocols: () => SUBPROTOCOL });

function onUpgrade(req, socket, head) {
	socket.on("error", () => {});
	const refusal = upgradeRefusal(req);
	if (refusal) {
		const [status, reason] = refusal;
		log(`refused connection from ${req.socket.remoteAddress ?? "the socket"}: ${status} ${reason}`);
		socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		runs++;
		// A run ends when its exit message leaves, or its connection closes first.
		// The close comes later, after the closing handshake.
		let running = true;
		const ended = () => { if (running) { running = false; runs--; } };
		ws.on("close", ended);
		handle(ws, socket, ended);
	});
}

// Anything but a WebSocket upgrade.
function onRequest(req, res) {
	res.writeHead(upgradeRefusal(req)?.[0] === 401 ? 401 : 426, { Connection: "close" }).end();
}

function handle(ws, socket, ended) {
	let child = null;
	let hello = null;
	// B's snapshot, while B waits for A's copy of the session.
	let awaiting = null;
	let claimed = [];
	// Set once the run failed or its exit message is on its way; nothing A sends
	// counts after that.
	let done = false;
	// Why the daemon stopped Claude Code, for A to report.
	let stopReason;
	// Bytes from A, which tell a session file on its way from silence.
	let received = 0;
	socket.on("data", (chunk) => { received += chunk.length; });
	// Whether a message may go to A now. One sent in the middle of a session file
	// (sendChannel) would become part of it; the file goes only after Claude Code
	// has closed, so that would be a bug here, and the message is dropped.
	const canSend = () => {
		if (ws.readyState !== ws.OPEN) return false;
		if (!sending(ws)) return true;
		log(`dropped a message for pid=${child?.pid ?? "-"}: it came while a session file was on its way`);
		return false;
	};
	const sendJson = (message) => { if (canSend()) ws.send(JSON.stringify(message)); };
	// Ends the connection; a running Claude Code is stopped when it closes.
	const fail = (message) => {
		if (done) return;
		done = true;
		clearTimeout(waiting);
		sendJson({ type: "exit", code: 1, signal: null, error: message, files: {} });
		ws.close(4000, Buffer.from(message).subarray(0, 120).toString());
		setTimeout(() => ws.terminate(), 1000).unref();
	};
	// The spawn message must come within WAIT_MS. When B asks for A's copy of
	// the session, its first KB must come within FIRST_PIECE_MS, and then at
	// least 1 KB per WAIT_MS (pings alone are a few bytes); a large copy on a slow
	// link takes long.
	let waiting = setTimeout(() => fail("no spawn message"), WAIT_MS);
	keepAlive(ws, socket, KEEPALIVE_MS, (seconds) => log(`dropped a connection (pid=${child?.pid ?? "-"}): nothing came from it for ${seconds} seconds`));
	// What another connection's takeOver asks of this run: whether its connection
	// still answers, and to stop for a new run of its session.
	const run = {
		answers: (ms) => new Promise((resolve) => {
			if (ws.readyState !== ws.OPEN) return resolve(false);
			const heard = () => { clearTimeout(timer); resolve(true); };
			const timer = setTimeout(() => { socket.off("data", heard); resolve(false); }, ms);
			socket.once("data", heard);
			ws.ping();
		}),
		replace: () => {
			log(`replaced pid=${child?.pid ?? "-"}: its connection stopped answering, and A started another run of its session`);
			fail("another run of this session replaced it");
			if (child) child.kill("SIGTERM");
			else release();
		},
	};
	const claim = (ids) => { for (const id of ids) busy.set(id, run); claimed.push(...ids); };
	const release = () => { for (const id of claimed) if (busy.get(id) === run) busy.delete(id); claimed = []; };

	// Claude Code's output waits while A is behind.
	let held = false;
	const out = (channel, bytes) => {
		if (!canSend()) return;
		ws.send(channelMessage(channel, bytes), () => {
			if (held && ws.bufferedAmount < HIGH_WATER_BYTES / 2) { held = false; child.stdout.resume(); child.stderr.resume(); }
		});
		if (!held && child && ws.bufferedAmount > HIGH_WATER_BYTES) { held = true; child.stdout.pause(); child.stderr.pause(); }
	};
	const io = {
		out,
		claim,
		release,
		spawned: (pid) => sendJson({ type: "spawned", pid }),
		// `file` is what A lacks of the session file, sent ahead of the exit
		// message, whose `files` names it.
		exit: (result, file) => {
			ended();
			done = true;
			ws.resume();
			if (ws.readyState !== ws.OPEN) return;
			const message = JSON.stringify({ type: "exit", ...result, ...(stopReason ? { error: stopReason } : {}) });
			// Close once the exit message has left: closing starts a 30-second timer
			// that cuts off what is still unsent.
			const exit = () => ws.send(message, () => ws.close(1000));
			if (file) sendChannel(ws, CHANNEL.file, file, (error) => { if (!error) exit(); });
			else exit();
		},
	};
	const launch = (bSnap, stored, upload) => { child = start(hello, bSnap, stored, upload, io); };

	function spawnRequest(request) {
		clearTimeout(waiting);
		try { validateRequest(request); } catch (error) { return fail(error.message); }
		hello = request;
		const ids = [hello.session?.resume, hello.session?.sessionId].filter(Boolean);
		const holders = new Set(ids.map((id) => busy.get(id)).filter(Boolean));
		if (!holders.size) return begin(ids);
		takeOver(holders, ids).then((free) => {
			if (done || ws.readyState !== ws.OPEN) return;
			if (free && !ids.some((id) => busy.has(id))) begin(ids);
			else fail("session in use by another run");
		});
	}

	function begin(ids) {
		claim(ids);
		try {
			checkDirs();
			const bSnap = bSnapshot();
			const { resume } = hello.session ?? {};
			if (!resume) return launch(bSnap, null, null);
			const stored = storedCopy(resume, hello.have, hello.a.snapshot.workingDirectory, bSnap);
			if (stored) return launch(bSnap, stored, null);
			awaiting = bSnap;
			sendJson({ type: "need" });
			const before = received;
			let seen = received;
			let waited = 0;
			waiting = setInterval(() => {
				waited += WAIT_MS;
				const coming = received - before >= 1024;
				if (received - seen < 1024 && (coming || waited >= FIRST_PIECE_MS)) fail("the session file did not arrive");
				seen = received;
			}, WAIT_MS);
		} catch (error) {
			log(`run refused: ${error.message}`);
			fail(error.message);
		}
	}

	// What is meant for Claude Code (stdin, stdin-end, kill) comes only once it
	// runs, so nothing is held for one that has not started.
	function message(data, isBinary) {
		if (!isBinary) {
			const m = json(data);
			if (!isObject(m)) throw new Error("not a JSON object");
			if (!hello) return m.type === "spawn" ? spawnRequest(m) : fail("expected a spawn message");
			if (m.type !== "stdin-end" && m.type !== "kill") throw new Error(`message type ${quoted(m.type)}`);
			const signal = m.signal ?? "SIGTERM";
			if (m.type === "kill" && !KILL_SIGNALS.has(signal)) throw new Error(`signal ${quoted(signal)} not accepted`);
			if (!child) throw new Error(`${m.type} before Claude Code started`);
			if (m.type === "kill") child.kill(signal);
			else { stdin.end(); child.stdin.end(); }
			return;
		}
		if (!hello) return fail("expected a spawn message");
		const bytes = data.subarray(1);
		if (data[0] === CHANNEL.transcript) {
			if (!awaiting || child) return fail("unexpected transcript");
			clearInterval(waiting);
			const bSnap = awaiting;
			awaiting = null;
			try { return launch(bSnap, null, bytes); }
			catch (error) {
				log(`run refused: ${error.message}`);
				return fail(error.message);
			}
		}
		if (data[0] !== CHANNEL.stdin) throw new Error(`channel ${data[0]}`);
		if (!child) throw new Error("stdin before Claude Code started");
		stdin.push(bytes);
	}

	ws.on("message", (data, isBinary) => {
		if (done) return;
		try { message(data, isBinary); } catch (error) { fail(`bad message: ${error.message}`); }
	});
	// Claude Code's stdin takes A's lines as fast as it reads them.
	let draining = false;
	const stdin = composedStdin((line) => {
		if (child.stdin.write(line) || draining) return;
		draining = true;
		ws.pause();
		child.stdin.once("drain", () => { draining = false; ws.resume(); });
	}, (reason) => {
		stopReason = reason;
		log(`refused pid=${child.pid}: ${reason}`);
		out(CHANNEL.stderr, `claude-remote: ${reason}; run stopped\n`);
		child.kill("SIGTERM");
	});
	ws.on("error", (error) => log(`connection error: ${error.message}`));
	ws.on("close", () => {
		clearTimeout(waiting);
		if (!child) { release(); return; }
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000).unref();
		}
	});
}

/**
 * Run Claude Code for a request. `bSnap` is B's snapshot. `stored` is B's
 * matching copy of the session to resume, or `upload` is A's copy (the
 * transcript message); neither for a fresh session or a summary. `io` reaches A
 * and marks the sessions the run uses.
 */
function start(hello, bSnap, stored, upload, io) {
	const { kind, model, thinking } = hello;
	const { resume, sessionId, forkAt } = hello.session ?? {};
	const aSnapshot = hello.a.snapshot;
	const aCwd = aSnapshot.workingDirectory;
	mkdirSync(PROJECT_DIR, { recursive: true, mode: 0o700 });

	let snapshots;
	let base = null;
	let opened;
	let target;
	let session;
	let copy;
	if (resume) {
		if (kind !== "provider") throw new Error("a summary query does not resume a session");
		if (forkAt ? !sessionId : sessionId) throw new Error("a fork needs session.sessionId and session.forkAt together");
		if (stored) {
			snapshots = stored.snapshots;
			base = { hash: stored.aHash, length: stored.aLength };
			copy = "stored";
		} else {
			const prepared = prepareForB(parseJsonl(upload.toString("utf8")), bSnap, resume, aSnapshot, forkAt);
			snapshots = prepared.snapshots;
			writeFileSync(sessionFile(resume), toJsonl(prepared.records), { mode: 0o600 });
			base = { hash: sha256(upload), length: upload.length };
			copy = `sent(${upload.length})`;
		}
		opened = resume;
		target = forkAt ? sessionId : resume;
		session = { resume, forkAt, sessionId };
	} else {
		// A fresh conversation, or a summary, starts from a file holding only
		// A's environment record, so the first request already shows A.
		if (forkAt) throw new Error("session.forkAt needs session.resume");
		if (kind === "summary" && sessionId) throw new Error("a summary query has no session");
		opened = sessionId ?? randomUUID();
		const seed = seededEnvRecord(opened, bSnap, aSnapshot);
		snapshots = { [seed.uuid]: aSnapshot };
		writeFileSync(sessionFile(opened), toJsonl([seed]), { mode: 0o600 });
		target = kind === "provider" ? opened : null;
		session = { resume: opened };
		copy = "seeded";
	}
	// A fork writes a new file, and A asked for that id fresh.
	if (target && target !== opened) forget(target);
	const inUse = [opened, target].filter(Boolean);
	io.claim(inUse);
	for (const id of inUse) {
		rmSync(notePath(id), { force: true });
		blockSavedFiles(id);
	}

	const args = argsOnB(claudeArgs({ kind, model, thinking, ...session }));
	const child = spawn(CLAUDE, args, { cwd: SPAWN_CWD_REAL, env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"] });
	// A child that could not start (its binary gone, say) has no pid, and its
	// error event says why.
	const started = child.pid !== undefined;
	let startError = "";
	if (started) log(`spawn pid=${child.pid} kind=${kind} opened=${opened} target=${target ?? "-"} copy=${copy}`);
	child.stdout.on("data", (d) => io.out(CHANNEL.stdout, d));
	child.stderr.on("data", (d) => io.out(CHANNEL.stderr, d));
	child.stdin.on("error", () => {});
	child.on("error", (error) => {
		if (started) io.out(CHANNEL.stderr, `claude-remote: ${error.message}\n`);
		else startError = error.message;
	});
	child.on("spawn", () => io.spawned(child.pid));
	child.on("close", (code, signal) => {
		const files = {};
		let file = null;
		let leaks = [];
		// Why the run failed on B, for A to report: Claude Code did not start, or
		// its session file cannot go back (the bridge needs it after every turn).
		let error = started ? undefined : `could not start Claude Code: ${startError}`;
		try {
			if (started && kind === "provider") {
				// A fork leaves its parent as it was; keep it for the next resume.
				if (target !== opened && existsSync(sessionFile(opened))) store(opened, base, snapshots, aCwd, bSnap);
				if (existsSync(sessionFile(target))) {
					const back = store(target, target === opened ? base : null, snapshots, aCwd, bSnap);
					files[target] = { from: back.from, length: back.bytes.length };
					file = back.bytes;
					leaks = back.leaks;
				}
			}
		} catch (failure) {
			error = `could not return the session file: ${failure.message}`;
		}
		if (kind !== "provider") removeSession(opened);
		io.release();
		if (leaks.length) log(`LEAK pid=${child.pid}: ${leaks.length} record(s) describe B: ${JSON.stringify(leaks).slice(0, 300)}`);
		if (!started) log(`${error} (${CLAUDE}; session ${opened})`);
		else {
			const returned = Object.entries(files).map(([id, f]) => `${id}(${f.from ? `+${f.length} after ${f.from}` : f.length})`).join(",");
			log(`exit pid=${child.pid} code=${code} signal=${signal} returned=${returned || "-"}${error ? ` (${error})` : ""}`);
		}
		io.exit({ code, signal, files, leaks, ...(error ? { error } : {}) }, file);
	});
	return child;
}

sweep(bSnapshot());
setInterval(() => {
	holdLock();
	try { sweep(bSnapshot()); } catch (error) { log(`sweep failed: ${error.message}`); }
}, 6 * 3600_000).unref();
// Before the token is checked a client gets only Node's header limits, 10
// seconds to send its request (Node alone would let a connection that sends
// nothing stay, and checks its timeouts every 30 seconds), and room for 32
// such connections beside the runs. A WebSocket clears the idle timeout.
const server = createServer({ connectionsCheckingInterval: 1000 });
server.headersTimeout = 10_000;
server.requestTimeout = 10_000;
server.timeout = 10_000;
server.maxConnections = MAX_RUNS + 32;
server.on("upgrade", onUpgrade);
server.on("request", onRequest);
server.on("error", (error) => {
	if (!server.listening) fatal(`cannot listen on ${SOCKET ?? LISTEN}: ${error.message}`);
	log(`server error: ${error.message}`);
});
const listening = () => {
	const url = SOCKET ? `ws+unix://${SOCKET}${PATH === "/" ? "" : `:${PATH}`}` : `ws://${HOST.includes(":") ? `[${HOST}]` : HOST}:${server.address().port}${PATH}`;
	log(`claude-remote listening on ${url}, spawn cwd ${SPAWN_CWD_REAL}, claude=${CLAUDE} (${CLAUDE_VERSION}), B snapshot ${JSON.stringify(bSnapshot())}`);
};
if (SOCKET) {
	// A socket left by a daemon that died is taken over; one that still answers
	// belongs to a daemon that runs. Anything else at the path stays.
	const left = (() => { try { return lstatSync(SOCKET); } catch { return null; } })();
	if (left) {
		if (!left.isSocket() || left.uid !== UID) fatal(`${SOCKET} exists and is not a socket of this user; remove it or give --listen another path`);
		const answers = await new Promise((resolve) => connect(SOCKET).on("connect", function () { this.destroy(); resolve(true); }).on("error", () => resolve(false)));
		if (answers) fatal(`another process listens on ${SOCKET}`);
		rmSync(SOCKET);
	}
	server.listen(SOCKET, () => {
		// Other users may not connect to it either (Linux checks a socket's mode).
		chmodSync(SOCKET, 0o600);
		const { ino } = statSync(SOCKET);
		removeSocket = () => { try { if (statSync(SOCKET).ino === ino) rmSync(SOCKET); } catch {} };
		listening();
	});
} else server.listen(PORT, HOST, listening);
