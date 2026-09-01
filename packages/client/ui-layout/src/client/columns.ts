/**
 * Pure concession-chain column solver for the AppFrame.
 * Chain order is fixed by contract: keep center >= CENTER_MIN by shrinking
 * details, then auto-closing it (derived zero width — preferred width
 * preferences are never rewritten, so widening the window restores them).
 * The sidebar never concedes on a column layout: its rendered width is always
 * the drag preference (or the collapsed rail), and center absorbs any
 * remaining deficit as the last resort. Inputs are the layout store's plain
 * width preferences (0 = closed); a closed sidebar resolves to the fixed
 * SIDEBAR_COLLAPSED control rail while closed details resolve to zero width.
 *
 * At or below MOBILE_MAX the frame stops being a column layout: center takes
 * the whole viewport and the sidebar leaves the flow for an overlay drawer,
 * whose rendered width is still reported through `sidebar` so AppFrame needs
 * no second geometry source. The rail has no mobile form — a permanent 56px
 * of chrome on a 390px screen is what makes the phone layout unusable — so a
 * closed mobile sidebar resolves to zero. The SIDEBAR_AUTO_COLLAPSE
 * breakpoint stays with AppFrame, which decides the effective sidebar
 * preference before solving.
 */

/**
 * Resolved widths for one frame; center may drop below CENTER_MIN only at the
 * final fallback. `overlay` marks the mobile layout, where `sidebar` is a
 * drawer floating above center rather than a grid track beside it.
 */
export interface Columns { sidebar: number; center: number; details: number; overlay: boolean }

// Contract-frozen geometry: the concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
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
/** Details drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360

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
 * Solve the column widths for one viewport frame. Pure: no hysteresis — the
 * output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @returns resolved widths; details 0 means visually closed (never unmounted).
 * On the column layout a closed sidebar keeps its compact rail, while an
 * `overlay` result reports a drawer width that does not consume center.
 */
export function computeColumns(viewport: number, sidebar: number, details: number): Columns {
  // Mobile: one full-width center column. Details has no room to open beside
  // it, and the sidebar only ever floats over it, so neither takes flow width.
  if (viewport <= MOBILE_MAX) {
    return {
      sidebar: sidebar === 0 ? 0 : Math.min(DRAWER_MAX, Math.max(0, viewport - DRAWER_PEEK)),
      center: Math.max(0, viewport),
      details: 0,
      overlay: true,
    }
  }

  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)

  // Step 1: everything fits at preferred widths.
  if (s + d0 + CENTER_MIN <= viewport) return { sidebar: s, center: viewport - s - d0, details: d0, overlay: false }

  // Step 2: shrink details toward its minimum.
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - CENTER_MIN)
  if (s + d1 + CENTER_MIN <= viewport) return { sidebar: s, center: CENTER_MIN, details: d1, overlay: false }

  // Step 3: auto-close details (derived — preferences untouched); center
  // absorbs any remaining deficit (may drop below CENTER_MIN).
  return { sidebar: s, center: Math.max(0, viewport - s), details: 0, overlay: false }
}
