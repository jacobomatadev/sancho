import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnStepResult } from 'claude-code'

import type { PanelTab, SanchoSettings } from '../types'
import { activityOf, todosOf } from './activity'
import { editFrom, shortPath } from './changes'
import { looksLikeCorrection, parseRisk, parseRule, RISK_SYSTEM, riskPrompt, RULE_SYSTEM, rulePrompt, withRule } from './notes'
import {
  applyMainStep,
  applyResume,
  DEFAULT_SETTINGS,
  holdFor,
  INITIAL_CACHE,
  reconcileAgents,
  rowModelOf,
} from './model'
import { FIVE_MINUTES, HOUR, usageUsd } from './pricing'
import { paneView, rowView } from './views'

type Engine = EngineInterface

const PANE = 'sancho'
const AGENT_POLL_MS = 3_000
/** How long the warning about a held message counts as seen. */
const PASS_MS = 15 * 60_000

const settingsAtom = atom({ plugin: 'sancho', key: 'settings' } as const, DEFAULT_SETTINGS)
const cacheAtom = atom({ plugin: 'sancho', key: 'cache' } as const, INITIAL_CACHE)
const sessionUsdAtom = atom({ plugin: 'sancho', key: 'sessionUsd' } as const, null)
const holdAtom = atom({ plugin: 'sancho', key: 'hold' } as const, null)
const passUntilAtom = atom({ plugin: 'sancho', key: 'passUntil' } as const, 0)
const agentsAtom = atom({ plugin: 'sancho', key: 'agents' } as const, [])
const agentsSinceAtom = atom({ plugin: 'sancho', key: 'agentsSince' } as const, 0)
const tabAtom = atom({ plugin: 'sancho', key: 'tab' } as const, 'cambios')
const editsAtom = atom({ plugin: 'sancho', key: 'edits' } as const, [])
const changesSinceAtom = atom({ plugin: 'sancho', key: 'changesSince' } as const, 0)
const cursorAtom = atom({ plugin: 'sancho', key: 'cursor' } as const, 0)
const readsAtom = atom({ plugin: 'sancho', key: 'reads' } as const, [])
const rootAtom = atom({ plugin: 'sancho', key: 'root' } as const, '')
const noteAtom = atom({ plugin: 'sancho', key: 'note' } as const, null)
const lastPromptAtom = atom({ plugin: 'sancho', key: 'lastPrompt' } as const, '')
const lastAnswerAtom = atom({ plugin: 'sancho', key: 'lastAnswer' } as const, '')

/** The tools whose results carry a diff. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])
const MAX_EDITS = 100

// Timers die with the module; session.start, which runs again on a reload,
// sets them up again from what $.state kept.
let agentPoll: Timer | undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Stored settings, each kept only when it has the right type. */
function settingsFrom(stored: unknown): SanchoSettings {
  if (!isRecord(stored)) return DEFAULT_SETTINGS
  const pick = <K extends keyof SanchoSettings>(key: K): SanchoSettings[K] =>
    typeof stored[key] === typeof DEFAULT_SETTINGS[key] ? (stored[key] as SanchoSettings[K]) : DEFAULT_SETTINGS[key]

  return {
    holdEnabled: pick('holdEnabled'),
    holdMinUsd: pick('holdMinUsd'),
    riskEnabled: pick('riskEnabled'),
    rulesEnabled: pick('rulesEnabled'),
  }
}

async function saveSettings($: Engine, patch: Partial<SanchoSettings>) {
  const settings = await update($, settingsAtom, current => ({ ...current, ...patch }))
  await $.store.set('settings', settings)
}

/** Subscribers get an hour of cache, API keys five minutes, unless a turn shows otherwise. */
async function ttlGuess($: Engine): Promise<number> {
  const usage = await $.session.usage()
  return usage.rateLimits.length > 0 ? HOUR : FIVE_MINUTES
}

async function openPanel($: Engine, tab: PanelTab) {
  await update($, tabAtom, () => tab)
  await $.ui.open({ id: PANE, title: 'Sancho', focus: true, closeOnEscape: true })
}

// --- Held messages -----------------------------------------------------------

/** Puts the held text back in the box, unless the person already typed something else. */
async function putBackInBox($: Engine, text: string) {
  const box = await $.prompt.read()
  let isInBox = box.text === text
  if (box.text.trim() === '') isInBox = (await $.prompt.fill({ text, mode: 'replace' })).isFilled
  if (isInBox) await update($, holdAtom, hold => (hold !== null && hold.text === text ? { ...hold, isInBox } : hold))
}

/** The held message, as the person left it: edited in the box, or as they sent it. */
async function takeHeld($: Engine): Promise<string | null> {
  const hold = await read($, holdAtom)
  if (hold === null) return null
  let text = hold.text
  if (hold.isInBox) {
    const box = await $.prompt.read()
    if (box.text.trim() !== '') {
      text = box.text
      await $.prompt.fill({ text: '', mode: 'replace' })
    }
  }
  await update($, holdAtom, () => null)
  await update($, passUntilAtom, () => 0)

  return text
}

async function continueHere($: Engine) {
  const text = await takeHeld($)
  if (text !== null) await $.prompt.submit({ text, asUser: true })
}

/** A new conversation (the old one stays in /resume), the message its first prompt. */
async function startFresh($: Engine) {
  const text = await takeHeld($)
  if (text === null) return
  await $.command.run({ command: 'clear' })
  await $.prompt.submit({ text, asUser: true })
}

// --- A second pair of eyes --------------------------------------------------

/** One small Haiku call; nothing when it fails or says nothing. */
async function askHaiku($: Engine, system: string, prompt: string): Promise<string> {
  const reply = await $.model.complete({ model: 'haiku', system, prompt, maxTokens: 400, effort: 'low', timeoutMs: 30_000 })
  return reply.isAnswered ? reply.text : ''
}

/** After a turn that changed files: is there one thing the person should know? */
async function reviewTurn($: Engine) {
  const since = await read($, changesSinceAtom)
  const edits = (await read($, editsAtom)).filter(edit => edit.at >= since)
  if (edits.length === 0) return
  const prompt = riskPrompt(await read($, lastPromptAtom), await read($, lastAnswerAtom), edits)
  const risk = parseRisk(await askHaiku($, RISK_SYSTEM, prompt))
  if (risk !== null) await update($, noteAtom, () => risk)
}

/** A message that corrects Claude: is it worth keeping as a rule? */
async function detectRule($: Engine, message: string) {
  const rule = parseRule(await askHaiku($, RULE_SYSTEM, rulePrompt(message, await read($, lastAnswerAtom))))
  if (rule !== null) await update($, noteAtom, note => note ?? rule)
}

async function askAboutRisk($: Engine) {
  const note = await read($, noteAtom)
  await update($, noteAtom, () => null)
  if (note === null || note.kind !== 'risk') return
  await $.prompt.submit({
    text: `Sancho me avisa de un posible riesgo: «${note.title}». ${note.detail} ¿Es un problema real en lo que acabas de cambiar? Si lo es, propón cómo arreglarlo.`,
    asUser: true,
  })
}

async function saveRule($: Engine, scope: 'project' | 'global') {
  const note = await read($, noteAtom)
  await update($, noteAtom, () => null)
  if (note === null || note.kind !== 'rule') return
  const home = (await $.env.get('HOME')) ?? ''
  const path = scope === 'project' ? `${await read($, rootAtom)}/CLAUDE.md` : `${home}/.claude/CLAUDE.md`
  const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  await $.fs.write(path, withRule(existing, note.rule))
  $.ui.toast(scope === 'project' ? 'Regla guardada en el CLAUDE.md del proyecto.' : 'Regla guardada en tu CLAUDE.md global.')
}

// --- Subagents ---------------------------------------------------------------

async function watchAgents($: Engine) {
  const isRunning = (await read($, agentsAtom)).some(agent => agent.status === 'running')
  if (isRunning && agentPoll === undefined) {
    agentPoll = $.clock.every(AGENT_POLL_MS, () => void pollAgents($))
  } else if (!isRunning && agentPoll !== undefined) {
    agentPoll.cancel()
    agentPoll = undefined
  }
}

async function pollAgents($: Engine) {
  const list = await $.agent.list()
  const now = await $.clock.now()
  await update($, agentsAtom, rows => reconcileAgents(rows, list, now))
  // Elapsed times move on even when nothing else changed.
  $.ui.invalidate('ui.render')
  await watchAgents($)
}

/** A subagent's model request: one more step, and what it cost. */
async function recordAgentStep($: Engine, agentId: string, result: TurnStepResult) {
  const rows = await read($, agentsAtom)
  if (!rows.some(row => row.id === agentId)) {
    // Started before Sancho loaded: take what the agent list knows of it.
    const info = (await $.agent.list()).find(agent => agent.id === agentId)
    if (info === undefined) return
    const now = await $.clock.now()
    await update($, agentsAtom, current => [
      {
        id: agentId,
        description: info.description,
        type: info.type,
        model: null,
        status: 'running',
        startedAt: now,
        endedAt: null,
        steps: 0,
        activity: null,
        usd: 0,
        todos: null,
      },
      ...current,
    ])
  }
  const { ttlMs } = await read($, cacheAtom)
  const usage = result.usage
  const spent = usage === null ? 0 : usageUsd(usage, usage.model, ttlMs)
  await update($, agentsAtom, current =>
    current.map(row =>
      row.id === agentId
        ? {
            ...row,
            status: 'running',
            endedAt: null,
            steps: row.steps + 1,
            usd: row.usd + spent,
            model: usage?.model ?? row.model,
          }
        : row,
    ),
  )
  await watchAgents($)
}

// --- Conversation --------------------------------------------------------------

async function resetConversation($: Engine) {
  const now = await $.clock.now()
  await update($, cacheAtom, cache => ({ ...INITIAL_CACHE, ttlMs: cache.ttlMs, ttlSource: cache.ttlSource }))
  await update($, holdAtom, () => null)
  await update($, passUntilAtom, () => 0)
  await update($, agentsAtom, () => [])
  await update($, agentsSinceAtom, () => now)
  await update($, sessionUsdAtom, () => null)
  await update($, editsAtom, () => [])
  await update($, readsAtom, () => [])
  await update($, changesSinceAtom, () => now)
  await update($, cursorAtom, () => 0)
  await update($, noteAtom, () => null)
}

async function registerTools($: Engine) {
  await $.tool.register({
    name: 'panel',
    description:
      "Opens Sancho's panel in the person's Claude Code window: the files the last turn changed, to review edit by edit (cambios); the subagents of this session, what each is doing and costs (agentes); or Sancho's settings (ajustes). Use it when they ask, in any words (\"enséñame qué has cambiado\", \"enséñame los agentes\", \"abre los ajustes de Sancho\").",
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string', enum: ['cambios', 'agentes', 'ajustes'] } },
      additionalProperties: false,
    },
  })

}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('settings')
    await update($, settingsAtom, () => settingsFrom(stored))
    const root = await $.session.root()
    await update($, rootAtom, () => root)
    await registerTools($)
    await watchAgents($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await resetConversation($)
    return next(e)
  })

  // A resumed conversation: the engine says how long ago it last answered and what re-reading costs.
  on('classic.SessionStart', async ($, e, next) => {
    const contextTokens = e.context_tokens
    if ((e.source === 'resume' || e.source === 'fork') && contextTokens !== undefined && contextTokens > 0) {
      const now = await $.clock.now()
      await update($, cacheAtom, cache =>
        applyResume(cache, {
          now,
          secondsSince: e.seconds_since_last_response ?? 0,
          contextTokens,
          isExpired: e.prompt_cache_likely_expired === true,
          coldUsd: e.estimated_cache_write_usd ?? null,
          model: e.model ?? null,
        }),
      )
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const cost = e.cost
    if (cost !== undefined) await update($, sessionUsdAtom, () => cost.usd)
    return next(e)
  })

  // The person's own message, typed while Claude is idle, waits once when
  // re-reading the conversation would cost more than they chose to allow.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (!isPerson || e.turnId !== undefined) return next(e)

    const now = await $.clock.now()
    const sendAndLearn = async () => {
      const sent = await next(e)
      const { rulesEnabled } = await read($, settingsAtom)
      if (sent.drop === undefined && rulesEnabled && looksLikeCorrection(e.text)) {
        $.clock.after(10, () => void detectRule($, e.text))
      }
      return sent
    }
    if (now < (await read($, passUntilAtom))) {
      await update($, passUntilAtom, () => 0)
      await update($, holdAtom, () => null)
      return sendAndLearn()
    }
    // Nothing is held where nobody can see the row (a -p run), nor what the box could not give back.
    const canShow = (await $.session.surfaces()).length > 0
    const resend =
      canShow && e.attachments === undefined
        ? holdFor(await read($, settingsAtom), await read($, cacheAtom), now)
        : null
    if (resend === null) return sendAndLearn()

    await update($, holdAtom, () => ({ text: e.text, ...resend, isInBox: false }))
    await update($, passUntilAtom, () => now + PASS_MS)
    $.clock.after(150, () => void putBackInBox($, e.text))

    return { drop: 'Sancho: continuar esta conversación sale caro; tu mensaje espera encima del cuadro de texto.' }
  })

  // A new turn starts a new summary: its own changes, reads and agents.
  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, changesSinceAtom, () => now)
    await update($, cursorAtom, () => 0)
    await update($, readsAtom, () => [])
    if (e.text !== '') await update($, lastPromptAtom, () => e.text)
    await update($, noteAtom, note => (note?.kind === 'risk' ? null : note))
    const isAnyRunning = (await read($, agentsAtom)).some(agent => agent.status === 'running')
    if (!isAnyRunning) await update($, agentsSinceAtom, () => now)
    return next(e)
  })

  // Every model request, the main thread's and each subagent's.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    try {
      if (e.agentId === undefined) {
        const cache = await read($, cacheAtom)
        const guess = cache.ttlSource === 'default' ? await ttlGuess($) : null
        await update($, cacheAtom, current =>
          applyMainStep(current, { startedAt, index: e.index, usage: result.usage }, guess),
        )
      } else {
        await recordAgentStep($, e.agentId, result)
      }
    } catch {
      // Bookkeeping never gets in the way of the response.
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    if (started.deny === undefined && agentId !== undefined) {
      const now = await $.clock.now()
      await update($, agentsAtom, rows => [
        {
          id: agentId,
          description: e.description,
          type: e.subagentType,
          model: started.model,
          status: 'running',
          startedAt: now,
          endedAt: null,
          steps: 0,
          activity: null,
          usd: 0,
          todos: null,
        },
        ...rows.filter(row => row.id !== agentId).slice(0, 39),
      ])
      await watchAgents($)
    }
    return started
  })

  // What each subagent is doing, which files the turn reads, and every edit with its diff.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Readonly<Record<string, unknown>>
    const agentId = e.agentId
    if (agentId !== undefined) {
      const activity = activityOf(tool, input)
      const todos = tool === 'TodoWrite' ? todosOf(input) : null
      await update($, agentsAtom, rows =>
        rows.map(row => (row.id === agentId ? { ...row, activity, todos: todos ?? row.todos } : row)),
      )
    }
    if (tool === 'Read' && typeof input.file_path === 'string') {
      const path = shortPath(input.file_path, await read($, rootAtom))
      await update($, readsAtom, reads => (reads.includes(path) ? reads : [...reads, path].slice(-200)))
    }
    if (!EDIT_TOOLS.has(tool)) return next(e)

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const edit = editFrom(ran.result, {
        id: e.tool_use_id,
        root: await read($, rootAtom),
        at: await $.clock.now(),
        agentId: agentId ?? null,
      })
      if (edit !== null) await update($, editsAtom, edits => [...edits, edit].slice(-MAX_EDITS))
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined && e.reason === 'answer') {
      await update($, lastAnswerAtom, () => e.answer)
      if ((await read($, settingsAtom)).riskEnabled) $.clock.after(10, () => void reviewTurn($))
    }
    if (agentId !== undefined) {
      const now = await $.clock.now()
      const status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await update($, agentsAtom, rows =>
        rows.map(row =>
          row.id === agentId && row.status === 'running' ? { ...row, status, endedAt: now, activity: null } : row,
        ),
      )
      await watchAgents($)
    }
    return next(e)
  })

  // Asking Claude in words does what the buttons do.
  on('tool.call', { tool: 'mcp__sancho__panel' }, async ($, e) => {
    const asked = (e as unknown as Record<string, unknown>).tab
    const tab: PanelTab = asked === 'ajustes' || asked === 'agentes' ? asked : 'cambios'
    await openPanel($, tab)
    return { result: `Panel de Sancho abierto en «${tab}».` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const model = rowModelOf({
      hold: await read($, holdAtom),
      note: await read($, noteAtom),
      agents: await read($, agentsAtom),
      agentsSince: await read($, agentsSinceAtom),
      edits: await read($, editsAtom),
      changesSince: await read($, changesSinceAtom),
      isWorking: e.props.isWorking,
    })
    if (model === null) return next(e)

    return rowView($.ui.resolve(e), model, {
      startFresh: () => void startFresh($),
      continueHere: () => void continueHere($),
      askAboutRisk: () => void askAboutRisk($),
      saveRule: scope => void saveRule($, scope),
      dismissNote: () => void update($, noteAtom, () => null),
      openPanel: tab => void openPanel($, tab),
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const changesSince = await read($, changesSinceAtom)
    return paneView(
      $.ui.resolve(e),
      {
        tab: await read($, tabAtom),
        agents: await read($, agentsAtom),
        settings: await read($, settingsAtom),
        sessionUsd: await read($, sessionUsdAtom),
        now: await $.clock.now(),
        bodyRows: e.props.scroll.bodyRows,
        edits: (await read($, editsAtom)).filter(edit => edit.at >= changesSince),
        cursor: await read($, cursorAtom),
        reads: (await read($, readsAtom)).length,
      },
      {
        setTab: tab => void update($, tabAtom, () => tab),
        showEdit: index => void update($, cursorAtom, () => index),
        close: () => void $.ui.close({ id: PANE }),
        setSettings: patch => void saveSettings($, patch),
      },
    )
  })
}
