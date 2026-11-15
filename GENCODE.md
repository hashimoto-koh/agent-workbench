# GenCode CLI Support in Agent Workbench

This document describes the support, environment variable contracts, and architecture for Genspark's GenCode CLI (`gencode`) in this fork of Agent Workbench.

## Overview

- **Agent ID:** `gencode`
- **Label:** `GenCode`
- **Command:** `gencode`
- **Verified Version:** `1.19.3-gencode.6`
- **Website:** [https://www.genspark.ai](https://www.genspark.ai)

GenCode is a derivative of OpenCode 1.x. It is implemented as an independent agent using `createOpenCodeFamilyAdapter`, sharing common logic with OpenCode while strictly separating databases, processes, credentials, and settings.

## Isolation & Security

1. **Storage & Database:**
   - GenCode uses its own data directory under `gencode` (default POSIX: `~/.local/share/gencode/opencode.db`, default Windows: `%USERPROFILE%\.local\share\gencode\opencode.db`, or `$XDG_DATA_HOME/gencode/opencode.db` when `XDG_DATA_HOME` is set).
   - OpenCode database settings (`OPENCODE_DB`) and OpenCode model caches (`OPENCODE_MODELS_*`) do not bleed into GenCode.
   - The database is accessed strictly read-only by Agent Workbench.

2. **Serve Process & Credentials:**
   - GenCode runs its own detached local server in a separate empty working directory (`path.join(os.tmpdir(), 'agent-workbench', 'gencode-serve')`).
   - A distinct random 48-hex password and ephemeral localhost port are allocated.
   - If an error occurs, passwords and custom usernames are redacted (`***`) from stderr outputs to avoid leaking credentials, while preserving diagnostic paths like `opencode.db`.
   - The listening command recognition strictly expects `gencode server listening on...` and rejects lines from other CLIs.

3. **Symlink and Project Unification:**
   - GenCode records canonical resolved paths (`realpath`), whereas other tools (such as Codex) may use symlinked paths.
   - `SessionIndex` automatically resolves canonical path aliases so sessions in the same physical directory are unified into a single project.
   - Project relocations are dynamically resolved regardless of session scan order.
   - **Known Limitation:** Alias resolution and `ProjectLocationStore` relocations match exact `cwd` paths learned from sessions. Parent-directory symlink relocations and child subdirectories of symlinked paths are not canonicalized in this release.

## Environment Variable Contract (`OPENCODE_*`)

Agent Workbench separates GenCode and OpenCode environments using the following policy (handled case-insensitively on Windows):

| Variable | `serveEnv` (Server) | `cleanTerminalEnv` (TUI) | Rationale |
|---|---|---|---|
| `OPENCODE_DB` | **Removed** | **Removed** | Prevents GenCode from reading or writing OpenCode's history database. |
| `OPENCODE_MODELS_PATH` / `OPENCODE_MODELS_URL` | **Removed** | **Removed** | Keeps GenCode model cache separate (`openCodeModelsEnv: false`). |
| `OPENCODE_SERVER_PASSWORD` / `OPENCODE_PASSWORD` | **Inherited** (overwritten by `OpenCodeServeProcess.environment()`) | **Removed** | `serveEnv` preserves them, and `OpenCodeServeProcess.environment()` overwrites them with the ephemeral 48-hex password generated per serve session. |
| `OPENCODE_SERVER_USERNAME` | **Inherited** | **Removed** | Preserves user-specified Basic Auth username across `serve` and `attach --username` (defaults to `opencode`). |
| Other env vars | **Inherited** | **Inherited** | Preserves user configuration and shell environment variables. |

## Supported Capabilities

- **Session Creation & Attach:** Full support for creating new sessions and resuming existing sessions.
- **Activity & Status Monitoring:** Tracks `idle`, `busy`, and `waiting` statuses via the local serve process.
- **Question Cards & Permissions:** Supports interactive questions and tool permissions.
- **Input & Pasting:** Supports images and multi-line inputs using quoted paths and interrupt sequences.
- **Bidirectional Handoff:** Supported across Claude Code, Codex, OpenCode, and GenCode.

### Intentionally Disabled / Unverified

- `scheduledSend` (`false`): Scheduled asynchronous prompt delivery via serve API is left disabled until verified with GenCode.
- `moveToWorktree` (`false`): Moving sessions across git worktrees via experimental API is left disabled until verified.
