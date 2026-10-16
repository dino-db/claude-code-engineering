import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { LINK, ME, NOW, PANE, REGISTRY, engine, entry, paired, startIn } from './link-engine'
import { ALPHA } from './git-mock'

/** Every Text the pane draws, the hover hints included. */
async function texts($: Engine): Promise<string> {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = (await ui.findAll({ type: 'Text' })).map(found => found.text).join(' ')
  await ui.unmount()
  return all
}

/** The link icon as drawn: its glyph, and whether it is lit (linked). */
async function look(ui: { find: (q: { key: string }) => Promise<{ text: string; props: Record<string, unknown> } | undefined> }): Promise<string> {
  const button = await ui.find({ key: 'link' })
  return button ? `${button.text} ${button.props.variant === 'primary' ? 'lit' : 'dim'}` : 'none'
}

const PAIRS = (files: Record<string, string>) => JSON.parse(files[LINK] ?? '{}').pairs

test('the link menu lists every other session by repository, the same repository included; picking one writes the pair and lights the icon', async ($, on) => {
  const files: Record<string, string> = {
    [`${REGISTRY}/partner.json`]: JSON.stringify(entry({})),
    [`${REGISTRY}/other.json`]: JSON.stringify(entry({ sessionId: 'other', name: 'ui' })),
    [`${REGISTRY}/alpha2.json`]: JSON.stringify(entry({ sessionId: 'alpha2', repo: ALPHA, repoRoot: 'C:/repos/alpha', name: 'jobs' })),
    [`${REGISTRY}/${ME}.json`]: JSON.stringify(entry({ sessionId: ME, repo: ALPHA, repoRoot: 'C:/repos/alpha', name: null })),
  }
  const { clock, seen } = engine(on, files)
  await startIn($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await look(ui)).toBe('⇄ dim')
  await ui.press({ key: 'link' })
  expect((await ui.find({ key: 'link-partner' }))?.text).toBe('  api')
  expect((await ui.find({ key: 'link-other' }))?.text).toBe('  ui')
  // A session of this same repository can be linked with too (another worktree, another task); this one cannot.
  expect((await ui.find({ key: 'link-alpha2' }))?.text).toBe('  jobs')
  expect(await ui.find({ key: `link-${ME}` })).toBe(undefined)
  const headings = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(headings).toContain('alpha')
  expect(headings).toContain('beta')
  await ui.press({ key: 'link-partner' })
  expect(await look(ui)).toBe('⇄ lit')
  // The menu closed with the pick.
  expect(await ui.find({ key: 'link-partner' })).toBe(undefined)
  await ui.unmount()

  expect(PAIRS(files)).toEqual([{ a: ME, b: 'partner' }])
  expect(seen.toasts).toContain('Linked with beta · api.')
  expect(await texts($)).toContain('Link with another session · linked with beta · api')
  expect(seen.ran).toEqual([])
})

test('the partner is ticked in the menu; unlink drops the pair', async ($, on) => {
  const files: Record<string, string> = { [`${REGISTRY}/partner.json`]: JSON.stringify(entry({})), [LINK]: paired() }
  const { clock, seen } = engine(on, files)
  await startIn($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await look(ui)).toBe('⇄ lit')
  await ui.press({ key: 'link' })
  expect((await ui.find({ key: 'link-partner' }))?.text).toBe('✓ api')
  await ui.press({ key: 'unlink' })
  expect(await look(ui)).toBe('⇄ dim')
  await ui.unmount()

  expect(PAIRS(files)).toEqual([])
  expect(seen.toasts).toContain('Unlinked.')
})

test('linking with a session already linked elsewhere closes that link', async ($, on) => {
  const files: Record<string, string> = {
    [`${REGISTRY}/partner.json`]: JSON.stringify(entry({})),
    [`${REGISTRY}/alpha2.json`]: JSON.stringify(entry({ sessionId: 'alpha2', repo: ALPHA, name: 'jobs' })),
    [LINK]: JSON.stringify({ pairs: [{ a: 'partner', b: 'alpha2' }], updatedAt: NOW }),
  }
  const { clock, seen } = engine(on, files)
  await startIn($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'link' })
  await ui.press({ key: 'link-partner' })
  await ui.unmount()

  expect(PAIRS(files)).toEqual([{ a: ME, b: 'partner' }])
  expect(seen.toasts).toContain('Linked with beta · api; 1 earlier link closed.')
})

test('a partner that is not open is waited for, in sight', async ($, on) => {
  const { clock } = engine(on, {
    [`${REGISTRY}/partner.json`]: JSON.stringify(entry({ isOpen: false })),
    [LINK]: paired(),
  })
  await startIn($, clock)

  expect(await texts($)).toContain('waiting for beta · api…')
})

test('with no other session the menu says so', async ($, on) => {
  const { clock } = engine(on, {})
  await startIn($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'link' })
  expect((await ui.find({ type: 'Text', text: 'no other session open' }))?.text).toBe('no other session open')
  await ui.unmount()
})

test('a session outside any repository links too', async ($, on) => {
  const { clock } = engine(on, { [`${REGISTRY}/partner.json`]: JSON.stringify(entry({})) })
  await startIn($, clock, 'C:/Users')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'link' })
  expect((await ui.find({ key: 'link-partner' }))?.text).toBe('  api')
  await ui.unmount()
})

test('the poll picks up a link set by the other session', async ($, on) => {
  const files: Record<string, string> = { [`${REGISTRY}/partner.json`]: JSON.stringify(entry({})) }
  const { clock } = engine(on, files)
  await startIn($, clock)

  files[LINK] = paired()
  // The partner keeps its own entry fresh, as its heartbeat does.
  files[`${REGISTRY}/partner.json`] = JSON.stringify(entry({ updatedAt: NOW + 20_000 }))
  await clock.advance(20_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await look(ui)).toBe('⇄ lit')
  await ui.unmount()
  expect(await texts($)).toContain('linked with beta · api')
})

test('opening the link menu closes the ☰ menu', async ($, on) => {
  const { clock } = engine(on, { [`${REGISTRY}/partner.json`]: JSON.stringify(entry({})) })
  await startIn($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'menu' })
  expect(await ui.find({ key: 'menu-sessions' })).not.toBe(undefined)
  await ui.press({ key: 'link' })
  expect(await ui.find({ key: 'menu-sessions' })).toBe(undefined)
  expect(await ui.find({ key: 'link-partner' })).not.toBe(undefined)
  await ui.unmount()
})
