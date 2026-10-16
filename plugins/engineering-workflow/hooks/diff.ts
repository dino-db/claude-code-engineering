/*
 * A modified file's changes, for the pane: read with git (read-only, no index
 * lock) and fitted to what the pane's Code element draws, whole hunks only,
 * since a hunk cut midway no longer parses as a diff. Pure: the hooks module
 * runs the commands.
 */

/** The Code element takes 10,000 characters; the rest is room for the note. */
export const DIFF_BUDGET = 9_000

function git(root: string, ...args: string[]): string[] {
  return ['git', '--no-optional-locks', '-C', root, ...args]
}

/** Context lines that take in a whole file: its changes drawn in place. */
export const WHOLE_FILE = 100_000

/** Context lines around each change when the whole file does not fit. */
export const NEAR_CHANGES = 5

/** A tracked file's changes against the last commit, staged and not, with `context` lines around them. */
export function diffArgv(root: string, relative: string, context = WHOLE_FILE): string[] {
  return git(root, 'diff', '--no-color', '--no-ext-diff', `--unified=${context}`, 'HEAD', '--', relative)
}

/**
 * This session's changes to a file: against the copy taken before its first
 * edit, outside any repository. Exits 0 when the two are the same again.
 */
export function sessionDiffArgv(baseline: string, file: string, context = WHOLE_FILE): string[] {
  return [
    'git', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-index',
    `--unified=${context}`, '--', baseline, file,
  ]
}

/** Where the copy of a file from before its first edit in the session is kept. */
export function baselinePath(base: string, sessionId: string, repo: string, relative: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${base}/baselines/${safe}/${repo}/${relative}`
}

/** The key a file goes by in the session's records. */
export function fileKey(repo: string, relative: string): string {
  return `${repo}:${relative}`
}

/** A new, untracked file shown whole, as all added. Exits 1 when it differs. */
export function newFileArgv(root: string, relative: string): string[] {
  return git(root, 'diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', relative)
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/** The diff's hunks, each its header and lines; the file preamble dropped. */
export function hunks(text: string): string[][] {
  const result: string[][] = []
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    // Only tab and newline may reach the Code element.
    const line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    if (HUNK.test(line)) result.push([line])
    else if (result.length > 0 && /^[ +\-\\]/.test(line)) result[result.length - 1]?.push(line)
  }
  return result
}

/** A hunk cut to its first `keep` lines, its header renumbered to match. */
function cutHunk(hunk: readonly string[], keep: number): string[] {
  const [header = '', ...lines] = hunk
  const kept = lines.slice(0, keep)
  const match = HUNK.exec(header)
  const oldCount = kept.filter(line => line.startsWith(' ') || line.startsWith('-')).length
  const newCount = kept.filter(line => line.startsWith(' ') || line.startsWith('+')).length
  const renumbered = match ? `@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3] ?? ''}` : header
  return [renumbered, ...kept]
}

export type FittedDiff = { source: string; omitted: number }

/**
 * The hunks that fit the budget, in order; `omitted` counts the hunks left out
 * (a first hunk too long alone is cut, counted as one). Null with no hunks.
 */
export function fitDiff(text: string, budget = DIFF_BUDGET): FittedDiff | null {
  const all = hunks(text)
  if (all.length === 0) return null

  const kept: string[] = []
  let used = 0
  for (const hunk of all) {
    const block = hunk.join('\n')
    if (used + block.length + 1 > budget) break
    kept.push(block)
    used += block.length + 1
  }

  if (kept.length === 0) {
    const first = all[0] ?? []
    let keep = first.length - 1
    while (keep > 1 && cutHunk(first, keep).join('\n').length > budget) keep = Math.floor(keep * 0.8)
    return { source: cutHunk(first, keep).join('\n'), omitted: all.length }
  }

  return { source: kept.join('\n'), omitted: all.length - kept.length }
}
