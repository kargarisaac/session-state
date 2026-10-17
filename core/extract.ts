import { tidy } from './redact'
import { KINDS } from './types'
import type { Kind, Memory, Note, Turn } from './types'

const USER_CHARS = 10000
const ANSWER_CHARS = 6000
const PREVIOUS_CHARS = 1500

export const systemPrompt = (maxWords: number): string =>
  [
    'You keep short notes of what a user said in a coding-agent chat, so the agent can recall them about 50 turns later.',
    'Record only things the USER said that will still matter about 50 turns later: decisions, constraints and requirements, preferences, corrections and reversals, scope limits, always/never/from-now-on rules, and standing requests the agent could drop.',
    'Never record: one-off commands ("run the tests"), questions, acknowledgements, the current step of a task, or anything only the agent said.',
    'The agent text is context. Use it to work out what a short reply like "yes" or "the second one" refers to, and write the note with that detail.',
    `Each note is one sentence of at most ${maxWords} words, clear on its own: what was decided and the one detail that makes it unambiguous. No quotes.`,
    `"kind" is one of: ${KINDS.join(', ')}. Use "ask" only for a standing request that is not yet done.`,
    '"quote" is an exact, contiguous piece of the USER\'S LATEST MESSAGE that supports the note, copied character for character.',
    '"supersedes" lists the ids of active notes this note replaces or reverses (numbers, e.g. 2 for M-002), or [].',
    'Reply with JSON only, no prose: {"title": "<=6 words, only when the current title is (none)", "memories": [{"kind": "...", "text": "...", "quote": "...", "supersedes": []}]}',
    'If nothing qualifies, reply {"memories": []}.',
  ].join('\n')

export const noteLabel = (id: number): string => `M-${String(id).padStart(3, '0')}`

export const userPrompt = (turn: Turn, active: Note[], title: string): string =>
  [
    `Current title: ${title === '' ? '(none)' : title}`,
    'Active notes, oldest first:',
    active.length === 0 ? '(none)' : active.map(n => `${noteLabel(n.id)} [${n.kind}] ${n.text}`).join('\n'),
    '',
    'Previous agent reply (end of it):',
    turn.previousAnswer === '' ? '(none)' : tidy(turn.previousAnswer.slice(-PREVIOUS_CHARS), PREVIOUS_CHARS),
    '',
    "User's latest message:",
    tidy(turn.user, USER_CHARS),
    '',
    "Agent's reply to it:",
    turn.answer === '' ? '(none)' : tidy(turn.answer, ANSWER_CHARS),
  ].join('\n')

export const wordCount = (text: string): number => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length)

const squash = (s: string): string =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

export const isQuoteOf = (quote: string, user: string): boolean => {
  const q = squash(quote)
  return q.length >= 3 && squash(user).includes(q)
}

export type Extraction = { title: string; memories: Memory[] }

const isKind = (v: unknown): v is Kind => typeof v === 'string' && (KINDS as readonly string[]).includes(v)

const idOf = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isInteger(v)) return v
  const m = typeof v === 'string' ? /^M?-?(\d+)$/i.exec(v.trim()) : null
  return m === null ? undefined : Number(m[1])
}

export const parseExtraction = (text: string): Extraction | { error: string } => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { error: 'no JSON object in the reply' }
  let json: unknown
  try {
    json = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { error: 'reply is not valid JSON' }
  }
  const raw = (json as { memories?: unknown }).memories
  if (!Array.isArray(raw)) return { error: 'no memories array' }
  const memories: Memory[] = []
  for (const m of raw) {
    if (m === null || typeof m !== 'object') continue
    const { kind, text: body, quote, supersedes } = m as Record<string, unknown>
    if (!isKind(kind) || typeof body !== 'string' || typeof quote !== 'string') continue
    memories.push({
      kind,
      text: body.replace(/\s+/g, ' ').trim(),
      quote,
      supersedes: Array.isArray(supersedes) ? supersedes.map(idOf).filter((n): n is number => n !== undefined) : [],
    })
  }
  const title = (json as { title?: unknown }).title
  return { title: typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '', memories }
}

export type Checked = { kept: Memory[]; overLong: Memory[]; dropped: string[] }

// Code, not the model, decides what is saved: the quote must be the user's own words.
export const checkMemories = (memories: Memory[], user: string, active: Note[], maxWords: number): Checked => {
  const activeIds = new Set(active.map(n => n.id))
  const seen = new Set(active.map(n => squash(n.text).toLowerCase()))
  const kept: Memory[] = []
  const overLong: Memory[] = []
  const dropped: string[] = []
  for (const m of memories) {
    if (m.text === '') dropped.push('empty text')
    else if (!isQuoteOf(m.quote, user)) dropped.push(`quote not in the user message: ${m.text.slice(0, 40)}`)
    else if (wordCount(m.text) > maxWords) overLong.push(m)
    else if (seen.has(squash(m.text).toLowerCase())) dropped.push(`duplicate: ${m.text.slice(0, 40)}`)
    else {
      seen.add(squash(m.text).toLowerCase())
      kept.push({ ...m, supersedes: m.supersedes.filter(id => activeIds.has(id)) })
    }
  }
  return { kept, overLong, dropped }
}
