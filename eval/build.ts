// Step 1: read your own Claude Code history and keep the long chats.
//   bun eval/build.ts [minPrompts=25] [skipSessionIdPrefix...]
import { listSessions, writeJson } from './lib'

const MIN = Number(process.argv[2] ?? 25)
const skip = process.argv.slice(3)
const MAX_TURNS = 250

const sessions = listSessions(skip)
  .filter(s => s.turns.length >= MIN)
  .map(s => ({ ...s, turns: s.turns.slice(0, MAX_TURNS) }))
const turns = sessions.reduce((n, s) => n + s.turns.length, 0)
writeJson('sessions.json', sessions)

const byProject = new Map<string, number>()
for (const s of sessions) byProject.set(s.project, (byProject.get(s.project) ?? 0) + s.turns.length)
console.log(`${sessions.length} sessions with at least ${MIN} prompts, ${turns} turns`)
for (const [p, n] of [...byProject].sort((a, b) => b[1] - a[1])) console.log(`  ${p}: ${n}`)
const short = sessions.flatMap(s => s.turns).filter(t => t.user.length <= 40).length
console.log(`${short} turns have a user message of 40 characters or less`)
