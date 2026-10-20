export const KINDS = ['decision', 'preference', 'requirement', 'correction', 'ask'] as const
export type Kind = (typeof KINDS)[number]

export const LEARN_KINDS = ['failed', 'constraint'] as const
export type LearnKind = (typeof LEARN_KINDS)[number]

// Where a note came from: the turn, the engine's id for it, and the earlier turns it answers.
export type Source = { turnId: string; refersTo: number[] }

export type Note = {
  id: number
  turn: number
  kind: Kind
  text: string
  why: string
  context: string
  quote: string
  source: Source
  status: 'active' | 'superseded' | 'done'
  supersededBy?: number
  doneAt?: number
}

// Something the agent found out the hard way: an approach that failed, or a hard constraint.
export type Learning = {
  id: number
  turn: number
  kind: LearnKind
  text: string
  why: string
  evidence: string
  status: 'active' | 'superseded'
  supersededBy?: number
}

// The ledger as state.md holds it: only what is true now. `roles` maps a file path to what it is for.
export type State = {
  front: Record<string, string>
  notes: Note[]
  learnings: Learning[]
  roles: Record<string, string>
  own: string[]
}

// An item that left state.md, for history.md.
export type Moved = { item: Note | Learning; reason: 'superseded' | 'done'; by?: number; turn: number }

export type Step = {
  turn: number
  outcome: 'ok' | 'failed' | 'aborted'
  text: string
  facts: string
  // Labels of what the turn added (M-012, L-003) and finished (M-009).
  added: string[]
  done: string[]
}

export type Failure = { command: string; error: string }

// What the tools did in a turn, collected by code from the tool calls.
export type TurnFacts = {
  read: string[]
  edited: string[]
  commands: number
  failures: Failure[]
  commits: string[]
}

export type Turn = {
  turn: number
  turnId: string
  user: string
  answer: string
  previousAnswer: string
  isAborted: boolean
  facts: TurnFacts
}

export type FileEntry = { path: string; reads: number; edits: number; first: number; last: number; role: string; score: number }

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Memory = {
  kind: Kind
  text: string
  why: string
  context: string
  quote: string
  refersTo: number[]
  supersedes: number[]
}

export type LearningDraft = { kind: LearnKind; text: string; why: string; evidence: string; replaces: number[] }

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
  // eval/REPORT.md: the lowest threshold whose held-out precision stays at 0.9 or more for jev-1.14 with the previous reply in view.
  threshold: 0.7,
  jevModel: 'jev-1.14',
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

// One Haiku run on a turn: summarization always, extraction too when the gate passed.
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

// A turn as it was, redacted and clipped, so later turns can read it after Claude Code compacts.
export type TurnRecord = {
  type: 'turn'
  at: number
  turn: number
  turnId: string
  user: string
  answer: string
  facts: TurnFacts
}

export type LedgerEvent = GateEvent | ExtractEvent | TurnRecord
