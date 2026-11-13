import { KINDS } from './types'
import { topicOf } from './state'
import type { Kind, Memory, Moved, Note, State } from './types'

export const activeNotes = (state: State): Note[] => state.notes.filter(n => n.status === 'active')

// Requests still to be done. Only these can be marked finished: a rule or a choice never is.
export const openAsks = (state: State): Note[] => activeNotes(state).filter(n => n.kind === 'ask')

export type OldNote = { id: number; turn: number; kind: Kind; text: string }

const OLD_FRONT = /^---\n([\s\S]*?)\n---\n?/
const OLD_LINE = /^- (~~)?M-(\d+) · t(\d+) · ([a-z]+) · (.*?)(?:~~)?(?: → (?:superseded by M-(\d+)|done t(\d+)))?\s*$/

// A notes file from before 0.3 (one `<date>_<id8>.md`): its title and its active notes, to seed a ledger.
export const parseOldNotes = (md: string): { title: string; notes: OldNote[] } => {
  const head = OLD_FRONT.exec(md)
  const title = head === null ? '' : (/^title:\s*(.*)$/m.exec(head[1]!)?.[1] ?? '').trim()
  const notes: OldNote[] = []
  for (const line of md.split('\n')) {
    const m = OLD_LINE.exec(line)
    if (m === null || m[1] !== undefined || m[6] !== undefined || m[7] !== undefined) continue
    if (!(KINDS as readonly string[]).includes(m[4]!)) continue
    notes.push({ id: Number(m[2]), turn: Number(m[3]), kind: m[4] as Kind, text: m[5]!.trimEnd() })
  }
  return { title, notes }
}

export type SessionFacts = { sessionId: string; project: string; cwd: string; started: string; transcript: string }

export const newFront = (f: SessionFacts): Record<string, string> => ({
  session_id: f.sessionId,
  project: f.project,
  cwd: f.cwd,
  started: f.started,
  transcript: f.transcript,
  resume: `claude --resume ${f.sessionId}`,
  title: '',
  next_id: '1',
  next_learning: '1',
})

const repeatOf = (m: Memory, notes: Note[], via?: string): Note | undefined => {
  const words = (s: string) => [...new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
  const a = words(m.quote)
  return notes.find(n => {
    if (n.status !== 'active' || n.kind !== m.kind || n.via !== via || topicOf(n) !== topicOf(m)) return false
    const b = words(n.quote)
    if (m.quote.trim().length < 3 || n.quote.trim().length < 3 || a.length === 0 || b.length === 0) return false
    // Four fifths of both quotes must match, so a short shared phrase alone cannot merge two rules.
    return a.filter(w => b.includes(w)).length / Math.max(a.length, b.length) >= 0.8
  })
}

// New notes get the next id; a note that replaces or finishes another moves the old one out of the state.
export const applyMemories = (
  state: State,
  memories: Memory[],
  turn: number,
  turnId: string,
  title: string,
  done: number[] = [],
  via?: string,
  restates: number[] = [],
): { state: State; moved: Moved[] } => {
  let next = Math.max(Number(state.front.next_id) || 1, state.notes.reduce((top, n) => Math.max(top, n.id + 1), 1))
  let notes = [...state.notes]
  const moved: Moved[] = []
  const repeated = new Set<number>()
  const mark = (id: number) => {
    if (repeated.has(id)) return
    repeated.add(id)
    notes = notes.map(n => n.id === id && n.status === 'active' && n.via === via
      ? { ...n, count: (n.count ?? 1) + 1, lastTurn: turn }
      : n)
  }
  for (const id of restates) mark(id)
  for (const m of memories) {
    const repeat = m.supersedes.length === 0 ? repeatOf(m, notes, via) : undefined
    if (repeat !== undefined) {
      mark(repeat.id)
      continue
    }
    const id = next++
    for (const old of notes.filter(n => m.supersedes.includes(n.id))) moved.push({ item: old, reason: 'superseded', by: id, turn })
    notes = notes.filter(n => !m.supersedes.includes(n.id))
    notes.push({
      id,
      turn,
      kind: m.kind,
      text: m.text,
      why: m.why,
      context: m.context,
      quote: m.quote,
      source: { turnId, refersTo: m.refersTo },
      status: 'active',
      ...(m.topic === undefined ? {} : { topic: m.topic, count: 1, lastTurn: turn }),
      ...(via === undefined ? {} : { via }),
    })
  }
  for (const old of notes.filter(n => done.includes(n.id) && n.kind === 'ask')) moved.push({ item: old, reason: 'done', turn })
  notes = notes.filter(n => !(done.includes(n.id) && n.kind === 'ask'))
  const front: Record<string, string> = { ...state.front, next_id: String(next) }
  if (title !== '' && (front.title === undefined || front.title === '')) front.title = title
  return { state: { ...state, notes, front }, moved }
}

// What the agent is told about the ledger. It must read the same on every request of a session, so the
// prompt cache is written once: no counts, no times, only the folder.
export const pointerText = (dir: string): string =>
  `Session ledger: a tool keeps a ledger of this conversation in ${dir}/. ` +
  'state.md holds what is true now: the user\'s open asks, their decisions and rules with the reason and their exact words, ' +
  'what was learned the hard way, and the files that matter with their roles. steps.md has one line per turn; history.md has ' +
  'replaced and finished items. The files may not exist until the first turn is recorded. Read state.md when you need to ' +
  'recall what the user asked or decided or which files matter, after a compaction, or when you are unsure which decision is ' +
  'current. Do not edit these files; they are maintained automatically.'

const MAX_RULES = 8

// The few rules that must hold all chat long, for the system prompt. Empty when the person has none.
export const rulesText = (state: State): string => {
  // A rule another session relayed is not the person's own word, so it is not pinned.
  const rules = activeNotes(state).filter(n => (n.kind === 'requirement' || n.kind === 'preference') && n.via === undefined)
  if (rules.length === 0) return ''
  const shown = rules.slice(-MAX_RULES)
  const older = rules.length - shown.length
  return [
    'Standing rules the user gave in this conversation, from the session ledger. They still apply:',
    ...shown.map(r => `- ${r.text}`),
    ...(older > 0 ? [`(${older} older rule${older === 1 ? ' is' : 's are'} in state.md.)`] : []),
  ].join('\n')
}

export type IndexRow = { file: string; date: string; title: string; active: number; learned: number; steps: number }

const rowOf = (r: IndexRow): string =>
  `| ${r.date} | ${r.title === '' ? '(untitled)' : r.title.replace(/\|/g, '/')} | ${r.active} notes, ${r.learned} learned, ${r.steps} turns | [${r.file}](${r.file}) |`

export const upsertIndex = (md: string, project: string, row: IndexRow): string => {
  const rows = md
    .split('\n')
    .filter(line => line.startsWith('| ') && line.includes('](') && !line.includes(`[${row.file}](`))
  rows.push(rowOf(row))
  rows.sort((a, b) => (a.split('[').pop() ?? '').localeCompare(b.split('[').pop() ?? '')).reverse()
  return `# Session ledgers: ${project}\n\n| Date | Title | Ledger | Folder |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`
}
