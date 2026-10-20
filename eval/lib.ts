import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { addToolCall, emptyFacts } from '../core/facts'
import type { TurnFacts } from '../core/types'

export type EvalTurn = { n: number; user: string; answer: string; previousAnswer: string; facts?: TurnFacts }
export type EvalSession = { id: string; project: string; turns: EvalTurn[] }

export const DATA = join(import.meta.dir, 'data')
export const readJson = <T>(name: string, fallback: T): T => {
  const path = join(DATA, name)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback
}
export const writeJson = (name: string, value: unknown): void => {
  mkdirSync(DATA, { recursive: true })
  writeFileSync(join(DATA, name), JSON.stringify(value))
}

const PROJECTS = join(homedir(), '.claude', 'projects')

// Which chats to read: project folders whose name starts with EVAL_PROJECT_PREFIX (default: all of them).
// Worktree and scratch folders are left out.
const PREFIX = process.env.EVAL_PROJECT_PREFIX ?? ''
const isWanted = (dir: string): boolean => dir.startsWith(PREFIX) && !/worktrees|scratchpad/.test(dir)

const AUTOMATED = /^(<command-name>|<local-command-|<system-reminder>|Caveat:|\[Request interrupted|This session is being continued|<task-notification>|<bash-)/

const humanText = (d: Record<string, unknown>): string | undefined => {
  if (d.type !== 'user' || d.isMeta === true || d.isSidechain === true || d.isCompactSummary === true) return undefined
  const content = (d.message as { content?: unknown } | undefined)?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content) && content.every(b => (b as { type?: string }).type === 'text')
        ? content.map(b => (b as { text: string }).text).join('\n')
        : undefined
  if (text === undefined || text.trim() === '' || AUTOMATED.test(text.trim())) return undefined
  return text
}

const assistantText = (d: Record<string, unknown>): string | undefined => {
  if (d.type !== 'assistant' || d.isSidechain === true) return undefined
  const content = (d.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter(b => (b as { type?: string }).type === 'text')
    .map(b => (b as { text: string }).text)
    .join('\n')
  return text.trim() === '' ? undefined : text
}

type ToolUse = { id: string; name: string; input: Record<string, unknown> }

const blocks = (d: Record<string, unknown>): Record<string, unknown>[] => {
  const content = (d.message as { content?: unknown } | undefined)?.content
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : []
}

const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(b => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
      : ''

// The main agent's tool calls in a turn, folded the way the mod folds them live.
const addTools = (d: Record<string, unknown>, uses: Map<string, ToolUse>, turn: EvalTurn | undefined): void => {
  if (d.isSidechain === true || turn === undefined) return
  for (const b of blocks(d)) {
    if (d.type === 'assistant' && b.type === 'tool_use') uses.set(String(b.id), { id: String(b.id), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> })
    if (d.type === 'user' && b.type === 'tool_result') {
      const use = uses.get(String(b.tool_use_id))
      if (use !== undefined) turn.facts = addToolCall(turn.facts ?? emptyFacts(), { tool: use.name, input: use.input, isError: b.is_error === true, text: resultText(b.content) })
    }
  }
}

export const readSession = (file: string, project: string): EvalSession => {
  const turns: EvalTurn[] = []
  const uses = new Map<string, ToolUse>()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const user = humanText(d)
    if (user !== undefined) {
      turns.push({ n: turns.length + 1, user, answer: '', previousAnswer: turns.at(-1)?.answer ?? '', facts: emptyFacts() })
      continue
    }
    addTools(d, uses, turns.at(-1))
    const answer = assistantText(d)
    const last = turns.at(-1)
    if (answer !== undefined && last !== undefined) last.answer = answer
  }
  const id = file.slice(file.lastIndexOf('/') + 1).replace(/\.jsonl$/, '')
  return { id, project, turns }
}

export const listSessions = (skip: string[]): EvalSession[] => {
  const out: EvalSession[] = []
  for (const dir of readdirSync(PROJECTS).filter(isWanted)) {
    for (const name of readdirSync(join(PROJECTS, dir)).filter(n => n.endsWith('.jsonl'))) {
      const path = join(PROJECTS, dir, name)
      if (!statSync(path).isFile() || skip.some(s => name.startsWith(s))) continue
      out.push(readSession(path, dir.slice(PREFIX.length)))
    }
  }
  return out
}

// Scores before 0.3 were saved without a view suffix and saw no previous reply.
export const scoreFile = (model: string, view: 'prev' | 'none'): string => {
  const base = `scores-${model.replace(/[^a-z0-9.]+/gi, '_')}`
  return view === 'none' && existsSync(join(DATA, `${base}.json`)) ? `${base}.json` : `${base}-${view}.json`
}

export const clipText = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)} [...]`)

// One headless call on the Claude Code login (the subscription): no tools, no session saved.
export const ask = async (model: string, system: string, prompt: string, effort = 'high'): Promise<string> => {
  const proc = Bun.spawn(
    ['claude', '-p', '--model', model, '--effort', effort, '--output-format', 'json', '--no-session-persistence', '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--system-prompt', system],
    { cwd: '/tmp', stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`claude exited ${code}`)
  const json = JSON.parse(out) as { result?: string; is_error?: boolean }
  if (json.is_error === true || typeof json.result !== 'string') throw new Error(`claude error: ${out.slice(0, 200)}`)
  return json.result
}

export const jsonIn = <T>(text: string): T => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return JSON.parse(text.slice(start, end + 1)) as T
}

export const pool = async <T>(items: T[], size: number, run: (item: T, index: number) => Promise<void>): Promise<void> => {
  let next = 0
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        await run(items[i]!, i)
      }
    }),
  )
}
