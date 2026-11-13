// Step 5: does the ledger keep what matters? Replays real chats through the pipeline, then asks questions
// about each chat that a long-running agent must still answer after compaction, and grades the answers.
//   [OPENROUTER_API_KEY=...] bun eval/probe.ts <transcript.jsonl>...   → eval/PROBES.md (no key: the gate is off)
//
// Four probe types, after Factory's compression evaluation: recall (what the user asked or said), files (which
// file holds what), decision (what was chosen and why), continuation (what is still open at the end).
// Three conditions answer each probe:
//   summary  a compaction-style summary of the whole chat, written by Sonnet (a stand-in for /compact)
//   ledger   state.md and steps.md as the mod wrote them during the replay
//   both     summary and ledger: what the agent has after a compaction with the mod on
// Haiku, Sonnet and Jev run on the Claude Code login and OpenRouter; nothing is written outside eval/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { digestText } from '../core/digest'
import { fileIndex, rankFiles } from '../core/files'
import { factsText } from '../core/facts'
import { archivedTurns, turnRecord } from '../core/ledger'
import { newFront, pointerText, systemTexts } from '../core/notes'
import { processTurn } from '../core/pipeline'
import { emptyState, HISTORY_HEAD, historyBlock, renderState } from '../core/state'
import { appendStep, stepLines } from '../core/steps'
import { DEFAULTS } from '../core/types'
import type { Config, Host, LedgerEvent, State } from '../core/types'
import { ask, clipText, DATA, jsonIn, pool, readSession } from './lib'
import type { EvalSession } from './lib'

const KEY = process.env.OPENROUTER_API_KEY ?? ''
const FILES = process.argv.slice(2)
if (FILES.length === 0) throw new Error('usage: [PROBE_TURNS=200] [PROBE_REPORT=PROBES.md] bun eval/probe.ts <transcript.jsonl>...')
// A long chat is cut to its first turns: the probe writer and the summary read the whole chat in one call.
const MAX_TURNS = Number(process.env.PROBE_TURNS ?? '') || Infinity
const REPORT = process.env.PROBE_REPORT ?? 'PROBES.md'
// The chat as the probe writer reads it is kept under this many characters; long chats get shorter turns.
const CHAT_CHARS = 600_000

const TAIL = 5
const PROBES_PER_TYPE = 3
const TYPES = ['recall', 'files', 'decision', 'continuation'] as const
type ProbeType = (typeof TYPES)[number]
type Probe = { type: ProbeType; question: string; answer: string; turn: number }
const CONDITIONS = ['summary', 'ledger', 'both', 'after'] as const
type Condition = (typeof CONDITIONS)[number]

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
// With no key the gate is off and Haiku extracts every turn, so runs without a key compare only with each other.
const config: Config = { ...DEFAULTS, jevKey: KEY, gate: KEY === '' ? 'off' : 'jev' }

const host: Host = {
  now: async () => Date.now(),
  random: () => 1,
  complete: async ({ system, prompt, effort }) => {
    try {
      return { isOk: true, text: await ask('haiku', system, prompt, effort ?? config.effort), usage: ZERO }
    } catch (err) {
      return { isOk: false, reason: String(err).slice(0, 200), usage: ZERO }
    }
  },
  post: async (url, headers, body) => {
    const res = await fetch(url, { method: 'POST', headers, body })
    return { status: res.status, text: await res.text() }
  },
}

// The chat as text: every user message, the agent's reply and what its tools did.
const transcriptText = (s: EvalSession, cwd: string): string => {
  const per = Math.floor(CHAT_CHARS / Math.max(1, s.turns.length))
  const user = Math.min(4000, Math.floor(per * 0.6))
  const answer = Math.min(3000, Math.floor(per * 0.35))
  return s.turns
    .map(t => `## t${t.n}\nUSER: ${clipText(t.user, user)}\nAGENT: ${clipText(t.answer, answer)}${t.facts === undefined ? '' : `\nTOOLS: ${factsText(t.facts, cwd) || 'none'}`}`)
    .join('\n\n')
}

const replay = async (s: EvalSession, cwd: string, out: string) => {
  const tag = s.id.slice(0, 8)
  let state: State = emptyState(newFront({ sessionId: s.id, project: s.project, cwd, started: '', transcript: '' }))
  let steps = ''
  let history = ''
  let events: LedgerEvent[] = []
  for (const t of s.turns) {
    const turn = { turn: t.n, turnId: `${s.id}:${t.n}`, user: t.user, answer: t.answer, previousAnswer: t.previousAnswer, isAborted: false, facts: t.facts! }
    events = [...events, turnRecord(turn, Date.now())]
    const files = rankFiles(fileIndex(archivedTurns(events)), state, t.n)
    const outcome = await processTurn(host, config, { state, steps: stepLines(steps), archive: archivedTurns(events), files, events }, turn)
    events = [...events, ...outcome.events]
    state = outcome.state
    steps = appendStep(steps, outcome.step)
    if (outcome.moved.length > 0) history = `${history === '' ? HISTORY_HEAD : history}\n${outcome.moved.map(historyBlock).join('\n\n')}\n`
    const gate = outcome.events[0]
    const extract = outcome.events[1]
    console.log(`  ${tag} t${t.n} ${gate?.type === 'gate' ? `p=${gate.p} ${gate.action}` : ''} ${extract?.type === 'extract' ? `${extract.mode} +${extract.kept} notes +${extract.learned} learned${extract.error === undefined ? '' : ` ERROR ${extract.error}`}` : ''}`)
  }
  const md = renderState(state, rankFiles(fileIndex(archivedTurns(events)), state, s.turns.length))
  writeFileSync(join(out, 'state.md'), md)
  writeFileSync(join(out, 'steps.md'), steps)
  writeFileSync(join(out, 'history.md'), history)
  writeFileSync(join(out, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
  // What the mod hands the agent after a compaction: its system-prompt sections and the digest on the next prompt.
  const dir = `~/.claude/session-state/${s.project}/${s.id.slice(0, 8)}`
  const files = rankFiles(fileIndex(archivedTurns(events)), state, s.turns.length)
  const injected = [pointerText(dir), ...systemTexts(state), digestText(state, stepLines(steps), files, dir, undefined, [], events)].filter(x => x !== '').join('\n\n')
  writeFileSync(join(out, 'injected.md'), injected)
  return { md, steps, events, injected }
}

const PROBE_SYSTEM = [
  'You write test questions about a long chat between a user and a coding agent. They check whether the agent, after its history was compacted, still knows what matters.',
  `Write ${PROBES_PER_TYPE} questions of each type:`,
  '- recall: what the user asked for, stated or required (e.g. "What did the user say about X?").',
  '- files: which file holds something, or which files were changed for something.',
  '- decision: what was chosen between options, and why.',
  '- continuation: what was still open, unfinished or next at the end of the chat.',
  `Each answer must be stated plainly in the chat. Prefer things from early and middle turns: do not use the last ${TAIL} turns except for continuation. Each answer is one or two sentences with the specific names.`,
  'Reply with JSON only: {"probes": [{"type": "recall", "question": "...", "answer": "...", "turn": 12}]}',
].join('\n')

const SUMMARY_SYSTEM =
  'Summarize this chat so a coding agent can continue it without the history: what the user asked for and decided, constraints, files changed and why, what failed, and what is still open. Be specific. At most 1,500 words.'

const ANSWER_SYSTEM =
  'You are the coding agent in a long chat whose history was compacted. Answer the question from the material below only, in one or two sentences with specific names. If the material does not say, answer "Not in my notes."'

const GRADE_SYSTEM =
  'Grade an answer against a reference answer. 5: correct and specific. 3: partly correct or missing a key detail. 1: vague or only related. 0: wrong, or says it does not know. Reply with JSON only: {"score": 0, "why": "<=15 words"}'

const material = (c: Condition, summary: string, md: string, steps: string, injected: string): string =>
  ({
    summary: `# Compaction summary\n${summary}`,
    ledger: `# state.md\n${md}\n\n# steps.md\n${steps}`,
    both: `# Compaction summary\n${summary}\n\n# state.md\n${md}\n\n# steps.md\n${steps}`,
    after: `# Compaction summary\n${summary}\n\n# What the session ledger mod added\n${injected}`,
  })[c]

type Row = { session: string; type: ProbeType; condition: Condition; score: number; question: string; why: string }

const rows: Row[] = []
const sizes: { session: string; turns: number; summary: number; ledger: number; notes: number }[] = []

await pool(FILES, FILES.length, async file => {
  const id = file.slice(file.lastIndexOf('/') + 1, file.lastIndexOf('/') + 9)
  const full = readSession(file, id)
  const session = { ...full, turns: full.turns.filter(t => t.n <= MAX_TURNS) }
  const cwd = cwdOf(file)
  const out = join(DATA, 'probe', id)
  mkdirSync(out, { recursive: true })
  console.log(`${id}: ${session.turns.length} turns, replaying`)
  const { md, steps, injected } = await replay(session, cwd, out)

  const chat = transcriptText(session, cwd)
  // The probes and the summary of a chat are written once and reused, so runs on different code answer the same questions.
  const isSaved = existsSync(join(out, 'probes.json')) && existsSync(join(out, 'summary.md'))
  const [probeText, summary] = isSaved
    ? [readFileSync(join(out, 'probes.json'), 'utf8'), readFileSync(join(out, 'summary.md'), 'utf8')]
    : await Promise.all([ask('sonnet', PROBE_SYSTEM, chat), ask('sonnet', SUMMARY_SYSTEM, chat)])
  const parsed = jsonIn<{ probes: Probe[] } | Probe[]>(isSaved ? `{"probes": ${probeText}}` : probeText)
  const probes = (Array.isArray(parsed) ? parsed : parsed.probes).filter(p => (TYPES as readonly string[]).includes(p.type))
  writeFileSync(join(out, 'probes.json'), JSON.stringify(probes, null, 2))
  writeFileSync(join(out, 'summary.md'), summary)
  sizes.push({ session: id, turns: session.turns.length, summary: summary.length, ledger: md.length + steps.length, notes: (md.match(/^### [ML]-/gm) ?? []).length })
  console.log(`  ${probes.length} probes; answering under ${CONDITIONS.length} conditions`)

  const jobs = probes.flatMap(p => CONDITIONS.map(c => ({ p, c })))
  await pool(jobs, 4, async ({ p, c }) => {
    try {
      const answer = await ask('sonnet', ANSWER_SYSTEM, `${material(c, summary, md, steps, injected)}\n\n# Question\n${p.question}`, 'low')
      const grade = jsonIn<{ score: number; why: string }>(
        await ask('sonnet', GRADE_SYSTEM, `Question: ${p.question}\nReference: ${p.answer}\nAnswer: ${answer}`, 'low'),
      )
      rows.push({ session: id, type: p.type, condition: c, score: Number(grade.score) || 0, question: p.question, why: grade.why })
    } catch (err) {
      console.error(`  ${c} ${p.question.slice(0, 40)}: ${String(err).slice(0, 120)}`)
    }
  })
})

// The folder the chat ran in, from the transcript, so paths show as the agent saw them.
function cwdOf(file: string): string {
  for (const line of readFileSync(file, 'utf8').split('\n', 200)) {
    const m = /"cwd":"([^"]+)"/.exec(line)
    if (m !== null) return m[1]!
  }
  return ''
}

const mean = (xs: number[]) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length)
const cell = (f: (r: Row) => boolean) => {
  const xs = rows.filter(f).map(r => r.score)
  return xs.length === 0 ? '–' : `${mean(xs).toFixed(2)} (${xs.length})`
}
const lines = [
  '# Probe test',
  '',
  'Questions a long-running agent must still answer after compaction, graded 0 to 5 against the chat. Mean score (probes).',
  '',
  `| Type | ${CONDITIONS.join(' | ')} |`,
  `| --- | ${CONDITIONS.map(() => '---').join(' | ')} |`,
  ...TYPES.map(t => `| ${t} | ${CONDITIONS.map(c => cell(r => r.type === t && r.condition === c)).join(' | ')} |`),
  `| **all** | ${CONDITIONS.map(c => `**${cell(r => r.condition === c)}**`).join(' | ')} |`,
  '',
  '| Session | Turns | Summary chars | Ledger chars | Notes and learnings |',
  '| --- | --- | --- | --- | --- |',
  ...sizes.map(s => `| ${s.session} | ${s.turns} | ${s.summary} | ${s.ledger} | ${s.notes} |`),
  '',
  'summary: a Sonnet summary of the whole chat, a stand-in for /compact. ledger: state.md and steps.md from the replay.',
  'both: the summary plus state.md and steps.md whole. after: the summary plus exactly what the mod injects (its',
  'system-prompt sections and the digest), which is what the agent has after a compaction if it reads no file.',
  `Gate: ${config.gate}. Long chats are cut to their first ${MAX_TURNS === Infinity ? 'all' : MAX_TURNS} turns. The probes, references and grader are Sonnet; the`,
  'probe writer saw the full chat. Small sample: read the per-probe rows before trusting a difference.',
  '',
  'The per-probe questions quote the chats, so they stay in the git-ignored `eval/data/probe/PROBES-detail.md`.',
]
// Questions quote the chats (names, people, plans): they stay out of the tracked report.
const detail = [
  '# Per probe',
  '',
  `| Session | Type | Question | ${CONDITIONS.join(' | ')} |`,
  `| --- | --- | --- | ${CONDITIONS.map(() => '---').join(' | ')} |`,
  ...[...new Set(rows.map(r => `${r.session}\u0000${r.question}`))].map(k => {
    const [session, question] = k.split('\u0000')
    const of = (c: Condition) => rows.find(r => r.session === session && r.question === question && r.condition === c)
    const type = rows.find(r => r.question === question)?.type
    return `| ${session} | ${type} | ${question!.replace(/\|/g, '/')} | ${CONDITIONS.map(c => of(c)?.score ?? '–').join(' | ')} |`
  }),
]
writeFileSync(join(import.meta.dir, REPORT), lines.join('\n') + '\n')
writeFileSync(join(DATA, 'probe', REPORT.replace(/\.md$/, '-detail.md')), detail.join('\n') + '\n')
console.log(lines.slice(0, 12).join('\n'))
