export const KINDS = ['decision', 'preference', 'requirement', 'correction', 'ask'] as const
export type Kind = (typeof KINDS)[number]

export type Note = {
  id: number
  turn: number
  kind: Kind
  text: string
  status: 'active' | 'superseded' | 'done'
  supersededBy?: number
  doneAt?: number
}

// A line the person wrote by hand under the notes: kept in place, never parsed further.
export type Raw = { raw: string }
export type Item = Note | Raw

export type Doc = {
  front: Record<string, string>
  items: Item[]
}

export type Turn = {
  turn: number
  turnId: string
  user: string
  answer: string
  previousAnswer: string
  isAborted: boolean
}

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Memory = { kind: Kind; text: string; quote: string; supersedes: number[] }

export type Config = {
  gate: 'jev' | 'off'
  threshold: number
  jevModel: string
  jevKey: string
  haikuModel: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxWords: number
  auditRate: number
  pinRules: boolean
}

export const DEFAULTS: Config = {
  gate: 'jev',
  // eval/REPORT.md: at 0.7 precision is 96% and 93% on the two halves of 14 real chats; recall is about 53%.
  threshold: 0.7,
  jevModel: 'jev-1.13',
  jevKey: '',
  haikuModel: 'claude-haiku-5-5',
  effort: 'high',
  maxWords: 15,
  auditRate: 0,
  pinRules: true,
}

export type CompleteResult =
  | { isOk: true; text: string; usage: Usage }
  | { isOk: false; reason: string; usage: Usage }

export type PostResult = { status: number; text: string }

// Everything the pipeline needs from the agent it runs in. The Claude Code adapter fills it with `$`;
// a Pi or Codex adapter would fill it with that agent's own calls.
export type Host = {
  now: () => Promise<number>
  random: () => number
  complete: (req: { system: string; prompt: string; effort?: Config['effort'] }) => Promise<CompleteResult>
  post: (url: string, headers: Record<string, string>, body: string) => Promise<PostResult>
}

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

// A turn the gate skipped, read only to see which open requests the agent finished.
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
