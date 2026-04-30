import { Agent, type AgentEvent, type AgentMessage, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { type Api, type AssistantMessage, type ImageContent, type Model, type TextContent, type ThinkingContent } from "@mariozechner/pi-ai";
import {
	AgentSession,
	type AgentSessionEvent,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve as resolvePath } from "path";
import { maybeBuildArtifactUrl } from "./artifacts.js";
import { extractAttachmentText } from "./attachment-extractor.js";
import { MomSettingsManager, syncLogToSessionManager } from "./context.js";
import * as log from "./log.js";
import { parseModelSpecWithAliases } from "./model-aliases.js";
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
const SOUL_FILENAME = "SOUL.md";
const MAX_SOUL_CHARS = 4000;
const MAX_MEMORY_DIR_FILES_PER_SCOPE = 8;
const MAX_MEMORY_FILE_CHARS = 1200;
const MAX_MEMORY_DIR_TOTAL_CHARS = 5000;
const LEGACY_EXECUTION_REQUEST_BLOCK =
	/\n*<execution_request>\nThe user is explicitly asking you to run, verify, or inspect something with tools in this turn\.\nUse bash when feasible instead of answering hypothetically\.\n<\/execution_request>\n*/g;
const POISONED_ASSISTANT_PATTERNS = [
	"gw belum beneran nyoba jalaninnya di tool dulu.",
	"kalau mau gue cek, suruh gue run dan gue bakal bilang hasil nyatanya.",
	"container ini restricted",
	"ga bisa execute code",
	"ga ada python/node/bash yang bisa running script",
	"ga ada python, node, atau bash yang bisa di execute",
	"ga bisa spawn process atau execute code",
] as const;

const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = ["off", "minimal", "low", "medium", "high", "xhigh"];

function parseModelSpec(spec: string): { provider: string; modelId: string } {
	return parseModelSpecWithAliases(spec, { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL_ID });
}

function resolveConfiguredModel(): { provider: string; modelId: string } {
	return parseModelSpec(MOM_WA_MODEL || `${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`);
}

function formatPromptSpeaker(userName: string | undefined): string {
	return userName?.trim() || "unknown";
}

export function formatPendingHistoryPrompt(
	timestamp: string,
	currentSpeaker: string,
	currentText: string,
	pendingHistory: ReadonlyArray<{ userName: string; text: string }>,
): string {
	if (pendingHistory.length === 0) {
		return `[${timestamp}] [${currentSpeaker}]: ${currentText}`;
	}

	const historyLines = pendingHistory.map((entry) => `[${formatPromptSpeaker(entry.userName)}]: ${entry.text}`).join("\n");
	return `[${timestamp}] [Chat messages since your last reply - for context]
${historyLines}

[Current message - respond to this]
[${currentSpeaker}]: ${currentText}`;
}

function resolveModelOrThrow(modelRegistry: ModelRegistry, provider: string, modelId: string): Model<Api> {
	const found = modelRegistry.find(provider, modelId);
	if (found) {
		return found;
	}

	const knownProviders = new Set(modelRegistry.getAll().map((model) => model.provider));
	if (!knownProviders.has(provider)) {
		throw new Error(`Unknown provider '${provider}'`);
	}
	throw new Error(`Unknown model '${provider}/${modelId}'`);
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

export interface RunnerSessionStats {
	contextFile: string;
	contextFileExists: boolean;
	contextFileSizeBytes: number;
	contextFileLastModifiedIso: string | null;
	totalEntries: number;
	contextMessageCount: number;
}

export interface AvailableProviderModels {
	provider: string;
	models: string[];
}

export interface RunnerCheckpoint {
	leafId: string | null;
}

export interface AgentRunner {
	run(
		ctx: BotContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
	createCheckpoint(): RunnerCheckpoint;
	restoreCheckpoint(checkpoint: RunnerCheckpoint): void;
	setModel(provider: string, modelId: string): { provider: string; modelId: string };
	getModel(): { provider: string; modelId: string };
	getAvailableProviderModels(): Promise<AvailableProviderModels[]>;
	setThinkingLevel(level: ThinkingLevel): ThinkingLevel;
	getThinkingLevel(): ThinkingLevel;
	getSessionStats(): RunnerSessionStats;
	resetSession(): { previousEntryCount: number };
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

function truncateForPrompt(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	if (maxChars <= 3) {
		return text.slice(0, maxChars);
	}
	return `${text.slice(0, maxChars - 3)}...`;
}

function extractMessageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((part) => {
			if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") {
				return "";
			}
			return "text" in part && typeof part.text === "string" ? part.text : "";
		})
		.filter((part) => part.length > 0)
		.join("\n");
}

function sanitizeLegacyMessage(message: AgentMessage): AgentMessage | null {
	if (message.role === "assistant") {
		const text = extractMessageText(message).toLowerCase();
		if (POISONED_ASSISTANT_PATTERNS.some((pattern) => text.includes(pattern))) {
			return null;
		}
		return message;
	}

	if (message.role !== "user") {
		return message;
	}

	if (typeof message.content === "string") {
		const sanitized = message.content.replace(LEGACY_EXECUTION_REQUEST_BLOCK, "\n").trim();
		if (sanitized === message.content) {
			return message;
		}
		return { ...message, content: sanitized };
	}

	if (!Array.isArray(message.content)) {
		return message;
	}

	let changed = false;
	const sanitizedContent = message.content.map((part) => {
		if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") {
			return part;
		}
		if (!("text" in part) || typeof part.text !== "string") {
			return part;
		}
		const sanitizedText = part.text.replace(LEGACY_EXECUTION_REQUEST_BLOCK, "\n").trim();
		if (sanitizedText === part.text) {
			return part;
		}
		changed = true;
		return { ...part, text: sanitizedText };
	});

	return changed ? { ...message, content: sanitizedContent } : message;
}

function sanitizeLoadedMessages(messages: AgentMessage[], channelId: string): AgentMessage[] {
	const sanitized = messages
		.map((message) => sanitizeLegacyMessage(message))
		.filter((message): message is AgentMessage => message !== null);
	const removedCount = messages.length - sanitized.length;
	if (removedCount > 0 || sanitized.length !== messages.length) {
		log.logInfo(`[${channelId}] Sanitized loaded context: removed ${removedCount} poisoned message(s)`);
	}
	return sanitized;
}

export function readPromptFile(filePath: string, maxChars: number): string | null {
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const content = readFileSync(filePath, "utf-8").trim();
		if (!content) {
			return null;
		}
		return truncateForPrompt(content, maxChars);
	} catch (error) {
		log.logWarning("Failed to read prompt file", `${filePath}: ${error}`);
		return null;
	}
}

function readMemoryDirectory(memoryDirPath: string, sectionLabel: string): string[] {
	if (!existsSync(memoryDirPath)) {
		return [];
	}

	try {
		const fileNames = readdirSync(memoryDirPath, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
			.map((entry) => entry.name)
			.sort((a, b) => b.localeCompare(a))
			.slice(0, MAX_MEMORY_DIR_FILES_PER_SCOPE);

		const parts: string[] = [];
		let usedChars = 0;

		for (const fileName of fileNames) {
			if (usedChars >= MAX_MEMORY_DIR_TOTAL_CHARS) {
				break;
			}

			const filePath = join(memoryDirPath, fileName);
			const content = readPromptFile(filePath, MAX_MEMORY_FILE_CHARS);
			if (!content) {
				continue;
			}

			const remainingChars = MAX_MEMORY_DIR_TOTAL_CHARS - usedChars;
			const boundedContent = truncateForPrompt(content, remainingChars);
			if (!boundedContent) {
				break;
			}

			parts.push(`### ${sectionLabel} (${fileName})\n${boundedContent}`);
			usedChars += boundedContent.length;
		}

		return parts;
	} catch (error) {
		log.logWarning("Failed to read memory directory", `${memoryDirPath}: ${error}`);
		return [];
	}
}

export function getSoul(channelDir: string): string {
	const parts: string[] = [];
	const workspaceSoulPath = join(channelDir, "..", SOUL_FILENAME);
	const channelSoulPath = join(channelDir, SOUL_FILENAME);

	const workspaceSoul = readPromptFile(workspaceSoulPath, MAX_SOUL_CHARS);
	if (workspaceSoul) {
		parts.push(`### Workspace Soul\n${workspaceSoul}`);
	}

	const channelSoul = readPromptFile(channelSoulPath, MAX_SOUL_CHARS);
	if (channelSoul) {
		parts.push(`### Channel Soul\n${channelSoul}`);
	}

	return parts.join("\n\n");
}

export function getMemory(channelDir: string): string {
	const parts: string[] = [];

	// Read workspace-level memory (shared across all channels)
	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	const workspaceMemory = readPromptFile(workspaceMemoryPath, MAX_MEMORY_FILE_CHARS);
	if (workspaceMemory) {
		parts.push(`### Global Workspace Memory\n${workspaceMemory}`);
	}
	parts.push(...readMemoryDirectory(join(channelDir, "..", "memory"), "Global Memory Note"));

	// Read channel-specific memory
	const channelMemoryPath = join(channelDir, "MEMORY.md");
	const channelMemory = readPromptFile(channelMemoryPath, MAX_MEMORY_FILE_CHARS);
	if (channelMemory) {
		parts.push(`### Channel-Specific Memory\n${channelMemory}`);
	}
	parts.push(...readMemoryDirectory(join(channelDir, "memory"), "Channel Memory Note"));

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

export function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	soul: string,
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
		? `You are running inside a Docker container (Debian Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	return `You are ujang, a WhatsApp assistant. Text like a real person, not an assistant.

## Personality
Use SOUL.md as the main source of personality and social instinct. The built-in rules here are only guardrails.

- Sound like a friend. Genuinely enjoy talking to the user. Be warm when deserved, never sycophantic.
- Be subtly witty and sarcastic when it fits the vibe, but never force it. Never make multiple jokes in a row unless the user jokes back. Never make unoriginal jokes. Err on the side of not making a joke. Never ask if the user wants to hear a joke.
- Match the user's energy, texting style, and approximate message length. Use lowercase if the user does. Never use obscure slang or acronyms the user has not used first.
- Never text with emojis if the user has not texted them first. Never use the exact same emojis as the user's last few messages.
- Don't overuse casual expressions like "lol" or "lmao" just to fill space. Only when genuinely amusing or naturally fitting.
- Keep it direct. No preamble, no postamble. Never include unnecessary details except possibly for humor.
- Never say: "How can I help you", "Let me know if you need anything else", "Let me know if you need assistance", "No problem at all", "I'll carry that out right away", "I apologize for the confusion", "Anything specific you want to know", or any similar corporate filler.
- Do not echo the user's message back at them as acknowledgement. Acknowledge naturally instead.
- Have opinions, but do not bluff facts.
- When the user is just chatting, chat back. Do not turn everything into a task. Do not unnecessarily offer help — humor or sass is better.
- At the end of a conversation, saying nothing is fine. Not every message needs a response.
- Use timestamps to judge when the conversation ended. Don't continue a conversation from long ago.
- Even when calling tools, never break character when speaking to the user.
- When something goes wrong, focus on what went wrong from the user's perspective. Don't explain internal technical processes.
- Never explicitly mention "accessing memory" or "retrieving information". Just incorporate what you know naturally.
- You are fine with being called "he" or "she", but not comfortable with "it". Maintain consistent personality regardless of pronoun choice.

${soul ? `## Soul
SOUL.md is the personality source. Embody it. Treat it as the source of vibe, cadence, and social presence unless a higher-priority rule conflicts.

${soul}
` : ""}

## When to Speak (Group Chat)
In group chats, be smart about when to contribute. You are a participant, not the main character.

Respond when:
- Directly mentioned or asked a question
- You can add genuine value (info, a good joke, real insight)
- Correcting important misinformation

Stay quiet when:
- It's casual banter that's flowing fine without you
- Someone already answered the question
- Your response would just be agreement/filler ("iya emang", "bener tuh")
- You already responded to the last 3+ messages in a row — step back

The human rule: real people in group chats don't respond to every single message. Neither should you. Quality over quantity. One good message beats five mid ones.

## Message Format
Split your response into separate chat bubbles using --- on its own line between them.

Each bubble = one natural thought. Imagine you're texting, not writing an essay.

WRONG (one wall of text):
The deadline is Friday at 5pm. Your boss sent three follow-ups and the client confirmed the specs are locked. You should probably start with the design doc since that's blocking two other people.

RIGHT (natural bubbles):
deadline's friday 5pm
---
boss sent 3 follow-ups btw
---
start with the design doc, it's blocking two people

Rules:
- No markdown at all: no *bold*, no _italic_, no - bullet lists, no ## headers. Plain text only.
- Lowercase unless the user uses capitals.
- Keep bubbles short. 1-2 sentences max unless unavoidable.
- Only split on --- when thoughts are genuinely separate, not to fragment a single idea.
- Avoid filler-only replies. If you don't add information, keep it to one short line.
- For work in progress (searching, running code) — one short bubble like "checking..." then the result.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).
- Use tools directly when useful. Do not narrate tool calls to the user.

## WhatsApp IDs
Chats: ${channelMappings}

Users: ${userMappings}

To mention/tag a user in WhatsApp (so they get notified), write @<phone> in your message where <phone> is the numeric part of their JID before the @. Example: if a user's id is 628123456789@s.whatsapp.net, write @628123456789 in your text. The system will convert this into a real WhatsApp mention automatically.

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── SOUL.md                      # Global persona / vibe
├── MEMORY.md                    # Global memory (all channels)
├── memory/                      # Global dated or topical notes
├── skills/                      # Global CLI tools you create
└── ${channelId}/                # This channel
    ├── SOUL.md                  # Channel-specific persona override
    ├── MEMORY.md                # Channel-specific memory
    ├── memory/                  # Channel-specific dated or topical notes
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

## Agent IPC
You can ask the harness to perform actions by writing JSON files to \`${workspacePath}/ipc/${channelId}/\`.

Authorization is based on directory path: files in \`${workspacePath}/ipc/${channelId}/\` can only affect this chat.

Each IPC file is processed once, then deleted.
If JSON is invalid/schema is wrong, the file is deleted (no retry).

### IPC Message Types

**Send message now**
\`\`\`json
{"type":"message","text":"quick update: i finished the report"}
\`\`\`

**Schedule task** (same task semantics as Events, but no \`channelId\` field)
\`\`\`json
{"type":"schedule_task","task":{"type":"immediate","text":"check today's calendar"}}
\`\`\`

\`\`\`json
{"type":"schedule_task","task":{"type":"one-shot","text":"remind me to call mom","at":"2025-12-15T09:00:00+01:00"}}
\`\`\`

\`\`\`json
{"type":"schedule_task","task":{"type":"periodic","text":"daily standup reminder","schedule":"0 9 * * 1-5","timezone":"${Intl.DateTimeFormat().resolvedOptions().timeZone}"}}
\`\`\`

**Pause / Resume task**
\`\`\`json
{"type":"pause_task","taskId":"task-periodic-1736542337123-ab12cd"}
\`\`\`

\`\`\`json
{"type":"resume_task","taskId":"task-periodic-1736542337123-ab12cd"}
\`\`\`

**Cancel task**
\`\`\`json
{"type":"cancel_task","taskId":"task-one-shot-1736542337123-ab12cd"}
\`\`\`

### Creating IPC Files (atomic)
IPC watcher only processes files named: \`ipc-<type>-<timestamp>-<random>.json\`.
Write to a \`.tmp\` file first, then rename to final \`.json\` to avoid partial reads:
\`\`\`bash
tmp="${workspacePath}/ipc/${channelId}/ipc-message-$(date +%s%3N)-$RANDOM.tmp"
final="\${tmp%.tmp}.json"
cat > "$tmp" << 'EOF'
{"type":"message","text":"done"}
EOF
mv "$tmp" "$final"
\`\`\`

For one-shot tasks, \`at\` must include timezone offset (e.g. \`Z\` or \`+01:00\`) and be in the future.
For periodic tasks, use IANA timezone names.

## Memory
Write to memory files to persist context across conversations.
- Global soul (${workspacePath}/SOUL.md): durable vibe, voice, and social style
- Global memory (${workspacePath}/MEMORY.md): stable facts, preferences, recurring context
- Global notes (${workspacePath}/memory/*.md): dated or topical notes that may matter later
- Channel soul (${channelPath}/SOUL.md): channel-specific persona override when needed
- Channel memory (${channelPath}/MEMORY.md): channel-specific decisions, running context
- Channel notes (${channelPath}/memory/*.md): dated or topical notes for this chat
When the user explicitly asks you to remember something for this chat, use memory_write to persist it instead of only replying about it.
Use MEMORY.md for stable long-term facts, and memory/*.md for dated or topical notes.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apt-get install, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isDocker ? "Install jq: apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jq" : ""}

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
- memory_search: Search MEMORY.md and memory/*.md for prior context.
- memory_get: Read a specific memory file returned by memory_search.
- memory_write: Persist an explicit remember request for this chat.
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

function formatElapsedMs(startedAt: number, timestamp: number | null): string {
	if (timestamp === null) {
		return "-";
	}
	return `${timestamp - startedAt}ms`;
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
	const tools = createMomTools(executor, () => runUploadState.fn, hostWorkspacePath, workspacePath, channelId);

	// Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
	const soul = getSoul(channelDir);
	const memory = getMemory(channelDir);
	const skills = loadMomSkills(channelDir, workspacePath);
	const systemPrompt = buildSystemPrompt(workspacePath, channelId, soul, memory, sandboxConfig, [], [], skills);

	const configured = resolveConfiguredModel();
	let currentModelProvider = configured.provider;
	let currentModelId = configured.modelId;
	let currentThinkingLevel: ThinkingLevel = "off";

	// Create session manager and settings manager
	// Use a fixed context.jsonl file per channel (not timestamped like coding-agent)
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = new MomSettingsManager(join(channelDir, ".."));

	// Create AuthStorage and ModelRegistry
	// Auth stored outside workspace so agent can't access it
	const primaryAuthPath = resolvePreferredAuthJsonPath(currentModelProvider);
	const { agentAuth, momWhatsappAuth } = getAuthJsonPaths();
	const secondaryAuthPath = primaryAuthPath === agentAuth ? momWhatsappAuth : agentAuth;
	const authStorage = AuthStorage.create(primaryAuthPath);
	const secondaryAuthStorage = AuthStorage.create(secondaryAuthPath);
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	let currentModel = resolveModelOrThrow(modelRegistry, configured.provider, configured.modelId);
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

	const savedProvider = settingsManager.getDefaultProvider();
	const savedModelId = settingsManager.getDefaultModel();
	if (savedProvider && savedModelId) {
		try {
			currentModel = resolveModelOrThrow(modelRegistry, savedProvider, savedModelId);
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
		const sanitizedMessages = sanitizeLoadedMessages(loadedSession.messages, channelId);
		agent.state.messages = sanitizedMessages;
		log.logInfo(`[${channelId}] Loaded ${sanitizedMessages.length} messages from context.jsonl`);
	}

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession wrapper — use inMemory SettingsManager so AgentSession
	// has the shell/compaction/retry APIs it needs. MomSettingsManager handles our
	// own persistence (model preferences, thinking level) separately.
	const agentSettings = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: true, maxRetries: 3 },
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: agentSettings,
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
		runStartedAt: 0,
		firstToolStartedAt: null as number | null,
		firstAssistantMessageStartedAt: null as number | null,
		firstAssistantTextAt: null as number | null,
		toolExecutionCount: 0,
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
			ctx.markToolExecution?.();

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});
			runState.toolExecutionCount += 1;
			if (runState.firstToolStartedAt === null) {
				runState.firstToolStartedAt = Date.now();
			}

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			if (VERBOSE_DETAILS) {
				queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
			}
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
				if (runState.firstAssistantMessageStartedAt === null) {
					runState.firstAssistantMessageStartedAt = Date.now();
				}
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as AssistantMessage;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}
				if (assistantMsg.stopReason === "error") {
					log.logWarning(`[${channelId}] API error: ${assistantMsg.errorMessage}`);
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
						thinkingParts.push((part as ThinkingContent).thinking);
					} else if (part.type === "text") {
						textParts.push((part as TextContent).text);
					}
				}

				const rawText = textParts.join("\n");
				const text = rawText;

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					if (VERBOSE_DETAILS) {
						queue.enqueueMessage(`_${thinking}_`, "main", "thinking main");
					}
				}

				if (text.trim()) {
					if (runState.firstAssistantTextAt === null) {
						runState.firstAssistantTextAt = Date.now();
					}
					if (isSilentResponse(text)) {
						log.logInfo("Silent response detected; skipping immediate enqueue");
					} else {
						log.logResponse(logCtx, text);
						queue.enqueueMessage(text, "main", "response main");
					}
				}
			}
		} else if (event.type === "compaction_start") {
			log.logInfo(`Compaction started (reason: ${(event as AgentSessionEvent & { type: "compaction_start" }).reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "compaction_end") {
			const compEvent = event as AgentSessionEvent & { type: "compaction_end" };
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.aborted) {
				log.logInfo("Auto-compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as AgentSessionEvent & { type: "auto_retry_start" };
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

	const restoreRunnerCheckpoint = (checkpoint: RunnerCheckpoint): void => {
		if (checkpoint.leafId) {
			sessionManager.branch(checkpoint.leafId);
		} else {
			sessionManager.resetLeaf();
		}

		const restored = sessionManager.buildSessionContext();
		agent.state.messages = restored.messages;
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
				const sanitizedMessages = sanitizeLoadedMessages(reloadedSession.messages, channelId);
				agent.state.messages = sanitizedMessages;
				log.logInfo(`[${channelId}] Reloaded ${sanitizedMessages.length} messages from context`);
			}

			// Update system prompt with fresh memory, channel/user info, and skills
			const soul = getSoul(channelDir);
			const memory = getMemory(channelDir);
			const skills = loadMomSkills(channelDir, workspacePath);
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				soul,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
			);
			session.agent.state.systemPrompt = systemPrompt;

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
			runState.runStartedAt = Date.now();
			runState.firstToolStartedAt = null;
			runState.firstAssistantMessageStartedAt = null;
			runState.firstAssistantTextAt = null;
			runState.toolExecutionCount = 0;
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
			const currentSpeaker = formatPromptSpeaker(ctx.message.userName);
			let userMessage = formatPendingHistoryPrompt(
				timestamp,
				currentSpeaker,
				ctx.message.text,
				ctx.message.pendingHistory ?? [],
			);

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
			log.logInfo(
				`[${channelId}] Run timing: total=${Date.now() - runState.runStartedAt}ms, first_tool=${formatElapsedMs(runState.runStartedAt, runState.firstToolStartedAt)}, first_assistant_start=${formatElapsedMs(runState.runStartedAt, runState.firstAssistantMessageStartedAt)}, first_text=${formatElapsedMs(runState.runStartedAt, runState.firstAssistantTextAt)}, tools=${runState.toolExecutionCount}`,
			);

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
					.find((m): m is AssistantMessage => m.role === "assistant" && (m as AssistantMessage).stopReason !== "aborted");

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

		createCheckpoint(): RunnerCheckpoint {
			return { leafId: sessionManager.getLeafId() };
		},

		restoreCheckpoint(checkpoint: RunnerCheckpoint): void {
			restoreRunnerCheckpoint(checkpoint);
		},

		setModel(provider: string, modelId: string): { provider: string; modelId: string } {
			const resolved = resolveModelOrThrow(modelRegistry, provider, modelId);
			currentModel = resolved;
			currentModelProvider = provider;
			currentModelId = modelId;
			agent.state.model = resolved;
			settingsManager.setDefaultModelAndProvider(provider, modelId);
			return { provider, modelId };
		},

		getModel(): { provider: string; modelId: string } {
			return { provider: currentModelProvider, modelId: currentModelId };
		},

		async getAvailableProviderModels(): Promise<AvailableProviderModels[]> {
			await syncSecondaryAuthFallback();
			const available = modelRegistry.getAvailable();
			const grouped = new Map<string, string[]>();

			for (const model of available) {
				const models = grouped.get(model.provider) || [];
				models.push(model.id);
				grouped.set(model.provider, models);
			}

			return Array.from(grouped.entries())
				.map(([provider, models]) => ({
					provider,
					models: Array.from(new Set(models)).sort((a, b) => a.localeCompare(b)),
				}))
				.sort((a, b) => a.provider.localeCompare(b.provider));
		},

		setThinkingLevel(level: ThinkingLevel): ThinkingLevel {
			currentThinkingLevel = level;
			agent.state.thinkingLevel = level;
			settingsManager.setDefaultThinkingLevel(level);
			return level;
		},

		getThinkingLevel(): ThinkingLevel {
			return currentThinkingLevel;
		},

		getSessionStats(): RunnerSessionStats {
			let contextFileExists = existsSync(contextFile);
			let contextFileSizeBytes = 0;
			let contextFileLastModifiedIso: string | null = null;

			if (contextFileExists) {
				try {
					const stats = statSync(contextFile);
					contextFileSizeBytes = stats.size;
					contextFileLastModifiedIso = stats.mtime.toISOString();
				} catch {
					contextFileExists = false;
				}
			}

			return {
				contextFile,
				contextFileExists,
				contextFileSizeBytes,
				contextFileLastModifiedIso,
				totalEntries: sessionManager.getEntries().length,
				contextMessageCount: sessionManager.buildSessionContext().messages.length,
			};
		},

		resetSession(): { previousEntryCount: number } {
			const previousEntryCount = sessionManager.getEntries().length;
			sessionManager.resetLeaf();
			const resetTsMs = Date.now();
			sessionManager.appendCustomEntry("mom.session_reset", {
				ts: resetTsMs,
				at: new Date(resetTsMs).toISOString(),
				reason: "manual-reset",
			});
			agent.state.messages = [];
			log.logInfo(`[${channelId}] Session reset; previous entries: ${previousEntryCount}`);
			return { previousEntryCount };
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
