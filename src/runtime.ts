import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDefaultPiHookSettings, normalizeHookSettingsPayload } from "./hook-settings-policy.js";
import { getMcpPromptGuidelines } from "./constants";
import { callLocalMemPalaceTool, discoverLocalMemPalaceTools, hasStructuredToolFailure, readRecentHookLog } from "./local-backend";
import { MemPalaceMcpClient, type McpToolDefinition, getMcpErrorKind, mcpToolSchemaToTypeBox, normalizeMcpToolResult } from "./mcp-client";
import type { AutoIngestOutcome } from "./utils";
import { getMemPalaceSetupGuidance, getMemPalaceSetupGuidanceFromExec, runMemPalace, toolResult, unavailableToolResult } from "./utils";

export type PiHookSettings = {
	silent_save: boolean;
	desktop_toast: boolean;
	source: "default" | "mcp" | "python";
	updatedAt: string;
};

export type MemoriesFiledAwayState = {
	status: string;
	message?: string;
	count?: number;
	timestamp?: string | null;
	source: "mcp" | "python";
	checkedAt: string;
};

export type ReconnectState = {
	success: boolean;
	message?: string;
	error?: string;
	drawers?: number;
	source: "mcp" | "python";
	checkedAt: string;
};

export type LocalFallbackState = {
	toolName: string;
	transport: "python" | "cli";
	reason?: string;
	success: boolean;
	detail?: string;
	checkedAt: string;
};

export class MemPalaceRuntime {
	lastAutoSaveCount = 0;
	lastPreCompactWarningKey?: string;
	lastAutoIngest?: AutoIngestOutcome & { timestamp: string };
	hookSettings: PiHookSettings = {
		...getDefaultPiHookSettings(),
		source: "default",
		updatedAt: new Date(0).toISOString(),
	};
	lastMemoriesFiledAway?: MemoriesFiledAwayState;
	lastReconnect?: ReconnectState;
	lastFallback?: LocalFallbackState;
	private mcpClient?: MemPalaceMcpClient;
	mcpStartupError?: string;
	lastMcpToolError?: string;
	localFallbackError?: string;
	hasShownSetupNotice = false;
	mcpCircuitOpen = false;
	mcpCircuitReason?: string;
	mcpCircuitOpenedAt?: string;
	readonly registeredMcpTools = new Set<string>();
	readonly registeredFallbackTools = new Set<string>();
	readonly registeredDynamicTools = new Set<string>();
	readonly disabledMcpTools = new Set<string>();
	private localFallbackToolsDiscovered = false;
	private localFallbackTools: McpToolDefinition[] = [];

	constructor(private readonly pi: ExtensionAPI) {}

	getMcpClient() {
		if (!this.mcpClient) this.mcpClient = new MemPalaceMcpClient();
		return this.mcpClient;
	}

	async ensureLocalFallbackTools(signal?: AbortSignal) {
		if (this.localFallbackToolsDiscovered) {
			return { tools: this.localFallbackTools };
		}
		try {
			const { command, result, tools } = await discoverLocalMemPalaceTools(this.pi, signal);
			if (result.code !== 0) {
				this.localFallbackError = getMemPalaceSetupGuidanceFromExec(command, result) || result.stderr.trim() || result.stdout.trim();
				return { tools: [] };
			}
			this.localFallbackError = undefined;
			this.localFallbackTools = tools;
			this.localFallbackToolsDiscovered = true;
			this.registerDiscoveredFallbackTools();
			return { tools };
		} catch (error) {
			this.localFallbackError = error instanceof Error ? error.message : String(error);
			return { tools: [] };
		}
	}

	async ensureMcpConnected(signal?: AbortSignal) {
		if (this.mcpCircuitOpen) {
			this.mcpStartupError = this.mcpCircuitReason || this.mcpStartupError;
			return { tools: [] };
		}
		try {
			const client = this.getMcpClient();
			const { tools } = await client.connect(signal);
			this.mcpStartupError = undefined;
			this.registerDiscoveredMcpTools();
			return { client, tools };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.mcpStartupError = detail;
			if (getMcpErrorKind(error) === "transport" || getMcpErrorKind(error) === undefined) {
				await this.tripMcpCircuit(detail);
			}
			return { tools: [] };
		}
	}

	private applyHookSettings(payload: unknown, source: "default" | "mcp" | "python") {
		const normalized = normalizeHookSettingsPayload(payload);
		this.hookSettings = {
			...normalized,
			source,
			updatedAt: new Date().toISOString(),
		};
	}

	async refreshHookSettings(signal?: AbortSignal) {
		const result = (await this.maybeCallMcpTool("mempalace_hook_settings", {}, signal)) ||
			(await this.runLocalFallbackTool("mempalace_hook_settings", {}, signal, this.describeFallbackReason("mempalace_hook_settings")));
		const parsed = result?.details?.parsed;
		if (parsed && typeof parsed === "object") {
			this.applyHookSettings(parsed, result?.details?.transport === "python" ? "python" : "mcp");
			return this.hookSettings;
		}
		if (!this.hookSettings || this.hookSettings.source !== "default") {
			this.applyHookSettings(undefined, "default");
		}
		return this.hookSettings;
	}

	async acknowledgeMemoriesFiledAway(signal?: AbortSignal) {
		const result = (await this.maybeCallMcpTool("mempalace_memories_filed_away", {}, signal)) ||
			(await this.runLocalFallbackTool("mempalace_memories_filed_away", {}, signal, this.describeFallbackReason("mempalace_memories_filed_away")));
		const parsed = result?.details?.parsed;
		if (!parsed || typeof parsed !== "object") return undefined;
		const record = {
			status: typeof (parsed as { status?: unknown }).status === "string" ? (parsed as { status: string }).status : "unknown",
			message: typeof (parsed as { message?: unknown }).message === "string" ? (parsed as { message: string }).message : undefined,
			count: typeof (parsed as { count?: unknown }).count === "number" ? (parsed as { count: number }).count : undefined,
			timestamp: typeof (parsed as { timestamp?: unknown }).timestamp === "string" || (parsed as { timestamp?: unknown }).timestamp === null
				? ((parsed as { timestamp?: string | null }).timestamp ?? null)
				: undefined,
			source: result?.details?.transport === "python" ? ("python" as const) : ("mcp" as const),
			checkedAt: new Date().toISOString(),
		};
		this.lastMemoriesFiledAway = record;
		return record;
	}

	async reconnectPalace(signal?: AbortSignal) {
		const result = (await this.maybeCallMcpTool("mempalace_reconnect", {}, signal)) ||
			(await this.runLocalFallbackTool("mempalace_reconnect", {}, signal, this.describeFallbackReason("mempalace_reconnect")));
		const parsed = result?.details?.parsed;
		if (!parsed || typeof parsed !== "object") return undefined;
		const record = {
			success: Boolean((parsed as { success?: unknown }).success),
			message: typeof (parsed as { message?: unknown }).message === "string" ? (parsed as { message: string }).message : undefined,
			error: typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : undefined,
			drawers: typeof (parsed as { drawers?: unknown }).drawers === "number" ? (parsed as { drawers: number }).drawers : undefined,
			source: result?.details?.transport === "python" ? ("python" as const) : ("mcp" as const),
			checkedAt: new Date().toISOString(),
		};
		this.lastReconnect = record;
		return record;
	}

	async maybeCallMcpTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal) {
		if (this.mcpCircuitOpen || this.disabledMcpTools.has(toolName)) return undefined;
		const { client } = await this.ensureMcpConnected(signal);
		if (!client) return undefined;
		const available = client.getTools().some((tool) => tool.name === toolName);
		if (!available) return undefined;
		try {
			const result = await client.callTool(toolName, args, signal);
			this.lastMcpToolError = undefined;
			const normalized = normalizeMcpToolResult(result);
			if (toolName === "mempalace_hook_settings") {
				this.applyHookSettings(normalized.parsed, "mcp");
			}
			return {
				content: normalized.content,
				details: { transport: "mcp", toolName, ...normalized.details },
				isError: false,
			};
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.lastMcpToolError = detail;
			const kind = getMcpErrorKind(error);
			if (kind === "transport") {
				this.disabledMcpTools.add(toolName);
				await this.tripMcpCircuit(detail);
			}
			return undefined;
		}
	}

	async runFallbackTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal, reason?: string) {
		if (toolName === "mempalace_status") {
			return this.runCliFallbackTool("MemPalace status", ["status"], toolName, signal, reason);
		}
		if (toolName === "mempalace_search" && typeof args.query === "string") {
			const commandArgs = ["search", args.query];
			if (typeof args.wing === "string") commandArgs.push("--wing", args.wing);
			if (typeof args.room === "string") commandArgs.push("--room", args.room);
			return this.runCliFallbackTool("MemPalace search", commandArgs, toolName, signal, reason);
		}
		return this.runLocalFallbackTool(toolName, args, signal, reason);
	}

	private async runCliFallbackTool(
		label: string,
		commandArgs: string[],
		toolName: string,
		signal?: AbortSignal,
		reason?: string,
	) {
		const { command, result } = await runMemPalace(this.pi, commandArgs, signal);
		const guidance = getMemPalaceSetupGuidanceFromExec(command, result) || getMemPalaceSetupGuidance(this.mcpStartupError);
		if (result.code !== 0 && guidance) {
			this.recordFallback(toolName, "cli", false, reason, guidance);
			return unavailableToolResult(label, guidance, command, result, "cli");
		}
		this.recordFallback(toolName, "cli", result.code === 0, reason, result.stderr.trim() || undefined);
		const output = toolResult(label, command, result);
		return {
			...output,
			details: { ...output.details, transport: "cli", fallback: true, fallbackReason: reason, toolName },
		};
	}

	private async runLocalFallbackTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal, reason?: string) {
		const synthetic = await this.runSyntheticLocalFallbackTool(toolName, reason);
		if (synthetic) return synthetic;
		await this.ensureLocalFallbackTools(signal);
		const available = this.localFallbackTools.some((tool) => tool.name === toolName);
		if (!available) {
			const detail = this.localFallbackError || `No local MemPalace fallback is available for ${toolName}.`;
			this.recordFallback(toolName, "python", false, reason, detail);
			return {
				content: [{ type: "text" as const, text: `MemPalace fallback unavailable for ${toolName}: ${detail}` }],
				details: { transport: "python", toolName, unavailable: true, reason, error: detail },
				isError: true,
			};
		}

		const run = await callLocalMemPalaceTool(this.pi, toolName, args, signal);
		const guidance = getMemPalaceSetupGuidanceFromExec(run.command, run.result) || getMemPalaceSetupGuidance(this.mcpStartupError);
		if (run.result.code !== 0 && guidance) {
			this.recordFallback(toolName, "python", false, reason, guidance);
			return unavailableToolResult(`MemPalace fallback (${toolName})`, guidance, run.command, run.result, "python");
		}

		const isError = run.result.code !== 0 || hasStructuredToolFailure(run.parsed);
		const text = run.result.code === 0 ? run.text : `MemPalace local fallback failed for ${toolName}: ${run.text}`;
		this.recordFallback(toolName, "python", !isError, reason, typeof run.parsed === "string" ? run.parsed : undefined);
		return {
			content: [{ type: "text" as const, text }],
			details: {
				transport: "python",
				fallback: true,
				fallbackReason: reason,
				toolName,
				command: run.command,
				stdout: run.result.stdout,
				stderr: run.result.stderr,
				exitCode: run.result.code,
				parsed: run.parsed,
			},
			isError,
		};
	}

	private async runSyntheticLocalFallbackTool(toolName: string, reason?: string) {
		if (toolName === "mempalace_hook_settings") {
			const parsed = { settings: { ...getDefaultPiHookSettings() }, fallback: true, message: "Using Pi default hook settings because MemPalace did not expose operator hook settings outside MCP." };
			this.recordFallback(toolName, "python", true, reason, parsed.message);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
				details: { transport: "python", fallback: true, fallbackReason: reason, toolName, parsed },
				isError: false,
			};
		}
		if (toolName === "mempalace_memories_filed_away") {
			const hookLog = await readRecentHookLog();
			const timestampMatch = Array.from(hookLog?.matchAll(/\[(\d{2}:\d{2}:\d{2})\]\s+TRIGGERING SAVE/g) || []).at(-1);
			const parsed = {
				status: "unknown",
				message: "Local fallback cannot verify whether memories were filed away; upstream MemPalace only exposes that acknowledgement over MCP.",
				timestamp: timestampMatch?.[1] || null,
				hook_log_available: Boolean(hookLog),
			};
			this.recordFallback(toolName, "python", true, reason, parsed.message);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
				details: { transport: "python", fallback: true, fallbackReason: reason, toolName, parsed },
				isError: false,
			};
		}
		if (toolName === "mempalace_reconnect") {
			const parsed = {
				success: false,
				error: "Local fallback active; no MCP reconnect is available or required.",
				fallback: true,
			};
			this.recordFallback(toolName, "python", true, reason, parsed.error);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
				details: { transport: "python", fallback: true, fallbackReason: reason, toolName, parsed },
				isError: false,
			};
		}
		return undefined;
	}

	private async tripMcpCircuit(reason: string) {
		this.mcpCircuitOpen = true;
		this.mcpCircuitReason = reason;
		this.mcpCircuitOpenedAt = new Date().toISOString();
		this.mcpStartupError = reason;
		await this.shutdown();
	}

	private describeFallbackReason(toolName: string) {
		if (this.mcpCircuitOpen) return `MCP circuit open: ${this.mcpCircuitReason || toolName}`;
		if (this.disabledMcpTools.has(toolName) && this.lastMcpToolError) return `MCP disabled after failure: ${this.lastMcpToolError}`;
		if (this.lastMcpToolError) return `MCP failure: ${this.lastMcpToolError}`;
		if (this.mcpStartupError) return `MCP unavailable: ${this.mcpStartupError}`;
		return "MCP unavailable";
	}

	private recordFallback(toolName: string, transport: "python" | "cli", success: boolean, reason?: string, detail?: string) {
		this.lastFallback = {
			toolName,
			transport,
			reason,
			success,
			detail,
			checkedAt: new Date().toISOString(),
		};
	}

	registerDiscoveredFallbackTools() {
		for (const tool of this.localFallbackTools) {
			if (this.registeredFallbackTools.has(tool.name)) continue;
			if (["mempalace_status", "mempalace_search"].includes(tool.name)) continue;
			this.registeredFallbackTools.add(tool.name);
			this.registerDynamicTool(tool);
		}
	}

	registerDiscoveredMcpTools() {
		for (const tool of this.mcpClient?.getTools() ?? []) {
			if (this.registeredMcpTools.has(tool.name)) continue;
			if (["mempalace_status", "mempalace_search"].includes(tool.name)) continue;
			this.registeredMcpTools.add(tool.name);
			this.registerDynamicTool(tool);
		}
	}

	private registerDynamicTool(tool: McpToolDefinition) {
		if (this.registeredDynamicTools.has(tool.name)) return;
		this.registeredDynamicTools.add(tool.name);
		this.pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description || `MemPalace dynamic tool: ${tool.name}`,
			promptSnippet: tool.description || `Use the MemPalace tool ${tool.name}`,
			promptGuidelines: getMcpPromptGuidelines(tool.name),
			parameters: mcpToolSchemaToTypeBox(tool),
			execute: async (_toolCallId, params, signal) => {
				const mcpResult = await this.maybeCallMcpTool(tool.name, params as Record<string, unknown>, signal);
				if (mcpResult) return mcpResult;
				return this.runFallbackTool(tool.name, params as Record<string, unknown>, signal, this.describeFallbackReason(tool.name));
			},
		});
	}

	recordAutoIngest(outcome: AutoIngestOutcome) {
		if (!outcome.started) return;
		this.lastAutoIngest = {
			...outcome,
			timestamp: new Date().toISOString(),
		};
	}

	persistState() {
		this.pi.appendEntry("mempalace-state", {
			lastAutoSaveCount: this.lastAutoSaveCount,
			lastPreCompactWarningKey: this.lastPreCompactWarningKey,
			lastAutoIngest: this.lastAutoIngest,
			lastMemoriesFiledAway: this.lastMemoriesFiledAway,
			lastReconnect: this.lastReconnect,
			lastFallback: this.lastFallback,
			mcpCircuitOpen: this.mcpCircuitOpen,
			mcpCircuitReason: this.mcpCircuitReason,
			mcpCircuitOpenedAt: this.mcpCircuitOpenedAt,
			updatedAt: Date.now(),
		});
	}

	loadState(ctx: ExtensionContext) {
		this.lastAutoSaveCount = 0;
		this.lastPreCompactWarningKey = undefined;
		this.lastAutoIngest = undefined;
		this.lastMemoriesFiledAway = undefined;
		this.lastReconnect = undefined;
		this.lastFallback = undefined;
		this.mcpCircuitOpen = false;
		this.mcpCircuitReason = undefined;
		this.mcpCircuitOpenedAt = undefined;
		this.hookSettings = {
			...getDefaultPiHookSettings(),
			source: "default",
			updatedAt: new Date(0).toISOString(),
		};
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "mempalace-state") continue;
			const data = entry.data as {
				lastAutoSaveCount?: number;
				lastPreCompactWarningKey?: string;
				lastAutoIngest?: (AutoIngestOutcome & { timestamp?: string }) | undefined;
				lastMemoriesFiledAway?: MemoriesFiledAwayState | undefined;
				lastReconnect?: ReconnectState | undefined;
				lastFallback?: LocalFallbackState | undefined;
				mcpCircuitOpen?: boolean;
				mcpCircuitReason?: string;
				mcpCircuitOpenedAt?: string;
			} | undefined;
			if (typeof data?.lastAutoSaveCount === "number") this.lastAutoSaveCount = data.lastAutoSaveCount;
			if (typeof data?.lastPreCompactWarningKey === "string") this.lastPreCompactWarningKey = data.lastPreCompactWarningKey;
			if (data?.lastAutoIngest?.started && typeof data.lastAutoIngest.timestamp === "string") {
				this.lastAutoIngest = data.lastAutoIngest as AutoIngestOutcome & { timestamp: string };
			}
			if (data?.lastMemoriesFiledAway && typeof data.lastMemoriesFiledAway.checkedAt === "string") {
				this.lastMemoriesFiledAway = data.lastMemoriesFiledAway;
			}
			if (data?.lastReconnect && typeof data.lastReconnect.checkedAt === "string") {
				this.lastReconnect = data.lastReconnect;
			}
			if (data?.lastFallback && typeof data.lastFallback.checkedAt === "string") {
				this.lastFallback = data.lastFallback;
			}
			if (typeof data?.mcpCircuitOpen === "boolean") this.mcpCircuitOpen = data.mcpCircuitOpen;
			if (typeof data?.mcpCircuitReason === "string") this.mcpCircuitReason = data.mcpCircuitReason;
			if (typeof data?.mcpCircuitOpenedAt === "string") this.mcpCircuitOpenedAt = data.mcpCircuitOpenedAt;
		}
	}

	async shutdown() {
		await this.mcpClient?.close();
	}

	getMcpStderr() {
		return this.mcpClient?.getStderr() ?? "";
	}
}
