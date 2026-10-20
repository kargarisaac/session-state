import { checkDone, checkMemories, closePrompt, closeSystem, parseClose, parseExtraction, systemPrompt, userPrompt } from './extract'
import type { Extraction } from './extract'
import { runGate } from './gate'
import { addUsage, emptyUsage } from './ledger'
import { activeNotes, applyMemories, openAsks } from './notes'
import type { CloseEvent, Config, Doc, ExtractEvent, GateEvent, Host, LedgerEvent, Turn } from './types'

export type Outcome = { doc: Doc; events: LedgerEvent[] }

const ATTEMPTS = 2
// A shorter reply than this cannot report finished work.
const MIN_ANSWER_CHARS = 60

// The gate skipped the turn: the person said nothing lasting, but the agent may have finished an open
// request. One cheap look at its reply, only when there is something open.
const closeAsks = async (host: Host, config: Config, doc: Doc, turn: Turn, gate: GateEvent): Promise<Outcome> => {
  const open = openAsks(doc)
  if (open.length === 0 || turn.isAborted || turn.answer.trim().length < MIN_ANSWER_CHARS) return { doc, events: [gate] }
  const start = await host.now()
  const reply = await host.complete({ system: closeSystem(), prompt: closePrompt(turn, open), effort: 'low' })
  const event = async (fields: Pick<CloseEvent, 'closed'> & { error?: string }): Promise<CloseEvent> => ({
    type: 'close',
    at: start,
    turn: turn.turn,
    turnId: turn.turnId,
    model: config.haikuModel,
    ms: (await host.now()) - start,
    usage: reply.usage,
    ...fields,
  })
  if (!reply.isOk) return { doc, events: [gate, await event({ closed: 0, error: `haiku: ${reply.reason}` })] }
  const parsed = parseClose(reply.text)
  if ('error' in parsed) return { doc, events: [gate, await event({ closed: 0, error: `haiku reply: ${parsed.error}` })] }
  const done = checkDone(parsed.done, open)
  const next = done.length > 0 ? applyMemories(doc, [], turn.turn, '', done) : doc
  return { doc: next, events: [gate, await event({ closed: done.length })] }
}

// Gate, then extract, then check in code, then write. Never throws: a failure becomes an event.
export const processTurn = async (host: Host, config: Config, doc: Doc, turn: Turn): Promise<Outcome> => {
  const gate = await runGate(host, config, turn)
  if (!gate.isPassed) {
    return gate.event.action === 'skip' ? closeAsks(host, config, doc, turn, gate.event) : { doc, events: [gate.event] }
  }

  const start = await host.now()
  const active = activeNotes(doc)
  const system = systemPrompt(config.maxWords)
  const prompt = userPrompt(turn, active, doc.front.title ?? '')
  let usage = emptyUsage()
  let failure = ''

  const ask = async (text: string): Promise<Extraction | undefined> => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const reply = await host.complete({ system, prompt: text })
      usage = addUsage(usage, reply.usage)
      if (!reply.isOk) {
        failure = `haiku: ${reply.reason}`
        continue
      }
      const parsed = parseExtraction(reply.text)
      if ('error' in parsed) {
        failure = `haiku reply: ${parsed.error}`
        continue
      }
      return parsed
    }
    return undefined
  }

  const finish = async (fields: Pick<ExtractEvent, 'kept' | 'dropped'> & { closed?: number; error?: string }): Promise<ExtractEvent> => ({
    type: 'extract',
    at: start,
    turn: turn.turn,
    turnId: turn.turnId,
    model: config.haikuModel,
    ms: (await host.now()) - start,
    usage,
    ...fields,
  })

  const first = await ask(prompt)
  if (first === undefined) {
    return { doc, events: [gate.event, await finish({ kept: 0, dropped: [], error: failure })] }
  }

  let checked = checkMemories(first.memories, turn.user, active, config.maxWords)
  let title = first.title
  let done = checkDone(first.done, openAsks(doc))
  const dropped = [...checked.dropped]

  if (checked.overLong.length > 0) {
    const list = checked.overLong.map(m => `"${m.text}"`).join('; ')
    const again = await ask(
      `${prompt}\n\nThese notes were over ${config.maxWords} words: ${list}. Reply with the full JSON again, every note at most ${config.maxWords} words.`,
    )
    if (again === undefined) {
      dropped.push(...checked.overLong.map(m => `too long: ${m.text.slice(0, 40)}`))
      checked = { ...checked, overLong: [] }
    } else {
      const second = checkMemories(again.memories, turn.user, active, config.maxWords)
      dropped.length = 0
      dropped.push(...second.dropped, ...second.overLong.map(m => `too long: ${m.text.slice(0, 40)}`))
      checked = { kept: second.kept, overLong: [], dropped: second.dropped }
      title = again.title || title
      done = checkDone(again.done, openAsks(doc))
    }
  }

  const next = checked.kept.length > 0 || done.length > 0 ? applyMemories(doc, checked.kept, turn.turn, title, done) : doc
  return { doc: next, events: [gate.event, await finish({ kept: checked.kept.length, dropped, closed: done.length })] }
}
