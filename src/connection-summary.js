import { sharedServerUrl } from "./shared-server-policy.js";

export function formatConnectionSummary(status, toolCount, env = process.env) {
	const url = sharedServerUrl(env);
	let source = "local MCP";
	if (url) {
		try {
			const host = new URL(url).host;
			source = new URL(url).hostname === "mempalace.lan" ? `homelab (${host})` : host;
		} catch {
			source = "remote MCP";
		}
	}
	const version = status?.library_versions?.serving?.mempalace;
	const drawers = status?.total_drawers;
	return [
		typeof version === "string" ? `MemPalace v${version}` : "MemPalace",
		source,
		typeof drawers === "number" && Number.isFinite(drawers)
			? `${drawers.toLocaleString("en-US")} drawers`
			: "status unavailable",
		`${toolCount} tools`,
	].join(" · ");
}
