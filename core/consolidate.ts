import { emptyUsage } from './ledger'
import { UNSORTED, renderState, topicOf } from './state'
import { isAutomated, viaOf } from './transcript'
import type { FileEntry, Host, Moved, Note, State, TurnRecord, Usage } from './types'

type Merge = { keep: number; drop: number[] }
type Replacement = { old: number; new: number }
type Drop = { id: number; reason: string }
type Topic = { name: string; summary: string }
type Assignment = { id: number; topic: string }
type Reply = { merges: Merge[]; replaces: Replacement[]; done: number[]; dropped: Drop[]; topics: Topic[]; assign: Assignment[] }

export type Consolidation = { state: State; moved: Moved[]; usage: Usage; error?: string }

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

export const applyConsolidation = (state: State, text: string, turn: number): { state: State; moved: Moved[] } => {
  const reply = parse(text)
  const active = new Map(state.notes.filter(n => n.status === 'active').map(n => [n.id, n]))
  const removed = new Set<number>()
  const touched = new Set<number>()
  const moved: Moved[] = []
  const updates = new Map<number, Note>()
  const get = (id: number): Note => {
    const note = active.get(id)
    if (note === undefined) throw new Error(`inactive note ${id}`)
    return note
  }
  const claim = (id: number): Note => {
    const note = get(id)
    if (touched.has(id)) throw new Error(`note used twice ${id}`)
    touched.add(id)
    return note
  }
  for (const merge of reply.merges) {
    const keep = claim(merge.keep)
    const drops = merge.drop.map(claim)
    if (drops.some(n => n.id <= keep.id || n.kind !== keep.kind)) throw new Error('invalid merge')
    updates.set(keep.id, { ...keep, count: [keep, ...drops].reduce((sum, n) => sum + (n.count ?? 1), 0), lastTurn: Math.max(...[keep, ...drops].map(n => n.lastTurn ?? n.turn)) })
    for (const n of drops) {
      removed.add(n.id)
      moved.push({ item: n, reason: 'merged', by: keep.id, turn })
    }
  }
  for (const replace of reply.replaces) {
    const old = claim(replace.old)
    const next = claim(replace.new)
    if (old.kind !== next.kind || old.id === next.id) throw new Error('invalid replacement')
    removed.add(old.id)
    moved.push({ item: old, reason: 'superseded', by: next.id, turn })
  }
  for (const id of reply.done) {
    const note = claim(id)
    if (note.kind !== 'ask') throw new Error('only asks can be done')
    removed.add(id)
    moved.push({ item: note, reason: 'done', turn })
  }
  for (const drop of reply.dropped) {
    const note = claim(drop.id)
    if (note.kind !== 'ask') throw new Error('only asks can be dropped')
    removed.add(note.id)
    moved.push({ item: note, reason: 'dropped', note: drop.reason.trim(), turn })
  }
  const topics: Record<string, string> = {}
  for (const t of reply.topics) {
    const name = t.name.trim()
    if (name === UNSORTED || ['__proto__', 'constructor', 'prototype'].includes(name) || Object.hasOwn(topics, name) || /^(Now|Topic index|Learnings|Files|Your notes)$/i.test(name) || /[#\[\]]/.test(name)) throw new Error('invalid topic')
    topics[name] = t.summary.trim()
  }
  const assignments = new Map<number, string>()
  for (const a of reply.assign) {
    const note = get(a.id)
    const name = a.topic.trim()
    if (removed.has(a.id) || topicOf(note) !== UNSORTED || assignments.has(a.id) || !Object.hasOwn(topics, name)) throw new Error('invalid assignment')
    assignments.set(a.id, name)
  }
  const notes = state.notes.filter(n => !removed.has(n.id)).map(n => {
    const note = updates.get(n.id) ?? n
    if (note.status !== 'active') return note
    const topic = assignments.get(n.id) ?? topicOf(note)
    if (topic === UNSORTED || !Object.hasOwn(topics, topic)) throw new Error(`missing topic for ${n.id}`)
    return { ...note, topic }
  })
  return { state: { ...state, notes, topics }, moved }
}

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
      prompt: `State:\n${renderState(state, files)}\n\nSteps:\n${steps}\n\nUser messages since the last pass:\n${archive.filter(t => t.turn > since && !isAutomated(t.user) && viaOf(t.user) === undefined).map(t => `t${t.turn}: ${t.user}`).join('\n')}`,
      effort: 'high',
    })
    usage = result.usage
    if (!result.isOk) throw new Error(result.reason)
    return { ...applyConsolidation(state, result.text, turn), usage }
  } catch (error) {
    return { state, moved: [], usage, error: String(error) }
  }
}
