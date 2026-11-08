/**
 * provider.remote: Claude Code runs on another machine through the remote
 * spawner (pi-claude-bridge-remote). Nothing listens at the configured address,
 * so each query ends once the spawner has read its command line and failed to
 * connect.
 */
import { after, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { requestFromSdkArgs } from "pi-claude-bridge-remote/spawner";
import activate, { __test } from "../src/index.js";

// Its own agent dir, since the config is written: never the developer's.
const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-remote-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CLAUDE_CONFIG_DIR = join(agentDir, "claude");
after(() => rmSync(agentDir, { recursive: true, force: true }));
writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ provider: {
	remote: { url: "ws://127.0.0.1:1", token: "t" },
	autoMemoryEnabled: true, strictMcpConfig: false, pathToClaudeCodeExecutable: "/nonexistent/claude",
} }));
let providerConfig;
activate({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const turn = () => providerConfig.streamSimple(
	providerConfig.models.find((m) => m.id === "claude-haiku-4-5"),
	{ messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] },
	{ sessionId: `s-remote-${Math.random()}`, reasoning: "high" },
).result();

// The remote spawner refuses any command line the daemon would not build
// itself. Those three settings change it, so remote mode drops them.
it("builds a provider query the remote daemon can run, whatever autoMemoryEnabled, strictMcpConfig and pathToClaudeCodeExecutable say", async () => {
	let args;
	__test.setQuery(({ prompt, options }) => query({ prompt, options: {
		...options,
		spawnClaudeCodeProcess: (spawn) => { args = spawn.args; return options.spawnClaudeCodeProcess(spawn); },
	} }));
	try { await turn(); }
	finally { __test.setQuery(null); }
	assert.ok(args, "the SDK spawned Claude Code through the bridge");
	assert.doesNotThrow(() => requestFromSdkArgs(args));
});

// The SDK adds stderr only to processes it starts itself, so the spawner
// reports its failures as a process that could not start.
it("tells pi why a remote run failed", async () => {
	const result = await turn();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /^Failed to spawn Claude Code process: cannot reach the remote daemon at ws:\/\/127\.0\.0\.1:1 \(connect ECONNREFUSED/);
});
