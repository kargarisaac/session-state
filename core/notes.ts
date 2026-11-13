import { KINDS } from './types'
import { topicIndex, topicOf } from './state'
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
      count: 1,
      lastTurn: turn,
      ...(m.topic === undefined ? {} : { topic: m.topic }),
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
  `Session ledger: a tool keeps the state of this conversation in ${dir}/. ` +
  'state.md has a Now block, a topic index, and one ## <topic> section per topic. ' +
  'Notes have permanent ids such as M-012. Grep state.md for a topic heading or id; ' +
  "grep events.jsonl for the user's exact past words. steps.md records each turn and history.md holds past notes. " +
  'The files may not exist until the first turn is recorded. Do not edit them; they are maintained automatically.'

// The rules that must hold for the whole chat, newest first.
export const rulesText = (state: State, cap = 3000): string => {
  const rules = activeNotes(state)
    .filter(n => n.via === undefined && (n.kind === 'correction' || ((n.kind === 'requirement' || n.kind === 'preference') && (n.count ?? 1) >= 2)))
    .sort((a, b) => (b.lastTurn ?? b.turn) - (a.lastTurn ?? a.turn) || b.id - a.id)
  if (rules.length === 0) return ''
  const head = 'Core rules the user gave in this conversation:'
  const shown: string[] = []
  for (const rule of rules) {
    const line = `- ${rule.text.replace(/\s+/g, ' ').trim()}`
    const left = rules.length - shown.length - 1
    const tail = left > 0 ? `\n(${left} more in state.md.)` : ''
    if ([head, ...shown, line].join('\n').length + tail.length > cap) {
      if (shown.length === 0) {
        const room = cap - head.length - tail.length - 2
        if (room > 3) shown.push(`${line.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/, '')}…`)
      }
      break
    }
    shown.push(line)
  }
  const left = rules.length - shown.length
  return [head, ...shown, ...(left > 0 ? [`(${left} more in state.md.)`] : [])].join('\n')
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

const INDEX_CHARS = 1500
const SYSTEM_CHARS = 3000

// The topic index and the core rules for the system prompt, together at most about 3 KB. Both change only when a
// topic or a core rule changes, so the prompt cache stays valid.
export const systemTexts = (state: State): [index: string, rules: string] => {
  const lines = topicIndex(state).split('\n').filter(Boolean)
  let shown = 0
  while (shown < lines.length && ['Topic index:', ...lines.slice(0, shown + 1), '(more in state.md)'].join('\n').length <= INDEX_CHARS) shown++
  const index = lines.length === 0 ? '' : ['Topic index:', ...lines.slice(0, shown), ...(shown < lines.length ? ['(more in state.md)'] : [])].join('\n')
  return [index, rulesText(state, SYSTEM_CHARS - index.length)]
}
