// What Sancho decides, kept apart from the hooks so it can be tested whole:
// whether a message should wait, what the row says, and how a model request
// or the agent list changes what it knows.

import type { AgentInfo, TurnUsage } from 'claude-code'

import type { AgentRow, AgentRowStatus, CacheInfo, FileEdit, Hold, Note, SanchoSettings } from '../types'
import { coldResendUsd, FIVE_MINUTES, HOUR, warmResendUsd } from './pricing'

export const DEFAULT_SETTINGS: SanchoSettings = {
  holdEnabled: true,
  holdMinUsd: 0.5,
  riskEnabled: true,
  rulesEnabled: true,
}

export const INITIAL_CACHE: CacheInfo = {
  lastRequestAt: null,
  ttlMs: HOUR,
  ttlSource: 'default',
  contextTokens: 0,
  model: null,
  coldUsdHint: null,
}

export function isCold(cache: CacheInfo, now: number): boolean {
  return cache.lastRequestAt !== null && cache.contextTokens > 0 && now >= cache.lastRequestAt + cache.ttlMs
}

export type Resend = { coldUsd: number; warmUsd: number }

export function resendOf(cache: CacheInfo): Resend {
  return {
    coldUsd: cache.coldUsdHint ?? coldResendUsd(cache.model, cache.contextTokens, cache.ttlMs),
    warmUsd: warmResendUsd(cache.model, cache.contextTokens),
  }
}

/** What continuing here would cost, when it is enough to ask first; else null. */
export function holdFor(settings: SanchoSettings, cache: CacheInfo, now: number): Resend | null {
  if (!settings.holdEnabled || !isCold(cache, now)) return null
  const resend = resendOf(cache)

  return resend.coldUsd - resend.warmUsd >= settings.holdMinUsd ? resend : null
}

/**
 * A resumed conversation, as the engine describes it on SessionStart: how long
 * ago its last response was, what it re-sends, and what re-reading it costs.
 */
export function applyResume(
  cache: CacheInfo,
  resume: { now: number; secondsSince: number; contextTokens: number; isExpired: boolean; coldUsd: number | null; model: string | null },
): CacheInfo {
  const ago = resume.secondsSince * 1000
  // The engine knows the TTL; when it says expired, the entry is gone whatever we guessed.
  const lastRequestAt = resume.now - (resume.isExpired ? Math.max(ago, cache.ttlMs) : Math.min(ago, cache.ttlMs - 1))

  return {
    ...cache,
    lastRequestAt,
    contextTokens: resume.contextTokens,
    model: resume.model ?? cache.model,
    coldUsdHint: resume.coldUsd,
  }
}

const contextOf = (usage: TurnUsage) =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens

/**
 * One main-thread request: when it went out, what the next one re-sends, and
 * what a turn's first request says about the TTL. A hit after a gap longer
 * than five minutes proves an hour; a miss well inside the hour, five minutes.
 */
export function applyMainStep(
  cache: CacheInfo,
  step: { startedAt: number; index: number; usage: TurnUsage | null },
  ttlGuess: number | null,
): CacheInfo {
  let next: CacheInfo = { ...cache, lastRequestAt: step.startedAt, coldUsdHint: null }
  if (ttlGuess !== null && cache.ttlSource === 'default') next = { ...next, ttlMs: ttlGuess, ttlSource: 'guess' }
  const usage = step.usage
  if (usage === null) return next

  const isComparable =
    step.index === 0 && cache.lastRequestAt !== null && cache.contextTokens > 4000 && cache.model === usage.model
  if (isComparable && cache.lastRequestAt !== null) {
    const gap = step.startedAt - cache.lastRequestAt
    const share = usage.cache_read_input_tokens / cache.contextTokens
    if (share > 0.5 && gap > FIVE_MINUTES + 60_000) {
      next = { ...next, ttlMs: HOUR, ttlSource: 'observed' }
    } else if (share < 0.1 && gap > FIVE_MINUTES + 30_000 && gap < HOUR - 5 * 60_000) {
      next = { ...next, ttlMs: FIVE_MINUTES, ttlSource: 'observed' }
    }
  }

  return { ...next, contextTokens: contextOf(usage), model: usage.model }
}

const statusOf = (info: AgentInfo): AgentRowStatus => {
  switch (info.status) {
    case 'completed':
    case 'idle':
      return 'done'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'stopped'
    default:
      return 'running'
  }
}

/** Running rows the agent list says have ended, ended. */
export function reconcileAgents(rows: readonly AgentRow[], list: readonly AgentInfo[], now: number): AgentRow[] {
  return rows.map(row => {
    if (row.status !== 'running') return row
    const info = list.find(agent => agent.id === row.id)
    // A subagent leaves the list a while after it ends; a new one may not be there yet.
    const status = info === undefined ? (now - row.startedAt > 10_000 ? 'done' : 'running') : statusOf(info)

    return status === 'running' ? row : { ...row, status, endedAt: now, activity: null }
  })
}

export type TurnChanges = { files: number; additions: number; deletions: number }

export type FinishedAgents = { count: number; failed: number; usd: number }

export type RowModel =
  | { kind: 'hold'; hold: Hold }
  | { kind: 'agents'; running: number; usd: number }
  | { kind: 'note'; note: Note }
  | { kind: 'summary'; changes: TurnChanges | null; agents: FinishedAgents | null }

export type RowInput = {
  hold: Hold | null
  note: Note | null
  agents: readonly AgentRow[]
  agentsSince: number
  edits: readonly FileEdit[]
  changesSince: number
  isWorking: boolean
}

export function changesOf(edits: readonly FileEdit[], since: number): TurnChanges | null {
  const turn = edits.filter(edit => edit.at >= since)
  if (turn.length === 0) return null

  return {
    files: new Set(turn.map(edit => edit.path)).size,
    additions: turn.reduce((sum, edit) => sum + edit.additions, 0),
    deletions: turn.reduce((sum, edit) => sum + edit.deletions, 0),
  }
}

/**
 * The row speaks only when there is something to decide or to look at: a
 * costly conversation to continue, agents at work, a risk or a rule worth
 * keeping, or once a turn ends, what it changed and what its agents did.
 * Otherwise nothing.
 */
export function rowModelOf(input: RowInput): RowModel | null {
  if (input.hold !== null) return { kind: 'hold', hold: input.hold }

  const running = input.agents.filter(agent => agent.status === 'running')
  const recent = input.agents.filter(agent => agent.startedAt >= input.agentsSince)
  const spent = (rows: readonly AgentRow[]) => rows.reduce((sum, agent) => sum + agent.usd, 0)
  if (running.length > 0) {
    const shown = recent.length >= running.length ? recent : running
    return { kind: 'agents', running: running.length, usd: spent(shown) }
  }
  if (input.note !== null) return { kind: 'note', note: input.note }
  if (input.isWorking) return null

  const changes = changesOf(input.edits, input.changesSince)
  const agents =
    recent.length > 0
      ? { count: recent.length, failed: recent.filter(agent => agent.status === 'failed').length, usd: spent(recent) }
      : null
  if (changes === null && agents === null) return null

  return { kind: 'summary', changes, agents }
}
