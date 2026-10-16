import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { NEAR_CHANGES, WHOLE_FILE, diffArgv, fitDiff, hunks, newFileArgv } from '../hooks/diff'
import { toplevel } from './git-mock'

const DIFF = [
  'diff --git a/plugin_dev/a.py b/plugin_dev/a.py',
  'index 1111111..2222222 100644',
  '--- a/plugin_dev/a.py',
  '+++ b/plugin_dev/a.py',
  '@@ -1,3 +1,3 @@ def run():',
  ' keep',
  '-old',
  '+new',
  ' keep',
  '@@ -10,2 +10,3 @@',
  ' x',
  '+added',
  ' y',
].join('\r\n')

describe('fitting a diff to the pane', () => {
  test('keeps the hunks, drops the preamble and carriage returns', () => {
    expect(hunks(DIFF).map(h => h[0])).toEqual(['@@ -1,3 +1,3 @@ def run():', '@@ -10,2 +10,3 @@'])
    expect(fitDiff(DIFF)).toEqual({
      source: ['@@ -1,3 +1,3 @@ def run():', ' keep', '-old', '+new', ' keep', '@@ -10,2 +10,3 @@', ' x', '+added', ' y'].join('\n'),
      omitted: 0,
    })
  })

  test('leaves out whole hunks past the budget, never half of one', () => {
    const fitted = fitDiff(DIFF, 60)
    expect(fitted?.source.split('\n')[0]).toBe('@@ -1,3 +1,3 @@ def run():')
    expect(fitted?.source).not.toContain('@@ -10')
    expect(fitted?.omitted).toBe(1)
  })

  test('a single hunk too long alone is cut and renumbered', () => {
    const long = ['@@ -1,40 +1,40 @@', ...Array.from({ length: 40 }, (_, i) => ` line ${i}`)].join('\n')
    const fitted = fitDiff(long, 120)
    const [header, ...lines] = fitted?.source.split('\n') ?? []
    expect(header).toBe(`@@ -1,${lines.length} +1,${lines.length} @@`)
    expect((fitted?.source.length ?? 0) <= 120).toBe(true)
  })

  test('no hunks, no diff', () => {
    expect(fitDiff('Binary files a/x.png and b/x.png differ')).toBe(null)
    expect(fitDiff('')).toBe(null)
  })

  test('git is only read', () => {
    expect(diffArgv('C:/repos/alpha', 'a.py')).toEqual([
      'git', '--no-optional-locks', '-C', 'C:/repos/alpha', 'diff', '--no-color', '--no-ext-diff',
      `--unified=${WHOLE_FILE}`, 'HEAD', '--', 'a.py',
    ])
    expect(diffArgv('C:/repos/alpha', 'a.py', NEAR_CHANGES)).toContain('--unified=5')
    expect(newFileArgv('C:/repos/alpha', 'a.py').slice(4)).toEqual([
      'diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', 'a.py',
    ])
  })
})

/** git answering the whole-file diff, and the near-changes one when asked for it. */
function engine(on: On, gitDiff: string, nearDiff = gitDiff): void {
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { marker: 'core' } }))
  on('process.run', ($, e) => ({
    value: toplevel(e.argv) ?? {
      exitCode: 0,
      stdout: e.argv.includes(`--unified=${NEAR_CHANGES}`) ? nearDiff : e.argv.includes('HEAD') ? gitDiff : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
}

const PANE = {
  plugin: 'engineering-workflow',
  component: 'Pane',
  requestId: 'engineering-workflow',
  surface: 'terminal',
  props: {
    title: 'Engineering Workflow',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const CHANGES = { ...PANE, requestId: 'engineering-workflow-changes', props: { ...PANE.props, title: 'changes' } } as const

/** Records the panes the mod opens and closes. */
function panes(on: On): { opened: string[]; closed: string[] } {
  const seen = { opened: [] as string[], closed: [] as string[] }
  on('ui.open', ($, e) => {
    seen.opened.push(`${e.id}: ${e.title ?? ''}`)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  return seen
}

test('a modified file is listed alone; its changes open in a pane of their own', async ($, on) => {
  engine(on, DIFF)
  const seen = panes(on)
  await $.session.start({ cwd: 'C:\\repos\\alpha', surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\repos\\alpha\\plugin_dev\\a.py', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount(PANE)
  // The button is no path, so the terminal does not take the click to open an editor.
  expect((await ui.find({ key: 'file-alpha-0' }))?.text).toBe('changes')
  expect(await ui.find({ type: 'Text', text: 'plugin_dev/a.py' })).toBeDefined()

  await ui.press({ key: 'file-alpha-0' })
  // Nothing opens inside the main pane: the list stays a list.
  expect(await ui.find({ type: 'Code' })).toBe(undefined)
  await ui.unmount()
  expect(seen.opened).toContain('engineering-workflow-changes: changes · alpha/plugin_dev/a.py')

  const changes = await $.ui.mount(CHANGES)
  const code = await changes.find({ type: 'Code' })
  expect(code?.props.format).toBe('diff')
  expect(code?.text).toContain('+new')
  expect(code?.text).toContain('-old')
  expect(await changes.find({ type: 'Text', text: 'alpha/plugin_dev/a.py' })).toBeDefined()

  await changes.press({ key: 'close-changes' })
  await changes.unmount()
  expect(seen.closed).toContain('engineering-workflow-changes')
})

test('a file too large to show whole shows its changed parts, and says so', async ($, on) => {
  const lines = Array.from({ length: 2000 }, (_, i) => (i === 1000 ? '+changed' : ` line ${i}`))
  const whole = ['@@ -1,2000 +1,2000 @@', ...lines].join('\n')
  const near = ['@@ -996,3 +996,3 @@', ' line 999', '+changed', ' line 1001'].join('\n')
  engine(on, whole, near)
  panes(on)
  await $.session.start({ cwd: 'C:\\repos\\alpha', surface: 'terminal', isInteractive: false })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\repos\\alpha\\big.py', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'file-alpha-0' })
  await ui.unmount()

  const changes = await $.ui.mount(CHANGES)
  expect((await changes.find({ type: 'Code' }))?.text).toContain('+changed')
  expect(await changes.find({ type: 'Text', text: 'file too large to show whole: changed parts only' })).toBeDefined()
  await changes.unmount()
})
