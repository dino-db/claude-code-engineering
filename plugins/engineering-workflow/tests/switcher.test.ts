import { describe, expect, test } from 'claude-code/testing'

import {
  attachArgv,
  attachCommand,
  newSessionCommand,
  closePlan,
  entryLabel,
  errorFile,
  focusArgv,
  killArgv,
  nameProblem,
  newSessionArgv,
  openPlan,
  openSessions,
  parseEntry,
  parsePid,
  registryDir,
  repoWindow,
  sessionLook,
  sessionName,
  sessionWindow,
  slug,
  stopArgv,
  trustedWindow,
  wtPath,
} from '../hooks/switcher'
import type { SessionEntry } from '../types'

const NOW = 1_000_000
const REGISTRY = 'C:/T/engineering-workflow/sessions'
const ID = 'f1872805-c9f1-4560-9c16-9146d0e7efc8'

function entry(fields: Partial<SessionEntry>): SessionEntry {
  return { sessionId: 's', repo: 'beta', cwd: '', name: null, window: null, pid: null, updatedAt: NOW, isOpen: true, ...fields }
}

describe('names', () => {
  test('a name is letters, digits and - _ . without spaces, unique by its slug in the repository', () => {
    const open = [entry({ name: 'Login-Fix' }), entry({ name: null })]
    expect(nameProblem('api-auth', open)).toBe(null)
    expect(nameProblem('  api_v2.1  ', open)).toBe(null)
    expect(nameProblem('', open)).toBe('type a name')
    expect(nameProblem('   ', open)).toBe('type a name')
    expect(nameProblem('x'.repeat(41), open)).toBe('at most 40 characters')
    expect(nameProblem('api auth', open)).toBe('letters, digits and - _ . only, no spaces')
    expect(nameProblem('a&b', open)).toBe('letters, digits and - _ . only, no spaces')
    expect(nameProblem('--', open)).toBe('needs a letter or a digit')
    // Same window: login.fix and Login-Fix would both run in ew-beta-login-fix.
    expect(nameProblem('login.fix', open)).toBe('Login-Fix is already open')
  })

  test('slugs and windows', () => {
    expect(slug('Login.Fix_2')).toBe('login-fix-2')
    expect(slug('-a-')).toBe('a')
    expect(repoWindow('alpha')).toBe('ew-alpha')
    expect(sessionWindow('alpha', 'API.v2')).toBe('ew-alpha-api-v2')
  })

  test('the name read from the variable is kept only when the menu could have given it', () => {
    expect(sessionName(' api-auth ')).toBe('api-auth')
    expect(sessionName('')).toBe(null)
    expect(sessionName(undefined)).toBe(null)
    expect(sessionName('a b')).toBe(null)
  })

  test('the menu names a session by its name, or as unnamed with its short id', () => {
    expect(entryLabel(entry({ name: 'api-auth' }))).toBe('api-auth')
    expect(entryLabel(entry({ sessionId: ID }))).toBe('unnamed · f1872805')
  })
})

describe('sessions', () => {
  test('open sessions of a repository, the most recently heard first; closed, stale and other ones left out', () => {
    const entries = [
      entry({ sessionId: 'closed', isOpen: false }),
      entry({ sessionId: 'stale', updatedAt: NOW - 60_000 }),
      entry({ sessionId: 'alpha', repo: 'alpha' }),
      entry({ sessionId: 'older', updatedAt: NOW - 5_000 }),
      entry({ sessionId: 'newer', updatedAt: NOW - 1_000 }),
    ]
    expect(openSessions(entries, 'beta', NOW).map(e => e.sessionId)).toEqual(['newer', 'older'])
  })

  test('how a session stands, and how it opens', () => {
    const windowed = entry({ sessionId: 'w', window: 'ew-beta-api' })
    const background = entry({ sessionId: ID, name: 'api', background: true })
    const unnamedBackground = entry({ sessionId: ID, background: true })
    const hand = entry({ sessionId: 'h' })
    expect(sessionLook(entry({ sessionId: 'me' }), 'me')).toBe('self')
    expect(sessionLook(windowed, 'me')).toBe('window')
    expect(sessionLook(background, 'me')).toBe('background')
    expect(sessionLook(hand, 'me')).toBe('hand')

    expect(openPlan(entry({ sessionId: 'me' }), 'me')).toEqual({ kind: 'here' })
    expect(openPlan(windowed, 'me')).toEqual({ kind: 'focus', window: 'ew-beta-api' })
    expect(openPlan(background, 'me')).toEqual({ kind: 'attach', window: 'ew-beta-api' })
    expect(openPlan(unnamedBackground, 'me')).toEqual({ kind: 'attach', window: 'ew-beta' })
    expect(openPlan(hand, 'me')).toEqual({ kind: 'unreachable' })
  })

  test('Windows Terminal commands, and the ones to run by hand without it', () => {
    expect(newSessionArgv('c:/repos/beta', 'C:/repos/beta', 'login-fix')).toEqual([
      'wt.exe', '-w', 'ew-beta-login-fix', 'new-tab', '--title', 'beta · login-fix', '--suppressApplicationTitle',
      '-d', 'C:\\repos\\beta', 'cmd', '/k',
      'set EW_WT_WINDOW=ew-beta-login-fix&& set EW_SESSION_NAME=login-fix&& claude --name login-fix',
    ])
    expect(attachArgv(entry({ sessionId: ID, repo: 'alpha', name: 'api' }), 'C:/repos/alpha', 'ew-alpha-api')).toEqual([
      'wt.exe', '-w', 'ew-alpha-api', 'new-tab', '--title', 'alpha · api', '--suppressApplicationTitle',
      '-d', 'C:\\repos\\alpha', 'cmd', '/k', 'claude attach f1872805',
    ])
    expect(attachCommand(entry({ sessionId: ID }))).toBe('claude attach f1872805')
    expect(newSessionCommand('C:/repos/beta', 'login-fix', true)).toBe('cd /d "C:\\repos\\beta" && claude --name login-fix')
    expect(newSessionCommand("/home/me/it's", 'login-fix', false)).toBe("cd '/home/me/it'\\''s' && claude --name login-fix")
    expect(focusArgv('ew-alpha')).toEqual(['wt.exe', '-w', 'ew-alpha', 'focus-tab', '-t', '0'])
    expect(wtPath('C:\\Users\\me\\AppData\\Local')).toBe('C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe')
    expect(registryDir('C:\\T\\')).toBe(REGISTRY)
    expect(errorFile(REGISTRY)).toBe('C:/T/engineering-workflow/last-switch-error.txt')
  })

  test('how a session closes: stopped in the daemon, its claude ended in a window, never this one', () => {
    const exe = 'C:\\Users\\me\\.local\\bin\\claude.exe'
    expect(closePlan(entry({ sessionId: 'me', pid: 7 }), 'me')).toEqual({ kind: 'here' })
    expect(closePlan(entry({ sessionId: ID, background: true, pid: 7 }), 'me')).toEqual({ kind: 'stop' })
    expect(closePlan(entry({ window: 'ew-beta-api', pid: 4242 }), 'me')).toEqual({ kind: 'kill', pid: 4242 })
    expect(closePlan(entry({ pid: 4242 }), 'me')).toEqual({ kind: 'kill', pid: 4242 })
    expect(closePlan(entry({ window: 'ew-beta-api' }), 'me')).toEqual({ kind: 'unreachable' })
    expect(stopArgv(exe, ID)).toEqual([exe, 'stop', 'f1872805'])
    // Only a claude.exe of that id: a pid taken by another program since is left alone.
    expect(killArgv(4242)).toEqual(['taskkill', '/PID', '4242', '/FI', 'IMAGENAME eq claude.exe', '/T', '/F'])
    // Elsewhere ps says first whether the pid is still a claude.
    expect(killArgv(4242, false)).toEqual(['sh', '-c', 'ps -p 4242 -o comm= | grep -qi claude && kill 4242 || echo "No tasks running"'])
    expect(parsePid('5564')).toBe(5564)
    expect(parsePid(' 12 ')).toBe(12)
    expect(parsePid('')).toBe(null)
    expect(parsePid('x1')).toBe(null)
    expect(parsePid(undefined)).toBe(null)
  })

  test('entries parse with their name and pid; an old one has neither', () => {
    expect(parseEntry('not json')).toBe(null)
    expect(parseEntry(JSON.stringify(entry({ name: 'api', pid: 9 })))?.name).toBe('api')
    expect(parseEntry(JSON.stringify(entry({ name: 'api', pid: 9 })))?.pid).toBe(9)
    const old = JSON.stringify({ sessionId: 's', repo: 'alpha', cwd: '', window: null, updatedAt: NOW, isOpen: true })
    expect(parseEntry(old)?.name).toBe(null)
    expect(parseEntry(old)?.pid).toBe(null)
    expect(parseEntry(JSON.stringify(entry({ background: true })))?.background).toBe(true)
    expect(parseEntry(JSON.stringify(entry({})))?.background).toBe(false)
  })
})

describe('windows', () => {
  test('a window name counts only for a session started where the menu starts it', () => {
    const roots = { alpha: 'C:/repos/alpha', beta: 'C:/repos/beta' }
    expect(trustedWindow('ew-beta', 'C:/repos/beta', 'beta', roots)).toBe('ew-beta')
    expect(trustedWindow('ew-beta-api', 'c:/Repos/Beta/', 'beta', roots)).toBe('ew-beta-api')
    // Started by hand from a shell that inherited the name: not in that window for sure.
    expect(trustedWindow('ew-beta', 'C:/repos/beta/app-react', 'beta', roots)).toBe(null)
    expect(trustedWindow('ew-beta-api', 'C:/repos/alpha', 'alpha', roots)).toBe(null)
    expect(trustedWindow('ew-betax', 'C:/repos/beta', 'beta', roots)).toBe(null)
    expect(trustedWindow(null, 'C:/repos/beta', 'beta', roots)).toBe(null)
    expect(trustedWindow('ew-beta', 'C:/Users', null, roots)).toBe(null)
    // A background session runs in the daemon, in no window, whatever it inherited.
    expect(trustedWindow('ew-beta', 'C:/repos/beta', 'beta', roots, true)).toBe(null)
  })
})
