import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { toplevel } from './git-mock'

const BAND = {
  plugin: 'engineering-workflow',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

function engine(on: On): MockClock {
  const clock = mock.clock(on)
  // git: every repository on branch FEAT-1 with one changed file.
  on('process.run', ($, e) => ({
    value: toplevel(e.argv) ?? {
      exitCode: 0,
      stdout: e.argv.includes('--show-current') ? 'FEAT-1\n' : e.argv.includes('status') ? ' M a.py\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return clock
}

async function start($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: 'C:\\repos\\alpha', surface: 'terminal', isInteractive: false })
  // Runs the first git read, which session.start leaves on a timer.
  await clock.advance(0)
}

const PANE = {
  plugin: 'engineering-workflow',
  component: 'Pane',
  requestId: 'engineering-workflow',
  props: {
    title: 'Engineering Workflow',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

async function shown($: Engine, surface: 'terminal' | 'desktop', site: 'band' | 'pane' = 'band'): Promise<string> {
  const ui = site === 'band' ? await $.ui.mount({ ...BAND, surface }) : await $.ui.mount({ ...PANE, surface })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join(' ')
  await ui.unmount()
  return texts
}

test('tool results pass through unchanged, denials included', async ($, on) => {
  const clock = engine(on)
  on('tool.call', ($, e) =>
    String(e.tool) === 'Bash' ? { deny: 'blocked by a settings hook' } : { result: { marker: 'core' } },
  )
  await start($, clock)

  const edited = await $.tool.call({
    tool: 'Edit',
    file_path: 'C:\\repos\\alpha\\plugin_dev\\managers\\a.py',
    old_string: 'a',
    new_string: 'b',
  })
  expect(edited.result).toEqual({ marker: 'core' })

  const denied = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(denied.deny).toBe('blocked by a settings hook')

  const pane = await shown($, 'terminal', 'pane')
  expect(pane).toContain('plugin_dev/managers/a.py')
  expect(pane).toContain('▶ Implement   in progress')
  expect(pane).toContain('– Explore     skipped')
  expect(pane).toContain('· Verify      not started')
  expect(pane).toContain('Pending validation')
  expect(pane).toContain('Engineering Workflow')
  // Session: repository, branch and agent, of the session's own repository (alpha).
  expect(pane).toContain('Repository alpha')
  expect(pane).toContain('Branch      FEAT-1 (1 changed)')
  expect(pane).toContain('Agents     Main')
  // Modified files: the session's repository only.
  expect(pane).toContain('alpha · modified files')
  expect(pane).not.toContain('beta · modified files')
  // The denied command never ran, so it is not activity.
  expect(pane).not.toContain('git push')
})

test('a verifier subagent drives Verify and its verdict', async ($, on) => {
  const clock = engine(on)
  on('tool.call', () => ({ result: { marker: 'core' } }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'agent-v' }))
  await start($, clock)

  await $.tool.call({ tool: 'Write', file_path: 'C:/repos/beta/app/a.js', content: 'x' })
  await $.agent.spawn({
    tool_use_id: 'call-v',
    prompt: 'verify',
    description: 'verify change',
    subagentType: 'implementation-verifier',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
  })

  expect(await shown($, 'terminal', 'pane')).toContain('▶ Verify')
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await shown($, surface)).toContain('implementation-verifier')
  }

  await $.turn.complete({
    answer: '## Verdict\nPASS',
    durationMs: 1,
    isAborted: false,
    turnId: 't',
    agentId: 'agent-v',
    reason: 'answer',
  })
  expect(await shown($, 'terminal', 'pane')).toContain('verifier: PASS')

  for (const surface of ['terminal', 'desktop'] as const) {
    const text = await shown($, surface)
    expect(text).toContain('Main Claude')
    expect(text).toContain('Verifier PASS')
    expect(text).toContain('beta')
  }
})

test('outside any repository the workflow still shows, without Git', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: 'C:\\Users', surface: 'terminal', isInteractive: false })
  await clock.advance(0)

  const pane = await shown($, 'terminal', 'pane')
  expect(pane).toContain('session outside any Git repository')
  expect(pane).toContain('Workflow ·')
  expect(pane).toContain('Verification')

  const band = await shown($, 'terminal')
  expect(band).toContain('Engineering Workflow')
  expect(band).toContain('Explore')
  expect(band).not.toContain('⎇')
})

test('a file edited in another repository joins the session, with its branch', async ($, on) => {
  const clock = engine(on)
  on('tool.call', () => ({ result: { marker: 'core' } }))
  await start($, clock)

  await $.tool.call({ tool: 'Write', file_path: 'C:/repos/beta/new/dir/a.js', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/repos/alpha/b.py', old_string: 'a', new_string: 'b' })
  await clock.advance(2_000)

  const pane = await shown($, 'terminal', 'pane')
  expect(pane).toContain('alpha · modified files')
  expect(pane).toContain('beta · FEAT-1 (1 changed) · modified files')
  expect(pane).toContain('new/dir/a.js')
  expect(await shown($, 'terminal')).toContain('files alpha 1 · beta 1')
})

