import { roleOf } from './state'
import type { FileEntry, State, TurnRecord } from './types'

const TOP = 15

// Every file the main agent read or edited, from the archived turns.
export const fileIndex = (records: readonly TurnRecord[]): FileEntry[] => {
  const byPath = new Map<string, FileEntry>()
  const touch = (path: string, turn: number, isEdit: boolean) => {
    const e = byPath.get(path) ?? { path, reads: 0, edits: 0, first: turn, last: turn, role: '', score: 0 }
    if (isEdit) e.edits += 1
    else e.reads += 1
    e.first = Math.min(e.first, turn)
    e.last = Math.max(e.last, turn)
    byPath.set(path, e)
  }
  for (const r of records) {
    for (const p of r.facts.edited) touch(p, r.turn, true)
    for (const p of r.facts.read) touch(p, r.turn, false)
  }
  return [...byPath.values()]
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

// Edited files first, then the ones touched often and lately, and the ones the user's notes name.
export const rankFiles = (index: readonly FileEntry[], state: State, now: number, top = TOP): FileEntry[] => {
  const noteText = state.notes
    .filter(n => n.status === 'active')
    .map(n => `${n.text} ${n.why}`)
    .join(' ')
  return index
    .map(e => {
      const isNamed = noteText.includes(baseName(e.path))
      const recency = 1 / (1 + Math.max(0, now - e.last) / 10)
      const score = (e.edits > 0 ? 3 : 0) + Math.log(1 + e.reads + e.edits) + 2 * recency + (isNamed ? 2 : 0)
      return { ...e, role: roleOf(state, e.path), score }
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, top)
}
