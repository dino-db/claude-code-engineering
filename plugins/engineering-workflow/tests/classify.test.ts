import { describe, expect, test } from 'claude-code/testing'

import {
  classifyTool,
  isValidationCommand,
  locate,
  parseVerdict,
  phaseOfAgent,
  reposOfCommand,
  resolvePath,
} from '../hooks/classify'

const roots = { alpha: 'C:/repos/alpha', beta: 'C:/repos/beta' }

describe('paths', () => {
  test('locates Windows, MSYS and relative spellings', () => {
    expect(locate(roots, 'C:/repos/alpha', 'C:\\repos\\alpha\\plugin_dev\\a.py')).toEqual({
      repo: 'alpha',
      relative: 'plugin_dev/a.py',
    })
    expect(locate(roots, 'C:/repos/alpha', '/c/repos/beta/app/x.js')?.repo).toBe('beta')
    expect(locate(roots, 'C:/repos/alpha', '../beta/node/y.js')).toEqual({ repo: 'beta', relative: 'node/y.js' })
    expect(locate(roots, 'c:/REPOS/alpha', 'docs/a.md')?.relative).toBe('docs/a.md')
    expect(locate(roots, 'C:/repos/alpha', 'C:/Users/me/.claude/plans/p.md')).toBe(null)
    expect(locate(roots, 'C:/repos', 'alphay/a.py')).toBe(null)
  })

  test('resolves dot segments', () => {
    expect(resolvePath('C:/repos/alpha', './a/../b.py')).toBe('C:/repos/alpha/b.py')
  })

  test('finds repositories in commands', () => {
    expect(reposOfCommand(roots, 'C:/repos/alpha', 'pytest plugin_dev')).toEqual(['alpha'])
    expect(reposOfCommand(roots, 'C:/repos', 'git -C alpha status && git -C beta status')).toEqual(['alpha', 'beta'])
    expect(reposOfCommand(roots, 'C:/repos/alpha', 'cd ../beta && npm test')).toEqual(['beta'])
    expect(reposOfCommand(roots, 'C:/repos/notes', 'cat /c/repos/beta/CLAUDE.md')).toEqual(['beta'])
    expect(reposOfCommand(roots, 'C:/repos/notes', 'ls')).toEqual([])
  })
})

describe('commands', () => {
  test('recognises validation commands across toolchains', () => {
    for (const command of [
      'pytest -v -n 4 -m "not integration"',
      'cd src && ../.venv/Scripts/python.exe -m pytest a.py',
      'python -m py_compile a.py',
      'ruff check .',
      'uv run pytest',
      'npm run test:unit',
      'pnpm typecheck',
      'npx jest src',
      'npx vitest run',
      'mvn -q test',
      './gradlew check',
      'go test ./...',
      'cargo clippy',
      'dotnet test',
      'make test',
    ]) {
      expect(isValidationCommand(command)).toBe(true)
    }
    for (const command of ['git status', 'cat pytest.ini', 'npm install', 'go run .', 'cargo run', 'make install']) {
      expect(isValidationCommand(command)).toBe(false)
    }
  })

  test('maps agents to phases', () => {
    expect(phaseOfAgent('codebase-explorer')).toBe('explore')
    expect(phaseOfAgent('Explore')).toBe('explore')
    expect(phaseOfAgent('implementation-planner')).toBe('plan')
    expect(phaseOfAgent('implementation-executor')).toBe('implement')
    expect(phaseOfAgent('implementation-verifier')).toBe('verify')
    expect(phaseOfAgent('general-purpose')).toBe(null)
  })

  test('parses the verifier verdicts', () => {
    expect(parseVerdict('## Verdict\nCONDITIONAL PASS')).toBe('CONDITIONAL PASS')
    expect(parseVerdict('Verdict: FAIL')).toBe('FAIL')
    expect(parseVerdict('Verdict: PASS')).toBe('PASS')
    expect(parseVerdict('done')).toBe('UNKNOWN')
  })
})

describe('tool signals', () => {
  test('an edit in a repository is Implement', () => {
    const signal = classifyTool('Edit', { file_path: 'C:\\repos\\alpha\\plugin_dev\\m.py' }, true, roots, 'C:/repos/alpha')
    expect(signal?.hint).toBe('implement')
    expect(signal?.edits).toEqual([{ repo: 'alpha', relative: 'plugin_dev/m.py' }])
  })

  test('a failed edit and an edit outside the repositories are ignored', () => {
    expect(classifyTool('Edit', { file_path: 'C:/repos/alpha/a.py' }, false, roots, 'C:/repos/alpha')).toBe(null)
    expect(classifyTool('Write', { file_path: 'C:/tmp/a.py' }, true, roots, 'C:/repos/alpha')).toBe(null)
  })

  test('a plan file is Plan', () => {
    const signal = classifyTool('Write', { file_path: 'C:/Users/me/.claude/plans/x.md' }, true, roots, 'C:/repos/alpha')
    expect(signal?.hint).toBe('plan')
    expect(signal?.edits).toEqual([])
  })

  test('reads are Explore, validations Verify', () => {
    expect(classifyTool('Grep', { pattern: 'x', path: 'plugin_dev' }, true, roots, 'C:/repos/alpha')?.hint).toBe('explore')
    expect(classifyTool('Bash', { command: 'git log -5' }, true, roots, 'C:/repos/alpha')?.hint).toBe('explore')
    const tests = classifyTool('Bash', { command: 'npm test' }, false, roots, 'C:/repos/beta')
    expect(tests?.hint).toBe('verify')
    expect(tests?.validation).toEqual({ command: 'npm test', isOk: false, isInterrupted: false, repo: 'beta' })
  })
})
