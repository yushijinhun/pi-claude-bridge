// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json).
// There is no project config: a cloned repo could otherwise point the bridge at
// its own Claude Code executable or turn on metered billing. A missing or
// unparseable file is ignored (error to console.error, empty object returned)
// so the extension always starts. The exception is a `provider.remote` that
// cannot be used (no token, a URL the remote client refuses): the extension
// then fails to load with the reason, rather than run Claude Code locally.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface Config {
	/** Removed: AskClaude is its own package. Read only to warn whoever still has it enabled. */
	askClaude?: { enabled?: boolean };
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context;
		// newer models get 1M on every plan.
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
		// Model ids (e.g. "claude-future-9") whose declared 1M context Claude Code
		// does not actually serve; pins them to the bare id at 200K.
		forceTwoHundredK?: string[];
		// Run Claude Code on another machine through the claude-remote daemon
		// (pi-claude-bridge-remote). Tools, files and session history stay on this
		// machine. `url` is ws:// (the daemon, or an ssh tunnel to it), wss:// (a TLS
		// reverse proxy in front of it) or ws+unix:///path/to/socket.
		remote?: { url?: string; token?: string; tokenFile?: string };
	};
}

function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

export type RemoteSettings = { url: string; token: string };

const expandHome = (path: string) => path.replace(/^~(?=\/)/, process.env.HOME ?? "~");

/** `provider.remote`, or CLAUDE_BRIDGE_REMOTE=<url> with CLAUDE_BRIDGE_REMOTE_TOKEN. */
export function remoteSettings(provider: Config["provider"] = {}, env: NodeJS.ProcessEnv = process.env): RemoteSettings | undefined {
	const fromEnv = env.CLAUDE_BRIDGE_REMOTE;
	const remote = provider.remote;
	if (!fromEnv && !remote) return undefined;
	const url = fromEnv || remote?.url || "ws://127.0.0.1:7878";
	const token = env.CLAUDE_BRIDGE_REMOTE_TOKEN
		?? remote?.token
		?? (remote?.tokenFile ? readFileSync(expandHome(remote.tokenFile), "utf-8").trim() : undefined);
	if (!token) throw new Error("claude-bridge: remote Claude Code needs a token (provider.remote.token, tokenFile or CLAUDE_BRIDGE_REMOTE_TOKEN)");
	return { url, token };
}

/** The provider settings remote mode runs with. Three cannot apply when Claude Code
 *  runs on the other machine: its auto memory would be kept there, shared by every
 *  project; MCP servers from its config would run there; and the daemon picks the
 *  binary. Remote mode drops them, and `ignored` names the ones that were set. */
export function remoteProviderSettings(provider: NonNullable<Config["provider"]>): { provider: NonNullable<Config["provider"]>; ignored: string[] } {
	const { autoMemoryEnabled, strictMcpConfig, pathToClaudeCodeExecutable, ...kept } = provider;
	const ignored: string[] = [];
	if (autoMemoryEnabled === true) ignored.push("autoMemoryEnabled: true");
	if (strictMcpConfig === false) ignored.push("strictMcpConfig: false");
	if (pathToClaudeCodeExecutable) ignored.push("pathToClaudeCodeExecutable");
	return { provider: kept, ignored };
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

export function loadConfig(): Config {
	const global = tryParseJson(globalConfigPath());
	return { askClaude: global.askClaude, provider: { ...global.provider } };
}
