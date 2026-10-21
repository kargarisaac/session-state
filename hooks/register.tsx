import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { digestText } from '../core/digest'
import { addToolCall, emptyFacts } from '../core/facts'
import { fileIndex, rankFiles } from '../core/files'
import { archivedTurns, fitLedger, parseLedger, parsePending, serializeLedger, serializePending, summarize, turnRecord } from '../core/ledger'
import { activeNotes, newFront, parseOldNotes, pointerText, rulesText, upsertIndex } from '../core/notes'
import { processTurn } from '../core/pipeline'
import { emptyState, HISTORY_HEAD, historyBlock, parseState, renderState, seedState } from '../core/state'
import { appendStep, hasStep, lastStep, stepLines } from '../core/steps'
import { answersOf, continuesFrom, hasMessage, parseTranscript, withAnswers } from '../core/transcript'
import type { Config, State, Turn } from '../core/types'
import type { ExtractEvent, LedgerEvent, PendingTurn, Status, Tab } from '../types'
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
const history = atom({ plugin: 'session-state', key: 'history' } as const, '')
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

// The transcript a ledger folder names in its state.md.
const transcriptPathIn = async ($: EngineInterface, home: string, folder: string): Promise<string | undefined> => {
  const path = /^transcript:\s*(.+)$/m.exec(await readText($, stateOf(folder)))?.[1]?.trim()
  return path?.replace(/^~/, home)
}

// The text of a transcript; empty when there is none, or $.fs.read cannot read it (it rejects a file over 4 MiB, as
// a long chat's is).
const transcriptIn = async ($: EngineInterface, home: string, folder: string): Promise<string> => {
  const path = await transcriptPathIn($, home, folder)
  return path === undefined ? '' : readText($, path)
}

// Whether a ledger folder's transcript holds a message. One too big to read is searched by grep, which is run by
// its argument vector (no shell) on that one file, with an id that has nothing but letters, digits and dashes.
const holdsMessage = async ($: EngineInterface, home: string, folder: string, uuid: string): Promise<boolean> => {
  const path = await transcriptPathIn($, home, folder)
  if (path === undefined) return false
  const text = await readText($, path)
  if (text !== '') return hasMessage(text, uuid)
  if (!/^[A-Za-z0-9-]{1,64}$/.test(uuid)) return false
  try {
    const found = await $.process.run(['grep', '-q', '-E', '-e', `"uuid"[[:space:]]*:[[:space:]]*"${uuid}"`, path])
    return found.exitCode === 0
  } catch {
    return false
  }
}

// The ledger folder of the chat this one continues. In the process that compacted it, that is the folder it was
// recording into, whatever the size of its transcript. Otherwise it is found by the last message the new transcript
// points back to, among the folders whose ledgers were written last.
const parentFolder = async ($: EngineInterface, here: string, folder: string, home: string, uuid: string | undefined, previous: string): Promise<string | undefined> => {
  // A transcript that cannot be read cannot disagree.
  if (previous !== '' && previous !== folder) {
    const text = await transcriptIn($, home, previous)
    if (uuid === undefined || text === '' || hasMessage(text, uuid)) return previous
  }
  if (uuid === undefined) return undefined
  const written: { path: string; at: number }[] = []
  for (const entry of await listOf($, here)) {
    const path = `${here}/${entry.name}`
    if (entry.kind !== 'dir' || path === folder) continue
    const stat = await $.fs.stat(stateOf(path)).catch(() => undefined)
    if (stat !== undefined) written.push({ path, at: stat.mtimeMs })
  }
  for (const { path } of written.sort((a, b) => b.at - a.at).slice(0, MAX_PARENTS)) {
    if (await holdsMessage($, home, path, uuid)) return path
  }
  return undefined
}

// A compaction that moved the chat to a new session id keeps its ledger: the old files are copied over, for this
// session to carry on from. The old folder stays as it was. Says whether there was a parent.
const inherit = async ($: EngineInterface, here: string, folder: string, home: string, transcript: string, previous: string): Promise<boolean> => {
  const uuid = continuesFrom(transcript)
  // A transcript that has messages and no boundary is a chat of its own, not the continuation of the one before it.
  const parent = await parentFolder($, here, folder, home, uuid, transcript === '' || uuid !== undefined ? previous : '')
  if (parent === undefined) return false
  const front = await frontOf($)
  for (const pathOf of LEDGER_FILES) {
    const text = await readText($, pathOf(parent))
    if (text === '') continue
    const own = pathOf === stateOf ? text.replace(/^(session_id|transcript|resume):.*$/gm, (_, key: string) => `${key}: ${front[key]}`) : text
    await $.fs.write(pathOf(folder), own).catch(quiet)
  }
  return true
}

// The turns of a transcript that are over: the last one is left out while its reply is still being written.
const pastTurns = (transcript: string): Turn[] => {
  const past = parseTranscript(transcript)
  if (past.at(-1)?.answer === '') past.pop()
  return past
}

const boot = async ($: EngineInterface, id: string): Promise<string> => {
  if ((await read($, sessionId)) === id) {
    const known = await read($, dir)
    if (known !== '') return known
  }
  // What this process was recording until now. When that session compacted, this one is its continuation, and it
  // started in the same place, even if the person has since moved into a worktree.
  const before = { dir: await read($, dir), origin: await read($, origin), isCompacted: await read($, isCompacted), id: await read($, sessionId) }
  const previous = before.isCompacted ? before.dir : ''
  const home = (await $.env.get('HOME')) ?? ''
  const cwd = previous !== '' && before.origin !== '' ? before.origin : await $.session.cwd()
  const root = `${home}/.claude/session-state`
  const here = `${root}/${projectOf(cwd)}`
  const id8 = `_${id.slice(0, 8)}`
  const found = await findIn($, root, here, (name, kind) => kind === 'dir' && name.endsWith(id8))
  const folder = found ?? `${here}/${folderName(await dayOf($), id)}`
  const transcript = await readText($, transcriptOf(cwd, id).replace(/^~/, home))
  await update($, sessionId, () => id)
  await update($, dir, () => folder)
  await update($, origin, () => cwd)
  const isContinued = found === undefined && (await inherit($, here, folder, home, transcript, previous))

  let ledger = parseLedger(await readText($, eventsOf(folder)))
  let pending = parsePending(await readText($, pendingOf(folder)))
  let text = await readText($, stateOf(folder))
  const stepsMd = await readText($, stepsOf(folder))
  if (ledger.length === 0 && pending.length === 0) {
    // The turns before the mod met this chat, read back from Claude Code's transcript and queued like live
    // ones. A continuation numbers them on from the steps it was given.
    const past = pastTurns(transcript).map(t => ({ ...t, turn: t.turn + (isContinued ? lastStep(stepsMd) : 0) }))
    if (past.length > 0) {
      const now = await $.clock.now()
      pending = past.slice(-BACKFILL_MAX)
      ledger = pending.map(t => turnRecord(t, now))
      // The transcript is a fuller source than notes seeded from an older version, but not than a parent's ledger.
      if (!isContinued) {
        if (text !== '') await $.fs.write(stateOf(folder), '').catch(quiet)
        text = ''
      }
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
  await update($, steps, () => stepsMd)
  const historyMd = await readText($, historyOf(folder))
  await update($, history, () => historyMd)
  await update($, events, () => ledger)
  await update($, queue, () => pending)
  // pendingUser and facts are not reset: a turn that is running now ends under this id, and they are its.
  if (!isContinued) await update($, failed, () => [])
  await update($, previousAnswer, () => pending.at(-1)?.answer ?? archive.at(-1)?.answer ?? '')
  await update($, turns, () => Math.max(0, ...archive.map(r => r.turn), ...pending.map(t => t.turn), lastStep(stepsMd)))
  // A turn may be being written up right now; isBusy is the drain's to clear.
  await update($, status, s => ({ ...s, message: '' }))
  // A chat that was compacted still owes the agent its digest: under the new id, and after a rebuild (which
  // empties the session id, then boots the same chat again).
  await update($, isCompacted, () => isContinued || (before.isCompacted && before.id === ''))
  return folder
}

// One boot per session id, however many hooks ask at once. A /clear or a resume changes the id.
let booting: { id: string; run: Promise<string> } | undefined

const ensure = async ($: EngineInterface): Promise<string> => {
  const id = await $.session.id()
  if (booting === undefined || booting.id !== id) {
    const run = boot($, id)
    booting = { id, run }
    // A boot that failed is tried again by the next hook, not kept as the answer for the rest of the session.
    run.catch(() => {
      if (booting?.run === run) booting = undefined
    })
  }
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
  // The new events are added to what the atom holds when the write lands: a turn that ends while the last one is
  // being saved adds its record to the same list. The archive is kept inside the engine's file size limit.
  const all = await update($, events, list => fitLedger([...list, ...add]))
  await $.fs.write(eventsOf(await read($, dir)), serializeLedger(all))
  return all
}

const isFailure = (e: LedgerEvent): boolean => e.type === 'extract' && e.error !== undefined

// A turn whose step line is written and whose last run did not fail was recorded before the process stopped (it died
// between the step line and emptying pending.json). Running it again would add its notes a second time.
const isRecorded = (stepsMd: string, all: readonly LedgerEvent[], turn: PendingTurn): boolean => {
  const runs = all.filter((e): e is ExtractEvent => e.type === 'extract' && e.turn === turn.turn && e.turnId === turn.turnId)
  return runs.length > 0 && runs[runs.length - 1]!.error === undefined && hasStep(stepsMd, turn.turn)
}

// A /clear, a resume or a compaction moves the process to another chat while a turn is still being recorded.
const isHere = async ($: EngineInterface, folder: string): Promise<boolean> => (await read($, dir)) === folder

// Says whether the turn is done. It is not when the chat moved to a new session id while Haiku was writing it up:
// nothing is written then, and the turn stays queued in the folder that has it (a compaction's new session has
// inherited that queue, so it is handled again there).
const handle = async ($: EngineInterface, config: Config, turn: PendingTurn, folder: string): Promise<boolean> => {
  const state = loadState(await readText($, stateOf(folder)), await frontOf($))
  const stepsMd = await readText($, stepsOf(folder))
  const all = await read($, events)
  if (isRecorded(stepsMd, all, turn)) return true
  // A turn read back from the transcript sees only the turns before it, as it would have live.
  const ledger = all.filter(e => e.type !== 'turn' || e.turn <= turn.turn)

  const outcome = await processTurn(
    hostOf($, config),
    config,
    { state, steps: stepLines(stepsMd), archive: archivedTurns(ledger), files: ranked(state, ledger, turn.turn) },
    turn,
  )
  if (!(await isHere($, folder))) return false

  // The state and the step line matter more than the archive: a failed write of it must not stop them.
  await saveEvents($, outcome.events).catch(quiet)
  const out = renderState(outcome.state, ranked(outcome.state, ledger, turn.turn))
  await $.fs.write(stateOf(folder), out)
  await update($, md, () => out)
  if (outcome.moved.length > 0) {
    const before = await readText($, historyOf(folder))
    const blocks = outcome.moved.map(historyBlock).join('\n\n')
    const nextHistory = `${before === '' ? HISTORY_HEAD : before}\n${blocks}\n`
    await $.fs.write(historyOf(folder), nextHistory)
    await update($, history, () => nextHistory)
  }
  const nextSteps = appendStep(stepsMd, outcome.step)
  if (nextSteps !== stepsMd) await $.fs.write(stepsOf(folder), nextSteps)
  await update($, steps, () => nextSteps)
  await writeIndex($, folder, outcome.state, stepLines(nextSteps).length).catch(quiet)
  if (outcome.events.some(isFailure)) await update($, failed, list => [...list, turn].slice(-MAX_FAILED))
  return true
}

// Runs outside any hook's budget, one turn at a time, so the next prompt is never held up.
const drain = async ($: EngineInterface, config: Config): Promise<void> => {
  // The loop is claimed in one step on the busy flag itself: of two wake-ups at once, one gets it, so a turn is
  // never recorded twice.
  let isClaimed = false
  await update($, status, s => {
    isClaimed = !s.isBusy
    return isClaimed ? { ...s, isBusy: true } : s
  })
  if (!isClaimed) return
  try {
    for (;;) {
      // The queue in the atoms is the loaded chat's, and so is the folder: both are read again for each turn.
      const folder = await read($, dir)
      const next = (await read($, queue))[0]
      if (next === undefined) break
      await update($, status, s => ({ ...s, turn: next.turn }))
      let isDone = true
      try {
        isDone = await handle($, config, next, folder)
        await update($, status, s => ({ ...s, message: '' }))
      } catch (err) {
        if (!(await isHere($, folder))) continue
        await update($, status, s => ({ ...s, message: `error: ${String(err).slice(0, 140)}` }))
        await update($, failed, list => [...list, next].slice(-MAX_FAILED))
      }
      if (isDone) await update($, queue, list => list.slice(1))
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

// The panel follows the files, so a hand edit, a rollback or a rebuild shows within seconds. A read that fails
// comes back empty: a file the panel holds is let go only after two empty reads in a row.
const empties = new Map<string, number>()

const hasChanged = (path: string, held: string, text: string): boolean => {
  const misses = text === '' && held !== '' ? (empties.get(path) ?? 0) + 1 : 0
  empties.set(path, misses)
  return misses !== 1 && text !== held
}

const syncPanel = async ($: EngineInterface): Promise<void> => {
  // The atoms are read first: a turn that lands while the files are read changes them, and then the turn wins.
  const held = { md: await read($, md), steps: await read($, steps), history: await read($, history) }
  const folder = await read($, dir)
  if (folder === '') return
  const disk = { md: await readText($, stateOf(folder)), steps: await readText($, stepsOf(folder)), history: await readText($, historyOf(folder)) }
  if (hasChanged(stateOf(folder), held.md, disk.md)) await update($, md, now => (now === held.md ? disk.md : now))
  if (hasChanged(stepsOf(folder), held.steps, disk.steps)) await update($, steps, now => (now === held.steps ? disk.steps : now))
  if (hasChanged(historyOf(folder), held.history, disk.history)) await update($, history, now => (now === held.history ? disk.history : now))
}

// Empty when the ledger has nothing to hand over.
const digestOf = async ($: EngineInterface): Promise<string> => {
  const folder = await ensure($)
  const state = loadState(await read($, md), await frontOf($))
  const ledger = await read($, events)
  const stepsMd = await read($, steps)
  // The queue still holds the turns Haiku has not finished, so the ledger leaves them out.
  const unrecorded = (await read($, queue)).filter(t => !hasStep(stepsMd, t.turn)).map(t => ({ turn: t.turn, user: t.user }))
  return digestText(state, stepLines(stepsMd), ranked(state, ledger, await read($, turns)), folder, undefined, unrecorded)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-state',
      description: 'The ledger of this chat: open the panel (steps, ledger, stats), pause, retry, rebuild',
    }).catch(quiet)
    await ensure($).catch(quiet)
    // The session starts, or the module reloaded: either way no loop of this copy is recording, whatever the
    // atoms kept from the copy before. Without this a recording that the reload cut short blocks the queue for good.
    await update($, status, () => ({ isBusy: false, turn: 0, message: '' })).catch(quiet)
    if ((await read($, queue)).length > 0) kick($, options)
    // Picks up the person's hand edits for the panel and wakes a stranded queue.
    $.clock.every(3000, async () => {
      await syncPanel($).catch(quiet)
      if ((await read($, queue)).length > 0 && !(await read($, status)).isBusy) kick($, options)
    })
    if (options.openPanelOnStart === true) void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear starts a chat of its own: a compaction before it does not carry over to the new id.
    if (e.reason === 'clear') await update($, isCompacted, () => false).catch(quiet)
    await flush($, options).catch(quiet)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Typed by the person: at the keyboard, from a phone or from the SDK. Not a task notification, a
    // schedule, a peer or another plugin.
    const kind = e.origin?.kind
    const isTyped = kind === undefined || kind === 'composer' || kind === 'bridge' || kind === 'sdk'
    if (!isTyped || e.command !== undefined || e.isMeta === true || e.text.trim() === '' || (await read($, isPaused))) return next(e)
    let digest = ''
    try {
      await ensure($)
      await update($, pendingUser, p => (p === '' ? e.text : `${p}\n\n${e.text}`))
      if (await read($, isCompacted)) {
        digest = await digestOf($)
        await update($, isCompacted, () => false)
      }
    } catch {
      // never block a prompt
    }
    const out = await next(digest === '' ? e : { ...e, context: [...(e.context ?? []), digest] })
    if (out.drop !== undefined) {
      // Dropped beneath: the agent never saw it. It is not something the person asked, and the next typed
      // prompt carries the digest.
      await update($, pendingUser, p => (p === e.text ? '' : p.endsWith(`\n\n${e.text}`) ? p.slice(0, -(e.text.length + 2)) : p)).catch(quiet)
      if (digest !== '') await update($, isCompacted, () => true).catch(quiet)
    }
    return out
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
      await update($, isHistoryShown, () => false)
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
      const home = (await $.env.get('HOME')) ?? ''
      const transcript = await readText($, ((await frontOf($)).transcript ?? '').replace(/^~/, home))
      // Nothing is set aside unless the transcript has turns to rebuild the ledger from.
      if (pastTurns(transcript).length === 0) return { text: 'No earlier turns in the transcript to rebuild from. The ledger is unchanged.' }
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
      return { text: `Rebuilding the ledger from the transcript: ${queued} turns queued. The old files are in before-rebuild/.` }
    }
    if (arg === 'path') return { text: await ensure($) }
    if (arg === 'digest') return { text: (await digestOf($)) || 'Nothing in the ledger yet, so a compaction would hand the agent nothing.' }
    const chosen = TABS.find(t => t === arg)
    if (chosen !== undefined) {
      await update($, tab, () => chosen)
      await update($, isHistoryShown, () => false)
    }
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
      const text = (isHistory ? await read($, history) : await read($, md)).replace(/^---\n[\s\S]*?\n---\n?/, '')
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
