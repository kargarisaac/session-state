import { expect, mock, test } from 'claude-code/testing'

const ID = 'abc12345-0000-0000-0000-000000000000'
const FILE = '/h/.claude/session-state/demo/2026-10-17_abc12345.md'

const USAGE = { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type TestDollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never

const PANE_PROPS = {
  title: 'Session notes',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as never

// An engine whose files live in a map, whose Jev answers `p`, and whose Haiku answers from a script.
const world = (on: TestOn, p: number, replies: object[]) => {
  const files = new Map<string, string>()
  const calls = { jev: 0, haiku: 0 }
  mock.env(on, { HOME: '/h', OPENROUTER_API_KEY: 'test-key' })
  on('session.id', () => ({ value: ID }) as never)
  on('session.cwd', () => ({ value: '/work/demo' }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', () => ({ cwd: '/work/demo' }) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('prompt.compose', () => ({ sections: [] }) as never)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.read', (_$, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'no such file' }) as never)
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('fs.list', () => ({ value: [] }) as never)
  on('http.fetch', () => {
    calls.jev += 1
    const body = { model: 'typesafe/jev-1.13-x', answers: { important: { type: 'noul', noul: p } }, usage: { input_tokens: 356, output_tokens: 20, cost: 0.000015 } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('model.complete', () => {
    const next = replies[calls.haiku++] ?? { memories: [] }
    return { value: { isAnswered: true, text: JSON.stringify(next), usage: USAGE } } as never
  })
  return { files, calls }
}

const say = async ($: TestDollar, text: string, answer: string, n: number) => {
  await $.prompt.submit({ text } as never)
  await $.turn.complete({ turnId: `t${n}`, answer, durationMs: 10, isAborted: false } as never)
}

const settle = async (clock: { advance: (ms: number) => Promise<void> }, files: Map<string, string>, until: (f: Map<string, string>) => boolean) => {
  for (let i = 0; i < 30 && !until(files); i++) await clock.advance(10)
}

const textOf = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

test('a decision above the gate is saved to the notes file, indexed and counted in the panel', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 17, 8, 0, 0) })
  const { files, calls } = world(on, 0.95, [
    { title: 'Storage choice', memories: [{ kind: 'decision', text: 'Use SQLite for storage.', quote: 'use SQLite', supersedes: [] }] },
  ])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(FILE))

  const md = files.get(FILE) ?? ''
  expect(md).toContain('- M-001 · t1 · decision · Use SQLite for storage.')
  expect(md).toContain('session_id: abc12345-0000-0000-0000-000000000000')
  expect(md).toContain('# Storage choice')
  expect(files.get('/h/.claude/session-state/demo/INDEX.md') ?? '').toContain('2026-10-17_abc12345.md')
  expect(files.get(FILE.replace('.md', '.metrics.jsonl')) ?? '').toContain('"type":"extract"')
  expect(calls).toEqual({ jev: 1, haiku: 1 })

  const ui = await $.ui.mount({ plugin: 'session-state', surface: 'terminal', component: 'Pane', requestId: 'session-state', props: PANE_PROPS } as never)
  const panel = await textOf(ui)
  expect(panel).toContain('1 active')
  expect(panel).toContain('jev-1.13')
})

test('a turn below the gate writes no note and never calls Haiku', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 17, 8, 0, 0) })
  const { files, calls } = world(on, 0.1, [])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'run the tests', 'All pass.', 1)
  await settle(clock, files, f => f.has(FILE.replace('.md', '.metrics.jsonl')))

  expect(files.has(FILE)).toBe(false)
  expect(files.get(FILE.replace('.md', '.metrics.jsonl')) ?? '').toContain('"action":"skip"')
  expect(calls).toEqual({ jev: 1, haiku: 0 })
})

test('a paused session records nothing', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 17, 8, 0, 0) })
  const { files, calls } = world(on, 0.95, [{ memories: [] }])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  const paused = await $.command.run({ command: 'session-state', args: 'pause' } as never)
  expect(JSON.stringify(paused)).toContain('paused')
  await say($, 'use SQLite', 'ok', 1)
  await clock.advance(50)

  expect(files.size).toBe(0)
  expect(calls).toEqual({ jev: 0, haiku: 0 })
})

test('the system prompt tells the agent where the notes are, the same text on every request', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 17, 8, 0, 0) })
  world(on, 0.95, [])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  const first = await $.prompt.compose(COMPOSE)
  const second = await $.prompt.compose(COMPOSE)
  const section = first.sections.find(s => s.id === 'session-state:notes')

  expect(section?.scope).toBe('session')
  expect(section?.text).toContain(FILE)
  expect(JSON.stringify(second)).toBe(JSON.stringify(first))
})
