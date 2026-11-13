import { contextText } from './context'
import type { TurnContext } from './context'
import { checkDone, checkFileRoles, checkLearnings, checkMemories, checkStep, isQuoteOf, parseExtraction, systemPrompt } from './extract'
import type { Extraction, Mode } from './extract'
import { factsText } from './facts'
import { runGate } from './gate'
import { addUsage, emptyUsage, recentTopics } from './ledger'
import { activeNotes, applyMemories, openAsks } from './notes'
import { applyFileRoles, applyLearnings, learnLabel, noteLabel, topicNames } from './state'
import { redact } from './redact'
import { viaOf } from './transcript'
import type { CompleteResult, Config, ExtractEvent, FileEntry, Host, LedgerEvent, Moved, State, Step, Turn, TurnRecord } from './types'

export type Ledger = { state: State; steps: readonly string[]; archive: readonly TurnRecord[]; files: readonly FileEntry[]; events?: readonly LedgerEvent[] }

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
  const events = (ledger.events ?? []).filter(e => e.type !== 'extract' || e.turn < turn.turn)
  const base: TurnContext = { state, steps: ledger.steps, earlier, files: ledger.files, turn, topics: recentTopics(events, 3).filter(t => topicNames(state).includes(t)) }
  const system = systemPrompt(mode, config.maxWords)
  const effort = mode === 'extract' ? config.effort : 'low'
  const start = await host.now()
  let usage = emptyUsage()
  let failure = ''
  let calls = 0
  const maxTokens = mode === 'extract' ? 12000 : 2000
  const f = turn.facts
  const trivial = gate.event.action === 'skip' && f.edited.length === 0 && f.commands === 0 && f.failures.length === 0 && Object.values(f.tools ?? {}).every(n => n === 0) && turn.answer.length < 1500

  const ask = async (prompt: string): Promise<Extraction | undefined> => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      let reply: CompleteResult
      try {
        calls++
        reply = await host.complete({ system, prompt, effort, maxTokens: Math.min(16000, maxTokens * 2 ** attempt) })
      } catch (err) {
        reply = { isOk: false, reason: `threw ${String(err).slice(0, 120)}`, usage: emptyUsage() }
      }
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
  let got = trivial ? undefined : await ask(contextText(context, mode))
  // One look further back, only when Haiku names an archived turn it was not shown in full.
  const need = mode === 'extract' ? got?.need : undefined
  const looked = need === undefined ? undefined : earlier.find(r => r.turn === need)
  const needTopic = mode === 'extract' && got?.needTopic !== undefined && topicNames(state).includes(got.needTopic) && !base.topics?.includes(got.needTopic) ? got.needTopic : undefined
  if (looked !== undefined || needTopic !== undefined) {
    context = { ...base, looked, topics: needTopic === undefined ? base.topics : [...(base.topics ?? []), needTopic] }
    got = (await ask(contextText(context, mode))) ?? got
  }

  const active = activeNotes(state)
  const dropped: string[] = []
  const memories = got === undefined || mode === 'summarize' ? undefined : checkMemories(got.memories, turn.user, active, config.maxWords, turn.turn)
  dropped.push(...(memories?.dropped ?? []))

  const done = got === undefined ? [] : checkDone(got.done, openAsks(state))
  const learned = got === undefined ? { kept: [], dropped: [] } : checkLearnings(got.learnings, turn.answer, turn.facts, state.learnings)
  dropped.push(...learned.dropped)
  const roles = got === undefined ? [] : checkFileRoles(got.files, turn.facts.edited, cwd)

  const restates = mode === 'extract' ? (got?.restates ?? []).filter(r => isQuoteOf(r.quote, turn.user) || isQuoteOf(r.quote, redact(turn.user))).map(r => r.id) : []
  const notes = applyMemories(state, memories?.kept ?? [], turn.turn, turn.turnId, got?.title ?? '', done, viaOf(turn.user), restates)
  const withLearnings = applyLearnings(notes.state, learned.kept, turn.turn)
  const withRoles = applyFileRoles(withLearnings.state, roles)
  const next = got?.now === undefined ? withRoles : { ...withRoles, now: got.now }
  const moved = [...notes.moved, ...withLearnings.moved]

  const firstNote = Number(state.front.next_id) || 1
  const firstLearning = Number(state.front.next_learning) || 1
  const added = [
    ...next.notes.filter(n => n.turn === turn.turn && n.id >= firstNote).map(n => noteLabel(n.id)),
    ...next.learnings.filter(l => l.turn === turn.turn && l.id >= firstLearning).map(l => learnLabel(l.id)),
  ]
  const step: Step = {
    turn: turn.turn,
    outcome: turn.isAborted ? 'aborted' : trivial ? 'ok' : got === undefined ? 'unrecorded' : got.step.outcome,
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
    calls,
    ms: (await host.now()) - start,
    usage,
    kept: memories?.kept.length ?? 0,
    learned: learned.kept.length,
    closed: done.length,
    roles: roles.length,
    ...(looked === undefined ? {} : { need: looked.turn }),
    ...(got === undefined ? {} : { topics: got.topics }),
    dropped,
    ...(got === undefined && !trivial ? { error: failure } : {}),
  }
  return { state: next, moved, step, events: [gate.event, event] }
}
