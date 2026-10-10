// Spanish formatting for what the row and the panel show. Written by hand:
// the environment's Intl and time zone are not to be relied on.

const NBSP = ' '

/** "0,52 $", "12,40 $", "<0,01 $". */
export function usd(value: number): string {
  if (value < 0.005) return `<0,01${NBSP}$`
  const digits = value < 100 ? 2 : 0

  return `${value.toFixed(digits).replace('.', ',')}${NBSP}$`
}

/** An estimate: "~0,52 $". */
export function approx(value: number): string {
  return value < 0.005 ? usd(value) : `~${usd(value)}`
}

/** A countdown: "menos de 1 min", "8 min", "1 h 5 min". */
export function remaining(ms: number): string {
  if (ms < 60_000) return 'menos de 1 min'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** How long something ran: "45 s", "2 min 10 s", "1 h 3 min". */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`

  return remaining(ms)
}

/** "1 agente", "3 agentes". */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "claude-opus-5-5" → "Opus 5.5", "haiku" → "Haiku". */
export function shortModel(model: string | null): string {
  const id = (model ?? '').toLowerCase()
  const match = /(fable|mythos|opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2})(?!\d))?)?/.exec(id)
  if (match === null) return model ?? ''
  const [, family = '', major, minor] = match
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  if (major === undefined) return name

  return minor === undefined ? `${name} ${major}` : `${name} ${major}.${minor}`
}

/** One line, cut with an ellipsis. */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length <= max ? line : `${line.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}
