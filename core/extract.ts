import { shortPath } from './facts'
import { redact } from './redact'
import { KINDS, LEARN_KINDS } from './types'
import type { Kind, LearnKind, Learning, LearningDraft, Memory, Note, Step, TurnFacts } from './types'

export type Mode = 'summarize' | 'extract'

const WHY_WORDS = 60
const STEP_WORDS = 25
const ROLE_WORDS = 10

const shared = [
  'You keep the ledger of a long coding-agent chat, so the agent never forgets what the user asked and decided, what was learned, and which files matter, even after the chat is compacted.',
  'You read the ledger, recent steps, the user\'s earlier messages, the previous reply and THIS TURN.',
  '"step": what THIS TURN did or found, in at most 25 words, past tense, naming files, features and results. "outcome" is "failed" only when the turn ended without doing what was asked; otherwise "ok".',
  '"done": ids of open "ask" notes that the agent\'s reply in this turn shows are finished: it says it did them and nothing is left. Never list one you are unsure about. Usually [].',
  '"files": for each file under "Edited files with no role yet", its role in at most 10 words (what it is for, not what changed). Use the path as shown.',
  `"learnings": only something the agent found out the hard way in THIS TURN that should stop it repeating a mistake later: an approach that failed and why ("failed"), or a hard limit of the environment, tool or data ("constraint"). "evidence" is an exact piece of the agent's reply or a failed command's output, copied character for character. "replaces" lists ids of active learnings it makes untrue. Kinds: ${LEARN_KINDS.join(', ')}. Usually [].`,
]

const memoryRules = (maxWords: number): string[] => [
  'Also record what the USER said in THIS TURN that will still matter about 50 turns later: decisions, constraints and requirements, preferences, corrections and reversals, scope limits, always/never/from-now-on rules, and standing requests the agent could drop.',
  'Never record one-off commands ("run the tests"), questions, acknowledgements, the current step of a task, or anything only the agent said.',
  `"text": one sentence of at most ${maxWords} words, clear on its own. Name things the way the chat does: where the user says "it", "the video" or "the second one", write the real file, feature or option from the context. If the chat gives no name, keep the user's words; never invent one.`,
  `"why": at most ${WHY_WORDS} words: the reason the user gave, or what problem it settles. "context": at most ${WHY_WORDS} words: what was being discussed, so a reader who never saw the chat understands the note. Write "" when there is nothing to add; never write filler such as "no reason given".`,
  '"quote": an exact, contiguous piece of THE USER\'S MESSAGE IN THIS TURN that supports the note, copied character for character.',
  '"refers_to": turn numbers of earlier turns this note answers or depends on, e.g. [40] when the user replies "yes" to a question asked in t40. Usually [].',
  `"kind": one of ${KINDS.join(', ')}. "ask" is an action still to be done. "decision" is a choice that stays true. "requirement" and "preference" are rules for the rest of the chat. "correction" fixes something the agent got wrong.`,
  '"supersedes": ids of active notes this note REPLACES or REVERSES (the user changed their mind about the same thing). A note that adds to or narrows an earlier one does NOT supersede it. When unsure, [].',
  '"need": when you cannot understand the user\'s message without an older turn that is not shown in full (e.g. "do what I said about the deck"), the number of that turn; you will get it and answer again. Otherwise omit it.',
]

export const systemPrompt = (mode: Mode, maxWords: number): string =>
  [
    ...shared,
    ...(mode === 'extract' ? memoryRules(maxWords) : ['Do not record notes about the user in this run; "memories" is always [].']),
    'Reply with JSON only, no prose:',
    '{"title": "<=6 words, only when the current title is (none)", "step": {"text": "...", "outcome": "ok"}, "done": [], "files": [{"path": "...", "role": "..."}], ' +
      '"learnings": [{"kind": "failed", "text": "...", "why": "...", "evidence": "...", "replaces": []}], ' +
      '"memories": [{"kind": "...", "text": "...", "why": "...", "context": "...", "quote": "...", "refers_to": [], "supersedes": []}]' +
      (mode === 'extract' ? ', "need": null}' : '}'),
  ].join('\n')

export const wordCount = (text: string): number => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length)

const clipWords = (text: string, max: number): string => {
  const words = text.trim().split(/\s+/)
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(' ')}…`
}

const squash = (s: string): string =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

export const isQuoteOf = (quote: string, source: string): boolean => {
  const q = squash(quote)
  return q.length >= 3 && squash(source).includes(q)
}

export type FileRole = { path: string; role: string }

export type Extraction = {
  title: string
  step: { text: string; outcome: 'ok' | 'failed' }
  done: number[]
  files: FileRole[]
  learnings: LearningDraft[]
  memories: Memory[]
  need?: number
}

const isKind = (v: unknown): v is Kind => typeof v === 'string' && (KINDS as readonly string[]).includes(v)
const isLearnKind = (v: unknown): v is LearnKind => typeof v === 'string' && (LEARN_KINDS as readonly string[]).includes(v)
const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

const idOf = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isInteger(v)) return v
  const m = typeof v === 'string' ? /^[ML]?-?t?(\d+)$/i.exec(v.trim()) : null
  return m === null ? undefined : Number(m[1])
}

const idsOf = (v: unknown): number[] => (Array.isArray(v) ? v.map(idOf).filter((n): n is number => n !== undefined) : [])

const objects = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object') : []

export const parseExtraction = (text: string): Extraction | { error: string } => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { error: 'no JSON object in the reply' }
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return { error: 'reply is not valid JSON' }
  }
  if (json === null || typeof json !== 'object') return { error: 'reply is not an object' }
  const step = (json.step ?? {}) as Record<string, unknown>
  const memories: Memory[] = objects(json.memories).flatMap(m =>
    isKind(m.kind) && typeof m.text === 'string' && typeof m.quote === 'string'
      ? [{ kind: m.kind, text: str(m.text), why: str(m.why), context: str(m.context), quote: m.quote, refersTo: idsOf(m.refers_to), supersedes: idsOf(m.supersedes) }]
      : [],
  )
  const learnings: LearningDraft[] = objects(json.learnings).flatMap(l =>
    isLearnKind(l.kind) && typeof l.text === 'string' && typeof l.evidence === 'string'
      ? [{ kind: l.kind, text: str(l.text), why: str(l.why), evidence: l.evidence, replaces: idsOf(l.replaces) }]
      : [],
  )
  const files = objects(json.files).flatMap(f => (typeof f.path === 'string' && typeof f.role === 'string' ? [{ path: f.path.trim(), role: str(f.role) }] : []))
  const need = idOf(json.need)
  return {
    title: str(json.title),
    step: { text: str(step.text), outcome: step.outcome === 'failed' ? 'failed' : 'ok' },
    done: idsOf(json.done),
    files,
    learnings,
    memories,
    ...(need === undefined ? {} : { need }),
  }
}

// Only a request still to be done can be finished, and only one that exists.
export const checkDone = (ids: number[], open: Note[]): number[] => {
  const asks = new Set(open.map(n => n.id))
  return [...new Set(ids.filter(id => asks.has(id)))]
}

export type Checked = { kept: Memory[]; overLong: Memory[]; dropped: string[] }

// Code, not the model, decides what is saved: the quote must be the user's own words.
export const checkMemories = (memories: Memory[], user: string, active: Note[], maxWords: number, turn: number): Checked => {
  // Haiku read the redacted message, so a quote may carry a "[redacted ...]" mark where a secret was.
  const words = [user, redact(user)]
  const activeIds = new Set(active.map(n => n.id))
  const seen = new Set(active.map(n => squash(n.text).toLowerCase()))
  const kept: Memory[] = []
  const overLong: Memory[] = []
  const dropped: string[] = []
  for (const m of memories) {
    if (m.text === '') dropped.push('empty text')
    else if (!words.some(w => isQuoteOf(m.quote, w))) dropped.push(`quote not in the user message: ${m.text.slice(0, 40)}`)
    else if (wordCount(m.text) > maxWords) overLong.push(m)
    else if (seen.has(squash(m.text).toLowerCase())) dropped.push(`duplicate: ${m.text.slice(0, 40)}`)
    else {
      seen.add(squash(m.text).toLowerCase())
      kept.push({
        ...m,
        why: clipWords(m.why, WHY_WORDS),
        context: clipWords(m.context, WHY_WORDS),
        refersTo: [...new Set(m.refersTo.filter(t => t > 0 && t < turn))],
        supersedes: m.supersedes.filter(id => activeIds.has(id)),
      })
    }
  }
  return { kept, overLong, dropped }
}

// A learning must cite the agent's reply or a failed command word for word.
export const checkLearnings = (drafts: LearningDraft[], answer: string, facts: TurnFacts, active: Learning[]): { kept: LearningDraft[]; dropped: string[] } => {
  const source = [answer, ...facts.failures.map(f => `${f.command}\n${f.error}`)].join('\n')
  const sources = [source, redact(source)]
  const activeIds = new Set(active.filter(l => l.status === 'active').map(l => l.id))
  const seen = new Set(active.map(l => squash(l.text).toLowerCase()))
  const kept: LearningDraft[] = []
  const dropped: string[] = []
  for (const d of drafts) {
    if (d.text === '') dropped.push('empty learning')
    else if (!sources.some(w => isQuoteOf(d.evidence, w))) dropped.push(`evidence not in the turn: ${d.text.slice(0, 40)}`)
    else if (seen.has(squash(d.text).toLowerCase())) dropped.push(`duplicate learning: ${d.text.slice(0, 40)}`)
    else {
      seen.add(squash(d.text).toLowerCase())
      kept.push({ ...d, why: clipWords(d.why, WHY_WORDS), replaces: d.replaces.filter(id => activeIds.has(id)) })
    }
  }
  return { kept, dropped }
}

// A role is kept only for a file edited in this turn; the path comes back as the tool saw it.
export const checkFileRoles = (roles: FileRole[], edited: string[], cwd: string): FileRole[] =>
  roles.flatMap(r => {
    const path = edited.find(p => p === r.path || shortPath(p, cwd) === r.path || p.endsWith(`/${r.path}`))
    return path === undefined || r.role === '' ? [] : [{ path, role: clipWords(r.role, ROLE_WORDS) }]
  })

const firstWords = (text: string, max: number): string => clipWords(text.split('\n').find(l => l.trim() !== '') ?? '', max)

// The step line's text: Haiku's, clipped, or the user's first words when Haiku gave none.
export const checkStep = (text: string, user: string): string =>
  text === '' ? `Asked: ${firstWords(user, 15)}` : clipWords(text, STEP_WORDS)

export type { Step }
