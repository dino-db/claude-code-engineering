import type { Repo, RepoRoots, SessionEntry } from '../types'
import { baseName } from './repo'

/*
 * The open sessions of every repository, and bringing them up. Every session
 * with the mod keeps a small file in a shared registry folder. With Windows
 * Terminal, a session the sessions menu creates runs in a window named after
 * its repository and its name, which `wt -w <window> focus-tab` brings back;
 * one in the background is shown with `claude attach`; a session opened by
 * hand has no window to be found by. Without Windows Terminal, the menu gives
 * the command to run by hand instead. Pure: the hooks module runs these.
 */

/** A session not heard from for this long is taken as gone. */
export const STALE_MS = 45_000

/** Set in the sessions the menu opens: the named window they run in. */
export const WINDOW_ENV = 'EW_WT_WINDOW'

/** Set in the sessions the menu creates: the name it gave them. */
export const NAME_ENV = 'EW_SESSION_NAME'

export const NAME_MAX = 40

/** No spaces or shell characters: the name goes into the `cmd /k` line unquoted. */
const NAME_CHARS = /^[A-Za-z0-9._-]+$/

/** The window of a repository's sessions without a name. */
export function repoWindow(repo: Repo): string {
  return `ew-${slug(baseName(repo)) || 'repo'}`
}

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The window a named session runs in. */
export function sessionWindow(repo: Repo, name: string): string {
  return `${repoWindow(repo)}-${slug(name)}`
}

/**
 * Why a name cannot be given to a new session of a repository, or null when it
 * can. `open` is that repository's open sessions: two names with one slug
 * would share a window.
 */
export function nameProblem(name: string, open: readonly SessionEntry[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'type a name'
  if (trimmed.length > NAME_MAX) return `at most ${NAME_MAX} characters`
  if (!NAME_CHARS.test(trimmed)) return 'letters, digits and - _ . only, no spaces'
  if (!slug(trimmed)) return 'needs a letter or a digit'
  const clash = open.find(e => e.name !== null && slug(e.name) === slug(trimmed))
  return clash ? `${clash.name} is already open` : null
}

/** The name the menu gave this session, from its variable; null when there is none it could have given. */
export function sessionName(env: string | null | undefined): string | null {
  const name = (env ?? '').trim()
  return name && nameProblem(name, []) === null ? name : null
}

function samePath(a: string, b: string): boolean {
  const plain = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return plain(a) === plain(b)
}

/**
 * The named window this session runs in, as far as it can tell. The variable
 * is inherited by everything started from that window's shell, so a claude
 * started by hand elsewhere claims a window it is not in, and focusing that
 * name opens an empty window: the name counts only for a session started
 * where the menu starts it, its repository's root. A background session
 * runs in the claude daemon, which inherited the name from the session that
 * started it: it is in no window at all.
 */
export function trustedWindow(
  env: string | null,
  cwd: string,
  cwdRepo: Repo | null,
  roots: RepoRoots,
  background = false,
): string | null {
  if (background || !env || !cwdRepo) return null
  const own = repoWindow(cwdRepo)
  if (env !== own && !env.startsWith(`${own}-`)) return null
  const root = roots[cwdRepo]
  return root && samePath(cwd, root) ? env : null
}

export function registryDir(temp: string): string {
  return `${temp.replace(/\\/g, '/').replace(/\/$/, '')}/engineering-workflow/sessions`
}

export function entryFile(dir: string, sessionId: string): string {
  return `${dir}/${sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`
}

export function parseEntry(text: string): SessionEntry | null {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object') return null
    const entry = value as Partial<SessionEntry>
    if (typeof entry.sessionId !== 'string' || typeof entry.updatedAt !== 'number') return null
    return {
      sessionId: entry.sessionId,
      repo: typeof entry.repo === 'string' && entry.repo ? entry.repo : null,
      repoRoot: typeof entry.repoRoot === 'string' && entry.repoRoot ? entry.repoRoot : null,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      name: typeof entry.name === 'string' && entry.name ? entry.name : null,
      window: typeof entry.window === 'string' && entry.window ? entry.window : null,
      pid: typeof entry.pid === 'number' && Number.isInteger(entry.pid) && entry.pid > 0 ? entry.pid : null,
      updatedAt: entry.updatedAt,
      isOpen: entry.isOpen !== false,
      background: entry.background === true,
    }
  } catch {
    return null
  }
}

/** Open, and heard from recently enough. */
export function isLive(entry: SessionEntry, now: number): boolean {
  return entry.isOpen && now - entry.updatedAt < STALE_MS
}

/** The repository's sessions still open, this one included, the most recently heard first. */
export function openSessions(entries: readonly SessionEntry[], repo: Repo | null, now: number): SessionEntry[] {
  return allOpen(entries, now).filter(e => e.repo === repo)
}

/** Every session still open, of any repository or none, the most recently heard first. */
export function allOpen(entries: readonly SessionEntry[], now: number): SessionEntry[] {
  return entries.filter(e => isLive(e, now)).sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * The repositories the sessions menu lists, by id with their roots: this
 * session's first, then those of the other open sessions, then those this
 * session edited in.
 */
export function menuRepos(own: Repo | null, roots: RepoRoots, open: readonly SessionEntry[]): RepoRoots {
  const listed: RepoRoots = {}
  if (own && roots[own]) listed[own] = roots[own]
  for (const entry of open) {
    if (entry.repo && !(entry.repo in listed)) listed[entry.repo] = entry.repoRoot ?? roots[entry.repo] ?? entry.repo
  }
  for (const [repo, root] of Object.entries(roots)) if (!(repo in listed)) listed[repo] = root
  return listed
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

/** How the menus name a session. */
export function entryLabel(entry: SessionEntry): string {
  return entry.name ?? `unnamed · ${shortId(entry.sessionId)}`
}

/** This session, one in a named window, one in the background, or one opened by hand. */
export type SessionLook = 'self' | 'window' | 'background' | 'hand'

export function sessionLook(entry: SessionEntry, selfId: string): SessionLook {
  if (entry.sessionId === selfId) return 'self'
  if (entry.window) return 'window'
  if (entry.background) return 'background'
  return 'hand'
}

export type OpenPlan =
  | { kind: 'here' }
  | { kind: 'focus'; window: string }
  | { kind: 'attach'; window: string }
  | { kind: 'unreachable' }

/** How a session listed in the menu is brought up. */
export function openPlan(entry: SessionEntry, selfId: string): OpenPlan {
  const look = sessionLook(entry, selfId)
  if (look === 'self') return { kind: 'here' }
  if (look === 'window' && entry.window) return { kind: 'focus', window: entry.window }
  if (look === 'background' && entry.repo) {
    return { kind: 'attach', window: entry.name ? sessionWindow(entry.repo, entry.name) : repoWindow(entry.repo) }
  }
  return { kind: 'unreachable' }
}

/** The session's claude process id, from CLAUDE_PID; null when it is not a whole positive number. */
export function parsePid(env: string | null | undefined): number | null {
  const text = (env ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const pid = Number(text)
  return pid > 0 ? pid : null
}

export type ClosePlan = { kind: 'here' } | { kind: 'stop' } | { kind: 'kill'; pid: number } | { kind: 'unreachable' }

/**
 * How a session listed in the menu is closed: one in the background is
 * stopped in the claude daemon; any other with a known claude process has
 * that process ended (its tab stays, at cmd's prompt). Never this one.
 */
export function closePlan(entry: SessionEntry, selfId: string): ClosePlan {
  if (entry.sessionId === selfId) return { kind: 'here' }
  if (entry.background) return { kind: 'stop' }
  return entry.pid ? { kind: 'kill', pid: entry.pid } : { kind: 'unreachable' }
}

/** Stops a background session; `claude stop` takes the short id the daemon lists. */
export function stopArgv(claude: string, sessionId: string): string[] {
  return [claude, 'stop', shortId(sessionId)]
}

/**
 * Ends a session's claude process and its children, only while that pid is
 * claude's: taskkill's filter on Windows, `ps` checked first elsewhere.
 */
export function killArgv(pid: number, isWindows = true): string[] {
  if (isWindows) return ['taskkill', '/PID', String(pid), '/FI', 'IMAGENAME eq claude.exe', '/T', '/F']
  const id = String(Math.trunc(pid))
  return ['sh', '-c', `ps -p ${id} -o comm= | grep -qi claude && kill ${id} || echo "No tasks running"`]
}

/**
 * Windows Terminal's launcher by its full path, the App Execution Alias under
 * %LOCALAPPDATA%: no lookup on the PATH of whatever directory the session runs in.
 * Without LOCALAPPDATA, the bare name.
 */
export function wtPath(localAppData: string | undefined): string {
  if (!localAppData) return 'wt.exe'
  return `${localAppData.replace(/\//g, '\\').replace(/\\$/, '')}\\Microsoft\\WindowsApps\\wt.exe`
}

/** A new tab in the named window, running `line` in cmd from the repository's root. */
function tabArgv(wt: string, window: string, title: string, root: string, line: string): string[] {
  return [wt, '-w', window, 'new-tab', '--title', title, '--suppressApplicationTitle', '-d', root.replace(/\//g, '\\'), 'cmd', '/k', line]
}

/** A new named session: claude in the repository, in a window of its own. */
export function newSessionArgv(repo: Repo, root: string, name: string, wt = 'wt.exe', label = baseName(root)): string[] {
  const window = sessionWindow(repo, name)
  return tabArgv(wt, window, `${label} · ${name}`, root, `set ${WINDOW_ENV}=${window}&& set ${NAME_ENV}=${name}&& claude --name ${name}`)
}

/** A background session shown in a new tab of its window; `claude attach` takes the short id the daemon lists. */
export function attachArgv(entry: SessionEntry, root: string, window: string, wt = 'wt.exe', label = baseName(root)): string[] {
  return tabArgv(wt, window, `${label} · ${entryLabel(entry)}`, root, attachCommand(entry))
}

/** What brings a background session up in a terminal, typed by hand. */
export function attachCommand(entry: SessionEntry): string {
  return `claude attach ${shortId(entry.sessionId)}`
}

/** What starts a new named session in a repository, typed by hand in a terminal. */
export function newSessionCommand(root: string, name: string, isWindows: boolean): string {
  if (isWindows) return `cd /d "${root.replace(/\//g, '\\')}" && claude --name ${name}`
  return `cd ${quoted(root)} && claude --name ${name}`
}

/** One POSIX shell word: single-quoted, each quote in it closed, escaped and reopened. */
function quoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Brings the named window forward, on its first tab. */
export function focusArgv(window: string, wt = 'wt.exe'): string[] {
  return [wt, '-w', window, 'focus-tab', '-t', '0']
}

/** Where the last failed switch leaves its full error, beside the registry. */
export function errorFile(registry: string): string {
  return `${registry.replace(/\/sessions$/, '')}/last-switch-error.txt`
}
