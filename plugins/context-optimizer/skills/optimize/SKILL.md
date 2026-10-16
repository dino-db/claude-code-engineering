---
name: optimize
description: Audit Claude Code instruction files for repeated guidance, excessive length, and opportunities to reduce context usage without changing behavior. Use when asked to optimize CLAUDE.md, agent instructions, or project Claude configuration.
argument-hint: "[project path]"
allowed-tools: Read, Grep, Glob, Bash
---

# Context Optimizer — read-only audit

Analyze the user's target repository (`$ARGUMENTS` if supplied, otherwise the current working directory). Never modify files, configuration, Git state, or memory. Never run installation commands.

1. Locate relevant instruction sources: root and nested `CLAUDE.md`, `AGENTS.md`, Markdown under `.claude/`, and global `~/.claude/CLAUDE.md` only if readable and relevant. Do not traverse unrelated private directories. Do not print secrets.
2. Run the bundled deterministic analyzer when available: `python "${CLAUDE_PLUGIN_ROOT}/scripts/audit_context.py" --root .` (replace `.` with the requested repository path). If shell environment expansion differs, resolve the plugin path before invoking. The analyzer is advisory; inspect source context before proposing deletions.
3. Read only the relevant sections around findings. Separate exact duplicate text from semantically overlapping instructions; avoid claiming semantic equivalence from matching keywords.
4. Check instruction precedence and applicability before suggesting moves between global, repository, subdirectory, agent and skill scopes. Avoid changes that would silently broaden permissions or remove safeguards.
5. Prefer precise, low-risk edits: shorten repeated explanations, reference stable documentation, consolidate exact duplicates only when scopes match, and leave operational rules near their point of use.
6. Return a concise report with: **Summary**, **Evidence** (path:line and short excerpt), **Recommendations** (expected benefit and behavior risk), **Do not change**, and **Uncertainties**. Label token counts as estimates, never measured API savings. Do not promise that shorter files necessarily reduce billed tokens.
7. Ask for explicit approval before any later edit. Do not modify anything during this skill invocation.

If the analyzer is missing or Python is unavailable, perform a manual read-only review and disclose that automated checks were skipped.
