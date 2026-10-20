import { factsText, shortPath } from './facts'
import { activeNotes } from './notes'
import { tidy } from './redact'
import { learnLabel, noteLabel, roleOf } from './state'
import type { FileEntry, State, Turn, TurnRecord } from './types'

const STEPS = 15
const EARLIER = 10
const EARLIER_CHARS = 1500
const PREVIOUS_CHARS = 6000
const USER_CHARS = 10000
const ANSWER_CHARS = 6000
const LOOKED_CHARS = 6000

// What Haiku reads for one turn. `earlier` are the archived turns before this one; `looked` is an older
// turn it asked for.
export type TurnContext = {
  state: State
  steps: readonly string[]
  earlier: readonly TurnRecord[]
  files: readonly FileEntry[]
  turn: Turn
  looked?: TurnRecord
}

// Edited this turn and not yet given a role: the files Haiku is asked to describe.
export const unnamedFiles = (c: Pick<TurnContext, 'state' | 'turn'>): string[] =>
  c.turn.facts.edited.filter(p => roleOf(c.state, p) === '')

const list = (lines: string[]): string => (lines.length === 0 ? '(none)' : lines.join('\n'))

export const contextText = (c: TurnContext): string => {
  const cwd = c.state.front.cwd ?? ''
  const notes = activeNotes(c.state).map(n => `${noteLabel(n.id)} [${n.kind}] ${n.text}${n.why === '' ? '' : ` (why: ${n.why})`}`)
  const learnings = c.state.learnings.filter(l => l.status === 'active').map(l => `${learnLabel(l.id)} [${l.kind}] ${l.text}`)
  const files = c.files.map(f => `${shortPath(f.path, cwd)}${roleOf(c.state, f.path) === '' ? '' : ` · ${roleOf(c.state, f.path)}`}`)
  const earlier = c.earlier.slice(-EARLIER).map(r => `t${r.turn}: ${tidy(r.user, EARLIER_CHARS)}`)
  const f = c.turn.facts
  const failures = f.failures.map(x => `failed: ${x.command}\n${x.error}`)
  const unnamed = unnamedFiles(c).map(p => shortPath(p, cwd))
  return [
    `Current title: ${c.state.front.title === undefined || c.state.front.title === '' ? '(none)' : c.state.front.title}`,
    '',
    'Active notes (the ledger), oldest first:',
    list(notes),
    '',
    'Active learnings:',
    list(learnings),
    '',
    'Files that matter:',
    list(files),
    '',
    `Last ${STEPS} steps:`,
    list(c.steps.slice(-STEPS)),
    '',
    "The user's earlier messages, oldest first:",
    list(earlier),
    '',
    ...(c.looked === undefined
      ? []
      : [`Turn t${c.looked.turn}, which you asked for:`, `User: ${tidy(c.looked.user, LOOKED_CHARS)}`, `Agent: ${tidy(c.looked.answer, LOOKED_CHARS)}`, '']),
    'Previous agent reply:',
    c.turn.previousAnswer === '' ? '(none)' : tidy(c.turn.previousAnswer, PREVIOUS_CHARS),
    '',
    `THIS TURN, t${c.turn.turn}. The user's message:`,
    tidy(c.turn.user, USER_CHARS),
    '',
    "The agent's reply:",
    c.turn.answer === '' ? '(none)' : tidy(c.turn.answer, ANSWER_CHARS),
    '',
    `What the tools did: ${factsText(f, cwd) || 'nothing'}`,
    ...(f.edited.length === 0 ? [] : [`Edited: ${f.edited.map(p => shortPath(p, cwd)).join(', ')}`]),
    ...failures,
    ...(unnamed.length === 0 ? [] : [`Edited files with no role yet: ${unnamed.join(', ')}`]),
  ].join('\n')
}
