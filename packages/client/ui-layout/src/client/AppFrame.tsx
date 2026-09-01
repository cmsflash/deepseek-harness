/**
 * Shell frame, registered into the built-in 'root' slot (the web shell renders
 * only 'root'). Owns the grid tracks (sidebar | center | details), the drag
 * handles (pointer capture + rAF throttle), the concession chain (columns.ts),
 * and the child-slot render decisions: the sidebar slot renders HERE with live
 * parameters from the concession solve, and the session-aware occupants render
 * in fixed column positions; strict entries gate themselves on current-session
 * availability while session-maybe entries retain identity.
 *
 * A mobile solve (columns.ts MOBILE_MAX) collapses the grid to the single
 * center track and moves the sidebar to an overlay drawer with a dismiss
 * scrim. The slot occupants keep their tree positions and React identity
 * across that switch — only the frame's own geometry changes — so nothing
 * remounts when a window crosses the breakpoint.
 *
 * Pure component: everything arrives through the three framework shares —
 * zero cordis or framework imports, zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { computeColumns, MOBILE_MAX, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT } from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'layout'>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  t,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  // A viewport change that leaves the frame's box unchanged still has to be
  // seen — the frame fills the window, so the two normally agree, but a
  // resize that does not settle the observed element (a devtools viewport
  // override, an emulated resize) would otherwise strand the layout at the
  // width it last measured, including on the wrong side of a breakpoint.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const measure = (): void => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports auto-collapse the sidebar; the store mirror keeps
  // toggleSidebar's semantics right (narrow toggles flip the manual
  // re-expand override, stores.ts). Collapsed is decided here, so the
  // solver stays free of the collapse breakpoint: a narrow re-expand passes
  // the preference (or the default when the wide preference is closed) and
  // the center absorbs the squeeze. On mobile the same override opens the
  // drawer, which floats instead of squeezing.
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const mobile = viewport <= MOBILE_MAX
  useEffect(() => { actions.setNarrow(narrow, mobile) }, [actions, mobile, narrow])
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  const cols = computeColumns(viewport, sidebarPreference, detailsSession === undefined ? 0 : panels.details)
  const colsRef = useRef(cols)
  colsRef.current = cols

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        // Mobile lifts the sidebar out of the flow, so the frame is a single
        // center track; the drawer is sized from its own inline width below.
        gridTemplateColumns: cols.overlay
          ? 'minmax(0, 1fr)'
          : `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px`,
      }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-dragging={dragging || undefined}
      data-overlay={cols.overlay || undefined}
    >
      <div
        className={css.sidebarCol}
        style={cols.overlay ? { width: cols.sidebar } : undefined}
        data-open={cols.overlay && !sidebarCollapsed ? true : undefined}
        // A closed drawer is off-screen decoration: keep it out of the tab
        // order and off the accessibility tree rather than leaving focusable
        // controls behind the conversation. React 18's JSX types predate the
        // `inert` property, so it goes through as the plain DOM attribute.
        aria-hidden={cols.overlay && sidebarCollapsed ? true : undefined}
        {...(cols.overlay && sidebarCollapsed ? { inert: '' } : {})}
      >
        {/* Render-site slot call with live concession output: a closed
            sidebar keeps the mounted slot at the compact-rail width, and the
            component sees its rendered state as owner params decided here
            (collapsed follows the resolved rail, so a derived auto-collapse
            renders the rail UI too). The mobile drawer has no rail, so it
            reports itself expanded whenever it is open. */}
        {renderSlot('sidebar', {
          collapsed: cols.overlay ? false : sidebarCollapsed,
          width: cols.sidebar,
        })}
      </div>
      {/* Scrim: only an open mobile drawer has anything to dismiss. */}
      {cols.overlay && !sidebarCollapsed && (
        <div
          className={css.scrim}
          role="presentation"
          onClick={() => { actions.toggleSidebar() }}
        />
      )}
      {/* The mobile drawer leaves no rail behind, so the frame owns the only
          control that can bring it back. It sits here rather than in the
          conversation header because the hero state renders no header, and a
          closed drawer with no opener strands the user in one session. */}
      {cols.overlay && sidebarCollapsed && (
        <button
          type="button"
          className={css.drawerOpener}
          aria-label={t('sidebar.open')}
          onClick={() => { actions.toggleSidebar() }}
        >
          <IconPanelLeftOutline16 size={18} />
        </button>
      )}
      <>
        {/* Both column occupants stay at fixed tree positions from first
            paint — no loading gate: a bare status line reads worse than
            the shell's own pending rendering. The conversation
            is session-maybe; the strict details entry naturally renders
            empty while no session is current. */}
        <CenterColumn>{renderSlot('conversation', {})}</CenterColumn>
        <DetailsColumn>{renderSlot('details', {})}</DetailsColumn>
      </>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* The collapsed rail is fixed-width: no resize handle while closed.
          Mobile has no column border to drag, and a col-resize strip over a
          touch target would only steal the gesture. */}
      {!cols.overlay && !sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {!cols.overlay && cols.details > 0 && <DragHandle side="details" left={viewport - cols.details} onStart={onDetailsStart} onDrag={onDetailsDrag} onEnd={onDragEnd} />}
    </div>
  )
}
