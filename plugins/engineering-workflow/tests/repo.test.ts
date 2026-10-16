import { describe, expect, test } from 'claude-code/testing'

import { labelOf, locate, parentOf, parseToplevel, repoId, repoLabels, toplevelArgv, withRepo } from '../hooks/repo'
import { repoLabel } from '../hooks/tracker'
import { menuRepos } from '../hooks/switcher'
import type { SessionEntry } from '../types'

describe('repositories', () => {
  test('a repository goes by its root, lower-cased, and joins once', () => {
    expect(repoId('C:\\Repos\\Alpha\\')).toBe('c:/repos/alpha')
    const one = withRepo({}, 'C:/Repos/Alpha')
    expect(one).toEqual({ 'c:/repos/alpha': 'C:/Repos/Alpha' })
    expect(withRepo(one, 'c:\\repos\\alpha')).toBe(one)
    expect(Object.keys(withRepo(one, '/home/me/beta'))).toEqual(['c:/repos/alpha', '/home/me/beta'])
  })

  test('a file belongs to the deepest repository holding it', () => {
    const roots = { outer: 'C:/work/app', inner: 'C:/work/app/vendor/lib' }
    expect(locate(roots, 'C:/work', 'app/src/a.ts')).toEqual({ repo: 'outer', relative: 'src/a.ts' })
    expect(locate(roots, 'C:/work', 'app/vendor/lib/b.ts')).toEqual({ repo: 'inner', relative: 'b.ts' })
    expect(locate(roots, 'C:/work', 'C:/work/other/c.ts')).toBe(null)
  })

  test('labels are folder names, with the folder above when two share one', () => {
    const labels = repoLabels({ a: 'C:/work/api', b: 'C:/personal/api', c: '/home/me/web' })
    expect(labels).toEqual({ a: 'api (work)', b: 'api (personal)', c: 'web' })
    // The same name twice above as well: the whole root.
    expect(repoLabels({ a: 'C:/x/api', b: 'D:/x/api' })).toEqual({ a: 'C:/x/api', b: 'D:/x/api' })
    expect(labelOf(labels, 'a')).toBe('api (work)')
    expect(labelOf(labels, 'c:/unknown/thing')).toBe('thing')
    expect(labelOf(labels, null)).toBe('—')
  })

  test('the band names the repositories at work: one, or the first and how many more', () => {
    const labels = { a: 'api', b: 'web', c: 'docs' }
    expect(repoLabel([], labels)).toBe('—')
    expect(repoLabel(['a'], labels)).toBe('api')
    expect(repoLabel(['b', 'a', 'c'], labels)).toBe('web +2')
  })

  test('git toplevel: asked of a directory, read back as one absolute path', () => {
    expect(toplevelArgv('C:/repos/alpha/src')).toEqual(['git', '--no-optional-locks', '-C', 'C:/repos/alpha/src', 'rev-parse', '--show-toplevel'])
    expect(parseToplevel('C:/repos/alpha\n')).toBe('C:/repos/alpha')
    expect(parseToplevel('/home/me/web\n')).toBe('/home/me/web')
    expect(parseToplevel('')).toBe(null)
    expect(parseToplevel('fatal: not a git repository')).toBe(null)
    expect(parentOf('C:/x')).toBe('C:/')
    expect(parentOf('/home')).toBe('/')
  })

  test('the sessions menu lists this repository first, then those of the open sessions, then the edited ones', () => {
    const open = [
      { sessionId: 's1', repo: 'c:/w/web', repoRoot: 'C:/w/web' },
      { sessionId: 's2', repo: 'c:/w/api', repoRoot: 'C:/w/api' },
      { sessionId: 's3', repo: null },
    ] as SessionEntry[]
    const listed = menuRepos('c:/w/api', { 'c:/w/api': 'C:/w/api', 'c:/w/docs': 'C:/w/docs' }, open)
    expect(Object.entries(listed)).toEqual([
      ['c:/w/api', 'C:/w/api'],
      ['c:/w/web', 'C:/w/web'],
      ['c:/w/docs', 'C:/w/docs'],
    ])
  })
})
