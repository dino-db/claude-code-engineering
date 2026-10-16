import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted as TestMounted } from 'claude-code/testing'

import { attachArgv, errorFile, focusArgv, killArgv, newSessionArgv, parseEntry, stopArgv, wtPath } from '../hooks/switcher'
import { NO_WT } from '../hooks/view'
import { ALPHA, BETA } from './git-mock'
import { ME, PANE, REGISTRY, engine, entry, startIn } from './link-engine'

type Mounted = TestMounted<'terminal', 'Pane'>

async function mount($: Engine): Promise<Mounted> {
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

async function label(ui: Mounted, key: string): Promise<string | undefined> {
  return (await ui.find({ key }))?.text
}

async function textsOf(ui: Mounted): Promise<string> {
  return (await ui.findAll({ type: 'Text' })).map(found => found.text).join(' | ')
}

/** ☰, then sessions ▸. */
async function openSessions(ui: Mounted): Promise<void> {
  await ui.press({ key: 'menu' })
  await ui.press({ key: 'menu-sessions' })
}

const SESSIONS = () => ({
  [`${REGISTRY}/partner.json`]: JSON.stringify(entry({})),
  [`${REGISTRY}/bg.json`]: JSON.stringify(entry({ sessionId: 'bg', name: 'ui', window: null, background: true })),
  [`${REGISTRY}/hand.json`]: JSON.stringify(entry({ sessionId: 'hand', name: null, window: null })),
  [`${REGISTRY}/alpha2.json`]: JSON.stringify(entry({ sessionId: 'alpha2', repo: ALPHA, repoRoot: 'C:/repos/alpha', name: 'jobs', window: 'ew-alpha-jobs' })),
})

test('☰ opens sessions and skills; sessions lists the repositories and new session, a repository its sessions, back returns', async ($, on) => {
  const { clock } = engine(on, SESSIONS())
  await startIn($, clock)

  const ui = await mount($)
  expect(await label(ui, 'menu')).toBe('☰')
  expect(await ui.find({ key: 'menu-sessions' })).toBe(undefined)
  await ui.press({ key: 'menu' })
  expect(await label(ui, 'menu-sessions')).toBe('sessions ▸')
  expect(await label(ui, 'menu-skills')).toBe('skills ▸')
  await ui.press({ key: 'menu-sessions' })
  // This alpha session counts among the alpha ones.
  expect(await label(ui, 'sessions-alpha')).toBe('alpha (2)')
  expect(await label(ui, 'sessions-beta')).toBe('beta (3)')
  expect(await label(ui, 'sessions-new')).toBe('+ new session')

  await ui.press({ key: 'sessions-beta' })
  expect(await label(ui, 'open-partner')).toBe('api  ● window')
  expect(await label(ui, 'open-bg')).toBe('ui  ◌ background')
  // A session opened by hand is listed, not openable.
  expect(await ui.find({ key: 'open-hand' })).toBe(undefined)
  expect(await textsOf(ui)).toContain('unnamed · hand  opened by hand')

  await ui.press({ key: 'menu-back' })
  expect(await label(ui, 'sessions-alpha')).toBe('alpha (2)')
  await ui.press({ key: 'sessions-alpha' })
  expect(await label(ui, 'open-alpha2')).toBe('jobs  ● window')
  expect(await textsOf(ui)).toContain('unnamed · me  · this session')
  await ui.press({ key: 'menu' })
  expect(await ui.find({ key: 'open-alpha2' })).toBe(undefined)
  await ui.unmount()
})

test('a session in its window is brought forward, a background one attached in its window', async ($, on) => {
  const { clock, seen } = engine(on, SESSIONS())
  await startIn($, clock)

  const ui = await mount($)
  await openSessions(ui)
  await ui.press({ key: 'sessions-beta' })
  await ui.press({ key: 'open-partner' })
  // The menu closed once the window came up.
  expect(await ui.find({ key: 'open-bg' })).toBe(undefined)
  await openSessions(ui)
  await ui.press({ key: 'sessions-beta' })
  await ui.press({ key: 'open-bg' })
  await ui.unmount()

  const bg = entry({ sessionId: 'bg', name: 'ui', window: null, background: true })
  expect(seen.ran).toEqual([focusArgv('ew-beta-api'), attachArgv(bg, 'C:/repos/beta', 'ew-beta-ui')])
  expect(seen.toasts).toEqual(['Switched to beta · api.', 'Opening beta · ui…'])
})

test('a repository the session edited, with no session open, offers a new session of it', async ($, on) => {
  const { clock } = engine(on, {})
  on('tool.call', () => ({ result: { marker: 'core' } }))
  await startIn($, clock)
  await $.tool.call({ tool: 'Write', file_path: 'C:/repos/beta/a.js', content: 'x' })

  const ui = await mount($)
  await openSessions(ui)
  await ui.press({ key: 'sessions-beta' })
  expect(await textsOf(ui)).toContain('no open session')
  await ui.press({ key: 'sessions-new-beta' })
  expect(await ui.find({ key: 'session-name' })).not.toBe(undefined)
  expect(await textsOf(ui)).toContain('new beta session')
  await ui.unmount()
})

test('new session: pick the repository, type the name; a refused name starts nothing, a good one starts it', async ($, on) => {
  const { clock, seen } = engine(on, SESSIONS())
  await startIn($, clock)

  const ui = await mount($)
  await openSessions(ui)
  await ui.press({ key: 'sessions-new' })
  await ui.press({ key: 'new-beta' })

  // The reason shows while typing.
  await ui.input({ key: 'session-name', text: 'API', kind: 'change' })
  expect(await textsOf(ui)).toContain('api is already open')
  await ui.input({ key: 'session-name', text: 'login fix' })
  expect(seen.ran).toEqual([])
  expect(seen.toasts).toEqual(['Not created: letters, digits and - _ . only, no spaces.'])
  // Still on the name, with what was typed.
  expect((await ui.find({ key: 'session-name' }))?.props.value).toBe('login fix')

  await ui.input({ key: 'session-name', text: ' login-fix ' })
  expect(await ui.find({ key: 'session-name' })).toBe(undefined)
  await ui.unmount()

  expect(seen.ran).toEqual([newSessionArgv(BETA, 'C:/repos/beta', 'login-fix')])
  expect(seen.toasts[seen.toasts.length - 1]).toBe('Opening beta · login-fix…')
})

test('a session the menu created registers its name and window', async ($, on) => {
  const files: Record<string, string> = {}
  const { clock } = engine(on, files, undefined, { env: { EW_WT_WINDOW: 'ew-alpha-jobs', EW_SESSION_NAME: 'jobs' } })
  await startIn($, clock)

  const own = parseEntry(files[`${REGISTRY}/${ME}.json`] ?? '')
  expect(own?.name).toBe('jobs')
  expect(own?.window).toBe('ew-alpha-jobs')
  expect(own?.background).toBe(false)
})

test('a background session keeps its name and claims no window', async ($, on) => {
  const files: Record<string, string> = {}
  const { clock } = engine(on, files, undefined, {
    env: {
      EW_WT_WINDOW: 'ew-alpha-jobs',
      EW_SESSION_NAME: 'jobs',
      CLAUDE_JOB_DIR: 'C:\\Users\\me\\.claude\\jobs\\x',
    },
  })
  await startIn($, clock)

  const own = parseEntry(files[`${REGISTRY}/${ME}.json`] ?? '')
  expect(own?.name).toBe('jobs')
  expect(own?.window).toBe(null)
  expect(own?.background).toBe(true)
})

test('a session started by hand below the repository does not claim the window it inherited', async ($, on) => {
  const files: Record<string, string> = {}
  const { clock } = engine(on, files, undefined, { env: { EW_WT_WINDOW: 'ew-beta' } })
  await startIn($, clock, 'C:\\repos\\beta\\app-react')

  expect(parseEntry(files[`${REGISTRY}/${ME}.json`] ?? '')?.window).toBe(null)
})

test('/workflow sessions beta opens the sessions menu on the beta list', async ($, on) => {
  const { clock } = engine(on, SESSIONS())
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await startIn($, clock)

  const ran = await $.command.run({ command: 'workflow', args: 'sessions beta' } as never)
  expect(String((ran as { text?: unknown }).text)).toContain('sessions menu')

  const ui = await mount($)
  expect(await label(ui, 'open-partner')).toBe('api  ● window')
  await ui.unmount()
})

const LOCAL = String.raw`C:\Users\me\AppData\Local`
const WT = String.raw`C:\Users\me\AppData\Local\Microsoft\WindowsApps\wt.exe`

test('Windows Terminal is run by its full path first', async ($, on) => {
  const { clock, seen } = engine(on, SESSIONS(), undefined, { env: { LOCALAPPDATA: LOCAL } })
  await startIn($, clock)

  const ui = await mount($)
  await openSessions(ui)
  await ui.press({ key: 'sessions-beta' })
  await ui.press({ key: 'open-partner' })
  await ui.unmount()

  expect(wtPath(LOCAL)).toBe(WT)
  expect(seen.ran).toEqual([focusArgv('ew-beta-api', WT)])
})

test('when the full path cannot start, the name is tried; when neither can, the error is kept whole', async ($, on) => {
  const files: Record<string, string> = SESSIONS()
  const { clock, seen } = engine(on, files, undefined, { env: { LOCALAPPDATA: LOCAL }, cannotStart: () => true })
  await startIn($, clock)

  const ui = await mount($)
  await openSessions(ui)
  await ui.press({ key: 'sessions-beta' })
  await ui.press({ key: 'open-partner' })
  await ui.unmount()

  expect(seen.ran.map(argv => argv[0])).toEqual([WT, 'wt.exe'])
  const kept = files[errorFile(REGISTRY)] ?? ''
  expect(kept).toContain('session cwd: C:/repos/alpha')
  expect(kept).toContain(`${WT}:`)
  expect(kept).toContain('wt.exe failed to start')
})

test('skills ▸ in a repository session without skills says why', async ($, on) => {
  const { clock } = engine(on, {})
  await startIn($, clock)

  const ui = await mount($)
  await ui.press({ key: 'menu' })
  await ui.press({ key: 'menu-skills' })
  expect(await textsOf(ui)).toContain('alpha skills')
  // The test engine has no skills folder to read: the reason shows in place of the list.
  expect(await textsOf(ui)).toContain('could not read the skills')
  await ui.press({ key: 'menu-back' })
  expect(await label(ui, 'menu-sessions')).toBe('sessions ▸')
  await ui.unmount()
})

test('outside any repository skills ▸ says where they show', async ($, on) => {
  const { clock } = engine(on, {})
  await startIn($, clock, 'C:/Users')

  const ui = await mount($)
  await ui.press({ key: 'menu' })
  await ui.press({ key: 'menu-skills' })
  expect(await textsOf(ui)).toContain('skills show in a session inside a Git repository')
  await ui.unmount()
})

const CLOSABLE = () => ({
  [`${REGISTRY}/partner.json`]: JSON.stringify(entry({ pid: 4242 })),
  [`${REGISTRY}/bg.json`]: JSON.stringify(entry({ sessionId: 'bg', name: 'ui', window: null, background: true })),
  [`${REGISTRY}/nopid.json`]: JSON.stringify(entry({ sessionId: 'nopid', name: 'old' })),
})

test('✕ shows on the sessions it can close: in the background or with a known process, never this one', async ($, on) => {
  const { clock } = engine(on, CLOSABLE())
  await startIn($, clock)

  const ui = await mount($)
  await openSessions(ui)
  await ui.press({ key: 'sessions-beta' })
  expect(await label(ui, 'close-partner')).toBe('✕')
  expect(await label(ui, 'close-bg')).toBe('✕')
  expect(await ui.find({ key: 'close-nopid' })).toBe(undefined)
  await ui.press({ key: 'menu-back' })
  await ui.press({ key: 'sessions-alpha' })
  expect(await ui.find({ key: 'close-me' })).toBe(undefined)
  await ui.unmount()
})

test('closing asks first; back closes nothing, confirming ends its claude and drops it from the list', async ($, on) => {
  const files = CLOSABLE()
  const { clock, seen } = engine(on, files, undefined, { env: { CLAUDE_CODE_EXECPATH: 'C:\bin\claude.exe' } })
  await startIn($, clock)

  const ui = await mount($)
  await openSessions(ui)
  await ui.press({ key: 'sessions-beta' })
  await ui.press({ key: 'close-partner' })
  expect(await textsOf(ui)).toContain('close beta · api?')
  await ui.press({ key: 'menu-back' })
  expect(seen.closes).toEqual([])
  expect(await label(ui, 'open-partner')).toBe('api  ● window')

  await ui.press({ key: 'close-partner' })
  await ui.press({ key: 'close-confirm' })
  // Back on the list, without it.
  expect(await ui.find({ key: 'open-partner' })).toBe(undefined)
  expect(await label(ui, 'open-bg')).toBe('ui  ◌ background')
  await ui.unmount()

  expect(seen.closes).toEqual([killArgv(4242)])
  expect(parseEntry(files[`${REGISTRY}/partner.json`] ?? '')?.isOpen).toBe(false)
  expect(seen.toasts[seen.toasts.length - 1]).toBe('Closed beta · api.')
})

test('a background session is stopped in the daemon', async ($, on) => {
  const { clock, seen } = engine(on, CLOSABLE(), undefined, { env: { CLAUDE_CODE_EXECPATH: 'C:\bin\claude.exe' } })
  await startIn($, clock)

  const ui = await mount($)
  await openSessions(ui)
  await ui.press({ key: 'sessions-beta' })
  await ui.press({ key: 'close-bg' })
  expect(await textsOf(ui)).toContain('stops it in the background')
  await ui.press({ key: 'close-confirm' })
  await ui.unmount()

  expect(seen.closes).toEqual([stopArgv('C:\bin\claude.exe', 'bg')])
  expect(seen.toasts[seen.toasts.length - 1]).toBe('Closed beta · ui.')
})

test('a process already gone is said so, and the session leaves the list', async ($, on) => {
  const files = CLOSABLE()
  const { clock, seen } = engine(on, files, undefined, { closeStdout: 'INFO: No tasks running with the specified criteria.' })
  await startIn($, clock)

  const ui = await mount($)
  await openSessions(ui)
  await ui.press({ key: 'sessions-beta' })
  await ui.press({ key: 'close-partner' })
  await ui.press({ key: 'close-confirm' })
  await ui.unmount()

  expect(seen.toasts[seen.toasts.length - 1]).toBe('beta · api was not running any more.')
  expect(parseEntry(files[`${REGISTRY}/partner.json`] ?? '')?.isOpen).toBe(false)
})

test('a session registers its claude process', async ($, on) => {
  const files: Record<string, string> = {}
  const { clock } = engine(on, files, undefined, { env: { CLAUDE_PID: '5564' } })
  await startIn($, clock)

  expect(parseEntry(files[`${REGISTRY}/${ME}.json`] ?? '')?.pid).toBe(5564)
})

test('without Windows Terminal the menu says so, and gives the commands to run by hand', async ($, on) => {
  const { clock, seen } = engine(on, SESSIONS(), undefined, { noWt: true })
  await startIn($, clock)

  const ui = await mount($)
  await openSessions(ui)
  expect(await textsOf(ui)).toContain(NO_WT)
  await ui.press({ key: 'sessions-beta' })
  expect(await textsOf(ui)).toContain(NO_WT)
  // A window cannot be brought forward; a background session gets its command.
  expect(await ui.find({ key: 'open-partner' })).toBe(undefined)
  expect(await textsOf(ui)).toContain('api  ● window  · in another window')
  expect(await label(ui, 'open-bg')).toBe('ui  ◌ background  · copy command')
  await ui.press({ key: 'open-bg' })
  expect(await textsOf(ui)).toContain('claude attach bg')
  await ui.press({ key: 'menu-back' })

  await ui.press({ key: 'menu-back' })
  await ui.press({ key: 'sessions-new' })
  await ui.press({ key: 'new-beta' })
  expect((await ui.find({ key: 'session-name' }))?.props.submitLabel).toBe('Show command')
  await ui.input({ key: 'session-name', text: 'login-fix' })
  expect(await textsOf(ui)).toContain('cd /d "C:\\repos\\beta" && claude --name login-fix')
  await ui.unmount()

  // Nothing was started.
  expect(seen.ran).toEqual([])
})

test('on macOS and Linux the command for a new session is for sh, and closing checks the process with ps', async ($, on) => {
  const files = { ...SESSIONS(), [`${REGISTRY}/partner.json`]: JSON.stringify(entry({ pid: 4242 })) }
  const { clock, seen } = engine(on, files, undefined, { env: { OS: '' } })
  await startIn($, clock, '/repos/alpha')

  const ui = await mount($)
  await openSessions(ui)
  await ui.press({ key: 'sessions-new' })
  await ui.press({ key: 'new-beta' })
  await ui.input({ key: 'session-name', text: 'login-fix' })
  expect(await textsOf(ui)).toContain("cd 'C:/repos/beta' && claude --name login-fix")
  await ui.press({ key: 'menu-back' })
  await ui.press({ key: 'menu-back' })
  await ui.press({ key: 'menu-back' })
  await ui.press({ key: 'sessions-beta' })
  await ui.press({ key: 'close-partner' })
  await ui.press({ key: 'close-confirm' })
  await ui.unmount()

  expect(seen.closes).toEqual([killArgv(4242, false)])
  expect(seen.ran).toEqual([])
})
