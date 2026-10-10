// The two things a second pair of eyes says: a risk the person may miss after
// a turn that changed files, and a correction worth keeping as a rule. The
// prompts go to Haiku; what comes back is parsed defensively.

import type { FileEdit, Note } from '../types'
import { clip } from './format'

/** Cheap first pass, so most messages never cost a model call. */
const CORRECTION =
  /\b(no,|no\.|nunca|siempre|en vez de|en lugar de|te he dicho|ya te dije|deja de|no uses|usa .+ no |prefiero|don'?t|never|always|instead of|stop |i told you|use .+ not )/i

export function looksLikeCorrection(text: string): boolean {
  return text.length <= 2000 && CORRECTION.test(text)
}

export const RULE_SYSTEM = `You read one message a developer sent to their coding assistant and decide whether it corrects the assistant in a way that should become a lasting rule for future sessions: a preference or convention about tools, commands, style or how to work. A one-off instruction about the current task is not a rule.
Answer with JSON only, no prose: {"rule": null}, or {"rule": "<the rule as one imperative sentence in the message's language, under 120 characters>", "scope": "project" | "global"}.
Use "global" only when the rule is clearly about the person's general preferences rather than this codebase.`

export function rulePrompt(message: string, previousAnswer: string): string {
  return `The assistant's previous reply (excerpt):\n${clip(previousAnswer, 1500)}\n\nThe developer's message:\n${message}`
}

export const RISK_SYSTEM = `You are a second pair of eyes on what a coding assistant just did. Flag at most one thing the developer is likely to miss and would want to know before moving on: a correctness, data-loss, security, money or behaviour-change risk the changes introduce, or something the assistant says it did that the diff does not show.
Do not flag style, naming, tests in general, or anything the assistant already pointed out clearly. Most turns have nothing worth flagging.
Answer with JSON only, no prose: {"risk": null}, or {"risk": "<headline in Spanish, under 80 characters>", "detail": "<one or two sentences in Spanish saying where and why>"}.`

export function riskPrompt(request: string, answer: string, edits: readonly FileEdit[]): string {
  let diffs = ''
  for (const edit of edits) {
    const block = `--- ${edit.path}\n${edit.patch}\n`
    if (diffs.length + block.length > 14_000) break
    diffs += block
  }

  return `What the developer asked:\n${clip(request, 1500)}\n\nWhat the assistant answered:\n${answer.slice(0, 4000)}\n\nThe changes it made:\n${diffs}`
}

function jsonIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function parseRule(text: string): Extract<Note, { kind: 'rule' }> | null {
  const json = jsonIn(text)
  if (json === null || typeof json.rule !== 'string' || json.rule.trim() === '') return null

  return { kind: 'rule', rule: clip(json.rule, 160), scope: json.scope === 'global' ? 'global' : 'project' }
}

export function parseRisk(text: string): Extract<Note, { kind: 'risk' }> | null {
  const json = jsonIn(text)
  if (json === null || typeof json.risk !== 'string' || json.risk.trim() === '') return null

  return {
    kind: 'risk',
    title: clip(json.risk, 100),
    detail: typeof json.detail === 'string' ? clip(json.detail, 400) : '',
  }
}

const HEADING = '## Reglas aprendidas'

/** CLAUDE.md with the rule added under its own heading, created when missing. */
export function withRule(existing: string, rule: string): string {
  const line = `- ${rule}`
  if (existing.includes(line)) return existing
  if (!existing.includes(HEADING)) {
    const base = existing.trimEnd()
    return `${base === '' ? '' : `${base}\n\n`}${HEADING}\n\n${line}\n`
  }
  const at = existing.indexOf(HEADING) + HEADING.length
  const next = existing.indexOf('\n## ', at)
  const end = next === -1 ? existing.length : next
  const section = existing.slice(0, end).trimEnd()

  return `${section}\n${line}\n${existing.slice(end)}`
}
