import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const EXTENSION_NAME = "mempalace-team-docs";
const GLOBAL_CONFIG_PATH = path.join(homedir(), ".pi", "agent", "mempalace-team-docs.json");

const DEFAULT_CONFIG = {
	enabled: true,
	docsRoot: "docs",
	defaultFolder: "memory",
	mode: "auto",
	blockOnSecret: false,
	requireGitRepo: false,
	includeDiaryWrites: true,
	excludeWings: ["wing_user", "wing_chatgpt"],
	excludeRooms: ["diary", "personal"],
	redactEmails: false,
	categoryFolders: {
		decision: "decisions",
		architecture: "architecture",
		incident: "incidents",
		runbook: "runbooks",
		testing: "testing",
		memory: "memory",
	},
} as const;

type Category = keyof typeof DEFAULT_CONFIG.categoryFolders;
type Config = typeof DEFAULT_CONFIG;
type PartialConfig = Partial<Omit<Config, "categoryFolders">> & {
	categoryFolders?: Partial<Record<Category, string>>;
};

type RepoInfo = {
	repoRoot: string;
	isGitRepo: boolean;
};

type MemoryInput = {
	kind: "drawer" | "diary";
	wing?: string;
	room?: string;
	sharedBy?: string;
	content: string;
};

type Classification = {
	shareable: boolean;
	category: Category;
	reason: string;
};

type RedactionResult = {
	text: string;
	highRisk: boolean;
	reasons: string[];
};

type WritePlan = {
	title: string;
	category: Category;
	relativePath: string;
	absolutePath: string;
	markdown: string;
};

type ProcessResult =
	| { status: "created" | "appended" | "unchanged"; relativePath: string }
	| { status: "skipped"; reason: string; isSecret?: boolean };

const POLICY_PROMPT = `
## MemPalace team-doc policy

Local/personal memory is not enough for team-useful project knowledge. If you store a MemPalace drawer or diary entry containing team-useful project knowledge, a sanitized Markdown note must also exist in this repository's docs tree. Do not write secrets, credentials, PII, private chats, or raw sensitive logs into team docs.`;

const CATEGORY_KEYWORDS: Record<Category, RegExp[]> = {
	decision: [
		/\b(adr|decision|decided|chose|chosen|trade-?off|product decision|architectural decision)\b/i,
	],
	architecture: [
		/\b(architecture|architectural|design|system|service|api contract|interface|schema|migration|data flow|integration|convention)\b/i,
	],
	incident: [
		/\b(incident|root cause|postmortem|outage|production|deploy(?:ment)? failure|ci failure|debugging|bug|regression|flaky)\b/i,
	],
	runbook: [/\b(runbook|procedure|operational|rollback|recover|playbook|steps to|how to|deploy steps)\b/i],
	testing: [/\b(test|testing|qa|coverage|spec|e2e|integration test|unit test|verification|findings)\b/i],
	memory: [
		/\b(implementation plan|project convention|gotcha|follow-?up|action item|todo|teammate|team|api|migration)\b/i,
	],
};

const PRIVATE_KEYWORDS = [
	/\b(personal diary|private diary|reflection|feelings?|mood|private chat|customer pii|user preference|prefers?)\b/i,
	/\b(local-only|only on my machine|would not help teammates)\b/i,
];

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function nowTime(): string {
	return new Date().toISOString().slice(11, 16);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readJsonIfExists(file: string): Promise<PartialConfig | undefined> {
	try {
		const raw = await readFile(file, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return isPlainObject(parsed) ? (parsed as PartialConfig) : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function mergeConfig(base: Config, override?: PartialConfig): Config {
	if (!override) return base;
	return {
		...base,
		...override,
		categoryFolders: {
			...base.categoryFolders,
			...(override.categoryFolders ?? {}),
		},
	} as Config;
}

async function findRepoRoot(cwd: string): Promise<RepoInfo> {
	let current = path.resolve(cwd || process.cwd());
	while (true) {
		try {
			await stat(path.join(current, ".git"));
			return { repoRoot: current, isGitRepo: true };
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return { repoRoot: path.resolve(cwd || process.cwd()), isGitRepo: false };
			current = parent;
		}
	}
}

async function loadConfig(cwd: string): Promise<{ config: Config; configPath?: string; repo: RepoInfo }> {
	const repo = await findRepoRoot(cwd);
	const globalConfig = await readJsonIfExists(GLOBAL_CONFIG_PATH);
	const projectConfigPath = path.join(repo.repoRoot, ".pi", "mempalace-team-docs.json");
	const projectConfig = await readJsonIfExists(projectConfigPath);
	const config = mergeConfig(mergeConfig({ ...DEFAULT_CONFIG, categoryFolders: { ...DEFAULT_CONFIG.categoryFolders } }, globalConfig), projectConfig);
	return { config, configPath: projectConfig ? projectConfigPath : globalConfig ? GLOBAL_CONFIG_PATH : undefined, repo };
}

function safeRelativeSegment(value: string, fallback: string): string {
	const normalized = path.normalize(value || fallback).replace(/^([/\\])+/, "");
	if (!normalized || normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) return fallback;
	return normalized
		.split(/[\\/]+/)
		.filter((part) => part && part !== "." && part !== "..")
		.map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-") || fallback)
		.join(path.sep);
}

function baseToolName(toolName: string): string {
	return toolName.split(/[./]/).pop() ?? toolName;
}

function isMemPalaceWriteTool(toolName: string): boolean {
	const name = baseToolName(toolName);
	return name === "mempalace_add_drawer" || name === "mempalace_diary_write";
}

function memoryInputFromTool(toolName: string, input: unknown): MemoryInput | undefined {
	if (!isPlainObject(input)) return undefined;
	const name = baseToolName(toolName);
	if (name === "mempalace_add_drawer") {
		const content = typeof input.content === "string" ? input.content : "";
		if (!content.trim()) return undefined;
		return {
			kind: "drawer",
			wing: typeof input.wing === "string" ? input.wing : undefined,
			room: typeof input.room === "string" ? input.room : undefined,
			sharedBy: typeof input.added_by === "string" ? input.added_by : undefined,
			content,
		};
	}
	if (name === "mempalace_diary_write") {
		const content = typeof input.entry === "string" ? input.entry : "";
		if (!content.trim()) return undefined;
		return {
			kind: "diary",
			room: typeof input.topic === "string" ? input.topic : undefined,
			sharedBy: typeof input.agent_name === "string" ? input.agent_name : undefined,
			content,
		};
	}
	return undefined;
}

function matchesExcluded(value: string | undefined, excludes: readonly string[]): boolean {
	if (!value) return false;
	const lower = value.toLowerCase();
	return excludes.some((item) => item.toLowerCase() === lower || lower.includes(item.toLowerCase()));
}

function classifyMemory(memory: MemoryInput, config: Config): Classification {
	const haystack = `${memory.wing ?? ""}\n${memory.room ?? ""}\n${memory.content}`;
	if (matchesExcluded(memory.wing, config.excludeWings)) {
		return { shareable: false, category: "memory", reason: `excluded wing ${memory.wing}` };
	}
	if (matchesExcluded(memory.room, config.excludeRooms)) {
		return { shareable: false, category: "memory", reason: `excluded room/topic ${memory.room}` };
	}
	if (memory.kind === "diary" && !config.includeDiaryWrites) {
		return { shareable: false, category: "memory", reason: "diary writes disabled" };
	}

	const categoryScores = Object.entries(CATEGORY_KEYWORDS).map(([category, patterns]) => ({
		category: category as Category,
		score: patterns.reduce((score, pattern) => score + (pattern.test(haystack) ? 1 : 0), 0),
	}));
	categoryScores.sort((a, b) => b.score - a.score);
	const best = categoryScores[0] ?? { category: "memory" as Category, score: 0 };
	const privateScore = PRIVATE_KEYWORDS.reduce((score, pattern) => score + (pattern.test(haystack) ? 1 : 0), 0);

	if (best.score === 0) {
		return { shareable: false, category: "memory", reason: "classified as personal/private or local-only" };
	}
	if (privateScore > best.score && memory.kind === "diary") {
		return { shareable: false, category: "memory", reason: "classified as personal/private" };
	}
	return { shareable: true, category: best.category, reason: `matched ${best.category} project/team knowledge` };
}

function redactSensitiveText(input: string, config: Config): RedactionResult {
	const reasons: string[] = [];
	let highRisk = false;
	let text = input;

	const highRiskPatterns: Array<[RegExp, string]> = [
		[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private key"],
		[/\bsk_live_[A-Za-z0-9]{16,}\b/g, "live Stripe secret key"],
		[/\bgh[pousr]_[A-Za-z0-9_]{24,}\b/g, "GitHub token"],
		[/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "Slack token"],
		[/\bAKIA[0-9A-Z]{16}\b/g, "AWS access key"],
	];

	for (const [pattern, reason] of highRiskPatterns) {
		if (pattern.test(text)) {
			highRisk = true;
			reasons.push(reason);
		}
	}

	text = text.replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s`'"<>]+/gi, (_match, prefix: string) => {
		reasons.push("authorization header");
		return `${prefix}[REDACTED]`;
	});
	text = text.replace(
		/^([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(.+)$/gim,
		(_match, prefix: string) => {
			reasons.push("environment secret value");
			return `${prefix}[REDACTED]`;
		},
	);
	text = text.replace(/\/Users\/[^/\s]+\//g, "~/");
	text = text.replace(/\b(?:\d[ -]*?){13,16}\b/g, (match) => {
		const digits = match.replace(/\D/g, "");
		if (digits.length < 13 || digits.length > 16) return match;
		reasons.push("possible payment card");
		return "[REDACTED-CARD]";
	});
	text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => {
		reasons.push("possible SSN");
		return "[REDACTED-SSN]";
	});
	text = text.replace(/\b\+?1?[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, () => {
		reasons.push("possible phone number");
		return "[REDACTED-PHONE]";
	});
	if (config.redactEmails) {
		text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, () => {
			reasons.push("email address");
			return "[REDACTED-EMAIL]";
		});
	}

	return { text, highRisk, reasons: [...new Set(reasons)] };
}

function firstMeaningfulParagraph(text: string): string {
	const paragraphs = text
		.replace(/```[\s\S]*?```/g, "")
		.split(/\n\s*\n/g)
		.map((part) => part.replace(/^#+\s+/gm, "").trim())
		.filter(Boolean);
	return paragraphs[0] ?? text.trim();
}

function truncateText(text: string, max = 6000): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max).trimEnd()}\n\n_[Truncated for team doc review.]_`;
}

function titleFromMemory(memory: MemoryInput, sanitizedContent: string): string {
	const heading = sanitizedContent.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
	const candidate = heading || memory.room || firstMeaningfulParagraph(sanitizedContent).split(/\n/)[0] || "Shared MemPalace note";
	return candidate
		.replace(/[`*_#[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 90) || "Shared MemPalace note";
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/['"]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || "mempalace-note";
}

function summaryFromContent(sanitizedContent: string): string {
	const paragraph = firstMeaningfulParagraph(sanitizedContent).replace(/\s+/g, " ").trim();
	if (!paragraph) return "MemPalace note captured for team review.";
	return paragraph.length > 500 ? `${paragraph.slice(0, 497).trimEnd()}...` : paragraph;
}

function whyThisMatters(category: Category): string[] {
	switch (category) {
		case "decision":
			return ["Records decision context teammates should not have to rediscover.", "Helps future changes preserve the intended trade-offs."];
		case "architecture":
			return ["Explains system structure and design constraints for future contributors.", "Reduces onboarding and review ambiguity."];
		case "incident":
			return ["Captures root-cause/debugging knowledge before it is lost.", "Helps teammates recognize or prevent similar failures."];
		case "runbook":
			return ["Provides repeatable operational steps for teammates.", "Reduces reliance on individual memory during incidents or deployments."];
		case "testing":
			return ["Preserves verification findings and test strategy context.", "Helps teammates avoid repeating brittle or ineffective checks."];
		default:
			return ["Captures useful project context for teammates.", "Makes local memory discoverable in repository documentation."];
	}
}

function extractFollowUps(text: string): string[] {
	return text
		.split(/\n+/)
		.map((line) => line.trim().replace(/^[-*]\s*/, "").replace(/^\[[ xX]\]\s*/, ""))
		.map((line) => {
			const explicit = line.match(/\b(?:todo|follow-?up|next step|action item):\s*(.+)$/i);
			return explicit?.[1]?.trim() || line;
		})
		.filter((line) => /\b(todo|follow-?up|next step|action item|needs?|should|add|fix|update|create|write|verify|document)\b/i.test(line))
		.slice(0, 5);
}

function buildMarkdown(memory: MemoryInput, category: Category, title: string, sanitizedContent: string): string {
	const summary = summaryFromContent(sanitizedContent);
	const details = truncateText(sanitizedContent.trim());
	const matters = whyThisMatters(category).map((line) => `- ${line}`).join("\n");
	const followUps = extractFollowUps(sanitizedContent);
	const followUpSection = followUps.length > 0 ? followUps.map((line) => `- [ ] ${line}`).join("\n") : "_None captured._";
	const meta = [
		`Date: ${today()}`,
		"Source: MemPalace",
		memory.wing ? `Wing: ${memory.wing}` : undefined,
		memory.room ? `Room: ${memory.room}` : undefined,
		memory.sharedBy ? `Shared by: ${memory.sharedBy}` : undefined,
	]
		.filter(Boolean)
		.join("\n");

	return `# ${title}\n\n${meta}\n\n## Summary\n\n${summary}\n\n## Details\n\n${details}\n\n## Why this matters for the team\n\n${matters}\n\n## Follow-ups\n\n${followUpSection}\n`;
}

function buildAppendSection(memory: MemoryInput, category: Category, sanitizedContent: string): string {
	const summary = summaryFromContent(sanitizedContent);
	const details = truncateText(sanitizedContent.trim());
	const matters = whyThisMatters(category).map((line) => `- ${line}`).join("\n");
	const followUps = extractFollowUps(sanitizedContent);
	const followUpSection = followUps.length > 0 ? followUps.map((line) => `- [ ] ${line}`).join("\n") : "_None captured._";
	const meta = [
		`Date: ${today()}`,
		"Source: MemPalace",
		memory.wing ? `Wing: ${memory.wing}` : undefined,
		memory.room ? `Room: ${memory.room}` : undefined,
		memory.sharedBy ? `Shared by: ${memory.sharedBy}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
	return `\n---\n\n## Additional note — ${nowTime()}\n\n${meta}\n\n### Summary\n\n${summary}\n\n### Details\n\n${details}\n\n### Why this matters for the team\n\n${matters}\n\n### Follow-ups\n\n${followUpSection}\n`;
}

function makeWritePlan(repoRoot: string, config: Config, memory: MemoryInput, category: Category, sanitizedContent: string): WritePlan {
	const title = titleFromMemory(memory, sanitizedContent);
	const docsRoot = safeRelativeSegment(config.docsRoot, DEFAULT_CONFIG.docsRoot);
	const configuredFolder = config.categoryFolders[category] ?? config.defaultFolder;
	const folder = safeRelativeSegment(configuredFolder, config.defaultFolder);
	const fileName = `${today()}-${slugify(title)}.md`;
	const relativePath = path.join(docsRoot, folder, fileName);
	return {
		title,
		category,
		relativePath,
		absolutePath: path.join(repoRoot, relativePath),
		markdown: buildMarkdown(memory, category, title, sanitizedContent),
	};
}

async function writeTeamDoc(plan: WritePlan, memory: MemoryInput, category: Category, sanitizedContent: string): Promise<"created" | "appended" | "unchanged"> {
	await mkdir(path.dirname(plan.absolutePath), { recursive: true });
	try {
		await access(plan.absolutePath);
		const current = await readFile(plan.absolutePath, "utf8");
		const duplicateNeedle = sanitizedContent.trim().slice(0, 500);
		if (duplicateNeedle && current.includes(duplicateNeedle)) return "unchanged";
		const appendSection = buildAppendSection(memory, category, sanitizedContent);
		await writeFile(plan.absolutePath, `${current.replace(/\s*$/u, "\n")}${appendSection}`, "utf8");
		return "appended";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await writeFile(plan.absolutePath, plan.markdown, "utf8");
		return "created";
	}
}

async function processMemory(memory: MemoryInput, cwd: string): Promise<ProcessResult> {
	if (!memory.content.trim()) return { status: "skipped", reason: "no memory content found" };

	const { config, repo } = await loadConfig(cwd);
	if (!config.enabled) return { status: "skipped", reason: "extension disabled" };
	if (config.requireGitRepo && !repo.isGitRepo) return { status: "skipped", reason: "no git repository found" };

	const classification = classifyMemory(memory, config);
	if (!classification.shareable) return { status: "skipped", reason: classification.reason };

	const redaction = redactSensitiveText(memory.content, config);
	if (redaction.highRisk) {
		return {
			status: "skipped",
			reason: `high-risk secret pattern detected (${redaction.reasons.join(", ")}); not written`,
			isSecret: true,
		};
	}

	const sanitizedMemory = { ...memory, content: redaction.text };
	const plan = makeWritePlan(repo.repoRoot, config, sanitizedMemory, classification.category, redaction.text);
	const status = await writeTeamDoc(plan, sanitizedMemory, classification.category, redaction.text);
	return { status, relativePath: plan.relativePath };
}

async function processMemoryWrite(toolName: string, input: unknown, cwd: string): Promise<ProcessResult> {
	const memory = memoryInputFromTool(toolName, input);
	if (!memory) return { status: "skipped", reason: "no memory content found" };
	return processMemory(memory, cwd);
}

function appendToolResultNote(content: unknown, note: string): Array<{ type: "text"; text: string }> {
	if (Array.isArray(content)) {
		const next = [...content] as Array<{ type?: string; text?: string }>;
		const lastTextIndex = next.map((part) => part.type).lastIndexOf("text");
		if (lastTextIndex >= 0 && typeof next[lastTextIndex]?.text === "string") {
			next[lastTextIndex] = { ...next[lastTextIndex], text: `${next[lastTextIndex].text}\n\n${note}` };
			return next as Array<{ type: "text"; text: string }>;
		}
		return [...(next as Array<{ type: "text"; text: string }>), { type: "text", text: note }];
	}
	if (typeof content === "string" && content.trim()) return [{ type: "text", text: `${content}\n\n${note}` }];
	return [{ type: "text", text: note }];
}

async function writeProjectEnabledConfig(cwd: string, enabled: boolean): Promise<string> {
	const repo = await findRepoRoot(cwd);
	const configPath = path.join(repo.repoRoot, ".pi", "mempalace-team-docs.json");
	const current = (await readJsonIfExists(configPath)) ?? {};
	await mkdir(path.dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify({ ...current, enabled }, null, 2)}\n`, "utf8");
	return configPath;
}

async function statusText(cwd: string): Promise<string> {
	const { config, configPath, repo } = await loadConfig(cwd);
	const docsRoot = path.join(repo.repoRoot, safeRelativeSegment(config.docsRoot, DEFAULT_CONFIG.docsRoot));
	return [
		`enabled: ${config.enabled}`,
		`config: ${configPath ?? "defaults"}`,
		`repo root: ${repo.repoRoot}${repo.isGitRepo ? "" : " (no .git found)"}`,
		`docs root: ${docsRoot}`,
	].join("\n");
}

async function dryRunText(cwd: string, text: string): Promise<string> {
	const { config, repo } = await loadConfig(cwd);
	const memory: MemoryInput = { kind: "drawer", content: text, room: undefined, wing: undefined };
	const classification = classifyMemory(memory, config);
	const redaction = redactSensitiveText(text, config);
	const plan = makeWritePlan(repo.repoRoot, config, memory, classification.category, redaction.text);
	return [
		`shareable: ${classification.shareable}`,
		`category: ${classification.category}`,
		`reason: ${classification.reason}`,
		`secret risk: ${redaction.highRisk ? redaction.reasons.join(", ") || "yes" : "no"}`,
		`target: ${plan.relativePath}`,
	].join("\n");
}

type ImportExistingOptions = {
	dryRun: boolean;
	wing?: string;
	limit: number;
};

type StatusWing = {
	wing: string;
	drawers: number;
};

function parseImportExistingArgs(args: string): ImportExistingOptions {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const options: ImportExistingOptions = { dryRun: false, limit: 10_000 };
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (part === "--dry-run" || part === "dry-run") {
			options.dryRun = true;
			continue;
		}
		if (part === "--wing") {
			options.wing = parts[index + 1];
			index += 1;
			continue;
		}
		if (part?.startsWith("--wing=")) {
			options.wing = part.slice("--wing=".length);
			continue;
		}
		if (part === "--limit") {
			const parsed = Number.parseInt(parts[index + 1] ?? "", 10);
			if (Number.isFinite(parsed) && parsed > 0) options.limit = parsed;
			index += 1;
			continue;
		}
		if (part?.startsWith("--limit=")) {
			const parsed = Number.parseInt(part.slice("--limit=".length), 10);
			if (Number.isFinite(parsed) && parsed > 0) options.limit = parsed;
		}
	}
	return options;
}

function parseStatusWings(output: string): StatusWing[] {
	const wings: StatusWing[] = [];
	let current: StatusWing | undefined;
	for (const line of output.split(/\r?\n/)) {
		const wingMatch = line.match(/^\s*WING:\s*(.+?)\s*$/);
		if (wingMatch) {
			current = { wing: wingMatch[1].trim(), drawers: 0 };
			wings.push(current);
			continue;
		}
		const roomMatch = line.match(/^\s*ROOM:\s+.+?\s+(\d+)\s+drawers?\s*$/);
		if (current && roomMatch) current.drawers += Number.parseInt(roomMatch[1], 10) || 0;
	}
	return wings;
}

async function repoWingCandidates(repoRoot: string): Promise<string[]> {
	const base = path.basename(repoRoot);
	const candidates = new Set([base, base.replace(/-/g, "_"), base.replace(/_/g, "-")]);
	try {
		const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as { name?: unknown };
		if (typeof pkg.name === "string" && pkg.name.trim()) {
			candidates.add(pkg.name.trim());
			candidates.add(pkg.name.trim().replace(/-/g, "_"));
			candidates.add(pkg.name.trim().replace(/_/g, "-"));
		}
	} catch {
		// package.json is optional.
	}
	return [...candidates];
}

function parseMemPalaceSearchResults(output: string): MemoryInput[] {
	const memories: MemoryInput[] = [];
	let current: { wing: string; room: string; lines: string[] } | undefined;
	const flush = () => {
		if (!current) return;
		const content = current.lines
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		if (content) memories.push({ kind: "drawer", wing: current.wing, room: current.room, content });
	};

	for (const line of output.split(/\r?\n/)) {
		const header = line.match(/^\s*\[\d+\]\s+(.+?)\s+\/\s+(.+?)\s*$/);
		if (header) {
			flush();
			current = { wing: header[1].trim(), room: header[2].trim(), lines: [] };
			continue;
		}
		if (!current) continue;
		if (/^\s*[─-]{8,}\s*$/.test(line)) continue;
		if (/^\s*(Source|Match):\s/.test(line)) continue;
		current.lines.push(line.replace(/^\s{6}/, ""));
	}
	flush();

	const seen = new Set<string>();
	return memories.filter((memory) => {
		const key = `${memory.wing}\u0000${memory.room}\u0000${memory.content}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function summarizeImportResults(results: ProcessResult[], dryRun: boolean, wings: string[]): string {
	const count = (status: ProcessResult["status"]) => results.filter((result) => result.status === status).length;
	const targets = [...new Set(results.flatMap((result) => ("relativePath" in result ? [result.relativePath] : [])))].slice(0, 12);
	return [
		`✅ MemPalace existing-memory ${dryRun ? "dry run" : "import"} complete`,
		`wings: ${wings.join(", ") || "none"}`,
		`examined: ${results.length}`,
		`created: ${dryRun ? 0 : count("created")}`,
		`updated: ${dryRun ? 0 : count("appended")}`,
		`unchanged: ${count("unchanged")}`,
		`skipped: ${count("skipped")}`,
		targets.length ? `targets:\n${targets.map((target) => `- ${target}`).join("\n")}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

async function importExistingMemories(
	pi: ExtensionAPI,
	cwd: string,
	options: ImportExistingOptions,
	signal?: AbortSignal,
): Promise<string> {
	const { config, repo } = await loadConfig(cwd);
	if (!config.enabled) return "MemPalace existing-memory import skipped: extension disabled.";
	if (config.requireGitRepo && !repo.isGitRepo) return "MemPalace existing-memory import skipped: no git repository found.";

	const statusRun = await pi.exec("mempalace", ["status"], { signal, timeout: 60_000 });
	if (statusRun.code !== 0) {
		return `MemPalace existing-memory import failed: mempalace status exited ${statusRun.code}\n${statusRun.stderr || statusRun.stdout}`.trim();
	}

	const statusWings = parseStatusWings(statusRun.stdout);
	const candidates = options.wing ? [options.wing] : await repoWingCandidates(repo.repoRoot);
	const matchingWings = statusWings.filter((entry) => candidates.includes(entry.wing));
	const wings = options.wing ? [{ wing: options.wing, drawers: options.limit }] : matchingWings;
	if (wings.length === 0) {
		return `MemPalace existing-memory import skipped: no status wings matched this repo (${candidates.join(", ")}). Use --wing <name> to override.`;
	}

	const memories: MemoryInput[] = [];
	for (const wing of wings) {
		const resultCount = Math.max(1, Math.min(options.limit, wing.drawers || options.limit));
		const searchRun = await pi.exec("mempalace", ["search", "", "--wing", wing.wing, "--results", String(resultCount)], {
			signal,
			timeout: 120_000,
		});
		if (searchRun.code === 0) memories.push(...parseMemPalaceSearchResults(searchRun.stdout));
	}

	const results: ProcessResult[] = [];
	for (const memory of memories.slice(0, options.limit)) {
		if (options.dryRun) {
			const classification = classifyMemory(memory, config);
			if (!classification.shareable) {
				results.push({ status: "skipped", reason: classification.reason });
				continue;
			}
			const redaction = redactSensitiveText(memory.content, config);
			if (redaction.highRisk) {
				results.push({ status: "skipped", reason: `high-risk secret pattern detected (${redaction.reasons.join(", ")}); not written`, isSecret: true });
				continue;
			}
			const plan = makeWritePlan(repo.repoRoot, config, memory, classification.category, redaction.text);
			results.push({ status: "unchanged", relativePath: plan.relativePath });
			continue;
		}
		results.push(await processMemory(memory, cwd));
	}

	return summarizeImportResults(results, options.dryRun, wings.map((wing) => wing.wing));
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function commandOutput(pi: ExtensionAPI, ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.log(message);

	try {
		(pi as ExtensionAPI & { sendMessage?: (message: unknown, options?: unknown) => void }).sendMessage?.(
			{
				customType: "memory-docs",
				content: message,
				display: true,
				details: { level, source: EXTENSION_NAME },
			},
			{ deliverAs: "nextTurn" },
		);
	} catch {
		// Notifications/console output above are sufficient if session message injection is unavailable.
	}
}

export default function mempalaceTeamDocs(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n${POLICY_PROMPT}`,
	}));

	pi.on("tool_result", async (event, ctx) => {
		if (!isMemPalaceWriteTool(event.toolName) || event.isError) return undefined;

		try {
			const result = await processMemoryWrite(event.toolName, event.input, ctx.cwd);
			if (result.status === "created" || result.status === "appended" || result.status === "unchanged") {
				const action = result.status === "created" ? "created" : result.status === "appended" ? "updated" : "unchanged";
				const note = `Team doc ${action}: ${result.relativePath}`;
				notify(ctx, note, "info");
				return { content: appendToolResultNote(event.content, note) };
			}

			const note = result.isSecret ? `Team doc skipped: ${result.reason}` : `Team doc skipped: ${result.reason}.`;
			if (result.isSecret) notify(ctx, note, "warning");
			const patch: { content: Array<{ type: "text"; text: string }>; isError?: boolean } = {
				content: appendToolResultNote(event.content, note),
			};
			const { config } = await loadConfig(ctx.cwd);
			if (result.isSecret && config.blockOnSecret) patch.isError = true;
			return patch;
		} catch (error) {
			const note = `Team doc skipped: extension error (${(error as Error).message}).`;
			notify(ctx, note, "warning");
			return { content: appendToolResultNote(event.content, note) };
		}
	});

	pi.registerCommand("memory-docs", {
		description: "Manage MemPalace team docs mirroring (status|enable|disable|dry-run <text>|import-existing [--dry-run] [--wing <wing>] [--limit N])",
		getArgumentCompletions: (prefix) => {
			const options = ["status", "enable", "disable", "dry-run", "import-existing"];
			return options.filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [command, ...rest] = trimmed.split(/\s+/);
			if (!command || command === "status") {
				commandOutput(pi, ctx, await statusText(ctx.cwd), "info");
				return;
			}
			if (command === "enable" || command === "disable") {
				const enabled = command === "enable";
				const configPath = await writeProjectEnabledConfig(ctx.cwd, enabled);
				commandOutput(pi, ctx, `${EXTENSION_NAME} ${enabled ? "enabled" : "disabled"} in ${configPath}`, "info");
				return;
			}
			if (command === "dry-run") {
				const text = rest.join(" ").trim();
				if (!text) {
					commandOutput(pi, ctx, "Usage: /memory-docs dry-run <text>", "warning");
					return;
				}
				commandOutput(pi, ctx, await dryRunText(ctx.cwd, text), "info");
				return;
			}
			if (command === "import-existing") {
				const output = await importExistingMemories(pi, ctx.cwd, parseImportExistingArgs(rest.join(" ")), ctx.signal);
				commandOutput(pi, ctx, output, "info");
				return;
			}
			commandOutput(pi, ctx, "Usage: /memory-docs status|enable|disable|dry-run <text>|import-existing [--dry-run] [--wing <wing>] [--limit N]", "warning");
		},
	});
}

export const __mempalaceTeamDocsTest = {
	appendToolResultNote,
	classifyMemory,
	dryRunText,
	findRepoRoot,
	loadConfig,
	makeWritePlan,
	importExistingMemories,
	memoryInputFromTool,
	parseImportExistingArgs,
	parseMemPalaceSearchResults,
	parseStatusWings,
	processMemory,
	processMemoryWrite,
	redactSensitiveText,
	repoWingCandidates,
	statusText,
};
