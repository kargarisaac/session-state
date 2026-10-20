import { noteLabel } from './extract'
import { KINDS } from './types'
import type { Doc, Item, Kind, Memory, Note } from './types'

export const LEGEND =
  'Notes of what you asked and decided in this chat, oldest first. A later line overrides an earlier one. ' +
  'Struck-through lines are history: replaced ("superseded") or finished ("done"). Keep your own notes as lines that start with "- ".'

const FRONT = /^---\n([\s\S]*?)\n---\n?/
const LINE = /^- (~~)?M-(\d+) · t(\d+) · ([a-z]+) · (.*?)(?:~~)?(?: → (?:superseded by M-(\d+)|done t(\d+)))?\s*$/

export const isNote = (item: Item): item is Note => 'id' in item

export const activeNotes = (doc: Doc): Note[] => doc.items.filter(isNote).filter(n => n.status === 'active')

// Requests still to be done. Only these can be marked finished: a rule or a choice never is.
export const openAsks = (doc: Doc): Note[] => activeNotes(doc).filter(n => n.kind === 'ask')

const parseLine = (line: string): Item => {
  const m = LINE.exec(line)
  if (m === null || !(KINDS as readonly string[]).includes(m[4]!)) return { raw: line }
  const isDone = m[7] !== undefined
  const isStruck = m[1] !== undefined || m[6] !== undefined || isDone
  return {
    id: Number(m[2]),
    turn: Number(m[3]),
    kind: m[4] as Kind,
    text: m[5]!.trimEnd(),
    status: isDone ? 'done' : isStruck ? 'superseded' : 'active',
    ...(m[6] === undefined ? {} : { supersededBy: Number(m[6]) }),
    ...(isDone ? { doneAt: Number(m[7]) } : {}),
  }
}

export const parseDoc = (md: string): Doc => {
  const front: Record<string, string> = {}
  let body = md
  const head = FRONT.exec(md)
  if (head !== null) {
    for (const line of head[1]!.split('\n')) {
      const at = line.indexOf(':')
      if (at > 0) front[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
    body = md.slice(head[0].length)
  }
  const items = body
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(parseLine)
  return { front, items }
}

export const noteLine = (n: Note): string => {
  const core = `${noteLabel(n.id)} · t${n.turn} · ${n.kind} · ${n.text}`
  if (n.status === 'active') return `- ${core}`
  if (n.status === 'done') return `- ~~${core}~~${n.doneAt === undefined ? '' : ` → done t${n.doneAt}`}`
  return `- ~~${core}~~${n.supersededBy === undefined ? '' : ` → superseded by ${noteLabel(n.supersededBy)}`}`
}

export const renderDoc = (doc: Doc): string => {
  const front = Object.entries(doc.front)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const title = doc.front.title === undefined || doc.front.title === '' ? 'Session notes' : doc.front.title
  const lines = doc.items.map(i => (isNote(i) ? noteLine(i) : i.raw))
  return `---\n${front}\n---\n# ${title}\n${LEGEND}\n\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`
}

export type SessionFacts = { sessionId: string; project: string; cwd: string; started: string; transcript: string }

export const newDoc = (f: SessionFacts): Doc => ({
  front: {
    session_id: f.sessionId,
    project: f.project,
    cwd: f.cwd,
    started: f.started,
    transcript: f.transcript,
    resume: `claude --resume ${f.sessionId}`,
    title: '',
    next_id: '1',
  },
  items: [],
})

const maxId = (doc: Doc): number => doc.items.filter(isNote).reduce((top, n) => Math.max(top, n.id), 0)

export const applyMemories = (doc: Doc, memories: Memory[], turn: number, title: string, done: number[] = []): Doc => {
  let next = Math.max(Number(doc.front.next_id) || 1, maxId(doc) + 1)
  const items: Item[] = doc.items.map(i => ({ ...i }))
  for (const m of memories) {
    const id = next++
    for (const target of items) {
      if (isNote(target) && m.supersedes.includes(target.id) && target.status === 'active') {
        target.status = 'superseded'
        target.supersededBy = id
      }
    }
    items.push({ id, turn, kind: m.kind, text: m.text, status: 'active' })
  }
  for (const target of items) {
    if (isNote(target) && done.includes(target.id) && target.status === 'active') {
      target.status = 'done'
      target.doneAt = turn
    }
  }
  const front: Record<string, string> = { ...doc.front, next_id: String(next) }
  if (title !== '' && (front.title === undefined || front.title === '')) front.title = title
  return { front, items }
}

// What the agent is told about the file. It must read the same on every request of a session, so the
// prompt cache is written once: no counts, no times, only the path.
export const pointerText = (file: string): string =>
  `Session notes: a tool keeps short notes of what the user asked and decided in this conversation at ${file}. ` +
  'The file may not exist until the first note is saved. Lines are in the order the user said things, oldest first; ' +
  'a later line overrides an earlier one, and struck-through (~~) lines are history. ' +
  'Read it with the Read tool when you need to recall what the user asked or decided, after a compaction, ' +
  'or when you are unsure which decision is current. Do not edit it; it is maintained automatically.'

const MAX_RULES = 8

// The few rules that must hold all chat long, for the system prompt. Empty when the person has none.
export const rulesText = (doc: Doc): string => {
  const rules = activeNotes(doc).filter(n => n.kind === 'requirement' || n.kind === 'preference')
  if (rules.length === 0) return ''
  const shown = rules.slice(-MAX_RULES)
  const older = rules.length - shown.length
  return [
    'Standing rules the user gave in this conversation, from the session notes. They still apply:',
    ...shown.map(r => `- ${r.text}`),
    ...(older > 0 ? [`(${older} older rule${older === 1 ? ' is' : 's are'} in the notes file.)`] : []),
  ].join('\n')
}

export type IndexRow = { file: string; date: string; title: string; active: number; done: number; superseded: number }

const rowOf = (r: IndexRow): string =>
  `| ${r.date} | ${r.title === '' ? '(untitled)' : r.title.replace(/\|/g, '/')} | ${r.active} active, ${r.done} done, ${r.superseded} superseded | [${r.file}](${r.file}) |`

export const upsertIndex = (md: string, project: string, row: IndexRow): string => {
  const rows = md
    .split('\n')
    .filter(line => line.startsWith('| ') && line.includes('](') && !line.includes(`[${row.file}](`))
  rows.push(rowOf(row))
  rows.sort((a, b) => (a.split('[').pop() ?? '').localeCompare(b.split('[').pop() ?? '')).reverse()
  return `# Session notes: ${project}\n\n| Date | Title | Notes | File |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`
}
