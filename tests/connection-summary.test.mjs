import test from "node:test";
import assert from "node:assert/strict";
import { formatConnectionSummary } from "../src/connection-summary.js";

const status = {
	library_versions: { serving: { mempalace: "3.11.0" } },
	total_drawers: 373652,
};

test("startup summary shows the serving version, homelab source, and drawer count", () => {
	assert.equal(
		formatConnectionSummary(status, 62, { MEMPALACE_MCP_URL: "http://mempalace.lan/mcp" }),
		"MemPalace v3.11.0 · homelab (mempalace.lan) · 373,652 drawers · 62 tools",
	);
});

test("other servers show their host, never credentials or URL parameters", () => {
	assert.equal(
		formatConnectionSummary(status, 62, { MEMPALACE_MCP_URL: "https://user:secret@memory.example:8765/mcp?token=secret" }),
		"MemPalace v3.11.0 · memory.example:8765 · 373,652 drawers · 62 tools",
	);
});

test("stdio MCP is local and zero drawers is a valid count", () => {
	assert.equal(
		formatConnectionSummary({ ...status, total_drawers: 0 }, 62, {}),
		"MemPalace v3.11.0 · local MCP · 0 drawers · 62 tools",
	);
});

test("missing status and malformed URLs still produce a usable connection notice", () => {
	assert.equal(
		formatConnectionSummary(undefined, 62, { MEMPALACE_MCP_URL: "invalid" }),
		"MemPalace · remote MCP · status unavailable · 62 tools",
	);
	assert.equal(formatConnectionSummary({}, 62, {}), "MemPalace · local MCP · status unavailable · 62 tools");
});
