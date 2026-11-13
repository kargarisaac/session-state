import { emptyUsage } from './ledger'
import { tidy } from './redact'
import { UNSORTED, renderState, topicOf } from './state'
import { isAutomated, viaOf } from './transcript'
import type { FileEntry, Host, Moved, Note, State, TurnRecord, Usage } from './types'

type Merge = { keep: number; drop: number[] }
type Replacement = { old: number; new: number }
type Drop = { id: number; reason: string }
type Topic = { name: string; summary: string }
type Assignment = { id: number; topic: string }
type Reply = { merges: Merge[]; replaces: Replacement[]; done: number[]; dropped: Drop[]; topics: Topic[]; assign: Assignment[] }

export type Consolidation = { state: State; moved: Moved[]; usage: Usage; skipped: number; error?: string }

const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const line = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v)
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

const parse = (text: string): Reply => {
  const raw: unknown = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''))
  if (!object(raw) || !Array.isArray(raw.merges) || !Array.isArray(raw.replaces) || !Array.isArray(raw.done) || !Array.isArray(raw.dropped) || !Array.isArray(raw.topics) || !Array.isArray(raw.assign)) throw new Error('missing lists')
  if (!raw.merges.every(v => object(v) && integer(v.keep) && Array.isArray(v.drop) && v.drop.length > 0 && v.drop.every(integer)) ||
      !raw.replaces.every(v => object(v) && integer(v.old) && integer(v.new)) || !raw.done.every(integer) ||
      !raw.dropped.every(v => object(v) && integer(v.id) && line(v.reason)) ||
      !raw.topics.every(v => object(v) && line(v.name) && line(v.summary)) ||
      !raw.assign.every(v => object(v) && integer(v.id) && line(v.topic))) throw new Error('invalid list item')
  return raw as Reply
}

// Applies each change the code can check and skips the rest, so one bad item does not cost the whole pass.
export const applyConsolidation = (state: State, text: string, turn: number): { state: State; moved: Moved[]; skipped: number } => {
  const reply = parse(text)
  const active = new Map(state.notes.filter(n => n.status === 'active').map(n => [n.id, n]))
  const touched = new Set<number>()
  const removed = new Set<number>()
  const updates = new Map<number, Note>()
  const moved: Moved[] = []
  let skipped = 0
  // Each note takes part in one change at most.
  const claim = (ids: number[], check: (notes: Note[]) => boolean): Note[] | undefined => {
    const notes = ids.map(id => active.get(id))
    if (notes.some(n => n === undefined) || ids.some(id => touched.has(id)) || new Set(ids).size !== ids.length || !check(notes as Note[])) {
      skipped++
      return undefined
    }
    for (const id of ids) touched.add(id)
    return notes as Note[]
  }
  const remove = (n: Note, m: Omit<Moved, 'item' | 'turn'>) => {
    removed.add(n.id)
    moved.push({ item: n, turn, ...m })
  }
  for (const merge of reply.merges) {
    const got = claim([merge.keep, ...merge.drop], ([keep, ...drops]) => drops.every(n => n.id > keep!.id && n.kind === keep!.kind))
    if (got === undefined) continue
    const [keep, ...drops] = got
    updates.set(keep!.id, { ...keep!, count: got.reduce((sum, n) => sum + (n.count ?? 1), 0), lastTurn: Math.max(...got.map(n => n.lastTurn ?? n.turn)) })
    for (const n of drops) remove(n, { reason: 'merged', by: keep!.id })
  }
  for (const r of reply.replaces) {
    const got = claim([r.old, r.new], ([old, next]) => old!.kind === next!.kind && old!.id < next!.id)
    if (got !== undefined) remove(got[0]!, { reason: 'superseded', by: r.new })
  }
  // Only asks finish or are dropped: a rule, decision, preference or correction is only ever merged or replaced.
  for (const id of reply.done) {
    const got = claim([id], ([n]) => n!.kind === 'ask')
    if (got !== undefined) remove(got[0]!, { reason: 'done' })
  }
  for (const d of reply.dropped) {
    const got = claim([d.id], ([n]) => n!.kind === 'ask')
    if (got !== undefined) remove(got[0]!, { reason: 'dropped', note: d.reason.trim() })
  }
  const topics: Record<string, string> = {}
  for (const t of reply.topics) {
    const name = t.name.trim()
    if (name === UNSORTED || Object.hasOwn(topics, name) || RESERVED.test(name) || /[#[\]]/.test(name)) skipped++
    else topics[name] = t.summary.trim()
  }
  const assigned = new Map<number, string>()
  for (const a of reply.assign) {
    if (active.has(a.id) && !removed.has(a.id) && Object.hasOwn(topics, a.topic.trim())) assigned.set(a.id, a.topic.trim())
    else skipped++
  }
  const notes = state.notes
    .filter(n => !removed.has(n.id))
    .map(n => {
      const note = updates.get(n.id) ?? n
      const topic = assigned.get(n.id) ?? note.topic
      return topic === undefined || topic === UNSORTED ? note : { ...note, topic }
    })
  // A topic the reply left out keeps its old summary, so no note loses its section.
  for (const n of notes) {
    const t = topicOf(n)
    if (n.status === 'active' && t !== UNSORTED && !Object.hasOwn(topics, t)) topics[t] = state.topics[t] ?? ''
  }
  return { state: { ...state, notes, topics }, moved, skipped }
}

const RESERVED = /^(__proto__|constructor|prototype|Now|Topic index|Learnings|Files|Your notes)$/i
// What the pass reads: the newest steps and the person's messages since the last pass, clipped.
const STEP_LINES = 30
const MESSAGES = 40
const MESSAGE_CHARS = 1500

const STOP = new Set('a an and are as at be by for from in is it of on or that the this to was with you your'.split(' '))
const words = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length > 1 && !STOP.has(w)))
const similar = (a: string, b: string): boolean => {
  const left = words(a)
  const right = words(b)
  if (left.size < 3 || right.size < 3) return false
  if (['never', 'not', 'no', 'without', 'always'].some(w => left.has(w) !== right.has(w))) return false
  const shared = [...left].filter(w => right.has(w)).length
  return shared >= 3 && shared / Math.max(left.size, right.size) >= 0.7
}

export const standingRules = (state: State, others: readonly State[]): Note[] => {
  const rules = (s: State) => s.notes.filter(n => n.status === 'active' && n.via === undefined && (n.kind === 'requirement' || n.kind === 'preference' || n.kind === 'correction'))
  const peers = others.flatMap(rules)
  const found: Note[] = []
  for (const note of rules(state)) {
    if (peers.some(peer => similar(note.text, peer.text)) && !found.some(prev => similar(note.text, prev.text))) found.push(note)
  }
  return found
}

export const consolidate = async (host: Host, state: State, steps: string, archive: readonly TurnRecord[], since: number, turn: number, files: readonly FileEntry[]): Promise<Consolidation> => {
  let usage = emptyUsage()
  try {
    const result = await host.complete({
      system: 'Consolidate the session ledger. Return only JSON with merges [{keep,drop:[ids]}], replaces [{old,new}], done [ask ids], dropped [{id,reason}], topics [{name,summary}], assign [{id,topic}]. Use numeric ids. Merge only notes of the same kind, keep the lowest id. Replace only when a newer active note supersedes an older one. Mark only clearly finished asks done. Drop only asks clearly abandoned or exact duplicates. Never drop rules, decisions, preferences, or corrections. Include all current topics in index order and assign every surviving Unsorted note. Keep topic summaries to one line.',
      prompt: [
        `State:\n${renderState(state, files)}`,
        `Last steps:\n${steps.split('\n').filter(l => l.startsWith('- t')).slice(-STEP_LINES).join('\n')}`,
        `User messages since the last pass:\n${archive
          .filter(t => t.turn > since && !isAutomated(t.user) && viaOf(t.user) === undefined)
          .slice(-MESSAGES)
          .map(t => `t${t.turn}: ${tidy(t.user, MESSAGE_CHARS)}`)
          .join('\n')}`,
      ].join('\n\n'),
      effort: 'high',
    })
    usage = result.usage
    if (!result.isOk) throw new Error(result.reason)
    return { ...applyConsolidation(state, result.text, turn), usage }
  } catch (error) {
    return { state, moved: [], usage, skipped: 0, error: String(error) }
  }
}
