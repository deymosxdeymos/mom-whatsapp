import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative, resolve } from "path";

const DEFAULT_BLOCKED_PATTERNS: string[] = [
	"/.ssh",
	"/.gnupg",
	"/.aws",
	"/credentials",
	"/id_rsa",
	"/id_ed25519",
	"/.env",
];

export interface MountAllowlistRoot {
	path: string;
	allowReadWrite: boolean;
	description?: string;
}

export interface MountAllowlist {
	allowedRoots: MountAllowlistRoot[];
	blockedPatterns: string[];
}

export interface MountValidationResult {
	ok: boolean;
	allowlistPath: string;
	resolvedPath: string;
	matchedRoot?: string;
	error?: string;
}

export function getMountAllowlistPath(): string {
	return join(homedir(), ".config", "mom-whatsapp", "mount-allowlist.json");
}

export function ensureMountAllowlist(workspaceDir: string): MountAllowlist {
	const allowlistPath = getMountAllowlistPath();
	if (!existsSync(allowlistPath)) {
		const template = buildInitialAllowlist(workspaceDir);
		mkdirSync(dirname(allowlistPath), { recursive: true });
		writeFileSync(allowlistPath, `${JSON.stringify(template, null, 2)}\n`, "utf-8");
	}
	return loadMountAllowlist(allowlistPath);
}

export function validateWorkspaceMount(workspaceDir: string): MountValidationResult {
	const allowlistPath = getMountAllowlistPath();
	const allowlist = ensureMountAllowlist(workspaceDir);
	const resolvedPath = resolveHostPath(workspaceDir);

	const blocked = findBlockedPattern(resolvedPath, allowlist.blockedPatterns);
	if (blocked) {
		return {
			ok: false,
			allowlistPath,
			resolvedPath,
			error: `Workspace path '${resolvedPath}' matches blocked pattern '${blocked}'.`,
		};
	}

	for (const root of allowlist.allowedRoots) {
		const resolvedRoot = resolveHostPath(root.path);
		if (!isPathWithinRoot(resolvedRoot, resolvedPath)) {
			continue;
		}
		if (!root.allowReadWrite) {
			return {
				ok: false,
				allowlistPath,
				resolvedPath,
				matchedRoot: resolvedRoot,
				error: `Workspace path '${resolvedPath}' is inside '${resolvedRoot}' but that root is read-only.`,
			};
		}
		return {
			ok: true,
			allowlistPath,
			resolvedPath,
			matchedRoot: resolvedRoot,
		};
	}

	return {
		ok: false,
		allowlistPath,
		resolvedPath,
		error: `Workspace path '${resolvedPath}' is not inside any allowed root.`,
	};
}

function buildInitialAllowlist(workspaceDir: string): MountAllowlist {
	return {
		allowedRoots: [
			{
				path: resolveHostPath(workspaceDir),
				allowReadWrite: true,
				description: "Auto-generated initial workspace root",
			},
		],
		blockedPatterns: DEFAULT_BLOCKED_PATTERNS,
	};
}

function loadMountAllowlist(path: string): MountAllowlist {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		throw new Error(`Invalid mount allowlist JSON at '${path}': ${err instanceof Error ? err.message : String(err)}`);
	}

	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`Invalid mount allowlist at '${path}': expected object.`);
	}

	const data = parsed as Record<string, unknown>;
	const allowedRootsValue = data.allowedRoots;
	if (!Array.isArray(allowedRootsValue) || allowedRootsValue.length === 0) {
		throw new Error(`Invalid mount allowlist at '${path}': allowedRoots must be a non-empty array.`);
	}

	const allowedRoots: MountAllowlistRoot[] = allowedRootsValue.map((value, index) => {
		if (typeof value !== "object" || value === null) {
			throw new Error(`Invalid mount allowlist at '${path}': allowedRoots[${index}] must be an object.`);
		}
		const root = value as Record<string, unknown>;
		const rootPath = root.path;
		const allowReadWrite = root.allowReadWrite;
		if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
			throw new Error(`Invalid mount allowlist at '${path}': allowedRoots[${index}].path must be a non-empty string.`);
		}
		if (typeof allowReadWrite !== "boolean") {
			throw new Error(`Invalid mount allowlist at '${path}': allowedRoots[${index}].allowReadWrite must be boolean.`);
		}
		const description = root.description;
		if (description !== undefined && typeof description !== "string") {
			throw new Error(`Invalid mount allowlist at '${path}': allowedRoots[${index}].description must be a string.`);
		}
		return {
			path: rootPath,
			allowReadWrite,
			description,
		};
	});

	const blockedPatternsValue = data.blockedPatterns;
	const blockedPatterns = Array.isArray(blockedPatternsValue)
		? blockedPatternsValue
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
		: DEFAULT_BLOCKED_PATTERNS;

	return {
		allowedRoots,
		blockedPatterns,
	};
}

function resolveHostPath(pathValue: string): string {
	const expanded = expandHome(pathValue.trim());
	const resolved = isAbsolute(expanded) ? expanded : resolve(expanded);
	if (existsSync(resolved)) {
		return realpathSync(resolved);
	}
	return resolve(resolved);
}

function expandHome(pathValue: string): string {
	if (pathValue === "~") {
		return homedir();
	}
	if (pathValue.startsWith("~/")) {
		return join(homedir(), pathValue.slice(2));
	}
	return pathValue;
}

function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
	const rel = relative(rootPath, targetPath);
	if (rel === "") {
		return true;
	}
	return !rel.startsWith("..") && !isAbsolute(rel);
}

function findBlockedPattern(targetPath: string, patterns: string[]): string | null {
	const normalized = `/${targetPath.replace(/\\/g, "/").replace(/^\/+/, "")}`.toLowerCase();
	for (const pattern of patterns) {
		const candidate = pattern.trim().toLowerCase();
		if (!candidate) {
			continue;
		}
		if (normalized.includes(candidate)) {
			return pattern;
		}
	}
	return null;
}
