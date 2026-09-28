import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AUTO_SAVE_MARKER, PRECOMPACT_BLOCK_REASON, SAVE_INTERVAL, STOP_BLOCK_REASON } from "./constants";
import type { MemPalaceRuntime } from "./runtime";
import { canForegroundIngestSatisfyPrecompact } from "./auto-ingest-policy.js";
import { shouldShowHookToast, shouldUseSilentSave } from "./hook-settings-policy.js";
import {
	countRelevantUserMessages,
	getMemPalaceSetupGuidance,
	getRelevantUserMessageKey,
	maybeAutoIngest,
	probePythonEnvironment,
	refineSetupGuidance,
	sendUserMessage,
} from "./utils";

export function registerHooks(pi: ExtensionAPI, runtime: MemPalaceRuntime) {
	// Pi rejects prompts while a compaction is in progress, including from inside
	// session_before_compact. The save checkpoint is held here and sent from
	// session_compact_failed, which pi emits after it clears the compaction state.
	let pendingPrecompactPrompt: string | undefined;
	// Set when we cancel a compaction to take a save checkpoint first. The user asked for
	// that compaction, so we owe them it: agent_end re-requests it once the save turn is
	// done. Without this the cancel is terminal — /compact only ever files memories, and
	// the caller has to run it a second time. Worse, any message they send in between
	// changes the getRelevantUserMessageKey, so the second /compact is a fresh key and
	// gets cancelled too: context never drops no matter how often they ask.
	let resumeCompactionAfterSave = false;

	pi.on("session_start", async (_event, ctx) => {
		runtime.loadState(ctx);
		const { tools: localTools } = await runtime.ensureLocalFallbackTools();
		const { tools } = await runtime.ensureMcpConnected();
		await runtime.refreshHookSettings();
		runtime.registerDiscoveredMcpTools();
		runtime.registerDiscoveredFallbackTools();
		if (ctx.hasUI && tools.length > 0) {
			ctx.ui.notify(`MemPalace MCP connected (${tools.length} tools)`, "success");
			return;
		}
		if (ctx.hasUI && localTools.length > 0) {
			ctx.ui.notify(`MemPalace local fallback ready (${localTools.length} tools)`, "info");
			return;
		}

		const probe = await probePythonEnvironment(pi).catch(() => undefined);
		const guidance = refineSetupGuidance(getMemPalaceSetupGuidance(runtime.mcpStartupError), probe);
		if (!guidance || runtime.hasShownSetupNotice) return;
		runtime.hasShownSetupNotice = true;
		if (ctx.hasUI) {
			ctx.ui.notify(guidance, "warning");
		}
		pi.sendMessage({
			customType: "mempalace-notice",
			content: guidance,
			display: true,
			details: { severity: "warning", source: "session_start", error: runtime.mcpStartupError },
		});
	});

	pi.on("session_tree", async (_event, ctx) => {
		runtime.loadState(ctx);
	});

	pi.on("session_shutdown", async () => {
		await runtime.shutdown();
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Resume the compaction we cancelled for the save checkpoint, before the
		// interval auto-save below can inject another prompt and defer it again.
		// The save prompt carries AUTO_SAVE_MARKER, which getRelevantUserMessages
		// filters out, so the warning key is unchanged and session_before_compact
		// takes its `lastPreCompactWarningKey === warningKey` early return this time.
		if (resumeCompactionAfterSave) {
			resumeCompactionAfterSave = false;
			ctx.compact({
				onError: (error) => {
					if (ctx.hasUI) {
						ctx.ui.notify(`MemPalace: compaction after save failed: ${error.message}`, "error");
					}
				},
			});
			return;
		}

		const currentCount = countRelevantUserMessages(ctx);
		if (currentCount <= 0) return;
		if (currentCount - runtime.lastAutoSaveCount < SAVE_INTERVAL) return;

		const hookSettings = await runtime.refreshHookSettings();
		const ingest = await maybeAutoIngest(pi, ctx, undefined, "background");
		if (ingest.started) {
			runtime.lastAutoSaveCount = currentCount;
		}
		runtime.recordAutoIngest(ingest);
		runtime.persistState();
		if (shouldUseSilentSave(hookSettings)) {
			const filedAway = await runtime.acknowledgeMemoriesFiledAway();
			if (ctx.hasUI && shouldShowHookToast(hookSettings)) {
				ctx.ui.notify(
					filedAway?.status === "ok"
						? filedAway.message || `MemPalace auto-save checkpoint filed (${currentCount} messages)`
						: `MemPalace auto-save checkpoint queued silently (${currentCount} messages)`,
					filedAway?.status === "ok" ? "success" : "info",
				);
			}
			runtime.persistState();
			return;
		}
		if (ctx.hasUI && shouldShowHookToast(hookSettings)) {
			ctx.ui.notify(`MemPalace auto-save checkpoint triggered (${currentCount} messages)`, "info");
		}
		sendUserMessage(pi, ctx, `${AUTO_SAVE_MARKER}\n${STOP_BLOCK_REASON}`);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const warningKey = getRelevantUserMessageKey(event.branchEntries);
		if (!warningKey) {
			return;
		}
		if (runtime.lastPreCompactWarningKey === warningKey) {
			return;
		}

		const hookSettings = await runtime.refreshHookSettings(event.signal);
		const ingest = await maybeAutoIngest(pi, ctx, event.signal, "foreground");
		runtime.recordAutoIngest(ingest);
		if (canForegroundIngestSatisfyPrecompact(ingest)) {
			const reconnect = await runtime.reconnectPalace(event.signal);
			const filedAway = await runtime.acknowledgeMemoriesFiledAway(event.signal);
			runtime.persistState();
			if (ctx.hasUI && shouldShowHookToast(hookSettings)) {
				const suffix = reconnect?.success ? " and reconnected" : "";
				const message = filedAway?.status === "ok" ? `${filedAway.message || "Memories filed away"}${suffix}` : `MemPalace pre-compact ingest completed${suffix}`;
				ctx.ui.notify(message, "success");
			}
			return;
		}

		runtime.lastPreCompactWarningKey = warningKey;
		runtime.persistState();
		if (ctx.hasUI && shouldShowHookToast(hookSettings)) {
			ctx.ui.notify("MemPalace pre-compact save checkpoint triggered", "warning");
		}
		pendingPrecompactPrompt = `${AUTO_SAVE_MARKER}\n${PRECOMPACT_BLOCK_REASON}`;
		resumeCompactionAfterSave = true;
		return { cancel: true };
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		if (!event.aborted || !pendingPrecompactPrompt) {
			return;
		}
		const text = pendingPrecompactPrompt;
		pendingPrecompactPrompt = undefined;
		sendUserMessage(pi, ctx, text);
	});
}
