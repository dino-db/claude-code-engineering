import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SessionEntry } from '../types'
import { BETA, toplevel } from './git-mock'

export const NOW = 1_000_000
export const REGISTRY = 'C:/T/engineering-workflow/sessions'
export const LINK = 'C:/T/engineering-workflow/link.json'

/** The id the test engine gives the session under test. */
export const ME = 'me'

export function entry(fields: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: 'partner',
    repo: BETA,
    repoRoot: 'C:/repos/beta',
    cwd: '',
    name: 'api',
    window: 'ew-beta-api',
    pid: null,
    updatedAt: NOW,
    isOpen: true,
    ...fields,
  }
}

/** A link file pairing this session with `other`. */
export function paired(other = 'partner'): string {
  return JSON.stringify({ pairs: [{ a: ME, b: other }], updatedAt: NOW })
}

function slash(path: string): string {
  return path.replace(/\\/g, '/')
}

export type Seen = {
  /** Windows Terminal runs. */
  ran: string[][]
  /** Runs that close a session: `claude stop` and `taskkill`. */
  closes: string[][]
  sends: { to: string; text: string }[]
  toasts: string[]
}

export type Host = {
  env?: Record<string, string>
  /** A launcher the host cannot start: its process.run is refused. */
  cannotStart?: (launcher: string) => boolean
  /** What a close command prints, as taskkill does when its filter matched nothing. */
  closeStdout?: string
  /** Windows Terminal is not installed: not at its alias, not on the PATH. */
  noWt?: boolean
}

/** An engine with an in-memory TEMP folder; records Windows Terminal runs, session sends and toasts. */
export function engine(
  on: On,
  files: Record<string, string>,
  deliver?: (to: string, text: string) => { isDelivered: true } | { isDelivered: false; reason: string },
  host: Host = {},
): { clock: MockClock; seen: Seen } {
  const clock = mock.clock(on, { now: NOW })
  const seen: Seen = { ran: [], closes: [], sends: [], toasts: [] }
  // Windows, unless a test says otherwise with `OS: ''`.
  mock.env(on, { TEMP: 'C:\\T', OS: 'Windows_NT', ...host.env })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: ME }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('fs.write', ($, e) => {
    files[slash(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.read', ($, e) => (slash(e.path) in files ? { value: files[slash(e.path)] ?? '' } : { deny: 'no such file' }))
  on('fs.list', ($, e) =>
    slash(e.path) === REGISTRY
      ? {
          value: Object.keys(files)
            .filter(path => path.startsWith(`${REGISTRY}/`))
            .map(path => ({ name: path.slice(REGISTRY.length + 1), kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false })),
        }
      : { value: [] },
  )
  on('process.run', ($, e) => {
    const top = toplevel(e.argv)
    if (top) return { value: top }
    const launcher = e.argv[0] ?? ''
    if (launcher === 'where') {
      return { value: { exitCode: host.noWt ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (launcher.endsWith('wt.exe')) {
      seen.ran.push([...e.argv])
      if (host.cannotStart?.(launcher)) return { deny: `${launcher} failed to start` }
    }
    const isClose = launcher === 'taskkill' || e.argv[1] === 'stop' || (launcher === 'sh' && /kill/.test(e.argv[2] ?? ''))
    if (isClose) seen.closes.push([...e.argv])
    const stdout = isClose ? (host.closeStdout ?? '') : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', ($, e) => {
    seen.sends.push({ to: String(e.to), text: e.text })
    return deliver ? deliver(String(e.to), e.text) : { isDelivered: true }
  })
  return { clock, seen }
}

export const PANE = {
  plugin: 'engineering-workflow',
  component: 'Pane',
  requestId: 'engineering-workflow',
  props: {
    title: 'Engineering Workflow',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

export async function startIn($: Engine, clock: MockClock, cwd = 'C:\\repos\\alpha'): Promise<void> {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: false })
  await clock.advance(0)
}
