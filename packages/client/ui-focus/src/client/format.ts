// Display formatting for the collapsed metric rows.

/**
 * Compact token count: 517 / 12.2K / 1.2M (one decimal under three digits).
 * @param n - token count.
 * @returns display string.
 */
export function formatTokens(n: number): string {
  const scaled = (value: number): string =>
    value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/**
 * Compact duration: 0.8s / 45.2s under a minute, 2m42s under an hour, 1h04m above.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number): string {
  const seconds = ms / 1_000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const whole = Math.round(seconds)
  if (whole < 3_600) return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`
  return `${Math.floor(whole / 3_600)}h${String(Math.floor(whole % 3_600 / 60)).padStart(2, '0')}m`
}
