import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export function registerRenderers(pi: ExtensionAPI) {
	pi.registerMessageRenderer("mempalace-notice", (message, _state, theme) => {
		const body = String(message.content ?? "");
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("warning", theme.bold("! MemPalace Setup Needed"))}\n\n${theme.fg("muted", body)}`, 0, 0));
		return box;
	});

	pi.registerMessageRenderer("mempalace-doctor", (message, { expanded }, theme) => {
		const details = (message.details ?? {}) as { ok?: boolean };
		const ok = !!details.ok;
		const title = ok ? theme.fg("success", theme.bold("✓ MemPalace Doctor")) : theme.fg("warning", theme.bold("! MemPalace Doctor"));
		const body = String(message.content ?? "");
		const sections = body
			.split(/\n\n+/)
			.map((line) => line.trim())
			.filter(Boolean);
		const shown = expanded ? sections : sections.slice(0, 8);
		const formatted = shown
			.map((line) => {
				if (line.includes(": ok")) return `${theme.fg("success", "✓")} ${theme.fg("muted", line.replace(/: ok$/, ""))}`;
				const reportsMissingItems = line.includes("missing ") && !line.endsWith(": none");
				if (line.includes(": unavailable") || line.includes(": failed") || reportsMissingItems) {
					return `${theme.fg("warning", "!")} ${theme.fg("muted", line)}`;
				}
				if (line.includes(":\n")) {
					const [head, ...rest] = line.split("\n");
					return `${theme.fg("accent", head)}\n${theme.fg("dim", rest.join("\n"))}`;
				}
				return `${theme.fg("accent", "•")} ${theme.fg("muted", line)}`;
			})
			.join("\n\n");
		const more = !expanded && sections.length > shown.length ? `\n\n${theme.fg("dim", `… ${sections.length - shown.length} more lines (expand to view)`)}` : "";
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${title}\n\n${formatted}${more}`, 0, 0));
		return box;
	});
}
