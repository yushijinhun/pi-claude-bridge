// The SDK iterator can settle before Claude Code finishes flushing its file.
// Use the documented custom-spawn hook to observe the real child's close.
import { spawn } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

/** A spawned Claude Code with the stderr and close event QueryProcess relies on:
 *  a local child, or the remote one from pi-claude-bridge-remote. */
type ObservableProcess = SpawnedProcess & {
	stderr: NodeJS.ReadableStream;
	once(event: "close", listener: () => void): unknown;
};
export type SpawnImpl = (options: SpawnOptions) => ObservableProcess;

const spawnLocal: SpawnImpl = (options) => spawn(options.command, options.args, {
	cwd: options.cwd, env: options.env, signal: options.signal,
	stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});

export class QueryProcess {
	private started = false;
	private child: SpawnedProcess | undefined;
	private closed = false;
	private resolveExit!: () => void;
	readonly exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });
	constructor(private stderr?: (data: string) => void, private spawnImpl: SpawnImpl = spawnLocal) {}
	spawn = (options: SpawnOptions): SpawnedProcess => {
		if (this.closed || this.started) throw new Error("Query process spawned after close or more than once");
		const child = this.spawnImpl(options);
		// Only a returned child can close; a synchronous spawn failure leaves none.
		this.started = true;
		this.child = child;
		child.stderr.on("data", (data: Buffer) => this.stderr?.(data.toString()));
		// A remote child closes only after its transcript is stored back here.
		child.once("close", () => this.resolveExit());
		return child;
	};
	/** A query constructor can throw after spawning, before returning a handle. */
	terminate(): void {
		this.close();
		if (this.child && !this.child.killed) this.child.kill("SIGTERM");
	}
	/** Called only after closing the SDK query, which forbids a deferred spawn. */
	close(): void {
		this.closed = true;
		if (!this.started) this.resolveExit();
	}
}
