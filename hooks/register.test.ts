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
const world = (on: TestOn, p: number, replies: object[], cwdOf: () => string = () => '/work/demo', idOf: () => string = () => ID) => {
  const files = new Map<string, string>()
  const calls = { jev: 0, haiku: 0, efforts: [] as string[], contexts: [] as (readonly string[] | undefined)[], isDropping: false }
  mock.env(on, { HOME: '/h', OPENROUTER_API_KEY: 'test-key' })
  on('session.id', () => ({ value: idOf() }) as never)
  on('session.cwd', () => ({ value: cwdOf() }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', () => ({ cwd: '/work/demo' }) as never)
  on('prompt.submit', (_$, e) => {
    calls.contexts.push(e.context)
    return (calls.isDropping ? { drop: 'blocked' } : { text: e.text }) as never
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

// ---- what the agent is told after a compaction

const NEW_ID = 'def67890-0000-0000-0000-000000000000'
const NEW_FOLDER = `${ROOT}/demo/2026-10-17_def67890`
const COMPACT = { trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never

// Claude Code carries the chat on under NEW_ID: the old transcript ends at `last-of-old`, the new one opens
// with a compaction boundary that points back at it.
const carryOn = (files: Map<string, string>) => {
  files.set(TRANSCRIPT, [typed('u1', 'Please use SQLite from now on.'), replied('Switched.'), JSON.stringify({ type: 'assistant', uuid: 'last-of-old' })].join('\n'))
  files.set(`/h/.claude/projects/-work-demo/${NEW_ID}.jsonl`, JSON.stringify({ type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'last-of-old' }))
}

// A chat with one recorded decision (M-001), ready to be compacted.
const recorded = async ($: TestDollar, on: TestOn, idOf: () => string = () => ID) => {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on, 0.95, [SQLITE], () => '/work/demo', idOf)
  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, w.files, f => f.has(STEPS))
  return { clock, ...w }
}

const digestOn = (contexts: (readonly string[] | undefined)[], at = -1): string | undefined => contexts.at(at)?.[0]

const ORDERS = [
  ['the compaction comes first and the new id boots at the next typed prompt', false, false],
  ['the compaction comes first and a request is composed under the new id before the next typed prompt', true, false],
  ['the id moves and boots first, the compaction is noted after it', true, true],
] as const

for (const [name, composes, isIdFirst] of ORDERS) {
  test(`the digest survives a compaction that moves the chat to a new session id: ${name}`, async ($, on) => {
    let id = ID
    const { files, calls } = await recorded($, on, () => id)
    carryOn(files)
    if (isIdFirst) id = NEW_ID
    if (isIdFirst) await $.prompt.compose(COMPOSE)
    await $.session.compact(COMPACT)
    if (!isIdFirst) id = NEW_ID
    if (composes && !isIdFirst) await $.prompt.compose(COMPOSE)
    await $.prompt.submit({ text: 'what next?' } as never)
    await $.prompt.submit({ text: 'and then?' } as never)

    const [withDigest, after] = calls.contexts.slice(-2)
    expect(withDigest?.[0]).toContain('M-001 (t1) Use SQLite for storage.')
    expect(withDigest?.[0]).toContain(`Full ledger: ${NEW_FOLDER}/state.md`)
    expect(after ?? []).toEqual([])
  })
}

test('a compaction that keeps the session id still hands over the digest after the session is booted again', async ($, on) => {
  const { files, calls } = await recorded($, on)
  await $.session.compact(COMPACT)
  // The person rebuilds the ledger before typing: the agent has still not been told.
  files.set(TRANSCRIPT, [typed('u1', 'Please use SQLite from now on.'), replied('Switched.')].join('\n'))
  await $.command.run({ command: 'session-state', args: 'rebuild' } as never)
  await $.prompt.submit({ text: 'what next?' } as never)

  expect(digestOn(calls.contexts)).toContain('The chat was just compacted.')
})

test('a turn that a compaction moved to a new session id is still recorded', async ($, on) => {
  let id = ID
  const { clock, files } = await recorded($, on, () => id)
  carryOn(files)
  await $.prompt.submit({ text: 'now add an index' } as never)
  await $.turn.start({ text: 'now add an index', turnId: 't2' } as never)
  await $.session.compact(COMPACT)
  id = NEW_ID
  await $.prompt.compose(COMPOSE)
  await $.turn.complete({ turnId: 't2', answer: 'Added.', durationMs: 10, isAborted: false } as never)
  await settle(clock, files, f => (f.get(`${NEW_FOLDER}/steps.md`) ?? '').includes('- t2'))

  expect(files.get(`${NEW_FOLDER}/steps.md`) ?? '').toContain('- t2')
})

test('a typed prompt that something beneath drops does not use up the digest', async ($, on) => {
  const { calls } = await recorded($, on)
  await $.session.compact(COMPACT)
  calls.isDropping = true
  const dropped = await $.prompt.submit({ text: 'what next?' } as never)
  calls.isDropping = false
  await $.prompt.submit({ text: 'what next, again?' } as never)

  expect(dropped.drop).toBe('blocked')
  expect(digestOn(calls.contexts)).toContain('The chat was just compacted.')
})

test('a typed prompt that something beneath drops is not recorded as something the person asked', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, calls } = world(on, 0.1, [])
  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  calls.isDropping = true
  await $.prompt.submit({ text: 'my password is hunter2, remember it' } as never)
  calls.isDropping = false
  await say($, 'run the tests', 'All pass.', 1)
  await settle(clock, files, f => f.has(STEPS))

  expect(files.get(EVENTS) ?? '').toContain('run the tests')
  expect((files.get(EVENTS) ?? '').includes('hunter2')).toBe(false)
})

test('a digest made while turns are still being recorded says so and carries their messages', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, calls } = world(on, 0.95, [SQLITE])
  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await $.session.compact(COMPACT)
  await $.prompt.submit({ text: 'what next?' } as never)

  const digest = digestOn(calls.contexts) ?? ''
  expect(digest).toContain('still being recorded')
  expect(digest).toContain('t1: Please use SQLite from now on.')
  expect(digest.length).toBeLessThanOrEqual(8000)
  await settle(clock, files, f => f.has(STEPS))
})

test('a digest has nothing to say about an empty ledger and is not sent', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { calls } = world(on, 0.95, [])
  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await $.session.compact(COMPACT)
  await $.prompt.submit({ text: 'what next?' } as never)

  expect(calls.contexts.at(-1) ?? []).toEqual([])
})

test('the digest command prints what the next prompt would carry', async ($, on) => {
  const { calls } = await recorded($, on)
  await $.session.compact(COMPACT)
  const printed = await $.command.run({ command: 'session-state', args: 'digest' } as never)
  await $.prompt.submit({ text: 'what next?' } as never)

  expect(JSON.stringify(printed)).toContain(JSON.stringify(digestOn(calls.contexts)).slice(1, -1))
})

// ---- how big the digest gets, and what is in it

const pad = (n: number) => String(n).padStart(3, '0')
const noteMd = (i: number, kind: string, text: string, why: string, quote: string) =>
  `### M-${pad(i)} · ${kind} · t${i}\n${text}\nWhy: ${why}\nQuote: "${quote}"\nSource: t${i} · turn u${i}\n`
const stateMd = (notes: string[], learnings: string[] = []) =>
  `---\nsession_id: x\nproject: demo\ncwd: /work/demo\nnext_id: ${notes.length + 1}\nnext_learning: ${learnings.length + 1}\n---\n# Big chat\n\n## Decisions and rules\n${notes.join('\n')}\n## Learnings\n${learnings.join('\n')}`
const learnMd = (i: number, text: string) => `### L-${pad(i)} · failed · t${i}\n${text}\nEvidence: "boom"\n`
const turnLine = (turn: number, edited: string[]) => JSON.stringify({ type: 'turn', at: turn, turn, turnId: `u${turn}`, user: 'work', answer: 'ok', facts: { read: [], edited, commands: 0, failures: [], commits: [] } })

// A compacted chat whose ledger files are as given, and the digest its next typed prompt carries.
const digestFor = async ($: TestDollar, on: TestOn, md: string, eventsText = '') => {
  mock.clock(on, { now: NOW })
  const { files, calls } = world(on, 0.95, [])
  files.set(STATE, md)
  if (eventsText !== '') files.set(EVENTS, eventsText)
  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await $.session.compact(COMPACT)
  await $.prompt.submit({ text: 'what next?' } as never)
  return digestOn(calls.contexts) ?? ''
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

test('hundreds of notes, learnings and files still give a digest under 8,000 characters that ends with the path', async ($, on) => {
  const notes = Array.from({ length: 300 }, (_, i) =>
    noteMd(i + 1, i < 10 ? 'ask' : ['decision', 'requirement'][i % 2]!, `Note number ${i + 1} about the parser and its tests.`, 'Because the user said so, and it keeps the build green.', `quote ${i + 1} from the user, word for word`),
  )
  const learnings = Array.from({ length: 80 }, (_, i) => learnMd(i + 1, `Learning number ${i + 1}: the command fails when the cache is cold.`))
  const events = Array.from({ length: 60 }, (_, i) => turnLine(i + 1, [`/work/demo/src/${'deep/'.repeat(20)}file${i}.ts`])).join('\n')
  const digest = await digestFor($, on, stateMd(notes, learnings), events)

  expect(digest.length).toBeLessThanOrEqual(8000)
  expect(digest).toContain('(cut to fit; the rest is in state.md)')
  expect(digest.endsWith(`Full ledger: ${FOLDER}/state.md (steps.md has every turn).`)).toBe(true)
  expect(digest).toContain('M-001 (t1) Note number 1')
  expect(digest.indexOf('## Open asks')).toBeLessThan(digest.indexOf('## Decisions and rules'))
  // No heading stands alone, with its items all cut.
  expect(/## [^\n]*\n(\n## |\(cut to fit)/.test(digest)).toBe(false)
})

test('one very long note cannot use up the digest: the notes after it are still there', async ($, on) => {
  const long = 'word '.repeat(2000).trim()
  const notes = [
    noteMd(1, 'ask', 'Port the whole spec.', long, long),
    ...Array.from({ length: 12 }, (_, i) => noteMd(i + 2, 'ask', `Ask number ${i + 2}.`, 'short reason', 'short quote')),
  ]
  const digest = await digestFor($, on, stateMd(notes))

  expect(digest.length).toBeLessThanOrEqual(8000)
  expect(digest).toContain('M-001 (t1) Port the whole spec.')
  expect(digest).toContain('M-013 (t13) Ask number 13.')
  expect(digest.includes('(cut to fit')).toBe(false)
  expect(digest).toMatch(/User: "[^"\n]+…"/)
})

test('a digest never cuts a surrogate pair or leaves a code fence open', async ($, on) => {
  const emoji = '😀'.repeat(3000)
  const fenced = `use this: ${'```js const a = 1 ``` and '.repeat(40)} then keep going`
  const notes = [noteMd(1, 'ask', 'Emoji ask.', emoji, emoji), noteMd(2, 'requirement', 'Fenced rule.', fenced, fenced), noteMd(3, 'ask', 'Plain ask.', 'why', 'quote')]
  const digest = await digestFor($, on, stateMd(notes))

  expect(LONE_SURROGATE.test(digest)).toBe(false)
  expect(((digest.match(/```/g) ?? []).length) % 2).toBe(0)
  expect(digest).toContain('M-003 (t3) Plain ask.')
})

test('the digest lists only what is true now: replaced and finished items are in history, not in it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const memory = (kind: string, text: string, quote: string, supersedes: number[] = []) => ({ kind, text, why: '', context: '', quote, refers_to: [], supersedes })
  const { files, calls } = world(on, 0.95, [
    { step: { text: 'Chose SQLite.', outcome: 'ok' }, memories: [memory('decision', 'Use SQLite.', 'use SQLite'), memory('ask', 'Rename the video.', 'rename the video')] },
    { step: { text: 'Chose Postgres, renamed it.', outcome: 'ok' }, done: [2], memories: [memory('decision', 'Use Postgres.', 'use Postgres', [1])] },
  ])
  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'use SQLite and rename the video', 'ok', 1)
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t1'))
  await say($, 'actually use Postgres', 'ok', 2)
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t2'))
  await $.session.compact(COMPACT)
  await $.prompt.submit({ text: 'what next?' } as never)

  const digest = digestOn(calls.contexts) ?? ''
  expect(digest).toContain('M-003 (t2) Use Postgres.')
  expect(digest.includes('Use SQLite')).toBe(false)
  expect(digest.includes('Rename the video')).toBe(false)
  expect(files.get(`${FOLDER}/history.md`) ?? '').toContain('Use SQLite.')
})

// ---- what the system prompt carries

const said = (kind: string, text: string, quote: string) => ({
  step: { text: 'Recorded.', outcome: 'ok' },
  memories: [{ kind, text, why: '', context: '', quote, refers_to: [], supersedes: [] }],
})

test('a /clear after a compaction starts a new chat with no digest', async ($, on) => {
  let id = ID
  const { files, calls } = await recorded($, on, () => id)
  await $.session.compact(COMPACT)
  id = NEW_ID
  files.set(`/h/.claude/projects/-work-demo/${NEW_ID}.jsonl`, '')
  await $.prompt.submit({ text: 'a fresh start' } as never)

  expect(calls.contexts.at(-1) ?? []).toEqual([])
  expect(files.get(`${NEW_FOLDER}/state.md`) ?? '').toBe('')
})

test('compactions that move the chat to a new id twice in a row, composing a request between them, still hand over the digest', async ($, on) => {
  let id = ID
  const { files, calls } = await recorded($, on, () => id)
  const THIRD = 'fed09876-0000-0000-0000-000000000000'
  carryOn(files)
  await $.session.compact(COMPACT)
  id = NEW_ID
  await $.prompt.compose(COMPOSE)
  files.set(`/h/.claude/projects/-work-demo/${NEW_ID}.jsonl`, [JSON.stringify({ type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'last-of-old' }), JSON.stringify({ type: 'assistant', uuid: 'last-of-second' })].join('\n'))
  files.set(`/h/.claude/projects/-work-demo/${THIRD}.jsonl`, JSON.stringify({ type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'last-of-second' }))
  await $.session.compact(COMPACT)
  id = THIRD
  await $.prompt.submit({ text: 'what next?' } as never)

  expect(digestOn(calls.contexts)).toContain('M-001 (t1) Use SQLite for storage.')
})
