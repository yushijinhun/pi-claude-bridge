import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync, renameSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import os from "node:os";
import { MODEL } from "./protocol.mjs";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, allowed) => Object.keys(v).every((k) => allowed.includes(k));
const family = (model) => /claude-(opus|sonnet|haiku|fable)-/.exec(model)?.[1];

/** Limits live with the login, so daemons using the same login share cooldowns. */
export class AccountPool extends EventEmitter {
	constructor(file, privateDir, log = () => {}) {
		super();
		Object.assign(this, { file: resolve(file), privateDir, log });
		this.known = new Map();
		this.source = readFileSync(this.file, "utf8");
		this.configure(this.source);
		// Stat polling also handles editors that replace the file by rename.
		// Selection re-reads it too, so new requests need not wait for the poll.
		this.changed = () => this.reload();
		watchFile(this.file, { persistent: false, interval: 500 }, this.changed);
	}

	configure(source) {
		const config = JSON.parse(source);
		if (!object(config) || !keys(config, ["accounts", "scheduling", "exhausted", "fallbackCooldownSeconds"]) || !Array.isArray(config.accounts) || !config.accounts.length) throw new Error("accounts file needs a nonempty accounts array");
		const scheduling = config.scheduling ?? "priority";
		const exhausted = config.exhausted ?? "error";
		const fallbackMs = (config.fallbackCooldownSeconds ?? 60) * 1000;
		if (!["priority", "sticky"].includes(scheduling)) throw new Error("scheduling must be priority or sticky");
		if (!["wait", "error"].includes(exhausted)) throw new Error("exhausted must be wait or error");
		if (!Number.isFinite(fallbackMs) || fallbackMs < 1000) throw new Error("fallbackCooldownSeconds must be at least 1");
		const ids = new Set(), dirs = new Set();
		const entries = config.accounts.map((entry) => {
			if (!object(entry) || !keys(entry, ["id", "configDir", "models", "priority"]) || typeof entry.id !== "string" || !entry.id || typeof entry.configDir !== "string" || !entry.configDir) throw new Error("each account needs id and configDir (and optionally models and priority)");
			if (entry.models !== undefined && (!Array.isArray(entry.models) || !entry.models.length || entry.models.some((m) => typeof m !== "string" || !MODEL.test(m)))) throw new Error(`account ${entry.id}: models must be a nonempty list of exact Claude model IDs (including [1m] where supported)`);
			if (entry.priority !== undefined && !Number.isSafeInteger(entry.priority)) throw new Error(`account ${entry.id}: priority must be a safe integer`);
			const expanded = entry.configDir.startsWith("~/") ? join(os.homedir(), entry.configDir.slice(2)) : entry.configDir;
			const configDir = this.privateDir(isAbsolute(expanded) ? expanded : resolve(dirname(this.file), expanded));
			if (ids.has(entry.id) || dirs.has(configDir)) throw new Error("accounts must have distinct ids and config directories");
			ids.add(entry.id); dirs.add(configDir);
			const limitsDir = this.privateDir(join(configDir, "claude-remote", "limits"));
			return { id: entry.id, configDir, limitsDir, models: entry.models, priority: entry.priority ?? 0 };
		});
		// Apply only after the entire file validates. Reuse account objects so
		// running workers retain their counts, even across removal/readdition.
		this.accounts = entries.map((entry) => {
			const account = this.known.get(entry.configDir) ?? { active: 0 };
			Object.assign(account, entry);
			this.known.set(entry.configDir, account);
			return account;
		});
		this.scheduling = scheduling;
		this.exhausted = exhausted;
		this.fallbackMs = fallbackMs;
	}

	reload() {
		let source;
		try {
			source = readFileSync(this.file, "utf8");
			if (source === this.source) { this.lastError = null; return false; }
			this.configure(source);
		} catch (error) {
			if (this.lastError !== error.message) this.log(`accounts file reload ignored (${this.file}): ${error.message}; keeping the last valid config`);
			this.lastError = error.message;
			return false;
		}
		this.source = source;
		this.lastError = null;
		this.log(`reloaded accounts file ${this.file}`);
		this.emit("reload");
		return true;
	}

	close() {
		unwatchFile(this.file, this.changed);
	}

	eligible(model) {
		return this.accounts.filter((a) => !a.models || a.models.includes(model));
	}

	blockedUntil(account, model, now = Date.now()) {
		let until = 0;
		for (const name of readdirSync(account.limitsDir)) {
			const match = /^(all|opus|sonnet|haiku|fable)-(\d+)\.json$/.exec(name);
			if (!match) continue;
			const reset = Number(match[2]);
			if (reset <= now) { rmSync(join(account.limitsDir, name), { force: true }); continue; }
			if (match[1] === "all" || match[1] === family(model)) until = Math.max(until, reset);
		}
		return until;
	}

	select(model, preferred) {
		this.reload();
		const eligible = this.eligible(model);
		if (!eligible.length) throw new Error(`no account supports ${model}`);
		const now = Date.now();
		const available = eligible.filter((a) => this.blockedUntil(a, model, now) <= now);
		const priority = Math.max(...available.map((a) => a.priority));
		const first = available.filter((a) => a.priority === priority);
		const sticky = this.scheduling === "sticky" ? available.find((a) => a.configDir === preferred) : undefined;
		const account = sticky ?? first.find((a) => a.configDir === preferred) ?? first.sort((a, b) => a.active - b.active)[0];
		return { account, until: account ? 0 : Math.min(...eligible.map((a) => this.blockedUntil(a, model, now))) };
	}

	reject(account, model, info = {}) {
		this.reload();
		const scope = /seven_day_(opus|sonnet|haiku|fable)$/.exec(info.rateLimitType)?.[1] ?? "all";
		const now = Date.now();
		const reported = Number(info.resetsAt ?? info.overageResetsAt) * 1000;
		const until = Math.ceil(Number.isFinite(reported) && reported > now ? reported + 1000 : now + this.fallbackMs);
		// Immutable markers avoid lost updates between simultaneous daemons.
		const file = join(account.limitsDir, `${scope}-${until}.json`);
		const temp = `${file}.${randomUUID()}.tmp`;
		writeFileSync(temp, JSON.stringify({ model, rateLimitType: info.rateLimitType, until }), { mode: 0o600 });
		renameSync(temp, file);
		return until;
	}
}

export function quotaInfo(message, records = []) {
	if (message.type === "rate_limit_event") {
		const info = message.rate_limit_info;
		return info?.status === "rejected" && !info.isUsingOverage && !info.overageInUse ? info : null;
	}
	// API-key throttling also produces api_retry/429. Only a subscription window
	// recorded by CC establishes that changing logins can help.
	if ((message.type === "system" && message.subtype === "api_retry" && message.error_status === 429) || (message.type === "assistant" && message.message?.model === "<synthetic>" && message.api_error_status === 429) || (message.type === "result" && message.is_error)) {
		const info = records.findLast((r) => r.type === "system" && r.subtype === "api_error" && r.error?.status === 429)?.error?.rateLimits;
		if (info?.rateLimitType) return info;
		// A failed SSE stream can carry 429 without a rate-limit event or reset.
		if (message.api_error_status === 429) return {};
	}
	return null;
}
