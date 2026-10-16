import type { Activity, AgentRun, Phase, Repo, Tracker, Verdict } from '../types'
import { PHASES, isVerifier, parseVerdict, phaseOfAgent } from './classify'
import { labelOf } from './repo'
import type { ToolSignal } from './classify'

const ACTIVITY_LIMIT = 40

export const MAIN = 'Main Claude'

export function initialTracker(): Tracker {
  return {
    seq: 0,
    cycle: 1,
    phase: null,
    reached: [],
    phaseSource: null,
    phaseTurn: null,
    turnId: null,
    cycleRepos: [],
    cycleEdits: 0,
    cycleFiles: {},
    lastEditSeq: 0,
    files: {},
    validation: null,
    verifier: null,
    agents: [],
    activity: [],
  }
}

/** The cycle's files; a tracker kept from before they were recorded has none. */
export function cycleFilesOf(t: Tracker): Tracker['cycleFiles'] {
  return t.cycleFiles ?? {}
}

function rank(phase: Phase | null): number {
  return phase === null ? -1 : PHASES.indexOf(phase)
}

function log(t: Tracker, at: number, actor: string, text: string): Activity[] {
  return [...t.activity, { at, actor, text }].slice(-ACTIVITY_LIMIT)
}

/** A line of recent activity that is no tool call: the session link's messages. */
export function noted(t: Tracker, at: number, actor: string, text: string): Tracker {
  return { ...t, activity: log(t, at, actor, text) }
}

function withRepos(current: readonly Repo[], added: readonly Repo[]): Repo[] {
  const fresh = added.filter((repo, index) => !current.includes(repo) && added.indexOf(repo) === index)
  return fresh.length > 0 ? [...current, ...fresh] : [...current]
}

/** The files by repository with `relative` added under `repo`, once. */
function withFile(files: Readonly<Record<Repo, string[]>>, repo: Repo, relative: string): Record<Repo, string[]> {
  const listed = files[repo] ?? []
  return listed.includes(relative) ? { ...files } : { ...files, [repo]: [...listed, relative] }
}

/** A new Explore or Plan after Verify starts the next cycle; session files are kept. */
function nextCycle(t: Tracker): Tracker {
  return {
    ...t,
    cycle: t.cycle + 1,
    phase: null,
    reached: [],
    phaseSource: null,
    cycleRepos: [],
    cycleEdits: 0,
    cycleFiles: {},
    lastEditSeq: 0,
    validation: null,
    verifier: null,
  }
}

function enter(t: Tracker, phase: Phase, source: 'agent' | 'inferred'): Tracker {
  if (t.phase === phase && t.phaseSource === source) return t
  return {
    ...t,
    phase,
    phaseSource: source,
    phaseTurn: t.turnId,
    reached: t.reached.includes(phase) ? t.reached : [...t.reached, phase],
  }
}

/** Main Claude's phase, inferred from what it does; subagent phases are taken as given. */
function infer(t: Tracker, hint: Phase): Tracker {
  if ((hint === 'explore' || hint === 'plan') && t.phase === 'verify' && t.turnId !== t.phaseTurn) {
    return enter(nextCycle(t), hint, 'inferred')
  }
  switch (hint) {
    case 'explore':
      return t.phase === null ? enter(t, 'explore', 'inferred') : t
    case 'plan':
      return rank(t.phase) <= rank('explore') ? enter(t, 'plan', 'inferred') : t
    case 'implement':
      return enter(t, 'implement', 'inferred')
    case 'verify':
      return t.cycleEdits > 0 ? enter(t, 'verify', 'inferred') : t
  }
}

/**
 * Applies one finished tool call. `actor` is the subagent type the call ran in,
 * or null for the main loop. Calls of a workflow subagent never move the phase:
 * its own type already says it.
 */
export function applyTool(t: Tracker, signal: ToolSignal, actor: string | null, at: number): Tracker {
  const seq = t.seq + 1
  let next: Tracker = { ...t, seq }

  const governed = actor !== null && phaseOfAgent(actor) !== null
  if (!governed && signal.hint) {
    let hint = signal.hint
    if (hint === 'explore' && signal.isGitDiff && next.cycleEdits > 0) hint = 'verify'
    if (hint === 'verify' && next.cycleEdits === 0) hint = 'explore'
    next = infer(next, hint)
  }

  next = { ...next, cycleRepos: withRepos(next.cycleRepos, signal.repos) }

  if (signal.edits.length > 0) {
    let files = next.files
    let cycleFiles = cycleFilesOf(next)
    for (const edit of signal.edits) {
      files = withFile(files, edit.repo, edit.relative)
      cycleFiles = withFile(cycleFiles, edit.repo, edit.relative)
    }
    next = { ...next, files, cycleFiles, cycleEdits: next.cycleEdits + signal.edits.length, lastEditSeq: seq }
    // An edit after Verify reopens Implement: what was verified has changed.
    if (governed && next.phase === 'verify') next = enter(next, 'implement', 'inferred')
  }

  if (signal.validation) {
    next = { ...next, validation: { ...signal.validation, seq } }
  }

  return { ...next, activity: log(next, at, actor ?? MAIN, signal.text) }
}

export function agentStarted(
  t: Tracker,
  run: AgentRun,
  at: number,
): Tracker {
  const started = { ...run, startedAt: run.startedAt ?? at }
  let next: Tracker = { ...t, seq: t.seq + 1, agents: [...t.agents.filter(a => a.key !== run.key), started] }
  const phase = phaseOfAgent(run.type)
  if (phase) {
    if ((phase === 'explore' || phase === 'plan') && next.phase === 'verify') next = nextCycle(next)
    next = enter(next, phase, 'agent')
  }
  return { ...next, activity: log(next, at, run.type, `started: ${run.description}`) }
}

export function agentIdKnown(t: Tracker, key: string, agentId: string): Tracker {
  return {
    ...t,
    agents: t.agents.map(a => (a.key === key ? { ...a, agentId } : a)),
  }
}

/** Finds the run by its call's key or its agent id; with neither, the oldest unnamed run of `type`. */
function findRun(t: Tracker, by: { key?: string; agentId?: string; type?: string }): AgentRun | undefined {
  return (
    t.agents.find(a => (by.key !== undefined && a.key === by.key) || (by.agentId !== undefined && a.agentId === by.agentId)) ??
    (by.type ? t.agents.find(a => a.type === by.type && a.agentId === undefined) : undefined)
  )
}

export function agentFinished(
  t: Tracker,
  by: { key?: string; agentId?: string; type?: string },
  answer: string | null,
  at: number,
): Tracker {
  const run = findRun(t, by)
  const type = run?.type ?? by.type
  if (!run && !type) return t

  const seq = t.seq + 1
  let next: Tracker = { ...t, seq, agents: run ? t.agents.filter(a => a !== run) : t.agents }
  let text = 'finished'

  if (type && isVerifier(type) && answer !== null) {
    const verdict: Verdict = parseVerdict(answer)
    next = { ...next, verifier: { verdict, seq } }
    text = `verdict ${verdict}`
  }

  return { ...next, activity: log(next, at, type ?? 'agent', text) }
}

export function turnStarted(t: Tracker, turnId: string): Tracker {
  return { ...t, turnId }
}

/** A main turn's end: foreground subagents cannot outlive it. */
export function turnEnded(t: Tracker): Tracker {
  const agents = t.agents.filter(a => a.isBackground)
  return agents.length === t.agents.length ? t : { ...t, agents }
}

export function activeAgent(t: Tracker): string {
  const last = t.agents[t.agents.length - 1]
  if (!last) return MAIN
  return t.agents.length > 1 ? `${last.type} +${t.agents.length - 1}` : last.type
}

export type Tone = 'muted' | 'pending' | 'ok' | 'warn' | 'bad'

export type Status = { label: string; tone: Tone }

/**
 * The verifier's verdict newer than the latest edit, else the latest
 * validation command after it, else pending once something was edited.
 */
export function verification(t: Tracker): Status {
  const verdict = t.verifier && t.verifier.seq > t.lastEditSeq ? t.verifier.verdict : null
  const validation = t.validation && t.validation.seq > t.lastEditSeq ? t.validation : null

  if (verdict === 'FAIL') return { label: 'Verifier FAIL', tone: 'bad' }
  if (verdict === 'PASS') return { label: 'Verifier PASS', tone: 'ok' }
  // A pass, with the verifier's conditions to read.
  if (verdict === 'CONDITIONAL PASS') return { label: 'Verifier CONDITIONAL PASS', tone: 'ok' }
  if (verdict === 'UNKNOWN') return { label: 'Verifier verdict unknown', tone: 'warn' }

  // Nothing edited in the cycle: a test run then explores, it validates nothing.
  if (t.cycleEdits === 0) return { label: 'No changes', tone: 'muted' }
  if (validation?.isInterrupted) return { label: 'Validation stopped by you', tone: 'warn' }
  if (validation && !validation.isOk) return { label: 'Validation failed', tone: 'bad' }
  if (validation) return { label: 'Validated', tone: 'ok' }
  return { label: 'Pending validation', tone: 'pending' }
}

/** Where each phase of the cycle stands: green done, yellow current, red failed, grey otherwise. */
export type PhaseState = 'done' | 'current' | 'failed' | 'skipped' | 'pending' | 'notNeeded'

/**
 * Phases before the current one are done when visited, skipped when not.
 * Verify alone can end: its verification's outcome makes it done or failed.
 */
export function phaseStates(t: Tracker, isIdle = false): Record<Phase, PhaseState> {
  const current = rank(t.phase)
  const status = verification(t)
  const states = {} as Record<Phase, PhaseState>
  PHASES.forEach((phase, index) => {
    // Exploring or planning ends with the turn; edits still unvalidated do not.
    if (isIdle && index === current && (phase === 'explore' || phase === 'plan')) states[phase] = 'done'
    else if (index < current) states[phase] = t.reached.includes(phase) ? 'done' : 'skipped'
    else if (index > current) states[phase] = 'pending'
    else if (phase === 'verify' && status.tone === 'bad') states[phase] = 'failed'
    else if (phase === 'verify' && status.tone === 'ok') states[phase] = 'done'
    else states[phase] = 'current'
  })
  return states
}

export function activeRepos(t: Tracker, cwdRepo: Repo | null): Repo[] {
  if (t.cycleRepos.length > 0) return t.cycleRepos
  return cwdRepo ? [cwdRepo] : []
}

/** The repositories at work, by name: one, or the first and how many more. */
export function repoLabel(repos: readonly Repo[], labels: Readonly<Record<Repo, string>>): string {
  const first = repos[0]
  if (!first) return '—'
  return repos.length > 1 ? `${labelOf(labels, first)} +${repos.length - 1}` : labelOf(labels, first)
}
