import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemPalaceRuntime } from "./runtime";
import { getBundledInstructions } from "./instructions";
import {
	formatExecOutput,
	getMemPalaceSetupGuidance,
	getMemPalaceSetupGuidanceFromExec,
	runMemPalace,
	stripAtPrefix,
	toolResult,
	unavailableToolResult,
} from "./utils";

export function registerTools(pi: ExtensionAPI, runtime: MemPalaceRuntime) {
	pi.registerTool({
		name: "mempalace_instructions",
		label: "MemPalace Instructions",
		description: "Fetch the built-in MemPalace instructions for help, setup, search, mining, or status.",
		promptSnippet: "Read MemPalace's built-in instructions for help, setup, search, mine, or status workflows.",
		promptGuidelines: [
			"Use MemPalace tools when the user asks about their memory palace, mining data, searching memories, or checking palace status.",
		],
		parameters: Type.Object({
			name: StringEnum(["help", "init", "search", "mine", "status"] as const),
		}),
		async execute(_toolCallId, params, signal) {
			const bundled = getBundledInstructions(params.name);
			const instructionRun = await runMemPalace(pi, ["instructions", params.name], signal).catch(() => undefined);
			if (instructionRun?.result.code === 0 && instructionRun.result.stdout.trim()) {
				return {
					content: [{ type: "text" as const, text: instructionRun.result.stdout.trim() }],
					details: { source: "cli", name: params.name, command: instructionRun.command },
					isError: false,
				};
			}
			return {
				content: [{ type: "text" as const, text: bundled }],
				details: { source: "bundled", name: params.name, fallback: true },
				isError: false,
			};
		},
	});

	pi.registerTool({
		name: "mempalace_status",
		label: "MemPalace Status",
		description: "Show current MemPalace status, counts, and health.",
		promptSnippet: "Show palace status, room counts, and health using MemPalace, preferring MCP when available.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			const mcpResult = await runtime.maybeCallMcpTool("mempalace_status", {}, signal);
			if (mcpResult) return mcpResult;
			return runtime.runFallbackTool("mempalace_status", {}, signal, runtime.mcpStartupError || runtime.lastMcpToolError || "MCP unavailable");
		},
	});

	pi.registerTool({
		name: "mempalace_init",
		label: "MemPalace Init",
		description: "Initialize a MemPalace in a target directory.",
		promptSnippet: "Initialize MemPalace for a project directory.",
		parameters: Type.Object({
			directory: Type.String({ description: "Project directory to initialize" }),
		}),
		async execute(_toolCallId, params, signal) {
			const directory = stripAtPrefix(params.directory);
			const { command, result } = await runMemPalace(pi, ["init", directory], signal);
			const guidance = getMemPalaceSetupGuidanceFromExec(command, result) || getMemPalaceSetupGuidance(runtime.mcpStartupError);
			if (result.code !== 0 && guidance) return unavailableToolResult("MemPalace init", guidance, command, result);
			if (result.code === 0) {
				await runtime.reconnectPalace(signal);
			}
			return toolResult("MemPalace init", command, result);
		},
	});

	pi.registerTool({
		name: "mempalace_search",
		label: "MemPalace Search",
		description: "Search memories stored in MemPalace.",
		promptSnippet: "Search MemPalace memories by semantic query, optionally filtered by wing or room.",
		parameters: Type.Object({
			query: Type.String({ description: "Semantic query to search for" }),
			wing: Type.Optional(Type.String({ description: "Optional wing filter" })),
			room: Type.Optional(Type.String({ description: "Optional room filter" })),
			limit: Type.Optional(Type.Integer({ description: "Optional result limit" })),
			max_distance: Type.Optional(Type.Number({ description: "Optional maximum cosine distance" })),
			context: Type.Optional(Type.String({ description: "Optional extra search context" })),
		}),
		async execute(_toolCallId, params, signal) {
			const mcpResult = await runtime.maybeCallMcpTool("mempalace_search", params as Record<string, unknown>, signal);
			if (mcpResult) return mcpResult;
			return runtime.runFallbackTool(
				"mempalace_search",
				params as Record<string, unknown>,
				signal,
				runtime.mcpStartupError || runtime.lastMcpToolError || "MCP unavailable",
			);
		},
	});

	pi.registerTool({
		name: "mempalace_mine",
		label: "MemPalace Mine",
		description: "Mine a project or conversation export into MemPalace.",
		promptSnippet: "Mine a project directory or conversation export into MemPalace.",
		parameters: Type.Object({
			path: Type.String({ description: "Directory or source path to mine" }),
			mode: Type.Optional(StringEnum(["project", "convos"] as const)),
			extract: Type.Optional(StringEnum(["general"] as const)),
			wing: Type.Optional(Type.String({ description: "Optional wing override" })),
			split: Type.Optional(StringEnum(["none", "dry-run", "run"] as const)),
		}),
		async execute(_toolCallId, params, signal) {
			const sourcePath = stripAtPrefix(params.path);
			const outputs: string[] = [];
			const details: Record<string, unknown> = { sourcePath };
			let failed = false;
			let reconnected = false;

			if (params.split && params.split !== "none") {
				const splitArgs = ["split", sourcePath];
				if (params.split === "dry-run") splitArgs.push("--dry-run");
				const splitRun = await runMemPalace(pi, splitArgs, signal);
				const splitGuidance = getMemPalaceSetupGuidanceFromExec(splitRun.command, splitRun.result) || getMemPalaceSetupGuidance(runtime.mcpStartupError);
				if (splitRun.result.code !== 0 && splitGuidance) {
					return unavailableToolResult("MemPalace split", splitGuidance, splitRun.command, splitRun.result);
				}
				outputs.push(formatExecOutput("MemPalace split", splitRun.command, splitRun.result));
				details.split = { command: splitRun.command, exitCode: splitRun.result.code };
				if (splitRun.result.code !== 0) failed = true;
			}

			const mineArgs = ["mine", sourcePath];
			if (params.mode && params.mode !== "project") mineArgs.push("--mode", params.mode);
			if (params.extract) mineArgs.push("--extract", params.extract);
			if (params.wing) mineArgs.push("--wing", params.wing);
			const mineRun = await runMemPalace(pi, mineArgs, signal);
			const mineGuidance = getMemPalaceSetupGuidanceFromExec(mineRun.command, mineRun.result) || getMemPalaceSetupGuidance(runtime.mcpStartupError);
			if (mineRun.result.code !== 0 && mineGuidance) {
				return unavailableToolResult("MemPalace mine", mineGuidance, mineRun.command, mineRun.result);
			}
			outputs.push(formatExecOutput("MemPalace mine", mineRun.command, mineRun.result));
			details.mine = { command: mineRun.command, exitCode: mineRun.result.code };
			if (mineRun.result.code !== 0) failed = true;
			if (mineRun.result.code === 0) {
				const reconnect = await runtime.reconnectPalace(signal);
				reconnected = Boolean(reconnect?.success);
				details.reconnect = reconnect;
				if (reconnected) {
					outputs.push("MemPalace reconnect: refreshed MCP state after CLI mine");
				}
			}

			return {
				content: [{ type: "text" as const, text: outputs.join("\n\n") }],
				details,
				isError: failed,
			};
		},
	});
}
