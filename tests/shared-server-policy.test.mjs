import test from "node:test";
import assert from "node:assert/strict";
import {
	describeSharedServerRefusal,
	sharedServerHealthUrl,
	sharedServerUrl,
} from "../src/shared-server-policy.js";

const SHARED = "http://127.0.0.1:8765/mcp";

test("a nominated shared server is detected, and whitespace-only is not", () => {
	assert.equal(sharedServerUrl({ MEMPALACE_MCP_URL: SHARED }), SHARED);
	assert.equal(sharedServerUrl({ MEMPALACE_MCP_URL: `  ${SHARED}  ` }), SHARED);
	// An empty or blank value must read as "no shared server", otherwise an accidental
	// `export MEMPALACE_MCP_URL=` would refuse every fallback with nowhere to go.
	assert.equal(sharedServerUrl({ MEMPALACE_MCP_URL: "" }), undefined);
	assert.equal(sharedServerUrl({ MEMPALACE_MCP_URL: "   " }), undefined);
	assert.equal(sharedServerUrl({}), undefined);
});

test("health URL is derived from the origin, not appended to the MCP path", () => {
	assert.equal(sharedServerHealthUrl(SHARED), "http://127.0.0.1:8765/healthz");
	assert.equal(sharedServerHealthUrl("not a url"), undefined);
});

test("the refusal carries the originating MCP failure through verbatim", () => {
	// Without this, a dead server and a tripped circuit are indistinguishable, and they have
	// different fixes.
	const message = describeSharedServerRefusal("mempalace_checkpoint", "MCP circuit open: socket hang up", SHARED);
	assert.match(message, /MCP circuit open: socket hang up/);
	assert.match(message, /mempalace_checkpoint/);
	assert.match(message, /SILENTLY LOST/);
	assert.match(message, /MEMPALACE_MCP_CONNECT_TIMEOUT_MS/);
	assert.match(message, /launchctl kickstart/);
	// The escape hatch has to be discoverable from the error itself.
	assert.match(message, /unset MEMPALACE_MCP_URL/);
});

test("the refusal still reads sensibly with no reason and an unparseable URL", () => {
	// "garbage://" deliberately NOT used here: it parses fine as a URL with scheme "garbage:",
	// so it would still yield a health URL. This is a value new URL() actually rejects.
	const message = describeSharedServerRefusal("mempalace_add_drawer", undefined, "not a url");
	assert.match(message, /no reason reported/);
	// No health check offered when the URL will not parse, but the rest of the guidance survives.
	assert.doesNotMatch(message, /healthz/);
	assert.match(message, /launchctl kickstart/);
});
