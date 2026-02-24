import { Agent, type AgentEvent, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
	type Api,
	getModels,
	getProviders,
	type ImageContent,
	type KnownProvider,
	type Model,
} from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve as resolvePath } from "path";
import { maybeBuildArtifactUrl } from "./artifacts.js";
import { extractAttachmentText } from "./attachment-extractor.js";
import { MomSettingsManager, syncLogToSessionManager } from "./context.js";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelStore } from "./store.js";
import { createMomTools } from "./tools/index.js";
import type { BotContext, ChannelInfo, UserInfo } from "./whatsapp.js";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-6";
const MOM_WA_MODEL = process.env.MOM_WA_MODEL?.trim();
const VERBOSE_DETAILS = process.env.MOM_WA_VERBOSE_DETAILS === "1";
const MAX_EXTRACTED_ATTACHMENTS = 4;
const MAX_PARALLEL_ATTACHMENT_EXTRACTIONS = 2;
const ATTACHMENT_EXTRACTION_BUDGET_MS = 15000;

const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = ["off", "minimal", "low", "medium", "high", "xhigh"];

function parseModelSpec(spec: string): { provider: string; modelId: string } {
	const trimmed = spec.trim();
	if (!trimmed) {
		return { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL_ID };
	}
	if (trimmed.includes("/")) {
		const [provider, ...rest] = trimmed.split("/");
		const modelId = rest.join("/").trim();
		return {
			provider: provider.trim() || DEFAULT_PROVIDER,
			modelId: modelId || DEFAULT_MODEL_ID,
		};
	}
	return { provider: DEFAULT_PROVIDER, modelId: trimmed };
}

function resolveConfiguredModel(): { provider: string; modelId: string } {
	return parseModelSpec(MOM_WA_MODEL || `${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`);
}

function resolveModelOrThrow(provider: string, modelId: string): Model<Api> {
	const providerCandidate = provider as KnownProvider;
	if (!getProviders().includes(providerCandidate)) {
		throw new Error(`Unknown provider '${provider}'`);
	}
	const found = getModels(providerCandidate).find((model) => model.id === modelId);
	if (!found) {
		throw new Error(`Unknown model '${provider}/${modelId}'`);
	}
	return found;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: BotContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
	setModel(provider: string, modelId: string): { provider: string; modelId: string };
	getModel(): { provider: string; modelId: string };
	setThinkingLevel(level: ThinkingLevel): ThinkingLevel;
	getThinkingLevel(): ThinkingLevel;
}

function getAuthJsonPaths(): { agentAuth: string; momWhatsappAuth: string } {
	return {
		agentAuth: join(homedir(), ".pi", "agent", "auth.json"),
		momWhatsappAuth: join(homedir(), ".pi", "mom-whatsapp", "auth.json"),
	};
}

function authFileHasProvider(authPath: string, provider: string): boolean {
	if (!existsSync(authPath)) return false;
	try {
		const content = readFileSync(authPath, "utf-8").trim();
		if (!content) return false;
		const parsed = JSON.parse(content) as Record<string, unknown>;
		return provider in parsed;
	} catch {
		return false;
	}
}

function resolvePreferredAuthJsonPath(provider: string): string {
	const { agentAuth, momWhatsappAuth } = getAuthJsonPaths();
	if (authFileHasProvider(agentAuth, provider)) {
		return agentAuth;
	}
	if (authFileHasProvider(momWhatsappAuth, provider)) {
		return momWhatsappAuth;
	}
	if (existsSync(agentAuth)) {
		return agentAuth;
	}
	return momWhatsappAuth;
}

async function getApiKeyForProvider(
	provider: string | undefined,
	primaryAuthStorage: AuthStorage,
	secondaryAuthStorage: AuthStorage,
): Promise<string> {
	const resolvedProvider = provider?.trim();
	if (!resolvedProvider) {
		throw new Error("No model provider selected");
	}

	const primaryKey = await primaryAuthStorage.getApiKey(resolvedProvider);
	if (primaryKey) return primaryKey;

	const secondaryKey = await secondaryAuthStorage.getApiKey(resolvedProvider);
	if (secondaryKey) return secondaryKey;

	const { agentAuth, momWhatsappAuth } = getAuthJsonPaths();
	throw new Error(
		`No API key found for ${resolvedProvider}.\n\n` +
			`Set an API key environment variable, or use /login with ${resolvedProvider} and ensure auth exists at ` +
			`${agentAuth} or ${momWhatsappAuth}.`,
	);
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function getMemory(channelDir: string): string {
	const parts: string[] = [];

	// Read workspace-level memory (shared across all channels)
	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// Read channel-specific memory
	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

function loadMomSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();

	// channelDir is the host path (e.g., /Users/.../data/C0A34FL8PMH)
	// hostWorkspacePath is the parent directory on host
	// workspacePath is the container path (e.g., /workspace)
	const hostWorkspacePath = join(channelDir, "..");

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills (global)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		// Translate paths to container paths for system prompt
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills (override workspace skills on collision)
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";

	// Format channel mappings
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	// Format user mappings
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(no users loaded)";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	return `You are mom, a WhatsApp bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## WhatsApp IDs
Chats: ${channelMappings}

Users: ${userMappings}

Use plain text formatting. Keep responses concise for mobile chat.

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Global memory (all channels)
├── skills/                      # Global CLI tools you create
└── ${channelId}/                # This channel
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (channel-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePath}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This suppresses user-facing noise for periodic checks with no actionable updates.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isDocker ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to WhatsApp

Each tool requires a "label" parameter (shown to user).
`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function isSilentResponse(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "[SILENT]" || trimmed.startsWith("[SILENT]");
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

interface NonImageAttachment {
	containerPath: string;
	hostPath: string;
	commandPath: string;
}

function formatAttachmentExtractForPrompt(path: string, method: string, text: string): string {
	return [`<attachment_extract path="${path}" method="${method}">`, text, "</attachment_extract>"].join("\n");
}

async function extractAttachmentsForPrompt(
	channelId: string,
	attachments: NonImageAttachment[],
	options: { commandPrefix?: string[] },
): Promise<{ blocks: string[]; extractedCount: number }> {
	const candidates = attachments.slice(0, MAX_EXTRACTED_ATTACHMENTS);
	if (candidates.length === 0) {
		return { blocks: [], extractedCount: 0 };
	}

	const deadlineMs = Date.now() + ATTACHMENT_EXTRACTION_BUDGET_MS;
	const blocksByIndex: Array<string | null> = new Array(candidates.length).fill(null);
	let extractedCount = 0;
	let nextIndex = 0;

	const workerCount = Math.min(MAX_PARALLEL_ATTACHMENT_EXTRACTIONS, candidates.length);
	const workers: Array<Promise<void>> = [];
	for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
		workers.push(
			(async () => {
				while (true) {
					if (Date.now() >= deadlineMs) {
						return;
					}

					const attachmentIndex = nextIndex;
					if (attachmentIndex >= candidates.length) {
						return;
					}
					nextIndex += 1;

					const attachment = candidates[attachmentIndex];
					const extracted = await extractAttachmentText(attachment.hostPath, {
						deadlineMs,
						commandPath: attachment.commandPath,
						commandPrefix: options.commandPrefix,
					});
					if (!extracted) {
						continue;
					}

					extractedCount += 1;
					log.logInfo(
						`[${channelId}] Extracted text from attachment ${attachment.containerPath} via ${extracted.method}`,
					);
					blocksByIndex[attachmentIndex] = formatAttachmentExtractForPrompt(
						attachment.containerPath,
						extracted.method,
						extracted.text,
					);
				}
			})(),
		);
	}

	await Promise.all(workers);

	const skippedByBudget = candidates.length - nextIndex;
	if (skippedByBudget > 0) {
		log.logWarning(
			`[${channelId}] Stopped attachment extraction after ${ATTACHMENT_EXTRACTION_BUDGET_MS}ms budget`,
			`${skippedByBudget} attachment(s) were not processed`,
		);
	}

	return {
		blocks: blocksByIndex.filter((block): block is string => block !== null),
		extractedCount,
	};
}

function formatToolArgsForChat(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Cache runners per channel
const channelRunners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for a channel.
 * Runners are cached - one per channel, persistent across messages.
 */
export function getOrCreateRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, channelId, channelDir);
	channelRunners.set(channelId, runner);
	return runner;
}

/**
 * Create a new AgentRunner for a channel.
 * Sets up the session and subscribes to events once.
 */
function createRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	const executor = createExecutor(sandboxConfig);
	const hostWorkspacePath = join(channelDir, "..");
	const workspacePath = executor.getWorkspacePath(hostWorkspacePath);
	const attachmentExtractionCommandPrefix =
		sandboxConfig.type === "docker" ? ["docker", "exec", sandboxConfig.container] : undefined;
	const runUploadState = {
		fn: null as ((filePath: string, title?: string) => Promise<void>) | null,
	};

	// Create tools
	const tools = createMomTools(executor, () => runUploadState.fn, hostWorkspacePath, workspacePath);

	// Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
	const memory = getMemory(channelDir);
	const skills = loadMomSkills(channelDir, workspacePath);
	const systemPrompt = buildSystemPrompt(workspacePath, channelId, memory, sandboxConfig, [], [], skills);

	const configured = resolveConfiguredModel();
	let currentModel = resolveModelOrThrow(configured.provider, configured.modelId);
	let currentModelProvider = configured.provider;
	let currentModelId = configured.modelId;
	let currentThinkingLevel: ThinkingLevel = "off";

	// Create session manager and settings manager
	// Use a fixed context.jsonl file per channel (not timestamped like coding-agent)
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = new MomSettingsManager(join(channelDir, ".."));

	const savedProvider = settingsManager.getDefaultProvider();
	const savedModelId = settingsManager.getDefaultModel();
	if (savedProvider && savedModelId) {
		try {
			currentModel = resolveModelOrThrow(savedProvider, savedModelId);
			currentModelProvider = savedProvider;
			currentModelId = savedModelId;
		} catch (err) {
			log.logWarning(
				`[${channelId}] Failed to use saved model ${savedProvider}/${savedModelId}, using ${currentModelProvider}/${currentModelId}`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}
	const savedThinkingLevel = settingsManager.getDefaultThinkingLevel();
	if (savedThinkingLevel && isThinkingLevel(savedThinkingLevel)) {
		currentThinkingLevel = savedThinkingLevel;
	}

	// Create AuthStorage and ModelRegistry
	// Auth stored outside workspace so agent can't access it
	const primaryAuthPath = resolvePreferredAuthJsonPath(currentModelProvider);
	const { agentAuth, momWhatsappAuth } = getAuthJsonPaths();
	const secondaryAuthPath = primaryAuthPath === agentAuth ? momWhatsappAuth : agentAuth;
	const authStorage = AuthStorage.create(primaryAuthPath);
	const secondaryAuthStorage = AuthStorage.create(secondaryAuthPath);
	const modelRegistry = new ModelRegistry(authStorage);
	const secondaryRuntimeProviders = new Set<string>();

	const syncSecondaryAuthFallback = async (): Promise<void> => {
		authStorage.reload();
		secondaryAuthStorage.reload();

		const secondaryProviders = secondaryAuthStorage.list();
		const secondaryProviderSet = new Set(secondaryProviders);

		for (const provider of [...secondaryRuntimeProviders]) {
			if (!secondaryProviderSet.has(provider) || authStorage.has(provider)) {
				authStorage.removeRuntimeApiKey(provider);
				secondaryRuntimeProviders.delete(provider);
			}
		}

		for (const provider of secondaryProviders) {
			if (authStorage.has(provider)) {
				continue;
			}

			const apiKey = await secondaryAuthStorage.getApiKey(provider);
			if (apiKey) {
				authStorage.setRuntimeApiKey(provider, apiKey);
				secondaryRuntimeProviders.add(provider);
			} else {
				authStorage.removeRuntimeApiKey(provider);
				secondaryRuntimeProviders.delete(provider);
			}
		}
	};

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: currentModel,
			thinkingLevel: currentThinkingLevel,
			tools,
		},
		convertToLlm,
		getApiKey: async (provider) => getApiKeyForProvider(provider, authStorage, secondaryAuthStorage),
	});

	// Load existing messages
	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.replaceMessages(loadedSession.messages);
		log.logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession wrapper
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: settingsManager as any,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	// Mutable per-run state - event handler references this
	const runState = {
		ctx: null as BotContext | null,
		logCtx: null as { channelId: string; userName?: string; channelName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
	};

	// Subscribe to events ONCE
	session.subscribe(async (event) => {
		// Skip if no active run
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		const { ctx, logCtx, queue, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			// Post args + result to thread
			const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
			const argsFormatted = pending
				? formatToolArgsForChat(agentEvent.toolName, pending.args as Record<string, unknown>)
				: "(args not found)";
			const duration = (durationMs / 1000).toFixed(1);
			let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
			if (label) threadMessage += `: ${label}`;
			threadMessage += ` (${duration}s)\n`;
			if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
			threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

			if (VERBOSE_DETAILS) {
				queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);
			}

			if (!agentEvent.isError && agentEvent.toolName === "attach" && pending?.args) {
				const attachPath = (pending.args as { path?: unknown }).path;
				if (typeof attachPath === "string") {
					let artifactUrl: string | null = null;
					try {
						const hostPath = translateToHostPath(attachPath, channelDir, workspacePath);
						artifactUrl = await maybeBuildArtifactUrl({ workspaceDir: hostWorkspacePath, path: hostPath });
					} catch {
						artifactUrl = null;
					}
					if (artifactUrl) {
						queue.enqueue(() => ctx.respond(`Artifact URL: ${artifactUrl}`), "artifact url");
					}
				}
			}

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const text = textParts.join("\n");

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					queue.enqueueMessage(`_${thinking}_`, "main", "thinking main");
				}

				if (text.trim()) {
					if (isSilentResponse(text)) {
						log.logInfo("Silent response detected; skipping immediate enqueue");
					} else {
						log.logResponse(logCtx, text);
						queue.enqueueMessage(text, "main", "response main");
					}
				}
			}
		} else if (event.type === "auto_compaction_start") {
			log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.aborted) {
				log.logInfo("Auto-compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		}
	});

	// WhatsApp message limit
	const WHATSAPP_MAX_LENGTH = 65535;
	const splitForWhatsApp = (text: string): string[] => {
		if (text.length <= WHATSAPP_MAX_LENGTH) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, WHATSAPP_MAX_LENGTH - 50);
			remaining = remaining.substring(WHATSAPP_MAX_LENGTH - 50);
			const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	return {
		async run(
			ctx: BotContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });

			// Sync messages from log.jsonl that arrived while we were offline or busy
			// Exclude the current message (it will be added via prompt())
			const syncedCount = syncLogToSessionManager(sessionManager, channelDir, ctx.message.ts);
			if (syncedCount > 0) {
				log.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
			}

			// Reload messages from context.jsonl
			// This picks up any messages synced above
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				agent.replaceMessages(reloadedSession.messages);
				log.logInfo(`[${channelId}] Reloaded ${reloadedSession.messages.length} messages from context`);
			}

			// Update system prompt with fresh memory, channel/user info, and skills
			const memory = getMemory(channelDir);
			const skills = loadMomSkills(channelDir, workspacePath);
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
			);
			session.agent.setSystemPrompt(systemPrompt);

			// Set up file upload function for this run
			runUploadState.fn = async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath);
				await ctx.uploadFile(hostPath, title);
			};

			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`WhatsApp API error (${errorContext})`, errMsg);
							if (VERBOSE_DETAILS) {
								try {
									await ctx.respondInThread(`_Error: ${errMsg}_`);
								} catch {
									// Ignore
								}
							}
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					const parts = splitForWhatsApp(text);
					for (const part of parts) {
						this.enqueue(
							() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
							errorContext,
						);
					}
				},
			};

			// Log context info
			log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

			// Build user message with timestamp and username prefix
			// Format: "[YYYY-MM-DD HH:MM:SS+HH:MM] [username]: message" so LLM knows when and who
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
			let userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

			const imageAttachments: ImageContent[] = [];
			const nonImageAttachments: NonImageAttachment[] = [];
			let extractedAttachmentCount = 0;

			for (const a of ctx.message.attachments || []) {
				const containerPath = `${workspacePath}/${a.local}`;
				const hostPath = translateToHostPath(containerPath, channelDir, workspacePath);
				const commandPath = sandboxConfig.type === "docker" ? containerPath : hostPath;
				const mimeType = getImageMimeType(a.local);

				if (mimeType && existsSync(hostPath)) {
					try {
						imageAttachments.push({
							type: "image",
							mimeType,
							data: readFileSync(hostPath).toString("base64"),
						});
					} catch {
						nonImageAttachments.push({ containerPath, hostPath, commandPath });
					}
				} else {
					nonImageAttachments.push({ containerPath, hostPath, commandPath });
				}
			}

			if (nonImageAttachments.length > 0) {
				userMessage +=
					`\n\n<whatsapp_attachments>\n${nonImageAttachments.map((a) => a.containerPath).join("\n")}\n</whatsapp_attachments>`;

				const extractionResult = await extractAttachmentsForPrompt(channelId, nonImageAttachments, {
					commandPrefix: attachmentExtractionCommandPrefix,
				});
				extractedAttachmentCount = extractionResult.extractedCount;

				if (extractionResult.blocks.length > 0) {
					userMessage +=
						`\n\n<whatsapp_attachment_extracts>\n${extractionResult.blocks.join("\n\n")}\n</whatsapp_attachment_extracts>`;
				}
			}

			// Debug: write context to last_prompt.jsonl
			const debugContext = {
				systemPrompt,
				messages: session.messages,
				newUserMessage: userMessage,
				imageAttachmentCount: imageAttachments.length,
				nonImageAttachmentCount: nonImageAttachments.length,
				extractedAttachmentCount,
			};
			await writeFile(join(channelDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			await syncSecondaryAuthFallback();
			await session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);

			// Wait for queued messages
			await queueChain;

			// Handle error case - update main message and post error to thread
			if (runState.stopReason === "error" && runState.errorMessage) {
				try {
					await ctx.replaceMessage("_Sorry, something went wrong_");
					if (VERBOSE_DETAILS) {
						await ctx.respondInThread(`_Error: ${runState.errorMessage}_`);
					}
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else {
				// Final message update
				const messages = session.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const finalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				// Check for [SILENT] marker - delete message and thread instead of posting
				if (isSilentResponse(finalText)) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (finalText.trim()) {
					try {
						const mainText =
							finalText.length > WHATSAPP_MAX_LENGTH
								? `${finalText.substring(0, WHATSAPP_MAX_LENGTH - 50)}\n\n_(response truncated)_`
								: finalText;
						await ctx.replaceMessage(mainText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				}
			}

			// Log usage summary with context info
			if (runState.totalUsage.cost.total > 0) {
				// Get last non-aborted assistant message for context calculation
				const messages = session.messages;
				const lastAssistantMessage = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const contextWindow = currentModel.contextWindow || 200000;

				const summary = log.logUsageSummary(runState.logCtx!, runState.totalUsage, contextTokens, contextWindow);
				if (VERBOSE_DETAILS) {
					runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
					await queueChain;
				}
			}

			// Clear run state
			runUploadState.fn = null;
			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			session.abort();
		},

		setModel(provider: string, modelId: string): { provider: string; modelId: string } {
			const resolved = resolveModelOrThrow(provider, modelId);
			currentModel = resolved;
			currentModelProvider = provider;
			currentModelId = modelId;
			agent.setModel(resolved);
			settingsManager.setDefaultModelAndProvider(provider, modelId);
			return { provider, modelId };
		},

		getModel(): { provider: string; modelId: string } {
			return { provider: currentModelProvider, modelId: currentModelId };
		},

		setThinkingLevel(level: ThinkingLevel): ThinkingLevel {
			currentThinkingLevel = level;
			agent.setThinkingLevel(level);
			settingsManager.setDefaultThinkingLevel(level);
			return level;
		},

		getThinkingLevel(): ThinkingLevel {
			return currentThinkingLevel;
		},
	};
}

/**
 * Translate container path back to host path for file operations
 */
export function translateToHostPath(containerPath: string, channelDir: string, workspacePath: string): string {
	if (workspacePath === "/workspace") {
		const normalizedContainerPath = containerPath.replace(/\\/g, "/");
		const workspaceContainerRoot = "/workspace";
		if (
			normalizedContainerPath !== workspaceContainerRoot &&
			!normalizedContainerPath.startsWith(`${workspaceContainerRoot}/`)
		) {
			throw new Error(`Path '${containerPath}' is outside Docker workspace (${workspaceContainerRoot})`);
		}

		const workspaceHostRoot = resolvePath(channelDir, "..");
		const relativePath =
			normalizedContainerPath === workspaceContainerRoot
				? ""
				: normalizedContainerPath.slice(`${workspaceContainerRoot}/`.length);
		const hostPath = resolvePath(workspaceHostRoot, relativePath);
		const relativeToWorkspace = relative(workspaceHostRoot, hostPath);
		if (relativeToWorkspace.startsWith("..") || isAbsolute(relativeToWorkspace)) {
			throw new Error(`Path '${containerPath}' resolves outside Docker workspace`);
		}
		return hostPath;
	}
	return containerPath;
}
