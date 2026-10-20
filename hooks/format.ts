import type { Stats } from '../core/ledger'
import type { Config } from '../core/types'
import type { Status } from '../types'

export const money = (usd: number): string => {
  if (usd === 0) return '$0'
  if (usd < 0.0001) return '<$0.0001'
  return `$${usd.toFixed(usd < 0.01 ? 4 : 3)}`
}

export const kilo = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export const duration = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`)

const mean = (total: number, count: number): number => (count === 0 ? 0 : total / count)

export type Row = { label: string; value: string }

export type PanelInput = {
  stats: Stats
  asks: number
  rules: number
  learnings: number
  files: number
  config: Config
  status: Status
  isPaused: boolean
  failed: number
}

export const rows = (p: PanelInput): Row[] => {
  const { stats, config } = p
  const haikuIn = stats.haikuUsage.input + stats.haikuUsage.cacheRead + stats.haikuUsage.cacheWrite
  const state = p.isPaused
    ? 'paused'
    : p.status.isBusy
      ? `recording turn ${p.status.turn}`
      : 'idle'
  const list: Row[] = [
    { label: 'Ledger', value: `${p.asks} open asks · ${p.rules} decisions and rules · ${p.learnings} learnings · ${p.files} files` },
    { label: 'Turns', value: `${stats.turns} seen · ${stats.passed} passed · ${stats.skipped} skipped` },
    {
      label: 'Gate',
      value:
        config.gate === 'off'
          ? 'off: Haiku reads every turn'
          : `${config.jevModel} via OpenRouter · pass at p ≥ ${config.threshold} · avg ${duration(mean(stats.jevMs, stats.jevCalls))}`,
    },
    {
      label: 'Haiku',
      value: `${config.haikuModel} · via Claude Code · ${stats.summaries} summaries (low) · ${stats.extractions} extractions (${config.effort}) · ${stats.lookups} look-backs · avg ${duration(mean(stats.haikuMs, stats.summaries + stats.extractions))}`,
    },
    {
      label: 'Saved',
      value: `${stats.saved} notes · ${stats.learned} learnings · ${stats.closed} asks closed · ${stats.dropped} dropped by checks`,
    },
    {
      label: 'Cost',
      value: `Jev ${money(stats.jevCost)} · Haiku ${kilo(haikuIn)} in, ${kilo(stats.haikuUsage.output)} out ≈ ${money(stats.haikuCost)} (plan usage, not billed)`,
    },
    { label: 'Status', value: p.status.message === '' ? state : `${state} · ${p.status.message}` },
  ]
  if (p.failed > 0) list.push({ label: 'Failed', value: `${p.failed} turn${p.failed === 1 ? '' : 's'}; /session-state retry` })
  return list
}

export const gateLines = (stats: Stats): string[] =>
  stats.lastGates.map(g => `t${g.turn}  ${g.p === null ? ' —  ' : `p ${g.p.toFixed(2)}`}  ${g.action}${g.error === undefined ? '' : ` (${g.error})`}`)
