import { shortPath } from './facts'
import { KINDS, LEARN_KINDS } from './types'
import type { FileEntry, Kind, LearnKind, Learning, LearningDraft, Moved, Note, State } from './types'

export const LEGEND =
  'What the user asked and decided in this chat, what the agent learned, and the files that matter. Only what is true now: ' +
  'Now tracks the current work; the topic index points to notes grouped by topic. Each note quotes the user and names ' +
  'its turn. Removed items move to history.md; steps.md records each turn. Lines under "## Your notes" are kept.'

const SECTIONS = { now: 'Now', index: 'Topic index', asks: 'Open asks', rules: 'Decisions and rules', learnings: 'Learnings', files: 'Files', own: 'Your notes' } as const

const FRONT = /^---\n([\s\S]*?)\n---\n?/
const NOTE_HEAD = /^### M-(\d+) · ([a-z]+) · t(\d+)\s*$/
const LEARN_HEAD = /^### L-(\d+) · ([a-z]+) · t(\d+)\s*$/
const FILE_LINE = /^- `([^`]+)`.*?(?: · role: (.+))?$/

export const noteLabel = (id: number): string => `M-${String(id).padStart(3, '0')}`
export const learnLabel = (id: number): string => `L-${String(id).padStart(3, '0')}`

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

export const emptyState = (front: Record<string, string>): State => ({ front: { ...front }, notes: [], learnings: [], roles: {}, own: [], now: '', topics: {} })

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

const FIELD = /^(Why|Context|Quote|Via|Source|Evidence): ?(.*)$/

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
      ...(b.fields.Via === undefined || b.fields.Via === '' ? {} : { via: b.fields.Via }),
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
// Fields a note line does not show, kept in a short comment so state.md round-trips.
type Hidden = { turn?: number; turnId?: string; refersTo?: number[]; context?: string; via?: string; textLength?: number }

const hiddenText = (n: Note): string =>
  JSON.stringify({
    ...(n.turn === (n.lastTurn ?? n.turn) ? {} : { turn: n.turn }),
    turnId: n.source.turnId,
    ...(n.source.refersTo.length === 0 ? {} : { refersTo: n.source.refersTo }),
    ...(n.context === '' ? {} : { context: oneLine(n.context) }),
    ...(n.via === undefined ? {} : { via: n.via }),
    // A text with a double quote in it cannot be split from the quote by pattern alone.
    ...(n.text.includes('"') ? { textLength: oneLine(n.text).length } : {}),
  }).replace(/-->/g, '--\\u003e')

const hiddenOf = (text: string | undefined): Hidden => {
  try {
    const h = JSON.parse(text ?? '{}')
    return h !== null && typeof h === 'object' ? (h as Hidden) : {}
  } catch {
    // A broken comment must not hide the note.
    return {}
  }
}

export const parseState = (md: string): State => {
  const { front, body } = parseFront(md.replace(/\r\n?/g, '\n'))
  const state = emptyState(front)
  let section = ''
  let block: Block | undefined
  let lastNote: Note | undefined
  const now: string[] = []
  const close = () => {
    if (block !== undefined) finish(block, state)
    block = undefined
  }
  for (const line of body.split('\n')) {
    // "Your notes" is the last section: from its heading on, everything is the person's, blank lines and headings too.
    if (section === SECTIONS.own) {
      if (state.own.length > 0 || line.trim() !== '') state.own.push(line)
      continue
    }
    if (line.startsWith('## ')) {
      close()
      section = line.slice(3).trim()
      lastNote = undefined
      continue
    }
    if (section === SECTIONS.now) {
      now.push(line)
      continue
    }
    if (section === SECTIONS.index) {
      const entry = /^- (.*?)(?:: (.*?))?(?: (?:M-\d+)(?: M-\d+)*)?$/.exec(line)
      if (entry !== null) state.topics[entry[1]!] = entry[2] ?? ''
      continue
    }
    const item = /^- M-(\d+) · ([a-z]+) · (.*?) \(t(\d+)(?:, said (\d+) times)?\)(?: <!-- (.*?) -->)?$/.exec(line)
    if (item !== null && (KINDS as readonly string[]).includes(item[2]!)) {
      close()
      const hidden = hiddenOf(item[6])
      // The line shows `text "quote"`, or `text via: "quote"` for a relayed note.
      const body = hidden.via === undefined ? item[3]! : item[3]!.replace(` ${oneLine(hidden.via)}: "`, ' "')
      const words =
        hidden.textLength === undefined
          ? /^(.*?)(?: "(.*)")?$/.exec(body)!
          : [body, body.slice(0, hidden.textLength), /^ "(.*)"$/.exec(body.slice(hidden.textLength))?.[1]]
      lastNote = {
        id: Number(item[1]),
        kind: item[2] as Kind,
        turn: hidden.turn ?? Number(item[4]),
        text: words[1]!,
        why: '',
        context: hidden.context ?? '',
        quote: words[2] ?? '',
        source: { turnId: hidden.turnId ?? '', refersTo: hidden.refersTo ?? [] },
        status: 'active',
        count: item[5] === undefined ? 1 : Number(item[5]),
        lastTurn: Number(item[4]),
        ...(section === UNSORTED ? {} : { topic: section }),
        ...(hidden.via === undefined ? {} : { via: hidden.via }),
      }
      state.notes.push(lastNote)
      continue
    }
    if (lastNote !== undefined && line.startsWith('  Why: ')) {
      lastNote.why = line.slice(7).trim()
      continue
    }
    lastNote = undefined
    const note = NOTE_HEAD.exec(line)
    const learn = note === null ? LEARN_HEAD.exec(line) : null
    if (note !== null || learn !== null) {
      close()
      block = { head: (note ?? learn)!, isNote: note !== null, text: [], fields: {} }
      continue
    }
    // A heading the person broke by hand ends the block above it and drops its own lines, so they cannot rewrite it.
    if (line.startsWith('### ')) {
      close()
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
  state.now = now.join('\n').trim()
  if (state.now === '_None._') state.now = ''
  while (state.own.length > 0 && state.own[state.own.length - 1]!.trim() === '') state.own.pop()
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
    ...(n.via === undefined ? [] : [`Via: ${oneLine(n.via)}`]),
    `Source: ${sourceLine(n)}`,
  ].join('\n')

export const UNSORTED = 'Unsorted'
export const topicOf = (n: { topic?: string }): string => n.topic?.trim() || UNSORTED

// One line per note: what to act on, the person's words, the last turn and how often they said it, then a one-line Why.
export const noteLine = (n: Note): string => {
  const said = (n.count ?? 1) > 1 ? `, said ${n.count} times` : ''
  const quote = n.quote === '' ? '' : ` ${n.via === undefined ? '' : `${n.via}: `}"${oneLine(n.quote)}"`
  const why = n.why === '' ? '' : `\n  Why: ${oneLine(n.why)}`
  return `- ${noteLabel(n.id)} · ${n.kind} · ${oneLine(n.text)}${quote} (t${n.lastTurn ?? n.turn}${said})${why}`
}

// Topics in index order: the index first, then topics that only active notes name.
export const topicNames = (state: State): string[] => [
  ...new Set([...Object.keys(state.topics), ...state.notes.filter(n => n.status === 'active').map(topicOf)]),
]

// One line per topic: its summary and the ids of its active notes.
export const topicIndex = (state: State): string =>
  topicNames(state)
    .map(t => {
      const ids = state.notes.filter(n => n.status === 'active' && topicOf(n) === t).map(n => noteLabel(n.id))
      const summary = state.topics[t] ?? ''
      return `- ${t}${summary === '' ? '' : `: ${oneLine(summary)}`}${ids.length === 0 ? '' : ` ${ids.join(' ')}`}`
    })
    .join('\n')

// A topic's full section: its heading and one line per active note.
export const topicSection = (state: State, topic: string): string =>
  [`## ${topic}`, ...state.notes.filter(n => n.status === 'active' && topicOf(n) === topic).map(noteLine)].join('\n')

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
  const topics = topicNames(state).map(topic => {
    const notes = state.notes.filter(n => n.status === 'active' && topicOf(n) === topic).map(n => {
      const [line, ...rest] = noteLine(n).split('\n')
      return [`${line} <!-- ${hiddenText(n)} -->`, ...rest].join('\n')
    })
    return section(topic, notes)
  })
  const learnings = state.learnings.filter(l => l.status === 'active').map(l => learningBlock(l))
  const fileLines = files.map(f => fileLine({ ...f, role: roleOf(state, f.path) || f.role }, cwd))
  return [
    `---\n${front}\n---\n# ${title}\n${LEGEND}\n`,
    section(SECTIONS.now, state.now === '' ? [] : [state.now]),
    section(SECTIONS.index, topicIndex(state) === '' ? [] : [topicIndex(state)]),
    ...topics,
    section(SECTIONS.learnings, learnings),
    `## ${SECTIONS.files}\n${fileLines.length === 0 ? '_None yet._' : fileLines.join('\n')}\n`,
    `## ${SECTIONS.own}\n${state.own.join('\n')}${state.own.length > 0 ? '\n' : ''}`,
  ].join('\n')
}

export const HISTORY_HEAD = '# History\nItems that left state.md, oldest first: replaced, done, merged, or dropped.\n'

export const historyBlock = (m: Moved): string => {
  const isNote = isNoteItem(m.item)
  const by = isNote ? noteLabel(m.by ?? 0) : learnLabel(m.by ?? 0)
  const action = m.reason === 'superseded' ? `replaced by ${by}` : m.reason === 'merged' ? `merged${m.by === undefined ? '' : ` into ${by}`}` : m.reason
  const why = ` · ${action} at t${m.turn}`
  const block = isNoteItem(m.item) ? noteBlock(m.item, why) : learningBlock(m.item, why)
  return m.note === undefined || m.note === '' ? block : `${block}\nNote: ${oneLine(m.note)}`
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
