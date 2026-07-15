import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands";
import { registerHooks } from "./hooks";
import { registerRenderers } from "./renderers";
import { MemPalaceRuntime } from "./runtime";
import { registerTools } from "./tools";

export default function (pi: ExtensionAPI) {
	const runtime = new MemPalaceRuntime(pi);

	registerRenderers(pi);
	registerTools(pi, runtime);
	registerCommands(pi, runtime);
	registerHooks(pi, runtime);
	void runtime.ensureLocalFallbackTools();
}
