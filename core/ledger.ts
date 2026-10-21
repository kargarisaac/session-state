import { emptyFacts } from './facts'
import { clip, redact } from './redact'
import type { ExtractEvent, GateEvent, LedgerEvent, Turn, TurnFacts, TurnRecord, Usage } from './types'

// $ per million tokens, claude-haiku-5-5 up to 100k prompt tokens. Third-party figures; confirm on
// Anthropic's pricing page. The mod runs on a subscription, so this is plan usage expressed in API dollars.
export const HAIKU_PRICE = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }

export const haikuCost = (u: Usage): number =>
  (u.input * HAIKU_PRICE.input + u.output * HAIKU_PRICE.output + u.cacheRead * HAIKU_PRICE.cacheRead + u.cacheWrite * HAIKU_PRICE.cacheWrite) /
  1_000_000

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

export type Stats = {
  turns: number
  passed: number
  skipped: number
  gateErrors: number
  summaries: number
  extractions: number
  haikuErrors: number
  saved: number
  learned: number
  closed: number
  dropped: number
  lookups: number
  jevCost: number
  jevMs: number
  jevCalls: number
  haikuUsage: Usage
  haikuCost: number
  haikuMs: number
  lastGates: GateEvent[]
  lastError?: string
}

export const summarize = (events: readonly LedgerEvent[]): Stats => {
  const stats: Stats = {
    turns: 0, passed: 0, skipped: 0, gateErrors: 0, summaries: 0, extractions: 0, haikuErrors: 0, saved: 0, learned: 0,
    closed: 0, dropped: 0, lookups: 0, jevCost: 0, jevMs: 0, jevCalls: 0, haikuUsage: emptyUsage(), haikuCost: 0, haikuMs: 0,
    lastGates: [],
  }
  for (const e of events) {
    if (e.type === 'turn') continue
    if (e.type === 'gate') {
      stats.turns += 1
      if (e.action === 'skip') stats.skipped += 1
      else if (e.action === 'error') {
        stats.gateErrors += 1
        stats.lastError = e.error
      } else stats.passed += 1
      if (e.p !== null) {
        stats.jevCalls += 1
        stats.jevCost += e.cost
        stats.jevMs += e.ms
      }
      stats.lastGates.push(e)
      continue
    }
    if (e.mode === 'extract') stats.extractions += 1
    else stats.summaries += 1
    stats.saved += e.kept
    stats.learned += e.learned
    stats.closed += e.closed
    stats.dropped += e.dropped.length
    if (e.need !== undefined) stats.lookups += 1
    stats.haikuUsage = addUsage(stats.haikuUsage, e.usage)
    stats.haikuCost += haikuCost(e.usage)
    stats.haikuMs += e.ms
    if (e.error !== undefined) {
      stats.haikuErrors += 1
      stats.lastError = e.error
    }
  }
  stats.lastGates = stats.lastGates.slice(-8)
  return stats
}

const isFacts = (f: unknown): f is TurnFacts =>
  f !== null && typeof f === 'object' && Array.isArray((f as TurnFacts).read) && Array.isArray((f as TurnFacts).edited)

export const parseLedger = (text: string): LedgerEvent[] =>
  text
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap((line): LedgerEvent[] => {
      try {
        const e = JSON.parse(line) as LedgerEvent
        if (e.type === 'gate' || e.type === 'extract') return [e]
        if (e.type === 'turn') return [{ ...e, facts: isFacts(e.facts) ? { ...emptyFacts(), ...e.facts } : emptyFacts() }]
        return []
      } catch {
        return []
      }
    })

export const serializeLedger = (events: readonly LedgerEvent[]): string => events.map(e => JSON.stringify(e)).join('\n') + '\n'

// $.fs.write refuses a file over 4 MiB, and a chat that runs for days gets there. The file is kept under this.
export const LEDGER_MAX = 3_000_000
// What an old turn keeps of the user's words once the archive is full.
const OLD_USER = 300
const OLD_SLACK = 60
// The newest turns are never shrunk: the later turns read their words back.
const KEEP_RECENT = 20

const sizeOf = (e: LedgerEvent): number => new TextEncoder().encode(JSON.stringify(e)).length + 1

// Keeps the ledger under `max` bytes: the oldest turns give up their answer and most of their message first (their
// tool facts stay, so the file index keeps its counts), then the oldest events go. The newest turns are untouched.
export const fitLedger = (events: readonly LedgerEvent[], max = LEDGER_MAX): LedgerEvent[] => {
  const kept = [...events]
  const sizes = kept.map(sizeOf)
  let total = sizes.reduce((sum, n) => sum + n, 0)
  const recent = new Set(kept.flatMap((e, i) => (e.type === 'turn' ? [i] : [])).slice(-KEEP_RECENT))
  for (let i = 0; i < kept.length && total > max; i++) {
    const e = kept[i]!
    if (e.type !== 'turn' || recent.has(i) || (e.answer === '' && e.user.length <= OLD_USER + OLD_SLACK)) continue
    kept[i] = { ...e, user: clip(e.user, OLD_USER), answer: '' }
    const size = sizeOf(kept[i]!)
    total += size - sizes[i]!
    sizes[i] = size
  }
  let dropped = 0
  while (total > max && dropped < kept.length) total -= sizes[dropped++]!
  return kept.slice(dropped)
}

// The archive keeps each turn so later turns can still read it after Claude Code compacts the chat.
const ARCHIVE_USER = 8000
const ARCHIVE_ANSWER = 4000

export const turnRecord = (t: Turn, at: number): TurnRecord => ({
  type: 'turn',
  at,
  turn: t.turn,
  turnId: t.turnId,
  user: clip(redact(t.user), ARCHIVE_USER),
  answer: clip(redact(t.answer), ARCHIVE_ANSWER),
  facts: t.facts,
})

export const archivedTurns = (events: readonly LedgerEvent[]): TurnRecord[] =>
  events.filter((e): e is TurnRecord => e.type === 'turn')

export type { ExtractEvent }

// Turns waiting for Haiku survive a quit: the next start of the session picks them up.
export const serializePending = (turns: readonly Turn[]): string => JSON.stringify(turns)

export const parsePending = (text: string): Turn[] => {
  try {
    const list: unknown = JSON.parse(text)
    if (!Array.isArray(list)) return []
    return list
      .filter(
        (t): t is Turn =>
          t !== null && typeof t === 'object' && typeof t.turn === 'number' && typeof t.turnId === 'string' && typeof t.user === 'string' && typeof t.answer === 'string',
      )
      .map(t => ({
        ...t,
        previousAnswer: typeof t.previousAnswer === 'string' ? t.previousAnswer : '',
        isAborted: t.isAborted === true,
        facts: isFacts(t.facts) ? { ...emptyFacts(), ...t.facts } : emptyFacts(),
      }))
  } catch {
    return []
  }
}
