/**
 * Normal column geometry: the right column shrinks, then loses its track,
 * before the center drops below its minimum. The sidebar never concedes here;
 * AppFrame supplies its effective preference after responsive collapse.
 *
 * At or below MOBILE_MAX the frame stops being a column layout: the sidebar
 * and the conversation become two full-viewport views stacked in the same
 * area, and only one of them is on screen at a time.
 */

/**
 * Resolved widths for one frame. `overlay` marks the mobile layout, where
 * `sidebar` and `center` are both the whole viewport rather than grid tracks.
 */
export interface Columns { sidebar: number; center: number; rightbar: number; overlay: boolean }

/** Center width protected while the normal right column is open. */
export const CENTER_MIN = 300
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/**
 * Widest viewport still treated as a phone (deepsuite SM breakpoint): at or
 * below it the thread list and the conversation are separate full-screen
 * views. Tablets stay on the column layout, where a rail beside the
 * conversation is still affordable.
 */
export const MOBILE_MAX = 640
/** Right column drag clamp floor. */
export const RIGHTBAR_MIN = 300
/** Maximum normal right panel width as a fraction of the frame. */
export const RIGHTBAR_MAX_RATIO = 0.7
/** First-open right panel preference as a fraction of the frame. */
export const RIGHTBAR_DEFAULT_RATIO = 0.45

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the three column widths for one viewport frame.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param rightbar - requested right panel width in px (0 = no track).
 * @param collapsedWidth - track width of the closed sidebar; the default keeps
 *   the icon rail, 0 hides the column entirely (macOS desktop).
 * @returns actual widths after shrinking or removing the right track; only
 *   without that track may the center fall below its minimum, down to zero.
 *   On the column layout a closed sidebar keeps its compact rail, while an
 *   `overlay` result gives both views the whole viewport whether or not the
 *   thread list is the one on screen.
 */
export function computeColumns(viewport: number, sidebar: number, rightbar: number, collapsedWidth = SIDEBAR_COLLAPSED): Columns {
  if (viewport <= MOBILE_MAX) {
    return {
      sidebar: Math.max(0, viewport),
      center: Math.max(0, viewport),
      rightbar: 0,
      overlay: true,
    }
  }
  const s = sidebar === 0 ? collapsedWidth : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const available = viewport - s - CENTER_MIN
  const r = rightbar === 0 || available < RIGHTBAR_MIN
    ? 0
    : Math.min(available, clampWidth(rightbar, RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO))
  return { sidebar: s, center: Math.max(0, viewport - s - r), rightbar: r, overlay: false }
}
