import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const DEFAULT_ARTIFACTS_URL_FILE = "/tmp/artifacts-url.txt";

export interface ArtifactUrlBuildOptions {
	workspaceDir: string;
	path: string;
	liveReload?: boolean;
}

export interface ArtifactUrlBuildSuccess {
	ok: true;
	url: string;
	relativePath: string;
	artifactsRoot: string;
	baseUrl: string;
}

export interface ArtifactUrlBuildFailure {
	ok: false;
	error: string;
	artifactsRoot: string;
	baseUrl: string | null;
}

export type ArtifactUrlBuildResult = ArtifactUrlBuildSuccess | ArtifactUrlBuildFailure;

function normalizeBaseUrl(url: string): string {
	return url.endsWith("/") ? url : `${url}/`;
}

export function getArtifactsRoot(workspaceDir: string): string {
	const configured = process.env.MOM_WA_ARTIFACTS_ROOT?.trim();
	if (configured) {
		return resolve(configured);
	}
	return resolve(join(workspaceDir, "artifacts", "files"));
}

export async function getArtifactsBaseUrl(): Promise<string | null> {
	const configured = process.env.MOM_WA_ARTIFACTS_BASE_URL?.trim();
	if (configured) {
		return normalizeBaseUrl(configured);
	}

	const urlFile = process.env.MOM_WA_ARTIFACTS_URL_FILE?.trim() || DEFAULT_ARTIFACTS_URL_FILE;
	if (!existsSync(urlFile)) {
		return null;
	}

	try {
		const content = (await readFile(urlFile, "utf-8")).trim();
		if (!content) {
			return null;
		}
		return normalizeBaseUrl(content.split(/\s+/)[0] || "");
	} catch {
		return null;
	}
}

function isWithinArtifactsRoot(target: string, artifactsRoot: string): boolean {
	const rel = relative(artifactsRoot, target);
	return !rel.startsWith("..") && !isAbsolute(rel);
}

function resolveArtifactTarget(inputPath: string, artifactsRoot: string, workspaceDir: string): string {
	if (isAbsolute(inputPath)) {
		return resolve(inputPath);
	}

	const byArtifactsRoot = resolve(join(artifactsRoot, inputPath));
	if (isWithinArtifactsRoot(byArtifactsRoot, artifactsRoot) && existsSync(byArtifactsRoot)) {
		return byArtifactsRoot;
	}

	const byWorkspace = resolve(join(workspaceDir, inputPath));
	if (isWithinArtifactsRoot(byWorkspace, artifactsRoot) && existsSync(byWorkspace)) {
		return byWorkspace;
	}

	if (isWithinArtifactsRoot(byArtifactsRoot, artifactsRoot)) {
		return byArtifactsRoot;
	}
	return byWorkspace;
}

function toUrlPath(relativePath: string): string {
	return relativePath
		.split("/")
		.filter((part) => part.length > 0)
		.map((part) => encodeURIComponent(part))
		.join("/");
}

export async function buildArtifactUrl(options: ArtifactUrlBuildOptions): Promise<ArtifactUrlBuildResult> {
	const artifactsRoot = getArtifactsRoot(options.workspaceDir);
	const baseUrl = await getArtifactsBaseUrl();
	if (!baseUrl) {
		return {
			ok: false,
			error:
				"Artifacts base URL not configured. Set MOM_WA_ARTIFACTS_BASE_URL or write URL to MOM_WA_ARTIFACTS_URL_FILE (/tmp/artifacts-url.txt by default).",
			artifactsRoot,
			baseUrl: null,
		};
	}

	let target = resolveArtifactTarget(options.path, artifactsRoot, options.workspaceDir);
	if (!isWithinArtifactsRoot(target, artifactsRoot)) {
		return {
			ok: false,
			error: "Path must be inside artifacts root",
			artifactsRoot,
			baseUrl,
		};
	}

	if (existsSync(target)) {
		const indexHtmlPath = resolve(join(target, "index.html"));
		if (existsSync(indexHtmlPath)) {
			target = indexHtmlPath;
		}
	}

	if (!existsSync(target)) {
		return {
			ok: false,
			error: "Artifact path does not exist inside artifacts root",
			artifactsRoot,
			baseUrl,
		};
	}

	const rel = relative(artifactsRoot, target);

	const normalizedRel = rel.replace(/\\/g, "/");
	const encodedPath = toUrlPath(normalizedRel);

	try {
		const url = new URL(encodedPath, baseUrl);
		if (options.liveReload) {
			url.searchParams.set("ws", "true");
		}

		return {
			ok: true,
			url: url.toString(),
			relativePath: normalizedRel,
			artifactsRoot,
			baseUrl,
		};
	} catch {
		return {
			ok: false,
			error: "[ARTIFACT_URL_INVALID_BASE] Artifacts base URL is invalid. Set MOM_WA_ARTIFACTS_BASE_URL to an absolute URL (for example https://example.trycloudflare.com/).",
			artifactsRoot,
			baseUrl,
		};
	}
}

export async function maybeBuildArtifactUrl(options: ArtifactUrlBuildOptions): Promise<string | null> {
	const result = await buildArtifactUrl(options);
	if (!result.ok) {
		return null;
	}
	return result.url;
}
