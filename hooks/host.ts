import type { EngineInterface, PluginOptions } from 'claude-code'

import { DEFAULTS } from '../core/types'
import type { Config, Host } from '../core/types'

const text = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback)
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export async function configOf($: EngineInterface, options: PluginOptions): Promise<Config> {
  const fromOptions = text(options.openrouterKey, '')
  const jevKey = fromOptions !== '' ? fromOptions : ((await $.env.get('OPENROUTER_API_KEY')) ?? '')
  const effort = EFFORTS.find(e => e === options.effort) ?? DEFAULTS.effort
  return {
    gate: options.gate === 'off' ? 'off' : 'jev',
    threshold: num(options.threshold, DEFAULTS.threshold),
    jevModel: text(options.jevModel, DEFAULTS.jevModel),
    jevKey,
    haikuModel: text(options.haikuModel, DEFAULTS.haikuModel),
    effort,
    maxWords: Math.max(5, Math.round(num(options.maxWords, DEFAULTS.maxWords))),
    auditRate: Math.min(1, Math.max(0, num(options.auditRate, DEFAULTS.auditRate))),
  }
}

// The Claude Code side of the pipeline's Host: Haiku runs as one request on the session's own client
// (the person's subscription), Jev as a plain HTTP call.
export function hostOf($: EngineInterface, config: Config): Host {
  return {
    now: () => $.clock.now(),
    random: () => Math.random(),
    complete: async ({ system, prompt }) => {
      const r = await $.model.complete({
        model: config.haikuModel,
        effort: config.effort,
        system,
        prompt,
        maxTokens: 1500,
        timeoutMs: 90_000,
      })
      const usage = {
        input: r.usage.input_tokens,
        output: r.usage.output_tokens,
        cacheRead: r.usage.cache_read_input_tokens,
        cacheWrite: r.usage.cache_creation_input_tokens,
      }
      if (r.isAnswered) return { isOk: true, text: r.text, usage }
      return { isOk: false, reason: r.reason === 'api-error' ? `api-error ${r.status ?? 'no response'} ${r.error}` : r.reason, usage }
    },
    post: async (url, headers, body) => {
      const r = await $.http.fetch(url, { method: 'POST', headers, body })
      return { status: r.status, text: r.text }
    },
  }
}
