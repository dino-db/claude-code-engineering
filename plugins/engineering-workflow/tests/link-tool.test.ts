import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { LINK, REGISTRY, engine, entry, paired, startIn } from './link-engine'

const TOOL = 'mcp__engineering-workflow__message_partner'

async function paneTexts($: Engine): Promise<string> {
  const ui = await $.ui.mount({
    plugin: 'engineering-workflow',
    component: 'Pane',
    requestId: 'engineering-workflow',
    surface: 'terminal',
    props: { title: 'Engineering Workflow', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join(' ')
  await ui.unmount()
  return texts
}

const LINKED = () => ({
  [`${REGISTRY}/partner.json`]: JSON.stringify(entry({})),
  [LINK]: paired(),
})

test('unlinked, the tool is refused', async ($, on) => {
  const { clock, seen } = engine(on, { [`${REGISTRY}/partner.json`]: JSON.stringify(entry({})) })
  await startIn($, clock)

  const ran = await $.tool.call({ tool: TOOL, text: 'hi' } as never)

  expect(ran.deny).toContain('Not linked')
  expect(seen.sends).toEqual([])
})

test('linked with no partner open, the tool is refused', async ($, on) => {
  const { clock, seen } = engine(on, { [LINK]: paired() })
  await startIn($, clock)

  const ran = await $.tool.call({ tool: TOOL, text: 'hi' } as never)

  expect(ran.deny).toBe('The linked session partner is not open; the message was not sent. Tell the user if it matters; do not retry.')
  expect(seen.sends).toEqual([])
})

test('linked, the message goes to the partner framed, and shows in recent activity', async ($, on) => {
  const { clock, seen } = engine(on, LINKED())
  await startIn($, clock)

  const ran = await $.tool.call({ tool: TOOL, text: 'API v2 is out' } as never)

  expect(ran.result).toBe('Sent to the session "api" in beta.')
  expect(seen.sends).toEqual([{ to: 'partner', text: '[from session me · alpha] API v2 is out' }])
  expect(await paneTexts($)).toContain('→ beta: API v2 is out')
})

test('a session the menu named signs its messages with that name', async ($, on) => {
  const { clock, seen } = engine(on, LINKED(), undefined, { env: { EW_SESSION_NAME: 'jobs' } })
  await startIn($, clock)

  await $.tool.call({ tool: TOOL, text: 'done' } as never)

  expect(seen.sends).toEqual([{ to: 'partner', text: '[from session jobs · alpha] done' }])
})

test('outside any repository the message still goes, from no repository', async ($, on) => {
  const { clock, seen } = engine(on, LINKED())
  await startIn($, clock, 'C:/elsewhere')

  const ran = await $.tool.call({ tool: TOOL, text: 'hello' } as never)

  expect(ran.result).toBe('Sent to the session "api" in beta.')
  expect(seen.sends).toEqual([{ to: 'partner', text: '[from session me · no repository] hello' }])
})

test('an empty message is refused', async ($, on) => {
  const { clock } = engine(on, LINKED())
  await startIn($, clock)

  const ran = await $.tool.call({ tool: TOOL, text: '  ' } as never)

  expect(ran.deny).toBe('The message is empty.')
})

test('a refused delivery is reported and not shown as sent', async ($, on) => {
  const { clock } = engine(on, LINKED(), () => ({ isDelivered: false, reason: 'gone' }))
  await startIn($, clock)

  const ran = await $.tool.call({ tool: TOOL, text: 'hello' } as never)

  expect(ran.deny).toContain('Not delivered: gone')
  expect(await paneTexts($)).not.toContain('→ beta:')
})

test('a send that throws is reported as not delivered', async ($, on) => {
  const { clock } = engine(on, LINKED(), () => {
    throw new Error('boom')
  })
  await startIn($, clock)

  const ran = await $.tool.call({ tool: TOOL, text: 'hello' } as never)

  expect(String(ran.deny)).toMatch(/^Not delivered:/)
})

test('a delivered message is counted', async ($, on) => {
  const { clock } = engine(on, LINKED())
  const counts: number[] = []
  on('state.set', ($, e, next) => {
    const value = e as unknown as { key?: string; value?: { sent?: number } }
    if (value.key === 'link' && typeof value.value?.sent === 'number') counts.push(value.value.sent)
    return next(e)
  })
  await startIn($, clock)

  await $.tool.call({ tool: TOOL, text: 'hello' } as never)

  expect(counts[counts.length - 1]).toBe(1)
})

test('a message from the linked session shows in recent activity and passes on unchanged', async ($, on) => {
  const { clock } = engine(on, LINKED())
  on('session.receive', ($, e) => ({ text: e.text }))
  await startIn($, clock)

  const got = await $.session.receive({
    origin: { kind: 'peer', plugin: 'engineering-workflow' },
    text: '[from session api · beta] adapted the client',
  } as never)

  expect(got.text).toBe('[from session api · beta] adapted the client')
  expect(await paneTexts($)).toContain('← beta: adapted the client')
})

test('other deliveries are not counted as the partner', async ($, on) => {
  const { clock } = engine(on, { [LINK]: paired() })
  on('session.receive', ($, e) => ({ text: e.text }))
  await startIn($, clock)

  await $.session.receive({ origin: { kind: 'peer' }, text: 'hello from someone' } as never)
  await $.session.receive({ origin: { kind: 'peer', plugin: 'other' }, text: '[from session api · beta] x' } as never)

  expect(await paneTexts($)).not.toContain('← ')
})
