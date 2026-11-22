import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool, quotaInfo } from "../remote/accounts.mjs";

function fixture(t, config = {}, log) {
	const dir = mkdtempSync(join(tmpdir(), "accounts-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "pool.json");
	const privateDir = (path) => { mkdirSync(path, { recursive: true }); return realpathSync(path); };
	const accounts = [{ id: "first", configDir: "first" }, { id: "second", configDir: "second" }];
	writeFileSync(file, JSON.stringify({ accounts, ...config }));
	const pool = new AccountPool(file, privateDir, log);
	t.after(() => pool.close());
	return { file, privateDir, pool };
}

test("account eligibility distinguishes model families and extended context", (t) => {
	const { pool } = fixture(t, { accounts: [{ id: "small@example.com / Unicode \u{1F642}", configDir: "small", models: ["claude-sonnet-5-5"] }, { id: "large+context@example.com\n(1M context)", configDir: "large", models: ["claude-sonnet-5-5[1m]", "claude-opus-5-5"] }] });
	assert.equal(pool.select("claude-sonnet-5-5").account.id, "small@example.com / Unicode \u{1F642}");
	assert.equal(pool.select("claude-sonnet-5-5[1m]").account.id, "large+context@example.com\n(1M context)");
	assert.throws(() => pool.select("claude-haiku-5-5"), /no account supports/);
});

test("cooldowns share login state across pools, respect scope, and expire", (t) => {
	const { pool, file, privateDir } = fixture(t);
	const other = new AccountPool(file, privateDir);
	t.after(() => other.close());
	const first = pool.accounts[0];
	const until = pool.reject(first, "claude-opus-5-5", { rateLimitType: "seven_day_opus", resetsAt: Date.now() / 1000 + 60 });
	assert.equal(other.select("claude-opus-5-5").account.id, "second");
	assert.equal(other.select("claude-sonnet-5-5").account.id, "first");
	other.reject(other.accounts[1], "claude-opus-5-5", { rateLimitType: "five_hour", resetsAt: Date.now() / 1000 + 120 });
	assert.equal(pool.select("claude-opus-5-5").account, undefined);
	assert.equal(pool.select("claude-opus-5-5").until, until);
	assert.equal(pool.blockedUntil(first, "claude-opus-5-5", until + 1), 0);
});

test("unclassified and overage rejections only block the exact requested model across pools", (t) => {
	const { pool, file, privateDir } = fixture(t);
	const other = new AccountPool(file, privateDir);
	t.after(() => other.close());
	const first = pool.accounts[0];
	const resetsAt = Math.floor(Date.now() / 1000) + 86400;
	for (const rateLimitType of [undefined, "unknown_window", "overage", "seven_day_overage_included"]) {
		pool.reject(first, "claude-fable-5-2[1m]", { rateLimitType, resetsAt });
		assert.equal(other.select("claude-fable-5-2[1m]").account.id, "second");
		for (const model of ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-fable-5-2", "claude-fable-5-1[1m]"]) {
			assert.equal(other.select(model).account.id, "first", `${rateLimitType}: ${model}`);
		}
	}
	// Equal resets for two model rejections must not overwrite each other.
	const until = other.reject(other.accounts[0], "claude-opus-5-5[1m]", { resetsAt });
	assert.equal(pool.select("claude-fable-5-2[1m]").account.id, "second");
	assert.equal(pool.select("claude-opus-5-5[1m]").account.id, "second");
	assert.equal(pool.select("claude-opus-5-5").account.id, "first");
	assert.equal(pool.blockedUntil(first, "claude-fable-5-2[1m]", until + 1), 0);
	assert.equal(pool.blockedUntil(first, "claude-opus-5-5[1m]", until + 1), 0);
});

test("explicit subscription windows still block all models or the reported family", (t) => {
	const { pool } = fixture(t);
	const [first, second] = pool.accounts;
	for (const rateLimitType of ["five_hour", "seven_day"]) {
		const until = pool.reject(first, "claude-fable-5-2[1m]", { rateLimitType, resetsAt: Date.now() / 1000 + 60 });
		for (const model of ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-fable-5-2"]) {
			assert.equal(pool.select(model).account, second);
		}
		pool.blockedUntil(first, "claude-fable-5-2[1m]", until + 1);
	}
	pool.reject(first, "claude-opus-5-5[1m]", { rateLimitType: "seven_day_opus", resetsAt: Date.now() / 1000 + 60 });
	assert.equal(pool.select("claude-opus-5-5").account, second);
	assert.equal(pool.select("claude-opus-4-6[1m]").account, second);
	assert.equal(pool.select("claude-sonnet-5-5").account, first);
});

test("legacy all-model markers without a subscription window no longer block Opus", (t) => {
	const { pool, file, privateDir } = fixture(t);
	const until = Date.now() + 86400_000;
	for (const [i, account] of pool.accounts.entries()) {
		// Matches the persisted Fable failures that previously drained the pool.
		writeFileSync(join(account.limitsDir, `all-${until}.json`), JSON.stringify({
			model: "claude-fable-5-2[1m]", until, ...(i ? { rateLimitType: "overage" } : {}),
		}));
	}
	const restarted = new AccountPool(file, privateDir);
	t.after(() => restarted.close());
	assert.equal(restarted.select("claude-fable-5-2[1m]").account, undefined);
	assert.equal(restarted.select("claude-fable-5-2[1m]").until, until);
	assert.equal(restarted.select("claude-opus-5-5").account.id, "first");
	assert.equal(restarted.select("claude-opus-5-5[1m]").account.id, "first");
	// Preserve a genuine subscription limit alongside the old model rejection.
	pool.reject(pool.accounts[0], "claude-opus-5-5", { rateLimitType: "five_hour", resetsAt: Date.now() / 1000 + 60 });
	assert.equal(restarted.select("claude-opus-5-5").account.id, "second");
});

test("sticky scheduling keeps a lower-priority account until blocked or ineligible", (t) => {
	const { pool } = fixture(t, { scheduling: "sticky", accounts: [{ id: "first", configDir: "first", priority: 100 }, { id: "second", configDir: "second", priority: 50, models: ["claude-opus-5-5"] }] });
	const second = pool.accounts[1];
	second.active = 5;
	assert.equal(pool.select("claude-opus-5-5").account.id, "first");
	assert.equal(pool.select("claude-opus-5-5", second.configDir).account, second);
	assert.equal(pool.select("claude-sonnet-5-5", second.configDir).account.id, "first");
	pool.reject(second, "claude-opus-5-5");
	assert.equal(pool.select("claude-opus-5-5", second.configDir).account.id, "first");
});

test("higher priority overrides sticky preference and load, then falls back until reset", (t) => {
	const { pool } = fixture(t, { accounts: [{ id: "primary", configDir: "primary", priority: 100 }, { id: "backup", configDir: "backup", priority: 50 }] });
	const [primary, backup] = pool.accounts;
	assert.equal(pool.scheduling, "priority");
	assert.equal(pool.exhausted, "error");
	primary.active = 5;
	assert.equal(pool.select("claude-opus-5-5", backup.configDir).account, primary);
	const until = pool.reject(primary, "claude-opus-5-5");
	assert.equal(pool.select("claude-opus-5-5", primary.configDir).account, backup);
	pool.blockedUntil(primary, "claude-opus-5-5", until + 1);
	assert.equal(pool.select("claude-opus-5-5", backup.configDir).account, primary);
});

test("atomic config replacement reloads automatically and preserves running account state", { timeout: 10000 }, async (t) => {
	const { pool, file } = fixture(t);
	const first = pool.accounts[0];
	first.active = 2;
	pool.reject(first, "claude-opus-5-5", { rateLimitType: "seven_day_opus", resetsAt: Date.now() / 1000 + 60 });
	const changed = once(pool, "reload", { signal: AbortSignal.timeout(5000) });
	writeFileSync(`${file}.new`, JSON.stringify({ accounts: [{ id: "renamed", configDir: "first", priority: 100, models: ["claude-opus-5-5"] }, { id: "second", configDir: "second", priority: 50 }], scheduling: "sticky", exhausted: "error", fallbackCooldownSeconds: 12 }));
	renameSync(`${file}.new`, file);
	await changed;
	assert.equal(pool.accounts[0], first);
	assert.equal(first.active, 2);
	assert.equal(pool.exhausted, "error");
	assert.equal(pool.fallbackMs, 12000);
	assert.equal(pool.scheduling, "sticky");
	assert.equal(pool.select("claude-opus-5-5").account.id, "second");
	assert.equal(pool.select("claude-sonnet-5-5").account.id, "second");

	writeFileSync(file, JSON.stringify({ accounts: [{ id: "second", configDir: "second" }] }));
	assert.equal(pool.select("claude-opus-5-5").account.id, "second");
	assert.equal(pool.scheduling, "priority");
	writeFileSync(file, JSON.stringify({ accounts: [{ id: "first", configDir: "first", priority: 100 }, { id: "second", configDir: "second" }] }));
	assert.equal(pool.select("claude-sonnet-5-5").account, first);
	assert.equal(first.active, 2);
	assert.equal(first.models, undefined);
	assert.equal(pool.select("claude-opus-5-5").account.id, "second");
});

test("an invalid or missing replacement keeps the last valid config until repaired", (t) => {
	const logs = [];
	const { pool, file } = fixture(t, { scheduling: "sticky", exhausted: "wait" }, (line) => logs.push(line));
	const first = pool.accounts[0];
	writeFileSync(file, JSON.stringify({ accounts: [{ id: "changed", configDir: "first", priority: 100 }, { id: "invalid", configDir: "second", priority: "bad" }], exhausted: "error", fallbackCooldownSeconds: 1 }));
	assert.equal(pool.select("claude-opus-5-5").account, first);
	assert.equal(first.id, "first");
	assert.equal(first.priority, 0);
	assert.equal(pool.exhausted, "wait");
	assert.equal(pool.scheduling, "sticky");
	assert.equal(pool.fallbackMs, 60000);
	writeFileSync(file, '{"accounts":');
	assert.equal(pool.select("claude-opus-5-5").account, first);
	rmSync(file);
	assert.equal(pool.select("claude-opus-5-5").account, first);
	assert.ok(logs.some((line) => line.includes("keeping the last valid config")));
	writeFileSync(file, JSON.stringify({ accounts: [{ id: "repaired", configDir: "second", priority: 100 }], exhausted: "error" }));
	assert.equal(pool.select("claude-opus-5-5").account.id, "repaired");
	assert.equal(pool.exhausted, "error");
});

test("invalid account configurations fail at startup", (t) => {
	const { file, privateDir } = fixture(t);
	for (const config of [
		{ accounts: [] },
		{ accounts: [{ id: "a", configDir: "a", env: {} }] },
		{ accounts: [{ id: "", configDir: "a" }] },
		{ accounts: [{ id: 123, configDir: "a" }] },
		{ accounts: [{ id: "a", configDir: "a" }, { id: "b", configDir: "./a" }] },
		{ accounts: [{ id: "a", configDir: "a", models: ["*"] }] },
		...["100", 1.5, null, Number.MAX_SAFE_INTEGER + 1].map((priority) => ({ accounts: [{ id: "a", configDir: "a", priority }] })),
		{ accounts: [{ id: "a", configDir: "a" }], exhausted: "skip" },
		{ accounts: [{ id: "a", configDir: "a" }], scheduling: "round-robin" },
	]) {
		writeFileSync(file, JSON.stringify(config));
		assert.throws(() => new AccountPool(file, privateDir));
	}
});

test("quota detection excludes overage successes and unclassified API throttles", () => {
	const event = (info) => ({ type: "rate_limit_event", rate_limit_info: info });
	assert.equal(quotaInfo(event({ status: "rejected", isUsingOverage: true })), null);
	assert.equal(quotaInfo(event({ status: "allowed_warning" })), null);
	assert.equal(quotaInfo({ type: "system", subtype: "api_retry", error_status: 429 }, []), null);
	assert.deepEqual(quotaInfo(event({ status: "rejected", rateLimitType: "five_hour" })), { status: "rejected", rateLimitType: "five_hour" });
});
