// What the panel draws, as plain data: the pane code only lays it out.

export type StepView = {
  turn: number
  mark: '✓' | '✗' | '◌'
  text: string
  facts: string[]
  added: string[]
  done: string[]
}

// The tool-call facts steps.md puts after a step's own text: "edited a.ts", "read 3 files", "5 commands, 1 failed", "commit …".
const FACT = /^(edited |read \d|\d+ commands?\b|commit )/

// "- t41 · ✓ · Moved the parser · edited parse.ts · read 3 files · +M-012 · done M-009"
export const parseStep = (line: string): StepView | undefined => {
  const parts = line.slice(2).split(' · ')
  const turn = /^t(\d+)$/.exec(parts[0] ?? '')
  const mark = parts[1]
  if (turn === null || (mark !== '✓' && mark !== '✗' && mark !== '◌')) return undefined
  const rest = parts.slice(2)
  const added: string[] = []
  const done: string[] = []
  const facts: string[] = []
  // The tail is read from the end, so a text that holds " · " itself stays whole.
  for (let part = rest[rest.length - 1]; part !== undefined; part = rest[rest.length - 1]) {
    if (/^\+[ML]-\d+$/.test(part)) added.unshift(part.slice(1))
    else if (/^done [ML]-\d+$/.test(part)) done.unshift(part.slice(5))
    else if (FACT.test(part)) facts.unshift(part)
    else break
    rest.pop()
  }
  return { turn: Number(turn[1]), mark, text: rest.join(' · '), facts, added, done }
}

export const RULE = '─'

// A line as wide as the body, but never so wide that a docked pane wraps it.
export const rule = (columns: number): string => RULE.repeat(Math.max(8, Math.min(columns - 2, 100)))

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

// A gate decision's colour: what it did to the turn.
export const gateTone = (action: string): 'success' | 'warning' | 'error' | 'inactive' =>
  action === 'extract' ? 'success' : action === 'audit' ? 'warning' : action === 'error' ? 'error' : 'inactive'
