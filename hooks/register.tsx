import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { digestText } from '../core/digest'
import { addToolCall, emptyFacts } from '../core/facts'
import { fileIndex, rankFiles } from '../core/files'
import { archivedTurns, fitLedger, parseLedger, parsePending, serializeLedger, serializePending, summarize, turnRecord } from '../core/ledger'
import { activeNotes, newFront, parseOldNotes, pointerText, rulesText, upsertIndex } from '../core/notes'
import { processTurn } from '../core/pipeline'
import { emptyState, HISTORY_HEAD, historyBlock, parseState, renderState, seedState } from '../core/state'
import { appendStep, stepLines } from '../core/steps'
import { answersOf, continuesFrom, parseTranscript, withAnswers } from '../core/transcript'
import type { Config, State } from '../core/types'
import type { LedgerEvent, PendingTurn, Status, Tab } from '../types'
import { gateLines, rows } from './format'
import { configOf, hostOf } from './host'
import { baseOf, dirOf, eventsOf, folderName, historyOf, pendingOf, projectOf, stateOf, stepsOf, transcriptOf } from './paths'

const PANE = 'session-state'
const TITLE = 'Session ledger'
const MAX_FAILED = 5
const PANEL_STEPS = 40
// A chat met mid-way (new install, upgrade, resume) is read back from its transcript, up to this many turns.
const BACKFILL_MAX = 100
const TABS: Tab[] = ['steps', 'ledger', 'stats']

const sessionId = atom({ plugin: 'session-state', key: 'sessionId' } as const, '')
// This session's ledger folder: <project>/<date>_<id8>.
const dir = atom({ plugin: 'session-state', key: 'dir' } as const, '')
// Where the chat started. The session's own directory moves when the person enters a worktree.
const origin = atom({ plugin: 'session-state', key: 'origin' } as const, '')
const md = atom({ plugin: 'session-state', key: 'md' } as const, '')
const steps = atom({ plugin: 'session-state', key: 'steps' } as const, '')
const events = atom({ plugin: 'session-state', key: 'events' } as const, [] as LedgerEvent[])
const queue = atom({ plugin: 'session-state', key: 'queue' } as const, [] as PendingTurn[])
const failed = atom({ plugin: 'session-state', key: 'failed' } as const, [] as PendingTurn[])
const pendingUser = atom({ plugin: 'session-state', key: 'pendingUser' } as const, '')
const previousAnswer = atom({ plugin: 'session-state', key: 'previousAnswer' } as const, '')
const facts = atom({ plugin: 'session-state', key: 'facts' } as const, emptyFacts())
const turns = atom({ plugin: 'session-state', key: 'turns' } as const, 0)
const status = atom({ plugin: 'session-state', key: 'status' } as const, { isBusy: false, turn: 0, message: '' } as Status)
const isPaused = atom({ plugin: 'session-state', key: 'isPaused' } as const, false)
// Set when Claude Code compacts the main chat; the next typed prompt carries the digest and clears it.
const isCompacted = atom({ plugin: 'session-state', key: 'isCompacted' } as const, false)
const tab = atom({ plugin: 'session-state', key: 'tab' } as const, 'steps' as Tab)
const isHistoryShown = atom({ plugin: 'session-state', key: 'isHistoryShown' } as const, false)

// Bookkeeping never fails the event it watches.
const quiet = () => undefined

const readText = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

const listOf = async ($: EngineInterface, path: string) => {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

// This project's folder first, then every other project: a resumed chat may start elsewhere.
const findIn = async ($: EngineInterface, root: string, here: string, isMatch: (name: string, kind: string) => boolean): Promise<string | undefined> => {
  const look = async (d: string) => (await listOf($, d)).find(e => isMatch(e.name, e.kind))?.name
  const found = await look(here)
  if (found !== undefined) return `${here}/${found}`
  for (const project of await listOf($, root)) {
    if (project.kind !== 'dir' || `${root}/${project.name}` === here) continue
    const name = await look(`${root}/${project.name}`)
    if (name !== undefined) return `${root}/${project.name}/${name}`
  }
  return undefined
}

const dayOf = async ($: EngineInterface): Promise<string> => new Date(await $.clock.now()).toISOString().slice(0, 10)

const frontOf = async ($: EngineInterface): Promise<Record<string, string>> => {
  const id = await read($, sessionId)
  const cwd = (await read($, origin)) || (await $.session.cwd())
  return newFront({ sessionId: id, project: projectOf(cwd), cwd, started: await dayOf($), transcript: transcriptOf(cwd, id) })
}

// The file is the truth: read it back each turn so the person's edits stand.
const loadState = (text: string, front: Record<string, string>): State => {
  if (text === '') return emptyState(front)
  const parsed = parseState(text)
  return { ...parsed, front: { ...front, ...parsed.front } }
}

const LEDGER_FILES = [stateOf, stepsOf, historyOf, eventsOf, pendingOf]
const MAX_PARENTS = 12

// The ledger folder of the chat this one continues, found by the last message the new transcript points back to.
const parentFolder = async ($: EngineInterface, here: string, folder: string, home: string, uuid: string): Promise<string | undefined> => {
  const names = (await listOf($, here)).filter(e => e.kind === 'dir' && `${here}/${e.name}` !== folder).map(e => e.name).sort().reverse()
  for (const name of names.slice(0, MAX_PARENTS)) {
    const path = /^transcript:\s*(.+)$/m.exec(await readText($, stateOf(`${here}/${name}`)))?.[1]?.trim()
    if (path !== undefined && (await readText($, path.replace(/^~/, home))).includes(uuid)) return `${here}/${name}`
  }
  return undefined
}

// A compaction that moved the chat to a new session id keeps its ledger: the old files are copied over, for this
// session to carry on from. The old folder stays as it was.
const inherit = async ($: EngineInterface, here: string, folder: string, home: string, transcript: string): Promise<void> => {
  const uuid = continuesFrom(transcript)
  if (uuid === undefined) return
  const parent = await parentFolder($, here, folder, home, uuid)
  if (parent === undefined) return
  const front = await frontOf($)
  for (const pathOf of LEDGER_FILES) {
    const text = await readText($, pathOf(parent))
    if (text === '') continue
    const own = pathOf === stateOf ? text.replace(/^(session_id|transcript|resume):.*$/gm, (_, key: string) => `${key}: ${front[key]}`) : text
    await $.fs.write(pathOf(folder), own).catch(quiet)
  }
}

const boot = async ($: EngineInterface, id: string): Promise<string> => {
  if ((await read($, sessionId)) === id) {
    const known = await read($, dir)
    if (known !== '') return known
  }
  const home = (await $.env.get('HOME')) ?? ''
  const cwd = await $.session.cwd()
  const root = `${home}/.claude/session-state`
  const here = `${root}/${projectOf(cwd)}`
  const id8 = `_${id.slice(0, 8)}`
  const found = await findIn($, root, here, (name, kind) => kind === 'dir' && name.endsWith(id8))
  const folder = found ?? `${here}/${folderName(await dayOf($), id)}`
  const transcript = await readText($, transcriptOf(cwd, id).replace(/^~/, home))
  await update($, sessionId, () => id)
  await update($, dir, () => folder)
  await update($, origin, () => cwd)
  if (found === undefined) await inherit($, here, folder, home, transcript)

  let ledger = parseLedger(await readText($, eventsOf(folder)))
  let pending = parsePending(await readText($, pendingOf(folder)))
  let text = await readText($, stateOf(folder))
  if (ledger.length === 0 && pending.length === 0) {
    // The turns before the mod met this chat, read back from Claude Code's transcript and queued like live
    // ones. The last turn is left out while its reply is still being written.
    const past = parseTranscript(transcript)
    if (past.at(-1)?.answer === '') past.pop()
    if (past.length > 0) {
      const now = await $.clock.now()
      pending = past.slice(-BACKFILL_MAX)
      ledger = pending.map(t => turnRecord(t, now))
      // The transcript is a fuller source than notes seeded from an older version.
      if (text !== '') await $.fs.write(stateOf(folder), '').catch(quiet)
      text = ''
      await $.fs.write(eventsOf(folder), serializeLedger(ledger)).catch(quiet)
      await $.fs.write(pendingOf(folder), serializePending(pending)).catch(quiet)
    }
  }
  if (text === '' && pending.length === 0) {
    // A notes file from before 0.3 seeds the new ledger once; the old file is left as it is.
    const old = await findIn($, root, here, (name, kind) => kind === 'file' && name.endsWith(`${id8}.md`))
    if (old !== undefined) {
      const { title, notes } = parseOldNotes(await readText($, old))
      const front = { ...(await frontOf($)), title }
      text = renderState(seedState(notes, front), [])
      await $.fs.write(stateOf(folder), text).catch(quiet)
    }
  }
  const archive = archivedTurns(ledger)
  await update($, md, () => text)
  const stepsMd = await readText($, stepsOf(folder))
  await update($, steps, () => stepsMd)
  await update($, events, () => ledger)
  await update($, queue, () => pending)
  await update($, failed, () => [])
  await update($, pendingUser, () => '')
  await update($, previousAnswer, () => pending.at(-1)?.answer ?? archive.at(-1)?.answer ?? '')
  await update($, facts, () => emptyFacts())
  await update($, turns, () => Math.max(0, ...archive.map(r => r.turn), ...pending.map(t => t.turn)))
  await update($, status, () => ({ isBusy: false, turn: 0, message: '' }))
  await update($, isCompacted, () => false)
  return folder
}

// One boot per session id, however many hooks ask at once. A /clear or a resume changes the id.
let booting: { id: string; run: Promise<string> } | undefined

const ensure = async ($: EngineInterface): Promise<string> => {
  const id = await $.session.id()
  if (booting === undefined || booting.id !== id) booting = { id, run: boot($, id) }
  return booting.run
}

const ranked = (state: State, ledger: readonly LedgerEvent[], now: number) => rankFiles(fileIndex(archivedTurns(ledger)), state, now)

const writeIndex = async ($: EngineInterface, folder: string, state: State, stepCount: number): Promise<void> => {
  const indexPath = `${dirOf(folder)}/INDEX.md`
  const next = upsertIndex(await readText($, indexPath), state.front.project ?? '', {
    file: `${baseOf(folder)}/state.md`,
    date: baseOf(folder).slice(0, 10),
    title: state.front.title ?? '',
    active: activeNotes(state).length,
    learned: state.learnings.filter(l => l.status === 'active').length,
    steps: stepCount,
  })
  await $.fs.write(indexPath, next)
}

const savePending = async ($: EngineInterface): Promise<void> => {
  await $.fs.write(pendingOf(await read($, dir)), serializePending(await read($, queue)))
}

const saveEvents = async ($: EngineInterface, add: LedgerEvent[]): Promise<LedgerEvent[]> => {
  const all = fitLedger([...(await read($, events)), ...add])
  await update($, events, () => all)
  await $.fs.write(eventsOf(await read($, dir)), serializeLedger(all))
  return all
}

const isFailure = (e: LedgerEvent): boolean => e.type === 'extract' && e.error !== undefined

const handle = async ($: EngineInterface, config: Config, turn: PendingTurn): Promise<void> => {
  const folder = await read($, dir)
  const state = loadState(await readText($, stateOf(folder)), await frontOf($))
  const stepsMd = await readText($, stepsOf(folder))
  // A turn read back from the transcript sees only the turns before it, as it would have live.
  const ledger = (await read($, events)).filter(e => e.type !== 'turn' || e.turn <= turn.turn)

  const outcome = await processTurn(
    hostOf($, config),
    config,
    { state, steps: stepLines(stepsMd), archive: archivedTurns(ledger), files: ranked(state, ledger, turn.turn) },
    turn,
  )

  // The state and the step line matter more than the archive: a failed write of it must not stop them.
  await saveEvents($, outcome.events).catch(quiet)
  const out = renderState(outcome.state, ranked(outcome.state, ledger, turn.turn))
  await $.fs.write(stateOf(folder), out)
  await update($, md, () => out)
  if (outcome.moved.length > 0) {
    const history = await readText($, historyOf(folder))
    const blocks = outcome.moved.map(historyBlock).join('\n\n')
    await $.fs.write(historyOf(folder), `${history === '' ? HISTORY_HEAD : history}\n${blocks}\n`)
  }
  const nextSteps = appendStep(stepsMd, outcome.step)
  if (nextSteps !== stepsMd) await $.fs.write(stepsOf(folder), nextSteps)
  await update($, steps, () => nextSteps)
  await writeIndex($, folder, outcome.state, stepLines(nextSteps).length).catch(quiet)
  if (outcome.events.some(isFailure)) await update($, failed, list => [...list, turn].slice(-MAX_FAILED))
}

// Runs outside any hook's budget, one turn at a time, so the next prompt is never held up.
const drain = async ($: EngineInterface, config: Config): Promise<void> => {
  // One drain at a time. Claiming is a single update, so two callers that arrive together (a timer, the poller,
  // the exit) cannot both find it free and record the same turn twice.
  let isClaimed = false
  await update($, status, s => {
    isClaimed = !s.isBusy
    return isClaimed ? { ...s, isBusy: true } : s
  })
  if (!isClaimed) return
  try {
    for (;;) {
      const next = (await read($, queue))[0]
      if (next === undefined) break
      await update($, status, s => ({ ...s, turn: next.turn }))
      try {
        await handle($, config, next)
        await update($, status, s => ({ ...s, message: '' }))
      } catch (err) {
        await update($, status, s => ({ ...s, message: `error: ${String(err).slice(0, 140)}` }))
        await update($, failed, list => [...list, next].slice(-MAX_FAILED))
      }
      await update($, queue, list => list.slice(1))
      await savePending($).catch(quiet)
    }
  } finally {
    await update($, status, s => ({ ...s, isBusy: false }))
  }
}

// Before the process goes, finish what is queued, within the time a hook is given.
const flush = async ($: EngineInterface, options: PluginOptions): Promise<void> => {
  const config = await configOf($, options)
  const deadline = (await $.clock.now()) + 8000
  while ((await $.clock.now()) < deadline) {
    const isBusy = (await read($, status)).isBusy
    if (!isBusy && (await read($, queue)).length === 0) return
    if (isBusy) await $.clock.sleep(150)
    else await drain($, config)
  }
}

const kick = ($: EngineInterface, options: PluginOptions): void =>
  void $.clock.after(0, async () => {
    await drain($, await configOf($, options)).catch(quiet)
  })

const digestOf = async ($: EngineInterface): Promise<string> => {
  const folder = await ensure($)
  const state = loadState(await read($, md), await frontOf($))
  const ledger = await read($, events)
  return digestText(state, stepLines(await read($, steps)), ranked(state, ledger, await read($, turns)), folder)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-state',
      description: 'The ledger of this chat: open the panel (steps, ledger, stats), pause, retry, rebuild',
    }).catch(quiet)
    await ensure($).catch(quiet)
    if ((await read($, queue)).length > 0) kick($, options)
    // Picks up the person's hand edits for the panel and wakes a stranded queue.
    $.clock.every(3000, async () => {
      const folder = await read($, dir)
      if (folder !== '') {
        const text = await readText($, stateOf(folder))
        if (text !== (await read($, md))) await update($, md, () => text)
      }
      if ((await read($, queue)).length > 0 && !(await read($, status)).isBusy) kick($, options)
    })
    if (options.openPanelOnStart === true) void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flush($, options).catch(quiet)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Typed by the person: at the keyboard, from a phone or from the SDK. Not a task notification, a
    // schedule, a peer or another plugin.
    const kind = e.origin?.kind
    const isTyped = kind === undefined || kind === 'composer' || kind === 'bridge' || kind === 'sdk'
    if (!isTyped || e.command !== undefined || e.isMeta === true || e.text.trim() === '' || (await read($, isPaused))) return next(e)
    try {
      await ensure($)
      await update($, pendingUser, p => (p === '' ? e.text : `${p}\n\n${e.text}`))
      if (await read($, isCompacted)) {
        await update($, isCompacted, () => false)
        const digest = await digestOf($)
        return next({ ...e, context: [...(e.context ?? []), digest] })
      }
    } catch {
      // never block a prompt
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, facts, () => emptyFacts()).catch(quiet)
    return next(e)
  })

  // Watches the main agent's tool calls for the turn's facts. It never changes a call or its result.
  on('tool.call', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined && out.deny === undefined) {
      const call = { tool: e.tool, input: e as unknown as Record<string, unknown>, isError: out.isError === true, text: out.text ?? '' }
      await update($, facts, f => addToolCall(f, call)).catch(quiet)
      if (e.tool === 'AskUserQuestion' && out.isError !== true) {
        const answers = answersOf(out.result ?? out.text)
        if (answers !== '') await update($, pendingUser, p => withAnswers(p, answers)).catch(quiet)
      }
    }
    return out
  })

  // Only notes that the main chat was compacted. It never changes, starts or skips a compaction.
  on('session.compact', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && out.skip === undefined) await update($, isCompacted, () => true).catch(quiet)
    return out
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        // Taken and cleared in one step each, before anything else is awaited: a message or a tool call that lands
        // while this turn is being stored belongs to the next turn and must not be cleared with it.
        let user = ''
        let toolFacts = emptyFacts()
        await update($, pendingUser, p => {
          user = p
          return ''
        })
        await update($, facts, f => {
          toolFacts = f
          return emptyFacts()
        })
        if (user.trim() !== '' && !(await read($, isPaused))) {
          await ensure($)
          const n = (await read($, turns)) + 1
          const turn: PendingTurn = {
            turn: n,
            turnId: e.turnId,
            user,
            answer: e.answer,
            previousAnswer: await read($, previousAnswer),
            isAborted: e.isAborted,
            facts: toolFacts,
          }
          await update($, turns, () => n)
          await saveEvents($, [turnRecord(turn, await $.clock.now())]).catch(quiet)
          await update($, queue, q => [...q, turn])
          await savePending($).catch(quiet)
          kick($, options)
        }
        if (e.answer !== '') await update($, previousAnswer, () => e.answer)
      } catch {
        // never fail the turn's end
      }
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    try {
      const folder = await ensure($)
      const sections = [...out.sections, { id: 'session-state:ledger', text: pointerText(folder), scope: 'session' as const }]
      if ((await configOf($, options)).pinRules) {
        const rules = rulesText(loadState(await readText($, stateOf(folder)), {}))
        if (rules !== '') sections.push({ id: 'session-state:rules', text: rules, scope: 'session' as const })
      }
      return { sections }
    } catch {
      return out
    }
  })

  on('command.run', { command: 'session-state' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Session ledger panel closed.' }
    }
    if (arg === 'pause' || arg === 'resume') {
      await update($, isPaused, () => arg === 'pause')
      return { text: arg === 'pause' ? 'Session ledger paused: new turns are not recorded.' : 'Session ledger resumed.' }
    }
    if (arg === 'retry') {
      const again = await read($, failed)
      await update($, failed, () => [])
      await update($, queue, q => [...q, ...again])
      await savePending($).catch(quiet)
      kick($, options)
      return { text: `Retrying ${again.length} turn${again.length === 1 ? '' : 's'}.` }
    }
    if (arg === 'rebuild') {
      if ((await read($, status)).isBusy || (await read($, queue)).length > 0) return { text: 'Still recording turns; run rebuild when the queue is empty.' }
      const folder = await ensure($)
      // The current files move to before-rebuild/, then the next boot reads the chat back from its transcript.
      for (const path of [stateOf(folder), stepsOf(folder), historyOf(folder), eventsOf(folder), pendingOf(folder)]) {
        const text = await readText($, path)
        if (text === '') continue
        await $.fs.write(`${folder}/before-rebuild/${baseOf(path)}`, text)
        await $.fs.write(path, '')
      }
      booting = undefined
      await update($, sessionId, () => '')
      await ensure($)
      kick($, options)
      const queued = (await read($, queue)).length
      return { text: queued === 0 ? 'No earlier turns in the transcript to rebuild from.' : `Rebuilding the ledger from the transcript: ${queued} turns queued. The old files are in before-rebuild/.` }
    }
    if (arg === 'path') return { text: await ensure($) }
    if (arg === 'digest') return { text: await digestOf($) }
    const chosen = TABS.find(t => t === arg)
    if (chosen !== undefined) await update($, tab, () => chosen)
    await ensure($).catch(quiet)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Session ledger panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const shown = await read($, tab)
    const folder = await read($, dir)
    const tabs = (
      <Box>
        {TABS.map(t => (
          <Button key={t} label={t[0]!.toUpperCase() + t.slice(1)} variant={t === shown ? 'primary' : 'secondary'} onPress={() => void update($, tab, () => t)} />
        ))}
      </Box>
    )

    if (shown === 'steps') {
      const lines = stepLines(await read($, steps))
      const s = await read($, status)
      const queued = (await read($, queue)).length
      return (
        <Box flexDirection="column">
          {tabs}
          {lines.length === 0 && <Text dimColor>No steps yet: one line appears after each turn.</Text>}
          {lines.length > PANEL_STEPS && <Text dimColor>{`${lines.length - PANEL_STEPS} earlier steps in steps.md`}</Text>}
          {lines.slice(-PANEL_STEPS).map(line => (
            <Text key={line}>{line.slice(2)}</Text>
          ))}
          {s.isBusy && <Text dimColor>{`recording t${s.turn}…${queued > 1 ? ` (${queued - 1} more queued)` : ''}`}</Text>}
        </Box>
      )
    }

    if (shown === 'ledger') {
      const isHistory = await read($, isHistoryShown)
      // The front matter is for tools and the agent; the panel shows the ledger itself.
      const text = (isHistory ? await readText($, historyOf(folder)) : await read($, md)).replace(/^---\n[\s\S]*?\n---\n?/, '')
      return (
        <Box flexDirection="column">
          {tabs}
          <Box>
            <Button key="history" label={isHistory ? 'Show state' : 'Show history'} onPress={() => void update($, isHistoryShown, h => !h)} />
          </Box>
          <Markdown text={text === '' ? (isHistory ? '_Nothing replaced or finished yet._' : '_No ledger yet._') : text} />
        </Box>
      )
    }

    const config = await configOf($, options)
    const state = loadState(await read($, md), {})
    const active = activeNotes(state)
    const ledger = await read($, events)
    const stats = summarize(ledger)
    const panel = rows({
      stats,
      asks: active.filter(n => n.kind === 'ask').length,
      rules: active.filter(n => n.kind !== 'ask').length,
      learnings: state.learnings.filter(l => l.status === 'active').length,
      files: fileIndex(archivedTurns(ledger)).length,
      config,
      status: await read($, status),
      isPaused: await read($, isPaused),
      failed: (await read($, failed)).length,
    })
    const recent = gateLines(stats)
    return (
      <Box flexDirection="column">
        {tabs}
        {panel.map(r => (
          <Text key={r.label}>
            <Text bold>{r.label.padEnd(9)}</Text>
            {r.value}
          </Text>
        ))}
        {recent.length > 0 && <Text dimColor>Recent gate decisions</Text>}
        {recent.map(line => (
          <Text key={line} dimColor>
            {line}
          </Text>
        ))}
        <Text dimColor wrap="truncate-middle">
          {folder === '' ? 'No folder yet' : folder}
        </Text>
        <Box>
          <Button key="copy" label="Copy path" onPress={() => void $.ui.copy({ text: folder, surface: e.surface })} />
          <Button key="pause" label={(await read($, isPaused)) ? 'Resume' : 'Pause'} onPress={() => void update($, isPaused, p => !p)} />
        </Box>
      </Box>
    )
  })
}
