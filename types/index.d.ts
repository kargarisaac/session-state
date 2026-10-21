// The plugin's state contract. It must stand alone, so it mirrors core/types.ts rather than importing it.

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Failure = { command: string; error: string }

export type TurnFacts = { read: string[]; edited: string[]; commands: number; failures: Failure[]; commits: string[] }

export type GateEvent = {
  type: 'gate'
  at: number
  turn: number
  turnId: string
  p: number | null
  model: string
  ms: number
  inputTokens: number
  cost: number
  action: 'extract' | 'skip' | 'audit' | 'error' | 'off'
  error?: string
}

export type ExtractEvent = {
  type: 'extract'
  at: number
  turn: number
  turnId: string
  model: string
  mode: 'summarize' | 'extract'
  ms: number
  usage: Usage
  kept: number
  learned: number
  closed: number
  roles: number
  need?: number
  dropped: string[]
  error?: string
}

export type TurnRecord = { type: 'turn'; at: number; turn: number; turnId: string; user: string; answer: string; facts: TurnFacts }

export type LedgerEvent = GateEvent | ExtractEvent | TurnRecord

export type PendingTurn = {
  turn: number
  turnId: string
  user: string
  answer: string
  previousAnswer: string
  isAborted: boolean
  facts: TurnFacts
}

export type Status = { isBusy: boolean; turn: number; message: string }

export type Tab = 'steps' | 'ledger' | 'stats'

declare module 'claude-code' {
  interface PluginState {
    'session-state': {
      sessionId: string
      dir: string
      origin: string
      md: string
      steps: string
      history: string
      events: LedgerEvent[]
      queue: PendingTurn[]
      failed: PendingTurn[]
      pendingUser: string
      previousAnswer: string
      facts: TurnFacts
      turns: number
      status: Status
      isPaused: boolean
      isCompacted: boolean
      tab: Tab
      isHistoryShown: boolean
    }
  }
}
