/**
 * Tool render-intent vocabulary: the provider-neutral types a tool declares via
 * `ToolDefinition.presentCall`/`ToolDefinition.presentResult` to say how one of its calls
 * renders in a UI (an editor's tool-call card, a CLI log line), plus the pure
 * reading of a settled file mutation's applied diffs that every consumer of
 * the persisted `tool/result` record shares.
 * @module @deepseek-ai/dsh-tools/src/presentation
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * Category of a tool call, used by a UI to pick an icon or treatment. The
 * provider-neutral vocabulary lets tools describe themselves without depending
 * on a particular client; `other` is the default.
 */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

/**
 * A file location a tool reads or modifies, so a capable UI can "follow along" —
 * highlight or jump to the file (and line) as the tool runs. `path` is what the
 * tool operated on (the model-facing path); `line` is an optional 1-based line
 * to focus (e.g. a read's offset).
 */
export interface FileLocation {
  path: string
  line?: number
}

/**
 * A single-file change a tool is about to make, for a UI that renders inline
 * diffs. `oldText` is `null` for a new-file create (nothing to diff against);
 * an overwrite also uses `null`, because a call-time presenter has no access to
 * the file's prior content.
 */
export interface FileDiff {
  path: string
  /** Prior content, or `null` for a new file / an overwrite (no prior content available at call time). */
  oldText: string | null
  /** Content after the change. */
  newText: string
}

/**
 * Provider-neutral pending-call presentation. Tools declare one tagged intent;
 * UI bridges map it without special-casing tool names.
 */
export type ToolCallView = GenericCallView | TerminalCallView | DiffCallView

/**
 * The default card: a titled tool-call row with an optional category icon, a
 * salient raw input, extra content blocks, and follow-along file locations. Any
 * tool whose call is not a terminal or a diff uses this.
 */
export interface GenericCallView {
  card: 'generic'
  /**
   * Human-readable, always-visible label describing what THIS call does. Keep it
   * short — a UI shows it as a card header / log line.
   */
  title: string
  /** Category for icon/treatment; defaults to `other` when omitted. */
  kind?: ToolCallKind
  /**
   * The salient input to show in a detail/expanded view (e.g. a background
   * job id). Omit to show nothing; a string renders as-is, an object as pretty
   * JSON. NOT the full raw args object unless that is genuinely what a reader wants.
   */
  rawInput?: unknown
  /**
   * UI-facing content blocks to show on the pending call alongside the title.
   * Omit to show none. A UI maps these to its own content blocks.
   */
  content?: ContentBlock[]
  /** Files this call reads/modifies, for editor follow-along. Omit for a call that touches no file. */
  locations?: FileLocation[]
}

/**
 * A call that IS a shell command running in a working directory: a capable UI
 * renders it as a terminal card (cwd-headed, with the command as the title and
 * live/afterward output from the {@link TerminalResultView}); an incapable UI
 * falls back to a generic card whose body is the fenced command output. Set by a
 * tool whose call is a foreground command (e.g. `bash`).
 */
export interface TerminalCallView {
  card: 'terminal'
  /** The command, shown as the terminal card's title / header line. */
  title: string
  /**
   * A human-readable one-line summary of what the command does, rendered ABOVE
   * the terminal card (the card itself has no description slot). Omit for none.
   */
  description?: string
  /**
   * Working directory the command runs in, shown as the terminal header. An
   * ABSOLUTE path is used as-is; a RELATIVE path is resolved by the UI bridge
   * against the session workspace (the pure presenter can't see the session cwd).
   * Omit entirely to let the bridge use the session workspace.
   */
  cwd?: string
}

/**
 * A call that creates or modifies files, rendered as an inline diff card by a
 * capable UI. Set by a tool whose call writes/edits a file (e.g. `write`,
 * `edit`). The diffs are derived from the call ARGUMENTS (a create's `oldText` is
 * `null`); the tool emits a separate {@link DiffResultView} after `execute` — the
 * applied change (an edit/overwrite hunk with context, or a whole-file diff for a
 * create).
 */
export interface DiffCallView {
  card: 'diff'
  /** Card header (e.g. `Write foo.txt`). */
  title: string
  /** One entry per file the call changes. */
  diffs: FileDiff[]
  /** Files this call modifies, for editor follow-along (usually the diffs' paths). */
  locations?: FileLocation[]
}

/**
 * One numbered line of a file, the unit a {@link ReadResultView} carries so a
 * capable UI can render a syntax-highlighted, line-numbered code view. `number`
 * is the 1-based line number in the file (a window past `offset` keeps the file's
 * own numbering, not a 1-based re-count); `text` is the line without its trailing
 * newline, already truncated to the read tool's per-line cap.
 */
export interface ReadFileLine {
  number: number
  text: string
}

/**
 * How a tool wants the COMPLETED call shown — the *result* state, after `execute`
 * returns. A `card`-tagged union mirroring {@link ToolCallView}: a UI switches on
 * `card`. Lets the tool reformat its result for a UI distinctly from the
 * model-facing text it returned from `execute`. Returned by
 * `ToolDefinition.presentResult`; omitting the method keeps the pending
 * title and renders the raw result content.
 */
export type ToolResultView = GenericResultView | TerminalResultView | DiffResultView | SearchResultView | ReadResultView | WebResultView

/**
 * The default completed card: an optional replacement title and reformatted
 * content. Omit a field to keep the pending title / render the raw result content.
 */
export interface GenericResultView {
  card: 'generic'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /**
   * UI-facing result content (harness {@link ContentBlock}s), reformatted from
   * the model-facing result. Omit to let the UI render the raw result content.
   */
  content?: ContentBlock[]
}

/**
 * The completed state of a {@link TerminalCallView}: the captured output and exit
 * status. A capable UI renders `output` in the terminal card and shows an
 * exit-status pill; an incapable UI gets a fenced ```console fallback the BRIDGE
 * derives from `output` (the tool does not double-encode it).
 */
export interface TerminalResultView {
  card: 'terminal'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** Captured command output (stdout+stderr as the tool chooses to combine them). */
  output?: string
  /**
   * Process exit code, when the run ended by exiting (not a signal). Lets a
   * capable UI show an exit-status pill. Omit when killed by a signal or unknown.
   */
  exitCode?: number
  /** Signal name that killed the process (e.g. `SIGTERM`). Mutually exclusive with `exitCode`. */
  signal?: string
}

/**
 * A completed file mutation rendered as an inline diff card, the result-time
 * analogue of {@link DiffCallView}. Because a completed UI update replaces the
 * pending card content, mutation tools return this even when it repeats the
 * call-time diff; otherwise raw result text would replace the diff.
 */
export interface DiffResultView {
  card: 'diff'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** The change to show, in file order — applied contextual hunks, or a whole-file diff when there is no before-image. */
  diffs: FileDiff[]
}

/**
 * The persisted facts of one settled root tool call that decide which file
 * changes it applied: the call head as logged by `tool/call`, and the result's
 * outcome and tool-private `meta` as logged by `tool/result`.
 */
export interface SettledToolCallRecord {
  /** Tool name from the call head, or null when the head is unavailable. */
  name: string | null
  /** JSON text of the call arguments, or null when the head is unavailable. */
  argumentsRaw: string | null
  /** Whether the result reported failure, through its block or a recorded error identity. */
  isError: boolean
  /** The result's opaque presentation payload, when the tool attached one. */
  meta: unknown
}

/** Whether `value` is a well-formed {@link FileDiff}. */
function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText } = value as Record<string, unknown>
  return typeof path === 'string'
    && (oldText === null || typeof oldText === 'string')
    && typeof newText === 'string'
}

/**
 * Read the `diffs` a file-mutation tool persisted on its result `meta`
 * (`{ diffs: FileDiff[] }`, the payload `write` and `edit` attach).
 * @returns the hunks, `'empty'` for a valid empty list, or null when absent or malformed.
 */
function persistedDiffs(meta: unknown): FileDiff[] | 'empty' | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const { diffs } = meta as Record<string, unknown>
  if (!Array.isArray(diffs)) return null
  if (diffs.length === 0) return 'empty'
  return diffs.every(isFileDiff) ? diffs : null
}

/**
 * The whole-file diff a `write` call describes through its own arguments, for
 * a create or an identical overwrite whose result persisted no applied hunk.
 * @returns the diff, or null when the head is not a `write` with a path and content.
 */
function intendedWriteDiff(record: SettledToolCallRecord): FileDiff | null {
  if (record.name !== 'write' || record.argumentsRaw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(record.argumentsRaw)
  } catch {
    // Only JSON.parse throws here; arguments that never parsed name no file.
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { file_path: path, content } = parsed as Record<string, unknown>
  if (typeof path !== 'string' || path.trim() === '' || typeof content !== 'string') return null
  return { path, oldText: null, newText: content }
}

/**
 * Read a settled root call's persisted diff images, ignoring failed outcomes.
 * A successful `write` without usable hunks retains the documented whole-file
 * argument fallback. Creates and identical overwrites share that representation,
 * so its line volume describes the displayed image, not an inferred filesystem
 * change. An `edit` without usable metadata contributes no diff. Nested dispatches
 * carry no persisted `meta`; callers pass only root results here.
 * @param record - the settled call's persisted head, outcome, and metadata.
 * @returns the applied diffs in file order; empty when none can be read.
 */
export function appliedFileDiffs(record: SettledToolCallRecord): FileDiff[] {
  if (record.isError) return []
  const persisted = persistedDiffs(record.meta)
  if (persisted !== null && persisted !== 'empty') return persisted
  const intended = intendedWriteDiff(record)
  return intended === null ? [] : [intended]
}

/**
 * Split one file image into its lines. A single terminating newline ends the
 * last line rather than starting an empty one.
 */
function lines(text: string): readonly string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * Added and removed line counts for one {@link FileDiff}.
 *
 * A diff carries before/after images rather than a hunk list, so this is a
 * line-multiset difference: lines present in both cancel regardless of
 * position, which reads a moved line as unchanged and a modified line as one
 * addition plus one removal. Context lines an applied hunk repeats on both
 * sides cancel the same way.
 * @param diff - one applied file change.
 * @returns the added and removed line counts.
 */
export function fileDiffLineDelta(diff: Pick<FileDiff, 'oldText' | 'newText'>): { added: number; removed: number } {
  if (diff.oldText === null) return { added: lines(diff.newText).length, removed: 0 }
  const remaining = new Map<string, number>()
  for (const line of lines(diff.oldText)) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  let added = 0
  for (const line of lines(diff.newText)) {
    const available = remaining.get(line) ?? 0
    if (available > 0) remaining.set(line, available - 1)
    else added += 1
  }
  let removed = 0
  for (const surplus of remaining.values()) removed += surplus
  return { added, removed }
}

/** One matched line inside a {@link SearchFileMatches} group: its 1-based line number and text. */
export interface SearchLineMatch {
  /** 1-based line number of the match within its file. */
  lineNumber: number
  /** The matched line text, as the tool surfaced it (the per-line preview budget already applied). */
  line: string
}

/** One file's grouped content matches for a {@link SearchMatchesResultView}, in first-seen file order. */
export interface SearchFileMatches {
  /** The file the matches belong to (the model-facing display path). */
  path: string
  /** The file's matched lines, in output order. */
  matches: SearchLineMatch[]
}

/**
 * A completed content search (`grep`) rendered as a search card whose matches are
 * grouped by file, so a capable UI can list each file as an expandable group of
 * its matched lines. `shape: 'matches'` discriminates this variant from the path
 * variant ({@link SearchPathsResultView}) within {@link SearchResultView}. The
 * discriminant is `shape`, not `kind`, so it never collides with the
 * {@link ToolCallKind} `kind` an icon-picking bridge reads off a call view.
 */
export interface SearchMatchesResultView {
  card: 'search'
  shape: 'matches'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** Matched lines grouped by file, in first-seen file order. */
  files: SearchFileMatches[]
  /**
   * Whether the tool capped the inline result: `files` carries only the retained
   * matches, not every match the search found. A UI shows a capped indicator so it
   * never presents a partial group as complete.
   */
  truncated: boolean
  /** Total matches the search found before capping (equals the retained count when not `truncated`). */
  total: number
}

/**
 * A completed path search (`glob`) rendered as a search card whose result is a flat
 * path list. `shape: 'paths'` discriminates this variant from the grouped-matches
 * variant ({@link SearchMatchesResultView}) within {@link SearchResultView}.
 */
export interface SearchPathsResultView {
  card: 'search'
  shape: 'paths'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** The discovered paths, in the tool's result order (the retained page when `truncated`). */
  paths: string[]
  /**
   * Whether the tool capped the inline result: `paths` carries only the retained
   * page, not every path the search found. A UI shows a capped indicator so it
   * never presents a partial list as complete.
   */
  truncated: boolean
  /** Total paths the search found before capping (equals `paths.length` when not `truncated`). */
  total: number
}

/**
 * A completed search rendered as a search card, the result-time view a discovery
 * tool (`grep`, `glob`) returns from `presentResult`. One `card: 'search'` view
 * with two `shape`-discriminated variants: grouped-by-file content matches
 * ({@link SearchMatchesResultView}) and a flat path list
 * ({@link SearchPathsResultView}). Both carry a `truncated`/`total` signal so a UI
 * never presents a capped result as complete. The view carries no result text: a
 * UI without a search card falls back to the raw `tool/result` content. There is
 * no call-time analogue: a search call stays a {@link GenericCallView}
 * (`kind: 'search'`) because the pending state has no matches or paths to show —
 * the structured shape exists only after `execute`.
 */
export type SearchResultView = SearchMatchesResultView | SearchPathsResultView

/**
 * A completed file read rendered as a line-numbered, optionally syntax-highlighted
 * code view by a capable UI. Set by a tool whose call reads file text (e.g.
 * `read`); the pending state stays a {@link GenericCallView} (`kind: 'read'`)
 * because a call carries no content until `execute` returns. The structured
 * `lines`/`path`/`lang`/`totalLines` fields cannot be reconstructed from the
 * model-facing result text alone, so the read tool projects them through its
 * `output.presentationMeta` (persisted with the session log) and `presentResult`
 * narrows that metadata back into this view on live and replay paths alike. A UI
 * without the read capability falls back to `content` (the model-facing text with
 * its envelope stripped), so this view degrades to the generic text card.
 */
export interface ReadResultView {
  card: 'read'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** The read file's path (the model-facing path; the bridge relativizes it). */
  path: string
  /**
   * The 1-based first line the window requested, preserved even when `lines` is
   * empty (a byte cap below the first selected line yields an empty window) so a
   * UI knows where the window starts and where a continuation resumes.
   */
  offset: number
  /** The returned window's lines, in file order, each keeping its file line number. */
  lines: ReadFileLine[]
  /** Exact total line count in the file, so a UI can show a "showing N of M" affordance. */
  totalLines: number
  /**
   * A syntax-highlighting language hint derived from the file extension (e.g.
   * `ts`, `py`), or omitted when the extension maps to no known language so a UI
   * renders the lines as plain text.
   */
  lang?: string
  /**
   * The model-facing result content with its envelope stripped, for a UI without
   * the read capability. Omit to let such a UI render the raw result content.
   */
  content?: ContentBlock[]
}

/**
 * One citeable source in a completed {@link WebSearchResultView}, the faithful
 * projection of one web-search source. The presentation projection of `dsh-web`'s
 * `WebSearchSource`: that Service Definition type is authoritative (core cannot depend
 * on the web Service Definition, so the two are declared separately and MUST evolve together).
 * A web tool projects this shape through `output.presentationMeta` because the
 * render text cannot losslessly carry it (see the web-result-card Agent Note); its
 * `presentResult` reads it back.
 */
export interface WebSource {
  /** The source URL. */
  url: string
  /** The source title, when the provider returned one. */
  title?: string
  /** A short excerpt or summary, when the provider returned one. */
  snippet?: string
  /** Publication/crawl timestamp as a provider-supplied ISO-8601 string, when present. */
  publishedAt?: string
}

/**
 * A completed web retrieval rendered as a structured card by a capable UI. Set
 * by a web tool whose call retrieves from the web (`web_search`, `web_fetch`).
 * One `kind`-tagged union carries both shapes because both are web retrieval and
 * a UI renders them with one component family; a UI switches on `kind`. An
 * incapable UI falls back to the raw `tool/result` content (this view carries no
 * `content` copy — see the web-result-card Agent Note). This is the result-time
 * analogue of the `web_search`/`web_fetch` calls' generic call views
 * (`kind: 'search'`/`'fetch'`); those tools keep their generic pending card and
 * add only this completed card.
 *
 * The `kind` field here is this union's own discriminant, NOT a
 * {@link ToolCallKind}: the two values deliberately match the tools' pending
 * `ToolCallKind` (`'search'`/`'fetch'`) so a call and its result read as one
 * category, but a new arm is a union edit plus a consumer branch, not any
 * arbitrary `ToolCallKind` value.
 */
export type WebResultView = WebSearchResultView | WebFetchResultView

/**
 * The completed state of a `web_search` call: the structured sources the model
 * cited, an optional provider answer, and whether the source list was cut to the
 * result cap. A capable UI renders the sources as a citation list; a UI without
 * the `web` capability falls back to the raw `tool/result` content.
 */
export interface WebSearchResultView {
  card: 'web'
  kind: 'search'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** The faithful, structured sources — the field render text cannot losslessly carry. */
  sources: WebSource[]
  /** The provider-generated answer text, when any. */
  answer?: string
  /** True when the web service cut the source list to honor the result cap. */
  truncated: boolean
}

/**
 * The completed state of a `web_fetch` call: the fetched URL, its HTTP status,
 * and whether the content was cut. The body itself is already markdown in the
 * raw `tool/result` content, so this card carries only the retrieval summary and
 * a UI without the `web` capability falls back to that content.
 */
export interface WebFetchResultView {
  card: 'web'
  kind: 'fetch'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** The final URL after allowed redirects. */
  url: string
  /** HTTP status code of the fetched response. */
  statusCode: number
  /**
   * True when the provider capped the decoded body, or the output cap or a
   * pre-conversion source cut trimmed the rendered text (the effective
   * truncation the model-facing text also reflects).
   */
  truncated: boolean
}
