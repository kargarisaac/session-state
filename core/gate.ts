import { tidy } from './redact'
import type { Config, GateEvent, Host, Turn } from './types'

const ENDPOINT = 'https://openrouter.ai/api/v1/systemone'

export const GATE_INSTRUCTIONS =
  'Did the user, in this turn, say something that will still matter about 50 turns later in this chat? ' +
  'That means a decision, a constraint or requirement, a preference, a correction or reversal, a scope limit, ' +
  'an always/never/from-now-on rule, or a standing request the agent could drop. ' +
  "Judge the user's words; the agent's reply is only context."

export const GATE_CRITERIA = {
  true: 'The user sets, changes or reverses a lasting decision, requirement, preference or scope, or makes a standing request.',
  false: 'The user gives a one-off command, asks a question, shares information for the current step only, or just acknowledges.',
}

// Jev reads at most ~32k bytes before it switches to a slower mode: stay well under.
const USER_CHARS = 8000
const ANSWER_CHARS = 6000

export const gateState = (turn: Turn): string =>
  `User: ${tidy(turn.user, USER_CHARS)}\n\nAgent: ${tidy(turn.answer, ANSWER_CHARS)}`

export const gateBody = (model: string, turn: Turn): string =>
  JSON.stringify({
    model,
    state: gateState(turn),
    questions: { important: { type: 'noul', instructions: GATE_INSTRUCTIONS, criteria: GATE_CRITERIA } },
  })

export type GateAnswer = { p: number; model: string; inputTokens: number; cost: number }

export const parseGate = (text: string): GateAnswer | { error: string } => {
  try {
    const json = JSON.parse(text)
    const p = json?.answers?.important?.noul
    if (typeof p !== 'number' || p < 0 || p > 1) return { error: 'no probability in the answer' }
    return {
      p,
      model: String(json.model ?? ''),
      inputTokens: Number(json.usage?.input_tokens ?? 0),
      cost: Number(json.usage?.cost ?? 0),
    }
  } catch {
    return { error: 'answer is not JSON' }
  }
}

export type GateVerdict = { event: GateEvent; isPassed: boolean }

export const runGate = async (host: Host, config: Config, turn: Turn): Promise<GateVerdict> => {
  const start = await host.now()
  const base = { type: 'gate' as const, at: start, turn: turn.turn, turnId: turn.turnId, model: config.jevModel }
  const done = (event: Partial<GateEvent> & Pick<GateEvent, 'action'>, isPassed: boolean): GateVerdict => ({
    event: { ...base, p: null, ms: 0, inputTokens: 0, cost: 0, ...event },
    isPassed,
  })

  if (config.gate === 'off') return done({ action: 'off' }, true)
  if (config.jevKey === '') return done({ action: 'error', error: 'no OpenRouter key' }, false)

  try {
    const res = await host.post(
      ENDPOINT,
      { Authorization: `Bearer ${config.jevKey}`, 'Content-Type': 'application/json' },
      gateBody(config.jevModel, turn),
    )
    const ms = (await host.now()) - start
    if (res.status < 200 || res.status >= 300) return done({ action: 'error', ms, error: `jev status ${res.status}` }, false)
    const answer = parseGate(res.text)
    if ('error' in answer) return done({ action: 'error', ms, error: answer.error }, false)
    const isPassed = answer.p >= config.threshold
    const isAudit = !isPassed && config.auditRate > 0 && host.random() < config.auditRate
    return done(
      {
        p: answer.p,
        model: answer.model || config.jevModel,
        ms,
        inputTokens: answer.inputTokens,
        cost: answer.cost,
        action: isPassed ? 'extract' : isAudit ? 'audit' : 'skip',
      },
      isPassed || isAudit,
    )
  } catch (err) {
    return done({ action: 'error', error: `jev call failed: ${String(err).slice(0, 120)}` }, false)
  }
}
