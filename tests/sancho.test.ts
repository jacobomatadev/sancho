import type { AgentInfo, AgentSpawnInput, On, SessionUsage, TurnStepResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { approx, elapsed, shortModel, usd } from '../hooks/format'
import { applyResume, DEFAULT_SETTINGS, holdFor, INITIAL_CACHE, rowModelOf } from '../hooks/model'
import { looksLikeCorrection, parseRisk, parseRule, withRule } from '../hooks/notes'
import { coldResendUsd, FIVE_MINUTES, HOUR, warmResendUsd } from '../hooks/pricing'

const MINUTE = 60_000
const START = 1_000_000_000

const USAGE: SessionUsage = {
  startedAt: START,
  context: { window: 1_000_000, tokens: 100_000, percent: 10 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 12 }],
  cost: { usd: 1.2 },
}

const $empty = (e: { surface: 'terminal' | 'desktop' | 'mobile' | 'vscode' }) => {
  void e
  return h('Box', null)
}

/** The world beneath Sancho: a mocked clock and store, and answers for what it asks. */
function world(on: On, options: { box?: boolean } = {}) {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  let box = ''
  const agents: AgentInfo[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.root', () => ({ value: '/proyecto' }))
  const files = new Map<string, string>([['/proyecto/CLAUDE.md', '# Proyecto\n\nNotas.\n']])
  const haiku: { system: string; prompt: string }[] = []
  let haikuReply = '{"risk": null}'
  on('model.complete', (_$, e) => {
    haiku.push({ system: e.system ?? '', prompt: e.prompt })
    return { value: { isAnswered: true, text: haikuReply, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('env.get', () => ({ value: '/Users/yo' }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'Edit') {
      return {
        result: {
          filePath: input.file_path,
          oldString: 'a',
          newString: 'b',
          originalFile: 'a',
          structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' ctx', '-viejo', '+nuevo', '+más'] }],
          userModified: false,
          replaceAll: false,
        },
      }
    }
    return { result: 'ok' }
  })
  on('session.surfaces', () => ({ value: ['terminal'] as const }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__sancho__${e.name}` } }))
  on('agent.list', () => ({ value: agents.map(agent => ({ ...agent })) }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  // What the engine draws when Sancho has nothing to say: an empty band.
  on('ui.render', { component: 'AbovePrompt' }, (_$, e) => $empty(e))
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
  on('prompt.fill', (_$, e) => {
    if (options.box === false) return { isFilled: false, refusal: 'no_composer' as const }
    box = e.text
    return { isFilled: true }
  })
  const commands: string[] = []
  const prompts: string[] = []
  on('command.run', (_$, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.step', async function* (_$, e) {
    const result: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 2_000,
        cache_read_input_tokens: 97_000,
        cache_creation_input_tokens: 500,
        output_tokens: 500,
      },
    }
    return result
  })
  let forks = 0
  on('model.fork', () => {
    forks += 1
    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 99_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('agent.spawn', (_$, e) => {
    agents.push({ id: 'a1', description: e.description, type: e.subagentType, status: 'running' })
    return { model: 'claude-haiku-5-5', agentId: 'a1' }
  })
  on('turn.complete', (_$, e) => {
    const agent = agents.find(one => one.id === e.agentId)
    if (agent !== undefined) agent.status = 'completed'
    return { text: e.answer }
  })

  return { clock, box: () => box, forks: () => forks, commands, prompts, files, haiku, reply: (text: string) => (haikuReply = text) }
}

async function mainStep($: Engine) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 4 })
  for await (const _chunk of stream) {
    // drain
  }
  return stream.result
}

const BAND = {
  plugin: 'sancho',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'sancho',
  component: 'Pane',
  requestId: 'sancho',
  props: {
    title: 'Sancho',
    isFocused: false,
    bodyColumns: 90,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

describe('precios y formato', () => {
  test('releer en frío cuesta escribir la caché; en caliente, leerla', () => {
    expect(coldResendUsd('claude-opus-5-5', 100_000, HOUR)).toBe(0.8)
    expect(coldResendUsd('claude-opus-5-5', 100_000, FIVE_MINUTES)).toBe(0.5)
    expect(Math.round(warmResendUsd('claude-opus-5-5', 100_000) * 1000)).toBe(20)
    expect(Math.round(coldResendUsd('claude-fable-5-1', 100_000, HOUR) * 100)).toBe(200)
  })

  test('habla español', () => {
    expect(usd(0.523)).toBe('0,52 $')
    expect(approx(0.001)).toBe('<0,01 $')
    expect(elapsed(130_000)).toBe('2 min 10 s')
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(shortModel('claude-sonnet-4-20250514')).toBe('Sonnet 4')
    expect(shortModel('haiku')).toBe('Haiku')
  })
})

describe('cuándo preguntar', () => {
  const cache = { ...INITIAL_CACHE, lastRequestAt: START, contextTokens: 100_000, model: 'claude-opus-5-5' }

  test('la fila no dice nada si no hay agentes ni nada que decidir', () => {
    expect(rowModelOf({ hold: null, note: null, agents: [], agentsSince: START, edits: [], changesSince: START, isWorking: false })).toBeNull()
  })

  test('solo pregunta con la caché fría y si sale caro', () => {
    expect(holdFor(DEFAULT_SETTINGS, cache, START + 30 * MINUTE)).toBeNull()
    expect(holdFor(DEFAULT_SETTINGS, cache, START + 61 * MINUTE)).toMatchObject({ coldUsd: 0.8 })
    expect(holdFor({ ...DEFAULT_SETTINGS, holdMinUsd: 1 }, cache, START + 61 * MINUTE)).toBeNull()
    expect(holdFor({ ...DEFAULT_SETTINGS, holdEnabled: false }, cache, START + 61 * MINUTE)).toBeNull()
    const small = { ...cache, contextTokens: 20_000 }
    expect(holdFor(DEFAULT_SETTINGS, small, START + 61 * MINUTE)).toBeNull()
  })

  test('al retomar una conversación usa lo que dice Claude Code', () => {
    const resumed = applyResume(INITIAL_CACHE, {
      now: START,
      secondsSince: 3 * 3600,
      contextTokens: 300_000,
      isExpired: true,
      coldUsd: 2.4,
      model: 'claude-opus-5-5',
    })
    expect(holdFor(DEFAULT_SETTINGS, resumed, START)).toMatchObject({ coldUsd: 2.4 })
    const recent = applyResume(INITIAL_CACHE, {
      now: START,
      secondsSince: 120,
      contextTokens: 300_000,
      isExpired: false,
      coldUsd: 2.4,
      model: 'claude-opus-5-5',
    })
    expect(holdFor(DEFAULT_SETTINGS, recent, START)).toBeNull()
  })
})

describe('mensaje en espera', () => {
  test('retiene el primer mensaje con la caché fría, lo devuelve al cuadro y deja pasar el siguiente', async ($, on) => {
    const { clock, box } = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await mainStep($)
    await clock.advance(61 * MINUTE)

    const held = await $.prompt.submit({ text: 'sigue con los tests', wait: false, origin: { kind: 'composer' } })
    expect(held).toMatchObject({ drop: expect.any(String) })
    await clock.advance(200)
    expect(box()).toBe('sigue con los tests')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect((await ui.find({ key: 'hold-fresh' }))?.type).toBe('Button')
      expect(await ui.find({ text: /costará ~0,80/ })).toBeDefined()
      await ui.unmount()
    }

    const sent = await $.prompt.submit({ text: 'sigue con los tests', wait: false, origin: { kind: 'composer' } })
    expect(sent).toMatchObject({ text: 'sigue con los tests' })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ key: 'hold-fresh' })).toBeUndefined()
    await ui.unmount()
  })

  test('sin cuadro de texto (escritorio), «Empezar una nueva» lo envía en una conversación nueva', async ($, on) => {
    const { clock, commands, prompts } = world(on, { box: false })
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    await mainStep($)
    await clock.advance(61 * MINUTE)
    await $.prompt.submit({ text: 'revisa el PR', wait: false, origin: { kind: 'sdk' } })
    await clock.advance(200)

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ text: /revisa el PR/ })).toBeDefined()
    await ui.press({ key: 'hold-fresh' })
    expect(commands).toEqual(['clear'])
    expect(prompts.at(-1)).toBe('revisa el PR')
    expect(await ui.find({ key: 'hold-fresh' })).toBeUndefined()
    await ui.unmount()
  })

  test('no retiene lo que no escribió la persona', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await mainStep($)
    await clock.advance(61 * MINUTE)
    const result = await $.prompt.submit({
      text: 'tarea programada',
      wait: false,
      origin: { kind: 'scheduled-trigger' },
    })
    expect(result).toMatchObject({ text: 'tarea programada' })
  })
})

describe('cambios', () => {
  test('al acabar el turno resume los cambios y el panel los recorre uno a uno', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/proyecto', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'arregla los pagos', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/proyecto/src/pagos.ts' })
    await $.tool.call({ tool: 'Edit', file_path: '/proyecto/src/pagos.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Edit', file_path: '/proyecto/src/retry.ts', old_string: 'a', new_string: 'b' })

    const working = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })
    expect(await working.find({ key: 'row-changes' })).toBeUndefined()
    await working.unmount()

    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ text: /2 archivos cambiados · \+4 −2/ })).toBeDefined()
      await band.press({ key: 'row-changes' })
      await band.unmount()

      const pane = await $.ui.mount({ ...PANE, surface })
      expect(await pane.find({ text: /Cambio 1 de 2 · src\/pagos\.ts/ })).toBeDefined()
      expect((await pane.find({ type: 'Code' }))?.props).toMatchObject({ format: 'diff' })
      await pane.press({ key: 'edit-next' })
      expect(await pane.find({ text: /Cambio 2 de 2 · src\/retry\.ts/ })).toBeDefined()
      await pane.press({ key: 'edit-prev' })
      await pane.unmount()
    }
  })
})

describe('segundo par de ojos', () => {
  test('reconoce correcciones y lee lo que contesta Haiku', () => {
    expect(looksLikeCorrection('no, en este repo usamos pnpm')).toBe(true)
    expect(looksLikeCorrection('añade un botón de guardar')).toBe(false)
    expect(parseRule('```json\n{"rule": "Usa pnpm, no npm", "scope": "project"}\n```')).toMatchObject({ rule: 'Usa pnpm, no npm', scope: 'project' })
    expect(parseRule('{"rule": null}')).toBeNull()
    expect(parseRisk('nada que decir')).toBeNull()
  })

  test('añade la regla bajo su sección sin tocar el resto', () => {
    const once = withRule('# Proyecto\n\n## Estilo\n\nTabs.\n', 'Usa pnpm')
    expect(once).toBe('# Proyecto\n\n## Estilo\n\nTabs.\n\n## Reglas aprendidas\n\n- Usa pnpm\n')
    const twice = withRule(`${once}\n## Otro\n\nx\n`, 'Nunca hagas push a main')
    expect(twice).toContain('- Usa pnpm\n- Nunca hagas push a main\n\n## Otro')
    expect(withRule(twice, 'Usa pnpm')).toBe(twice)
  })

  test('tras un turno con cambios avisa de un riesgo y deja preguntar a Claude', async ($, on) => {
    const { clock, reply, prompts, haiku } = world(on)
    await $.session.start({ cwd: '/proyecto', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'añade reintentos al cobro', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: '/proyecto/src/pagos.ts', old_string: 'a', new_string: 'b' })
    reply('{"risk": "un reintento puede cobrar dos veces", "detail": "cobrar() reintenta sin clave de idempotencia."}')
    await $.turn.complete({ answer: 'Hecho', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(50)
    expect(haiku.at(-1)?.prompt).toContain('src/pagos.ts')

    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ text: /Ojo: un reintento puede cobrar dos veces/ })).toBeDefined()
      await band.unmount()
    }
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'note-ask' })
    expect(prompts.at(-1)).toContain('un reintento puede cobrar dos veces')
    expect(await band.find({ key: 'note-ask' })).toBeUndefined()
    await band.unmount()
  })

  test('sin cambios no gasta en revisar', async ($, on) => {
    const { clock, haiku } = world(on)
    await $.session.start({ cwd: '/proyecto', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: '¿qué hace este archivo?', turnId: 't1' })
    await $.turn.complete({ answer: 'Explica…', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(50)
    expect(haiku).toHaveLength(0)
  })

  test('una corrección se ofrece como regla y se guarda en el CLAUDE.md elegido', async ($, on) => {
    const { clock, reply, files } = world(on)
    await $.session.start({ cwd: '/proyecto', surface: 'terminal', isInteractive: true })
    reply('{"rule": "Usa pnpm, no npm", "scope": "project"}')
    await $.prompt.submit({ text: 'no, en este repo usamos pnpm, no npm', wait: false, origin: { kind: 'composer' } })
    await clock.advance(50)

    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await band.find({ text: /Usa pnpm, no npm/ })).toBeDefined()
    await band.press({ key: 'rule-project' })
    expect(files.get('/proyecto/CLAUDE.md')).toBe('# Proyecto\n\nNotas.\n\n## Reglas aprendidas\n\n- Usa pnpm, no npm\n')
    expect(await band.find({ key: 'rule-project' })).toBeUndefined()
    await band.unmount()

    reply('{"rule": "Responde siempre en español", "scope": "global"}')
    await $.prompt.submit({ text: 'siempre en español, por favor', wait: false, origin: { kind: 'composer' } })
    await clock.advance(50)
    const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await again.press({ key: 'rule-global' })
    expect(files.get('/Users/yo/.claude/CLAUDE.md')).toContain('- Responde siempre en español')
    await again.unmount()
  })
})

describe('agentes', () => {
  const SPAWN: AgentSpawnInput = {
    tool_use_id: 'toolu_1',
    prompt: 'Busca dónde se reintentan los pagos',
    description: 'Explorar el módulo de pagos',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  }

  test('el panel muestra cada agente, qué hace y cuándo termina', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.agent.spawn(SPAWN)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ text: /1 agente trabajando/ })).toBeDefined()
    expect(await band.find({ key: 'row-agents' })).toBeDefined()
    await band.press({ key: 'row-agents' })
    await band.unmount()

    await clock.advance(90_000)
    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ ...PANE, surface })
      expect(await pane.find({ text: /Explorar el módulo de pagos/ })).toBeDefined()
      expect(await pane.find({ text: /Haiku 5\.5 · 1 min 30 s/ })).toBeDefined()
      await pane.unmount()
    }

    await $.turn.complete({ answer: 'listo', durationMs: 90_000, isAborted: false, turnId: 'a1-run', agentId: 'a1', reason: 'answer' })
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ text: /terminado/ })).toBeDefined()
    await pane.unmount()
  })

  test('los ajustes se guardan', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'tab-ajustes' })
    await pane.press({ key: 'set-min-0.5' })
    expect((await pane.find({ key: 'set-min-0.5' }))?.props).toMatchObject({ label: '(•) 0,50 $' })
    await pane.unmount()
  })
})
