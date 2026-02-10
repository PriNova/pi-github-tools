/**
 * GitHub Repository Tools Extension for pi-coding-agent
 *
 * Provides tools to read, search, and explore GitHub repositories.
 * Requires GITHUB_PAT environment variable or GITHUB_PAT_FILE (path to token file) for API access.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { keyHint, truncateToVisualLines } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";

// Common details type for all tools - must have consistent shape
interface GitHubToolDetails {
	// Error fields (present when isError is true)
	error?: string;
	status?: number;
	// Success fields
	repository?: string;
	path?: string;
	pattern?: string;
	query?: string;
	itemCount?: number;
	lineCount?: number;
	totalCount?: number;
	results?: unknown;
	commits?: unknown;
}

// GitHub API response types
interface GitHubAPIResponse<T> {
	ok: boolean;
	status: number;
	statusText?: string;
	data?: T;
}

interface GitHubFileContent {
	content: string;
	encoding: string;
}

interface GitHubDirectoryItem {
	name: string;
	type: "file" | "dir";
	path: string;
}

interface GitHubCodeSearchItem {
	path: string;
	html_url: string;
	repository: { full_name: string };
	text_matches: Array<{ fragment: string; property: string }>;
}

interface GitHubSearchResponse {
	total_count: number;
	items: GitHubCodeSearchItem[];
	incomplete_results: boolean;
}

// Result type for token retrieval
interface TokenResult {
	token?: string;
	error?: string;
}

// Cache for file-based tokens to avoid reading on every API call
let cachedToken: { token: string; filePath: string } | null = null;

// Maximum file size for token files (1KB is more than enough for a token)
const MAX_TOKEN_FILE_SIZE = 1024;

// Validate GitHub token format (basic check)
function isValidTokenFormat(token: string): boolean {
	// GitHub tokens typically start with ghp_, github_pat_, gho_, ghu_, ghs_, or ghr_
	// and are at least 20 characters long
	const validPrefixes = ["ghp_", "github_pat_", "gho_", "ghu_", "ghs_", "ghr_"];
	const hasValidPrefix = validPrefixes.some((prefix) => token.startsWith(prefix));
	return hasValidPrefix && token.length >= 20;
}

// Get GitHub token from environment or file
// Supports GITHUB_PAT (env var) or GITHUB_PAT_FILE (path to file containing token)
// This allows NixOS and containerized deployments to use secret files
function getGitHubToken(): TokenResult {
	// First check for direct env var (backward compatible)
	if (process.env.GITHUB_PAT) {
		const token = process.env.GITHUB_PAT.trim();
		if (!token) {
			return { error: "GITHUB_PAT environment variable is set but empty" };
		}
		if (!isValidTokenFormat(token)) {
			return { error: "GITHUB_PAT appears to be invalid (should start with ghp_, github_pat_, etc.)" };
		}
		return { token };
	}

	// Then check for file path env var (for NixOS secrets, Docker secrets, etc.)
	if (process.env.GITHUB_PAT_FILE) {
		const filePath = path.resolve(process.env.GITHUB_PAT_FILE);

		// Return cached token if file path hasn't changed
		if (cachedToken && cachedToken.filePath === filePath) {
			return { token: cachedToken.token };
		}

		try {
			// Check file size before reading to prevent memory issues
			const stats = fs.statSync(filePath);
			if (stats.size > MAX_TOKEN_FILE_SIZE) {
				return { error: `Token file at ${filePath} is too large (${stats.size} bytes, max ${MAX_TOKEN_FILE_SIZE})` };
			}
			if (stats.size === 0) {
				return { error: `Token file at ${filePath} is empty` };
			}

			// Read and validate the token
			const content = fs.readFileSync(filePath, "utf8");
			const token = content.trim();

			if (!token) {
				return { error: `Token file at ${filePath} contains only whitespace` };
			}
			if (!isValidTokenFormat(token)) {
				return { error: `Token in ${filePath} appears to be invalid (should start with ghp_, github_pat_, etc.)` };
			}

			// Cache the token for subsequent calls
			cachedToken = { token, filePath };
			return { token };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return { error: `Token file not found at ${filePath}` };
			}
			if ((err as NodeJS.ErrnoException).code === "EACCES") {
				return { error: `Permission denied reading token file at ${filePath}. Ensure the file is readable by the current user.` };
			}
			const errorMessage = err instanceof Error ? err.message : String(err);
			return { error: `Failed to read token file at ${filePath}: ${errorMessage}` };
		}
	}

	return { error: "GitHub token not found. Set GITHUB_PAT environment variable or GITHUB_PAT_FILE (path to file containing token)" };
}

// Make authenticated request to GitHub API
async function fetchFromGitHub<T>(path: string, options: { headers?: Record<string, string> } = {}): Promise<GitHubAPIResponse<T>> {
	const result = getGitHubToken();
	if (!result.token) {
		return {
			ok: false,
			status: 401,
			statusText: result.error || "GitHub token not found",
		};
	}
	const token = result.token;

	const url = `https://api.github.com/${path.replace(/^\//, "")}`;
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github.v3+json",
		...options.headers,
	};

	try {
		const response = await fetch(url, { headers });

		if (!response.ok) {
		// Provide more specific error messages for common GitHub API issues
		let statusText = response.statusText;
		if (response.status === 403) {
		const rateLimitRemaining = response.headers.get("X-RateLimit-Remaining");
		 if (rateLimitRemaining === "0") {
		   const resetTime = response.headers.get("X-RateLimit-Reset");
						const resetDate = resetTime ? new Date(Number.parseInt(resetTime) * 1000).toLocaleString() : "soon";
						statusText = `GitHub API rate limit exceeded. Resets at ${resetDate}`;
					}
				}
				if (response.status === 404) {
					statusText = "Repository or file not found (404)";
				}
				return {
					ok: false,
					status: response.status,
					statusText,
				};
			}

		let data: T | undefined;
		try {
			data = (await response.json()) as T;
		} catch {
			data = undefined;
		}

		return { ok: true, status: response.status, data };
	} catch (err) {
		return {
			ok: false,
			status: 0,
			statusText: err instanceof Error ? err.message : String(err),
		};
	}
}

// Decode base64 content
function decodeBase64(content: string): string {
	// Strip newlines - GitHub's API may include them for formatting, but they interfere with decoding
	const clean = content.replace(/\n/g, "");
	if (typeof Buffer !== "undefined") {
		return Buffer.from(clean, "base64").toString("utf8");
	}
	if (typeof atob !== "undefined") {
		try {
			return decodeURIComponent(escape(atob(clean)));
		} catch {
			return atob(clean);
		}
	}
	throw new Error("Base64 decode not supported");
}

// Extract repo name from URL (supports HTTPS and SSH formats)
function extractRepoName(repository: string): string {
	// Handle SSH format: git@github.com:owner/repo.git
	if (repository.startsWith("git@github.com:")) {
		return repository.replace(/\.git$/, "").replace(/^git@github\.com:/, "");
	}
	// Handle HTTPS format: https://github.com/owner/repo.git
	return repository.replace(/\.git$/, "").replace(/^https:\/\/github\.com\//, "");
}

// Format repository path
function formatRepoPath(repoName: string, filePath: string): string {
	return `/${repoName}/${filePath}`;
}

// Simple glob pattern matching
function matchGlobPatterns(files: string[], pattern: string): string[] {
	const regex = globToRegex(pattern);
	return files.filter((f) => regex.test(f));
}

function globToRegex(pattern: string): RegExp {
	let regex = pattern
		.replace(/\*\*/g, "{{GLOBSTAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, ".")
		.replace(/\{\{GLOBSTAR\}\}/g, ".*");

	regex = regex.replace(/\{([^}]+)\}/g, (match, inner) => {
		const parts = inner.split(",");
		return `(?:${parts.join("|")})`;
	});

	return new RegExp(`^${regex}$`);
}

export default function githubRepoToolsExtension(pi: ExtensionAPI) {
	// Register read_github tool
	pi.registerTool({
		name: "read_github",
		label: "Read GitHub File",
		description: `Read the contents of a file from a GitHub repository.

## When to use this tool

- Reading source code files from remote repositories
- Examining configuration files, documentation, or any file content
- When you need to understand implementation details from open-source projects

## Parameters

- path: The file path within the repository (e.g., "src/index.ts")
- repository: The repository URL (e.g., "https://github.com/owner/repo")
- startLine: Optional start line number to read from (1-indexed)
- endLine: Optional end line number to read to (1-indexed)

## Examples

Read a file from a repository:
{ "path": "README.md", "repository": "https://github.com/facebook/react" }

Read specific lines:
{ "path": "src/index.ts", "repository": "https://github.com/owner/repo", "startLine": 10, "endLine": 50 }`,
		parameters: Type.Object({
			path: Type.String({ description: "The path to the file to read" }),
			repository: Type.String({ description: "Repository URL (e.g., https://github.com/owner/repo)" }),
			startLine: Type.Optional(Type.Number({ description: "Optional start line number to read from (1-indexed)" })),
			endLine: Type.Optional(Type.Number({ description: "Optional end line number to read to (1-indexed)" })),
		}),

		async execute(
			_toolCallId,
			params: { path: string; repository: string; startLine?: number; endLine?: number },
			_signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<GitHubToolDetails>> {
			const { path, repository, startLine, endLine } = params;
			const repoName = extractRepoName(repository);

			const cleanPath = path.startsWith("/") ? path.slice(1) : path;
			const apiPath = `repos/${repoName}/contents/${cleanPath}`;
			const response = await fetchFromGitHub<GitHubFileContent>(apiPath);

			if (!response.ok || !response.data) {
				return {
					content: [{ type: "text", text: `Failed to read file: ${response.statusText || `HTTP ${response.status}`}` }],
					details: { error: response.statusText || `HTTP ${response.status}`, status: response.status },
				};
			}

			let content = response.data.content;
			if (response.data.encoding === "base64") {
				content = decodeBase64(content);
			}

			// Validate and apply line range filtering
			if (typeof startLine === "number" || typeof endLine === "number") {
				const lines = content.split("\n");
				const start = typeof startLine === "number" ? Math.max(0, startLine - 1) : 0;
				const end = typeof endLine === "number" ? Math.max(0, endLine) : lines.length;

				if (start > end) {
					return {
						content: [{ type: "text", text: "Error: startLine must be less than or equal to endLine" }],
						details: { error: "Invalid line range", path, repository: repoName, status: 0 },
					};
				}

				content = lines.slice(start, end).join("\n");
			}

			const startNum = startLine ?? 1;
			const numberedContent = content
				.split("\n")
				.map((line, idx) => `${startNum + idx}: ${line}`)
				.join("\n");

			return {
				content: [{ type: "text", text: numberedContent }],
				details: { path, repository: repoName, lineCount: content.split("\n").length },
			};
		},

		renderResult(result: AgentToolResult<GitHubToolDetails>, options: ToolRenderResultOptions, theme: Theme) {
			const container = new Container();
			const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
			const details = result.details;

			const headerText = details?.path ? `${details.repository}/${details.path}` : "read_github";
			container.addChild(new Text(theme.fg("toolTitle", theme.bold("read_github")) + " " + theme.fg("accent", headerText), 0, 0));
			container.addChild(new Spacer(1));

			// Use visual truncation for proper line wrapping
			const PREVIEW_LINES = 20;
			const width = 80; // Default terminal width
			const { visualLines, skippedCount } = truncateToVisualLines(textContent, options.expanded ? Number.MAX_SAFE_INTEGER : PREVIEW_LINES, width, 0);

			container.addChild(new Text(theme.fg("toolOutput", visualLines.join("\n")), 0, 0));

			if (skippedCount > 0 && !options.expanded) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg("muted", `... (${skippedCount} more lines,`) + ` ${keyHint("expandTools", "to expand")})`,
						0,
						0,
					),
				);
			}

			return container;
		},
	});

	// Register list_directory_github tool
	pi.registerTool({
		name: "list_directory_github",
		label: "List GitHub Directory",
		description: `List the contents of a directory in a GitHub repository.

## When to use this tool

- Exploring repository structure
- Finding files in a specific directory
- Understanding the layout of a codebase

## Parameters

- path: The directory path (use "" or "." for root)
- repository: The repository URL

## Examples

List root directory:
{ "path": ".", "repository": "https://github.com/facebook/react" }

List src directory:
{ "path": "src", "repository": "https://github.com/facebook/react" }`,
		parameters: Type.Object({
			path: Type.String({ description: "Directory path (use '.' for root)" }),
			repository: Type.String({ description: "Repository URL (e.g., https://github.com/owner/repo)" }),
		}),

		async execute(
			_toolCallId: string,
			params: { path: string; repository: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<GitHubToolDetails>> {
			const { path, repository } = params;
			const repoName = extractRepoName(repository);

			let cleanPath = path;
			if (cleanPath.startsWith("/")) cleanPath = cleanPath.slice(1);
			if (cleanPath === "." || cleanPath === "") cleanPath = "";

			const apiPath = `repos/${repoName}/contents/${cleanPath}`;
			const response = await fetchFromGitHub<GitHubDirectoryItem[]>(apiPath);

			if (!response.ok || !response.data) {
				return {
					content: [{ type: "text", text: `Failed to list directory: ${response.statusText || `HTTP ${response.status}`}` }],
					details: { error: response.statusText || `HTTP ${response.status}`, status: response.status },
				};
			}

			const items = response.data.map((item) => (item.type === "dir" ? `${item.name}/` : item.name));

			items.sort((a, b) => {
				const aIsDir = a.endsWith("/");
				const bIsDir = b.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.localeCompare(b);
			});

			const formatted = items.join("\n");

			return {
				content: [{ type: "text", text: formatted || "(empty directory)" }],
				details: { path: cleanPath || ".", repository: repoName, itemCount: items.length },
			};
		},

		renderResult(result: AgentToolResult<GitHubToolDetails>, options: ToolRenderResultOptions, theme: Theme) {
			const container = new Container();
			const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
			const details = result.details;

			const dirPath = details?.path ? `${details.repository}/${details.path}` : details?.repository || "list_directory_github";
			container.addChild(new Text(theme.fg("toolTitle", theme.bold("list_directory_github")) + " " + theme.fg("accent", dirPath), 0, 0));
			container.addChild(new Spacer(1));

			if (textContent && textContent !== "(empty directory)") {
				const PREVIEW_LINES = 30;
				const width = 80;
				const { visualLines, skippedCount } = truncateToVisualLines(textContent, options.expanded ? Number.MAX_SAFE_INTEGER : PREVIEW_LINES, width, 0);

				container.addChild(new Text(theme.fg("toolOutput", visualLines.join("\n")), 0, 0));

				if (skippedCount > 0 && !options.expanded) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(
							theme.fg("muted", `... (${skippedCount} more items,`) + ` ${keyHint("expandTools", "to expand")})`,
							0,
							0,
						),
					);
				}
			} else {
				container.addChild(new Text(theme.fg("muted", "(empty directory)"), 0, 0));
			}

			return container;
		},
	});

	// Register search_github tool
	pi.registerTool({
		name: "search_github",
		label: "Search GitHub Code",
		description: `Search for code patterns in a GitHub repository using GitHub's code search API.

## When to use this tool

- Finding specific code patterns across a repository
- Locating function definitions, imports, or usages
- Searching for text within source files

## Parameters

- pattern: The search query (GitHub code search syntax)
- repository: The repository URL to search within
- path: Optional subdirectory path to limit search

## Examples

Search for a function:
{ "pattern": "function useState", "repository": "https://github.com/facebook/react" }

Search in specific directory:
{ "pattern": "export default", "repository": "https://github.com/owner/repo", "path": "src" }

## GitHub Code Search Syntax

- Use quotes for exact matches: "class Component"
- Search by language: "extension:ts"
- Search by path: "path:src/components"
- Search by filename: "filename:package.json"`,
		parameters: Type.Object({
			pattern: Type.String({ description: "Search query pattern" }),
			repository: Type.String({ description: "Repository URL (e.g., https://github.com/owner/repo)" }),
			path: Type.Optional(Type.String({ description: "Optional subdirectory path to limit search" })),
		}),

		async execute(
			_toolCallId: string,
			params: { pattern: string; repository: string; path?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<GitHubToolDetails>> {
			const { pattern, repository, path } = params;
			const repoName = extractRepoName(repository);

			let query = `${pattern} repo:${repoName}`;
			if (path && path !== ".") {
				query += ` path:${path}`;
			}

			const headers = { Accept: "application/vnd.github.v3.text-match+json" };
			const apiPath = `search/code?q=${encodeURIComponent(query)}&per_page=100`;
			const response = await fetchFromGitHub<GitHubSearchResponse>(apiPath, { headers });

			if (!response.ok || !response.data) {
				return {
					content: [{ type: "text", text: `Search failed: ${response.statusText || `HTTP ${response.status}`}` }],
					details: { error: response.statusText || `HTTP ${response.status}`, status: response.status },
				};
			}

			const data = response.data;

			if (data.total_count === 0) {
				return {
					content: [{ type: "text", text: "No results found." }],
					details: { repository: repoName, pattern, totalCount: 0, results: [] },
				};
			}

			const fileMap = new Map<string, string[]>();
			for (const item of data.items) {
				const filePath = formatRepoPath(repoName, item.path);
				if (!fileMap.has(filePath)) {
					fileMap.set(filePath, []);
				}
				const chunks = fileMap.get(filePath)!;
				for (const match of item.text_matches ?? []) {
					if (match.property === "content" && match.fragment) {
						chunks.push(match.fragment.trim());
					}
				}
			}

			const results: Array<{ file: string; chunks: string[] }> = Array.from(fileMap.entries()).map(([file, chunks]) => ({
				file,
				chunks,
			}));

			const formattedResults = results
				.map((r, i) => {
					const chunksText = r.chunks.slice(0, 3).join("\n");
					const more = r.chunks.length > 3 ? `\n... (${r.chunks.length - 3} more matches)` : "";
					return `${i + 1}. ${r.file}\n${chunksText}${more}`;
				})
				.join("\n\n");

			return {
				content: [{ type: "text", text: `Found ${data.total_count} results:\n\n${formattedResults}` }],
				details: { repository: repoName, pattern, totalCount: data.total_count, results },
			};
		},

		renderResult(result: AgentToolResult<GitHubToolDetails>, options: ToolRenderResultOptions, theme: Theme) {
			const container = new Container();
			const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
			const details = result.details;

			const queryText = details?.pattern ? `"${details.pattern}" in ${details.repository}` : "search_github";
			container.addChild(new Text(theme.fg("toolTitle", theme.bold("search_github")) + " " + theme.fg("accent", queryText), 0, 0));
			container.addChild(new Spacer(1));

			if (details?.totalCount === 0) {
				container.addChild(new Text(theme.fg("muted", "No results found."), 0, 0));
				return container;
			}

			const PREVIEW_LINES = 15;
			const width = 80;
			const { visualLines, skippedCount } = truncateToVisualLines(textContent, options.expanded ? Number.MAX_SAFE_INTEGER : PREVIEW_LINES, width, 0);

			container.addChild(new Text(theme.fg("toolOutput", visualLines.join("\n")), 0, 0));

			if (skippedCount > 0 && !options.expanded) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg("muted", `... (${skippedCount} more lines,`) + ` ${keyHint("expandTools", "to expand")})`,
						0,
						0,
					),
				);
			}

			return container;
		},
	});

	// Register glob_github tool
	pi.registerTool({
		name: "glob_github",
		label: "Glob GitHub Files",
		description: `Find files matching a glob pattern in a GitHub repository using the Git tree API.

## When to use this tool

- Finding all files of a certain type (e.g., all "*.test.ts" files)
- Locating configuration files across a repository
- Pattern matching for file discovery

## Parameters

- filePattern: Glob pattern to match (e.g., "**/*.md", "src/**/*.ts")
- repository: The repository URL
- limit: Optional max results to return
- offset: Optional offset for pagination

## Examples

Find all TypeScript files:
{ "filePattern": "**/*.ts", "repository": "https://github.com/facebook/react" }

Find test files in src:
{ "filePattern": "src/**/*.test.tsx", "repository": "https://github.com/owner/repo" }

Find markdown files with pagination:
{ "filePattern": "**/*.md", "repository": "https://github.com/owner/repo", "limit": 10, "offset": 0 }`,
		parameters: Type.Object({
			filePattern: Type.String({ description: "Glob pattern to match files (e.g., '**/*.ts')" }),
			repository: Type.String({ description: "Repository URL (e.g., https://github.com/owner/repo)" }),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results to return" })),
			offset: Type.Optional(Type.Number({ description: "Offset for pagination", default: 0 })),
		}),

		async execute(
			_toolCallId,
			params: { filePattern: string; repository: string; limit?: number; offset?: number },
			_signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<GitHubToolDetails>> {
			const { filePattern, repository, limit, offset = 0 } = params;
			const repoName = extractRepoName(repository);

			const apiPath = `repos/${repoName}/git/trees/HEAD?recursive=1`;
			const response = await fetchFromGitHub<{ tree: Array<{ path: string; type: string }>; truncated: boolean }>(apiPath);

			if (!response.ok || !response.data) {
				return {
					content: [{ type: "text", text: `Failed to fetch file tree: ${response.statusText || `HTTP ${response.status}`}` }],
					details: { error: response.statusText || `HTTP ${response.status}`, status: response.status },
				};
			}

			const filesOnly = response.data.tree.filter((item) => item.type === "blob").map((item) => item.path);
			const matched = matchGlobPatterns(filesOnly, filePattern);
			const paginated = limit !== undefined ? matched.slice(offset, offset + limit) : matched.slice(offset);

			let outputText = paginated.map((p) => formatRepoPath(repoName, p)).join("\n") || "No files matched.";

			// Warn users if repository is too large for full tree listing (GitHub truncates at ~100k entries)
			if (response.data.truncated) {
				outputText += "\n\n[Note: This repository is large and results may be incomplete due to GitHub API tree truncation]";
			}

			return {
				content: [{ type: "text", text: outputText }],
				details: { repository: repoName, pattern: filePattern, totalCount: matched.length, results: paginated },
			};
		},

		renderResult(result: AgentToolResult<GitHubToolDetails>, options: ToolRenderResultOptions, theme: Theme) {
			const container = new Container();
			const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
			const details = result.details;

			const headerText = details?.pattern ? `"${details.pattern}" in ${details.repository}` : "glob_github";
			container.addChild(new Text(theme.fg("toolTitle", theme.bold("glob_github")) + " " + theme.fg("accent", headerText), 0, 0));
			container.addChild(new Spacer(1));

			if (details?.totalCount === 0) {
				container.addChild(new Text(theme.fg("muted", "No files matched."), 0, 0));
				return container;
			}

			const PREVIEW_LINES = 30;
			const width = 80;
			const { visualLines, skippedCount } = truncateToVisualLines(textContent, options.expanded ? Number.MAX_SAFE_INTEGER : PREVIEW_LINES, width, 0);

			container.addChild(new Text(theme.fg("toolOutput", visualLines.join("\n")), 0, 0));

			if (skippedCount > 0 && !options.expanded) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg("muted", `... (${skippedCount} more files,`) + ` ${keyHint("expandTools", "to expand")})`,
						0,
						0,
					),
				);
			}

			return container;
		},
	});

	// Register list_repositories tool
	pi.registerTool({
		name: "list_repositories",
		label: "List GitHub Repositories",
		description: `Search and list public GitHub repositories.

## When to use this tool

- Finding popular repositories by topic or name
- Discovering repositories in a specific organization
- Searching for repositories by programming language

## Parameters

- pattern: Optional search term to match in repository names
- organization: Optional organization to search within
- language: Optional programming language filter
- limit: Max results to return (default: 30)

## Examples

Search for react repositories:
{ "pattern": "react", "limit": 10 }

List repositories in an organization:
{ "organization": "microsoft", "limit": 20 }

Find TypeScript projects:
{ "pattern": "framework", "language": "typescript", "limit": 15 }`,
		parameters: Type.Object({
			pattern: Type.Optional(Type.String({ description: "Search term to match in repository names" })),
			organization: Type.Optional(Type.String({ description: "Organization name to search within" })),
			language: Type.Optional(Type.String({ description: "Programming language filter (e.g., 'typescript', 'python')" })),
			limit: Type.Optional(Type.Number({ description: "Maximum results to return", default: 30 })),
		}),

		async execute(
			_toolCallId: string,
			params: { pattern?: string; organization?: string; language?: string; limit?: number },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<GitHubToolDetails>> {
			const { pattern, organization, language, limit = 30 } = params;

			const parts: string[] = [];
			if (pattern) parts.push(`${pattern} in:name`);
			if (organization) parts.push(`org:${organization}`);
			if (language) parts.push(`language:${language}`);
			const query = parts.length > 0 ? parts.join(" ") : "*";

			const apiPath = `search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 100)}&sort=stars&order=desc`;
			const response = await fetchFromGitHub<{
				total_count: number;
				items: Array<{
					full_name: string;
					description: string | null;
					language: string | null;
					stargazers_count: number;
					forks_count: number;
					private: boolean;
				}>;
			}>(apiPath);

			if (!response.ok || !response.data) {
				return {
					content: [{ type: "text", text: `Failed to search repositories: ${response.statusText || `HTTP ${response.status}`}` }],
					details: { error: response.statusText || `HTTP ${response.status}`, status: response.status },
				};
			}

			const repos = response.data.items.slice(0, limit).map((r) => ({
				name: r.full_name,
				description: r.description,
				language: r.language,
				stars: r.stargazers_count,
				forks: r.forks_count,
				private: r.private,
			}));

			const formatted = repos
				.map((r, i) => {
					const desc = r.description ? ` - ${r.description.slice(0, 80)}${r.description.length > 80 ? "..." : ""}` : "";
					const meta = ` [${r.language || "N/A"}] ★${r.stars} ⑂${r.forks}`;
					return `${i + 1}. ${r.name}${meta}${desc}`;
				})
				.join("\n");

			return {
				content: [{ type: "text", text: repos.length > 0 ? formatted : "No repositories found." }],
				details: { query, totalCount: response.data.total_count, results: repos },
			};
		},

		renderResult(result: AgentToolResult<GitHubToolDetails>, options: ToolRenderResultOptions, theme: Theme) {
			const container = new Container();
			const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
			const details = result.details;

			const headerText = details?.query && details.query !== "*" ? `search: "${details.query}"` : "list_repositories";
			container.addChild(new Text(theme.fg("toolTitle", theme.bold("list_repositories")) + " " + theme.fg("accent", headerText), 0, 0));
			container.addChild(new Spacer(1));

			if (!textContent || textContent === "No repositories found.") {
				container.addChild(new Text(theme.fg("muted", "No repositories found."), 0, 0));
				return container;
			}

			const PREVIEW_LINES = 20;
			const width = 80;
			const { visualLines, skippedCount } = truncateToVisualLines(textContent, options.expanded ? Number.MAX_SAFE_INTEGER : PREVIEW_LINES, width, 0);

			container.addChild(new Text(theme.fg("toolOutput", visualLines.join("\n")), 0, 0));

			if (skippedCount > 0 && !options.expanded) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg("muted", `... (${skippedCount} more repos,`) + ` ${keyHint("expandTools", "to expand")})`,
						0,
						0,
					),
				);
			}

			return container;
		},
	});

	// Register commit_search tool
	pi.registerTool({
		name: "commit_search",
		label: "Search GitHub Commits",
		description: `Search commits in a GitHub repository.

## When to use this tool

- Finding when a specific change was made
- Tracking commit history by author
- Searching for commits within a date range
- Understanding code evolution

## Parameters

- repository: The repository URL (required)
- query: Optional search term in commit messages
- author: Optional GitHub username of commit author
- since: Optional start date (YYYY-MM-DD format)
- until: Optional end date (YYYY-MM-DD format)

## Examples

Search commits by message:
{ "repository": "https://github.com/facebook/react", "query": "fix hooks" }

Search by author:
{ "repository": "https://github.com/owner/repo", "author": "danabramov" }

Search by date range:
{ "repository": "https://github.com/owner/repo", "since": "2024-01-01", "until": "2024-06-30" }

Combined search:
{ "repository": "https://github.com/facebook/react", "query": "refactor", "author": "gaearon", "since": "2024-01-01" }`,
		parameters: Type.Object({
			repository: Type.String({ description: "Repository URL (e.g., https://github.com/owner/repo)" }),
			query: Type.Optional(Type.String({ description: "Search term in commit messages" })),
			author: Type.Optional(Type.String({ description: "GitHub username of commit author" })),
			since: Type.Optional(Type.String({ description: "Start date (YYYY-MM-DD)" })),
			until: Type.Optional(Type.String({ description: "End date (YYYY-MM-DD)" })),
		}),

		async execute(
			_toolCallId: string,
			params: { repository: string; query?: string; author?: string; since?: string; until?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<GitHubToolDetails>> {
			const { repository, query, author, since, until } = params;
			const repoName = extractRepoName(repository);

			const parts: string[] = [];
			if (query) parts.push(query);
			parts.push(`repo:${repoName}`);
			if (author) parts.push(`author:${author}`);
			if (since) parts.push(`author-date:>=${since}`);
			if (until) parts.push(`author-date:<=${until}`);
			const searchQuery = parts.join(" ");

			const apiPath = `search/commits?q=${encodeURIComponent(searchQuery)}&per_page=100&sort=author-date&order=desc`;
			const response = await fetchFromGitHub<{
				total_count?: number;
				items?: Array<{
					sha: string;
					commit: {
						message: string;
						author: { name: string; email: string; date: string };
					};
				}>;
			}>(apiPath);

			if (!response.ok || !response.data) {
				return {
					content: [{ type: "text", text: `Failed to search commits: ${response.statusText || `HTTP ${response.status}`}` }],
					details: { error: response.statusText || `HTTP ${response.status}`, status: response.status },
				};
			}

			const items = response.data.items ?? [];
			const commits = items.map((c) => ({
				sha: c.sha.slice(0, 7),
				fullSha: c.sha,
				message: c.commit.message.split("\n")[0].trim(),
				fullMessage: c.commit.message.trim(),
				author: c.commit.author.name,
				date: c.commit.author.date.slice(0, 10),
			}));

			const formatted = commits
				.map((c, i) => `${i + 1}. \`${c.sha}\` ${c.date} - ${c.author}: ${c.message}`)
				.join("\n");

			return {
				content: [{ type: "text", text: commits.length > 0 ? formatted : "No commits found." }],
				details: { repository: repoName, totalCount: response.data.total_count ?? commits.length, results: commits },
			};
		},

		renderResult(result: AgentToolResult<GitHubToolDetails>, options: ToolRenderResultOptions, theme: Theme) {
			const container = new Container();
			const textContent = result.content.find((c) => c.type === "text")?.text ?? "";
			const details = result.details;

			const headerText = details?.repository ? `commits in ${details.repository}` : "commit_search";
			container.addChild(new Text(theme.fg("toolTitle", theme.bold("commit_search")) + " " + theme.fg("accent", headerText), 0, 0));
			container.addChild(new Spacer(1));

			if (!textContent || textContent === "No commits found.") {
				container.addChild(new Text(theme.fg("muted", "No commits found."), 0, 0));
				return container;
			}

			const PREVIEW_LINES = 25;
			const width = 80;
			const { visualLines, skippedCount } = truncateToVisualLines(textContent, options.expanded ? Number.MAX_SAFE_INTEGER : PREVIEW_LINES, width, 0);

			container.addChild(new Text(theme.fg("toolOutput", visualLines.join("\n")), 0, 0));

			if (skippedCount > 0 && !options.expanded) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg("muted", `... (${skippedCount} more commits,`) + ` ${keyHint("expandTools", "to expand")})`,
						0,
						0,
					),
				);
			}

			return container;
		},
	});
}
