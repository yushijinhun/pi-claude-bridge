// Tool results for a Claude Code running on another machine (provider.remote).
//
// Claude Code saves a tool result over 50,000 characters to its own session
// directory and shows the model that path instead (measured on 2.1.308: 50,000
// inline, 50,001 saved). Remotely that path is on the other machine, where pi's
// read tool cannot reach it, so cap the text here and keep the full output on
// this machine. pi's bash and read stop at 50KB, which can still be over the
// limit; the cut is taken from the middle so their start and their trailing
// truncation notes both survive.
//
// The full output is saved the way pi saves its own (utils/output-files.js in
// pi-coding-agent): a new file with a random name in the OS temp directory,
// readable only by the user, and created with `wx` so a link someone else
// placed at the path is never followed.

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpResult } from "./extract-tool-results.js";

const CLAUDE_CODE_INLINE_LIMIT = 50_000;
const MARKER_ROOM = 300;

export function capRemoteResult(result: McpResult): McpResult {
	const texts = result.content.filter((block) => block.type === "text") as { type: "text"; text: string }[];
	const text = texts.map((block) => block.text).join("\n");
	if (text.length <= CLAUDE_CODE_INLINE_LIMIT) return result;
	const file = join(tmpdir(), `pi-claude-bridge-${randomBytes(8).toString("hex")}.txt`);
	writeFileSync(file, text, { mode: 0o600, flag: "wx" });
	const keep = CLAUDE_CODE_INLINE_LIMIT - MARKER_ROOM;
	const head = text.slice(0, Math.ceil(keep / 2));
	const tail = text.slice(text.length - Math.floor(keep / 2));
	const marker = `\n[... ${text.length - head.length - tail.length} of ${text.length} characters omitted here. Full output saved to ${file} ...]\n`;
	const others = result.content.filter((block) => block.type !== "text");
	return { ...result, content: [{ type: "text", text: head + marker + tail }, ...others] };
}
