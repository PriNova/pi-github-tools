# @prinova/pi-github-tools

GitHub repository tools extension for [pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent). Provides tools to read, search, and explore GitHub repositories directly from pi.

## Installation

```bash
pi install npm:@prinova/pi-github-tools
```

Or install globally:

```bash
npm install -g @prinova/pi-github-tools
```

## Setup

This extension requires a GitHub Personal Access Token (PAT) to access the GitHub API. You can provide the token in two ways:

### Option 1: Environment Variable (GITHUB_PAT)

```bash
export GITHUB_PAT=ghp_your_token_here
```

### Option 2: File Path (GITHUB_PAT_FILE)

For NixOS, Docker secrets, or other deployments where secrets are stored in files:

```bash
export GITHUB_PAT_FILE=/path/to/github_token.txt
```

The file should contain only the token (with optional trailing whitespace/newlines). This is useful for:
- NixOS automatic deployments with `deployment.keys`
- Docker secrets mounted as files
- Kubernetes secrets
- systemd credentials

**Token File Example:**
```bash
# Create the token file (replace with your actual token)
echo -n 'ghp_xxxxxxxxxxxxxxxxxxxx' > /etc/secrets/github_token
chmod 600 /etc/secrets/github_token

# Set the environment variable
export GITHUB_PAT_FILE=/etc/secrets/github_token
```

**Security Notes:**
- The token file must be readable by the user running pi
- File size is limited to 1KB (tokens are typically ~40-100 bytes)
- Tokens are validated to ensure they start with valid GitHub prefixes (`ghp_`, `github_pat_`, etc.)
- The token is cached in memory after first read for performance

### Creating a GitHub Token

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Select the `repo` scope for full repository access, or `public_repo` for public repositories only
4. Generate and copy the token

## Tools

This extension adds the following tools to pi:

### `read_github`
Read the contents of a file from a GitHub repository.

**Parameters:**
- `path` - The file path within the repository (e.g., "src/index.ts")
- `repository` - The repository URL (e.g., "https://github.com/owner/repo")
- `startLine` (optional) - Start line number to read from (1-indexed)
- `endLine` (optional) - End line number to read to (1-indexed)

**Example:**
```json
{ "path": "README.md", "repository": "https://github.com/facebook/react" }
```

### `list_directory_github`
List the contents of a directory in a GitHub repository.

**Parameters:**
- `path` - Directory path (use "." for root)
- `repository` - Repository URL

**Example:**
```json
{ "path": "src", "repository": "https://github.com/facebook/react" }
```

### `search_github`
Search for code patterns in a GitHub repository using GitHub's code search API.

**Parameters:**
- `pattern` - Search query pattern (GitHub code search syntax)
- `repository` - Repository URL to search within
- `path` (optional) - Subdirectory path to limit search

**Example:**
```json
{ "pattern": "function useState", "repository": "https://github.com/facebook/react" }
```

### `glob_github`
Find files matching a glob pattern in a GitHub repository using the Git tree API.

**Parameters:**
- `filePattern` - Glob pattern to match (e.g., "**/*.md", "src/**/*.ts")
- `repository` - Repository URL
- `limit` (optional) - Maximum results to return
- `offset` (optional) - Offset for pagination

**Example:**
```json
{ "filePattern": "**/*.test.ts", "repository": "https://github.com/facebook/react" }
```

### `list_repositories`
Search and list public GitHub repositories.

**Parameters:**
- `pattern` (optional) - Search term to match in repository names
- `organization` (optional) - Organization to search within
- `language` (optional) - Programming language filter
- `limit` (optional) - Max results (default: 30)

**Example:**
```json
{ "pattern": "react", "limit": 10 }
```

### `commit_search`
Search commits in a GitHub repository.

**Parameters:**
- `repository` - Repository URL (required)
- `query` (optional) - Search term in commit messages
- `author` (optional) - GitHub username of commit author
- `since` (optional) - Start date (YYYY-MM-DD)
- `until` (optional) - End date (YYYY-MM-DD)

**Example:**
```json
{ "repository": "https://github.com/facebook/react", "query": "fix hooks", "author": "danabramov" }
```

## Usage in pi

Once installed, the tools are automatically available in pi. Just ask pi to use them:

```
Read the README from https://github.com/vercel/next.js
```

```
Find all TypeScript files in the React repository
```

```
Search for "useEffect" usage in the facebook/react repo
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev
```

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on GitHub.
