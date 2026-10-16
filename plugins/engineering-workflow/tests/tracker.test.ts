import { describe, expect, test } from 'claude-code/testing'

import { classifyTool, isInterruptedRun } from '../hooks/classify'
import {
  MAIN,
  activeAgent,
  activeRepos,
  agentFinished,
  agentIdKnown,
  agentStarted,
  applyTool,
  initialTracker,
  noted,
  turnEnded,
  turnStarted,
  phaseStates,
  verification,
} from '../hooks/tracker'
import type { Tracker } from '../types'

const roots = { alpha: 'C:/repos/alpha', beta: 'C:/repos/beta' }
const CWD = 'C:/repos/alpha'

function tool(t: Tracker, name: string, input: Record<string, unknown>, isOk = true, actor: string | null = null): Tracker {
  const signal = classifyTool(name, input, isOk, roots, CWD)
  return signal ? applyTool(t, signal, actor, 0) : t
}

function spawn(t: Tracker, key: string, type: string): Tracker {
  return agentStarted(t, { key, type, description: type, isBackground: false }, 0)
}

describe('main Claude, phases inferred', () => {
  test('explore, plan, implement, verify', () => {
    let t = turnStarted(initialTracker(), 'turn-1')
    expect(activeAgent(t)).toBe(MAIN)

    t = tool(t, 'Read', { file_path: 'plugin_dev/managers/a.py' })
    expect(t.phase).toBe('explore')

    t = tool(t, 'ExitPlanMode', {})
    expect(t.phase).toBe('plan')

    t = tool(t, 'Read', { file_path: 'plugin_dev/managers/a.py' })
    expect(t.phase).toBe('plan')

    t = tool(t, 'Edit', { file_path: 'C:/repos/alpha/plugin_dev/managers/a.py' })
    expect(t.phase).toBe('implement')
    expect(verification(t).label).toBe('Pending validation')

    t = tool(t, 'Read', { file_path: 'plugin_dev/managers/b.py' })
    expect(t.phase).toBe('implement')

    t = tool(t, 'Bash', { command: 'pytest plugin_dev/managers' })
    expect(t.phase).toBe('verify')
    expect(verification(t).label).toBe('Validated')
    expect(t.reached).toEqual(['explore', 'plan', 'implement', 'verify'])
    expect(t.files.alpha).toEqual(['plugin_dev/managers/a.py'])
  })

  test('tests before any edit stay Explore; git diff after an edit is Verify', () => {
    let t = tool(initialTracker(), 'Bash', { command: 'pytest -x' })
    expect(t.phase).toBe('explore')
    t = tool(t, 'Write', { file_path: 'C:/repos/beta/app/a.js' })
    t = tool(t, 'Bash', { command: 'git diff' })
    expect(t.phase).toBe('verify')
    expect(activeRepos(t, 'alpha')).toEqual(['alpha', 'beta'])
  })

  test('an edit after Verify reopens Implement and drops the validation', () => {
    let t = tool(initialTracker(), 'Edit', { file_path: 'C:/repos/alpha/a.py' })
    t = tool(t, 'Bash', { command: 'pytest' }, false)
    expect(verification(t).label).toBe('Validation failed')
    t = tool(t, 'Edit', { file_path: 'C:/repos/alpha/a.py' })
    expect(t.phase).toBe('implement')
    expect(verification(t).label).toBe('Pending validation')
    expect(t.files.alpha).toEqual(['a.py'])
  })

  test('exploring in a later turn after Verify starts a new cycle', () => {
    let t = turnStarted(initialTracker(), 'turn-1')
    t = tool(t, 'Edit', { file_path: 'C:/repos/alpha/a.py' })
    t = tool(t, 'Bash', { command: 'pytest' })
    t = tool(t, 'Read', { file_path: 'a.py' })
    expect(t.cycle).toBe(1)
    t = turnStarted(t, 'turn-2')
    t = tool(t, 'Grep', { pattern: 'x' })
    expect(t.cycle).toBe(2)
    expect(t.phase).toBe('explore')
    expect(t.files.alpha).toEqual(['a.py'])
    expect(verification(t).label).toBe('No changes')
  })
})

describe('workflow subagents', () => {
  test('agents set the phase; their own calls do not move it', () => {
    let t = spawn(initialTracker(), 'call-1', 'codebase-explorer')
    t = agentIdKnown(t, 'call-1', 'agent-1')
    expect(activeAgent(t)).toBe('codebase-explorer')
    expect(t.phase).toBe('explore')
    t = agentFinished(t, { agentId: 'agent-1' }, 'findings', 0)
    expect(activeAgent(t)).toBe(MAIN)

    t = spawn(t, 'call-2', 'implementation-planner')
    expect(t.phase).toBe('plan')
    t = agentFinished(t, { key: 'call-2' }, 'plan', 0)

    t = spawn(t, 'call-3', 'implementation-executor')
    t = tool(t, 'Edit', { file_path: 'C:/repos/beta/app-react/x.tsx' }, true, 'implementation-executor')
    t = tool(t, 'Bash', { command: 'npm test' }, true, 'implementation-executor')
    expect(t.phase).toBe('implement')
    expect(verification(t).label).toBe('Validated')
    t = agentFinished(t, { key: 'call-3' }, 'done', 0)

    t = spawn(t, 'call-4', 'implementation-verifier')
    expect(t.phase).toBe('verify')
    t = agentFinished(t, { key: 'call-4' }, '## Verdict\nFAIL: missing test', 0)
    expect(verification(t)).toEqual({ label: 'Verifier FAIL', tone: 'bad' })
    expect(t.reached).toEqual(['explore', 'plan', 'implement', 'verify'])
  })

  test('the explorer after Verify starts a new cycle', () => {
    let t = spawn(initialTracker(), 'a', 'implementation-verifier')
    t = spawn(t, 'b', 'codebase-explorer')
    expect(t.cycle).toBe(2)
    expect(t.reached).toEqual(['explore'])
  })

  test('a finish known only by type ends the oldest unnamed run of it', () => {
    let t = spawn(initialTracker(), 'a', 'implementation-verifier')
    t = agentFinished(t, { agentId: 'unknown', type: 'implementation-verifier' }, 'PASS', 0)
    expect(t.agents).toEqual([])
    expect(t.verifier?.verdict).toBe('PASS')
  })

  test('a main turn end clears foreground agents only', () => {
    let t = spawn(initialTracker(), 'a', 'implementation-executor')
    t = agentStarted(t, { key: 'b', type: 'general-purpose', description: 'bg', isBackground: true }, 0)
    expect(activeAgent(t)).toBe('general-purpose +1')
    t = turnEnded(t)
    expect(t.agents.map(a => a.key)).toEqual(['b'])
  })

  test('a general-purpose subagent is inferred like the main loop', () => {
    let t = spawn(initialTracker(), 'a', 'general-purpose')
    t = tool(t, 'Edit', { file_path: 'C:/repos/alpha/a.py' }, true, 'general-purpose')
    expect(t.phase).toBe('implement')
  })
})

describe('phase states: green done, yellow current, red failed, grey otherwise', () => {
  test('before any work every phase is not started', () => {
    expect(phaseStates(initialTracker())).toEqual({
      explore: 'pending',
      plan: 'pending',
      implement: 'pending',
      verify: 'pending',
    })
  })

  test('visited phases are done, skipped ones skipped, the current one current', () => {
    let t = tool(initialTracker(), 'Read', { file_path: 'a.py' })
    t = tool(t, 'Edit', { file_path: 'C:/repos/alpha/a.py' })
    expect(phaseStates(t)).toEqual({ explore: 'done', plan: 'skipped', implement: 'current', verify: 'pending' })
  })

  test('Verify ends done on a pass and failed on a failure', () => {
    let t = tool(initialTracker(), 'Edit', { file_path: 'C:/repos/alpha/a.py' })
    t = tool(t, 'Bash', { command: 'pytest' })
    expect(phaseStates(t).verify).toBe('done')

    t = tool(t, 'Edit', { file_path: 'C:/repos/alpha/a.py' })
    t = tool(t, 'Bash', { command: 'pytest' }, false)
    expect(phaseStates(t).verify).toBe('failed')

    t = spawn(t, 'v', 'implementation-verifier')
    expect(phaseStates(t).verify).toBe('failed')
    t = agentFinished(t, { key: 'v' }, 'Verdict: CONDITIONAL PASS', 0)
    expect(phaseStates(t).verify).toBe('done')
  })

  test('Verify is current while the verifier runs', () => {
    let t = tool(initialTracker(), 'Edit', { file_path: 'C:/repos/alpha/a.py' })
    t = spawn(t, 'v', 'implementation-verifier')
    expect(phaseStates(t).verify).toBe('current')
  })
})

describe('a test run the person stops', () => {
  const jest = 'cd /c/repos/beta/app-react && npx jest src/views/tools/tire-build/actions/test/VTire.test.jsx'

  test('with nothing edited it validates nothing: no changes, and the run reads stopped, not failed', () => {
    const signal = classifyTool('Bash', { command: jest }, false, roots, 'C:/repos/beta', true)
    expect(signal?.text.endsWith('■ stopped by you')).toBe(true)
    const t = signal ? applyTool(initialTracker(), signal, null, 0) : initialTracker()
    expect(verification(t)).toEqual({ label: 'No changes', tone: 'muted' })
    expect(t.validation?.isInterrupted).toBe(true)
  })

  test('after an edit it is stopped by the person, not failed', () => {
    let t = tool(initialTracker(), 'Edit', { file_path: 'C:/repos/beta/app-react/src/a.jsx' })
    const signal = classifyTool('Bash', { command: jest }, false, roots, 'C:/repos/beta', true)
    t = signal ? applyTool(t, signal, null, 0) : t
    expect(verification(t)).toEqual({ label: 'Validation stopped by you', tone: 'warn' })
    expect(phaseStates(t).verify).toBe('current')
  })

  test('Ctrl+C exit codes and interrupt messages read as stopped', () => {
    expect(isInterruptedRun('Exit code 3221225786')).toBe(true)
    expect(isInterruptedRun('exited with code 130')).toBe(true)
    expect(isInterruptedRun('KeyboardInterrupt')).toBe(true)
    expect(isInterruptedRun('Exit code 1')).toBe(false)
    expect(isInterruptedRun('exit code 1301')).toBe(false)
  })
})

test('a noted line joins the recent activity under its actor', () => {
  const t = noted(initialTracker(), 5, 'link', '→ beta: hello')
  expect(t.activity).toEqual([{ at: 5, actor: 'link', text: '→ beta: hello' }])
})
