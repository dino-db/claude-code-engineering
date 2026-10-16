import type { Repo, RepoRoots } from '../types'

/*
 * The repositories a session works in, found rather than configured: the Git
 * toplevel of the session's directory, then the toplevel of each file it
 * edits. A repository goes by the normalized, lower-cased path of its root;
 * the pane names it by its folder. Pure: the hooks module runs git.
 */

/** Forward slashes, `/c/...` spelled `c:/...`, no duplicate or trailing slash. */
export function normalizePath(path: string): string {
  let value = path.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/')
  const drive = /^\/([a-zA-Z])(\/|$)/.exec(value)
  if (drive) {
    value = `${drive[1]}:/${value.slice(3)}`
  }
  value = value.replace(/\/{2,}/g, '/')
  return value.length > 3 ? value.replace(/\/$/, '') : value
}

/** Paths compare without case: a repository on Windows may be spelled either way. */
export function pathKey(path: string): string {
  return normalizePath(path).toLowerCase()
}

export function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path) || path.startsWith('/')
}

/** Resolves `path` against `cwd`, collapsing `.` and `..`. */
export function resolvePath(cwd: string, path: string): string {
  const target = normalizePath(path)
  const joined = isAbsolute(target) ? target : `${normalizePath(cwd)}/${target}`
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (part === '.' || (part === '' && parts.length > 0)) continue
    if (part === '..') {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

export function parentOf(path: string): string {
  const value = normalizePath(path)
  const index = value.lastIndexOf('/')
  if (index < 0) return value
  // The parent of `/x` is `/`, of `c:/x` is `c:/`.
  return index === 0 ? '/' : /^[a-zA-Z]:$/.test(value.slice(0, index)) ? value.slice(0, index + 1) : value.slice(0, index)
}

export function baseName(path: string): string {
  const value = normalizePath(path)
  return value.slice(value.lastIndexOf('/') + 1)
}

/** The id a repository goes by. */
export function repoId(root: string): Repo {
  return pathKey(root)
}

/** The roots with `root` added last; the same object when it is known already. */
export function withRepo(roots: RepoRoots, root: string): RepoRoots {
  const id = repoId(root)
  return id in roots ? roots : { ...roots, [id]: normalizePath(root) }
}

/** The repository holding `path` (the deepest root, for a repository nested in another) and the path relative to it. */
export function locate(roots: RepoRoots, cwd: string, path: string): { repo: Repo; relative: string } | null {
  const absolute = resolvePath(cwd, path)
  const key = absolute.toLowerCase()
  let found: { repo: Repo; relative: string; depth: number } | null = null
  for (const [repo, path] of Object.entries(roots)) {
    const root = pathKey(path).replace(/\/$/, '')
    if (key === root) return { repo, relative: '' }
    if (key.startsWith(`${root}/`) && (!found || root.length > found.depth)) {
      found = { repo, relative: absolute.slice(root.length + 1), depth: root.length }
    }
  }
  return found ? { repo: found.repo, relative: found.relative } : null
}

/**
 * How the pane names each repository: its folder, and the folder above it
 * when two share a name; the whole root when that is not enough either.
 */
export function repoLabels(roots: Readonly<Record<Repo, string>>): Record<Repo, string> {
  const ids = Object.keys(roots)
  const short = (id: string) => baseName(roots[id] ?? id) || (roots[id] ?? id)
  const longer = (id: string) => {
    const root = roots[id] ?? id
    const parent = baseName(parentOf(root))
    return parent ? `${short(id)} (${parent})` : root
  }
  const count = (names: readonly string[], name: string) => names.filter(other => other.toLowerCase() === name.toLowerCase()).length
  const first = ids.map(short)
  const second = ids.map((id, index) => (count(first, first[index] ?? '') > 1 ? longer(id) : (first[index] ?? id)))
  const labels: Record<Repo, string> = {}
  ids.forEach((id, index) => {
    const name = second[index] ?? id
    labels[id] = count(second, name) > 1 ? normalizePath(roots[id] ?? id) : name
  })
  return labels
}

export function labelOf(labels: Readonly<Record<Repo, string>>, repo: Repo | null): string {
  if (!repo) return '—'
  return labels[repo] ?? baseName(repo)
}

/** Reads the Git toplevel of a directory: one that exists, or git cannot start in it. */
export function toplevelArgv(dir: string): string[] {
  return ['git', '--no-optional-locks', '-C', dir, 'rev-parse', '--show-toplevel']
}

/** The toplevel git printed; null for anything that is not one absolute path. */
export function parseToplevel(stdout: string): string | null {
  const line = stdout.trim().split('\n')[0]?.trim() ?? ''
  const path = normalizePath(line)
  return path && isAbsolute(path) ? path : null
}
