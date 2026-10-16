/*
 * The fictional repositories the tests work in, `C:/repos/alpha` and
 * `C:/repos/beta`, as git finds them: what `git rev-parse --show-toplevel`
 * prints for a directory under one of them, and a failure anywhere else.
 */

export type Ran = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false }

function ran(exitCode: number, stdout: string, stderr = ''): Ran {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

/** The answer to a toplevel lookup; null for any other command. */
export function toplevel(argv: readonly string[]): Ran | null {
  if (!argv.includes('--show-toplevel')) return null
  const at = argv.indexOf('-C')
  const dir = (at >= 0 ? (argv[at + 1] ?? '') : '').replace(/\\/g, '/')
  const match = /^(?:[a-z]:)?\/repos\/(alpha|beta)(\/|$)/i.exec(dir)
  return match ? ran(0, `C:/repos/${match[1]?.toLowerCase()}\n`) : ran(128, '', 'fatal: not a git repository')
}

/** The id the fictional repositories go by. */
export const ALPHA = 'c:/repos/alpha'
export const BETA = 'c:/repos/beta'
