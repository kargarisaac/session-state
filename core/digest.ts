import { shortPath } from './facts'
import { activeNotes } from './notes'
import { learnLabel, noteLabel, roleOf } from './state'
import type { FileEntry, State } from './types'

const CAP = 8000
const STEPS = 10

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// What goes beside the first prompt after Claude Code compacts the chat: the ledger in short, most
// important first, so whatever the cap cuts is the least needed. Ends with where the full ledger is.
export const digestText = (state: State, steps: readonly string[], files: readonly FileEntry[], dir: string, cap = CAP): string => {
  const cwd = state.front.cwd ?? ''
  const active = activeNotes(state)
  const note = (n: (typeof active)[number]) =>
    `- ${noteLabel(n.id)} (t${n.turn}) ${oneLine(n.text)}${n.why === '' ? '' : ` Why: ${oneLine(n.why)}`}${n.quote === '' ? '' : ` User: "${oneLine(n.quote)}"`}`
  const blocks: [string, string[]][] = [
    ['Open asks', active.filter(n => n.kind === 'ask').map(note)],
    ['Decisions and rules', active.filter(n => n.kind !== 'ask').map(note)],
    ['Learnings', state.learnings.filter(l => l.status === 'active').map(l => `- ${learnLabel(l.id)} [${l.kind}] ${oneLine(l.text)}`)],
    ['Files that matter', files.map(f => `- ${shortPath(f.path, cwd)}${roleOf(state, f.path) === '' ? '' : ` · ${roleOf(state, f.path)}`}`)],
    ['Recent steps', steps.slice(-STEPS)],
  ]
  const head = `The chat was just compacted. This is the session ledger as it stands, so nothing the user asked or decided is lost.`
  const tail = `Full ledger: ${dir}/state.md (steps.md has every turn).`
  const cut = '(cut to fit; the rest is in state.md)'
  const lines = [head]
  // Room is kept for the tail and the cut notice, so the whole digest stays under the cap.
  let size = head.length + tail.length + cut.length + 3
  let isCut = false
  for (const [title, items] of blocks) {
    if (items.length === 0) continue
    const heading = `\n## ${title}`
    if (size + heading.length + 1 > cap) {
      isCut = true
      break
    }
    lines.push(heading)
    size += heading.length + 1
    for (const item of items) {
      if (size + item.length + 1 > cap) {
        isCut = true
        break
      }
      lines.push(item)
      size += item.length + 1
    }
  }
  if (isCut) lines.push(cut)
  lines.push('', tail)
  return lines.join('\n')
}
