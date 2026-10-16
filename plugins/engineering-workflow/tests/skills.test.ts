import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted as TestMounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import { commandText, parseSkill, sortSkills } from '../hooks/skills'
import { toplevel } from './git-mock'

describe('reading a skill', () => {
  test('its name, and whether it takes an argument', () => {
    const handoff = '---\nname: handoff\ndescription: x\nargument-hint: "What next?"\nuser-invocable: true\n---\nbody'
    expect(parseSkill('handoff', handoff)).toEqual({ name: 'handoff', takesArgument: true })
    expect(commandText({ name: 'handoff', takesArgument: true })).toBe('/handoff ')
    expect(commandText({ name: 'prepare-pr', takesArgument: false })).toBe('/prepare-pr')
  })

  test('no frontmatter: the folder names it, as Claude Code does', () => {
    expect(parseSkill('prepare-pr', '# prepare-pr\n\nPrepare the branch.')).toEqual({ name: 'prepare-pr', takesArgument: false })
  })

  test('a skill the person cannot invoke gets no button', () => {
    expect(parseSkill('internal', '---\nname: internal\nuser-invocable: false\n---\n')).toBe(null)
  })

  test('sorted by name', () => {
    expect(sortSkills([{ name: 'prepare-pr', takesArgument: false }, { name: 'handoff', takesArgument: true }]).map(s => s.name)).toEqual([
      'handoff',
      'prepare-pr',
    ])
  })
})

/** Each repository's skill folders, as alpha and beta have them. */
const SKILLS: Record<string, Record<string, string>> = {
  'C:/repos/alpha/.claude/skills': {
    'clean-code-practices': '---\nname: clean-code-practices\ndescription: x\n---\n',
    handoff: '---\nname: handoff\nargument-hint: "What next?"\n---\n',
    'prepare-pr': '---\nname: prepare-pr\ndescription: x\n---\n',
    'unit-test-structure': '---\nname: unit-test-structure\ndescription: x\n---\n',
  },
  'C:/repos/beta/.claude/skills': {
    handoff: '---\nname: handoff\nargument-hint: "What next?"\n---\n',
    'prepare-pr': '# prepare-pr\n',
  },
}

function slash(path: string): string {
  return path.replace(/\\/g, '/')
}

function engine(on: On, filled: string[], submitted: string[]) {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => ({ value: toplevel(e.argv) ?? { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', ($, e) => ({ value: slash(e.path) in SKILLS }))
  on('fs.list', ($, e) => ({
    value: Object.keys(SKILLS[slash(e.path)] ?? {}).map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', ($, e) => {
    const path = slash(e.path)
    const dir = path.replace(/\/[^/]+\/SKILL\.md$/, '')
    const folder = path.slice(dir.length + 1).replace(/\/SKILL\.md$/, '')
    const text = SKILLS[dir]?.[folder]
    return text === undefined ? { deny: 'no such file' } : { value: text }
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return clock
}

const PANE = {
  plugin: 'engineering-workflow',
  component: 'Pane',
  requestId: 'engineering-workflow',
  surface: 'terminal',
  props: {
    title: 'Engineering Workflow',
    isFocused: true,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

type Mounted = TestMounted<'terminal', 'Pane'>

/** ☰, then skills ▸. */
async function openSkills(ui: Mounted): Promise<void> {
  await ui.press({ key: 'menu' })
  await ui.press({ key: 'menu-skills' })
}

/** The skills level's entries. */
async function entries($: Engine): Promise<string[]> {
  const ui = await $.ui.mount(PANE)
  await openSkills(ui)
  const found = (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(key => key.startsWith('skill-'))
  await ui.unmount()
  return found
}

test('☰ › skills lists alpha’s skills; an entry fills the prompt, runs nothing, and closes the menu', async ($, on) => {
  const filled: string[] = []
  const submitted: string[] = []
  const clock = engine(on, filled, submitted)
  await $.session.start({ cwd: String.raw`C:\repos\alpha`, surface: 'terminal', isInteractive: false })
  await clock.advance(0)

  const ui = await $.ui.mount(PANE)
  // Closed: only the menu's own button.
  expect((await ui.find({ key: 'menu' }))?.text).toBe('☰')
  expect(await ui.find({ key: 'skill-prepare-pr' })).toBe(undefined)

  await openSkills(ui)
  expect(await ui.find({ type: 'Text', text: 'alpha skills' })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key).filter(key => key?.startsWith('skill-'))).toEqual([
    'skill-clean-code-practices',
    'skill-handoff',
    'skill-prepare-pr',
    'skill-unit-test-structure',
  ])

  await ui.press({ key: 'skill-prepare-pr' })
  expect(await ui.find({ key: 'skill-handoff' })).toBe(undefined)
  expect(await ui.find({ key: 'menu-skills' })).toBe(undefined)

  await openSkills(ui)
  await ui.press({ key: 'skill-handoff' })
  await ui.unmount()

  expect(filled).toEqual(['/prepare-pr', '/handoff '])
  expect(submitted).toEqual([])
})

test('a beta session’s menu has beta’s skills only', async ($, on) => {
  const clock = engine(on, [], [])
  await $.session.start({ cwd: String.raw`C:\repos\beta`, surface: 'terminal', isInteractive: false })
  await clock.advance(0)
  expect(await entries($)).toEqual(['skill-handoff', 'skill-prepare-pr'])
})

test('outside alpha and beta there are no skills', async ($, on) => {
  const clock = engine(on, [], [])
  await $.session.start({ cwd: String.raw`C:\Users`, surface: 'terminal', isInteractive: false })
  await clock.advance(0)
  expect(await entries($)).toEqual([])
})

test('in a repository session without readable skills, skills ▸ says why', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', ($, e) => ({ value: toplevel(e.argv) ?? { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ name: 'handoff', kind: 'other' as const, size: 0, mtimeMs: 0, isLink: true }] }))
  on('fs.read', () => ({ deny: 'access denied' }))
  await $.session.start({ cwd: 'C:/repos/beta', surface: 'terminal', isInteractive: false })
  await clock.advance(0)

  const ui = await $.ui.mount(PANE)
  await openSkills(ui)
  // A link to a folder is tried too; what failed is named.
  expect((await ui.find({ type: 'Text', text: /^could not read the skills: handoff:/ }))?.text).toContain('access denied')
  await ui.unmount()
})
