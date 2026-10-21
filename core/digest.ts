import { shortPath } from './facts'
import { activeNotes } from './notes'
import { learnLabel, noteLabel, roleOf } from './state'
import type { FileEntry, State } from './types'

const CAP = 8000
const STEPS = 10
// One long note, quote or path must not use up the room of the rest.
const TEXT_CHARS = 400
const WHY_CHARS = 200
const QUOTE_CHARS = 240
const LINE_CHARS = 400
// Turns the ledger has not caught up with: the newest few, each cut short.
const UNRECORDED = 5
const UNRECORDED_CHARS = 300

type Unrecorded = { turn: number; user: string }

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// Cut to `max` characters of one line, counted as code points so a surrogate pair is never split. A code
// fence the cut leaves open is dropped, so it cannot swallow what follows.
const short = (s: string, max: number): string => {
  const chars = Array.from(oneLine(s))
  if (chars.length <= max) return chars.join('')
  const head = chars.slice(0, max - 1).join('')
  const isOpen = (head.match(/```/g)?.length ?? 0) % 2 === 1
  return `${(isOpen ? head.slice(0, head.lastIndexOf('```')) : head).trimEnd()}…`
}

// What goes beside the first prompt after Claude Code compacts the chat: the ledger in short, most
// important first, so whatever the cap cuts is the least needed. Ends with where the full ledger is. Empty
// when there is nothing to hand over. `unrecorded` are the turns still being recorded: the ledger leaves them
// out, so their messages come first.
export const digestText = (
  state: State,
  steps: readonly string[],
  files: readonly FileEntry[],
  dir: string,
  cap = CAP,
  unrecorded: readonly Unrecorded[] = [],
): string => {
  const cwd = state.front.cwd ?? ''
  const active = activeNotes(state)
  const note = (n: (typeof active)[number]) =>
    `- ${noteLabel(n.id)} (t${n.turn}) ${short(n.text, TEXT_CHARS)}${n.why === '' ? '' : ` Why: ${short(n.why, WHY_CHARS)}`}${n.quote === '' ? '' : ` User: "${short(n.quote, QUOTE_CHARS)}"`}`
  const blocks: [string, string[]][] = [
    [
      'Not in the ledger yet (these turns are still being recorded, so the sections below leave them out)',
      unrecorded.slice(-UNRECORDED).map(t => `- t${t.turn}: ${short(t.user, UNRECORDED_CHARS)}`),
    ],
    ['Open asks', active.filter(n => n.kind === 'ask').map(note)],
    ['Decisions and rules', active.filter(n => n.kind !== 'ask').map(note)],
    ['Learnings', state.learnings.filter(l => l.status === 'active').map(l => `- ${learnLabel(l.id)} [${l.kind}] ${short(l.text, TEXT_CHARS)}`)],
    ['Files that matter', files.map(f => short(`- ${shortPath(f.path, cwd)}${roleOf(state, f.path) === '' ? '' : ` · ${roleOf(state, f.path)}`}`, LINE_CHARS))],
    ['Recent steps', steps.slice(-STEPS).map(s => short(s, LINE_CHARS))],
  ]
  if (blocks.every(([, items]) => items.length === 0)) return ''
  const head = `The chat was just compacted. This is the session ledger as it stands, so nothing the user asked or decided is lost.`
  const tail = `Full ledger: ${dir}/state.md (steps.md has every turn).`
  const cut = '(cut to fit; the rest is in state.md)'
  const lines = [head]
  // Room is kept for the tail and the cut notice, so the whole digest stays under the cap.
  let size = head.length + tail.length + cut.length + 3
  let isCut = false
  for (const [title, items] of blocks) {
    const heading = `\n## ${title}`
    let isOpen = false
    for (const item of items) {
      // A heading comes with its first item, never alone.
      const need = (isOpen ? 0 : heading.length + 1) + item.length + 1
      if (size + need > cap) {
        isCut = true
        break
      }
      if (!isOpen) lines.push(heading)
      isOpen = true
      lines.push(item)
      size += need
    }
  }
  if (isCut) lines.push(cut)
  lines.push('', tail)
  return lines.join('\n')
}
