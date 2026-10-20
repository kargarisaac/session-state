// Reads a Claude Code transcript (<id>.jsonl) back into turns, the way the mod records them live:
// the person's typed message, the main agent's last reply, and what its tools did.
import { addToolCall, emptyFacts } from './facts'
import type { Turn } from './types'

type Line = Record<string, unknown>
type ToolUse = { name: string; input: Record<string, unknown> }

// Messages Claude Code or a plugin wrote into the user's slot.
const AUTOMATED = /^(<command-name>|<local-command-|<system-reminder>|Caveat:|\[Request interrupted|This session is being continued|<task-notification>|<bash-)/

const blocks = (d: Line): Line[] => {
  const content = (d.message as { content?: unknown } | undefined)?.content
  return Array.isArray(content) ? (content as Line[]) : []
}

// A message the person typed: text, maybe with pasted images; never a tool result.
const humanText = (d: Line): string | undefined => {
  if (d.type !== 'user' || d.isMeta === true || d.isSidechain === true || d.isCompactSummary === true) return undefined
  const content = (d.message as { content?: unknown } | undefined)?.content
  const parts = blocks(d)
  const text =
    typeof content === 'string'
      ? content
      : parts.length > 0 && parts.every(b => b.type === 'text' || b.type === 'image')
        ? parts.flatMap(b => (b.type === 'text' ? [String(b.text)] : [])).join('\n')
        : undefined
  if (text === undefined || text.trim() === '' || AUTOMATED.test(text.trim())) return undefined
  return text
}

const assistantText = (d: Line): string | undefined => {
  if (d.type !== 'assistant' || d.isSidechain === true) return undefined
  const text = blocks(d)
    .filter(b => b.type === 'text')
    .map(b => String(b.text))
    .join('\n')
  return text.trim() === '' ? undefined : text
}

const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(b => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
      : ''

// What the person picked in the agent's multiple-choice questions: their words too.
export const answersOf = (result: unknown): string => {
  const record = (result as { answers?: unknown } | null)?.answers
  const pairs: [string, string][] =
    record !== null && typeof record === 'object'
      ? Object.entries(record as Record<string, unknown>).map(([q, a]) => [q, String(a)])
      : typeof result === 'string'
        ? [...result.matchAll(/"([^"\n]+)"="([^"]*)"/g)].map(m => [m[1]!, m[2]!])
        : []
  return pairs.length === 0 ? '' : `[Answers to the agent's questions]\n${pairs.map(([q, a]) => `- ${q} → ${a}`).join('\n')}`
}

export const withAnswers = (user: string, answers: string): string => (answers === '' ? user : `${user}\n\n${answers}`)

export const parseTranscript = (text: string): Turn[] => {
  const turns: Turn[] = []
  const uses = new Map<string, ToolUse>()
  // A tool result can be written twice; each call counts once.
  const done = new Set<string>()
  for (const raw of text.split('\n')) {
    if (raw === '') continue
    let d: Line
    try {
      d = JSON.parse(raw) as Line
    } catch {
      continue
    }
    const user = humanText(d)
    if (user !== undefined) {
      turns.push({ turn: turns.length + 1, turnId: String(d.uuid ?? ''), user, answer: '', previousAnswer: turns.at(-1)?.answer ?? '', isAborted: false, facts: emptyFacts() })
      continue
    }
    const last = turns.at(-1)
    if (last === undefined || d.isSidechain === true) continue
    // A message typed while the agent was working joins the turn it was typed in.
    const queued = d.type === 'attachment' ? (d.attachment as { type?: string; prompt?: unknown } | undefined) : undefined
    if (queued?.type === 'queued_command' && typeof queued.prompt === 'string' && !AUTOMATED.test(queued.prompt.trim())) {
      last.user = `${last.user}\n\n${queued.prompt}`
      continue
    }
    for (const b of blocks(d)) {
      if (d.type === 'assistant' && b.type === 'tool_use') uses.set(String(b.id), { name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> })
      if (d.type !== 'user' || b.type !== 'tool_result') continue
      const use = uses.get(String(b.tool_use_id))
      if (use === undefined || done.has(String(b.tool_use_id))) continue
      done.add(String(b.tool_use_id))
      const isError = b.is_error === true
      if (use.name === 'AskUserQuestion' && !isError) last.user = withAnswers(last.user, answersOf(d.toolUseResult ?? resultText(b.content)))
      last.facts = addToolCall(last.facts, { tool: use.name, input: use.input, isError, text: resultText(b.content) })
    }
    const answer = assistantText(d)
    if (answer !== undefined) last.answer = answer
  }
  return turns
}
