---
name: status
description: Show or reset the tools that tool-health recorded as failing for structural reasons in this environment (unsupported by the API provider, command not installed, MCP server unreachable). Use when asked which tools don't work here, why a tool is being avoided, or to forget a recorded failure.
argument-hint: "[reset [key]]"
allowed-tools: Bash
---

# tool-health status

Run the bundled script and report its output. It touches only the plugin's own state file, never the project.

- No arguments: `sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" status --data-dir "${CLAUDE_PLUGIN_DATA}"`
- `$ARGUMENTS` starting with `reset`: `sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" reset [key] --data-dir "${CLAUDE_PLUGIN_DATA}"`, where `key` is the entry key (e.g. `tool:WebSearch`, `cmd:gh`, `mcp:github`) or its subject (`WebSearch`, `gh`). Without a key, all entries are removed: confirm with the user first.

Summarize the entries in plain language: what fails, since when, and the suggested alternative. Entries expire 7 days after the last failure (`TOOL_HEALTH_TTL_DAYS`) or when the tool succeeds again. If the command prints nothing, Python 3.8+ is probably missing: say so.
