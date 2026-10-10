import type { ModelUsage } from 'claude-code'

export const FIVE_MINUTES = 5 * 60_000
export const HOUR = 60 * 60_000

/** Dollars per million tokens. */
type Rates = { input: number; output: number; cacheRead: number }

// Anthropic API list prices, October 2026. A subscription is not billed per
// token: there these are the API-equivalent figures /cost shows too.
const RATES: ReadonlyArray<readonly [RegExp, Rates]> = [
  [/(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1 }],
]

// The session's default model when the id is unknown.
const DEFAULT_RATES: Rates = { input: 4, output: 20, cacheRead: 0.2 }

// Haiku 5.5 bills prompts over 100K tokens at five times its rates.
const HAIKU_LONG: Rates = { input: 0.5, output: 2.5, cacheRead: 0.05 }

export function ratesFor(model: string | null, promptTokens = 0): Rates {
  const id = (model ?? '').toLowerCase()
  if (/haiku-5/.test(id) && promptTokens > 100_000) return HAIKU_LONG
  return RATES.find(([pattern]) => pattern.test(id))?.[1] ?? DEFAULT_RATES
}

/** Writing to the cache costs 1.25x input for five minutes, 2x for an hour. */
const writeMultiplier = (ttlMs: number) => (ttlMs >= HOUR ? 2 : 1.25)

export function usageUsd(usage: ModelUsage, model: string | null, ttlMs: number): number {
  const prompt =
    usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const rates = ratesFor(model, prompt)
  const dollars =
    usage.input_tokens * rates.input +
    usage.output_tokens * rates.output +
    usage.cache_read_input_tokens * rates.cacheRead +
    usage.cache_creation_input_tokens * rates.input * writeMultiplier(ttlMs)

  return dollars / 1e6
}

/** Re-sending the whole conversation once the cache entry has lapsed. */
export function coldResendUsd(model: string | null, contextTokens: number, ttlMs: number): number {
  return (contextTokens * ratesFor(model, contextTokens).input * writeMultiplier(ttlMs)) / 1e6
}

/** Re-sending it while the cache still holds it. */
export function warmResendUsd(model: string | null, contextTokens: number): number {
  return (contextTokens * ratesFor(model, contextTokens).cacheRead) / 1e6
}
