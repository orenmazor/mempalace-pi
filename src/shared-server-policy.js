// Policy: when MEMPALACE_MCP_URL nominates a shared `mempalace serve`, this session must NOT
// fall back to a direct-palace transport.
//
// Why a refusal and not a fallback. `mempalace serve` holds the palace writer lease for its
// whole process lifetime (mcp_server._acquire_mcp_writer_lock, taken lazily on the first
// mutating call). Both fallback transports in runtime.runFallbackTool -- the `mempalace` CLI
// and the local python path -- open the palace directly, so the lease refuses them. Falling
// back is therefore not a degraded save, it is a guaranteed failed one, and it fails SILENTLY:
// the call returns, nothing is written, and the loss surfaces whenever someone next looks.
//
// This matters because of the circuit breaker above it: a single transport error trips
// `mcpCircuitOpen`, which routes EVERY tool here for the rest of the session with no half-open
// retry. Observed 2026-10-06 -- a whole session's writes discarded, with reads still working so
// nothing looked wrong.
//
// Plain .js and dependency-free to match the sibling policy modules (hook-settings-policy.js,
// auto-ingest-policy.js): node --test imports these directly, and runtime.ts cannot be imported
// under node's strip-only TypeScript mode (it uses a constructor parameter property).

/** The nominated shared-server URL, or undefined when this session may use a local transport. */
export function sharedServerUrl(env = process.env) {
	const url = env.MEMPALACE_MCP_URL;
	const trimmed = typeof url === "string" ? url.trim() : "";
	return trimmed || undefined;
}

/** `/healthz` on the shared server's origin, or undefined if the URL will not parse. */
export function sharedServerHealthUrl(url) {
	try {
		return new URL("/healthz", url).toString();
	} catch {
		return undefined;
	}
}

/**
 * The operator-facing explanation for refusing the fallback. Carries the originating MCP
 * failure through verbatim -- without it there is no way to tell a dead server from a tripped
 * circuit, which are different fixes.
 */
export function describeSharedServerRefusal(toolName, reason, url) {
	const health = sharedServerHealthUrl(url);
	const checks = [
		health ? `check it is up (curl -s -o /dev/null -w '%{http_code}' ${health})` : undefined,
		'restart it (launchctl kickstart -k "gui/$(id -u)/com.orenmazor.mempalace-serve")',
		"then start a new pi session, which rebuilds the MCP connection",
	].filter(Boolean);
	return (
		`MEMPALACE_MCP_URL is set (${url}), so ${toolName} must go through the shared MemPalace ` +
		`server and will NOT fall back to a direct-palace transport: that server holds the palace ` +
		`writer lease, so a fallback write would be refused and SILENTLY LOST. ` +
		`MCP is unavailable -- ${reason || "no reason reported"}. To recover, ${checks.join(", ")}. ` +
		`If the failure was a connect timeout, raise MEMPALACE_MCP_CONNECT_TIMEOUT_MS (default ` +
		`45000); initialize is slow on a large palace. To deliberately allow the local fallback, ` +
		`unset MEMPALACE_MCP_URL.`
	);
}
