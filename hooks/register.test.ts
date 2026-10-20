import { expect, mock, test } from 'claude-code/testing'

const ID = 'abc12345-0000-0000-0000-000000000000'
const ROOT = '/h/.claude/session-state'
const FOLDER = `${ROOT}/demo/2026-10-17_abc12345`
const STATE = `${FOLDER}/state.md`
const STEPS = `${FOLDER}/steps.md`
const EVENTS = `${FOLDER}/events.jsonl`

const USAGE = { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type TestDollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never

const PANE_PROPS = {
  title: 'Session ledger',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as never

const NOW = Date.UTC(2026, 9, 17, 8, 0, 0)

// An engine whose files live in a map, whose Jev answers `p`, and whose Haiku answers from a script.
const world = (on: TestOn, p: number, replies: object[], cwdOf: () => string = () => '/work/demo') => {
  const files = new Map<string, string>()
  const calls = { jev: 0, haiku: 0, efforts: [] as string[], contexts: [] as (readonly string[] | undefined)[] }
  mock.env(on, { HOME: '/h', OPENROUTER_API_KEY: 'test-key' })
  on('session.id', () => ({ value: ID }) as never)
  on('session.cwd', () => ({ value: cwdOf() }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', () => ({ cwd: '/work/demo' }) as never)
  on('prompt.submit', (_$, e) => {
    calls.contexts.push(e.context)
    return { text: e.text } as never
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', (_$, e) => {
    const tool = (e as { tool: string }).tool
    if (tool === 'Bash') return { isError: true, result: 'x', text: 'Error: exit 1\nENOENT: no such file' } as never
    if (tool === 'AskUserQuestion') return { result: 'Your questions have been answered: "Which store?"="SQLite, the file one". You can now continue.' } as never
    return { result: 'ok', text: 'ok' } as never
  })
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }) as never)
  on('prompt.compose', () => ({ sections: [] }) as never)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.read', (_$, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'no such file' }) as never)
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  // The direct children of a folder: files, and folders that hold some file.
  on('fs.list', (_$, e) => {
    const base = `${(e as { path: string }).path}/`
    const seen = new Map<string, string>()
    for (const path of files.keys()) {
      if (!path.startsWith(base)) continue
      const rest = path.slice(base.length)
      const name = rest.split('/')[0]!
      seen.set(name, rest.includes('/') ? 'dir' : 'file')
    }
    return { value: [...seen].map(([name, kind]) => ({ name, kind })) } as never
  })
  on('http.fetch', () => {
    calls.jev += 1
    const body = { model: 'typesafe/jev-1.14-x', answers: { important: { type: 'noul', noul: p } }, usage: { input_tokens: 356, output_tokens: 20, cost: 0.000015 } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('model.complete', (_$, e) => {
    calls.efforts.push(String((e as { effort?: string }).effort))
    const next = replies[calls.haiku++] ?? { step: { text: 'Answered.', outcome: 'ok' }, memories: [] }
    return { value: { isAnswered: true, text: JSON.stringify(next), usage: USAGE } } as never
  })
  return { files, calls }
}

const say = async ($: TestDollar, text: string, answer: string, n: number) => {
  await $.prompt.submit({ text } as never)
  await $.turn.start({ text, turnId: `t${n}` } as never)
  await $.turn.complete({ turnId: `t${n}`, answer, durationMs: 10, isAborted: false } as never)
}

const settle = async (clock: { advance: (ms: number) => Promise<void> }, files: Map<string, string>, until: (f: Map<string, string>) => boolean) => {
  for (let i = 0; i < 30 && !until(files); i++) await clock.advance(10)
}

const textOf = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

const mountPane = ($: TestDollar) =>
  $.ui.mount({ plugin: 'session-state', surface: 'terminal', component: 'Pane', requestId: 'session-state', props: PANE_PROPS } as never)

const SQLITE = {
  title: 'Storage choice',
  step: { text: 'Switched storage to SQLite.', outcome: 'ok' },
  memories: [{ kind: 'decision', text: 'Use SQLite for storage.', why: 'No server to run.', context: '', quote: 'use SQLite', refers_to: [], supersedes: [] }],
}

test('a decision above the gate lands in the session folder: state, step, archive and index', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, calls } = world(on, 0.95, [SQLITE])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))

  const md = files.get(STATE) ?? ''
  expect(md).toContain('### M-001 · decision · t1\nUse SQLite for storage.\nWhy: No server to run.\nQuote: "use SQLite"')
  expect(md).toContain('session_id: abc12345-0000-0000-0000-000000000000')
  expect(md).toContain('# Storage choice')
  expect(files.get(STEPS) ?? '').toContain('- t1 · ✓ · Switched storage to SQLite. · +M-001')
  const events = files.get(EVENTS) ?? ''
  expect(events).toContain('"type":"turn"')
  expect(events).toContain('"mode":"extract"')
  expect(files.get(`${ROOT}/demo/INDEX.md`) ?? '').toContain('2026-10-17_abc12345/state.md')
  expect(calls.jev).toBe(1)
  expect(calls.haiku).toBe(1)
  expect(calls.efforts).toEqual(['high'])

  const ui = await mountPane($)
  expect(await textOf(ui)).toContain('t1 · ✓ · Switched storage to SQLite.')
  await $.command.run({ command: 'session-state', args: 'ledger' } as never)
  await ui.redraw()
  const ledger = JSON.stringify(await ui.findAll({ type: 'Markdown' } as never))
  expect(ledger).toContain('Use SQLite for storage.')
  expect(ledger.includes('session_id:')).toBe(false)
  await $.command.run({ command: 'session-state', args: 'stats' } as never)
  await ui.redraw()
  const stats = await textOf(ui)
  expect(stats).toContain('0 open asks · 1 decisions and rules')
  expect(stats).toContain('jev-1.14')
})

test('a turn below the gate gets a low-effort step line and no note', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, calls } = world(on, 0.1, [{ step: { text: 'Ran the tests; all pass.', outcome: 'ok' }, memories: [] }])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'run the tests', 'All pass.', 1)
  await settle(clock, files, f => f.has(STEPS))

  expect(files.get(STEPS) ?? '').toContain('- t1 · ✓ · Ran the tests; all pass.')
  expect(files.get(STATE) ?? '').toContain('## Open asks\n_None._')
  expect(files.get(EVENTS) ?? '').toContain('"action":"skip"')
  expect(calls.efforts).toEqual(['low'])
})

test('the main agent\'s tool calls become the turn facts; a subagent\'s do not', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.1, [])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await $.prompt.submit({ text: 'fix the parser' } as never)
  await $.turn.start({ text: 'fix the parser', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/work/demo/core/parse.ts', old_string: 'a', new_string: 'b', tool_use_id: 'u1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'bun test', tool_use_id: 'u2' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/work/demo/other.ts', old_string: 'a', new_string: 'b', tool_use_id: 'u3', agentId: 'sub1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Fixed.', durationMs: 10, isAborted: false } as never)
  await settle(clock, files, f => f.has(STEPS))

  const step = files.get(STEPS) ?? ''
  expect(step).toContain('edited core/parse.ts · 1 command, 1 failed')
  expect(step.includes('other.ts')).toBe(false)
  expect(files.get(EVENTS) ?? '').toContain('ENOENT: no such file')
  expect(files.get(STATE) ?? '').toContain('- `core/parse.ts` · edited 1 · t1')
})

test('after Claude Code compacts, the next typed prompt carries the ledger digest, once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, calls } = world(on, 0.95, [SQLITE])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  const compacted = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(compacted.skip).toBe(undefined)

  await $.prompt.submit({ text: 'what next?' } as never)
  await $.prompt.submit({ text: 'and then?' } as never)
  const [, withDigest, after] = calls.contexts
  expect(withDigest?.length).toBe(1)
  expect(withDigest?.[0]).toContain('The chat was just compacted.')
  expect(withDigest?.[0]).toContain('M-001 (t1) Use SQLite for storage.')
  expect(withDigest?.[0]).toContain(`Full ledger: ${FOLDER}/state.md`)
  expect(after ?? []).toEqual([])
})

test('a paused session records nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, calls } = world(on, 0.95, [])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  const paused = await $.command.run({ command: 'session-state', args: 'pause' } as never)
  expect(JSON.stringify(paused)).toContain('paused')
  await say($, 'use SQLite', 'ok', 1)
  await clock.advance(50)

  expect(files.size).toBe(0)
  expect([calls.jev, calls.haiku]).toEqual([0, 0])
})

test('the system prompt tells the agent where the ledger is, the same text on every request', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on, 0.95, [])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  const first = await $.prompt.compose(COMPOSE)
  const second = await $.prompt.compose(COMPOSE)
  const section = first.sections.find(s => s.id === 'session-state:ledger')

  expect(section?.scope).toBe('session')
  expect(section?.text).toContain(`${FOLDER}/`)
  expect(JSON.stringify(second)).toBe(JSON.stringify(first))
})

test('the rules the user gave are pinned in the system prompt next to the pointer', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files } = world(on, 0.95, [])
  files.set(
    STATE,
    '---\nsession_id: x\nnext_id: 3\n---\n# T\n## Open asks\n### M-002 · ask · t2\nRename the video.\n\n## Decisions and rules\n### M-001 · requirement · t1\nNever use Opus as a subagent.\n',
  )

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  const out = await $.prompt.compose(COMPOSE)
  const rules = out.sections.find(s => s.id === 'session-state:rules')

  expect(rules?.text).toContain('- Never use Opus as a subagent.')
  expect(rules?.text.includes('Rename the video')).toBe(false)
})

test('an old notes file seeds the new folder once and is left as it was', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.1, [])
  const OLD = `${ROOT}/demo/2026-10-16_abc12345.md`
  const old = '---\nsession_id: x\ntitle: Video work\nnext_id: 3\n---\n# Video work\n- ~~M-001 · t1 · decision · Use Postgres.~~ → superseded by M-002\n- M-002 · t2 · requirement · Keep answers short.\n'
  files.set(OLD, old)

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'hi', 'hello', 3)
  await settle(clock, files, f => f.has(STEPS))

  const md = files.get(`${ROOT}/demo/2026-10-17_abc12345/state.md`) ?? ''
  expect(md).toContain('# Video work')
  expect(md).toContain('### M-002 · requirement · t2\nKeep answers short.')
  expect(md.includes('Use Postgres')).toBe(false)
  expect(files.get(OLD)).toBe(old)
})

test('entering a worktree mid-chat does not change the project, folder or transcript of the ledger', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let cwd = '/work/demo'
  const { files } = world(on, 0.95, [SQLITE], () => cwd)

  await $.session.start({ cwd, surface: 'terminal' } as never)
  await $.prompt.compose(COMPOSE)
  cwd = '/work/demo/.local/worktrees'
  await say($, 'use SQLite', 'ok', 1)
  await settle(clock, files, f => f.has(STEPS))

  const md = files.get(STATE) ?? ''
  expect(md).toContain('project: demo')
  expect(md).toContain('cwd: /work/demo\n')
  expect(md).toContain('/.claude/projects/-work-demo/')
})

const TRANSCRIPT = `/h/.claude/projects/-work-demo/${ID}.jsonl`
const typed = (uuid: string, text: string) => JSON.stringify({ type: 'user', uuid, message: { content: text } })
const replied = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

test('a chat met mid-way is read back from its transcript, so steps and turn numbers start at the beginning', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, calls } = world(on, 0.1, [
    { title: 'Storage', step: { text: 'Chose SQLite.', outcome: 'ok' }, memories: [] },
    { step: { text: 'Ran the tests.', outcome: 'ok' }, memories: [] },
    { step: { text: 'Wrote the docs.', outcome: 'ok' }, memories: [] },
  ])
  files.set(TRANSCRIPT, [typed('u1', 'pick a store'), replied('SQLite.'), typed('u2', 'run the tests'), replied('All pass.'), typed('u3', 'still typing')].join('\n'))
  files.set(`${ROOT}/demo/2026-10-16_abc12345.md`, '---\nsession_id: x\nnext_id: 2\n---\n# Old\n- M-001 · t1 · ask · Pick a store.\n')

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t2'))
  await say($, 'write the docs', 'Done.', 3)
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t3'))

  const lines = (files.get(STEPS) ?? '').split('\n').filter(l => l.startsWith('- t'))
  expect(lines.map(l => l.split(' · ')[0])).toEqual(['- t1', '- t2', '- t3'])
  expect(lines[0]).toContain('Chose SQLite.')
  expect(files.get(STATE) ?? '').toContain('# Storage')
  expect((files.get(STATE) ?? '').includes('Pick a store.')).toBe(false)
  expect(files.get(EVENTS) ?? '').toContain('"turnId":"u2"')
  expect((files.get(EVENTS) ?? '').includes('still typing')).toBe(false)
  expect(calls.haiku).toBe(3)
})

test('a chat that Claude Code continues under a new session id after a compaction keeps its ledger', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.1, [{ step: { text: 'Wrote the docs.', outcome: 'ok' }, memories: [] }])
  const OLD = `${ROOT}/demo/2026-10-16_old00001`
  files.set(`${OLD}/state.md`, '---\nsession_id: old00001-0000\nproject: demo\ncwd: /work/demo\nstarted: 2026-10-16\ntranscript: ~/.claude/projects/-work-demo/old00001-0000.jsonl\nresume: claude --resume old00001-0000\ntitle: Storage\nnext_id: 2\nnext_learning: 1\n---\n# Storage\n\n## Decisions and rules\n### M-001 · decision · t1\nUse SQLite for storage.\nWhy: No server to run.\nQuote: "use SQLite"\nSource: t1 · turn u1\n')
  files.set(`${OLD}/steps.md`, '# Steps\n- t1 · ✓ · Chose SQLite. · +M-001\n')
  files.set(`${OLD}/events.jsonl`, `${JSON.stringify({ type: 'turn', at: 1, turn: 1, turnId: 'u1', user: 'use SQLite', answer: 'Done.', facts: {} })}\n`)
  files.set('/h/.claude/projects/-work-demo/old00001-0000.jsonl', `${typed('u1', 'use SQLite')}\n${replied('Done.')}\n${JSON.stringify({ type: 'assistant', uuid: 'last-of-old' })}`)
  files.set(TRANSCRIPT, JSON.stringify({ type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'last-of-old' }))

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await $.prompt.compose(COMPOSE)
  await say($, 'write the docs', 'Done.', 2)
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t2'))

  const md = files.get(STATE) ?? ''
  expect(md).toContain('Use SQLite for storage.')
  expect(md).toContain(`session_id: ${ID}`)
  expect(md).toContain(`resume: claude --resume ${ID}`)
  expect((files.get(STEPS) ?? '').split('\n').filter(l => l.startsWith('- t')).map(l => l.split(' · ')[0])).toEqual(['- t1', '- t2'])
  expect(files.get(`${OLD}/state.md`) ?? '').toContain('session_id: old00001-0000')
})

test('what the user picks in the agent\'s questions counts as their words', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const note = { step: { text: 'Chose the store.', outcome: 'ok' }, memories: [{ kind: 'decision', text: 'Use SQLite for storage.', why: '', context: '', quote: 'SQLite, the file one', refers_to: [], supersedes: [] }] }
  const { files } = world(on, 0.95, [note])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await $.prompt.submit({ text: 'set up storage' } as never)
  await $.turn.start({ text: 'set up storage', turnId: 't1' } as never)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'q1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Using SQLite.', durationMs: 10, isAborted: false } as never)
  await settle(clock, files, f => f.has(STEPS))

  expect(files.get(STATE) ?? '').toContain('Quote: "SQLite, the file one"')
  expect(files.get(EVENTS) ?? '').toContain('Which store? → SQLite, the file one')
})

test('rebuild sets the current files aside and reads the whole chat back from the transcript', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.1, [
    { step: { text: 'Live turn seen late.', outcome: 'ok' }, memories: [] },
    { step: { text: 'Chose SQLite.', outcome: 'ok' }, memories: [] },
    { step: { text: 'Ran the tests.', outcome: 'ok' }, memories: [] },
  ])
  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'run the tests', 'All pass.', 1)
  await settle(clock, files, f => f.has(STEPS))
  files.set(TRANSCRIPT, [typed('u1', 'pick a store'), replied('SQLite.'), typed('u2', 'run the tests'), replied('All pass.')].join('\n'))

  const out = await $.command.run({ command: 'session-state', args: 'rebuild' } as never)
  expect(JSON.stringify(out)).toContain('2 turns queued')
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t2'))

  const lines = (files.get(STEPS) ?? '').split('\n').filter(l => l.startsWith('- t'))
  expect(lines).toEqual(['- t1 · ✓ · Chose SQLite.', '- t2 · ✓ · Ran the tests.'])
  expect(files.get(`${FOLDER}/before-rebuild/steps.md`) ?? '').toContain('Live turn seen late.')
})
