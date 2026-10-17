// Step 2: label every turn of each long chat, no human in the loop.
// Two independent Haiku passes with different framings; a stronger model settles only the turns they disagree on.
// The labellers read the whole chat, so they can use what the gate never sees: what came after.
//   bun eval/label.ts
import { GATE_INSTRUCTIONS } from '../core/gate'
import { ask, clipText, jsonIn, pool, readJson, writeJson } from './lib'
import type { EvalSession } from './lib'

const LABELLER = 'claude-haiku-5-5'
const JUDGE = 'claude-sonnet-5-5'

type Mark = { turn: number; kind?: string; note?: string }
type Raw = Record<string, Mark[]> // session id -> turns the labeller called important

const BAR = `A turn is IMPORTANT when the USER's message in it says something that will still matter about 50 turns later in the same chat: a decision, a constraint or requirement, a preference, a correction or reversal, a scope limit, an always/never/from-now-on rule, or a standing request the agent could drop. It is NOT important when the user gives a one-off command ("run the tests"), asks a question, gives information for the current step only, or just acknowledges. The agent's text is only context. (The gate being calibrated asks: ${GATE_INSTRUCTIONS})`

const FORMAT =
  'Reply with JSON only: {"important": [{"turn": <number>, "kind": "decision|preference|requirement|correction|ask", "note": "<=15 words"}]}. List only important turns. Use {"important": []} if none.'

const SYSTEM_A = `You label turns of a long coding-agent chat. ${BAR} Read the chat from the start and decide, turn by turn, whether the user's message is important. ${FORMAT}`

const SYSTEM_B = `You label turns of a long coding-agent chat. ${BAR} Work backwards: for each turn, look at the turns after it. A turn is important if later turns rely on it, repeat it, or reverse it, or if the agent would have gone wrong without it. A turn that states an explicit lasting rule (always, never, from now on) is important even if the chat never tests it. A turn that only drives the next step is not. ${FORMAT}`

const chat = (s: EvalSession): string =>
  s.turns.map(t => `[t${t.n}] USER: ${clipText(t.user.replace(/\s+/g, ' '), 700)}\n      AGENT: ${clipText(t.answer.replace(/\s+/g, ' '), 250)}`).join('\n')

const label = async (system: string, s: EvalSession): Promise<Mark[]> => {
  const prompt = `Chat, oldest first, ${s.turns.length} turns:\n\n${chat(s)}\n\nLabel it.`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = jsonIn<{ important?: Mark[] }>(await ask(LABELLER, system, prompt))
      return (out.important ?? []).filter(m => Number.isInteger(m.turn) && m.turn >= 1 && m.turn <= s.turns.length)
    } catch (err) {
      console.error(`  ${s.id.slice(0, 8)} attempt ${attempt + 1}: ${String(err).slice(0, 100)}`)
    }
  }
  return []
}

// One object for both passes: they run side by side and each write must keep the other's marks.
const raw = readJson<Record<string, Raw>>('labels-raw.json', {})

const pass = async (name: 'A' | 'B', system: string, sessions: EvalSession[]): Promise<Raw> => {
  const mine = raw[name] ?? {}
  const todo = sessions.filter(s => mine[s.id] === undefined)
  console.log(`pass ${name}: ${todo.length} of ${sessions.length} sessions to label`)
  await pool(todo, 3, async s => {
    mine[s.id] = await label(system, s)
    raw[name] = mine
    writeJson('labels-raw.json', raw)
    console.log(`  ${name} ${s.id.slice(0, 8)} ${s.project}: ${mine[s.id]!.length} important of ${s.turns.length}`)
  })
  return mine
}

const sessions = readJson<EvalSession[]>('sessions.json', [])
const [a, b] = await Promise.all([pass('A', SYSTEM_A, sessions), pass('B', SYSTEM_B, sessions)])

type Final = Record<string, Record<number, { important: boolean; kind?: string; source: 'agree' | 'adjudicated' }>>
const final: Final = readJson<Final>('labels.json', {})
const judged = new Set(Object.keys(final))

await pool(sessions.filter(s => !judged.has(s.id)), 3, async s => {
  const inA = new Map((a[s.id] ?? []).map(m => [m.turn, m]))
  const inB = new Map((b[s.id] ?? []).map(m => [m.turn, m]))
  const out: Final[string] = {}
  const disputed: number[] = []
  for (const t of s.turns) {
    const x = inA.get(t.n)
    const y = inB.get(t.n)
    if ((x !== undefined) === (y !== undefined)) out[t.n] = { important: x !== undefined, kind: (x ?? y)?.kind, source: 'agree' }
    else disputed.push(t.n)
  }
  if (disputed.length > 0) {
    const lines = disputed.map(n => `t${n}: labeller A ${inA.has(n) ? 'said IMPORTANT' : 'said not important'}; labeller B ${inB.has(n) ? 'said IMPORTANT' : 'said not important'}`).join('\n')
    const system = `You settle disagreements between two labellers of a long coding-agent chat. ${BAR} Reply with JSON only: {"important": [<turn numbers among the disputed ones that ARE important>]}.`
    const prompt = `Chat, oldest first:\n\n${chat(s)}\n\nDisputed turns:\n${lines}\n\nDecide each disputed turn.`
    let verdict: number[] = []
    for (let attempt = 0; attempt < 2 && verdict.length === 0; attempt++) {
      try {
        verdict = jsonIn<{ important?: number[] }>(await ask(JUDGE, system, prompt)).important ?? []
        break
      } catch (err) {
        console.error(`  judge ${s.id.slice(0, 8)}: ${String(err).slice(0, 100)}`)
      }
    }
    for (const n of disputed) out[n] = { important: verdict.includes(n), kind: (inA.get(n) ?? inB.get(n))?.kind, source: 'adjudicated' }
  }
  final[s.id] = out
  writeJson('labels.json', final)
  console.log(`  settled ${s.id.slice(0, 8)}: ${disputed.length} disputed of ${s.turns.length}`)
})

const all = Object.values(final).flatMap(m => Object.values(m))
const agree = all.filter(l => l.source === 'agree')
console.log(`labels: ${all.length} turns, ${all.filter(l => l.important).length} important; ${agree.length} agreed, ${all.length - agree.length} adjudicated`)
