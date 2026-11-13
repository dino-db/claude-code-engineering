# Tool Health

A Claude Code plugin that remembers which tools fail for **structural** reasons in your environment and tells Claude at the start of the next session, so it stops paying the same failed calls again.

Typical cases:

- an API gateway (Databricks, a corporate proxy, ...) that rejects the server-side `WebSearch` tool: `API Error: 400 ... does not match any of the expected tags`;
- a CLI that isn't installed: `gh: command not found`, even when a pipe hides the exit code (`gh api ... | head` exits 0);
- an MCP server that is down: `server github is not connected`.

At the next session start Claude receives a short note such as:

```
tool-health: these tools failed for structural reasons in recent sessions in this environment (provider: gateway:example.cloud.databricks.com). ...
- `WebSearch` is not supported by the API provider here: don't call it. Use WebFetch on known URLs instead. (seen 3x, last 2026-11-13; error: API Error: 400 ...)
- `gh` is not installed or not on PATH: use another available tool, or ask the user to install it. (seen 1x, ...)
```

## What it records, and what it doesn't

| Recorded | Scope | Signal |
|----------|-------|--------|
| Tool unsupported by the API provider | provider | `API Error: 400` with unsupported-tool wording, `API Error: 404`, `No such tool available` |
| Tool refused by the API provider | provider | `API Error: 403` |
| Command not installed | machine | bash, zsh, `cmd` and PowerShell "not found" messages |
| MCP server unreachable | machine | `mcp__<server>__*` with not connected / connection closed / refused |

Not recorded: interrupts, user rejections, permission or hook denials, `429`/`5xx`, ordinary `400`s, failing tests, a `404` web page. They are not properties of the environment.

*Provider* entries apply only to the same provider: `bedrock`, `vertex`, `foundry`, `gateway:<host>` (the hostname of `ANTHROPIC_BASE_URL`, never the path or credentials) or `anthropic`. *Machine* entries apply to every session on this machine.

An entry disappears when the same tool, command or MCP server succeeds again, or 7 days after its last failure (`TOOL_HEALTH_TTL_DAYS` to change it).

## Usage

Install it and forget it: the hooks work on their own.

```
/tool-health:status           # list entries
/tool-health:status reset gh  # forget one entry (key or subject)
/tool-health:status reset     # forget everything
```

Standalone: `python scripts/tool_health.py status --data-dir <dir>`.

## Installation

From this repository's marketplace:

```bash
claude plugin install tool-health@claude-code-engineering
```

For local development:

```powershell
claude plugin validate C:\projects\claude-code-engineering\plugins\tool-health
claude --plugin-dir C:\projects\claude-code-engineering\plugins\tool-health
```

Requires Python 3.8+ (`python3` or `python`) and `sh` (Git Bash on Windows). Without them the hooks exit silently and the plugin does nothing.

## How it works

| Hook | Matcher | Action |
|------|---------|--------|
| `PostToolUseFailure` | all | Classify the error; record structural failures |
| `PostToolUse` | `Bash\|WebSearch\|WebFetch\|mcp__.*` | Clear entries the success disproves; for Bash also scan the output for missing commands |
| `SessionStart` | all | Drop expired entries; inject the active ones as context |

State lives in `${CLAUDE_PLUGIN_DATA}/state.json` (`~/.claude/plugins/data/<id>/`), written atomically. Error details are cut to one line of at most 160 characters, with bearer tokens, API keys and long tokens redacted.

The plugin never blocks or rewrites a tool call and never touches your project: its only write is its own state file. Every hook catches its own errors and exits 0.

## Testing

From the plugin directory:

```powershell
python -m unittest discover -s tests -v
```
