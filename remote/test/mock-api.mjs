#!/usr/bin/env node
// Mock Anthropic Messages API for zero-cost probing of what Claude Code sends.
// Records every request body to OUT/req-NNNN.json (headers reduced to an allowlist).
//
//   node mock-api.mjs --port 8799 --out /tmp/cc-re/cap
//
// Scripted replies: if the newest user text contains MOCK_TOOL:<name>:<json>, and the
// request does not end in a tool_result, the reply is a tool_use for <name> with <json>
// input. After a tool_result the reply is text echoing the first 200 chars of it.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const PORT = Number(flag("port", 8799));
const OUT = flag("out", "/tmp/cc-re/cap");
mkdirSync(OUT, { recursive: true });
let seq = 0;
const KEEP_HEADERS = ["anthropic-beta", "anthropic-version", "user-agent", "x-app", "content-type"];

function lastUserText(body) {
	const msgs = body.messages ?? [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role !== "user") continue;
		const c = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
		const texts = c.filter((b) => b.type === "text").map((b) => b.text);
		if (texts.length) return { text: texts.join("\n"), msg: m };
	}
	return { text: "" };
}
function endsWithToolResult(body) {
	const msgs = body.messages ?? [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role === "assistant") return null;
		if (m.role === "user" && Array.isArray(m.content)) {
			const tr = m.content.find((b) => b.type === "tool_result");
			if (tr) return tr;
		}
	}
	return null;
}

function sse(res, events) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": `req_mock_${seq}` });
	for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
	res.end();
}

function reply(body) {
	const model = body.model ?? "mock";
	const tr = endsWithToolResult(body);
	const { text } = lastUserText(body);
	const m = /MOCK_TOOL:([A-Za-z0-9_\-]+):(\{.*?\})(?:\s|$)/s.exec(text);
	const usage = { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
	const start = { type: "message_start", message: { id: `msg_mock_${seq}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } };
	if (!tr && m) {
		const tools = body.tools ?? [];
		const tool = tools.find((t) => t.name === m[1] || t.name.endsWith(`__${m[1]}`));
		const name = tool?.name ?? m[1];
		return [start,
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_mock_${seq}`, name, input: {} } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: m[2] } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
			{ type: "message_stop" }];
	}
	let out = "ok";
	if (tr) {
		const c = typeof tr.content === "string" ? tr.content : (tr.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
		out = `tool said: ${String(c).slice(0, 200)}`;
	}
	return [start,
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: out } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" }];
}

createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		const raw = Buffer.concat(chunks).toString("utf8");
		const n = ++seq;
		const headers = Object.fromEntries(KEEP_HEADERS.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
		const auth = req.headers.authorization ?? req.headers["x-api-key"] ?? "";
		const authFamily = /sk-ant-[a-z]+\d*/.exec(String(auth))?.[0] ?? (auth ? "other" : "none");
		appendFileSync(join(OUT, "index.jsonl"), JSON.stringify({ n, method: req.method, url: req.url, authFamily, bytes: raw.length }) + "\n");
		if (req.method === "POST" && /^\/v1\/messages(\?|$)/.test(req.url)) {
			let body;
			try { body = JSON.parse(raw); } catch { res.writeHead(400).end("bad json"); return; }
			writeFileSync(join(OUT, `req-${String(n).padStart(4, "0")}.json`), JSON.stringify({ url: req.url, headers, body }, null, 1));
			const events = reply(body);
			const slow = /MOCK_SLOW/.test(lastUserText(body).text) ? 15000 : 0;
			if (body.stream) return setTimeout(() => { if (!res.destroyed) sse(res, events); }, slow);
			const msg = { ...events[0].message, content: [], stop_reason: "end_turn" };
			for (const e of events) if (e.type === "content_block_start") msg.content.push(e.content_block.type === "text" ? { type: "text", text: "" } : { ...e.content_block });
			for (const e of events) if (e.type === "content_block_delta") {
				const b = msg.content[e.index];
				if (e.delta.type === "text_delta") b.text += e.delta.text; else b.input = JSON.parse(e.delta.partial_json);
			}
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg));
			return;
		}
		if (req.method === "POST" && req.url.startsWith("/v1/messages/count_tokens")) {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1000 }));
			return;
		}
		res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock" } }));
	});
}).listen(PORT, "127.0.0.1", () => console.error(`mock-api on ${PORT}, out=${OUT}`));
