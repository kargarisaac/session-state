import { contextText } from './context'
import type { TurnContext } from './context'
import { checkDone, checkFileRoles, checkLearnings, checkMemories, checkStep, parseExtraction, systemPrompt } from './extract'
import type { Extraction, Mode } from './extract'
import { factsText } from './facts'
import { runGate } from './gate'
import { addUsage, emptyUsage } from './ledger'
import { activeNotes, applyMemories, openAsks } from './notes'
import { applyFileRoles, applyLearnings, learnLabel, noteLabel } from './state'
import type { Config, ExtractEvent, FileEntry, Host, LedgerEvent, Moved, State, Step, Turn, TurnRecord } from './types'

export type Ledger = { state: State; steps: readonly string[]; archive: readonly TurnRecord[]; files: readonly FileEntry[] }

export type Outcome = { state: State; moved: Moved[]; step: Step; events: LedgerEvent[] }

const ATTEMPTS = 2

// One Haiku call per turn. Summarization always: the step line, finished asks, file roles and learnings.
// Extraction too when Jev says the user said something lasting (or Jev is off or failed): the notes.
// Never throws: a failure becomes an event, and the step line falls back to the user's first words.
export const processTurn = async (host: Host, config: Config, ledger: Ledger, turn: Turn): Promise<Outcome> => {
  const gate = await runGate(host, config, turn)
  const mode: Mode = gate.isPassed || gate.event.action === 'error' ? 'extract' : 'summarize'
  const { state } = ledger
  const cwd = state.front.cwd ?? ''
  const earlier = ledger.archive.filter(r => r.turn < turn.turn)
  const base: TurnContext = { state, steps: ledger.steps, earlier, files: ledger.files, turn }
  const system = systemPrompt(mode, config.maxWords)
  const effort = mode === 'extract' ? config.effort : 'low'
  const start = await host.now()
  let usage = emptyUsage()
  let failure = ''

  const ask = async (prompt: string): Promise<Extraction | undefined> => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const reply = await host.complete({ system, prompt, effort })
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

  let context = base
  let got = await ask(contextText(context))
  // One look further back, only when Haiku names an archived turn it was not shown in full.
  const need = mode === 'extract' ? got?.need : undefined
  const looked = need === undefined ? undefined : earlier.find(r => r.turn === need)
  if (looked !== undefined) {
    context = { ...base, looked }
    got = (await ask(contextText(context))) ?? got
  }

  const active = activeNotes(state)
  const dropped: string[] = []
  let memories = got === undefined || mode === 'summarize' ? undefined : checkMemories(got.memories, turn.user, active, config.maxWords, turn.turn)
  if (got !== undefined && memories !== undefined && memories.overLong.length > 0) {
    const list = memories.overLong.map(m => `"${m.text}"`).join('; ')
    const again = await ask(
      `${contextText(context)}\n\nThese notes were over ${config.maxWords} words: ${list}. Reply with the full JSON again, every note at most ${config.maxWords} words.`,
    )
    if (again !== undefined) {
      got = { ...again, step: again.step.text === '' ? got.step : again.step }
      memories = checkMemories(again.memories, turn.user, active, config.maxWords, turn.turn)
    }
    dropped.push(...memories.overLong.map(m => `too long: ${m.text.slice(0, 40)}`))
  }
  dropped.push(...(memories?.dropped ?? []))

  const done = got === undefined ? [] : checkDone(got.done, openAsks(state))
  const learned = got === undefined ? { kept: [], dropped: [] } : checkLearnings(got.learnings, turn.answer, turn.facts, state.learnings)
  dropped.push(...learned.dropped)
  const roles = got === undefined ? [] : checkFileRoles(got.files, turn.facts.edited, cwd)

  const notes = applyMemories(state, memories?.kept ?? [], turn.turn, turn.turnId, got?.title ?? '', done)
  const withLearnings = applyLearnings(notes.state, learned.kept, turn.turn)
  const next = applyFileRoles(withLearnings.state, roles)
  const moved = [...notes.moved, ...withLearnings.moved]

  const firstNote = Number(state.front.next_id) || 1
  const firstLearning = Number(state.front.next_learning) || 1
  const added = [
    ...next.notes.filter(n => n.turn === turn.turn && n.id >= firstNote).map(n => noteLabel(n.id)),
    ...next.learnings.filter(l => l.turn === turn.turn && l.id >= firstLearning).map(l => learnLabel(l.id)),
  ]
  const step: Step = {
    turn: turn.turn,
    outcome: turn.isAborted ? 'aborted' : (got?.step.outcome ?? 'ok'),
    text: checkStep(got?.step.text ?? '', turn.user),
    facts: factsText(turn.facts, cwd),
    added,
    done: done.map(noteLabel),
  }
  const event: ExtractEvent = {
    type: 'extract',
    at: start,
    turn: turn.turn,
    turnId: turn.turnId,
    model: config.haikuModel,
    mode,
    ms: (await host.now()) - start,
    usage,
    kept: memories?.kept.length ?? 0,
    learned: learned.kept.length,
    closed: done.length,
    roles: roles.length,
    ...(looked === undefined ? {} : { need: looked.turn }),
    dropped,
    ...(got === undefined ? { error: failure } : {}),
  }
  return { state: next, moved, step, events: [gate.event, event] }
}
