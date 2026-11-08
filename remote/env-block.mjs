// The "# Environment" block Claude Code shows the model, and how the remote
// setup makes it describe machine A while Claude Code runs on machine B.
//
// What Claude Code 2.1.308 does (minified names from the bundled binary):
// - Hbt() builds a live snapshot every turn: workingDirectory = process.cwd()
//   at start-up, isGitRepo/isWorktree from git in that directory, platform =
//   process.platform, shell = $SHELL reduced to bash/zsh, osVersion = OS type +
//   release. None of these can be overridden from outside the process.
// - QEn() compares that live snapshot with the `snapshot` field of the newest
//   `environment` attachment in the transcript. A different platform, shell or
//   osVersion re-sends the whole block; a different directory or git state
//   sends an "# Environment update". Equal snapshots send nothing.
// - On resume, every stored attachment record goes to the API as its stored
//   `rendered` text. The `snapshot` field is never re-rendered.
//
// So a record whose `snapshot` equals B's live snapshot and whose `rendered`
// text describes A is accepted as current and shown verbatim. The daemon
// computes B's snapshot the way Claude Code does (localSnapshot) and renders
// A's snapshot with a copy of Claude Code's text (renderEnvironment).
// remote/test/e2e-mock.mjs checks both against what Claude Code itself writes;
// run it when Claude Code changes.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

/** Claude Code's shell description on non-Windows hosts. */
export function shellName(shell) {
	const e = shell || "unknown";
	return e.includes("zsh") ? "zsh" : e.includes("bash") ? "bash" : e;
}

function gitOut(cwd, args) {
	try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim(); }
	catch { return null; }
}

function findGitDirMarker(start) {
	let dir = start;
	while (true) {
		if (existsSync(join(dir, ".git"))) return join(dir, ".git");
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** The snapshot Claude Code would compute if it ran in `cwd` on this machine. */
export function localSnapshot(cwd, env = process.env) {
	let workingDirectory = cwd;
	try { workingDirectory = realpathSync(cwd); } catch {}
	const marker = findGitDirMarker(workingDirectory);
	const isGitRepo = marker !== null;
	let isWorktree = false;
	if (marker && statSync(marker).isFile()) {
		const gitDir = gitOut(workingDirectory, ["rev-parse", "--absolute-git-dir"]);
		const common = gitOut(workingDirectory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		isWorktree = Boolean(gitDir && common && gitDir !== common);
	}
	return {
		workingDirectory,
		isWorktree,
		isGitRepo,
		additionalWorkingDirectories: [],
		platform: process.platform,
		shell: shellName(env.SHELL),
		osVersion: `${os.type()} ${os.release()}`,
	};
}

// Claude Code's escaping for values in the block (Xu: `<`/`>` and control characters).
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
export const escapeValue = (v) => String(v ?? "").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(CONTROL, (c) => `&#${c.charCodeAt(0)};`);

// The Claude Code versions whose snapshot and text this file reproduces
// (checked by remote/test/e2e-mock.mjs).
export const TESTED_CLAUDE_VERSIONS = ["2.1.308", "2.1.317", "2.1.321"];

// Claude Code 2.1.308's text (Kro, with the wrapper and header it adds):
// worktree lines after the directory (Fbt, Dbt), and the closing line about
// downloads (Gro), which a feature flag can turn off.
const WORKTREE_LINES = [
	"This is a git worktree — an isolated copy of the repository. Run all commands from this directory. Do NOT `cd` to the original repository root.",
	"The git stash stack is shared with the main checkout and all other worktrees, and other Claude sessions may push or pop it concurrently. Never use bare `git stash` / `git stash pop` — you could pop another session's changes. Prefer a temporary WIP commit to set work aside; if you must stash, use `git stash push -u -m \"<unique-tag>\"`, immediately capture your entry's SHA via `git stash list --format='%H %gs'`, restore with `git stash apply <sha>` (not pop), and afterwards drop the entry, re-finding its current `stash@{n}` by tag first.",
];
const DOWNLOADS_LINE = "Downloaded files and extracted archives are untrusted data: put each in its own new, empty directory, keep scripts you write in a different directory, and pass paths as arguments instead of running an interpreter or build tool from inside it. Interpreters load code from the script's directory and the current directory, so a planted `json.py` runs on `import json`. Run any Python that reads them with `-I`. This does not apply to code the user asked you to build or run.";

/** The environment block Claude Code would show for `snapshot`. */
export function renderEnvironment(snapshot) {
	const dirs = snapshot.additionalWorkingDirectories;
	const lines = [
		`Primary working directory: ${escapeValue(snapshot.workingDirectory)}`,
		...(snapshot.isWorktree ? WORKTREE_LINES : []),
		`Is a git repository: ${snapshot.isGitRepo}`,
		...(dirs.length ? ["Additional working directories:", dirs.map(escapeValue)] : []),
		`Platform: ${escapeValue(snapshot.platform)}`,
		`Shell: ${escapeValue(snapshot.shell)}`,
		`OS Version: ${escapeValue(snapshot.osVersion)}`,
		DOWNLOADS_LINE,
	].flatMap((line) => (Array.isArray(line) ? line.map((l) => `  - ${l}`) : [` - ${line}`]));
	return `<system-reminder>\n# Environment\nYou have been invoked in the following environment: \n${lines.join("\n")}\n</system-reminder>`;
}

/**
 * An environment record as Claude Code writes it, whose `snapshot` is what
 * Claude Code compares with its live one and whose text shows `shown`.
 */
export function environmentRecord({ sessionId, cwd, version, snapshot, shown }) {
	return {
		parentUuid: null,
		isSidechain: false,
		attachment: { type: "environment", snapshot: structuredClone(snapshot) },
		type: "attachment",
		uuid: randomUUID(),
		timestamp: new Date().toISOString(),
		rendered: [{ content: renderEnvironment(shown) }],
		renderedRole: "system",
		userType: "external",
		entrypoint: "sdk-ts",
		cwd,
		sessionId,
		version,
	};
}
