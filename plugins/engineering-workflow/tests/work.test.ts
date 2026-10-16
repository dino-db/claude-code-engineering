import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { initialTracker } from '../hooks/tracker'
import { IDLE, agentRows, agentToast, clockTime, duration, finishToast, workLine } from '../hooks/work'
import { toplevel } from './git-mock'

describe('working and finishing', () => {
  test('durations', () => {
    expect(duration(0)).toBe('0:00')
    expect(duration(65_000)).toBe('1:05')
    expect(duration(3_725_000)).toBe('1:02:05')
  })

  test('yellow while working, green when it answered, red on an error, grey when stopped by the person', () => {
    expect(workLine({ isWorking: true, startedAt: 0, finishedAt: null, durationMs: null, outcome: null }, 42_000)).toEqual({
      mark: '●',
      text: 'working · 0:42',
      color: 'yellow',
    })
    const at = new Date(2026, 9, 5, 15, 42).getTime()
    const ended = { isWorking: false, startedAt: null, finishedAt: at, durationMs: 190_000 }
    expect(workLine({ ...ended, outcome: 'answer' }, at)).toEqual({ mark: '✓', text: 'finished in 3:10 (at 15:42)', color: 'green' })
    expect(workLine({ ...ended, outcome: 'error' }, at)?.color).toBe('red')
    expect(workLine({ ...ended, outcome: 'aborted' }, at)).toEqual({ mark: '■', text: 'stopped by you in 3:10 (at 15:42)' })
    expect(clockTime(at)).toBe('15:42')
  })

  test('toasts: none when the person stopped it', () => {
    const ended = { isWorking: false, startedAt: null, finishedAt: 1, durationMs: 190_000 }
    expect(finishToast({ ...ended, outcome: 'answer' })).toBe('✓ Claude finished in 3:10')
    expect(finishToast({ ...ended, outcome: 'error' })).toBe('✗ Claude stopped on an error after 3:10')
    expect(finishToast({ ...ended, outcome: 'aborted' })).toBe(null)
    expect(agentToast('implementation-verifier', 'PASS')).toBe('✓ implementation-verifier finished: PASS')
  })

  test('agents: Main with its status, then each running subagent with its own time', () => {
    const t = {
      ...initialTracker(),
      agents: [
        { key: 'a', type: 'explorer', description: 'find the routing', isBackground: false, startedAt: 10_000 },
        { key: 'b', type: 'verifier', description: 'check the plan', isBackground: true, startedAt: 40_000 },
      ],
    }
    const working = { ...IDLE, isWorking: true, startedAt: 0 }
    expect(agentRows(t, working, 55_000)).toEqual([
      { name: 'Main', line: { mark: '●', text: 'working · 0:55', color: 'yellow' } },
      { name: 'explorer', line: { mark: '●', text: 'working · 0:45', color: 'yellow' }, detail: 'find the routing' },
      { name: 'verifier', line: { mark: '●', text: 'working · 0:15', color: 'yellow' }, detail: 'check the plan (background)' },
    ])
    expect(agentRows(initialTracker(), IDLE, 0)).toEqual([{ name: 'Main', line: { mark: '·', text: 'idle' } }])
  })
})

const PANE = {
  plugin: 'engineering-workflow',
  component: 'Pane',
  requestId: 'engineering-workflow',
  surface: 'terminal',
  props: {
    title: 'Engineering Workflow',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 90 },
    view: {},
  },
} as const

function engine(on: On, toasts: string[]) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-x' }))
  on('process.run', ($, e) => ({ value: toplevel(e.argv) ?? { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return clock
}

/** Main's row in the Agents list. */
async function status($: Engine): Promise<string> {
  const ui = await $.ui.mount(PANE)
  const row = await ui.find({ type: 'Text', text: /^Agents/ })
  await ui.unmount()
  return row?.text ?? ''
}

/** Every row of the Agents list, Main first. */
async function agentList($: Engine): Promise<string[]> {
  const ui = await $.ui.mount(PANE)
  const rows = (await ui.findAll({ type: 'Text', text: /^(Agents {5}| {11})\S/ })).map(found => found.text)
  await ui.unmount()
  return rows
}

const complete = (reason: 'answer' | 'aborted', durationMs: number) =>
  ({ answer: 'done', durationMs, isAborted: reason === 'aborted', turnId: 't', reason }) as const

test('the pane shows Main Claude working with the time ticking, then finished, with a toast', async ($, on) => {
  const toasts: string[] = []
  const clock = engine(on, toasts)
  await $.session.start({ cwd: String.raw`C:\repos\alpha`, surface: 'terminal', isInteractive: false })
  expect(await status($)).toBe('Agents     Main  · idle')

  await $.turn.start({ text: 'fix it', turnId: 't' })
  expect(await status($)).toBe('Agents     Main  ● working · 0:00')
  await clock.advance(65_000)
  expect(await status($)).toBe('Agents     Main  ● working · 1:05')

  await $.turn.complete(complete('answer', 65_000))
  expect(await status($)).toContain('Agents     Main  ✓ finished in 1:05 (at ')
  expect(toasts).toEqual(['✓ Claude finished in 1:05'])

  // Stopped by the person: shown, but no toast.
  await $.turn.start({ text: 'again', turnId: 'u' })
  await $.turn.complete(complete('aborted', 3_000))
  expect(await status($)).toContain('■ stopped by you in 0:03')
  expect(toasts).toEqual(['✓ Claude finished in 1:05'])
})

test('a subagent’s end is notified once, with the verifier’s verdict', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start({ cwd: String.raw`C:\repos\alpha`, surface: 'terminal', isInteractive: false })

  await $.agent.spawn({
    tool_use_id: 'call-v',
    prompt: 'verify',
    description: 'verify',
    subagentType: 'implementation-verifier',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
  })
  await $.turn.complete({ ...complete('answer', 1_000), agentId: 'agent-x', answer: '## Verdict\nPASS' })
  // Its Agent call's result arrives after: the same end, no second toast.
  await $.turn.complete({ ...complete('answer', 1_000), agentId: 'agent-x', answer: '## Verdict\nPASS' })

  expect(toasts).toEqual(['✓ implementation-verifier finished: PASS'])
})

test('a running subagent is listed beside Main with its time ticking, and leaves the list when it ends', async ($, on) => {
  const toasts: string[] = []
  const clock = engine(on, toasts)
  await $.session.start({ cwd: String.raw`C:\repos\alpha`, surface: 'terminal', isInteractive: false })
  await $.turn.start({ text: 'look around', turnId: 't' })

  await $.agent.spawn({
    tool_use_id: 'call-e',
    prompt: 'explore',
    description: 'find the routing',
    subagentType: 'explorer',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: true,
    fork: false,
  })
  // Main's turn ends; the background agent goes on, and its time still ticks.
  await $.turn.complete(complete('answer', 2_000))
  await clock.advance(30_000)

  const rows = await agentList($)
  expect(rows[0]).toContain('Agents     Main      ✓ finished in 0:02')
  expect(rows[1]).toBe('           explorer  ● working · 0:30  find the routing (background)')

  await $.turn.complete({ ...complete('answer', 30_000), agentId: 'agent-x', answer: 'done' })
  expect(await agentList($)).toHaveLength(1)
})

async function phase($: Engine, name: string): Promise<string> {
  const ui = await $.ui.mount(PANE)
  const row = await ui.find({ type: 'Text', text: new RegExp(`^. ${name}`) })
  await ui.unmount()
  return row?.text ?? ''
}

test('exploring is in progress while Claude works and done when the turn ends; unvalidated edits stay open', async ($, on) => {
  engine(on, [])
  on('tool.call', () => ({ result: { marker: 'core' } }))
  await $.session.start({ cwd: String.raw`C:\repos\beta`, surface: 'terminal', isInteractive: false })

  await $.turn.start({ text: 'vedi i cambi che ho fatto?', turnId: 't' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/repos/beta/app-react/src/a.jsx' })
  expect(await phase($, 'Explore')).toBe('▶ Explore     in progress')
  await $.turn.complete(complete('answer', 66_000))
  expect(await phase($, 'Explore')).toBe('✓ Explore     done')

  // A next turn that edits: Implement stays in progress after it, the edit not validated.
  await $.turn.start({ text: 'fix it', turnId: 'u' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/repos/beta/app-react/src/a.jsx', old_string: 'a', new_string: 'b' })
  await $.turn.complete(complete('answer', 5_000))
  expect(await phase($, 'Implement')).toBe('▶ Implement   in progress')
})
