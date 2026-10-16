import { describe, expect, test } from 'claude-code/testing'

import {
  PARTNER_TOOL,
  PARTNER_TOOL_ID,
  activityText,
  framed,
  linkFile,
  linkPrompt,
  pairWith,
  pairedId,
  parseLink,
  partnerOf,
  prune,
  senderName,
  unframed,
  unpair,
} from '../hooks/link'
import type { LinkPartner, SessionEntry } from '../types'
import { ALPHA, BETA } from './git-mock'

const NOW = 1_000_000

function entry(fields: Partial<SessionEntry>): SessionEntry {
  return { sessionId: 's', repo: BETA, repoRoot: 'C:/repos/beta', cwd: '', name: null, window: null, pid: null, updatedAt: NOW, isOpen: true, ...fields }
}

describe('link helpers', () => {
  test('the link file sits beside the session registry', () => {
    expect(linkFile('C:\\T\\')).toBe('C:/T/engineering-workflow/link.json')
  })

  test('the file holds pairs; anything else reads as none', () => {
    const pairs = [{ a: 'x', b: 'y' }]
    expect(parseLink(JSON.stringify({ pairs, updatedAt: 5 }))).toEqual({ pairs, updatedAt: 5 })
    expect(parseLink(JSON.stringify({ pairs: [{ a: 'x' }, { a: 'z', b: 'z' }, 7, ...pairs] }))).toEqual({ pairs, updatedAt: 0 })
    expect(parseLink('{"linked":true,"updatedAt":5}')).toEqual({ pairs: [], updatedAt: 0 })
    expect(parseLink('not json')).toEqual({ pairs: [], updatedAt: 0 })
  })

  test('pairs have no order: either side finds the other', () => {
    const pairs = [{ a: 'x', b: 'y' }]
    expect(pairedId(pairs, 'x')).toBe('y')
    expect(pairedId(pairs, 'y')).toBe('x')
    expect(pairedId(pairs, 'z')).toBe(null)
  })

  test('pairing breaks the pairs either session was in; unpairing drops its own', () => {
    const pairs = [
      { a: 'c1', b: 't1' },
      { a: 't2', b: 'c2' },
      { a: 'c3', b: 't3' },
    ]
    expect(pairWith(pairs, 'c1', 't2')).toEqual({
      pairs: [{ a: 'c3', b: 't3' }, { a: 'c1', b: 't2' }],
      broken: [
        { a: 'c1', b: 't1' },
        { a: 't2', b: 'c2' },
      ],
    })
    // Pairing again with the same partner, from either side, breaks nothing.
    expect(pairWith(pairs, 't3', 'c3').broken).toEqual([])
    expect(unpair(pairs, 't1')).toEqual([pairs[1], pairs[2]])
    expect(unpair(pairs, 'c2')).toEqual([pairs[0], pairs[2]])
    expect(prune(pairs, new Set(['c1', 't2']))).toEqual([pairs[0], pairs[1]])
  })

  test('the partner is the other side of the pair, open or not, of any repository or none', () => {
    const pairs = [{ a: 'me', b: 'api' }]
    const entries = [entry({ sessionId: 'api', name: 'api-auth' }), entry({ sessionId: 'me', repo: ALPHA, repoRoot: 'C:/repos/alpha' })]
    expect(partnerOf(entries, pairs, 'me', NOW)).toEqual({ sessionId: 'api', repo: BETA, repoRoot: 'C:/repos/beta', name: 'api-auth', isLive: true })
    expect(partnerOf(entries, pairs, 'api', NOW)).toEqual({ sessionId: 'me', repo: ALPHA, repoRoot: 'C:/repos/alpha', name: null, isLive: true })
    const gone = [entry({ sessionId: 'api', name: 'api-auth', isOpen: false })]
    expect(partnerOf(gone, pairs, 'me', NOW)?.isLive).toBe(false)
    expect(partnerOf([], pairs, 'me', NOW)).toEqual({ sessionId: 'api', repo: null, repoRoot: null, name: null, isLive: false })
    expect(partnerOf(entries, pairs, 'other', NOW)).toBe(null)
  })

  test('messages are framed with the sender and its repository, and logged short', () => {
    expect(framed('api-auth', 'alpha', 'API v2 is out')).toBe('[from session api-auth · alpha] API v2 is out')
    expect(senderName(null, '0123456789abcdef')).toBe('01234567')
    expect(senderName('api', '0123456789abcdef')).toBe('api')
    expect(activityText('to', 'beta', 'short')).toBe('→ beta: short')
    expect(activityText('from', 'alpha', 'x'.repeat(80))).toBe(`← alpha: ${'x'.repeat(60)}…`)
    expect(activityText('to', 'alpha', 'x'.repeat(60))).toBe(`→ alpha: ${'x'.repeat(60)}`)
    expect(activityText('to', 'alpha', '😀'.repeat(70))).toBe(`→ alpha: ${'😀'.repeat(60)}…`)
  })

  test('a framed message is told apart from a typed one', () => {
    expect(unframed(framed('web', 'api (work)', 'adapted'))).toEqual({ sender: 'web', label: 'api (work)', text: 'adapted' })
    expect(unframed('hello')).toBe(null)
  })

  test('the system prompt section names the partner, its repository and the tool', () => {
    const partner: LinkPartner = { sessionId: 'api', repo: BETA, repoRoot: 'C:/repos/beta', name: 'api-auth', isLive: true }
    const text = linkPrompt(ALPHA, partner, 'beta')
    expect(text).toContain('session "api-auth" working in the beta repository (C:/repos/beta)')
    expect(text).toContain(PARTNER_TOOL_ID)
    expect(text).toContain('Never send acknowledgements')
    expect(text).toContain('ask the user before')
    expect(text).toContain('[from session ...]')
    expect(linkPrompt(ALPHA, { ...partner, name: null }, 'beta')).toContain('a Claude Code session working in the beta repository')
    expect(linkPrompt(BETA, partner, 'beta')).toContain('working in this same repository (C:/repos/beta)')
    expect(linkPrompt(ALPHA, { ...partner, repo: null, repoRoot: null }, '')).toContain('working outside any Git repository')
    expect(PARTNER_TOOL.name).toBe('message_partner')
    expect(PARTNER_TOOL_ID).toBe(`mcp__engineering-workflow__${PARTNER_TOOL.name}`)
  })
})
