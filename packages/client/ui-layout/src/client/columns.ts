/**
 * Normal column geometry: the right column shrinks, then loses its track,
 * before the center drops below its minimum. The sidebar never concedes here;
 * AppFrame supplies its effective preference after responsive collapse.
 *
 * At or below MOBILE_MAX the frame stops being a column layout: center takes
 * the whole viewport and the sidebar leaves the flow for an overlay drawer,
 * whose rendered width is still reported through `sidebar` so AppFrame needs
 * no second geometry source. The rail has no mobile form — a permanent 56px
 * of chrome on a 390px screen is what makes the phone layout unusable — so a
 * closed mobile sidebar resolves to zero.
 */

/**
 * Resolved widths for one frame. `overlay` marks the mobile layout, where
 * `sidebar` is a drawer floating above center rather than a grid track beside it.
 */
export interface Columns { sidebar: number; center: number; rightbar: number; overlay: boolean }

/** Center width protected while the normal right column is open. */
export const CENTER_MIN = 400
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
 * below it the sidebar becomes an overlay drawer and center spans the frame.
 * Tablets stay on the column layout, where a rail beside the conversation is
 * still affordable.
 */
export const MOBILE_MAX = 640
/**
 * Mobile drawer width: nearly the viewport, less a strip of center left
 * visible so the drawer reads as covering the conversation and its scrim is
 * an obvious dismiss target.
 */
export const DRAWER_PEEK = 56
/** Drawer ceiling on larger phones, so it never grows into a second column. */
export const DRAWER_MAX = 320
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
 *   `overlay` result reports a drawer width that does not consume center.
 */
export function computeColumns(viewport: number, sidebar: number, rightbar: number, collapsedWidth = SIDEBAR_COLLAPSED): Columns {
  if (viewport <= MOBILE_MAX) {
    return {
      sidebar: sidebar === 0 ? 0 : Math.min(DRAWER_MAX, Math.max(0, viewport - DRAWER_PEEK)),
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
