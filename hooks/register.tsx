import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { parseLedger, parsePending, serializeLedger, serializePending, summarize } from '../core/ledger'
import { isNote, newDoc, parseDoc, pointerText, renderDoc, rulesText, upsertIndex } from '../core/notes'
import { processTurn } from '../core/pipeline'
import type { Config, Doc } from '../core/types'
import type { LedgerEvent, PendingTurn, Status } from '../types'
import { gateLines, rows } from './format'
import { configOf, hostOf } from './host'
import { baseOf, dirOf, fileName, metricsOf, pendingOf, projectOf, transcriptOf } from './paths'

const PANE = 'session-state'
const TITLE = 'Session notes'
const MAX_FAILED = 5

const sessionId = atom({ plugin: 'session-state', key: 'sessionId' } as const, '')
const file = atom({ plugin: 'session-state', key: 'file' } as const, '')
// Where the chat started. The session's own directory moves when the person enters a worktree.
const origin = atom({ plugin: 'session-state', key: 'origin' } as const, '')
const md = atom({ plugin: 'session-state', key: 'md' } as const, '')
const events = atom({ plugin: 'session-state', key: 'events' } as const, [] as LedgerEvent[])
const queue = atom({ plugin: 'session-state', key: 'queue' } as const, [] as PendingTurn[])
const failed = atom({ plugin: 'session-state', key: 'failed' } as const, [] as PendingTurn[])
const pendingUser = atom({ plugin: 'session-state', key: 'pendingUser' } as const, '')
const previousAnswer = atom({ plugin: 'session-state', key: 'previousAnswer' } as const, '')
const turns = atom({ plugin: 'session-state', key: 'turns' } as const, 0)
const status = atom({ plugin: 'session-state', key: 'status' } as const, { isBusy: false, turn: 0, message: '' } as Status)
const isPaused = atom({ plugin: 'session-state', key: 'isPaused' } as const, false)

// Bookkeeping never fails the event it watches.
const quiet = () => undefined

const readText = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

const findNote = async ($: EngineInterface, dir: string, tail: string): Promise<string | undefined> => {
  try {
    return (await $.fs.list(dir)).find(entry => entry.kind === 'file' && entry.name.endsWith(tail))?.name
  } catch {
    return undefined
  }
}

// The folder of this chat's project first, then every other project: a resumed chat may start elsewhere.
const findFile = async ($: EngineInterface, root: string, dir: string, tail: string): Promise<string | undefined> => {
  const here = await findNote($, dir, tail)
  if (here !== undefined) return `${dir}/${here}`
  try {
    for (const entry of await $.fs.list(root)) {
      const found = entry.kind === 'dir' ? await findNote($, `${root}/${entry.name}`, tail) : undefined
      if (found !== undefined) return `${root}/${entry.name}/${found}`
    }
  } catch {
    // no folder yet: this session starts it
  }
  return undefined
}

const dayOf = async ($: EngineInterface): Promise<string> => new Date(await $.clock.now()).toISOString().slice(0, 10)

const boot = async ($: EngineInterface, id: string): Promise<string> => {
  if ((await read($, sessionId)) === id) {
    const known = await read($, file)
    if (known !== '') return known
  }
  const home = (await $.env.get('HOME')) ?? ''
  const cwd = await $.session.cwd()
  const root = `${home}/.claude/session-state`
  const dir = `${root}/${projectOf(cwd)}`
  const path = (await findFile($, root, dir, `_${id.slice(0, 8)}.md`)) ?? `${dir}/${fileName(await dayOf($), id)}`
  const ledger = parseLedger(await readText($, metricsOf(path)))
  await update($, sessionId, () => id)
  await update($, file, () => path)
  await update($, origin, () => cwd)
  await update($, md, () => '')
  await update($, events, () => ledger)
  const pending = parsePending(await readText($, pendingOf(path)))
  await update($, queue, () => pending)
  await update($, failed, () => [])
  await update($, pendingUser, () => '')
  await update($, previousAnswer, () => '')
  await update($, turns, () => Math.max(ledger.filter(e => e.type === 'gate').length, ...pending.map(t => t.turn)))
  await update($, status, () => ({ isBusy: false, turn: 0, message: '' }))
  await update($, md, () => '')
  const text = await readText($, path)
  if (text !== '') await update($, md, () => text)
  return path
}

// One boot per session id, however many hooks ask at once. A /clear or a resume changes the id.
let booting: { id: string; run: Promise<string> } | undefined

const ensure = async ($: EngineInterface): Promise<string> => {
  const id = await $.session.id()
  if (booting === undefined || booting.id !== id) booting = { id, run: boot($, id) }
  return booting.run
}

const writeIndex = async ($: EngineInterface, path: string, doc: Doc): Promise<void> => {
  const notes = doc.items.filter(isNote)
  const indexPath = `${dirOf(path)}/INDEX.md`
  const next = upsertIndex(await readText($, indexPath), doc.front.project ?? '', {
    file: baseOf(path),
    date: baseOf(path).slice(0, 10),
    title: doc.front.title ?? '',
    active: notes.filter(n => n.status === 'active').length,
    done: notes.filter(n => n.status === 'done').length,
    superseded: notes.filter(n => n.status === 'superseded').length,
  })
  await $.fs.write(indexPath, next)
}

const savePending = async ($: EngineInterface): Promise<void> => {
  await $.fs.write(pendingOf(await read($, file)), serializePending(await read($, queue)))
}

// A failed look at the agent's reply loses no note, so it never asks for a retry.
const isFailure = (e: LedgerEvent): boolean => (e.type === 'gate' ? e.action === 'error' : e.type === 'extract' && e.error !== undefined)

const handle = async ($: EngineInterface, config: Config, turn: PendingTurn): Promise<void> => {
  const path = await read($, file)
  const id = await read($, sessionId)
  const cwd = (await read($, origin)) || (await $.session.cwd())
  const text = await readText($, path)
  const base = newDoc({ sessionId: id, project: projectOf(cwd), cwd, started: await dayOf($), transcript: transcriptOf(cwd, id) })
  // The file is the truth: read it back each turn so the person's edits stand.
  const parsed = text === '' ? base : parseDoc(text)
  const doc: Doc = text === '' ? base : { front: { ...base.front, ...parsed.front }, items: parsed.items }

  const outcome = await processTurn(hostOf($, config), config, doc, turn)

  const all = [...(await read($, events)), ...outcome.events]
  await update($, events, () => all)
  await $.fs.write(metricsOf(path), serializeLedger(all))
  if (outcome.doc !== doc) {
    const out = renderDoc(outcome.doc)
    await $.fs.write(path, out)
    await update($, md, () => out)
    await writeIndex($, path, outcome.doc).catch(quiet)
  }
  if (outcome.events.some(isFailure)) await update($, failed, list => [...list, turn].slice(-MAX_FAILED))
}

// Runs outside any hook's budget, one turn at a time, so the next prompt is never held up.
const drain = async ($: EngineInterface, config: Config): Promise<void> => {
  if ((await read($, status)).isBusy) return
  await update($, status, s => ({ ...s, isBusy: true }))
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

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'session-state', description: 'Notes of what you asked and decided in this chat: open the panel, pause, retry' }).catch(quiet)
    await ensure($).catch(quiet)
    if ((await read($, queue)).length > 0) kick($, options)
    // Picks up the person's hand edits for the panel and wakes a stranded queue.
    $.clock.every(3000, async () => {
      const path = await read($, file)
      if (path !== '') {
        const text = await readText($, path)
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
    if (isTyped && e.command === undefined && e.isMeta !== true && e.text.trim() !== '' && !(await read($, isPaused))) {
      await ensure($).catch(quiet)
      await update($, pendingUser, p => (p === '' ? e.text : `${p}\n\n${e.text}`)).catch(quiet)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        const user = await read($, pendingUser)
        if (user.trim() !== '' && !(await read($, isPaused))) {
          const n = (await read($, turns)) + 1
          const turn: PendingTurn = {
            turn: n,
            turnId: e.turnId,
            user,
            answer: e.answer,
            previousAnswer: await read($, previousAnswer),
            isAborted: e.isAborted,
          }
          await update($, turns, () => n)
          await update($, queue, q => [...q, turn])
          await savePending($).catch(quiet)
          kick($, options)
        }
        if (e.answer !== '') await update($, previousAnswer, () => e.answer)
        await update($, pendingUser, () => '')
      } catch {
        // never fail the turn's end
      }
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    try {
      const path = await ensure($)
      const sections = [...out.sections, { id: 'session-state:notes', text: pointerText(path), scope: 'session' as const }]
      if ((await configOf($, options)).pinRules) {
        const rules = rulesText(parseDoc(await readText($, path)))
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
      return { text: 'Session notes panel closed.' }
    }
    if (arg === 'pause' || arg === 'resume') {
      await update($, isPaused, () => arg === 'pause')
      return { text: arg === 'pause' ? 'Session notes paused: new turns are not recorded.' : 'Session notes resumed.' }
    }
    if (arg === 'retry') {
      const again = await read($, failed)
      await update($, failed, () => [])
      await update($, queue, q => [...q, ...again])
      await savePending($).catch(quiet)
      kick($, options)
      return { text: `Retrying ${again.length} turn${again.length === 1 ? '' : 's'}.` }
    }
    if (arg === 'path') return { text: await ensure($) }
    await ensure($).catch(quiet)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Session notes panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const config = await configOf($, options)
    const path = await read($, file)
    const text = await read($, md)
    const stats = summarize(await read($, events))
    const doc = parseDoc(text)
    const notes = doc.items.filter(isNote)
    const panel = rows({
      stats,
      active: notes.filter(n => n.status === 'active').length,
      done: notes.filter(n => n.status === 'done').length,
      superseded: notes.filter(n => n.status === 'superseded').length,
      config,
      status: await read($, status),
      isPaused: await read($, isPaused),
      failed: (await read($, failed)).length,
    })
    const recent = gateLines(stats)
    return (
      <Box flexDirection="column">
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
          {path === '' ? 'No file yet' : path}
        </Text>
        <Box>
          <Button key="copy" label="Copy path" onPress={() => void $.ui.copy({ text: path, surface: e.surface })} />
          <Button
            key="pause"
            label={(await read($, isPaused)) ? 'Resume' : 'Pause'}
            onPress={() => void update($, isPaused, p => !p)}
          />
        </Box>
        <Markdown text={text === '' ? '_No notes yet._' : text} />
      </Box>
    )
  })
}
