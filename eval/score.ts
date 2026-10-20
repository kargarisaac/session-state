// Step 3: ask Jev the gate question about every labelled turn, exactly as the mod does (same redaction, same caps).
//   OPENROUTER_API_KEY=... bun eval/score.ts [jev-model=jev-1.14] [view=prev|none]
// view "prev" shows Jev the end of the previous reply, as the mod does since 0.3; "none" is the gate before 0.3.
import { gateBody, parseGate } from '../core/gate'
import { emptyFacts } from '../core/facts'
import { pool, readJson, scoreFile, writeJson } from './lib'
import type { EvalSession } from './lib'

const MODEL = process.argv[2] ?? 'jev-1.14'
const VIEW = process.argv[3] === 'none' ? 'none' : 'prev'
const KEY = process.env.OPENROUTER_API_KEY
if (KEY === undefined || KEY === '') throw new Error('OPENROUTER_API_KEY is not set')

const sessions = readJson<EvalSession[]>('sessions.json', [])
const labels = readJson<Record<string, unknown>>('labels.json', {})
const file = scoreFile(MODEL, VIEW)
const scores = readJson<Record<string, number>>(file, {})

const jobs = sessions
  .filter(s => labels[s.id] !== undefined)
  .flatMap(s => s.turns.map(t => ({ key: `${s.id}:${t.n}`, turn: { turn: t.n, turnId: `${s.id}:${t.n}`, user: t.user, answer: t.answer, previousAnswer: VIEW === 'prev' ? t.previousAnswer : '', isAborted: false, facts: emptyFacts() } })))
  .filter(j => scores[j.key] === undefined)
console.log(`${jobs.length} turns to score with ${MODEL} (${VIEW})`)

let cost = 0
let done = 0
await pool(jobs, 6, async job => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: gateBody(MODEL, job.turn),
    })
    const parsed = res.ok ? parseGate(await res.text()) : { error: `status ${res.status}` }
    if (!('error' in parsed)) {
      scores[job.key] = parsed.p
      cost += parsed.cost
      break
    }
    if (attempt === 2) console.error(`  ${job.key}: ${parsed.error}`)
    await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
  }
  if (++done % 100 === 0) {
    writeJson(file, scores)
    console.log(`  ${done} scored`)
  }
})
writeJson(file, scores)
console.log(`scored ${Object.keys(scores).length} turns, Jev cost $${cost.toFixed(5)}`)
