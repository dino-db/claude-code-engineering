import type { Tracker, WorkState } from '../types'

/*
 * Main Claude working and finishing, for the pane, the band and the toasts.
 * Pure: the hooks module keeps the state and the clock.
 */

export const IDLE: WorkState = { isWorking: false, startedAt: null, finishedAt: null, durationMs: null, outcome: null }

/** `m:ss`, or `h:mm:ss` past the hour. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** The local time of day, `HH:MM`. */
export function clockTime(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export type WorkLine = { mark: string; text: string; color?: string }

/** What the pane and the band show: yellow while working, green when it answered, red on an error. */
export function workLine(work: WorkState, now: number): WorkLine | null {
  if (work.isWorking && work.startedAt !== null) {
    return { mark: '●', text: `working · ${duration(now - work.startedAt)}`, color: 'yellow' }
  }
  if (work.finishedAt === null || work.durationMs === null) return null
  const when = `in ${duration(work.durationMs)} (at ${clockTime(work.finishedAt)})`
  if (work.outcome === 'aborted') return { mark: '■', text: `stopped by you ${when}` }
  if (work.outcome === 'error' || work.outcome === 'refusal') {
    return { mark: '✗', text: `stopped on ${work.outcome === 'error' ? 'an error' : 'a refusal'} ${when}`, color: 'red' }
  }
  return { mark: '✓', text: `finished ${when}`, color: 'green' }
}

export type AgentRow = { name: string; line: WorkLine; detail?: string }

/**
 * The pane's Agents list: Main with its turn's status, then each subagent
 * still running with its own time; a subagent leaves the list as it ends.
 */
export function agentRows(t: Tracker, work: WorkState, now: number): AgentRow[] {
  const main: AgentRow = { name: 'Main', line: workLine(work, now) ?? { mark: '·', text: 'idle' } }
  return [
    main,
    ...t.agents.map(run => ({
      name: run.type,
      line: {
        mark: '●',
        text: run.startedAt === undefined ? 'working' : `working · ${duration(now - run.startedAt)}`,
        color: 'yellow',
      },
      detail: run.isBackground ? `${run.description} (background)` : run.description,
    })),
  ]
}

/** The toast at a turn's end; none when the person interrupted it themselves. */
export function finishToast(work: WorkState): string | null {
  if (work.durationMs === null) return null
  const took = duration(work.durationMs)
  if (work.outcome === 'aborted') return null
  if (work.outcome === 'error') return `✗ Claude stopped on an error after ${took}`
  if (work.outcome === 'refusal') return `✗ Claude stopped on a refusal after ${took}`
  return `✓ Claude finished in ${took}`
}

/** The toast when a subagent ends, with the verifier's verdict when it has one. */
export function agentToast(type: string, verdict: string | null): string {
  return verdict ? `✓ ${type} finished: ${verdict}` : `✓ ${type} finished`
}
