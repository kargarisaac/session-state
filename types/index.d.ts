export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

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
  ms: number
  usage: Usage
  kept: number
  dropped: string[]
  closed?: number
  error?: string
}

export type CloseEvent = {
  type: 'close'
  at: number
  turn: number
  turnId: string
  model: string
  ms: number
  usage: Usage
  closed: number
  error?: string
}

export type LedgerEvent = GateEvent | ExtractEvent | CloseEvent

export type PendingTurn = {
  turn: number
  turnId: string
  user: string
  answer: string
  previousAnswer: string
  isAborted: boolean
}

export type Status = { isBusy: boolean; turn: number; message: string }

declare module 'claude-code' {
  interface PluginState {
    'session-state': {
      sessionId: string
      file: string
      origin: string
      md: string
      events: LedgerEvent[]
      queue: PendingTurn[]
      failed: PendingTurn[]
      pendingUser: string
      previousAnswer: string
      turns: number
      status: Status
      isPaused: boolean
    }
  }
}
