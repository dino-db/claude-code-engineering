import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { toplevel } from './git-mock'

const PANE = {
  plugin: 'engineering-workflow',
  component: 'Pane',
  requestId: 'engineering-workflow',
  props: {
    title: 'Engineering Workflow',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Calls = { compact: number; cleans: string[][] }

/** An engine on Windows, or with `isWindows` false on macOS or Linux. */
function engine(on: On, isWindows = true): { clock: MockClock; calls: Calls } {
  const clock = mock.clock(on)
  const calls: Calls = { compact: 0, cleans: [] }
  on('process.run', ($, e) => {
    const top = toplevel(e.argv)
    if (top) return { value: top }
    const isClean = e.argv[0] === 'powershell' || e.argv[0] === 'sh'
    if (isClean) calls.cleans.push([...e.argv])
    return {
      value: {
        exitCode: 0,
        stdout: isClean ? '3\n' : e.argv.includes('--show-current') ? 'FEAT-1\n' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  const env: Record<string, string> = isWindows ? { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' } : { HOME: '/home/me' }
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('fs.list', () => ({ value: [{ name: 'a.txt', kind: 'file', size: 2048, mtimeMs: 1, isLink: false }] }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 90000, window: 200000, percent: 45 }, rateLimits: [] },
  }))
  on('session.compact', () => {
    calls.compact += 1
    return { skip: 'test' }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({
    text: e.answer,
    usage: { model: 'test', input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 5 },
  }))
  return { clock, calls }
}

async function start($: Engine, clock: MockClock, surface: 'terminal' | 'desktop'): Promise<void> {
  await $.session.start({ cwd: 'C:\\repos\\alpha', surface, isInteractive: false })
  await clock.advance(0)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the context block sits at the foot of the pane`, async ($, on) => {
    const { clock } = engine(on)
    await start($, clock, surface)

    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    const keys = (await ui.findAll({ type: 'Button' })).map(found => found.key)
    await ui.unmount()

    const joined = texts.join(' ')
    expect(joined).toContain('Engineering Workflow')
    expect(joined).toContain('▼ 45%')
    expect(joined).toContain('90k/200k')
    expect(keys).toContain('compact')
    expect(keys).toContain('clean')
    // After everything the pane draws: the rule, then the block.
    expect(texts.indexOf('Recent activity')).toBeLessThan(texts.findIndex(text => text.startsWith('─')))
  })

  test(`${surface}: no cache line, the clean button sits beside Compact`, async ($, on) => {
    const { clock } = engine(on)
    await start($, clock, surface)
    await $.turn.complete({ answer: 'done', reason: 'answer', durationMs: 1 } as never)

    const ui = await $.ui.mount({ ...PANE, surface })
    const joined = (await ui.findAll({ type: 'Text' })).map(text => text.text).join(' ')
    await ui.unmount()

    expect(joined).not.toContain('hit ')
    expect(joined).not.toContain('local ')
    expect(joined).not.toContain('Cache ')
  })

  test(`${surface}: Clear cache runs the clean`, async ($, on) => {
    const { clock, calls } = engine(on)
    await start($, clock, surface)

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'clean' })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join(' ')
    await ui.unmount()

    expect(calls.cleans.length).toBe(1)
    expect(calls.cleans[0]?.[0]).toBe('powershell')
    expect(texts).toContain('Cache cleared: 3 items')
  })

  test(`${surface}: on macOS and Linux Clear cache runs the clean with sh, under $HOME`, async ($, on) => {
    const { clock, calls } = engine(on, false)
    await start($, clock, surface)

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'clean' })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join(' ')
    await ui.unmount()

    expect(calls.cleans.length).toBe(1)
    expect(calls.cleans[0]?.slice(0, 2)).toEqual(['sh', '-c'])
    expect(calls.cleans[0]?.[2]).toContain('$HOME/.claude')
    expect(texts).toContain('Cache cleared: 3 items')
  })

  test(`${surface}: Compact asks for a compact`, async ($, on) => {
    const { clock, calls } = engine(on)
    await start($, clock, surface)

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'compact' })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join(' ')
    await ui.unmount()

    expect(calls.compact).toBe(1)
    expect(texts).toContain('Compact skipped: test')
  })
}
