import { expect, test } from 'claude-code/testing'

import { checkMemories, isQuoteOf, parseExtraction, wordCount } from './extract'
import { parseGate } from './gate'
import { haikuCost, parseLedger, serializeLedger, summarize } from './ledger'
import { activeNotes, applyMemories, newDoc, openAsks, parseDoc, renderDoc, rulesText, upsertIndex } from './notes'
import { processTurn } from './pipeline'
import { clip, redact } from './redact'
import { DEFAULTS } from './types'
import type { CompleteResult, Config, Host, Memory, Turn } from './types'

const FACTS = { sessionId: 'abc12345-0000', project: 'demo', cwd: '/tmp/demo', started: '2026-10-17', transcript: '~/t.jsonl' }
const USAGE = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }

const turn = (user: string, n = 1): Turn => ({ turn: n, turnId: `t${n}`, user, answer: 'Done.', previousAnswer: '', isAborted: false })

const memory = (text: string, quote: string, supersedes: number[] = [], kind: Memory['kind'] = 'decision'): Memory => ({ kind, text, quote, supersedes })
const reply = (memories: Memory[], title = '', done: number[] = []): CompleteResult => ({ isOk: true, text: JSON.stringify({ title, memories, done }), usage: USAGE })
const closeReply = (done: number[]): CompleteResult => ({ isOk: true, text: JSON.stringify({ done }), usage: USAGE })

const LONG_ANSWER = 'I renamed the video to Nablo Product Tour and updated every reference in the repo and the deck.'

// A host whose Jev answer and Haiku replies are scripted; it records every call.
const fakeHost = (p: number | 'down', replies: CompleteResult[]) => {
  const calls = { post: 0, complete: 0 }
  const queue = [...replies]
  const host: Host = {
    now: async () => 1000,
    random: () => 0,
    complete: async () => {
      calls.complete += 1
      return queue.shift() ?? { isOk: false, reason: 'no scripted reply', usage: USAGE }
    },
    post: async () => {
      calls.post += 1
      if (p === 'down') return { status: 503, text: 'unavailable' }
      return { status: 200, text: JSON.stringify({ model: 'typesafe/jev-1.13-x', answers: { important: { type: 'noul', noul: p } }, usage: { input_tokens: 356, output_tokens: 20, cost: 0.000015 } }) }
    },
  }
  return { host, calls }
}

const config = (over: Partial<Config> = {}): Config => ({ ...DEFAULTS, jevKey: 'k', ...over })

test('redact hides keys and secret-looking assignments but not prose', async () => {
  const text = 'use sk-or-v1-abcdef1234567890abcdef and\nOPENROUTER_API_KEY=abc123\nBearer abcdefghijklmnopqrstuvwxyz\nhello world'
  const out = redact(text)
  expect(out).toContain('hello world')
  expect(out.includes('abcdef1234567890')).toBe(false)
  expect(out.includes('abc123')).toBe(false)
  expect(out.includes('abcdefghijklmnop')).toBe(false)
})

test('clip keeps the start and the end of a long text', async () => {
  const out = clip('A'.repeat(500) + 'B'.repeat(500), 100)
  expect(out.startsWith('AAAA')).toBe(true)
  expect(out.endsWith('BBBB')).toBe(true)
  expect(out).toContain('characters cut')
})

test('a quote must be the user words, ignoring whitespace and curly quotes', async () => {
  expect(isQuoteOf('use  SQLite\ninstead', 'ok, use SQLite instead of it')).toBe(true)
  expect(isQuoteOf('don’t use it', "don't use it")).toBe(true)
  expect(isQuoteOf('use Postgres', 'use SQLite')).toBe(false)
  expect(isQuoteOf('ok', 'ok')).toBe(false)
})

test('extraction parsing accepts fenced JSON and "M-002" style ids, and rejects prose', async () => {
  const raw = '```json\n{"memories":[{"kind":"decision","text":"Use SQLite.","quote":"use SQLite","supersedes":["M-002",3,"x"]},{"kind":"bogus","text":"x","quote":"y"}]}\n```'
  const parsed = parseExtraction(raw)
  expect('error' in parsed).toBe(false)
  if ('error' in parsed) return
  expect(parsed.memories.length).toBe(1)
  expect(parsed.memories[0]!.supersedes).toEqual([2, 3])
  expect('error' in parseExtraction('no json here')).toBe(true)
})

test('check drops invented quotes, over-long notes and duplicates; unknown supersedes ids are ignored', async () => {
  const doc = applyMemories(newDoc(FACTS), [memory('Use Postgres.', 'use Postgres')], 1, '')
  const active = activeNotes(doc)
  const user = 'Actually use SQLite, not Postgres. Keep it simple.'
  const checked = checkMemories(
    [
      memory('Use SQLite.', 'use SQLite', [1, 99]),
      memory('Invented thing.', 'never said this'),
      memory('Use Postgres.', 'Postgres'),
      memory('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 'Keep it simple'),
    ],
    user,
    active,
    15,
  )
  expect(checked.kept.length).toBe(1)
  expect(checked.kept[0]!.supersedes).toEqual([1])
  expect(checked.overLong.length).toBe(1)
  expect(checked.dropped.length).toBe(2)
  expect(wordCount('a b  c')).toBe(3)
})

test('a note file round-trips, keeps hand-written lines, and a deleted line stays gone with no id reuse', async () => {
  let doc = applyMemories(newDoc(FACTS), [memory('Use Postgres.', 'q'), memory('Tabs not spaces.', 'q')], 3, 'Storage talk')
  doc = applyMemories(doc, [memory('Use SQLite.', 'q', [1])], 7, '')
  const md = renderDoc(doc)
  expect(md).toContain('- ~~M-001 · t3 · decision · Use Postgres.~~ → superseded by M-003')
  expect(md).toContain('- M-003 · t7 · decision · Use SQLite.')
  expect(md).toContain('# Storage talk')

  const again = parseDoc(md)
  expect(again.items).toEqual(doc.items)
  expect(again.front.next_id).toBe('4')

  // The person deletes the last line and adds their own note by hand.
  const edited = md.replace('- M-003 · t7 · decision · Use SQLite.\n', '') + '- my own reminder: ship friday\n'
  const parsed = parseDoc(edited)
  expect(parsed.items.some(i => 'raw' in i && i.raw.includes('ship friday'))).toBe(true)
  const next = applyMemories(parsed, [memory('Use DuckDB.', 'q')], 9, '')
  const ids = next.items.flatMap(i => ('id' in i ? [i.id] : []))
  expect(ids).toEqual([1, 2, 4])
  expect(renderDoc(next)).toContain('my own reminder: ship friday')
})

test('the index keeps one row per file, newest first', async () => {
  let md = upsertIndex('', 'demo', { file: '2026-10-16_aaaa1111.md', date: '2026-10-16', title: 'Old', active: 1, done: 0, superseded: 0 })
  md = upsertIndex(md, 'demo', { file: '2026-10-17_bbbb2222.md', date: '2026-10-17', title: 'New | pipe', active: 2, done: 0, superseded: 1 })
  md = upsertIndex(md, 'demo', { file: '2026-10-16_aaaa1111.md', date: '2026-10-16', title: 'Old', active: 5, done: 0, superseded: 0 })
  const rows = md.split('\n').filter(l => l.startsWith('| 20'))
  expect(rows.length).toBe(2)
  expect(rows[0]).toContain('bbbb2222')
  expect(rows[1]).toContain('5 active')
  expect(md.includes('New | pipe')).toBe(false)
})

test('a real Jev answer parses, and a malformed one reports an error', async () => {
  const real = '{"model":"typesafe/jev-1.13-20260917","answers":{"important":{"type":"noul","noul":0.93}},"usage":{"input_tokens":356,"output_tokens":20,"cost":0.000014952},"id":"x","provider":"TypeSafe"}'
  const ok = parseGate(real)
  expect('p' in ok && ok.p).toBe(0.93)
  expect('error' in parseGate('{"answers":{}}')).toBe(true)
  expect('error' in parseGate('nope')).toBe(true)
})

test('below the threshold the turn is skipped and Haiku is never called', async () => {
  const { host, calls } = fakeHost(0.2, [reply([memory('X.', 'whatever')])])
  const out = await processTurn(host, config(), newDoc(FACTS), turn('run the tests'))
  expect(calls.complete).toBe(0)
  expect(out.events.length).toBe(1)
  expect(out.events[0]).toMatchObject({ type: 'gate', action: 'skip', p: 0.2 })
  expect(out.doc.items.length).toBe(0)
})

test('above the threshold Haiku runs and a verified memory is saved with the title', async () => {
  const { host, calls } = fakeHost(0.95, [reply([memory('Use SQLite for storage.', 'use SQLite')], 'Storage choice')])
  const out = await processTurn(host, config(), newDoc(FACTS), turn('Please use SQLite from now on.'))
  expect(calls.post).toBe(1)
  expect(calls.complete).toBe(1)
  expect(out.doc.front.title).toBe('Storage choice')
  expect(activeNotes(out.doc).map(n => n.text)).toEqual(['Use SQLite for storage.'])
  expect(out.events[1]).toMatchObject({ type: 'extract', kept: 1, usage: USAGE })
})

test('an over-long note is asked again once and the short version is kept', async () => {
  const long = memory('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 'use SQLite')
  const { host, calls } = fakeHost(0.95, [reply([long]), reply([memory('Use SQLite.', 'use SQLite')])])
  const out = await processTurn(host, config(), newDoc(FACTS), turn('use SQLite please'))
  expect(calls.complete).toBe(2)
  expect(activeNotes(out.doc).map(n => n.text)).toEqual(['Use SQLite.'])
  expect(out.events[1]).toMatchObject({ kept: 1 })
})

test('a note whose quote is invented is dropped, not saved', async () => {
  const { host } = fakeHost(0.95, [reply([memory('Use Redis.', 'use Redis')])])
  const out = await processTurn(host, config(), newDoc(FACTS), turn('use SQLite please'))
  expect(out.doc.items.length).toBe(0)
  expect(out.events[1]).toMatchObject({ kept: 0 })
})

test('a Jev outage skips the turn with an error event and does not call Haiku', async () => {
  const { host, calls } = fakeHost('down', [reply([])])
  const out = await processTurn(host, config(), newDoc(FACTS), turn('use SQLite'))
  expect(calls.complete).toBe(0)
  expect(out.events[0]).toMatchObject({ action: 'error' })
})

test('with the gate off Haiku runs on every turn and Jev is never called', async () => {
  const { host, calls } = fakeHost(0, [reply([])])
  const out = await processTurn(host, config({ gate: 'off' }), newDoc(FACTS), turn('ok'))
  expect(calls.post).toBe(0)
  expect(calls.complete).toBe(1)
  expect(out.events[0]).toMatchObject({ action: 'off' })
})

test('Haiku failing twice leaves the file unchanged and records the error', async () => {
  const { host, calls } = fakeHost(0.95, [])
  const out = await processTurn(host, config(), newDoc(FACTS), turn('use SQLite'))
  expect(calls.complete).toBe(2)
  expect(out.doc.items.length).toBe(0)
  expect(out.events[1]).toMatchObject({ type: 'extract', kept: 0, error: 'haiku: no scripted reply' })
})

test('a later decision supersedes the earlier one through the whole pipeline', async () => {
  const first = fakeHost(0.95, [reply([memory('Use Postgres.', 'use Postgres')])])
  let doc = (await processTurn(first.host, config(), newDoc(FACTS), turn('use Postgres', 1))).doc
  const second = fakeHost(0.95, [reply([memory('Use SQLite, not Postgres.', 'SQLite instead', [1])])])
  doc = (await processTurn(second.host, config(), doc, turn('actually SQLite instead', 2))).doc
  expect(renderDoc(doc)).toContain('- ~~M-001 · t1 · decision · Use Postgres.~~ → superseded by M-002')
  expect(activeNotes(doc).length).toBe(1)
})

test('the ledger round-trips and its totals match the events', async () => {
  const { host } = fakeHost(0.95, [reply([memory('Use SQLite.', 'use SQLite')])])
  const out = await processTurn(host, config(), newDoc(FACTS), turn('use SQLite'))
  const events = parseLedger(serializeLedger(out.events))
  expect(events).toEqual(out.events)
  const stats = summarize(events)
  expect(stats).toMatchObject({ turns: 1, passed: 1, saved: 1, jevCalls: 1, extractions: 1 })
  expect(stats.haikuCost).toBe(haikuCost(USAGE))
  expect(Math.abs(stats.jevCost - 0.000015)).toBeLessThan(1e-9)
})

test('a finished request is struck as done, round-trips, and only requests can be finished', async () => {
  let doc = applyMemories(newDoc(FACTS), [memory('Rename the video.', 'q', [], 'ask'), memory('Use SQLite.', 'q')], 2, '')
  expect(openAsks(doc).map(n => n.id)).toEqual([1])
  doc = applyMemories(doc, [], 6, '', [1])
  const md = renderDoc(doc)
  expect(md).toContain('- ~~M-001 · t2 · ask · Rename the video.~~ → done t6')
  expect(parseDoc(md).items).toEqual(doc.items)
  expect(openAsks(doc).length).toBe(0)
  expect(activeNotes(doc).map(n => n.id)).toEqual([2])
})

test('the rules for the system prompt are only requirements and preferences, newest eight', async () => {
  expect(rulesText(newDoc(FACTS))).toBe('')
  const rules = Array.from({ length: 10 }, (_, i) => memory(`Rule ${i + 1}.`, 'q', [], 'requirement'))
  const doc = applyMemories(newDoc(FACTS), [...rules, memory('Use SQLite.', 'q'), memory('Rename it.', 'q', [], 'ask'), memory('Short answers.', 'q', [], 'preference')], 1, '')
  const text = rulesText(doc)
  expect(text).toContain('- Short answers.')
  expect(text).toContain('- Rule 10.')
  expect(text.includes('- Rule 3.')).toBe(false)
  expect(text.includes('Use SQLite')).toBe(false)
  expect(text.includes('Rename it')).toBe(false)
  expect(text).toContain('3 older rules are in the notes file')
})

test('a skipped turn still closes an open request the agent finished, with one cheap look', async () => {
  const seed = applyMemories(newDoc(FACTS), [memory('Rename the video.', 'q', [], 'ask'), memory('Use SQLite.', 'q')], 1, '')
  const { host, calls } = fakeHost(0.05, [closeReply([1, 2, 99])])
  const out = await processTurn(host, config(), seed, { ...turn('ok thanks', 2), answer: LONG_ANSWER })
  expect(calls.complete).toBe(1)
  expect(renderDoc(out.doc)).toContain('~~M-001 · t1 · ask · Rename the video.~~ → done t2')
  expect(activeNotes(out.doc).map(n => n.id)).toEqual([2])
  expect(out.events[1]).toMatchObject({ type: 'close', closed: 1, usage: USAGE })
  expect(summarize(out.events)).toMatchObject({ closeChecks: 1, closed: 1, extractions: 0 })
})

test('no look at the reply when nothing is open, the reply is short, or the turn was cut off', async () => {
  const seed = applyMemories(newDoc(FACTS), [memory('Rename the video.', 'q', [], 'ask')], 1, '')
  const none = fakeHost(0.05, [closeReply([1])])
  await processTurn(none.host, config(), newDoc(FACTS), { ...turn('ok', 2), answer: LONG_ANSWER })
  const short = fakeHost(0.05, [closeReply([1])])
  await processTurn(short.host, config(), seed, turn('ok', 2))
  const cut = fakeHost(0.05, [closeReply([1])])
  await processTurn(cut.host, config(), seed, { ...turn('ok', 2), answer: LONG_ANSWER, isAborted: true })
  expect([none.calls.complete, short.calls.complete, cut.calls.complete]).toEqual([0, 0, 0])
})

test('a failed look at the reply loses nothing and is not a failed turn', async () => {
  const seed = applyMemories(newDoc(FACTS), [memory('Rename the video.', 'q', [], 'ask')], 1, '')
  const { host } = fakeHost(0.05, [])
  const out = await processTurn(host, config(), seed, { ...turn('ok', 2), answer: LONG_ANSWER })
  expect(out.doc).toBe(seed)
  expect(out.events[1]).toMatchObject({ type: 'close', closed: 0, error: 'haiku: no scripted reply' })
})

test('a turn that passes the gate can add a note and finish a request in one run', async () => {
  const seed = applyMemories(newDoc(FACTS), [memory('Rename the video.', 'q', [], 'ask')], 1, '')
  const { host, calls } = fakeHost(0.95, [reply([memory('Never use Opus as a subagent.', 'never use Opus', [], 'requirement')], '', [1])])
  const out = await processTurn(host, config(), seed, { ...turn('good, and never use Opus as a subagent', 2), answer: LONG_ANSWER })
  expect(calls.complete).toBe(1)
  expect(activeNotes(out.doc).map(n => n.text)).toEqual(['Never use Opus as a subagent.'])
  expect(renderDoc(out.doc)).toContain('→ done t2')
  expect(out.events[1]).toMatchObject({ type: 'extract', kept: 1, closed: 1 })
})
