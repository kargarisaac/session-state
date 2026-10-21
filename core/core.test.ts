import { expect, test } from 'claude-code/testing'

import { contextText } from './context'
import { digestText } from './digest'
import { checkFileRoles, checkLearnings, checkMemories, isQuoteOf, parseExtraction, systemPrompt, wordCount } from './extract'
import { addToolCall, emptyFacts, factsText } from './facts'
import { fileIndex, rankFiles } from './files'
import { gateState, parseGate } from './gate'
import { archivedTurns, haikuCost, parseLedger, parsePending, serializeLedger, serializePending, summarize, turnRecord } from './ledger'
import { activeNotes, applyMemories, newFront, openAsks, parseOldNotes, rulesText, upsertIndex } from './notes'
import { processTurn } from './pipeline'
import type { Ledger } from './pipeline'
import { clip, redact } from './redact'
import { applyFileRoles, applyLearnings, emptyState, historyBlock, parseState, renderState, seedState } from './state'
import { appendStep, stepLine, stepLines } from './steps'
import { parseTranscript } from './transcript'
import { DEFAULTS } from './types'
import type { CompleteResult, Config, Host, Memory, State, Turn, TurnFacts } from './types'

const CWD = '/work/demo'
const FRONT = newFront({ sessionId: 'abc12345-0000', project: 'demo', cwd: CWD, started: '2026-10-20', transcript: '~/t.jsonl' })
const USAGE = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }

const fresh = (): State => emptyState(FRONT)

const turn = (user: string, n = 1, over: Partial<Turn> = {}): Turn => ({
  turn: n,
  turnId: `id-${n}`,
  user,
  answer: 'Done.',
  previousAnswer: '',
  isAborted: false,
  facts: emptyFacts(),
  ...over,
})

const memory = (text: string, quote: string, over: Partial<Memory> = {}): Memory => ({
  kind: 'decision',
  text,
  why: '',
  context: '',
  quote,
  refersTo: [],
  supersedes: [],
  ...over,
})

const json = (body: object): CompleteResult => ({ isOk: true, text: JSON.stringify(body), usage: USAGE })

const reply = (over: { memories?: object[]; step?: string; title?: string; done?: number[]; files?: object[]; learnings?: object[]; need?: number } = {}): CompleteResult =>
  json({
    title: over.title ?? '',
    step: { text: over.step ?? 'Did the thing.', outcome: 'ok' },
    done: over.done ?? [],
    files: over.files ?? [],
    learnings: over.learnings ?? [],
    memories: over.memories ?? [],
    ...(over.need === undefined ? {} : { need: over.need }),
  })

// A host whose Jev answer and Haiku replies are scripted; it records every Haiku request.
const fakeHost = (p: number | 'down', replies: CompleteResult[]) => {
  const calls = { post: 0, complete: 0, requests: [] as { system: string; prompt: string; effort?: string }[] }
  const queue = [...replies]
  const host: Host = {
    now: async () => 1000,
    random: () => 0,
    complete: async req => {
      calls.complete += 1
      calls.requests.push(req)
      return queue.shift() ?? { isOk: false, reason: 'no scripted reply', usage: USAGE }
    },
    post: async () => {
      calls.post += 1
      if (p === 'down') return { status: 503, text: 'unavailable' }
      return { status: 200, text: JSON.stringify({ model: 'typesafe/jev-1.14-x', answers: { important: { type: 'noul', noul: p } }, usage: { input_tokens: 356, output_tokens: 20, cost: 0.000015 } }) }
    },
  }
  return { host, calls }
}

const config = (over: Partial<Config> = {}): Config => ({ ...DEFAULTS, jevKey: 'k', ...over })

const ledgerOf = (state: State, over: Partial<Ledger> = {}): Ledger => ({ state, steps: [], archive: [], files: [], ...over })

const withFacts = (over: Partial<TurnFacts>): TurnFacts => ({ ...emptyFacts(), ...over })

// ---- text helpers

test('redact hides keys and secret-looking assignments but not prose', async () => {
  const out = redact('use sk-or-v1-abcdef1234567890abcdef and\nOPENROUTER_API_KEY=abc123\nBearer abcdefghijklmnopqrstuvwxyz\nhello world')
  expect(out).toContain('hello world')
  expect(out.includes('abcdef1234567890')).toBe(false)
  expect(out.includes('abc123')).toBe(false)
  expect(out.includes('abcdefghijklmnop')).toBe(false)
})

test('redact also hides passwords in URLs, Basic auth, AWS and API secrets in settings, more token kinds and a cut-off private key', async () => {
  const secrets: [string, string][] = [
    ['postgres://admin:s3cretpw@db.example.com:5432/app', 's3cretpw'],
    ['git clone https://x-access-token:abc123def@github.com/org/repo.git', 'abc123def'],
    ['DATABASE_URL=postgres://admin:s3cretpw@db.example.com/app', 's3cretpw'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
    ['ASIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE'],
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['{"api_key": "abcdef1234567890xyz", "password": "hunter2hunter2"}', 'abcdef1234567890xyz'],
    ['cd app && FOO_TOKEN=abc123 python run.py', 'abc123'],
    ['hf_abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz'],
    ['npm_abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz'],
    ['sk_live_' + 'abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx'],
    ['glpat-abcdefghijklmnopqrst', 'abcdefghijklmnopqrst'],
    ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'eyJzdWIiOiIx'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nabc', 'b3BlbnNzaC1rZXktdjEAAAAA'],
  ]
  for (const [text, secret] of secrets) expect([text, redact(text).includes(secret)]).toEqual([text, false])
  const prose = [
    'Key points: always use SQLite; token: string; the password field is hidden',
    'see https://example.com/docs:443/x and ssh://git@github.com/org/repo, or git@github.com:org/repo.git',
    'const apiKey = process.env.API_KEY',
  ]
  for (const text of prose) expect(redact(text)).toBe(text)
})

test('redact stays fast on a huge paste of blank lines or dotted words', async () => {
  const start = Date.now()
  redact(' \n'.repeat(40000))
  redact('a.'.repeat(300000))
  redact('A-'.repeat(300000))
  expect(Date.now() - start).toBeLessThan(1000)
})

test('clip keeps the start and the end of a long text', async () => {
  const out = clip('A'.repeat(500) + 'B'.repeat(500), 100)
  expect(out.startsWith('AAAA')).toBe(true)
  expect(out.endsWith('BBBB')).toBe(true)
  expect(out).toContain('characters cut')
})

test('a quote must be the source words, ignoring whitespace and curly quotes', async () => {
  expect(isQuoteOf('use  SQLite\ninstead', 'ok, use SQLite instead of it')).toBe(true)
  expect(isQuoteOf('don’t use it', "don't use it")).toBe(true)
  expect(isQuoteOf('use Postgres', 'use SQLite')).toBe(false)
  expect(isQuoteOf('ok', 'ok')).toBe(false)
})

// ---- facts from tool calls

test('tool calls become the turn facts: reads, edits, failed commands and commits', async () => {
  let f = emptyFacts()
  f = addToolCall(f, { tool: 'Read', input: { file_path: `${CWD}/a.ts` }, isError: false, text: '' })
  f = addToolCall(f, { tool: 'Read', input: { file_path: `${CWD}/a.ts` }, isError: false, text: '' })
  f = addToolCall(f, { tool: 'Edit', input: { file_path: `${CWD}/b.ts` }, isError: false, text: '' })
  f = addToolCall(f, { tool: 'Write', input: { file_path: `${CWD}/c.ts` }, isError: true, text: 'denied' })
  f = addToolCall(f, { tool: 'Bash', input: { command: 'bun test' }, isError: true, text: 'error: key sk-or-v1-abcdef1234567890abcdef rejected\n3 failed' })
  f = addToolCall(f, { tool: 'Bash', input: { command: 'git commit -m "Fix parser"' }, isError: false, text: '[main 3fa2c1b9] Fix parser\n 1 file changed' })
  expect(f.read).toEqual([`${CWD}/a.ts`])
  expect(f.edited).toEqual([`${CWD}/b.ts`])
  expect(f.commands).toBe(2)
  expect(f.failures.length).toBe(1)
  expect(f.failures[0]!.error.includes('abcdef1234567890')).toBe(false)
  expect(f.commits).toEqual(['3fa2c1b Fix parser'])
  expect(factsText(f, CWD)).toBe('edited b.ts · read 1 file · 2 commands, 1 failed · commit 3fa2c1b Fix parser')
})

// ---- parsing and checking Haiku's reply

test('the reply parses: fenced JSON, every section, and "M-002", "L-1", "t40" style ids', async () => {
  const raw =
    '```json\n' +
    JSON.stringify({
      step: { text: ' Moved  the parser. ', outcome: 'failed' },
      done: ['M-002'],
      files: [{ path: 'core/parse.ts', role: 'Parses the ledger' }],
      learnings: [{ kind: 'failed', text: 'Bun cannot run it.', why: 'no TS', evidence: 'cannot', replaces: ['L-1'] }, { kind: 'bogus', text: 'x', evidence: 'y' }],
      memories: [{ kind: 'decision', text: 'Use SQLite.', why: 'simple', context: 'storage', quote: 'use SQLite', refers_to: ['t40'], supersedes: ['M-002', 3, 'x'] }],
      need: 't12',
    }) +
    '\n```'
  const parsed = parseExtraction(raw)
  expect('error' in parsed).toBe(false)
  if ('error' in parsed) return
  expect(parsed.step).toEqual({ text: 'Moved the parser.', outcome: 'failed' })
  expect(parsed.done).toEqual([2])
  expect(parsed.learnings.length).toBe(1)
  expect(parsed.learnings[0]!.replaces).toEqual([1])
  expect(parsed.memories[0]).toMatchObject({ why: 'simple', context: 'storage', refersTo: [40], supersedes: [2, 3] })
  expect(parsed.need).toBe(12)
  expect('error' in parseExtraction('no json here')).toBe(true)
})

test('only extraction asks for notes about the user; summarization says memories stay empty', async () => {
  expect(systemPrompt('extract', 15)).toContain('"quote"')
  expect(systemPrompt('extract', 15)).toContain('"need"')
  expect(systemPrompt('summarize', 15)).toContain('"memories" is always []')
  expect(systemPrompt('summarize', 15).includes('"need"')).toBe(false)
})

test('memory checks drop invented quotes, over-long notes and duplicates, and tidy ids and reasons', async () => {
  const { state } = applyMemories(fresh(), [memory('Use Postgres.', 'use Postgres')], 1, 'id-1', '')
  const user = 'Actually use SQLite, not Postgres. Keep it simple.'
  const longWhy = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ')
  const checked = checkMemories(
    [
      memory('Use SQLite.', 'use SQLite', { supersedes: [1, 99], refersTo: [1, 5, 9], why: longWhy }),
      memory('Invented thing.', 'never said this'),
      memory('Use Postgres.', 'Postgres'),
      memory('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 'Keep it simple'),
    ],
    user,
    activeNotes(state),
    15,
    5,
  )
  expect(checked.kept.length).toBe(1)
  expect(checked.kept[0]!.supersedes).toEqual([1])
  expect(checked.kept[0]!.refersTo).toEqual([1])
  expect(wordCount(checked.kept[0]!.why)).toBe(60)
  expect(checked.overLong.length).toBe(1)
  expect(checked.dropped.length).toBe(2)
})

test('a learning must cite the reply or a failed command; a role only fits a file edited this turn', async () => {
  const facts = withFacts({ edited: [`${CWD}/core/a.ts`], failures: [{ command: 'bun x', error: 'ENOENT: no such file' }] })
  const learned = checkLearnings(
    [
      { kind: 'constraint', text: 'The file is missing on CI.', why: '', evidence: 'ENOENT: no such file', replaces: [] },
      { kind: 'failed', text: 'Made up.', why: '', evidence: 'never printed', replaces: [] },
    ],
    'I tried it.',
    facts,
    [],
  )
  expect(learned.kept.map(l => l.text)).toEqual(['The file is missing on CI.'])
  expect(learned.dropped.length).toBe(1)
  const roles = checkFileRoles([{ path: 'core/a.ts', role: 'one two three four five six seven eight nine ten eleven twelve' }, { path: 'core/b.ts', role: 'x' }], facts.edited, CWD)
  expect(roles.length).toBe(1)
  expect(roles[0]!.path).toBe(`${CWD}/core/a.ts`)
  expect(wordCount(roles[0]!.role)).toBe(10)
})

// ---- state.md, history.md, steps.md

test('state.md round-trips rich notes, learnings, roles and the person\'s own lines', async () => {
  let { state } = applyMemories(
    fresh(),
    [
      memory('Use SQLite for storage.', 'use SQLite', { why: 'One file, no server.', context: 'Choosing the ledger store.', refersTo: [] }),
      memory('Rename the video.', 'rename the video', { kind: 'ask' }),
    ],
    3,
    'turn-uuid-123456',
    'Storage choice',
  )
  state = applyLearnings(state, [{ kind: 'failed', text: 'Bun test needs the plugin runner.', why: 'imports claude-code', evidence: 'Cannot find module', replaces: [] }], 3).state
  state = applyFileRoles(state, [{ path: `${CWD}/core/state.ts`, role: 'Reads and writes state.md' }])
  state = { ...state, own: ['- ship on friday'] }
  const files = fileIndex([turnRecord(turn('x', 3, { facts: withFacts({ edited: [`${CWD}/core/state.ts`] }) }), 0)])
  const md = renderState(state, files)
  expect(md).toContain('# Storage choice')
  expect(md).toContain('### M-001 · decision · t3\nUse SQLite for storage.\nWhy: One file, no server.\nContext: Choosing the ledger store.\nQuote: "use SQLite"\nSource: t3 · turn turn-uui')
  expect(md).toContain('## Open asks\n### M-002 · ask · t3')
  expect(md).toContain('### L-001 · failed · t3')
  expect(md).toContain('- `core/state.ts` · edited 1 · t3 · role: Reads and writes state.md')
  expect(md).toContain('## Your notes\n- ship on friday')

  const again = parseState(md)
  expect(again.notes.map(n => ({ ...n, source: { ...n.source, turnId: '' } }))).toEqual(state.notes.map(n => ({ ...n, source: { ...n.source, turnId: '' } })))
  expect(again.learnings).toEqual(state.learnings)
  expect(again.roles).toEqual(state.roles)
  expect(again.own).toEqual(['- ship on friday'])
  expect(again.front.next_id).toBe('3')

  // The person deletes M-002 by hand: it stays gone and its id is not reused.
  const edited = parseState(md.replace(/### M-002[\s\S]*?(?=\n## )/, ''))
  const next = applyMemories(edited, [memory('Use DuckDB.', 'q')], 9, '', '')
  expect(next.state.notes.map(n => n.id)).toEqual([1, 3])
})

// A state.md with two notes, a learning, a role and a line of the person's own.
const richMd = (): string => {
  let { state } = applyMemories(
    fresh(),
    [memory('Use SQLite for storage.', 'use SQLite', { why: 'One file.', context: 'Choosing the store.' }), memory('Rename the video.', 'rename it', { kind: 'ask' })],
    3,
    'turn-uuid-123456',
    'Storage choice',
  )
  state = applyLearnings(state, [{ kind: 'failed', text: 'Bun test needs the runner.', why: 'imports', evidence: 'Cannot find module', replaces: [] }], 3).state
  state = applyFileRoles(state, [{ path: `${CWD}/core/state.ts`, role: 'Reads and writes state.md' }])
  return renderState({ ...state, own: ['- ship on friday'] }, richFiles)
}
const richFiles = fileIndex([turnRecord(turn('x', 3, { facts: withFacts({ edited: [`${CWD}/core/state.ts`] }) }), 0)])

test('a state.md saved with Windows line endings reads the same as one with Unix endings', async () => {
  const md = richMd()
  const crlf = parseState(md.replace(/\n/g, '\r\n'))
  expect(crlf).toEqual(parseState(md))
  expect(renderState(crlf, richFiles)).toBe(md)
  expect(crlf.notes.map(n => n.why)).toEqual(['One file.', ''])
  expect(crlf.front.title).toBe('Storage choice')
  expect(Object.keys(crlf.roles)).toEqual(['core/state.ts'])
})

test('everything the person writes under "Your notes" is kept: blank lines, sub-headings and what follows them', async () => {
  const hand = `${richMd()}\n- second para\n\n## Todo\n- item under a heading\n`
  const state = parseState(hand)
  expect(state.own).toEqual(['- ship on friday', '', '- second para', '', '## Todo', '- item under a heading'])
  const again = renderState(state, [])
  expect(again).toContain('## Your notes\n- ship on friday\n\n- second para\n\n## Todo\n- item under a heading\n')
  expect(renderState(parseState(again), [])).toBe(again)
})

test('a note heading the person broke does not take over the note above it', async () => {
  const two = applyMemories(fresh(), [memory('Use SQLite.', 'use SQLite', { why: 'One file.' }), memory('Keep answers short.', 'short', { why: 'Less to read.' })], 3, '', '').state
  const md = renderState(two, []).replace('### M-002 · decision · t3', '### M-002 · decision')
  const state = parseState(md)
  expect(state.notes.map(n => [n.id, n.text, n.why])).toEqual([[1, 'Use SQLite.', 'One file.']])
})

test('replaced and finished items move to history with what replaced them; only asks can finish', async () => {
  let { state } = applyMemories(fresh(), [memory('Use Postgres.', 'q'), memory('Rename the video.', 'q', { kind: 'ask' })], 1, '', '')
  expect(openAsks(state).map(n => n.id)).toEqual([2])
  const replaced = applyMemories(state, [memory('Use SQLite.', 'q', { supersedes: [1] })], 4, '', '', [1, 2])
  state = replaced.state
  expect(activeNotes(state).map(n => n.id)).toEqual([3])
  expect(replaced.moved.map(historyBlock).join('\n')).toContain('### M-001 · decision · t1 · replaced by M-003 at t4')
  expect(replaced.moved.map(historyBlock).join('\n')).toContain('### M-002 · ask · t1 · done at t4')
})

test('steps.md is append-only, one line per turn', async () => {
  const step = { turn: 4, outcome: 'ok' as const, text: 'Moved the parser.', facts: 'edited a.ts', added: ['M-003'], done: ['M-001'] }
  expect(stepLine(step)).toBe('- t4 · ✓ · Moved the parser. · edited a.ts · +M-003 · done M-001')
  const md = appendStep('', step)
  expect(md.startsWith('# Steps')).toBe(true)
  expect(appendStep(md, step)).toBe(md)
  const two = appendStep(md, { ...step, turn: 5, outcome: 'aborted', facts: '', added: [], done: [] })
  expect(stepLines(two)).toEqual(['- t4 · ✓ · Moved the parser. · edited a.ts · +M-003 · done M-001', '- t5 · ◌ · Moved the parser.'])
})

test('an old single-file notes file seeds the ledger with its active notes only', async () => {
  const old =
    '---\nsession_id: x\ntitle: Video work\nnext_id: 4\n---\n# Video work\n' +
    '- ~~M-001 · t1 · decision · Use Postgres.~~ → superseded by M-003\n' +
    '- ~~M-002 · t2 · ask · Rename the video.~~ → done t5\n' +
    '- M-003 · t3 · decision · Use SQLite.\n'
  const { title, notes } = parseOldNotes(old)
  expect(title).toBe('Video work')
  expect(notes).toEqual([{ id: 3, turn: 3, kind: 'decision', text: 'Use SQLite.' }])
  const state = seedState(notes, { ...FRONT, title })
  expect(state.front.next_id).toBe('4')
  expect(renderState(state, [])).toContain('### M-003 · decision · t3\nUse SQLite.')
})

// ---- files, digest, context

test('edited and recent files rank above files read once long ago, and keep their roles', async () => {
  const records = [
    turnRecord(turn('a', 1, { facts: withFacts({ read: [`${CWD}/old.ts`] }) }), 0),
    turnRecord(turn('b', 9, { facts: withFacts({ edited: [`${CWD}/core/state.ts`], read: [`${CWD}/core/state.ts`] }) }), 0),
  ]
  const state = applyFileRoles(fresh(), [{ path: `${CWD}/core/state.ts`, role: 'state.md writer' }])
  const ranked = rankFiles(fileIndex(records), state, 10)
  expect(ranked.map(f => f.path)).toEqual([`${CWD}/core/state.ts`, `${CWD}/old.ts`])
  expect(ranked[0]).toMatchObject({ edits: 1, reads: 1, role: 'state.md writer' })
})

test('the digest puts asks and rules first, cuts the least needed to fit, and ends with the path', async () => {
  const { state } = applyMemories(fresh(), [memory('Rename the video.', 'rename it', { kind: 'ask' }), memory('Use SQLite.', 'use SQLite', { why: 'simple' })], 2, '', '')
  const steps = Array.from({ length: 30 }, (_, i) => `- t${i + 1} · ✓ · Step number ${i + 1} with some words to fill the line`)
  const full = digestText(state, steps, [], '/h/ledger')
  expect(full.indexOf('## Open asks')).toBeLessThan(full.indexOf('## Decisions and rules'))
  expect(full).toContain('- M-002 (t2) Use SQLite. Why: simple User: "use SQLite"')
  expect(full).toContain('- t30 ·')
  expect(full.includes('- t20 ·')).toBe(false)
  expect(full.endsWith('Full ledger: /h/ledger/state.md (steps.md has every turn).')).toBe(true)
  const small = digestText(state, steps, [], '/h/ledger', 400)
  expect(small.length).toBeLessThan(400)
  expect(small).toContain('Rename the video.')
  expect(small).toContain('cut to fit')
})

test('Haiku sees the ledger, recent steps, earlier user messages verbatim, the previous reply and the turn facts', async () => {
  const { state } = applyMemories(fresh(), [memory('Use SQLite.', 'q')], 1, '', '')
  const earlier = Array.from({ length: 12 }, (_, i) => turnRecord(turn(`message number ${i + 1}`, i + 1), 0))
  const text = contextText({
    state,
    steps: ['- t12 · ✓ · Did it.'],
    earlier,
    files: [],
    turn: turn('yes, the second one', 13, { previousAnswer: 'Option one or option two?', facts: withFacts({ edited: [`${CWD}/x.ts`] }) }),
  })
  expect(text).toContain('M-001 [decision] Use SQLite.')
  expect(text).toContain('- t12 · ✓ · Did it.')
  expect(text).toContain('t12: message number 12')
  expect(text).toContain('t3: message number 3')
  expect(text.includes('t2: message number 2')).toBe(false)
  expect(text).toContain('Previous agent reply:\nOption one or option two?')
  expect(text).toContain("THIS TURN, t13. The user's message:\nyes, the second one")
  expect(text).toContain('Edited files with no role yet: x.ts')
})

// ---- gate

test('a real Jev answer parses, a malformed one reports an error, and the gate sees the previous reply', async () => {
  const real = '{"model":"typesafe/jev-1.13-20260917","answers":{"important":{"type":"noul","noul":0.93}},"usage":{"input_tokens":356,"output_tokens":20,"cost":0.000014952}}'
  const ok = parseGate(real)
  expect('p' in ok && ok.p).toBe(0.93)
  expect('error' in parseGate('{"answers":{}}')).toBe(true)
  expect('error' in parseGate('nope')).toBe(true)
  const state = gateState(turn('yes', 2, { previousAnswer: `${'x'.repeat(3000)} Shall I delete the old files?` }))
  expect(state.startsWith('Previous agent reply (end): ')).toBe(true)
  expect(state).toContain('Shall I delete the old files?\n\nUser: yes\n\nAgent: Done.')
  expect(state.length).toBeLessThan(2200)
  expect(gateState(turn('hi')).startsWith('User: hi')).toBe(true)
})

// ---- the whole turn

test('below the threshold one low-effort summarization runs: a step, no notes about the user', async () => {
  const { host, calls } = fakeHost(0.2, [reply({ step: 'Ran the tests; all pass.', memories: [{ kind: 'decision', text: 'X.', quote: 'run the tests' }] })])
  const out = await processTurn(host, config(), ledgerOf(fresh()), turn('run the tests'))
  expect(calls.complete).toBe(1)
  expect(calls.requests[0]!.effort).toBe('low')
  expect(out.events[0]).toMatchObject({ type: 'gate', action: 'skip', p: 0.2 })
  expect(out.events[1]).toMatchObject({ type: 'extract', mode: 'summarize', kept: 0 })
  expect(out.state.notes.length).toBe(0)
  expect(out.step).toMatchObject({ turn: 1, outcome: 'ok', text: 'Ran the tests; all pass.' })
})

test('above the threshold one extraction at the set effort saves a rich note with its source', async () => {
  const { host, calls } = fakeHost(0.95, [
    reply({ title: 'Storage choice', step: 'Switched storage to SQLite.', memories: [{ kind: 'decision', text: 'Use SQLite for storage.', why: 'No server to run.', context: 'Picking a store.', quote: 'use SQLite', refers_to: [], supersedes: [] }] }),
  ])
  const out = await processTurn(host, config(), ledgerOf(fresh()), turn('Please use SQLite from now on.', 7))
  expect(calls.post).toBe(1)
  expect(calls.complete).toBe(1)
  expect(calls.requests[0]!.effort).toBe('high')
  expect(out.state.front.title).toBe('Storage choice')
  expect(out.state.notes[0]).toMatchObject({ id: 1, turn: 7, text: 'Use SQLite for storage.', why: 'No server to run.', context: 'Picking a store.', source: { turnId: 'id-7', refersTo: [] } })
  expect(out.step.added).toEqual(['M-001'])
  expect(out.events[1]).toMatchObject({ type: 'extract', mode: 'extract', kept: 1, usage: USAGE })
})

test('extraction may ask for one older turn, and answers again with it in view', async () => {
  const archive = [turnRecord(turn('For the deck, always use the dark theme.', 3), 0)]
  const { host, calls } = fakeHost(0.95, [
    reply({ need: 3 }),
    reply({ memories: [{ kind: 'requirement', text: 'Use the dark theme for the deck.', quote: 'do what I said', refers_to: [3] }], need: 3 }),
  ])
  const out = await processTurn(host, config(), ledgerOf(fresh(), { archive }), turn('do what I said about the deck', 9))
  expect(calls.complete).toBe(2)
  expect(calls.requests[1]!.prompt).toContain('Turn t3, which you asked for:\nUser: For the deck, always use the dark theme.')
  expect(out.state.notes[0]!.source.refersTo).toEqual([3])
  expect(out.events[1]).toMatchObject({ need: 3, kept: 1 })
})

test('an over-long note is asked again once and the short version is kept', async () => {
  const long = { kind: 'decision', text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', quote: 'use SQLite' }
  const { host, calls } = fakeHost(0.95, [reply({ memories: [long] }), reply({ memories: [{ kind: 'decision', text: 'Use SQLite.', quote: 'use SQLite' }] })])
  const out = await processTurn(host, config(), ledgerOf(fresh()), turn('use SQLite please'))
  expect(calls.complete).toBe(2)
  expect(activeNotes(out.state).map(n => n.text)).toEqual(['Use SQLite.'])
})

test('a note whose quote is invented is dropped, not saved', async () => {
  const { host } = fakeHost(0.95, [reply({ memories: [{ kind: 'decision', text: 'Use Redis.', quote: 'use Redis' }] })])
  const out = await processTurn(host, config(), ledgerOf(fresh()), turn('use SQLite please'))
  expect(out.state.notes.length).toBe(0)
  expect(out.events[1]).toMatchObject({ kept: 0 })
  expect((out.events[1] as { dropped: string[] }).dropped[0]).toContain('quote not in the user message')
})

test('with Jev down or off, Haiku extracts so nothing is lost', async () => {
  const down = fakeHost('down', [reply()])
  const outDown = await processTurn(down.host, config(), ledgerOf(fresh()), turn('use SQLite'))
  expect(outDown.events[0]).toMatchObject({ action: 'error' })
  expect(outDown.events[1]).toMatchObject({ mode: 'extract' })
  const off = fakeHost(0, [reply()])
  const outOff = await processTurn(off.host, config({ gate: 'off' }), ledgerOf(fresh()), turn('ok'))
  expect(off.calls.post).toBe(0)
  expect(outOff.events[0]).toMatchObject({ action: 'off' })
  expect(outOff.events[1]).toMatchObject({ mode: 'extract' })
})

test('Haiku failing twice keeps the state, records the error, and the step falls back to the user words', async () => {
  const { host, calls } = fakeHost(0.95, [])
  const state = fresh()
  const out = await processTurn(host, config(), ledgerOf(state), turn('use SQLite\nand more', 1, { isAborted: true }))
  expect(calls.complete).toBe(2)
  expect(out.state.notes.length).toBe(0)
  expect(out.step).toMatchObject({ outcome: 'aborted', text: 'Asked: use SQLite' })
  expect(out.events[1]).toMatchObject({ type: 'extract', kept: 0, error: 'haiku: no scripted reply' })
})

test('one turn can finish an ask, record a learning, name a file and replace a decision', async () => {
  const seed = applyMemories(fresh(), [memory('Rename the video.', 'q', { kind: 'ask' }), memory('Use Postgres.', 'q')], 1, '', '').state
  const facts = withFacts({ edited: [`${CWD}/video.ts`], commands: 1, failures: [{ command: 'ffmpeg -i a', error: 'codec not found' }] })
  const { host } = fakeHost(0.95, [
    reply({
      done: [1, 2, 99],
      files: [{ path: 'video.ts', role: 'Renders the product video' }],
      learnings: [{ kind: 'constraint', text: 'ffmpeg here lacks the h265 codec.', why: '', evidence: 'codec not found', replaces: [] }],
      memories: [{ kind: 'decision', text: 'Use SQLite, not Postgres.', quote: 'SQLite instead', supersedes: [2] }],
    }),
  ])
  const out = await processTurn(host, config(), ledgerOf(seed), turn('actually SQLite instead', 2, { answer: 'Renamed the video.', facts }))
  expect(activeNotes(out.state).map(n => n.id)).toEqual([3])
  expect(out.moved.map(m => m.reason)).toEqual(['superseded', 'done'])
  expect(out.state.learnings.map(l => l.text)).toEqual(['ffmpeg here lacks the h265 codec.'])
  expect(out.state.roles).toEqual({ 'video.ts': 'Renders the product video' })
  expect(out.step).toMatchObject({ added: ['M-003', 'L-001'], done: ['M-001'], facts: 'edited video.ts · 1 command, 1 failed' })
  expect(out.events[1]).toMatchObject({ kept: 1, learned: 1, closed: 1, roles: 1 })
})

// ---- ledger and index

test('the ledger round-trips, keeps the turn archive, and its totals match the events', async () => {
  const { host } = fakeHost(0.95, [reply({ memories: [{ kind: 'decision', text: 'Use SQLite.', quote: 'use SQLite' }] })])
  const t = turn('use SQLite, key sk-or-v1-abcdef1234567890abcdef', 1, { facts: withFacts({ read: ['/a'] }) })
  const out = await processTurn(host, config(), ledgerOf(fresh()), t)
  const events = parseLedger(serializeLedger([turnRecord(t, 5), ...out.events]))
  expect(events.slice(1)).toEqual(out.events)
  expect(archivedTurns(events)[0]).toMatchObject({ turn: 1, facts: { read: ['/a'] } })
  expect(archivedTurns(events)[0]!.user.includes('abcdef1234567890')).toBe(false)
  const stats = summarize(events)
  expect(stats).toMatchObject({ turns: 1, passed: 1, saved: 1, jevCalls: 1, extractions: 1, summaries: 0 })
  expect(stats.haikuCost).toBe(haikuCost(USAGE))
  expect(parsePending(serializePending([t]))).toEqual([t])
  expect(parsePending('[{"turn":1,"turnId":"x","user":"u","answer":"a"}]')[0]!.facts).toEqual(emptyFacts())
})

test('the rules for the system prompt are only requirements and preferences, newest eight', async () => {
  expect(rulesText(fresh())).toBe('')
  const rules = Array.from({ length: 10 }, (_, i) => memory(`Rule ${i + 1}.`, 'q', { kind: 'requirement' }))
  const { state } = applyMemories(fresh(), [...rules, memory('Use SQLite.', 'q'), memory('Rename it.', 'q', { kind: 'ask' }), memory('Short answers.', 'q', { kind: 'preference' })], 1, '', '')
  const text = rulesText(state)
  expect(text).toContain('- Short answers.')
  expect(text).toContain('- Rule 10.')
  expect(text.includes('- Rule 3.')).toBe(false)
  expect(text.includes('Use SQLite')).toBe(false)
  expect(text).toContain('3 older rules are in state.md')
})

test('the index keeps one row per session folder, newest first', async () => {
  let md = upsertIndex('', 'demo', { file: '2026-10-16_aaaa1111/state.md', date: '2026-10-16', title: 'Old', active: 1, learned: 0, steps: 3 })
  md = upsertIndex(md, 'demo', { file: '2026-10-17_bbbb2222/state.md', date: '2026-10-17', title: 'New | pipe', active: 2, learned: 1, steps: 9 })
  md = upsertIndex(md, 'demo', { file: '2026-10-16_aaaa1111/state.md', date: '2026-10-16', title: 'Old', active: 5, learned: 0, steps: 4 })
  const rows = md.split('\n').filter(l => l.startsWith('| 20'))
  expect(rows.length).toBe(2)
  expect(rows[0]).toContain('bbbb2222')
  expect(rows[1]).toContain('5 notes, 0 learned, 4 turns')
  expect(md.includes('New | pipe')).toBe(false)
})

const line = (o: object) => JSON.stringify(o)
const TRANSCRIPT = [
  line({ type: 'user', uuid: 'u1', message: { content: 'Use SQLite.' } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'k1', name: 'AskUserQuestion', input: {} }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'k1', content: 'Your questions have been answered: "Which file?"="db.ts". You can now continue.' }] }, toolUseResult: { answers: { 'Which file?': 'db.ts' } } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'k1', content: 'Your questions have been answered: "Which file?"="db.ts".' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'k2', name: 'Edit', input: { file_path: '/work/demo/db.ts' } }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'k2', content: 'ok' }] } }),
  line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'and keep it local' } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Switched to SQLite.' }] } }),
  line({ type: 'user', isMeta: true, message: { content: '<system-reminder>x</system-reminder>' } }),
  line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
  line({ type: 'user', uuid: 'u2', message: { content: [{ type: 'image', source: {} }, { type: 'text', text: 'what is this?' }] } }),
  line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } }),
  'not json',
].join('\n')

test('a transcript reads back as typed turns with the last reply, tool facts and question answers', () => {
  const [first, second, ...rest] = parseTranscript(TRANSCRIPT)
  expect(rest).toEqual([])
  expect(first).toMatchObject({ turn: 1, turnId: 'u1', answer: 'Switched to SQLite.', previousAnswer: '' })
  expect(first!.user).toBe("Use SQLite.\n\n[Answers to the agent's questions]\n- Which file? → db.ts\n\nand keep it local")
  expect(first!.facts.edited).toEqual(['/work/demo/db.ts'])
  expect(second).toMatchObject({ turn: 2, turnId: 'u2', user: 'what is this?', answer: '', previousAnswer: 'Switched to SQLite.' })
})
