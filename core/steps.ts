import type { Step } from './types'

export const STEPS_HEAD =
  '# Steps\nOne line per turn, oldest first: ✓ done, ✗ failed, ◌ stopped. The facts come from the tool calls; ' +
  '+M-/L- is what the turn added to state.md, "done" what it finished.\n'

const MARK: Record<Step['outcome'], string> = { ok: '✓', failed: '✗', aborted: '◌' }

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// - t41 · ✓ · Moved the parser to its own file · edited parse.ts · +M-012 · done M-009
export const stepLine = (s: Step): string =>
  [`- t${s.turn}`, MARK[s.outcome], oneLine(s.text), s.facts, ...s.added.map(l => `+${l}`), ...s.done.map(l => `done ${l}`)]
    .filter(part => part !== '')
    .join(' · ')

const STEP = /^- t(\d+) · /

export const stepLines = (md: string): string[] => md.split('\n').filter(line => STEP.test(line))

export const hasStep = (md: string, turn: number): boolean => stepLines(md).some(line => STEP.exec(line)?.[1] === String(turn))

// steps.md is append-only: the new line goes under the last one. A turn run again (a retry after Haiku failed)
// replaces its own line where it stands.
export const appendStep = (md: string, step: Step): string => {
  if (hasStep(md, step.turn)) return md.split('\n').map(line => (STEP.exec(line)?.[1] === String(step.turn) ? stepLine(step) : line)).join('\n')
  const base = md === '' ? STEPS_HEAD : md.endsWith('\n') ? md : `${md}\n`
  return `${base}${stepLine(step)}\n`
}
