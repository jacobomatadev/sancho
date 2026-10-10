import type { Color, ElementTable } from 'claude-code'

import type { AgentRow, FileEdit, Hold, Note, PanelTab, SanchoSettings } from '../types'
import { filesOf } from './changes'
import { approx, clip, count, elapsed, shortModel, usd } from './format'
import type { RowModel } from './model'

export type RowActions = {
  startFresh: () => void
  continueHere: () => void
  askAboutRisk: () => void
  saveRule: (scope: 'project' | 'global') => void
  dismissNote: () => void
  openPanel: (tab: PanelTab) => void
}

function holdView(els: ElementTable, hold: Hold, act: RowActions) {
  const { Box, Text, Button } = els

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="warning">⏸ </Text>
        <Text bold>Continuar esta conversación costará {approx(hold.coldUsd)}</Text>
      </Box>
      <Text dimColor>
        Ha pasado tiempo y Claude tendría que releerla entera. Una conversación nueva sale casi gratis, pero empieza
        sin este contexto.
      </Text>
      {hold.isInBox ? null : (
        <Text dimColor wrap="truncate-end">
          Tu mensaje: «{clip(hold.text, 100)}»
        </Text>
      )}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="hold-fresh" variant="primary" label="Empezar una nueva" onPress={act.startFresh} />
        <Button key="hold-continue" label="Continuar aquí" onPress={act.continueHere} />
      </Box>
    </Box>
  )
}

function noteView(els: ElementTable, note: Note, act: RowActions) {
  const { Box, Text, Button } = els
  if (note.kind === 'risk') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="warning">⚠ </Text>
          <Text bold>Ojo: {note.title}</Text>
        </Box>
        {note.detail !== '' ? <Text dimColor>{note.detail}</Text> : null}
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button key="note-ask" label="Pregúntale a Claude" onPress={act.askAboutRisk} />
          <Button key="note-dismiss" role="dismiss" label="Entendido" onPress={act.dismissNote} />
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row" flexShrink={1}>
        <Text color="claude">✎ </Text>
        <Text dimColor>¿Guardar como regla? </Text>
        <Text wrap="truncate-end">«{note.rule}»</Text>
      </Box>
      <Box flexDirection="row" gap={1} flexShrink={0}>
        <Button
          key="rule-project"
          variant={note.scope === 'project' ? 'primary' : 'secondary'}
          label="En este proyecto"
          onPress={() => act.saveRule('project')}
        />
        <Button
          key="rule-global"
          variant={note.scope === 'global' ? 'primary' : 'secondary'}
          label="En todos"
          onPress={() => act.saveRule('global')}
        />
        <Button key="rule-no" role="dismiss" label="No" dimColor onPress={act.dismissNote} />
      </Box>
    </Box>
  )
}

/** The one row above the prompt: a decision, the agents at work, or what the last turn did. */
export function rowView(els: ElementTable, model: RowModel, act: RowActions) {
  if (model.kind === 'hold') return holdView(els, model.hold, act)
  if (model.kind === 'note') return noteView(els, model.note, act)

  const { Box, Text, Button } = els
  const parts: { glyph: string; color: Color; text: string }[] = []
  if (model.kind === 'agents') {
    parts.push({
      glyph: '◐',
      color: 'claude',
      text: `${count(model.running, 'agente', 'agentes')} trabajando · ${approx(model.usd)}`,
    })
  } else {
    const { changes, agents } = model
    if (changes !== null) {
      parts.push({
        glyph: '✎',
        color: 'claude',
        text: `${count(changes.files, 'archivo cambiado', 'archivos cambiados')} · +${changes.additions} −${changes.deletions}`,
      })
    }
    if (agents !== null) {
      const failed = agents.failed > 0 ? ` · ${count(agents.failed, 'falló', 'fallaron')}` : ''
      parts.push({
        glyph: agents.failed > 0 ? '✗' : '✓',
        color: agents.failed > 0 ? 'error' : 'success',
        text: `${count(agents.count, 'agente terminó', 'agentes terminaron')} · ${approx(agents.usd)}${failed}`,
      })
    }
  }
  const hasChanges = model.kind === 'summary' && model.changes !== null
  const hasAgents = model.kind === 'agents' || (model.kind === 'summary' && model.agents !== null)

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row" flexShrink={1}>
        {parts.map((part, index) => (
          <Box flexDirection="row" flexShrink={1}>
            {index > 0 ? <Text dimColor>{'   '}</Text> : null}
            <Text color={part.color}>{part.glyph} </Text>
            <Text dimColor wrap="truncate-end">
              {part.text}
            </Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="row" gap={1} flexShrink={0}>
        {hasChanges ? (
          <Button key="row-changes" label="Revisar cambios" onPress={() => act.openPanel('cambios')} />
        ) : null}
        {hasAgents ? <Button key="row-agents" label="Ver agentes" onPress={() => act.openPanel('agentes')} /> : null}
        <Button key="row-panel" label="⚙" plain dimColor onPress={() => act.openPanel('ajustes')} />
      </Box>
    </Box>
  )
}

export type PaneActions = {
  setTab: (tab: PanelTab) => void
  showEdit: (index: number) => void
  close: () => void
  setSettings: (patch: Partial<SanchoSettings>) => void
}

export type PaneContext = {
  tab: PanelTab
  agents: readonly AgentRow[]
  settings: SanchoSettings
  sessionUsd: number | null
  now: number
  bodyRows: number
  /** This turn's edits, oldest first, and which one is shown. */
  edits: readonly FileEdit[]
  cursor: number
  reads: number
}

function changesBody(els: ElementTable, ctx: PaneContext, act: PaneActions) {
  const { Box, Text, Button, Code } = els
  if (ctx.edits.length === 0) {
    return (
      <Text dimColor>
        Claude no ha cambiado archivos en este turno
        {ctx.reads > 0 ? ` (ha leído ${count(ctx.reads, 'archivo', 'archivos')})` : ''}. Cuando edite alguno, aquí
        podrás revisar cada cambio, uno a uno.
      </Text>
    )
  }

  const files = filesOf(ctx.edits)
  const index = Math.min(Math.max(ctx.cursor, 0), ctx.edits.length - 1)
  const edit = ctx.edits[index]
  if (edit === undefined) return null
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const listRoom = Math.max(2, Math.min(files.length, Math.floor(ctx.bodyRows / 4)))

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {count(files.length, 'archivo', 'archivos')} · +{additions} −{deletions}
        {ctx.reads > 0 ? ` · leyó ${ctx.reads}` : ''}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {files.slice(0, listRoom).map(file => (
          <Button
            key={`file-${file.firstIndex}`}
            plain
            dimColor={file.path !== edit.path}
            label={`${file.path === edit.path ? '›' : ' '} ${file.isNew ? '+' : '✎'} ${file.path}  +${file.additions} −${file.deletions}`}
            onPress={() => act.showEdit(file.firstIndex)}
          />
        ))}
        {files.length > listRoom ? <Text dimColor>  y {files.length - listRoom} más</Text> : null}
      </Box>
      <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
        <Text wrap="truncate-end">
          Cambio {index + 1} de {ctx.edits.length} · {edit.path}
        </Text>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {index > 0 ? <Button key="edit-prev" label="‹ Anterior" onPress={() => act.showEdit(index - 1)} /> : null}
          {index < ctx.edits.length - 1 ? (
            <Button key="edit-next" variant="primary" label="Siguiente ›" onPress={() => act.showEdit(index + 1)} />
          ) : null}
        </Box>
      </Box>
      {edit.patch === '' ? (
        <Text dimColor>Este cambio es demasiado grande para mostrarlo aquí.</Text>
      ) : (
        <Code source={edit.patch} format="diff" path={edit.path} />
      )}
    </Box>
  )
}

const STATUS_GLYPH: Record<AgentRow['status'], { glyph: string; color: Color; word: string }> = {
  running: { glyph: '◐', color: 'claude', word: '' },
  done: { glyph: '✓', color: 'success', word: 'terminado' },
  failed: { glyph: '✗', color: 'error', word: 'falló' },
  stopped: { glyph: '■', color: 'inactive', word: 'detenido' },
}

function agentDetail(agent: AgentRow, now: number): string {
  const parts = [shortModel(agent.model), elapsed((agent.endedAt ?? now) - agent.startedAt)]
  if (agent.status !== 'running') return [...parts, STATUS_GLYPH[agent.status].word].filter(Boolean).join(' · ')
  if (agent.steps > 0) parts.push(`paso ${agent.steps}`)
  if (agent.todos !== null) parts.push(`${agent.todos.done}/${agent.todos.total} tareas`)
  parts.push(agent.activity ?? 'Pensando…')

  return parts.filter(Boolean).join(' · ')
}

/** Running first, newest first; then the rest, the latest to end first. */
function ordered(agents: readonly AgentRow[]): AgentRow[] {
  const running = agents.filter(a => a.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
  const ended = agents
    .filter(a => a.status !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))

  return [...running, ...ended]
}

function agentsBody(els: ElementTable, ctx: PaneContext) {
  const { Box, Text } = els
  if (ctx.agents.length === 0) {
    return (
      <Text dimColor>
        Aún no hay subagentes en esta sesión. Cuando Claude reparta el trabajo entre varios, aquí verás qué hace cada
        uno, cuánto lleva y cuánto cuesta.
      </Text>
    )
  }

  const room = Math.max(1, Math.floor((ctx.bodyRows - 5) / 2))
  const list = ordered(ctx.agents)
  const shown = list.slice(0, room)
  const total = ctx.agents.reduce((sum, agent) => sum + agent.usd, 0)

  return (
    <Box flexDirection="column">
      {shown.map(agent => {
        const look = STATUS_GLYPH[agent.status]
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Box flexDirection="row" flexShrink={1}>
                <Text color={look.color}>{look.glyph} </Text>
                <Text wrap="truncate-end" dimColor={agent.status !== 'running'}>
                  {agent.description === '' ? agent.type : agent.description}
                </Text>
              </Box>
              <Text dimColor>{approx(agent.usd)}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {agentDetail(agent, ctx.now)}
            </Text>
          </Box>
        )
      })}
      {list.length > shown.length ? <Text dimColor>y {list.length - shown.length} más</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>
          Agentes {approx(total)}
          {ctx.sessionUsd !== null ? ` · Sesión ${approx(ctx.sessionUsd)}` : ''} · cifras estimadas
        </Text>
      </Box>
    </Box>
  )
}

const check = (on: boolean) => (on ? '[✓]' : '[ ]')
const radio = (on: boolean) => (on ? '(•)' : '( )')

const HOLD_THRESHOLDS = [0.25, 0.5, 1, 2] as const

function settingsBody(els: ElementTable, ctx: PaneContext, act: PaneActions) {
  const { Box, Text, Button } = els
  const s = ctx.settings

  return (
    <Box flexDirection="column">
      <Button
        key="set-hold"
        plain
        label={`${check(s.holdEnabled)} Preguntar antes de continuar una conversación cara`}
        onPress={() => act.setSettings({ holdEnabled: !s.holdEnabled })}
      />
      {s.holdEnabled ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginLeft={4}>
          <Text dimColor>a partir de</Text>
          {HOLD_THRESHOLDS.map(value => (
            <Button
              key={`set-min-${value}`}
              plain
              label={`${radio(s.holdMinUsd === value)} ${usd(value)}`}
              onPress={() => act.setSettings({ holdMinUsd: value })}
            />
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Button
          key="set-risk"
          plain
          label={`${check(s.riskEnabled)} Avisarme de riesgos cuando Claude cambie archivos`}
          onPress={() => act.setSettings({ riskEnabled: !s.riskEnabled })}
        />
      </Box>
      <Button
        key="set-rules"
        plain
        label={`${check(s.rulesEnabled)} Proponer guardar mis correcciones como reglas`}
        onPress={() => act.setSettings({ rulesEnabled: !s.rulesEnabled })}
      />
      <Box marginTop={1}>
        <Text dimColor>
          Los avisos y las reglas usan Haiku: una llamada pequeña por turno con cambios o por corrección. Los importes son estimaciones con precios de la API. Con una suscripción no pagas por token: tómalos como
          referencia de lo que consume cada cosa.
        </Text>
      </Box>
    </Box>
  )
}

/** The panel: what the turn changed, the agents at work, or Sancho's few settings. */
export function paneView(els: ElementTable, ctx: PaneContext, act: PaneActions) {
  const { Box, Button } = els
  const tab = (id: PanelTab, label: string) => (
    <Button
      key={`tab-${id}`}
      label={label}
      variant={ctx.tab === id ? 'primary' : 'secondary'}
      dimColor={ctx.tab !== id}
      onPress={() => act.setTab(id)}
    />
  )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          {tab('cambios', 'Cambios')}
          {tab('agentes', 'Agentes')}
          {tab('ajustes', 'Ajustes')}
        </Box>
        <Button key="pane-close" role="dismiss" label="Cerrar" dimColor onPress={act.close} />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {ctx.tab === 'cambios'
          ? changesBody(els, ctx, act)
          : ctx.tab === 'agentes'
            ? agentsBody(els, ctx)
            : settingsBody(els, ctx, act)}
      </Box>
    </Box>
  )
}
