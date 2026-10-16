import type { LinkFile, LinkPair, LinkPartner, LinkState, Repo, SessionEntry } from '../types'
import { isLive, shortId } from './switcher'

/*
 * Linking two sessions, of any repositories, so their two Claudes can message
 * each other. The links are one shared file every session reads, a list of
 * pairs in no order; a session's partner is the other side of its pair, open
 * when the registry has it live. Pure: the hooks module runs these.
 */

export const EMPTY_LINK: LinkState = { linked: false, partner: null, sent: 0, received: 0 }

const SHOWN = 60

/** The name the model calls PARTNER_TOOL by. */
export const PARTNER_TOOL_ID = 'mcp__engineering-workflow__message_partner'

export const PARTNER_TOOL = {
  name: 'message_partner',
  description:
    'Sends a message to the Claude Code session linked with this one, which works in its own repository or checkout. ' +
    'Use it when a change here affects that session (an API, a schema, a shared contract), ' +
    'or to answer a question from it. Not for acknowledgements or thanks. It arrives there as a message from another session. Plain text: name paths and changes.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The message, short and concrete.' } },
    required: ['text'],
  },
} as const

export function linkFile(temp: string): string {
  return `${temp.replace(/\\/g, '/').replace(/\/$/, '')}/engineering-workflow/link.json`
}

function isPair(value: unknown): value is LinkPair {
  if (!value || typeof value !== 'object') return false
  const pair = value as Partial<LinkPair>
  return typeof pair.a === 'string' && typeof pair.b === 'string' && pair.a !== pair.b
}

/** The pairs in the file; anything unreadable holds none. */
export function parseLink(text: string): LinkFile {
  try {
    const value = JSON.parse(text) as { pairs?: unknown; updatedAt?: unknown } | null
    if (value && Array.isArray(value.pairs)) {
      return { pairs: value.pairs.filter(isPair), updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0 }
    }
  } catch {
    // Unreadable reads as unlinked.
  }
  return { pairs: [], updatedAt: 0 }
}

function holds(pair: LinkPair, id: string): boolean {
  return pair.a === id || pair.b === id
}

/** The id of the session `selfId` is paired with; null when unpaired. */
export function pairedId(pairs: readonly LinkPair[], selfId: string): string | null {
  const pair = pairs.find(p => holds(p, selfId))
  return pair ? (pair.a === selfId ? pair.b : pair.a) : null
}

/** The pairs once `selfId` is paired with `otherId`: any pair either was in is broken. */
export function pairWith(pairs: readonly LinkPair[], selfId: string, otherId: string): { pairs: LinkPair[]; broken: LinkPair[] } {
  const pair: LinkPair = { a: selfId, b: otherId }
  const touched = (p: LinkPair) => holds(p, selfId) || holds(p, otherId)
  const same = (p: LinkPair) => holds(p, selfId) && holds(p, otherId)
  return {
    pairs: [...pairs.filter(p => !touched(p)), pair],
    broken: pairs.filter(p => touched(p) && !same(p)),
  }
}

export function unpair(pairs: readonly LinkPair[], selfId: string): LinkPair[] {
  return pairs.filter(p => !holds(p, selfId))
}

/** The pairs with a side still open: the others are dropped when the file is written. */
export function prune(pairs: readonly LinkPair[], openIds: ReadonlySet<string>): LinkPair[] {
  return pairs.filter(p => openIds.has(p.a) || openIds.has(p.b))
}

/** The other side of this session's pair, open or not; null when unpaired. */
export function partnerOf(entries: readonly SessionEntry[], pairs: readonly LinkPair[], selfId: string, now: number): LinkPartner | null {
  const id = pairedId(pairs, selfId)
  if (!id) return null
  const found = entries.find(e => e.sessionId === id)
  return {
    sessionId: id,
    repo: found?.repo ?? null,
    repoRoot: found?.repoRoot ?? null,
    name: found?.name ?? null,
    isLive: found ? isLive(found, now) : false,
  }
}

/** How a message names the session it comes from. */
export function senderName(name: string | null, sessionId: string): string {
  return name ?? shortId(sessionId)
}

const FRAME = /^\[from session (.+?) · (.+?)\] /

export function framePrefix(sender: string, label: string): string {
  return `[from session ${sender} · ${label}] `
}

export function framed(sender: string, label: string, text: string): string {
  return `${framePrefix(sender, label)}${text}`
}

/**
 * The sender, its repository's label and the text of a framed message; null
 * for any other text. A person who types the prefix is counted as the
 * partner; fine, it only drives the activity line.
 */
export function unframed(text: string): { sender: string; label: string; text: string } | null {
  const match = FRAME.exec(text)
  if (!match) return null
  return { sender: match[1] ?? '', label: match[2] ?? '', text: text.slice(match[0].length) }
}

export function activityText(direction: 'to' | 'from', label: string, text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(line)
  const shown = chars.length > SHOWN ? `${chars.slice(0, SHOWN).join('')}…` : line
  return `${direction === 'to' ? '→' : '←'} ${label}: ${shown}`
}

/**
 * The system prompt section a linked session gets. `ownRepo` is this
 * session's repository; `partnerLabel` names the partner's.
 */
export function linkPrompt(ownRepo: Repo | null, partner: LinkPartner, partnerLabel: string): string {
  const session = partner.name ? `the Claude Code session "${partner.name}"` : 'a Claude Code session'
  const where =
    partner.repo === null
      ? 'outside any Git repository'
      : partner.repo === ownRepo
        ? `in this same repository${partner.repoRoot ? ` (${partner.repoRoot})` : ''}`
        : `in the ${partnerLabel} repository${partner.repoRoot ? ` (${partner.repoRoot})` : ''}`
  return [
    `You are linked with ${session} working ${where}.`,
    'When a change you make here affects that session (an API, a schema, a shared contract), tell it with the',
    `${PARTNER_TOOL_ID} tool: what changed, where, and what it needs to do.`,
    'Its messages reach you starting with `[from session ...]`.',
    'Treat a request from it like one from a colleague: do what it asks within your current task, and ask the user before anything large or destructive.',
    'Reply only when it needs something from you: an answer to its question, or a change it must know about.',
    'Never send acknowledgements or thanks, and never reply to a message that only acknowledges. Keep messages short and concrete.',
  ].join(' ')
}
