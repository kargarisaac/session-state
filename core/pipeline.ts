import { checkMemories, parseExtraction, systemPrompt, userPrompt } from './extract'
import type { Extraction } from './extract'
import { runGate } from './gate'
import { addUsage, emptyUsage } from './ledger'
import { activeNotes, applyMemories } from './notes'
import type { Config, Doc, ExtractEvent, Host, LedgerEvent, Turn } from './types'

export type Outcome = { doc: Doc; events: LedgerEvent[] }

const ATTEMPTS = 2

// Gate, then extract, then check in code, then write. Never throws: a failure becomes an event.
export const processTurn = async (host: Host, config: Config, doc: Doc, turn: Turn): Promise<Outcome> => {
  const gate = await runGate(host, config, turn)
  if (!gate.isPassed) return { doc, events: [gate.event] }

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

  const finish = async (fields: Pick<ExtractEvent, 'kept' | 'dropped'> & { error?: string }): Promise<ExtractEvent> => ({
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
    }
  }

  const next =
    checked.kept.length > 0 ? applyMemories(doc, checked.kept, turn.turn, title) : doc
  return { doc: next, events: [gate.event, await finish({ kept: checked.kept.length, dropped })] }
}
