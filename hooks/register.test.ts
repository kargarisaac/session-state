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

// $.fs.read rejects a file over 4 MiB, as the engine does.
const READ_CAP = 4 * 1024 * 1024

// An engine whose files live in a map, whose Jev answers `p`, and whose Haiku answers from a script. The session
// id and directory are read at each call, so a test can move the chat to a new id or into a worktree.
const world = (
  on: TestOn,
  p: number,
  replies: object[],
  cwdOf: () => string = () => '/work/demo',
  idOf: () => string = () => ID,
  // How long each Haiku reply takes, on the test's clock.
  hold: () => Promise<void> = async () => {},
) => {
  const files = new Map<string, string>()
  const calls = { jev: 0, haiku: 0, efforts: [] as string[], contexts: [] as (readonly string[] | undefined)[] }
  // A read of a path waits for its hold and then answers what the file held when it was asked; Haiku waits for its
  // hold, and fails its next `fails` calls.
  const holds = { reads: new Map<string, Promise<void>>(), haiku: undefined as Promise<void> | undefined, fails: 0 }
  mock.env(on, { HOME: '/h', OPENROUTER_API_KEY: 'test-key' })
  on('session.id', () => ({ value: idOf() }) as never)
  on('session.cwd', () => ({ value: cwdOf() }) as never)
  on('command.register', () => ({ value: {} }) as never)
  on('session.start', () => ({ cwd: '/work/demo' }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
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
  on('ui.close', () => ({ value: undefined }) as never)
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    const hold = holds.reads.get(e.path)
    holds.reads.delete(e.path)
    await hold
    return (text !== undefined && text.length <= READ_CAP ? { value: text } : { deny: 'missing, or over 4 MiB' }) as never
  })
  // A write stamps the file with the next number, standing for its modification time.
  const written = new Map<string, number>()
  let tick = 0
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    written.set(e.path, ++tick)
    return { value: undefined } as never
  })
  on('fs.stat', (_$, e) => (files.has(e.path) ? { value: { kind: 'file', size: files.get(e.path)!.length, mtimeMs: written.get(e.path) ?? 0, isLink: false } } : { deny: 'ENOENT' }) as never)
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
  on('model.complete', async (_$, e) => {
    await hold()
    calls.efforts.push(String((e as { effort?: string }).effort))
    await holds.haiku
    if (holds.fails > 0) {
      holds.fails -= 1
      return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } } as never
    }
    const next = replies[calls.haiku++] ?? { step: { text: 'Answered.', outcome: 'ok' }, memories: [] }
    return { value: { isAnswered: true, text: JSON.stringify(next), usage: USAGE } } as never
  })
  return { files, calls, written, holds }
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

const CHILD = 'new00002-0000-0000-0000-000000000000'
const PROJECT = '/h/.claude/projects/-work-demo'
const CHILD_DIR = `${ROOT}/demo/2026-10-17_new00002`
const OLD_DIR = `${ROOT}/demo/2026-10-16_old00001`
const SUMMARY = [{ role: 'user', text: 'summary', toolUses: [] }]
const last = (uuid: string) => JSON.stringify({ type: 'assistant', uuid })
const boundary = (uuid: string) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', logicalParentUuid: uuid })
const turnsOf = (steps: string | undefined) => (steps ?? '').split('\n').filter(l => l.startsWith('- t')).map(l => l.split(' · ')[0])

// A ledger folder as the mod leaves it: the front matter points at the session's transcript.
const ledgerOf = (id: string, note: string) =>
  `---\nsession_id: ${id}\nproject: demo\ncwd: /work/demo\nstarted: 2026-10-16\ntranscript: ~/.claude/projects/-work-demo/${id}.jsonl\nresume: claude --resume ${id}\ntitle: Storage\nnext_id: 2\nnext_learning: 1\n---\n# Storage\n\n## Decisions and rules\n### M-001 · decision · t1\n${note}\nSource: t1 · turn u1\n`

// The chat's old session has run turn 1 and ends in `last-of-old`; Claude Code compacts it and carries on under CHILD,
// whose transcript opens with a compact boundary that points back at that message.
const compactToNewId = async ($: TestDollar, files: Map<string, string>, moveTo: () => void, oldTranscript = last('last-of-old')) => {
  files.set(`${PROJECT}/${ID}.jsonl`, oldTranscript)
  await $.session.compact({ trigger: 'auto', messages: SUMMARY } as never)
  moveTo()
  files.set(`${PROJECT}/${CHILD}.jsonl`, boundary('last-of-old'))
}

test('after a compaction that moved the chat to a new session id, the next prompt still carries the digest', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let id = ID
  const { files, calls } = world(on, 0.95, [SQLITE], () => '/work/demo', () => id)

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  await compactToNewId($, files, () => (id = CHILD))
  await $.prompt.submit({ text: 'what next?' } as never)
  await $.prompt.submit({ text: 'and then?' } as never)

  const [digest, after] = calls.contexts.slice(-2)
  expect(digest?.[0]).toContain('The chat was just compacted.')
  expect(digest?.[0]).toContain('M-001 (t1) Use SQLite for storage.')
  expect(digest?.[0]).toContain(`Full ledger: ${CHILD_DIR}/state.md`)
  expect(after ?? []).toEqual([])
})

test('a turn that is running when the compaction moves the chat to a new session id is still recorded', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let id = ID
  const { files } = world(on, 0.1, [{ step: { text: 'Ran the tests.', outcome: 'ok' }, memories: [] }, { step: { text: 'Fixed the parser.', outcome: 'ok' }, memories: [] }], () => '/work/demo', () => id)

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'run the tests', 'All pass.', 1)
  await settle(clock, files, f => f.has(STEPS))
  await $.prompt.submit({ text: 'fix the parser' } as never)
  await $.turn.start({ text: 'fix the parser', turnId: 't2' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/work/demo/core/parse.ts', old_string: 'a', new_string: 'b', tool_use_id: 'u1' } as never)
  await compactToNewId($, files, () => (id = CHILD))
  // The next request of the same turn composes the system prompt under the new id.
  await $.prompt.compose(COMPOSE)
  await $.turn.complete({ turnId: 't2', answer: 'Fixed.', durationMs: 10, isAborted: false } as never)
  await settle(clock, files, f => (f.get(`${CHILD_DIR}/steps.md`) ?? '').includes('- t2'))

  const steps = files.get(`${CHILD_DIR}/steps.md`) ?? ''
  expect(turnsOf(steps)).toEqual(['- t1', '- t2'])
  expect(steps).toContain('Fixed the parser. · edited core/parse.ts')
  expect(files.get(`${CHILD_DIR}/events.jsonl`) ?? '').toContain('"user":"fix the parser"')
})

test('the ledger of a parent whose transcript is too big to read is still carried to the new session id', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let id = ID
  const { files } = world(on, 0.95, [SQLITE], () => '/work/demo', () => id)

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  await compactToNewId($, files, () => (id = CHILD), `${last('last-of-old')}\n${'x'.repeat(READ_CAP)}`)
  await $.prompt.compose(COMPOSE)

  expect(files.get(`${CHILD_DIR}/state.md`) ?? '').toContain('Use SQLite for storage.')
  expect(turnsOf(files.get(`${CHILD_DIR}/steps.md`))).toEqual(['- t1'])
})

test('a chat compacted inside a worktree continues in the project folder it started in', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let cwd = '/work/demo'
  let id = ID
  const { files } = world(on, 0.95, [SQLITE, { step: { text: 'Wrote the docs.', outcome: 'ok' }, memories: [] }], () => cwd, () => id)

  await $.session.start({ cwd, surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  cwd = '/work/demo/.local/worktrees'
  await compactToNewId($, files, () => (id = CHILD))
  await say($, 'write the docs', 'Done.', 2)
  await settle(clock, files, f => (f.get(`${CHILD_DIR}/steps.md`) ?? '').includes('- t2'))

  const md = files.get(`${CHILD_DIR}/state.md`) ?? ''
  expect(md).toContain('Use SQLite for storage.')
  expect(md).toContain(`transcript: ~/.claude/projects/-work-demo/${CHILD}.jsonl`)
  expect(turnsOf(files.get(`${CHILD_DIR}/steps.md`))).toEqual(['- t1', '- t2'])
})

test('a second child of the same parent copies the parent, not its sibling', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files, written } = world(on, 0.1, [])
  files.set(`${OLD_DIR}/state.md`, ledgerOf('old00001-0000', 'Use SQLite for storage.'))
  files.set(`${PROJECT}/old00001-0000.jsonl`, last('last-of-old'))
  // The sibling was written after the parent, and its transcript names the same message, as its parent.
  files.set(`${ROOT}/demo/2026-10-17_mid00002/state.md`, ledgerOf('mid00002-0000', 'Use Postgres for storage.'))
  files.set(`${PROJECT}/mid00002-0000.jsonl`, `${boundary('last-of-old')}\n${last('mid-message')}`)
  files.set(TRANSCRIPT, boundary('last-of-old'))
  written.set(`${OLD_DIR}/state.md`, 1)
  written.set(`${ROOT}/demo/2026-10-17_mid00002/state.md`, 2)

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)

  const md = files.get(STATE) ?? ''
  expect(md).toContain('Use SQLite for storage.')
  expect(md.includes('Postgres')).toBe(false)
})

test('a parent that started long before the newest twelve folders is found by when its ledger was written', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files, written } = world(on, 0.1, [])
  // Fifteen chats of the project started after the parent did, and were last written before its last turn.
  for (let i = 1; i <= 15; i++) {
    const path = `${ROOT}/demo/2026-10-${String(i).padStart(2, '0')}_chat${String(i).padStart(4, '0')}/state.md`
    files.set(path, ledgerOf(`chat${String(i).padStart(4, '0')}-0000`, 'Another chat.'))
    written.set(path, i)
  }
  files.set(`${ROOT}/demo/2026-09-01_old00001/state.md`, ledgerOf('old00001-0000', 'Use SQLite for storage.'))
  written.set(`${ROOT}/demo/2026-09-01_old00001/state.md`, 100)
  files.set(`${PROJECT}/old00001-0000.jsonl`, last('last-of-old'))
  files.set(TRANSCRIPT, boundary('last-of-old'))

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)

  expect(files.get(STATE) ?? '').toContain('Use SQLite for storage.')
})

test('a live turn is numbered after the copied steps when the parent kept no events', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.1, [{ step: { text: 'Added the tests.', outcome: 'ok' }, memories: [] }])
  files.set(`${OLD_DIR}/state.md`, ledgerOf('old00001-0000', 'Use SQLite for storage.'))
  files.set(`${OLD_DIR}/steps.md`, '# Steps\n- t1 · ✓ · Chose SQLite.\n- t2 · ✓ · Ran the tests.\n- t3 · ✓ · Fixed the parser.\n')
  files.set(`${PROJECT}/old00001-0000.jsonl`, last('last-of-old'))
  files.set(TRANSCRIPT, boundary('last-of-old'))

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'add the tests', 'Added.', 4)
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t4'))

  expect(turnsOf(files.get(STEPS))).toEqual(['- t1', '- t2', '- t3', '- t4'])
  expect(files.get(STEPS) ?? '').toContain('- t4 · ✓ · Added the tests.')
})

test('turns the new session already ran are numbered after the copied steps', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.1, [
    { step: { text: 'Wrote the docs.', outcome: 'ok' }, memories: [] },
    { step: { text: 'Added the tests.', outcome: 'ok' }, memories: [] },
  ])
  files.set(`${OLD_DIR}/state.md`, ledgerOf('old00001-0000', 'Use SQLite for storage.'))
  files.set(`${OLD_DIR}/steps.md`, '# Steps\n- t1 · ✓ · Chose SQLite.\n- t2 · ✓ · Ran the tests.\n- t3 · ✓ · Fixed the parser.\n')
  files.set(`${PROJECT}/old00001-0000.jsonl`, last('last-of-old'))
  // The new session already ran one turn before the mod met it.
  files.set(TRANSCRIPT, [boundary('last-of-old'), typed('u9', 'write the docs'), replied('Done.')].join('\n'))

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t4'))
  await say($, 'add the tests', 'Added.', 5)
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t5'))

  expect(turnsOf(files.get(STEPS))).toEqual(['- t1', '- t2', '- t3', '- t4', '- t5'])
  expect(files.get(STEPS) ?? '').toContain('- t4 · ✓ · Wrote the docs.')
  expect(files.get(STEPS) ?? '').toContain('- t5 · ✓ · Added the tests.')
})

// Haiku takes a while to write up a turn; the chat can move to a new session id while it does.
for (const ms of [2000, 5000]) {
  test(`a turn still being written up when the chat moves to a new session id lands in the new ledger once (${ms} ms)`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let id = ID
    let latency = 0
    const first = { step: { text: 'Ran the tests.', outcome: 'ok' }, memories: [] }
    const { files, calls } = world(on, 0.95, [first, SQLITE, SQLITE], () => '/work/demo', () => id, () => clock.sleep(latency))

    await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
    await say($, 'run the tests', 'All pass.', 1)
    await settle(clock, files, f => f.has(STEPS))
    latency = ms
    await say($, 'Please use SQLite from now on.', 'Switched.', 2)
    await clock.advance(500)
    await compactToNewId($, files, () => (id = CHILD))
    await $.prompt.submit({ text: 'what next?' } as never)
    await clock.advance(30000)

    const decisions = (files.get(`${CHILD_DIR}/state.md`) ?? '').split('\n').filter(l => l.startsWith('### M-'))
    expect(decisions).toEqual(['### M-001 · decision · t2'])
    expect(turnsOf(files.get(`${CHILD_DIR}/steps.md`))).toEqual(['- t1', '- t2'])
    expect((files.get(`${CHILD_DIR}/events.jsonl`) ?? '').split('\n').filter(l => l.includes('"type":"extract"') && l.includes('"turn":2'))).toHaveLength(1)
    expect(calls.haiku).toBeGreaterThanOrEqual(2)
  })
}

test('a /clear after a compaction starts an empty ledger and carries no digest', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let id = ID
  const { files, calls } = world(on, 0.95, [SQLITE], () => '/work/demo', () => id)

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  await $.session.compact({ trigger: 'auto', messages: SUMMARY } as never)
  await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } } as never)
  id = CHILD
  await $.prompt.submit({ text: 'a fresh start' } as never)

  expect(calls.contexts.at(-1) ?? []).toEqual([])
  expect(files.get(`${CHILD_DIR}/state.md`) ?? '').toBe('')
})

test('resuming an unrelated chat after a compaction does not take the ledger of the chat before it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let id = ID
  const { files, calls } = world(on, 0.95, [SQLITE], () => '/work/demo', () => id)

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  await $.session.compact({ trigger: 'auto', messages: SUMMARY } as never)
  id = CHILD
  files.set(`${PROJECT}/${CHILD}.jsonl`, [typed('r1', 'an old question'), replied('An old answer.')].join('\n'))
  await $.prompt.submit({ text: 'carry on' } as never)

  expect(files.get(`${CHILD_DIR}/state.md`) ?? '').toBe('')
  expect(calls.contexts.at(-1) ?? []).toEqual([])
})

test('rebuild leaves the ledger alone when the transcript has no turns to rebuild it from', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.1, [{ step: { text: 'Ran the tests.', outcome: 'ok' }, memories: [] }])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'run the tests', 'All pass.', 1)
  await settle(clock, files, f => f.has(STEPS))
  // Claude Code's transcript for this chat is over 4 MiB, which $.fs.read refuses.
  files.set(TRANSCRIPT, `${typed('u1', 'run the tests')}\n${'x'.repeat(READ_CAP)}`)

  const out = await $.command.run({ command: 'session-state', args: 'rebuild' } as never)

  expect(JSON.stringify(out)).toContain('No earlier turns')
  expect(files.get(STEPS) ?? '').toContain('- t1 · ✓ · Ran the tests.')
  expect(files.get(EVENTS) ?? '').toContain('"turnId":"t1"')
})

test('a boot that failed once is tried again by the next hook', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let isDown = true
  const { files } = world(on, 0.1, [{ step: { text: 'Ran the tests.', outcome: 'ok' }, memories: [] }], () => {
    if (isDown) throw new Error('no session yet')
    return '/work/demo'
  })

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  isDown = false
  await say($, 'run the tests', 'All pass.', 1)
  await settle(clock, files, f => f.has(STEPS))

  expect(files.get(STEPS) ?? '').toContain('- t1 · ✓ · Ran the tests.')
})

test('a child that restarts keeps its own ledger and does not copy its parent again', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files } = world(on, 0.1, [])
  files.set(`${OLD_DIR}/state.md`, ledgerOf('old00001-0000', 'Use SQLite for storage.'))
  files.set(`${PROJECT}/old00001-0000.jsonl`, last('last-of-old'))
  // The child went on after the copy: its ledger has a note the parent's does not.
  const own = `${ledgerOf(ID, 'Use SQLite for storage.')}\n### M-002 · decision · t2\nKeep answers short.\nSource: t2 · turn u2\n`
  files.set(STATE, own)
  files.set(TRANSCRIPT, boundary('last-of-old'))

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  const ui = await mountPane($)
  await $.command.run({ command: 'session-state', args: 'ledger' } as never)
  await ui.redraw()

  expect(files.get(STATE)).toBe(own)
  expect(JSON.stringify(await ui.findAll({ type: 'Markdown' } as never))).toContain('Keep answers short.')
})

const SHORT = {
  step: { text: 'Kept answers short.', outcome: 'ok' },
  memories: [{ kind: 'decision', text: 'Keep answers short.', why: '', context: '', quote: 'keep answers short', refers_to: [], supersedes: [] }],
}

test('a chat compacted twice in one process carries the ledger of the newest session, with all its notes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const THIRD = 'thr00003-0000-0000-0000-000000000000'
  const THIRD_DIR = `${ROOT}/demo/2026-10-17_thr00003`
  let id = ID
  const { files } = world(on, 0.95, [SQLITE, SHORT, { step: { text: 'Wrote the docs.', outcome: 'ok' }, memories: [] }], () => '/work/demo', () => id)

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  await compactToNewId($, files, () => (id = CHILD))
  await say($, 'keep answers short', 'Ok.', 2)
  await settle(clock, files, f => (f.get(`${CHILD_DIR}/steps.md`) ?? '').includes('- t2'))
  files.set(`${PROJECT}/${CHILD}.jsonl`, `${boundary('last-of-old')}\n${last('last-of-second')}`)
  await $.session.compact({ trigger: 'auto', messages: SUMMARY } as never)
  id = THIRD
  files.set(`${PROJECT}/${THIRD}.jsonl`, boundary('last-of-second'))
  await say($, 'write the docs', 'Done.', 3)
  await settle(clock, files, f => (f.get(`${THIRD_DIR}/steps.md`) ?? '').includes('- t3'))

  const md = files.get(`${THIRD_DIR}/state.md`) ?? ''
  expect(md).toContain('Use SQLite for storage.')
  expect(md).toContain('Keep answers short.')
  expect(turnsOf(files.get(`${THIRD_DIR}/steps.md`))).toEqual(['- t1', '- t2', '- t3'])
})

test('a session met after two compactions copies the second session, not the first', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files, written } = world(on, 0.1, [])
  const FIRST_DIR = `${ROOT}/demo/2026-10-15_aaa00001`
  files.set(`${FIRST_DIR}/state.md`, ledgerOf('aaa00001-0000', 'Use SQLite for storage.'))
  files.set(`${PROJECT}/aaa00001-0000.jsonl`, last('last-of-first'))
  files.set(`${OLD_DIR}/state.md`, `${ledgerOf('old00001-0000', 'Use SQLite for storage.')}\n### M-002 · decision · t2\nKeep answers short.\nSource: t2 · turn u2\n`)
  files.set(`${PROJECT}/old00001-0000.jsonl`, `${boundary('last-of-first')}\n${last('last-of-second')}`)
  files.set(TRANSCRIPT, boundary('last-of-second'))
  written.set(`${FIRST_DIR}/state.md`, 1)
  written.set(`${OLD_DIR}/state.md`, 2)

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)

  expect(files.get(STATE) ?? '').toContain('Keep answers short.')
})


// What each tab shows, as the person reads it.
const tabsOf = async ($: TestDollar, ui: Awaited<ReturnType<typeof mountPane>>) => {
  const shown: Record<string, string> = {}
  for (const name of ['steps', 'ledger', 'stats']) {
    await $.command.run({ command: 'session-state', args: name } as never)
    await ui.redraw()
    shown[name] = `${await textOf(ui)}\n${JSON.stringify(await ui.findAll({ type: 'Markdown' } as never))}`
  }
  return shown
}

const SECOND = { step: { text: 'Ran the tests.', outcome: 'ok' }, memories: [] }

test('closing the panel and opening it again shows the same ledger, with or without a turn in between', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.95, [SQLITE, SECOND])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))

  const first = await mountPane($)
  const before = await tabsOf($, first)
  expect(before.steps).toContain('Switched storage to SQLite.')
  expect(before.ledger).toContain('Use SQLite for storage.')
  await $.command.run({ command: 'session-state', args: 'close' } as never)
  await first.unmount()

  await $.command.run({ command: 'session-state', args: '' } as never)
  const second = await mountPane($)
  expect(await tabsOf($, second)).toEqual(before)
  await $.command.run({ command: 'session-state', args: 'close' } as never)
  await second.unmount()

  await say($, 'run the tests', 'All pass.', 2)
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t2'))
  await $.command.run({ command: 'session-state', args: '' } as never)
  const third = await mountPane($)
  const after = await tabsOf($, third)
  expect(after.steps).toContain('Switched storage to SQLite.')
  expect(after.steps).toContain('Ran the tests.')
  expect(after.ledger).toContain('Use SQLite for storage.')
  expect(after.stats).toContain('1 decisions and rules')
})

const POSTGRES = {
  step: { text: 'Moved storage to Postgres.', outcome: 'ok' },
  memories: [{ kind: 'decision', text: 'Use Postgres for storage.', why: 'Needs concurrent writers.', context: '', quote: 'use Postgres', refers_to: [], supersedes: [1] }],
}

const markdownOf = async (ui: Awaited<ReturnType<typeof mountPane>>) => JSON.stringify(await ui.findAll({ type: 'Markdown' } as never))

test('the history view follows the turns while the panel stays open', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.95, [SQLITE, POSTGRES])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  await $.command.run({ command: 'session-state', args: 'ledger' } as never)
  const ui = await mountPane($)
  await ui.press({ key: 'history' })
  expect(await markdownOf(ui)).toContain('Nothing replaced or finished yet.')

  await say($, 'Actually use Postgres instead.', 'Moved.', 2)
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t2'))

  expect(files.get(`${FOLDER}/history.md`) ?? '').toContain('Use SQLite for storage.')
  expect(await markdownOf(ui)).toContain('Use SQLite for storage.')
})

test('reopening the panel on the ledger tab shows the ledger, not the history it was left on', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.95, [SQLITE])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  await $.command.run({ command: 'session-state', args: 'ledger' } as never)
  const first = await mountPane($)
  await first.press({ key: 'history' })
  expect(await markdownOf(first)).toContain('Nothing replaced or finished yet.')
  await $.command.run({ command: 'session-state', args: 'close' } as never)
  await first.unmount()

  await $.command.run({ command: 'session-state', args: 'ledger' } as never)
  const second = await mountPane($)
  expect(await markdownOf(second)).toContain('Use SQLite for storage.')
})

const DISK_STATE =
  '---\nsession_id: x\nproject: demo\ncwd: /work/demo\nnext_id: 2\n---\n# Storage\n## Open asks\n_None._\n## Decisions and rules\n### M-001 · decision · t1\nUse SQLite for storage.\nWhy: No server to run.\nQuote: "use SQLite"\nSource: t1 · turn u1\n'
const DISK_STEPS = '# Steps\n- t1 · ✓ · Chose SQLite. · +M-001\n'
const DISK_EVENTS = `${JSON.stringify({ type: 'turn', at: 1, turn: 1, turnId: 'u1', user: 'use SQLite', answer: 'Done.', facts: {} })}\n`

test('a panel drawn before the session has started shows the folder as soon as it is read', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files } = world(on, 0.1, [])
  files.set(STATE, DISK_STATE)
  files.set(STEPS, DISK_STEPS)
  files.set(EVENTS, DISK_EVENTS)

  const ui = await mountPane($)
  expect(await textOf(ui)).toContain('No steps yet')
  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)

  expect(await textOf(ui)).toContain('t1 · ✓ · Chose SQLite. · +M-001')
  await $.command.run({ command: 'session-state', args: 'stats' } as never)
  expect(await textOf(ui)).toContain('0 open asks · 1 decisions and rules')
  await $.command.run({ command: 'session-state', args: 'ledger' } as never)
  expect(await markdownOf(ui)).toContain('Use SQLite for storage.')
})

test('a state.md that cannot be read for a moment does not blank the panel; one that stays gone does', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.95, [SQLITE])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  await $.command.run({ command: 'session-state', args: 'ledger' } as never)
  const ui = await mountPane($)
  expect(await markdownOf(ui)).toContain('Use SQLite for storage.')

  const saved = files.get(STATE)!
  files.delete(STATE)
  await clock.advance(3000)
  expect(await markdownOf(ui)).toContain('Use SQLite for storage.')
  files.set(STATE, saved)
  await clock.advance(3000)
  expect(await markdownOf(ui)).toContain('Use SQLite for storage.')

  files.delete(STATE)
  await clock.advance(3000)
  await clock.advance(3000)
  expect(await markdownOf(ui)).toContain('No ledger yet.')
})

test('steps.md and history.md edited on disk show in the panel', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.95, [SQLITE])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  const ui = await mountPane($)
  expect(await textOf(ui)).toContain('Switched storage to SQLite.')

  files.set(STEPS, '# Steps\n- t1 · ✓ · Rolled back by hand · +M-001\n')
  await clock.advance(3000)
  expect(await textOf(ui)).toContain('Rolled back by hand')

  files.set(`${FOLDER}/history.md`, '# History\n### M-009 · decision · t1 · done at t2\nEdited by hand.\n')
  await $.command.run({ command: 'session-state', args: 'ledger' } as never)
  await ui.press({ key: 'history' })
  await clock.advance(3000)
  expect(await markdownOf(ui)).toContain('Edited by hand.')
})

test('a poll that read state.md before a turn wrote it does not put the old text back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, holds } = world(on, 0.95, [SQLITE, POSTGRES])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  await $.command.run({ command: 'session-state', args: 'ledger' } as never)
  const ui = await mountPane($)

  let release = () => {}
  holds.reads.set(STATE, new Promise<void>(resolve => (release = resolve)))
  await clock.advance(3000)
  await say($, 'Actually use Postgres instead.', 'Moved.', 2)
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t2'))
  expect(await markdownOf(ui)).toContain('Use Postgres for storage.')
  release()
  await clock.settle()

  expect(await markdownOf(ui)).toContain('Use Postgres for storage.')
})

const NEW_ID = 'def67890-0000-0000-0000-000000000000'
const NEW_FOLDER = `${ROOT}/demo/2026-10-17_def67890`
const COMPACTED = { trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never

test('the digest still follows a compaction that moves the chat to a new session id', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let id = ID
  const { files, calls } = world(on, 0.95, [SQLITE], () => '/work/demo', () => id)

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  files.set(TRANSCRIPT, `${typed('u1', 'use SQLite')}\n${replied('Switched.')}\n${JSON.stringify({ type: 'assistant', uuid: 'last-of-old' })}`)
  files.set(`/h/.claude/projects/-work-demo/${NEW_ID}.jsonl`, JSON.stringify({ type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'last-of-old' }))

  id = NEW_ID
  await $.session.compact(COMPACTED)
  await $.prompt.compose(COMPOSE)
  await $.prompt.submit({ text: 'what next?' } as never)

  const digest = calls.contexts.at(-1)?.[0]
  expect(digest).toContain('The chat was just compacted.')
  expect(digest).toContain('M-001 (t1) Use SQLite for storage.')
  expect(digest).toContain(`Full ledger: ${NEW_FOLDER}/state.md`)
})

test('the turn that Claude Code compacts in the middle of is still recorded, with its tool facts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let id = ID
  const { files } = world(on, 0.1, [], () => '/work/demo', () => id)

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await $.prompt.submit({ text: 'fix the parser' } as never)
  await $.turn.start({ text: 'fix the parser', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/work/demo/core/parse.ts', old_string: 'a', new_string: 'b', tool_use_id: 'u1' } as never)

  id = NEW_ID
  await $.session.compact(COMPACTED)
  await $.prompt.compose(COMPOSE)
  await $.turn.complete({ turnId: 't1', answer: 'Fixed.', durationMs: 10, isAborted: false } as never)
  await settle(clock, files, f => f.has(`${NEW_FOLDER}/steps.md`))

  const steps = files.get(`${NEW_FOLDER}/steps.md`) ?? ''
  expect(steps).toContain('- t1 · ✓ ')
  expect(steps).toContain('edited core/parse.ts')
})

test('after a reload loses the loop that was recording, the queue is picked up again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, holds } = world(on, 0.1, [])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  // The first Haiku call never answers: the loop that made it is gone, as it is when the module reloads.
  holds.haiku = new Promise<void>(() => {})
  await say($, 'run the tests', 'All pass.', 1)
  await clock.settle()
  holds.haiku = undefined
  const ui = await mountPane($)
  expect(await textOf(ui)).toContain('recording t1')

  // A reload runs session.start again; the atoms stay as they were.
  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await settle(clock, files, f => f.has(STEPS))

  expect(files.get(STEPS) ?? '').toContain('- t1 · ✓ ')
  expect(await textOf(ui)).not.toContain('recording t1')
})

test('a turn that ends while the last one is being saved keeps both in the archive', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, holds } = world(on, 0.1, [])
  // The first write of the archive after `isArmed` waits, as one that takes longer than a neighbour's does.
  let isArmed = false
  let isHeld = false
  let release = () => {}
  on('state.set', { plugin: 'session-state', key: 'events' }, async (_$, e, next) => {
    if (isArmed && !isHeld) {
      isHeld = true
      await new Promise<void>(resolve => (release = resolve))
    }
    return next(e)
  })

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  let releaseHaiku = () => {}
  holds.haiku = new Promise<void>(resolve => (releaseHaiku = resolve))
  await say($, 'run the tests', 'All pass.', 1)
  await clock.settle()
  isArmed = true
  releaseHaiku()
  await clock.settle()
  expect(isHeld).toBe(true)

  await say($, 'and the linter', 'Clean.', 2)
  release()
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t2'))

  const turns = (files.get(EVENTS) ?? '').split('\n').filter(l => l.includes('"type":"turn"')).map(l => (JSON.parse(l) as { turn: number }).turn)
  expect(turns).toEqual([1, 2])
})

test('a turn that Haiku failed twice shows in the panel, and retry records its notes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, holds } = world(on, 0.95, [SQLITE])

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  const ui = await mountPane($)
  holds.fails = 2
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  await $.command.run({ command: 'session-state', args: 'stats' } as never)
  expect(await textOf(ui)).toContain('1 turn; /session-state retry')
  expect(files.get(STATE) ?? '').not.toContain('Use SQLite for storage.')

  const out = await $.command.run({ command: 'session-state', args: 'retry' } as never)
  expect(JSON.stringify(out)).toContain('Retrying 1 turn.')
  await settle(clock, files, f => (f.get(STATE) ?? '').includes('Use SQLite for storage.'))

  expect(await textOf(ui)).not.toContain('/session-state retry')
  expect(await textOf(ui)).toContain('1 decisions and rules')
})

test('after a rebuild the open panel shows the rebuilt steps and ledger, not the old ones', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.1, [SQLITE, { step: { text: 'Picked a store.', outcome: 'ok' }, memories: [] }, { step: { text: 'Ran the tests.', outcome: 'ok' }, memories: [] }])
  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  const ui = await mountPane($)
  expect(await textOf(ui)).toContain('Switched storage to SQLite.')

  files.set(TRANSCRIPT, [typed('u1', 'pick a store'), replied('SQLite.'), typed('u2', 'run the tests'), replied('All pass.')].join('\n'))
  await $.command.run({ command: 'session-state', args: 'rebuild' } as never)
  expect(await textOf(ui)).toContain('No steps yet')
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t2'))

  const steps = await textOf(ui)
  expect(steps).toContain('t2 · ✓ · Ran the tests.')
  expect(steps.includes('Switched storage to SQLite.')).toBe(false)
})

test('pausing from the panel stops recording and says so; resuming records again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files } = world(on, 0.1, [])
  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  await $.command.run({ command: 'session-state', args: 'stats' } as never)
  const ui = await mountPane($)
  expect(await textOf(ui)).toContain('idle')

  await ui.press({ key: 'pause' })
  expect(await textOf(ui)).toContain('paused')
  await say($, 'run the tests', 'All pass.', 1)
  await clock.advance(50)
  expect(files.has(STEPS)).toBe(false)

  await ui.press({ key: 'pause' })
  expect(await textOf(ui)).toContain('idle')
  await say($, 'run the linter', 'Clean.', 2)
  await settle(clock, files, f => f.has(STEPS))
  expect(files.get(STEPS) ?? '').toContain('- t1 · ✓ ')
})

test('two wake-ups of the queue at once run one loop, so no turn is recorded twice or skipped', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { files, holds } = world(on, 0.1, [])
  // The first write of the busy flag waits, as one that takes longer than a neighbour's does.
  let isArmed = false
  let isHeld = false
  let release = () => {}
  on('state.set', { plugin: 'session-state', key: 'status' }, async (_$, e, next) => {
    if (isArmed && !isHeld) {
      isHeld = true
      await new Promise<void>(resolve => (release = resolve))
    }
    return next(e)
  })

  await $.session.start({ cwd: '/work/demo', surface: 'terminal' } as never)
  let releaseHaiku = () => {}
  holds.haiku = new Promise<void>(resolve => (releaseHaiku = resolve))
  isArmed = true
  await say($, 'run the tests', 'All pass.', 1)
  await clock.settle()
  expect(isHeld).toBe(true)
  await say($, 'and the linter', 'Clean.', 2)
  await clock.settle()
  release()
  await clock.settle()
  releaseHaiku()
  await settle(clock, files, f => (f.get(STEPS) ?? '').includes('- t2'))

  const lines = (files.get(STEPS) ?? '').split('\n').filter(l => l.startsWith('- t'))
  expect(lines.map(l => l.split(' · ')[0])).toEqual(['- t1', '- t2'])
  expect((files.get(EVENTS) ?? '').split('\n').filter(l => l.includes('"type":"extract"')).length).toBe(2)
})

test('a compaction after the chat entered a worktree still continues the ledger, in the project the chat started in', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let id = ID
  let cwd = '/work/demo'
  const { files, calls } = world(on, 0.95, [SQLITE], () => cwd, () => id)

  await $.session.start({ cwd, surface: 'terminal' } as never)
  await say($, 'Please use SQLite from now on.', 'Switched.', 1)
  await settle(clock, files, f => f.has(STEPS))
  files.set(TRANSCRIPT, `${typed('u1', 'use SQLite')}\n${replied('Switched.')}\n${JSON.stringify({ type: 'assistant', uuid: 'last-of-old' })}`)
  files.set(`/h/.claude/projects/-work-demo/${NEW_ID}.jsonl`, JSON.stringify({ type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'last-of-old' }))

  cwd = '/work/demo/.local/worktrees/panel'
  id = NEW_ID
  await $.session.compact(COMPACTED)
  await $.prompt.compose(COMPOSE)
  await $.prompt.submit({ text: 'what next?' } as never)

  expect(calls.contexts.at(-1)?.[0]).toContain('M-001 (t1) Use SQLite for storage.')
  expect(files.has(`${NEW_FOLDER}/state.md`)).toBe(true)
})
