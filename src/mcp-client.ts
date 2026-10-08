import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";

export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: {
		type?: string;
		properties?: Record<string, JsonSchema>;
		required?: string[];
	};
}

type JsonSchema = {
	type?: string;
	description?: string;
	enum?: unknown[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	minimum?: number;
	maximum?: number;
	maxLength?: number;
};

type JsonRpcResponse = {
	jsonrpc?: string;
	id?: number;
	result?: unknown;
	error?: { code?: number; message?: string };
};

// "timeout" is kept apart from "transport" on purpose: runtime trips the MCP circuit on
// "transport", and a slow answer is not a dead server. See DEFAULT_MCP_REQUEST_TIMEOUT_MS.
type McpErrorKind = "transport" | "tool" | "abort" | "timeout";

type TaggedMcpError = Error & { mcpKind?: McpErrorKind };

// 8s was too tight for real palaces: startup (initialize) has to open the
// on-disk backend (e.g. ChromaDB) before it can answer anything, and that
// alone takes ~20s against a palace with a couple hundred thousand drawers.
const DEFAULT_MCP_CONNECT_TIMEOUT_MS = normalizeTimeout(process.env.MEMPALACE_MCP_CONNECT_TIMEOUT_MS, 45000);
// Tool calls are usually fast, but the server answers one request at a time: a call that
// lands behind a mempalace_mine waits for the whole mine (measured: a hook_settings call
// waited 10.9s behind a 12.9s dry-run mine). At 8s that wait used to time out and trip
// the MCP circuit, switching MCP off for the rest of an unrelated sibling session. So
// the budget covers a full auto-ingest mine (DEFAULT_MINE_TIMEOUT_MS, 5 min) plus a
// minute of slack: callers wait instead of failing. A timeout no longer trips the
// circuit either (it is tagged "timeout"), so a call that does run out fails alone.
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = normalizeTimeout(process.env.MEMPALACE_MCP_REQUEST_TIMEOUT_MS, 360000);

// Shared-server mode. Set MEMPALACE_MCP_URL to the endpoint printed by
// `mempalace serve` (e.g. http://127.0.0.1:8765/mcp) and this client talks to
// that one process instead of spawning its own `mempalace-mcp`.
//
// Why this exists: mempalace holds a per-palace writer lease for the lifetime
// of the MCP process (mcp_server._acquire_mcp_writer_lock). That lease is not
// a bug -- it stops a second long-lived ChromaDB PersistentClient from writing
// with a stale in-memory HNSW cache. The consequence is that a second
// concurrent agent session gets a read-only palace and its saves are refused.
// Pointing every session at one server collapses them to a single writer, so
// the lease is satisfied rather than bypassed.
//
// `mempalace serve` answers plain application/json on POST -- no SSE framing
// and no Mcp-Session-Id -- so this needs no streaming or session plumbing.
const MCP_HTTP_URL_ENV = "MEMPALACE_MCP_URL";
const MCP_HTTP_TOKEN_ENV = "MEMPALACE_MCP_HTTP_TOKEN";

export class MemPalaceMcpClient {
	private child?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly discoveredTools = new Map<string, McpToolDefinition>();
	private stderrBuffer = "";
	private commandLine = "";
	private stdoutReader?: readline.Interface;
	private httpUrl?: string;

	get isConnected(): boolean {
		if (this.httpUrl) return true;
		return !!this.child && !this.child.killed;
	}

	getCommandLine(): string {
		return this.commandLine;
	}

	getStderr(): string {
		return this.stderrBuffer.trim();
	}

	getTools(): McpToolDefinition[] {
		return [...this.discoveredTools.values()];
	}

	async connect(signal?: AbortSignal): Promise<{ commandLine: string; tools: McpToolDefinition[] }> {
		if (this.isConnected && this.discoveredTools.size > 0) {
			return { commandLine: this.commandLine, tools: this.getTools() };
		}

		const httpUrl = process.env[MCP_HTTP_URL_ENV]?.trim();
		if (httpUrl) {
			await this.connectHttp(httpUrl, signal);
			return { commandLine: this.commandLine, tools: this.getTools() };
		}

		const customBin = process.env.MEMPALACE_MCP_BIN?.trim();
		const attempts: Array<[string, string[]]> = [
			...(customBin ? [[customBin, []] as [string, string[]]] : []),
			["mempalace-mcp", []],
			["python3", ["-m", "mempalace.mcp_server"]],
			["python", ["-m", "mempalace.mcp_server"]],
		];

		const errors: Error[] = [];
		for (const [command, args] of attempts) {
			try {
				await this.spawnAndInitialize(command, args, signal, DEFAULT_MCP_CONNECT_TIMEOUT_MS);
				return { commandLine: this.commandLine, tools: this.getTools() };
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				errors.push(normalized);
				await this.close();
			}
		}

		throw this.summarizeConnectErrors(errors, attempts.map(([command]) => command));
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (!this.isConnected) {
			await this.connect(signal);
		}
		return this.request("tools/call", { name, arguments: args }, signal);
	}

	async close(): Promise<void> {
		for (const [, pending] of this.pending) {
			pending.reject(createTaggedMcpError("MemPalace MCP client closed.", "transport"));
		}
		this.pending.clear();

		this.stdoutReader?.close();
		this.stdoutReader = undefined;

		if (this.child && !this.child.killed) {
			this.child.kill();
		}
		this.child = undefined;
		this.httpUrl = undefined;
		this.discoveredTools.clear();
		this.commandLine = "";
	}

	// Shared-server connect: initialize, announce initialized, then list tools.
	// Uses the connect timeout for all three because opening a large palace
	// happens on the server's first request, same as the stdio path.
	private async connectHttp(url: string, signal?: AbortSignal): Promise<void> {
		this.stderrBuffer = "";
		this.httpUrl = url;
		this.commandLine = `http ${url}`;
		this.discoveredTools.clear();

		try {
			await this.request(
				"initialize",
				{
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "mempalace-pi", version: "0.2.8" },
				},
				signal,
				DEFAULT_MCP_CONNECT_TIMEOUT_MS,
			);
			await this.notify("notifications/initialized", {});

			const listed = (await this.request("tools/list", {}, signal, DEFAULT_MCP_CONNECT_TIMEOUT_MS)) as
				| { tools?: McpToolDefinition[] }
				| undefined;
			for (const tool of listed?.tools ?? []) {
				if (tool?.name) this.discoveredTools.set(tool.name, tool);
			}
		} catch (error) {
			this.httpUrl = undefined;
			const message = error instanceof Error ? error.message : String(error);
			throw createTaggedMcpError(
				`Could not reach the MemPalace server at ${url} (${MCP_HTTP_URL_ENV}): ${message}. Start one with 'mempalace serve', or unset ${MCP_HTTP_URL_ENV} to spawn a local mempalace-mcp instead.`,
				"transport",
			);
		}
	}

	private async httpSend(payload: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<JsonRpcResponse | undefined> {
		const url = this.httpUrl;
		if (!url) throw createTaggedMcpError("MemPalace MCP server is not running.", "transport");

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
		};
		const token = process.env[MCP_HTTP_TOKEN_ENV]?.trim();
		if (token) headers.Authorization = `Bearer ${token}`;

		try {
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw createTaggedMcpError(`MemPalace server returned HTTP ${response.status} ${response.statusText}`, "transport");
			}
			const text = (await response.text()).trim();
			if (!text) return undefined;
			return JSON.parse(text) as JsonRpcResponse;
		} catch (error) {
			if (signal?.aborted) {
				throw createTaggedMcpError(`MemPalace MCP request aborted: ${String(payload.method)}`, "abort");
			}
			if (controller.signal.aborted) {
				throw createTaggedMcpError(`MemPalace MCP request timed out after ${timeoutMs}ms: ${String(payload.method)}`, "timeout");
			}
			if (error instanceof Error && (error as TaggedMcpError).mcpKind) throw error;
			throw createTaggedMcpError(error instanceof Error ? error.message : String(error), "transport");
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private async spawnAndInitialize(command: string, args: string[], signal?: AbortSignal, timeoutMs = DEFAULT_MCP_CONNECT_TIMEOUT_MS): Promise<void> {
		this.stderrBuffer = "";
		this.commandLine = [command, ...args].join(" ");
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;

		this.stdoutReader?.close();
		const rl = readline.createInterface({ input: child.stdout });
		this.stdoutReader = rl;
		rl.on("line", (line) => this.handleLine(line));
		child.stderr.on("data", (chunk) => {
			this.stderrBuffer += chunk.toString();
		});

		let startupComplete = false;
		let startupFailed = false;
		const startupFailure = new Promise<never>((_, reject) => {
			const fail = (error: Error) => {
				if (startupFailed) return;
				startupFailed = true;
				reject(error);
			};

			child.once("error", (error) => {
				fail(this.createStartupError(command, error.message));
			});
			child.once("exit", (code, sig) => {
				const reason = this.createStartupError(command, `process exited (${sig ?? code ?? "unknown"})`);
				if (!startupComplete) fail(reason);
				for (const [, pending] of this.pending) pending.reject(reason);
				this.pending.clear();
				this.child = undefined;
				this.stdoutReader?.close();
				this.stdoutReader = undefined;
			});
		});

		const abortStartup = () => {
			if (startupComplete || child.killed) return;
			child.kill();
		};
		signal?.addEventListener("abort", abortStartup, { once: true });

		let startupTimer: ReturnType<typeof setTimeout> | undefined;
		const clearStartupTimer = () => {
			if (!startupTimer) return;
			clearTimeout(startupTimer);
			startupTimer = undefined;
		};
		const startupTimeout = new Promise<never>((_, reject) => {
			startupTimer = setTimeout(() => {
				reject(this.createStartupError(command, `timed out after ${timeoutMs}ms during initialize/tools/list`));
			}, timeoutMs);
			signal?.addEventListener("abort", clearStartupTimer, { once: true });
		});

		try {
			await Promise.race([
				startupFailure,
				startupTimeout,
				(async () => {
					// Use the (larger) connect timeout for these two calls, not the
					// smaller default request timeout: initialize has to open the
					// server's on-disk backend before it can respond, which is the
					// slow part of startup. The outer startupTimeout race above is
					// what actually enforces the overall connect budget; passing it
					// through here just stops request()'s own shorter timeout from
					// firing first and masking it.
					await this.request(
						"initialize",
						{
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							clientInfo: { name: "pi-mempalace", version: "0.2.7" },
						},
						signal,
						timeoutMs,
					);
					await this.notify("notifications/initialized", {});
					const list = (await this.request("tools/list", {}, signal, timeoutMs)) as { tools?: McpToolDefinition[] };
					this.discoveredTools.clear();
					for (const tool of list.tools ?? []) {
						this.discoveredTools.set(tool.name, tool);
					}
					startupComplete = true;
				})(),
			]);
		} finally {
			clearStartupTimer();
			signal?.removeEventListener("abort", abortStartup);
			signal?.removeEventListener("abort", clearStartupTimer);
		}
	}

	private createStartupError(command: string, message: string): Error {
		const stderr = this.stderrBuffer.trim();
		const detail = stderr ? `${message}\n${stderr}` : message;
		return createTaggedMcpError(`Failed to start MemPalace MCP with ${command}: ${detail}`, "transport");
	}

	private summarizeConnectErrors(errors: Error[], attemptedCommands: string[]): Error {
		const messages = errors.map((error) => error.message).join("\n");
		const tried = attemptedCommands.join(", ");

		if (errors.length > 0 && errors.every((error) => /ENOENT/i.test(error.message))) {
			return createTaggedMcpError(`MemPalace was not found (tried: ${tried}). Install with 'uv tool install mempalace', 'pipx install mempalace', 'pipx install --global mempalace', or 'python3 -m pip install mempalace'. Ensure the launcher directory is on PATH.`, "transport");
		}

		if (/No module named mempalace/i.test(messages)) {
			return createTaggedMcpError(`Python was found, but the mempalace package is not installed in the environment used by ${tried}. Install with 'uv tool install mempalace', 'pipx install mempalace', 'pipx install --global mempalace', or 'python3 -m pip install mempalace'. For an existing isolated install, set MEMPALACE_PYTHON.`, "transport");
		}

		return createTaggedMcpError(errors[errors.length - 1]?.message || "Failed to start MemPalace MCP server.", "transport");
	}

	private async notify(method: string, params: Record<string, unknown>): Promise<void> {
		if (this.httpUrl) {
			await this.httpSend({ jsonrpc: "2.0", method, params }, undefined, DEFAULT_MCP_REQUEST_TIMEOUT_MS);
			return;
		}
		if (!this.child) throw createTaggedMcpError("MemPalace MCP server is not running.", "transport");
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	private request(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS): Promise<unknown> {
		if (this.httpUrl) {
			const id = this.nextId++;
			return this.httpSend({ jsonrpc: "2.0", id, method, params }, signal, timeoutMs).then((message) => {
				if (message?.error) {
					throw createTaggedMcpError(message.error.message || "Unknown MCP error", "tool");
				}
				return message?.result;
			});
		}
		if (!this.child) throw createTaggedMcpError("MemPalace MCP server is not running.", "transport");
		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(createTaggedMcpError(`MemPalace MCP request timed out after ${timeoutMs}ms: ${method}`, "timeout"));
			}, timeoutMs);
			const abort = () => {
				clearTimeout(timeout);
				this.pending.delete(id);
				reject(createTaggedMcpError(`MemPalace MCP request aborted: ${method}`, "abort"));
			};
			if (signal?.aborted) return abort();
			signal?.addEventListener("abort", abort, { once: true });

			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					signal?.removeEventListener("abort", abort);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					signal?.removeEventListener("abort", abort);
					reject(error);
				},
			});

			this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	private handleLine(line: string) {
		const trimmed = line.trim();
		if (!trimmed) return;
		let message: JsonRpcResponse;
		try {
			message = JSON.parse(trimmed) as JsonRpcResponse;
		} catch {
			return;
		}
		if (typeof message.id !== "number") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(createTaggedMcpError(message.error.message || "Unknown MCP error", "tool"));
			return;
		}
		pending.resolve(message.result);
	}
}

function createTaggedMcpError(message: string, kind: McpErrorKind): Error {
	const error = new Error(message) as TaggedMcpError;
	error.mcpKind = kind;
	return error;
}

export function getMcpErrorKind(error: unknown): McpErrorKind | undefined {
	return error instanceof Error ? (error as TaggedMcpError).mcpKind : undefined;
}

function normalizeTimeout(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function schemaToType(schema: JsonSchema | undefined): unknown {
	if (!schema) return Type.Any();
	if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) {
		return Type.Union(schema.enum.map((value) => Type.Literal(value as string)));
	}

	switch (schema.type) {
		case "string":
			return Type.String({
				description: schema.description,
				maxLength: schema.maxLength,
			});
		case "integer":
			return Type.Integer({
				description: schema.description,
				minimum: schema.minimum,
				maximum: schema.maximum,
			});
		case "number":
			return Type.Number({
				description: schema.description,
				minimum: schema.minimum,
				maximum: schema.maximum,
			});
		case "boolean":
			return Type.Boolean({ description: schema.description });
		case "array":
			return Type.Array(schemaToType(schema.items) as never, { description: schema.description });
		case "object": {
			const properties = schema.properties ?? {};
			const required = new Set(schema.required ?? []);
			const mapped = Object.fromEntries(
				Object.entries(properties).map(([key, value]) => [
					key,
					required.has(key) ? schemaToType(value) : Type.Optional(schemaToType(value) as never),
				]),
			);
			return Type.Object(mapped, { description: schema.description });
		}
		default:
			return Type.Any({ description: schema.description });
	}
}

export function mcpToolSchemaToTypeBox(tool: McpToolDefinition) {
	const schema = tool.inputSchema;
	if (!schema || schema.type !== "object") {
		return Type.Object({});
	}
	return schemaToType(schema);
}

export function normalizeMcpToolResult(result: unknown): {
	text: string;
	parsed: unknown;
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	const payload = (result as { content?: Array<{ type?: string; text?: string }> } | undefined) ?? {};
	const text = payload.content?.find((item) => item.type === "text")?.text ?? JSON.stringify(result, null, 2);
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// Keep plain text
	}
	return {
		text,
		parsed,
		content: [{ type: "text", text }],
		details: { rawResult: result, parsed },
	};
}
