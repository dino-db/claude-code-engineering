import type { Phase, Repo, RepoRoots, Verdict } from '../types'
import { baseName, locate, normalizePath, parentOf, pathKey, repoLabels } from './repo'

export const PHASES: readonly Phase[] = ['explore', 'plan', 'implement', 'verify']

export const PHASE_LABEL: Record<Phase, string> = {
  explore: 'Explore',
  plan: 'Plan',
  implement: 'Implement',
  verify: 'Verify',
}

export type Roots = RepoRoots

export { baseName, locate, normalizePath, parentOf, pathKey, resolvePath } from './repo'

export function repoOfCwd(roots: Roots, cwd: string): Repo | null {
  return locate(roots, cwd, cwd)?.repo ?? null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The known repositories a shell command names: absolute paths in either
 * spelling, or folder names relative to the session's directory. A command
 * naming none runs in the session's directory.
 */
export function reposOfCommand(roots: Roots, cwd: string, command: string): Repo[] {
  const text = command
    .replace(/\\/g, '/')
    .replace(/(^|[\s"'=(:;&|])\/([a-zA-Z])\//g, '$1$2:/')
    .toLowerCase()
  const cwdKey = pathKey(cwd)
  const found = new Set<Repo>()

  for (const repo of Object.keys(roots)) {
    const root = pathKey(roots[repo] ?? repo)
    if (text.includes(root)) {
      found.add(repo)
      continue
    }
    const name = escapeRegExp(baseName(root))
    const parent = parentOf(root)
    const edge = `(?=/|["'\\s;)&|]|$)`
    const lead = `(^|[\\s"'=;(&|])`
    if (cwdKey === parent && new RegExp(`${lead}(\\./)?${name}${edge}`).test(text)) {
      found.add(repo)
    } else if (parentOf(cwdKey) === parent && new RegExp(`${lead}\\.\\./${name}${edge}`).test(text)) {
      found.add(repo)
    }
  }

  if (found.size === 0) {
    const own = repoOfCwd(roots, cwd)
    if (own) found.add(own)
  }
  return Object.keys(roots).filter(repo => found.has(repo))
}

const PYTHON = String.raw`(\S*[\\/])?python3?(\.exe)?`
const SEGMENT = String.raw`(^|[;&|]\s*)`

const RUNNER = String.raw`(npm|yarn|pnpm|bun)\s+(run\s+)?(test|lint|build|check|typecheck)(:[\w-]+)?`
const END = String.raw`(\s|$)`

/** Commands that test, lint, type-check or build, across the common toolchains. */
const VALIDATION = [
  // JavaScript and TypeScript.
  new RegExp(`${SEGMENT}${RUNNER}${END}`, 'i'),
  /(^|[;&|]\s*)(npx|bunx|pnpm\s+exec|yarn)\s+(jest|vitest|mocha|eslint|tsc|playwright)(\s|$)/i,
  /(^|[;&|]\s*)(jest|vitest|tsc|eslint)(\s|$)/i,
  // Python.
  new RegExp(String.raw`${SEGMENT}(${PYTHON}\s+-m\s+)?pytest${END}`, 'i'),
  new RegExp(String.raw`${SEGMENT}${PYTHON}\s+-m\s+(unittest|py_compile|compileall|mypy)${END}`, 'i'),
  /(^|[;&|]\s*)(uv\s+run\s+|poetry\s+run\s+)?(pytest|ruff\s+check|mypy|pyright|pylint|flake8|tox|nox)(\s|$)/i,
  // JVM.
  /(^|[;&|]\s*)(\S*[\\/])?mvnw?(\.cmd)?\s+(\S+\s+)*(test|verify|package|install)(\s|$)/i,
  /(^|[;&|]\s*)(\S*[\\/])?gradlew?(\.bat)?\s+(\S+\s+)*(test|check|build)(\s|$)/i,
  // Go, Rust, .NET, make.
  /(^|[;&|]\s*)go\s+(test|vet|build)(\s|$)/i,
  /(^|[;&|]\s*)cargo\s+(test|check|clippy|build|nextest)(\s|$)/i,
  /(^|[;&|]\s*)dotnet\s+(test|build)(\s|$)/i,
  /(^|[;&|]\s*)make\s+(\S+\s+)*(test|check|lint)(\s|$)/i,
]

export function compactCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

/**
 * A run the person interrupted: an interrupt
 * message, or the exit code of Ctrl+C (130 on POSIX, 3221225786 on Windows).
 */
export function isInterruptedRun(text: string): boolean {
  return /KeyboardInterrupt|interrupted by (the )?user|exit(ed)?\s+(with\s+)?code\s*(130|3221225786)\b/i.test(text)
}

export function isValidationCommand(command: string): boolean {
  const normalized = compactCommand(command)
  return VALIDATION.some(pattern => pattern.test(normalized))
}

/** Each simple command of a pipeline or list, with a leading `cd ... &&` kept as its own. */
function segments(command: string): string[] {
  return compactCommand(command)
    .split(/&&|\|\||[;|]/)
    .map(part => part.trim())
    .filter(Boolean)
}

const READ_ONLY = /^(git\s+(-C\s+\S+\s+)?(log|show|blame|ls-files|grep|status|branch|rev-parse|diff)|ls|dir|cat|head|tail|less|find|grep|rg|wc|tree|file|stat|pwd|echo|which|type|sed\s+-n|awk)\b/i

const GIT_DIFF = /^git\s+(-C\s+\S+\s+)?diff\b/i

/** True when every segment only reads (cd included). */
export function isReadOnlyCommand(command: string): boolean {
  const parts = segments(command)
  return parts.length > 0 && parts.every(part => /^cd\b/i.test(part) || READ_ONLY.test(part))
}

export function isGitDiff(command: string): boolean {
  return segments(command).some(part => GIT_DIFF.test(part))
}

export function mentionsGit(command: string): boolean {
  return segments(command).some(part => /^git\b/i.test(part))
}

/** The workflow phase a subagent type stands for. */
export function phaseOfAgent(type: string): Phase | null {
  const name = type.slice(type.lastIndexOf(':') + 1)
  switch (name) {
    case 'codebase-explorer':
    case 'Explore':
      return 'explore'
    case 'implementation-planner':
    case 'Plan':
      return 'plan'
    case 'implementation-executor':
      return 'implement'
    case 'implementation-verifier':
      return 'verify'
    default:
      return null
  }
}

export function isVerifier(type: string): boolean {
  return type.slice(type.lastIndexOf(':') + 1) === 'implementation-verifier'
}

/** The verdict in the verifier's final message: PASS, CONDITIONAL PASS or FAIL. */
export function parseVerdict(message: string): Verdict {
  if (/\bconditional\s+pass\b/i.test(message)) return 'CONDITIONAL PASS'
  if (/\bfail(ed|ure)?\b/i.test(message)) return 'FAIL'
  if (/\bpass(ed)?\b/i.test(message)) return 'PASS'
  return 'UNKNOWN'
}

const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'LSP', 'WebFetch', 'WebSearch', 'NotebookRead'])
const PLAN_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'TodoWrite', 'TaskCreate', 'TaskUpdate'])
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** What one finished tool call tells about the workflow. */
export type ToolSignal = {
  hint: Phase | null
  repos: Repo[]
  edits: { repo: Repo; relative: string }[]
  validation: { command: string; isOk: boolean; isInterrupted: boolean; repo: Repo | null } | null
  isGitDiff: boolean
  touchesGit: boolean
  text: string
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function shorten(text: string, max = 72): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function classifyTool(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  isOk: boolean,
  roots: Roots,
  cwd: string,
  isInterrupted = false,
): ToolSignal | null {
  const signal: ToolSignal = {
    hint: null,
    repos: [],
    edits: [],
    validation: null,
    isGitDiff: false,
    touchesGit: false,
    text: tool,
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = str(input.command)
    if (!command) return null
    signal.repos = reposOfCommand(roots, cwd, command)
    signal.touchesGit = mentionsGit(command)
    signal.text = `$ ${shorten(compactCommand(command))}`
    if (isValidationCommand(command)) {
      signal.hint = 'verify'
      signal.validation = { command: compactCommand(command), isOk, isInterrupted, repo: signal.repos[0] ?? null }
      signal.text += isInterrupted ? '  ■ stopped by you' : isOk ? '  ✓' : '  ✗'
    } else if (isGitDiff(command)) {
      signal.hint = 'explore'
      signal.isGitDiff = true
    } else if (isReadOnlyCommand(command)) {
      signal.hint = 'explore'
    }
    return signal
  }

  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  const place = path ? locate(roots, cwd, path) : null
  if (place) signal.repos = [place.repo]
  const where = place ? `${repoLabels(roots)[place.repo] ?? baseName(place.repo)}/${place.relative}` : ''

  if (EDIT_TOOLS.has(tool)) {
    if (!path || !isOk) return null
    if (/\/\.claude\/plans\//i.test(normalizePath(path))) {
      signal.hint = 'plan'
      signal.text = `${tool} plan ${baseName(path)}`
      return signal
    }
    if (!place) return null
    signal.hint = 'implement'
    signal.edits = [{ repo: place.repo, relative: place.relative }]
    signal.text = `${tool} ${where}`
    return signal
  }

  if (EXPLORE_TOOLS.has(tool)) {
    signal.hint = 'explore'
    signal.text = place ? `${tool} ${place.relative ? where : `${where}.`}` : tool
    return signal
  }

  if (PLAN_TOOLS.has(tool)) {
    signal.hint = 'plan'
    return signal
  }

  return null
}
