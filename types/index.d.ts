export type SanchoSettings = {
  /** Ask before continuing a conversation whose cache has gone cold. */
  holdEnabled: boolean
  /** Only ask when re-reading the conversation costs at least this much more, in USD. */
  holdMinUsd: number
  /** After a turn that changed files, look for a risk the person may miss. */
  riskEnabled: boolean
  /** Offer to keep a correction as a rule in CLAUDE.md. */
  rulesEnabled: boolean
}

/** What the second pair of eyes has to say: one note at a time. */
export type Note =
  | { kind: 'risk'; title: string; detail: string }
  | { kind: 'rule'; rule: string; scope: 'project' | 'global' }

/** Where the TTL came from: the default, a guess from the plan, or what a turn showed. */
export type TtlSource = 'default' | 'guess' | 'observed'

export type CacheInfo = {
  /** When the main thread last sent a request, in `$.clock.now()` milliseconds. */
  lastRequestAt: number | null
  ttlMs: number
  ttlSource: TtlSource
  /** Tokens the next main-thread request re-sends. */
  contextTokens: number
  model: string | null
  /** The engine's own estimate of re-reading a resumed conversation, until its first request. */
  coldUsdHint: number | null
}

export type Hold = {
  text: string
  coldUsd: number
  warmUsd: number
  /** True once the held text is back in the prompt box. */
  isInBox: boolean
}

export type AgentRowStatus = 'running' | 'done' | 'failed' | 'stopped'

export type AgentTodos = { done: number; total: number }

export type AgentRow = {
  id: string
  description: string
  type: string
  model: string | null
  status: AgentRowStatus
  startedAt: number
  endedAt: number | null
  steps: number
  /** What it is doing now, in words: "Leyendo retry.ts". */
  activity: string | null
  usd: number
  todos: AgentTodos | null
}

/** One edit Claude made to a file, as the tool reported it. */
export type FileEdit = {
  id: string
  /** Relative to the project when it lies inside it. */
  path: string
  isNew: boolean
  /** Unified-diff hunks, whole. */
  patch: string
  additions: number
  deletions: number
  at: number
  /** The subagent that made it; null for the main conversation. */
  agentId: string | null
}

export type PanelTab = 'cambios' | 'agentes' | 'ajustes'

declare module 'claude-code' {
  interface PluginState {
    sancho: {
      settings: SanchoSettings
      cache: CacheInfo
      sessionUsd: number | null
      hold: Hold | null
      /** Until when the person's next message goes through unheld (0: none). */
      passUntil: number
      agents: AgentRow[]
      /** Agents started from this moment on count as this turn's. */
      agentsSince: number
      tab: PanelTab
      edits: FileEdit[]
      /** Edits and reads from this moment on are this turn's. */
      changesSince: number
      /** Which of this turn's edits the panel shows. */
      cursor: number
      /** Files read this turn, each once. */
      reads: string[]
      /** The project root, to show paths short. */
      root: string
      note: Note | null
      /** The person's prompt and Claude's answer of the last main turn, for the reviews. */
      lastPrompt: string
      lastAnswer: string
    }
  }
}
