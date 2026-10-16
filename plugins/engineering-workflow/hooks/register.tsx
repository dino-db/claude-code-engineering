import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Baselines,
  DiffView,
  GitInfo,
  LinkFile,
  LinkPair,
  LinkState,
  PanelMenu,
  Repo,
  RepoGit,
  RepoRoots,
  SessionEntry,
  SkillAction,
  TerminalInfo,
  WorkState,
} from '../types'
import { EDIT_TOOLS, classifyTool, isInterruptedRun, isVerifier, parseVerdict } from './classify'
import {
  agentFinished,
  agentIdKnown,
  agentStarted,
  applyTool,
  initialTracker,
  noted,
  turnEnded,
  turnStarted,
} from './tracker'
import {
  allOpen,
  attachArgv,
  attachCommand,
  closePlan,
  entryFile,
  entryLabel,
  errorFile,
  focusArgv,
  killArgv,
  menuRepos,
  nameProblem,
  newSessionArgv,
  newSessionCommand,
  openPlan,
  parseEntry,
  parsePid,
  registryDir,
  sessionName,
  shortId,
  stopArgv,
  trustedWindow,
  wtPath,
} from './switcher'
import { NEAR_CHANGES, WHOLE_FILE, baselinePath, diffArgv, fileKey, fitDiff, newFileArgv, sessionDiffArgv } from './diff'
import { parseSkill, sortSkills } from './skills'
import {
  EMPTY_LINK,
  PARTNER_TOOL,
  PARTNER_TOOL_ID,
  activityText,
  framed,
  linkFile,
  linkPrompt,
  pairWith,
  pairedId,
  parseLink,
  partnerOf,
  prune,
  senderName,
  unframed,
  unpair,
} from './link'
import { TITLE, band, changesPane, pane } from './view'
import { CACHE_DIRS, CACHE_FILES, CONTEXT_ROWS, ContextBlock, EMPTY_CONTEXT, cleanArgv, formatBytes } from './context'
import { IDLE, agentToast, finishToast } from './work'
import {
  labelOf,
  locate,
  normalizePath,
  parentOf,
  parseToplevel,
  pathKey,
  repoId,
  repoLabels,
  resolvePath,
  toplevelArgv,
  withRepo,
} from './repo'

/*
 * Observation only. Every hook hands the event on unchanged with `next(e)` and
 * returns what it resolved to; what the mod notes is taken after, inside a
 * try/catch, so nothing it does can change or fail a call. No `classic.*` hook
 * is registered, which keeps the mod out of the chain the repositories'
 * settings hooks run in. The actions are the pane's, each on a press alone:
 * the sessions menu, the link menu, a file's revert, and the context block's
 * compact and clean-cache buttons. The one answer the mod gives for itself is
 * its own partner tool's.
 */

// ── state ────────────────────────────────────────────────────

/*
 * The atoms the drawings read, kept by the host across reloads, and the
 * module's own state, which a reload starts over. Everything that takes `$`
 * stays in this file: the engine follows `$` into no import.
 */

const PLUGIN = 'engineering-workflow'
const PANE = 'engineering-workflow'
/** The pane a modified file's changes open in. */
const CHANGES_PANE = 'engineering-workflow-changes'
const COMMAND = 'workflow'

const tracker = atom({ plugin: 'engineering-workflow', key: 'tracker' } as const, initialTracker())
const repos = atom({ plugin: 'engineering-workflow', key: 'repos' } as const, {} as RepoRoots)
const git = atom({ plugin: 'engineering-workflow', key: 'git' } as const, {} as GitInfo)
const diff = atom({ plugin: 'engineering-workflow', key: 'diff' } as const, null as DiffView | null)
const baselines = atom({ plugin: 'engineering-workflow', key: 'baselines' } as const, {} as Baselines)
const reverted = atom({ plugin: 'engineering-workflow', key: 'reverted' } as const, [] as string[])
const skills = atom({ plugin: 'engineering-workflow', key: 'skills' } as const, [] as SkillAction[])
const skillsNote = atom({ plugin: 'engineering-workflow', key: 'skillsNote' } as const, null as string | null)
const work = atom({ plugin: 'engineering-workflow', key: 'work' } as const, IDLE)
const now = atom({ plugin: 'engineering-workflow', key: 'now' } as const, 0)
const context = atom({ plugin: 'engineering-workflow', key: 'context' } as const, EMPTY_CONTEXT)
const terminal = atom({ plugin: 'engineering-workflow', key: 'terminal' } as const, { isWindows: false, hasWt: false } as TerminalInfo)
const link = atom({ plugin: 'engineering-workflow', key: 'link' } as const, EMPTY_LINK)
const sessions = atom({ plugin: 'engineering-workflow', key: 'sessions' } as const, [] as SessionEntry[])
const menu = atom({ plugin: 'engineering-workflow', key: 'menu' } as const, { level: 'closed' } as PanelMenu)
const linkMenuOpen = atom({ plugin: 'engineering-workflow', key: 'linkMenuOpen' } as const, false)

const CLOSED: PanelMenu = { level: 'closed' }

/** Module state: a reload starts it over, the atoms above are kept by the host. */
const s = {
  /** The repositories known so far, mirrored in the `repos` atom. */
  roots: {} as RepoRoots,
  cwd: '',
  cwdRepo: null as Repo | null,
  sessionId: '',
  /** The shared session registry folder; empty without a temporary directory. */
  registry: '',
  /** The temporary directory, where the registry and the link file live. */
  temp: '',
  myWindow: null as string | null,
  /** The name the sessions menu gave this session; null for one opened by hand. */
  myName: null as string | null,
  /** This session's claude process, for another session's menu to close it. */
  myPid: null as number | null,
  background: false,
  isWindows: false,
  hasWt: false,
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'content' in value && Array.isArray(value.content)) {
    const parts = value.content
      .map((block: unknown) =>
        block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? block.text : '',
      )
      .filter(Boolean)
    return parts.length > 0 ? parts.join('\n') : null
  }
  return null
}

function field(value: unknown, name: string): string | undefined {
  if (value && typeof value === 'object' && name in value) {
    const found = (value as Record<string, unknown>)[name]
    return typeof found === 'string' ? found : undefined
  }
  return undefined
}

/** A failed command's first line of output, for the toast. */
function reason(ran: { exitCode: number; stdout: string; stderr: string }): string {
  const line = `${ran.stderr}\n${ran.stdout}`.split('\n').find(text => text.trim())
  return line ? line.trim().slice(0, 120) : `exit code ${ran.exitCode}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The folder beside the session registry where the mod keeps its files. */
function workDir(): string {
  return s.registry.replace(/\/sessions$/, '')
}

// ── git ──────────────────────────────────────────────────────

/*
 * The repositories, found with git and read with git, read-only:
 * `--no-optional-locks` keeps `git status` from taking the index lock a
 * concurrent git command of the session may need.
 */

const GIT_SETTLE_MS = 1_500
const GIT_TIMEOUT_MS = 5_000
/** How far up a path not yet created is walked to find a directory that exists. */
const MAX_DEPTH = 64

let isRefreshing = false
let settle: { cancel: () => void } | null = null
/** Each directory's toplevel, null outside Git: one git run per directory. */
const toplevels = new Map<string, string | null>()

/** The toplevel of a directory that exists; null outside Git or when git cannot run. */
async function toplevelOf($: EngineInterface, dir: string): Promise<string | null> {
  const key = pathKey(dir)
  if (toplevels.has(key)) return toplevels.get(key) ?? null
  let found: string | null = null
  try {
    const ran = await $.process.run(toplevelArgv(dir), { timeoutMs: GIT_TIMEOUT_MS })
    found = ran.exitCode === 0 ? parseToplevel(ran.stdout) : null
  } catch {
    found = null
  }
  toplevels.set(key, found)
  return found
}

/** Adds a repository by its root: kept in the `repos` atom, its Git read soon. */
async function addRoot($: EngineInterface, root: string): Promise<Repo> {
  const before = s.roots
  s.roots = withRepo(s.roots, root)
  if (s.roots !== before) {
    await update($, repos, () => s.roots)
    refreshSoon($)
  }
  return repoId(root)
}

/** The session's directory and its repository, found once at the session's start. */
async function setCwd($: EngineInterface, path: string): Promise<void> {
  s.cwd = normalizePath(path)
  // Known from before a reload: the atom keeps what git found then.
  s.roots = { ...(await read($, repos).catch(() => ({}))), ...s.roots }
  const root = await toplevelOf($, s.cwd)
  s.cwdRepo = root ? await addRoot($, root) : (locate(s.roots, s.cwd, s.cwd)?.repo ?? null)
  // The session's own repository is listed first.
  if (s.cwdRepo && Object.keys(s.roots)[0] !== s.cwdRepo) {
    const { [s.cwdRepo]: own, ...rest } = s.roots
    if (own) s.roots = { [s.cwdRepo]: own, ...rest }
    await update($, repos, () => s.roots)
  }
}

async function sessionCwd($: EngineInterface): Promise<string> {
  if (!s.cwd) await setCwd($, await $.session.cwd())
  return s.cwd
}

/**
 * Before a file is edited, the repository holding it joins the session: the
 * toplevel of its directory, or of the nearest one that exists for a file
 * in folders not yet created.
 */
async function ensureRepo($: EngineInterface, path: string): Promise<void> {
  try {
    const cwd = await sessionCwd($)
    const absolute = resolvePath(cwd, path)
    // Known already: no git run for a file of a known repository.
    if (locate(s.roots, cwd, absolute)) return
    // Up from the file's folder until git answers: a folder not created yet makes it fail too.
    const visited: string[] = []
    let dir = parentOf(absolute)
    let root: string | null = null
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const wasKnown = toplevels.has(pathKey(dir))
      root = await toplevelOf($, dir)
      if (root || wasKnown) break
      visited.push(pathKey(dir))
      const up = parentOf(dir)
      if (up === dir) break
      dir = up
    }
    // Every folder walked through answers as the one git answered for.
    for (const key of visited) toplevels.set(key, root)
    if (root) await addRoot($, root)
  } catch {
    // Observation only: a file of no known repository is not tracked.
  }
}

/** Branch and working-tree size of one repository. */
async function readGit($: EngineInterface, root: string): Promise<RepoGit> {
  const base = ['git', '--no-optional-locks', '-C', root]
  const init = { timeoutMs: GIT_TIMEOUT_MS }
  try {
    const branch = await $.process.run([...base, 'branch', '--show-current'], init)
    if (branch.exitCode !== 0) return { branch: null, dirty: null, error: 'not a git repository' }

    let name = branch.stdout.trim()
    if (!name) {
      const head = await $.process.run([...base, 'rev-parse', '--short', 'HEAD'], init)
      name = head.exitCode === 0 ? `detached@${head.stdout.trim()}` : 'detached'
    }

    const status = await $.process.run([...base, 'status', '--porcelain'], init)
    const dirty = status.exitCode === 0 ? status.stdout.split('\n').filter(line => line.trim()).length : null
    return { branch: name, dirty }
  } catch {
    return { branch: null, dirty: null, error: 'git unavailable' }
  }
}

async function refreshGit($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const known = Object.entries(s.roots)
    const read_ = await Promise.all(known.map(([, root]) => readGit($, root)))
    const info: GitInfo = {}
    known.forEach(([repo], index) => {
      info[repo] = read_[index] ?? null
    })
    // An unchanged read redraws nothing: a redraw under a click can swallow it.
    if (JSON.stringify(await read($, git)) !== JSON.stringify(info)) await update($, git, () => info)
  } catch {
    // A missed refresh is retried by the next poll.
  } finally {
    isRefreshing = false
  }
}

function refreshSoon($: EngineInterface): void {
  settle?.cancel()
  settle = $.clock.after(GIT_SETTLE_MS, () => void refreshGit($))
}

/** How the pane names every repository it shows: the known ones and those of the open sessions. */
async function labelsNow($: EngineInterface): Promise<Record<Repo, string>> {
  const roots = { ...(await read($, repos)), ...s.roots }
  return repoLabels(menuRepos(s.cwdRepo, roots, await read($, sessions)))
}

// ── sessions ─────────────────────────────────────────────────

/*
 * The shared session registry and the sessions menu's actions, each on a
 * press alone. Windows Terminal brings sessions up and starts new ones; where
 * it cannot be run, the menu shows the command that does it instead.
 */

let isSwitching = false
let switchLog: string[] = []

/** Whether this is Windows, and Windows Terminal's launcher is there to run. */
async function detectTerminal($: EngineInterface): Promise<void> {
  try {
    s.isWindows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
    const localAppData = await $.env.get('LOCALAPPDATA').catch(() => undefined)
    // Its App Execution Alias first, then the PATH: the two places runWt starts it from.
    const atAlias = Boolean(localAppData) && (await $.fs.exists(wtPath(localAppData)).catch(() => false))
    const onPath = async () => (await $.process.run(['where', 'wt.exe'], { timeoutMs: 5_000 }).catch(() => null))?.exitCode === 0
    s.hasWt = s.isWindows && (atAlias || (await onPath()))
  } catch {
    s.hasWt = false
  }
  await update($, terminal, () => ({ isWindows: s.isWindows, hasWt: s.hasWt })).catch(() => undefined)
}

/** Writes this session's registry entry; the poll keeps it fresh. */
async function writeEntry($: EngineInterface, isOpen: boolean): Promise<void> {
  if (!s.registry || !s.sessionId) return
  try {
    const entry: SessionEntry = {
      sessionId: s.sessionId,
      repo: s.cwdRepo,
      repoRoot: s.cwdRepo ? (s.roots[s.cwdRepo] ?? null) : null,
      cwd: s.cwd,
      name: s.myName,
      window: s.myWindow,
      pid: s.myPid,
      updatedAt: await $.clock.now(),
      isOpen,
      background: s.background,
    }
    await $.fs.write(entryFile(s.registry, s.sessionId), JSON.stringify(entry))
  } catch {
    // Without its entry this session is only harder to switch to.
  }
}

async function readEntries($: EngineInterface): Promise<SessionEntry[]> {
  if (!s.registry) return []
  try {
    const files = (await $.fs.list(s.registry)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    const entries = await Promise.all(
      files.map(f =>
        $.fs
          .read(`${s.registry}/${f.name}`)
          .then(parseEntry)
          .catch(() => null),
      ),
    )
    return entries.filter((e): e is SessionEntry => e !== null)
  } catch {
    return []
  }
}

/** Keeps this session's registry entry fresh, so other sessions can list it. */
async function heartbeat($: EngineInterface): Promise<void> {
  await writeEntry($, true)
}

/** Every open session, read again for the menus. */
async function refreshSessions($: EngineInterface): Promise<SessionEntry[]> {
  const at = await $.clock.now()
  const open = allOpen(await readEntries($), at)
  // Heartbeats alone redraw nothing: a redraw under a click can swallow it.
  const shape = (list: readonly SessionEntry[]) => JSON.stringify(list.map(({ updatedAt, ...rest }) => rest))
  if (shape(await read($, sessions)) !== shape(open)) await update($, sessions, () => open)
  return open
}

/** One menu open at a time: the one asked for, the others closed. */
async function openOnly($: EngineInterface, which: 'menu' | 'link' | null): Promise<void> {
  await update($, linkMenuOpen, () => which === 'link')
  if (which !== 'menu') await update($, menu, (): PanelMenu => CLOSED)
}

async function toggleMenu($: EngineInterface): Promise<void> {
  if ((await read($, menu)).level !== 'closed') return void (await update($, menu, (): PanelMenu => CLOSED))
  await openOnly($, 'menu')
  await update($, menu, (): PanelMenu => ({ level: 'main' }))
  await refreshSessions($)
}

async function toggleLink($: EngineInterface): Promise<void> {
  if (await read($, linkMenuOpen)) return void (await update($, linkMenuOpen, () => false))
  await openOnly($, 'link')
  await refreshSessions($)
}

/** A repository's root, as this session or another open one knows it. */
async function rootOf($: EngineInterface, repo: Repo): Promise<string | null> {
  return menuRepos(s.cwdRepo, { ...(await read($, repos)), ...s.roots }, await read($, sessions))[repo] ?? null
}

/** How the menu names a session in toasts: its repository, then its name. */
async function titleOf($: EngineInterface, entry: SessionEntry): Promise<string> {
  return entry.repo ? `${labelOf(await labelsNow($), entry.repo)} · ${entryLabel(entry)}` : entryLabel(entry)
}

/** Shows, in the menu, the command that does what was pressed, for a terminal by hand. */
async function showCommand($: EngineInterface, title: string, command: string, back: PanelMenu): Promise<void> {
  await update($, menu, (): PanelMenu => ({ level: 'command', title, command, back }))
}

/**
 * Runs Windows Terminal: by its full path first, then by name, from the
 * repository's directory. Rejects with every attempt's error when none starts.
 */
async function runWt(
  $: EngineInterface,
  argv: (wt: string) => string[],
  root: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const localAppData = await $.env.get('LOCALAPPDATA').catch(() => undefined)
  const failures: string[] = []
  for (const wt of [wtPath(localAppData), 'wt.exe']) {
    try {
      switchLog.push(`run: ${JSON.stringify(argv(wt))}`, `cwd: ${root}`)
      const ran = await $.process.run(argv(wt), { cwd: root, timeoutMs: 10_000 })
      switchLog.push(`exit: ${ran.exitCode}`, `stdout: ${ran.stdout}`, `stderr: ${ran.stderr}`)
      return ran
    } catch (error) {
      switchLog.push(`threw: ${message(error)}`)
      failures.push(`${wt}: ${message(error)}`)
    }
  }
  throw new Error(failures.join('\n'))
}

/** Keeps the full error of a failed switch where it can be read whole. */
async function noteFailure($: EngineInterface, target: string, text: string): Promise<void> {
  if (!s.registry) return
  const at = new Date(await $.clock.now()).toISOString()
  await $.fs.write(errorFile(s.registry), `${at}\nsession cwd: ${s.cwd}\ntarget: ${target}\n\n${text}\n`).catch(() => undefined)
}

/** Diagnostics: what the last switch saw and ran, for a switch that opens the wrong thing. */
async function keepSwitchLog($: EngineInterface): Promise<void> {
  if (s.registry) await $.fs.write(`${workDir()}/last-switch.txt`, `${switchLog.join('\n')}\n`).catch(() => undefined)
}

/** Marks a closed session's entry closed, so the menus drop it now; one still running writes itself open again. */
async function markClosed($: EngineInterface, entry: SessionEntry): Promise<void> {
  if (!s.registry) return
  await $.fs.write(entryFile(s.registry, entry.sessionId), JSON.stringify({ ...entry, isOpen: false })).catch(() => undefined)
  await refreshSessions($)
}

/** Closes a session listed in the menu, once confirmed: stopped in the background, or its claude ended. */
async function closeSession($: EngineInterface, entry: SessionEntry): Promise<void> {
  if (isSwitching) return
  const label = await titleOf($, entry)
  const plan = closePlan(entry, s.sessionId)
  if (plan.kind === 'here') return void $.ui.toast('This is the session you are in: end it with /exit.')
  if (plan.kind === 'unreachable') return void $.ui.toast(`${label}: its process is not known, close it in its own window.`)
  isSwitching = true
  switchLog = [`at: ${new Date(await $.clock.now()).toISOString()}`, `session: ${s.sessionId}`, `close: ${JSON.stringify(entry)}`, `plan: ${JSON.stringify(plan)}`]
  try {
    const claude = (await $.env.get('CLAUDE_CODE_EXECPATH').catch(() => undefined)) || 'claude'
    const argv = plan.kind === 'stop' ? stopArgv(claude, entry.sessionId) : killArgv(plan.pid, s.isWindows)
    switchLog.push(`run: ${JSON.stringify(argv)}`)
    const ran = await $.process.run(argv, { timeoutMs: 15_000 })
    switchLog.push(`exit: ${ran.exitCode}`, `stdout: ${ran.stdout}`, `stderr: ${ran.stderr}`)
    if (ran.exitCode !== 0) {
      $.ui.toast(`Could not close ${label}: ${reason(ran)}`)
      return
    }
    await markClosed($, entry)
    const repo = entry.repo
    await update($, menu, (): PanelMenu => (repo ? { level: 'list', repo } : { level: 'sessions' }))
    // Exits 0 with this line when nothing matched: gone already, or the pid is another program's now.
    $.ui.toast(/No tasks running/i.test(ran.stdout) ? `${label} was not running any more.` : `Closed ${label}.`)
  } catch (error) {
    $.ui.toast(`Could not close ${label}: ${message(error)}`)
  } finally {
    isSwitching = false
    await keepSwitchLog($)
  }
}

/** Brings up a session listed in the menu: its window, or its background session attached in one. */
async function openSession($: EngineInterface, entry: SessionEntry): Promise<void> {
  const repo = entry.repo
  if (isSwitching || !repo) return
  const label = await titleOf($, entry)
  const plan = openPlan(entry, s.sessionId)
  if (plan.kind === 'here') return void $.ui.toast('Already here.')
  if (plan.kind === 'unreachable') return void $.ui.toast(`${label} was opened by hand: switch to it in its own window.`)
  if (!s.hasWt) {
    if (plan.kind === 'focus') return void $.ui.toast(`${label} is in another window: switch to it there.`)
    return void (await showCommand($, `bring up ${label}`, attachCommand(entry), { level: 'list', repo }))
  }
  isSwitching = true
  switchLog = [
    `at: ${new Date(await $.clock.now()).toISOString()}`,
    `session: ${s.sessionId} cwd: ${s.cwd} repo: ${s.cwdRepo}`,
    `open: ${JSON.stringify(entry)}`,
    `plan: ${JSON.stringify(plan)}`,
  ]
  try {
    const root = entry.repoRoot ?? (await rootOf($, repo)) ?? entry.cwd
    const window = plan.window
    const tabLabel = labelOf(await labelsNow($), repo)
    const argv = plan.kind === 'focus' ? (wt: string) => focusArgv(window, wt) : (wt: string) => attachArgv(entry, root, window, wt, tabLabel)
    const ran = await runWt($, argv, root)
    if (ran.exitCode === 0) {
      await update($, menu, (): PanelMenu => CLOSED)
      $.ui.toast(plan.kind === 'focus' ? `Switched to ${label}.` : `Opening ${label}…`)
    } else {
      await noteFailure($, label, reason(ran))
      $.ui.toast(`Windows Terminal could not show ${label}: ${reason(ran)}`)
    }
  } catch (error) {
    await noteFailure($, label, message(error))
    $.ui.toast(`Could not open ${label}: ${message(error)}`)
  } finally {
    isSwitching = false
    await keepSwitchLog($)
  }
}

/** Starts a new session of `repo` named `typed`, in a window of its own; a name it cannot take starts nothing. */
async function createSession($: EngineInterface, repo: Repo, typed: string): Promise<void> {
  if (isSwitching) return
  const name = typed.trim()
  const open = await refreshSessions($)
  const problem = nameProblem(name, open.filter(e => e.repo === repo))
  if (problem) {
    await update($, menu, (): PanelMenu => ({ level: 'name', repo, name: typed }))
    $.ui.toast(`Not created: ${problem}.`)
    return
  }
  const root = await rootOf($, repo)
  const label = labelOf(await labelsNow($), repo)
  if (!root) return void $.ui.toast(`Not created: the root of ${label} is not known.`)
  if (!s.hasWt) {
    return void (await showCommand($, `new ${label} session`, newSessionCommand(root, name, s.isWindows), { level: 'name', repo, name }))
  }
  isSwitching = true
  switchLog = [`at: ${new Date(await $.clock.now()).toISOString()}`, `session: ${s.sessionId} cwd: ${s.cwd} repo: ${s.cwdRepo}`, `new: ${root} · ${name}`]
  try {
    const ran = await runWt($, wt => newSessionArgv(repo, root, name, wt, label), root)
    if (ran.exitCode === 0) {
      await update($, menu, (): PanelMenu => CLOSED)
      $.ui.toast(`Opening ${label} · ${name}…`)
    } else {
      await noteFailure($, `${label} · ${name}`, reason(ran))
      $.ui.toast(`Could not start Windows Terminal: ${reason(ran)}`)
    }
  } catch (error) {
    await noteFailure($, `${label} · ${name}`, message(error))
    $.ui.toast(`Could not start ${label} · ${name}: ${message(error)}`)
  } finally {
    isSwitching = false
    await keepSwitchLog($)
  }
}

// ── link ─────────────────────────────────────────────────────

/*
 * The session link: a pair in the shared link file, the partner tool the
 * model calls while the partner is open, and the system prompt section that
 * names it.
 */

let isLinking = false

/** The link file; one that cannot be read (missing, or mid-write by another session) holds no pairs until the next poll. */
async function readLinkFile($: EngineInterface): Promise<LinkFile> {
  return s.temp ? $.fs.read(linkFile(s.temp)).then(parseLink).catch(() => parseLink('')) : parseLink('')
}

/** The link file and the partner, read again into the `link` atom. */
async function readLink($: EngineInterface): Promise<LinkState> {
  const file = await readLinkFile($)
  const partner = partnerOf(await readEntries($), file.pairs, s.sessionId, await $.clock.now())
  const linked = partner !== null
  const old = await read($, link)
  if (old.linked === linked && JSON.stringify(old.partner) === JSON.stringify(partner)) return old
  return update($, link, current => ({ ...current, linked, partner }))
}

/** Writes the pairs, dropping those with no side open any more. */
async function writePairs($: EngineInterface, pairs: readonly LinkPair[]): Promise<void> {
  if (!s.temp) throw new Error('no temporary folder')
  const open = new Set((await refreshSessions($)).map(e => e.sessionId))
  await $.fs.write(linkFile(s.temp), JSON.stringify({ pairs: prune(pairs, open), updatedAt: await $.clock.now() }))
}

/** Links this session with another open one, breaking any link either had. */
async function linkWith($: EngineInterface, entry: SessionEntry): Promise<void> {
  if (isLinking || !s.sessionId || entry.sessionId === s.sessionId) return
  isLinking = true
  const label = await titleOf($, entry)
  try {
    const file = await readLinkFile($)
    if (pairedId(file.pairs, s.sessionId) === entry.sessionId) {
      $.ui.toast(`Already linked with ${label}.`)
      return
    }
    const { pairs, broken } = pairWith(file.pairs, s.sessionId, entry.sessionId)
    await writePairs($, pairs)
    await update($, linkMenuOpen, () => false)
    await readLink($)
    const closed = broken.length === 1 ? '; 1 earlier link closed' : broken.length > 1 ? `; ${broken.length} earlier links closed` : ''
    $.ui.toast(`Linked with ${label}${closed}.`)
  } catch (error) {
    $.ui.toast(`Could not change the link: ${message(error)}`)
  } finally {
    isLinking = false
  }
}

async function unlink($: EngineInterface): Promise<void> {
  if (isLinking) return
  isLinking = true
  try {
    await writePairs($, unpair((await readLinkFile($)).pairs, s.sessionId))
    await update($, linkMenuOpen, () => false)
    await readLink($)
    $.ui.toast('Unlinked.')
  } catch (error) {
    $.ui.toast(`Could not change the link: ${message(error)}`)
  } finally {
    isLinking = false
  }
}

/** The partner tool's answer: sent, or a denial telling Claude why not and not to retry. */
async function sendToPartner($: EngineInterface, raw: unknown): Promise<{ result: string } | { deny: string }> {
  const text = String(raw ?? '').trim()
  if (!text) return { deny: 'The message is empty.' }
  const state = await readLink($).catch(() => null)
  const partner = state?.partner
  if (!partner) {
    return { deny: 'Not linked with another session. Ask the user to pick one with the link button (⇄) in the Engineering Workflow panel; do not retry until then.' }
  }
  const labels = await labelsNow($)
  const where = partner.repo ? ` in ${labelOf(labels, partner.repo)}` : ''
  const label = `session ${partner.name ? `"${partner.name}"` : shortId(partner.sessionId)}${where}`
  if (!partner.isLive) {
    return { deny: `The linked ${label} is not open; the message was not sent. Tell the user if it matters; do not retry.` }
  }
  const ownLabel = s.cwdRepo ? labelOf(labels, s.cwdRepo) : 'no repository'
  try {
    const sent = await $.session.send({ to: { sessionId: partner.sessionId }, text: framed(senderName(s.myName, s.sessionId), ownLabel, text) })
    if (!sent.isDelivered) return { deny: `Not delivered: ${sent.reason}. Not sent.` }
  } catch (error) {
    return { deny: `Not delivered: ${message(error)}. Not sent.` }
  }
  try {
    const at = await $.clock.now()
    await update($, link, old => ({ ...old, sent: old.sent + 1 }))
    const shown = partner.repo ? labelOf(labels, partner.repo) : (partner.name ?? shortId(partner.sessionId))
    await update($, tracker, t => noted(t, at, 'link', activityText('to', shown, text)))
  } catch {
    // The message went; only the count is missing.
  }
  return { result: `Sent to the ${label}.` }
}

/** A framed message from the partner: counted, and a line of recent activity. */
async function noteReceived($: EngineInterface, text: string): Promise<void> {
  const got = unframed(text)
  if (!got) return
  const at = await $.clock.now()
  await update($, link, old => ({ ...old, received: old.received + 1 }))
  await update($, tracker, t => noted(t, at, 'link', activityText('from', got.label, got.text)))
}

/** The system prompt section while the partner is open; null otherwise. */
async function linkSection($: EngineInterface): Promise<string | null> {
  const state = await read($, link)
  if (!state.partner?.isLive) return null
  const labels = await labelsNow($)
  return linkPrompt(s.cwdRepo, state.partner, state.partner.repo ? labelOf(labels, state.partner.repo) : '')
}

// ── context ──────────────────────────────────────────────────

/*
 * The context window at the foot of the pane, and its two buttons: compact
 * the conversation, and empty Claude Code's local caches.
 */

/** The home directory: USERPROFILE on Windows, HOME elsewhere. */
async function homeDir($: EngineInterface): Promise<string | null> {
  const profile = await $.env.get('USERPROFILE').catch(() => undefined)
  const posixHome = await $.env.get('HOME').catch(() => undefined)
  const home = s.isWindows ? profile || posixHome : posixHome || profile
  return home ? home.replace(/\\/g, '/').replace(/\/$/, '') : null
}

/** Bytes in the local caches the clean button empties; null when unknown. */
async function measureLocal($: EngineInterface): Promise<number | null> {
  const home = await homeDir($)
  if (!home) return null
  const root = `${home}/.claude`
  let total = 0
  for (const dir of CACHE_DIRS) {
    const entries = await $.fs.list(`${root}/${dir}`).catch(() => [])
    for (const entry of entries) total += entry.size
  }
  for (const file of CACHE_FILES) {
    const stat = await $.fs.stat(`${root}/${file}`).catch(() => undefined)
    if (stat) total += stat.size
  }
  return total
}

/** The context window's fill, read again. */
async function refreshContext($: EngineInterface): Promise<void> {
  const usage = (await $.session.usage()).context
  const before = (await read($, context)).context
  if (before && before.percent === (usage.percent ?? null) && before.tokens === (usage.tokens ?? null) && before.window === usage.window) return
  await update($, context, old => ({
    ...old,
    context: { percent: usage.percent ?? null, tokens: usage.tokens ?? null, window: usage.window },
  }))
}

async function compactContext($: EngineInterface): Promise<void> {
  await update($, context, old => ({ ...old, isBusy: true, message: 'Compacting...' }))
  let message: string
  try {
    const { skip } = await $.session.compact()
    message = skip ? `Compact skipped: ${skip}` : 'Context compacted'
  } catch {
    message = 'Cannot compact while Claude is working'
  }
  await update($, context, old => ({ ...old, isBusy: false, message }))
  $.ui.toast(message)
  await refreshContext($).catch(() => undefined)
}

async function cleanCache($: EngineInterface): Promise<void> {
  await update($, context, old => ({ ...old, isBusy: true, message: 'Clearing cache...' }))
  const before = await measureLocal($).catch(() => null)
  let message: string
  try {
    const r = await $.process.run(cleanArgv(s.isWindows))
    message =
      r.exitCode === 0
        ? `Cache cleared: ${r.stdout.trim()} items, ${formatBytes(before)} freed`
        : `Error: ${r.stderr.trim().slice(0, 80)}`
  } catch {
    message = 'Could not clear the cache'
  }
  await update($, context, old => ({ ...old, isBusy: false, message }))
  $.ui.toast(message)
  await refreshContext($).catch(() => undefined)
}

// ── workflow ─────────────────────────────────────────────────

/*
 * What the pane shows of the work: the files each edit changed against how
 * the session found them, the session repository's skills, and Main Claude
 * and its subagents working.
 */

const agentTypes = new Map<string, string>()

/** A repository's file, by its root as git found it. */
function absoluteOf(repo: Repo, relative: string): string {
  return `${s.roots[repo] ?? repo}/${relative}`
}

/**
 * Before a file's first edit in the session: its repository joins the
 * session, and a copy of the file as the session found it (or a note that it
 * did not exist) is kept outside the repository. Reads only; any failure
 * leaves that file to be compared with the last commit.
 */
async function keepBaseline($: EngineInterface, input: Readonly<Record<string, unknown>>): Promise<void> {
  try {
    const path = [input.file_path, input.notebook_path].find((value): value is string => typeof value === 'string')
    if (!path) return
    await ensureRepo($, path)
    if (!s.registry || !s.sessionId) return
    const place = locate(s.roots, await sessionCwd($), path)
    if (!place || !place.relative) return
    const key = fileKey(place.repo, place.relative)
    if ((await read($, baselines))[key]) return

    const absolute = absoluteOf(place.repo, place.relative)
    const exists = await $.fs.exists(absolute)
    if (exists) {
      const text = await $.fs.read(absolute)
      await $.fs.write(baselinePath(workDir(), s.sessionId, safeRepo(place.repo), place.relative), text)
    }
    const state: Baselines[string] = exists ? 'saved' : 'absent'
    await update($, baselines, kept => (kept[key] ? kept : { ...kept, [key]: state }))
  } catch {
    // Observation only: the edit goes ahead regardless.
  }
}

/** A repository's id as one folder name, for the baselines kept under the work folder. */
function safeRepo(repo: Repo): string {
  return repo.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** Whether a file is back as the session found it: its copy again, or gone again when it was new. */
async function isBack($: EngineInterface, repo: Repo, relative: string, kept: 'saved' | 'absent'): Promise<boolean> {
  const absolute = absoluteOf(repo, relative)
  const exists = await $.fs.exists(absolute)
  if (kept === 'absent') return !exists
  if (!exists) return false
  const [current, then] = await Promise.all([
    $.fs.read(absolute),
    $.fs.read(baselinePath(workDir(), s.sessionId, safeRepo(repo), relative)),
  ])
  return current === then
}

/** Marks the edited files that are back as the session found them, so the pane leaves them out. */
async function checkReverted($: EngineInterface): Promise<void> {
  try {
    const touched = await read($, tracker)
    const kept = await read($, baselines)
    const back: string[] = []
    for (const [repo, files] of Object.entries(touched.files)) {
      for (const relative of files) {
        const key = fileKey(repo, relative)
        const state = kept[key]
        if (state && (await isBack($, repo, relative, state).catch(() => false))) back.push(key)
      }
    }
    if (back.join('\n') !== (await read($, reverted)).join('\n')) await update($, reverted, () => back)
    const opened = await read($, diff)
    if (opened && back.includes(fileKey(opened.repo, opened.file))) await update($, diff, () => null)
  } catch {
    // The next edit or poll looks again.
  }
}

/**
 * Reads a modified file's changes into the pane, read-only: against its copy
 * from before the session's first edit, so only this session's changes show;
 * for a file with no copy, against the last commit (the whole file when git
 * does not track it yet).
 */
async function loadDiff($: EngineInterface, repo: Repo, file: string): Promise<void> {
  const root = s.roots[repo] ?? repo
  const show = (view: DiffView) =>
    update($, diff, current => (current?.repo === repo && current.file === file ? view : current))
  const init = { cwd: root, timeoutMs: GIT_TIMEOUT_MS }
  const kept = (await read($, baselines))[fileKey(repo, file)]
  const saved = baselinePath(workDir(), s.sessionId, safeRepo(repo), file)

  /** The diff with `context` lines around each change. */
  const run = (context: number) =>
    kept === 'saved'
      ? $.process.run(sessionDiffArgv(saved, absoluteOf(repo, file), context), init)
      : kept === 'absent'
        ? $.process.run(newFileArgv(root, file), init)
        : $.process.run(diffArgv(root, file, context), init)

  try {
    // The whole file, its changes in place.
    let ran = await run(WHOLE_FILE)
    if (!kept && ran.exitCode === 0 && !ran.stdout.trim()) {
      // Nothing against HEAD: an untracked file, shown whole as added (exit 1 means it differs).
      ran = await $.process.run(newFileArgv(root, file), init)
    }
    if (ran.exitCode > 1) {
      await show({ repo, file, status: 'error', note: reason(ran) })
      return
    }

    let fitted = fitDiff(ran.stdout)
    let note: string | undefined
    if (fitted && fitted.omitted > 0) {
      // Too large for the pane whole: the changed parts, with lines around them.
      const near = await run(NEAR_CHANGES)
      const parts = near.exitCode <= 1 ? fitDiff(near.stdout) : null
      if (parts) {
        fitted = parts
        note = 'file too large to show whole: changed parts only'
      }
    }

    const nothing = kept ? 'no changes in this session' : 'no changes against the last commit'
    await show(
      fitted
        ? { repo, file, status: 'ready', source: fitted.source, omitted: fitted.omitted, note }
        : { repo, file, status: 'empty', note: /Binary files/.test(ran.stdout) ? 'binary file' : nothing },
    )
  } catch (error) {
    await show({ repo, file, status: 'error', note: message(error) })
  }
}

/** Opens a modified file's changes in their own pane, or shows another file's in it. */
async function openChanges($: EngineInterface, repo: Repo, file: string): Promise<void> {
  await update($, diff, () => ({ repo, file, status: 'loading' }))
  const label = labelOf(await labelsNow($), repo)
  await $.ui.open({ id: CHANGES_PANE, title: `changes · ${label}/${file}` }).catch(() => undefined)
  await loadDiff($, repo, file)
}

/** Reads the session repository's own skills (.claude/skills/<folder>/SKILL.md) for the menu. */
async function loadSkills($: EngineInterface): Promise<void> {
  const settle = async (list: SkillAction[], note: string | null) => {
    await update($, skills, () => list)
    await update($, skillsNote, () => note)
  }
  try {
    const repo = s.cwdRepo
    const root = repo ? s.roots[repo] : undefined
    if (!repo || !root) return void (await settle([], null))
    const label = labelOf(await labelsNow($), repo)
    const dir = `${root}/.claude/skills`
    if (!(await $.fs.exists(dir))) return void (await settle([], `no ${label}/.claude/skills folder`))
    // Every entry that is no plain file may hold a SKILL.md: a folder, or a link to one.
    const folders = (await $.fs.list(dir)).filter(entry => entry.kind !== 'file')
    const failures: string[] = []
    const found = await Promise.all(
      folders.map(folder =>
        $.fs
          .read(`${dir}/${folder.name}/SKILL.md`)
          .then(text => parseSkill(folder.name, text))
          .catch((error: unknown) => {
            failures.push(`${folder.name}: ${message(error)}`)
            return null
          }),
      ),
    )
    const list = sortSkills(found.filter((skill): skill is SkillAction => skill !== null))
    const note =
      list.length > 0
        ? null
        : folders.length === 0
          ? `no skills in ${label}/.claude/skills`
          : `could not read the skills: ${failures[0] ?? 'none can be invoked'}`
    await settle(list, note)
  } catch (error) {
    await settle([], `could not read the skills: ${message(error)}`).catch(() => undefined)
  }
}

/** A repository session still without its skills looks again: a first read may have come too early. */
async function retrySkills($: EngineInterface): Promise<void> {
  if (s.cwdRepo && (await read($, skills)).length === 0) await loadSkills($)
}

/**
 * Puts a slash command in the prompt for the person to run with Enter: the
 * menu's skill buttons start nothing by themselves.
 */
async function fillCommand($: EngineInterface, command: string): Promise<void> {
  try {
    const filled = await $.prompt.fill({ text: command, mode: 'replace' })
    if (filled.isFilled) $.ui.toast(`${command.trim()} is in the prompt: press Enter to run it.`)
    else if (filled.refusal === 'dialog') $.ui.toast('Close the open dialog, then press the button again.')
    else $.ui.toast(`Type ${command.trim()} in the prompt to run it.`)
  } catch (error) {
    $.ui.toast(`Could not fill the prompt: ${message(error)}`)
  }
}

let ticker: { cancel: () => void } | null = null

/** The elapsed times tick every second while Main or any subagent works. */
async function keepTicking($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  if (ticker) return
  ticker = $.clock.every(1_000, () => void $.clock.now().then(time => update($, now, () => time)))
}

/** Stops the clock once nobody works: Main idle and no subagent running. */
async function stopTickingIfIdle($: EngineInterface): Promise<void> {
  if ((await read($, work)).isWorking || (await read($, tracker)).agents.length > 0) return
  ticker?.cancel()
  ticker = null
}

/** Main Claude starts a turn: working, the elapsed time ticking every second. */
async function startWork($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, work, () => ({ ...IDLE, isWorking: true, startedAt: at }))
  await keepTicking($)
}

/** Main Claude's turn ended: how, and a toast unless the person stopped it. */
async function finishWork($: EngineInterface, outcome: WorkState['outcome'], durationMs: number): Promise<void> {
  const at = await $.clock.now()
  const ended: WorkState = { isWorking: false, startedAt: null, finishedAt: at, durationMs, outcome }
  await update($, work, () => ended)
  await stopTickingIfIdle($)
  const toast = finishToast(ended)
  if (toast) $.ui.toast(toast, { timeoutMs: 8_000 })
}

/** A subagent ended: recorded, and a toast once, whichever of its end and its Agent call comes first. */
async function finishAgent(
  $: EngineInterface,
  by: { key?: string; agentId?: string; type?: string },
  answer: string | null,
  at: number,
): Promise<void> {
  const before = await read($, tracker)
  const after = await update($, tracker, t => agentFinished(t, by, answer, at))
  await stopTickingIfIdle($)
  const ended = before.agents.find(run => !after.agents.some(a => a.key === run.key))
  if (!ended) return
  const verdict = isVerifier(ended.type) && answer !== null ? parseVerdict(answer) : null
  $.ui.toast(agentToast(ended.type, verdict), { timeoutMs: 6_000 })
}

function knowAgent(agentId: string, type: string): void {
  agentTypes.set(agentId, type)
}

/** The subagent type a loop runs, or null for the main loop. */
async function actorOf($: EngineInterface, agentId: string | undefined): Promise<string | null> {
  if (!agentId) return null
  const known = agentTypes.get(agentId) ?? (await read($, tracker)).agents.find(a => a.agentId === agentId)?.type
  if (known) return known
  const listed = (await $.agent.list()).find(agent => agent.id === agentId)?.type
  if (listed) agentTypes.set(agentId, listed)
  return listed ?? 'subagent'
}

// ── hooks ────────────────────────────────────────────────────

const GIT_POLL_MS = 20_000

const AGENT_TOOLS = new Set(['Agent', 'Task'])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    // Each step stands alone: the panel is optional and the session goes on regardless.
    try {
      s.sessionId = await $.session.id().catch(() => crypto.randomUUID())
      s.temp = (await $.env.get('TEMP').catch(() => undefined)) || (await $.env.get('TMPDIR').catch(() => undefined)) || (await $.env.get('TMP').catch(() => undefined)) || ''
      s.registry = s.temp ? registryDir(s.temp) : ''
      await detectTerminal($)
      await setCwd($, e.cwd)
      // The claude daemon sets CLAUDE_JOB_DIR in the background sessions it hosts.
      s.background = Boolean(await $.env.get('CLAUDE_JOB_DIR').catch(() => undefined))
      // WINDOW_ENV and NAME_ENV, spelled out: the engine lists the variables a module reads.
      s.myWindow = trustedWindow((await $.env.get('EW_WT_WINDOW').catch(() => undefined)) || null, s.cwd, s.cwdRepo, s.roots, s.background)
      s.myName = sessionName(await $.env.get('EW_SESSION_NAME').catch(() => undefined))
      s.myPid = parsePid(await $.env.get('CLAUDE_PID').catch(() => undefined))
    } catch {
      // Without them the pane still shows the workflow.
    }
    await $.command
      .register({
        name: COMMAND,
        description: `${TITLE} panel (args: sessions [repository], close, reset)`,
        argumentHint: '[sessions [repo]|close|reset]',
      })
      .catch(() => undefined)
    try {
      // Timers outlive this dispatch; the first read does not hold up the first prompt.
      $.clock.after(0, () => void refreshGit($).then(() => heartbeat($)).then(() => refreshSessions($)).then(() => loadSkills($)))
      // The poll also notices files put back by hand, outside Claude.
      $.clock.every(GIT_POLL_MS, () => void refreshGit($).then(() => heartbeat($)).then(() => refreshSessions($)).then(() => checkReverted($)).then(() => retrySkills($)).then(() => readLink($)).catch(() => undefined))
    } catch {
      // Without the poll, edits and git commands still refresh.
    }
    await refreshContext($).catch(() => undefined)
    await readLink($).catch(() => undefined)
    await $.tool.register(PARTNER_TOOL).catch(() => undefined)
    if (e.isInteractive) void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    return ran
  })

  on('session.compact', async ($, e, next) => {
    const ran = await next(e)
    await refreshContext($).catch(() => undefined)
    return ran
  })

  on('tool.call', { tool: PARTNER_TOOL_ID }, async ($, e) => sendToPartner($, (e as unknown as { text?: unknown }).text))

  on('session.receive', async ($, e, next) => {
    const ran = await next(e)
    try {
      const origin = e.origin as { kind: string; plugin?: string }
      if (origin.kind === 'peer' && origin.plugin === PLUGIN && !e.agentId) await noteReceived($, e.text)
    } catch {
      // Observation only.
    }
    return ran
  })

  on('prompt.compose', async ($, e, next) => {
    const ran = await next(e)
    try {
      const text = await linkSection($)
      if (!text) return ran
      return { sections: [...ran.sections, { id: `${PLUGIN}:link`, text, scope: 'session' as const }] }
    } catch {
      return ran
    }
  })

  on('session.end', async ($, e, next) => {
    const ran = await next(e)
    try {
      if (e.reason === 'clear') {
        // A new conversation: its files start from how they are now.
        await update($, tracker, () => initialTracker())
        await update($, baselines, () => ({}))
        await update($, reverted, () => [])
        await update($, diff, () => null)
      } else {
        await writeEntry($, false)
      }
    } catch {
      // Nothing to undo.
    }
    return ran
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = verb.toLowerCase()
    if (arg === 'sessions') {
      // The sessions menu, opened on a repository's list when one is named.
      const wanted = rest.join(' ').trim().toLowerCase()
      await openOnly($, 'menu')
      const open = await refreshSessions($)
      const labels = repoLabels(menuRepos(s.cwdRepo, s.roots, open))
      const repo = wanted ? Object.keys(labels).find(id => labelOf(labels, id).toLowerCase() === wanted || id === wanted) : undefined
      await update($, menu, (): PanelMenu => (repo ? { level: 'list', repo } : { level: 'sessions' }))
      await $.ui.open({ id: PANE, title: TITLE })
      if (wanted && !repo) return { text: `${TITLE}: no repository named ${wanted}; the sessions menu lists those known.` }
      return { text: `${TITLE}: the sessions are in the panel's sessions menu.` }
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: `${TITLE} panel closed.` }
    }
    if (arg === 'reset') {
      await update($, tracker, t => ({
        ...initialTracker(),
        files: t.files,
        agents: t.agents,
        turnId: t.turnId,
        cycle: t.cycle + 1,
      }))
      return { text: 'Workflow cycle reset (session files kept).' }
    }
    void refreshGit($)
    void loadSkills($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: `${TITLE} panel opened.` }
  })

  on('turn.start', async ($, e, next) => {
    const ran = await next(e)
    try {
      await update($, tracker, t => turnStarted(t, e.turnId))
      await startWork($)
    } catch {
      // Observation only.
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    try {
      const at = await $.clock.now()
      if (e.agentId) {
        const agentId = e.agentId
        const type = (await actorOf($, agentId)) ?? undefined
        await finishAgent($, { agentId, type }, e.answer, at)
      } else {
        await update($, tracker, t => turnEnded(t))
        await finishWork($, e.reason, e.durationMs)
        await refreshContext($)
      }
    } catch {
      // Observation only.
    }
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    try {
      const at = await $.clock.now()
      const run = { key: e.tool_use_id, type: e.subagentType, description: e.description, isBackground: e.background }
      await update($, tracker, t => agentStarted(t, run, at))
      await keepTicking($)
    } catch {
      // Observation only.
    }
    const ran = await next(e)
    try {
      if (ran.deny !== undefined) {
        const at = await $.clock.now()
        await update($, tracker, t => agentFinished(t, { key: e.tool_use_id }, null, at))
        await stopTickingIfIdle($)
      } else if (ran.agentId) {
        const agentId = ran.agentId
        knowAgent(agentId, e.subagentType)
        await update($, tracker, t => agentIdKnown(t, e.tool_use_id, agentId))
      }
    } catch {
      // Observation only.
    }
    return ran
  })

  on('tool.call', async ($, e, next) => {
    // Before a file's first edit: its repository found, and a copy of it as the session found it. Only read, never blocking.
    if (EDIT_TOOLS.has(String(e.tool))) await keepBaseline($, e as unknown as Readonly<Record<string, unknown>>)
    const ran = await next(e)
    try {
      if (ran.deny !== undefined) return ran
      const tool = String(e.tool)
      const at = await $.clock.now()

      if (AGENT_TOOLS.has(tool)) {
        // A foreground agent's call returns with its final answer; a background one returns at launch.
        const answer = textOf(ran.result)
        const key = e.tool_use_id
        if (answer !== null && key && field(ran.result, 'agentType') !== undefined) {
          const agentId = field(ran.result, 'agentId')
          await finishAgent($, { key, agentId }, answer, at)
        }
        return ran
      }

      const input = e as unknown as Readonly<Record<string, unknown>>
      // Stopped by the person: Bash says so, the dispatch was abandoned, or the exit code is Ctrl+C's.
      const isInterrupted =
        (ran.result as { interrupted?: unknown } | undefined)?.interrupted === true ||
        next.signal.aborted ||
        isInterruptedRun(ran.text ?? '')
      const signal = classifyTool(tool, input, ran.isError !== true, s.roots, await sessionCwd($), isInterrupted)
      if (!signal) return ran
      const actor = await actorOf($, e.agentId)
      await update($, tracker, t => applyTool(t, signal, actor, at))
      if (signal.edits.length > 0 || signal.touchesGit) refreshSoon($)
      if (signal.edits.length > 0) await checkReverted($)
      // An open file edited again shows its new changes.
      const opened = await read($, diff)
      if (opened && signal.edits.some(edit => edit.repo === opened.repo && edit.relative === opened.file)) {
        void loadDiff($, opened.repo, opened.file)
      }
    } catch {
      // Observation only: the call's own result stands.
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return band(
      { Box, Text },
      {
        tracker: await read($, tracker),
        git: await read($, git),
        cwdRepo: s.cwdRepo,
        roots: await read($, repos),
        labels: await labelsNow($),
        work: await read($, work),
        now: await read($, now),
      },
    )
  })

  on('ui.render', { component: 'Pane', requestId: CHANGES_PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    return changesPane({ Box, Text, Button, Code }, await read($, diff), await labelsNow($), () => void $.ui.close({ id: CHANGES_PANE }).catch(() => undefined))
  })

  // However the changes pane closes (its button, the person's mark or key), no file stays open.
  on('ui.close', { id: CHANGES_PANE }, async ($, e, next) => {
    const ran = await next(e)
    await update($, diff, () => null).catch(() => undefined)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code } = elements
    const rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const roots = await read($, repos)
    const labels = await labelsNow($)
    const view = {
      tracker: await read($, tracker),
      git: await read($, git),
      cwdRepo: s.cwdRepo,
      roots,
      labels,
      work: await read($, work),
      now: await read($, now),
    }
    // Mobile draws no field: there the menu says where a session can be created.
    const kit = { Box, Text, Button, Code, Input: 'Input' in elements ? elements.Input : undefined }
    const open = await read($, sessions)
    // The context block keeps its rows at the foot; the rest fits above it, clipped rather than pushing it down.
    const main = pane(
      kit,
      view,
      await read($, diff),
      await read($, reverted),
      // Each running subagent is a row of the Agents list: recent activity gives it up.
      Math.max(1, rows - CONTEXT_ROWS - Math.max(0, view.tracker.agents.length - 1)),
      {
        menu: await read($, menu),
        sessions: open,
        selfId: s.sessionId,
        repo: s.cwdRepo,
        repos: menuRepos(s.cwdRepo, roots, open),
        labels,
        terminal: await read($, terminal),
        skills: await read($, skills),
        skillsNote: await read($, skillsNote),
        onToggle: () => void toggleMenu($),
        onLevel: level => void update($, menu, (): PanelMenu => level),
        onOpen: entry => void openSession($, entry),
        onName: (repo, name) => void update($, menu, (): PanelMenu => ({ level: 'name', repo, name })),
        onCreate: (repo, name) => void createSession($, repo, name),
        onClose: entry => void closeSession($, entry),
        onSkill: command => void openOnly($, null).then(() => fillCommand($, command)),
      },
      (repo, file) => void openChanges($, repo, file),
      {
        state: await read($, link),
        candidates: open.filter(entry => entry.sessionId !== s.sessionId),
        labels,
        isOpen: await read($, linkMenuOpen),
        onToggle: () => void toggleLink($),
        onPick: entry => void linkWith($, entry),
        onUnlink: () => void unlink($),
      },
    )
    const block = ContextBlock(
      kit,
      await read($, context),
      e.props.bodyColumns,
      () => void compactContext($),
      () => void cleanCache($),
    )
    return (
      <Box flexDirection="column" height={rows}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
          {main}
        </Box>
        {block}
      </Box>
    )
  })
}
