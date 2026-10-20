import { shortPath } from './facts'
import { KINDS, LEARN_KINDS } from './types'
import type { FileEntry, Kind, LearnKind, Learning, LearningDraft, Moved, Note, State } from './types'

export const LEGEND =
  'What the user asked and decided in this chat, what the agent learned, and the files that matter. Only what is true now: ' +
  'replaced and finished items move to history.md, and every turn has a line in steps.md. Each note quotes the user and names ' +
  'its turn; the transcript in the front matter has the full chat. Lines you write under "## Your notes" are kept.'

const SECTIONS = { asks: 'Open asks', rules: 'Decisions and rules', learnings: 'Learnings', files: 'Files', own: 'Your notes' } as const

const FRONT = /^---\n([\s\S]*?)\n---\n?/
const NOTE_HEAD = /^### M-(\d+) · ([a-z]+) · t(\d+)\s*$/
const LEARN_HEAD = /^### L-(\d+) · ([a-z]+) · t(\d+)\s*$/
const FILE_LINE = /^- `([^`]+)`.*?(?: · role: (.+))?$/

export const noteLabel = (id: number): string => `M-${String(id).padStart(3, '0')}`
export const learnLabel = (id: number): string => `L-${String(id).padStart(3, '0')}`

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

export const emptyState = (front: Record<string, string>): State => ({ front: { ...front }, notes: [], learnings: [], roles: {}, own: [] })

const parseFront = (md: string): { front: Record<string, string>; body: string } => {
  const front: Record<string, string> = {}
  const head = FRONT.exec(md)
  if (head === null) return { front, body: md }
  for (const line of head[1]!.split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) front[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { front, body: md.slice(head[0].length) }
}

type Block = { head: RegExpExecArray; isNote: boolean; text: string[]; fields: Record<string, string> }

const FIELD = /^(Why|Context|Quote|Source|Evidence): ?(.*)$/

const unquote = (s: string): string => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s)

const sourceOf = (s: string): Note['source'] => ({
  turnId: /\bturn (\S+)/.exec(s)?.[1] ?? '',
  refersTo: [...(/answers ((?:t\d+(?:, )?)+)/.exec(s)?.[1] ?? '').matchAll(/t(\d+)/g)].map(m => Number(m[1])),
})

const finish = (b: Block, state: State): void => {
  const text = oneLine(b.text.join(' '))
  if (b.isNote) {
    if (!(KINDS as readonly string[]).includes(b.head[2]!)) return
    state.notes.push({
      id: Number(b.head[1]),
      kind: b.head[2] as Kind,
      turn: Number(b.head[3]),
      text,
      why: b.fields.Why ?? '',
      context: b.fields.Context ?? '',
      quote: unquote(b.fields.Quote ?? ''),
      source: sourceOf(b.fields.Source ?? ''),
      status: 'active',
    })
  } else {
    if (!(LEARN_KINDS as readonly string[]).includes(b.head[2]!)) return
    state.learnings.push({
      id: Number(b.head[1]),
      kind: b.head[2] as LearnKind,
      turn: Number(b.head[3]),
      text,
      why: b.fields.Why ?? '',
      evidence: unquote(b.fields.Evidence ?? ''),
      status: 'active',
    })
  }
}

// Reads state.md back, so the person's edits stand. Anything it does not recognise outside "Your notes" is
// dropped on the next write; nothing throws.
export const parseState = (md: string): State => {
  const { front, body } = parseFront(md)
  const state = emptyState(front)
  let section = ''
  let block: Block | undefined
  const close = () => {
    if (block !== undefined) finish(block, state)
    block = undefined
  }
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      close()
      section = line.slice(3).trim()
      continue
    }
    if (section === SECTIONS.own) {
      if (line.trim() !== '') state.own.push(line)
      continue
    }
    const note = NOTE_HEAD.exec(line)
    const learn = note === null ? LEARN_HEAD.exec(line) : null
    if (note !== null || learn !== null) {
      close()
      block = { head: (note ?? learn)!, isNote: note !== null, text: [], fields: {} }
      continue
    }
    if (section === SECTIONS.files) {
      const f = FILE_LINE.exec(line)
      if (f !== null && f[2] !== undefined) state.roles[f[1]!] = f[2].trim()
      continue
    }
    if (block === undefined || line.trim() === '') continue
    const field = FIELD.exec(line)
    if (field !== null) block.fields[field[1]!] = field[2]!.trim()
    else block.text.push(line.trim())
  }
  close()
  // state.md groups asks before rules; the ledger keeps them in id order.
  state.notes.sort((a, b) => a.id - b.id)
  return state
}

const sourceLine = (n: Note): string => {
  const parts = [`t${n.turn}`]
  if (n.source.turnId !== '') parts.push(`turn ${n.source.turnId.slice(0, 8)}`)
  if (n.source.refersTo.length > 0) parts.push(`answers ${n.source.refersTo.map(t => `t${t}`).join(', ')}`)
  return parts.join(' · ')
}

export const noteBlock = (n: Note, tail = ''): string =>
  [
    `### ${noteLabel(n.id)} · ${n.kind} · t${n.turn}${tail}`,
    oneLine(n.text),
    ...(n.why === '' ? [] : [`Why: ${oneLine(n.why)}`]),
    ...(n.context === '' ? [] : [`Context: ${oneLine(n.context)}`]),
    ...(n.quote === '' ? [] : [`Quote: "${oneLine(n.quote)}"`]),
    `Source: ${sourceLine(n)}`,
  ].join('\n')

export const learningBlock = (l: Learning, tail = ''): string =>
  [
    `### ${learnLabel(l.id)} · ${l.kind} · t${l.turn}${tail}`,
    oneLine(l.text),
    ...(l.why === '' ? [] : [`Why: ${oneLine(l.why)}`]),
    ...(l.evidence === '' ? [] : [`Evidence: "${oneLine(l.evidence)}"`]),
  ].join('\n')

export const fileLine = (f: FileEntry, cwd: string): string => {
  const counts = [f.edits > 0 ? `edited ${f.edits}` : '', f.reads > 0 ? `read ${f.reads}` : ''].filter(Boolean).join(', ')
  const turns = f.first === f.last ? `t${f.first}` : `t${f.first}–t${f.last}`
  return `- \`${shortPath(f.path, cwd)}\` · ${counts} · ${turns}${f.role === '' ? '' : ` · role: ${oneLine(f.role)}`}`
}

const section = (title: string, items: string[]): string => `## ${title}\n${items.length === 0 ? '_None._' : items.join('\n\n')}\n`

// The whole of state.md. `files` are the ranked files; their roles come from the state.
export const renderState = (state: State, files: readonly FileEntry[]): string => {
  const front = Object.entries(state.front)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const title = state.front.title === undefined || state.front.title === '' ? 'Session ledger' : state.front.title
  const cwd = state.front.cwd ?? ''
  const active = state.notes.filter(n => n.status === 'active')
  const asks = active.filter(n => n.kind === 'ask').map(n => noteBlock(n))
  const rules = active.filter(n => n.kind !== 'ask').map(n => noteBlock(n))
  const learnings = state.learnings.filter(l => l.status === 'active').map(l => learningBlock(l))
  const fileLines = files.map(f => fileLine({ ...f, role: roleOf(state, f.path) || f.role }, cwd))
  return [
    `---\n${front}\n---\n# ${title}\n${LEGEND}\n`,
    section(SECTIONS.asks, asks),
    section(SECTIONS.rules, rules),
    section(SECTIONS.learnings, learnings),
    `## ${SECTIONS.files}\n${fileLines.length === 0 ? '_None yet._' : fileLines.join('\n')}\n`,
    `## ${SECTIONS.own}\n${state.own.join('\n')}${state.own.length > 0 ? '\n' : ''}`,
  ].join('\n')
}

export const HISTORY_HEAD = '# History\nItems that left state.md, oldest first: replaced by a newer one, or done.\n'

export const historyBlock = (m: Moved): string => {
  const isNote = isNoteItem(m.item)
  const by = isNote ? noteLabel(m.by ?? 0) : learnLabel(m.by ?? 0)
  const why = m.reason === 'done' ? ` · done at t${m.turn}` : ` · replaced by ${by} at t${m.turn}`
  return isNoteItem(m.item) ? noteBlock(m.item, why) : learningBlock(m.item, why)
}

const isNoteItem = (item: Note | Learning): item is Note => 'quote' in item

// An old single-file notes file (before 0.3) seeds a new ledger once: its active notes, nothing else.
export const seedState = (oldNotes: { id: number; turn: number; kind: Kind; text: string }[], front: Record<string, string>): State => {
  const next = oldNotes.reduce((top, n) => Math.max(top, n.id + 1), Number(front.next_id) || 1)
  return {
    ...emptyState({ ...front, next_id: String(next) }),
    notes: oldNotes.map(n => ({ ...n, why: '', context: '', quote: '', source: { turnId: '', refersTo: [] }, status: 'active' as const })),
  }
}

const nextId = (state: State, key: 'next_id' | 'next_learning', used: number[]): number =>
  Math.max(Number(state.front[key]) || 1, used.reduce((top, id) => Math.max(top, id + 1), 1))

export const applyLearnings = (state: State, drafts: LearningDraft[], turn: number): { state: State; moved: Moved[] } => {
  if (drafts.length === 0) return { state, moved: [] }
  let next = nextId(state, 'next_learning', state.learnings.map(l => l.id))
  let learnings = [...state.learnings]
  const moved: Moved[] = []
  for (const d of drafts) {
    const id = next++
    for (const old of learnings.filter(l => d.replaces.includes(l.id))) moved.push({ item: old, reason: 'superseded', by: id, turn })
    learnings = learnings.filter(l => !d.replaces.includes(l.id))
    learnings.push({ id, turn, kind: d.kind, text: d.text, why: d.why, evidence: d.evidence, status: 'active' })
  }
  return { state: { ...state, learnings, front: { ...state.front, next_learning: String(next) } }, moved }
}

// Roles are kept under the path as state.md shows it (relative to the session's folder), so hand edits match.
export const roleOf = (state: State, path: string): string => state.roles[shortPath(path, state.front.cwd ?? '')] ?? ''

export const applyFileRoles = (state: State, roles: { path: string; role: string }[]): State =>
  roles.length === 0
    ? state
    : { ...state, roles: { ...state.roles, ...Object.fromEntries(roles.map(r => [shortPath(r.path, state.front.cwd ?? ''), r.role])) } }
