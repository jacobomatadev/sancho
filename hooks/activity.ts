import type { AgentTodos } from '../types'
import { clip } from './format'

const fileName = (path: unknown) =>
  typeof path === 'string' ? (path.split('/').filter(Boolean).pop() ?? path) : 'un archivo'

const text = (value: unknown, max: number) => clip(typeof value === 'string' ? value : '', max)

function host(url: unknown): string {
  try {
    return new URL(String(url)).host
  } catch {
    return 'una página'
  }
}

/** What a subagent is doing, in words, from the tool it just called. */
export function activityOf(tool: string, input: Readonly<Record<string, unknown>>): string {
  switch (tool) {
    case 'Read':
      return `Leyendo ${fileName(input.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `Editando ${fileName(input.file_path)}`
    case 'Write':
      return `Escribiendo ${fileName(input.file_path)}`
    case 'NotebookEdit':
      return `Editando ${fileName(input.notebook_path)}`
    case 'Bash':
      return `Ejecutando ${text(input.description ?? input.command, 48)}`
    case 'Grep':
      return `Buscando «${text(input.pattern, 32)}»`
    case 'Glob':
      return `Buscando archivos ${text(input.pattern, 32)}`
    case 'WebFetch':
      return `Leyendo ${host(input.url)}`
    case 'WebSearch':
      return `Buscando en la web «${text(input.query, 32)}»`
    case 'Agent':
    case 'Task':
      return `Delegando: ${text(input.description, 40)}`
    case 'TodoWrite':
      return 'Actualizando su lista de tareas'
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      return mcp === null ? `Usando ${tool}` : `Usando ${mcp[2]} (${mcp[1]})`
    }
  }
}

/** How far a subagent is through its own task list, when it keeps one. */
export function todosOf(input: Readonly<Record<string, unknown>>): AgentTodos | null {
  const todos = input.todos
  if (!Array.isArray(todos) || todos.length === 0) return null
  const done = todos.filter(
    todo => typeof todo === 'object' && todo !== null && 'status' in todo && todo.status === 'completed',
  ).length

  return { done, total: todos.length }
}
