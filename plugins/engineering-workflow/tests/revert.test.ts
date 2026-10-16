import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { toplevel } from './git-mock'

const FILE = 'C:/repos/alpha/plugin_dev/a.py'

function slash(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * A host with an in-memory disk: Edit replaces `old_string` with `new_string`
 * in the file, as the real tool does, and every git command is recorded.
 */
function engine(on: On, disk: Record<string, string>, commands: string[][]): void {
  mock.clock(on)
  mock.env(on, { TEMP: 'C:\\T' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.exists', ($, e) => ({ value: slash(e.path) in disk }))
  on('fs.read', ($, e) => (slash(e.path) in disk ? { value: disk[slash(e.path)] ?? '' } : { deny: 'no such file' }))
  on('fs.write', ($, e) => {
    disk[slash(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('tool.call', ($, e) => {
    const input = e as unknown as { file_path?: string; old_string?: string; new_string?: string }
    if (String(e.tool) === 'Edit' && input.file_path) {
      const path = slash(input.file_path)
      disk[path] = (disk[path] ?? '').replace(input.old_string ?? '', input.new_string ?? '')
    }
    return { result: { marker: 'core' } }
  })
  on('process.run', ($, e) => {
    const top = toplevel(e.argv)
    if (top) return { value: top }
    if (e.argv.includes('diff')) commands.push([...e.argv])
    const stdout = e.argv.includes('--no-index') ? '@@ -1 +1 @@\n-print(1)\n+print(2)' : ''
    return { value: { exitCode: 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
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

const edit = (oldText: string, newText: string) =>
  ({ tool: 'Edit', file_path: String.raw`C:\repos\alpha\plugin_dev\a.py`, old_string: oldText, new_string: newText }) as const

test('a file put back as the session found it leaves the list; its changes are this session’s own', async ($, on) => {
  const disk: Record<string, string> = { [FILE]: 'print(1)\n' }
  const commands: string[][] = []
  engine(on, disk, commands)
  await $.session.start({ cwd: String.raw`C:\repos\alpha`, surface: 'terminal', isInteractive: false })

  await $.tool.call(edit('print(1)', 'print(2)'))
  // The copy kept before the first edit holds the file as the session found it.
  const copies = Object.entries(disk).filter(([path]) => path.includes('/baselines/'))
  expect(copies.map(([, text]) => text)).toEqual(['print(1)\n'])

  let ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'file-alpha-0' })).toBeDefined()
  await ui.press({ key: 'file-alpha-0' })
  // The diff compares with that copy, not with the last commit.
  const shown = commands.at(-1) ?? []
  expect(shown.includes('--no-index') && shown.some(arg => arg.includes('/baselines/'))).toBe(true)
  expect(shown.includes('HEAD')).toBe(false)
  await ui.unmount()
  // The changes open in their own pane.
  let changes = await $.ui.mount(CHANGES)
  expect((await changes.find({ type: 'Code' }))?.text).toContain('+print(2)')
  await changes.unmount()

  await $.tool.call(edit('print(2)', 'print(1)'))
  expect(disk[FILE]).toBe('print(1)\n')

  ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'file-alpha-0' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: 'no files modified in this session' })).toBeDefined()
  await ui.unmount()
  // The open diff of the reverted file closed with it.
  changes = await $.ui.mount(CHANGES)
  expect(await changes.find({ type: 'Code' })).toBe(undefined)
  await changes.unmount()

  // Changed again, it is back in the list.
  await $.tool.call(edit('print(1)', 'print(3)'))
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'file-alpha-0' })).toBeDefined()
  await ui.unmount()
})

test('a file created in the session and deleted again leaves the list', async ($, on) => {
  const disk: Record<string, string> = {}
  engine(on, disk, [])
  await $.session.start({ cwd: String.raw`C:\repos\alpha`, surface: 'terminal', isInteractive: false })

  await $.tool.call(edit('', 'new file'))
  let ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'file-alpha-0' })).toBeDefined()
  await ui.unmount()

  delete disk[FILE]
  // An edit elsewhere looks again, as the poll does.
  await $.tool.call({ ...edit('x', 'y'), file_path: String.raw`C:\repos\alpha\other.py` })
  ui = await $.ui.mount(PANE)
  // Only other.py is listed now: a file name is a Text of its own, the whole of it.
  expect(await ui.find({ type: 'Text', text: /^plugin_dev\/a\.py$/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^other\.py$/ })).toBeDefined()
  await ui.unmount()
})
