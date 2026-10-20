import { redact, tidy } from './redact'
import type { TurnFacts } from './types'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMAND_CHARS = 200
const ERROR_CHARS = 300
const MAX_FAILURES = 5

export type ToolCall = { tool: string; input: Record<string, unknown>; isError: boolean; text: string }

export const emptyFacts = (): TurnFacts => ({ read: [], edited: [], commands: 0, failures: [], commits: [] })

const add = (list: string[], item: string): string[] => (item === '' || list.includes(item) ? list : [...list, item])

const pathOf = (input: Record<string, unknown>): string => {
  const p = input.file_path ?? input.notebook_path
  return typeof p === 'string' ? p : ''
}

// `[main 3fa2c1b] Fix the parser` in git's output, or the -m message in the command.
const commitOf = (command: string, text: string): string => {
  const out = /\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.+)/.exec(text)
  if (out !== null) return `${out[1]!.slice(0, 7)} ${out[2]!.trim()}`.slice(0, 120)
  const msg = /-m\s+(?:"([^"]+)"|'([^']+)')/.exec(command)
  return (msg?.[1] ?? msg?.[2] ?? 'commit').split('\n')[0]!.slice(0, 120)
}

// Folds one finished tool call into the turn's facts. Pure.
export const addToolCall = (f: TurnFacts, call: ToolCall): TurnFacts => {
  if (call.tool === 'Read') return { ...f, read: add(f.read, pathOf(call.input)) }
  if (EDIT_TOOLS.has(call.tool)) return call.isError ? f : { ...f, edited: add(f.edited, pathOf(call.input)) }
  if (call.tool !== 'Bash') return f
  const command = typeof call.input.command === 'string' ? call.input.command : ''
  const next = { ...f, commands: f.commands + 1 }
  if (call.isError) {
    const error = redact(call.text).trim().slice(-ERROR_CHARS)
    const failures = [...f.failures, { command: tidy(command, COMMAND_CHARS), error }].slice(-MAX_FAILURES)
    return { ...next, failures }
  }
  if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(command)) return { ...next, commits: [...f.commits, redact(commitOf(command, call.text))] }
  return next
}

const short = (path: string, cwd: string): string => (cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

const names = (paths: string[], cwd: string, max: number): string => {
  const shown = paths.slice(0, max).map(p => short(p, cwd))
  return paths.length > max ? `${shown.join(', ')} +${paths.length - max}` : shown.join(', ')
}

// One line such as "edited a.ts, b.ts · read 3 files · 5 commands, 1 failed · commit 3fa2c1b Fix the parser".
export const factsText = (f: TurnFacts, cwd = ''): string => {
  const parts: string[] = []
  if (f.edited.length > 0) parts.push(`edited ${names(f.edited, cwd, 3)}`)
  if (f.read.length > 0) parts.push(`read ${f.read.length} file${f.read.length === 1 ? '' : 's'}`)
  if (f.commands > 0) parts.push(`${f.commands} command${f.commands === 1 ? '' : 's'}${f.failures.length > 0 ? `, ${f.failures.length} failed` : ''}`)
  for (const c of f.commits) parts.push(`commit ${c}`)
  return parts.join(' · ')
}

export const shortPath = short
