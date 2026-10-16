# engineering-workflow

A Claude Code mod that shows, in a persistent panel, how a session moves through the
**Explore › Plan › Implement › Verify** workflow driven by this repository's agents
(`codebase-explorer`, `implementation-planner`, `implementation-executor`, `implementation-verifier`).

It works in any Git repository with no configuration, and it is **read-only**: it blocks, rewrites and
enforces nothing.

## What it shows

Two rows above the prompt, and the **Engineering Workflow** pane (opened at session start where the
terminal is wide enough, or with `/workflow`):

- **Session**: the session's repository and branch, and the agents at work, Main and each subagent still
  running, with status and elapsed time.
- **Workflow**: the current cycle and phase, each phase done, in progress, failed, skipped or not started.
- **Verification**: the latest `implementation-verifier` verdict, else the latest validation command,
  else *Pending validation* once something was edited.
- **Modified files**, per repository, each with a **changes** button that opens its diff in a pane of its
  own: against the file as the session found it, so only this session's changes show. A file put back as
  it was leaves the list.
- **Recent activity**: tool calls, agent starts and ends, link messages.
- **Context**, fixed at the foot of the pane: how full the context window is (green under 50%, yellow
  under 80%, red above), with **Compact** (`k`) and **Clear cache** (`x`), which empties
  `~/.claude/cache`, `~/.claude/paste-cache` and `~/.claude/stats-cache.json`.

### Repositories

No paths to configure. The session's repository is the Git toplevel of its working directory. Any other
repository joins the session the first time Claude edits a file in it, with its own branch and file list.
Repositories are named by their folder; two with the same folder name get the folder above appended:
`api (work)`, `api (personal)`. A session outside any Git repository still shows agents, phases and
context.

## Menu: sessions and skills

The **☰** button (`m`) opens **sessions ▸** and **skills ▸**.

- **skills ▸** lists the session repository's skills (`.claude/skills/*/SKILL.md`); an entry puts its
  command in the prompt, for Enter to run.
- **sessions ▸** lists the repositories with open sessions (this one's first, then those it edited), and
  under each its sessions: `● window`, `◌ background`, `· this session` or `opened by hand`.
  - Pressing a session brings it up: its Windows Terminal window, or a new tab running
    `claude attach <id>` for one in the background.
  - **✕** closes a session after a confirmation: `claude stop <id>` in the background, otherwise its
    claude process is ended, only while that pid is still claude's (`taskkill` on Windows, `ps` then
    `kill` elsewhere). The conversation stays in `/resume`.
  - **+ new session**: pick a repository, type a name (letters, digits, `-` `_` `.`): a new tab running
    `claude --name <name>` in that repository.
- `/workflow sessions [repository]` opens the menu, on a repository's list when one is named.

Every session keeps a small file in `<temp>/engineering-workflow/sessions/`, refreshed every 20 s; one not
refreshed for 45 s counts as gone.

## Platform support

> [!IMPORTANT]
> Opening sessions is automatic **only with Windows Terminal**. Everywhere else the menu gives the
> command to run by hand, and says so.

| Feature | Windows + Windows Terminal | Windows without it, macOS, Linux |
|---------|:--------------------------:|:--------------------------------:|
| Workflow pane, band, diffs, verification | ✓ | ✓ |
| Context meter, Compact, Clear cache | ✓ | ✓ |
| Skills menu | ✓ | ✓ |
| Session link and `message_partner` | ✓ | ✓ |
| List and close sessions | ✓ | ✓ |
| Bring a session's window forward | ✓ | — (switch to it by hand) |
| Bring up a background session | new tab, attached | shows `claude attach <id>` |
| Start a new named session | new tab | shows `cd <root> && claude --name <name>` |

Without Windows Terminal the sessions menu shows, at its top,
*"Windows Terminal not found: open/new show the command to run"*, and the entries that cannot run read
`copy command` or `in another window`. Windows Terminal is looked for at its App Execution Alias
(`%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`) and on the `PATH`.

## Session link

The **⇄** button (`l`, lit while linked) lists every other open session, grouped by repository (the same
repository included, for another worktree or task). Pick one to link the two, so their Claudes can message
each other:

- each session has at most one partner; linking with a session already linked elsewhere closes that link,
  and **unlink** drops this one. The pairs live in `<temp>/engineering-workflow/link.json`;
- while the partner is not open the pane shows `waiting for <repository> · <name>…`;
- while linked with a live partner, Claude has the tool `message_partner` and a system prompt section naming
  the partner: it messages the other session when a change crosses the two, asks its user before anything
  large, and sends no acknowledgements;
- messages arrive framed `[from session <name> · <repository>] …` and show in Recent activity as
  `→ <repository>: …` and `← <repository>: …`.

A session running in another permission mode may hold an incoming message for its user's approval before
its Claude reads it.

## Phase rules

- Subagents decide the phase: `codebase-explorer` or `Explore` → Explore, `implementation-planner` or
  `Plan` → Plan, `implementation-executor` → Implement, `implementation-verifier` → Verify. Their own tool
  calls never move it.
- Main Claude, and any other subagent, is inferred: reads, searches and read-only shell commands → Explore
  (only from no phase); plan mode, todo lists and files under `~/.claude/plans/` → Plan; edits to repository
  files → Implement (also after Verify); validation commands, or `git diff` after an edit → Verify. Tests
  before any edit count as exploration.
- Explore or Plan after Verify, in a later turn or by a workflow agent, starts the next cycle.
  `/workflow reset` starts one by hand.

Validation commands are recognised for the common toolchains: `npm`/`yarn`/`pnpm`/`bun`
`test|lint|build|check|typecheck`, `jest`, `vitest`, `eslint`, `tsc`, `playwright`, `pytest`, `unittest`,
`ruff check`, `mypy`, `pyright`, `pylint`, `flake8`, `tox`, `nox`, `mvn`, `gradle`, `go test|vet|build`,
`cargo test|check|clippy|build`, `dotnet test|build`, `make test|check|lint`.

## Observational only

Every hook passes its event on with `next(e)` and returns the result unchanged; what the mod records is
taken afterwards inside `try/catch`. It denies nothing, rewrites nothing, changes no permission and
registers no `classic.*` hook, so a repository's own settings hooks run exactly as before. Git is only read
(`rev-parse`, `branch --show-current`, `status --porcelain`, `diff`), with `--no-optional-locks`.

Its only actions are the ones you press: Compact, Clear cache, the sessions menu, link and unlink. The one
answer it gives for itself is its own `message_partner` tool's.

## Events observed

| Event | Used for |
|-------|----------|
| `session.start` | repository, terminal, registry entry, `/workflow`, Git poll, pane |
| `session.end` | registry entry closed; on `/clear`, a fresh start |
| `turn.start` / `turn.complete` | Main working and finished; subagent ends and the verifier's verdict |
| `agent.spawn` | subagent start, type and phase |
| `tool.call` | repositories, phase inference, edits, validations; the partner tool |
| `prompt.compose` | the link section of the system prompt, while linked |
| `session.receive` | messages from the partner |
| `ui.render` `AbovePrompt` / `Pane` | drawing |

## Installation

From this repository's marketplace:

```bash
claude plugin marketplace add <owner>/claude-code-engineering
claude plugin install engineering-workflow@claude-code-engineering
```

Or from a local clone, for one session or permanently:

```bash
claude --plugin-dir /path/to/claude-code-engineering/plugins/engineering-workflow
```

```json
// ~/.claude/settings.json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-code-engineering/plugins/engineering-workflow" } }
```

A folder loaded this way is watched: saving a file reloads the mod.

## Development

```bash
claude plugin validate .
claude plugin test .
```

The engine follows `$` into no import, so everything that calls the engine lives in `hooks/register.tsx`;
the other modules under `hooks/` are pure and tested directly.

## License

[MIT](../../LICENSE)
