import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseTranscript } from '../core/transcript'
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

export const readSession = (file: string, project: string): EvalSession => {
  const turns = parseTranscript(readFileSync(file, 'utf8')).map(t => ({ n: t.turn, user: t.user, answer: t.answer, previousAnswer: t.previousAnswer, facts: t.facts }))
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
