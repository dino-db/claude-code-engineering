# Context Optimizer

A read-only Claude Code plugin that audits instruction files for duplicated guidance and unnecessary context overhead.

## Features

- `/context-optimizer:optimize` skill: contextual recommendations with file and line evidence.
- `scripts/audit_context.py`: deterministic, dependency-free checks for oversized files and repeated normalized lines across files.
- No file edits, no Git changes, no dependency installation.

## Installation

Place this folder at `plugins/context-optimizer` in your marketplace repository. Add this entry to the **existing** `.claude-plugin/marketplace.json` `plugins` array (do not replace existing entries):

```json
{
  "name": "context-optimizer",
  "source": "./plugins/context-optimizer",
  "description": "Read-only Claude Code instruction and context audit"
}
```

For local development:

```powershell
claude plugin validate C:\projects\claude-code-engineering\plugins\context-optimizer
claude --plugin-dir C:\projects\claude-code-engineering\plugins\context-optimizer
```

In Claude Code, run `/context-optimizer:optimize` from a target project.

## Standalone audit

```powershell
python C:\projects\claude-code-engineering\plugins\context-optimizer\scripts\audit_context.py --root C:\projects\your-project
```

Add `--json` for machine-readable output. Counts are heuristics, not actual token billing. Repeated lines may be intentional due to differing scopes; review recommendations before making changes.

## Testing

From the plugin directory:

```powershell
python -m unittest discover -s tests -v
```

## Privacy and safety

Runs locally and reads only Markdown instruction files under the requested project directory. The skill may inspect global instructions when relevant; the script does not. Avoid including confidential content in reports you share publicly.
