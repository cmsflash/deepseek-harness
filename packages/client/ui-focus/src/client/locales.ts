/** `focus` namespace dictionaries (view tab label, summary row, and metric labels). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'focus'

/** The focus dictionary key set (the source of truth for both locales). */
export type FocusKey =
  | 'view.focus'
  | 'summary.turn'
  | 'summary.turnRange'
  | 'summary.running'
  | 'summary.truncated'
  | 'summary.empty'
  | 'summary.loadOlder'
  | 'summary.latestHeading'
  | 'summary.collapsedHeading'
  | 'summary.expand'
  | 'summary.collapse'
  | 'metric.steps'
  | 'metric.calls'
  | 'metric.linesAdded'
  | 'metric.linesRemoved'
  | 'metric.files'
  | 'metric.elapsed'
  | 'metric.tokens'
  | 'metric.cacheHit'
  | 'total.label'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The focus view tab label, collapsed summary rows, and metric labels. */
    'focus': FocusKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<FocusKey, string> = {
  'view.focus': '聚焦',
  'summary.turn': '第 {turn} 轮',
  'summary.turnRange': '第 {from}–{to} 轮',
  'summary.running': '进行中',
  'summary.truncated': '更早的历史尚未加载，以下统计仅覆盖已加载部分。',
  'summary.empty': '暂无更早的轮次。',
  'summary.loadOlder': '加载更早的历史',
  'summary.latestHeading': '当前轮次',
  'summary.collapsedHeading': '已折叠 {count} 轮',
  'summary.expand': '展开这一轮',
  'summary.collapse': '收起这一轮',
  'metric.steps': '{count} 步',
  'metric.calls': '{count} 次调用',
  'metric.linesAdded': '+{added}',
  'metric.linesRemoved': '-{removed} 行',
  'metric.files': '{count} 个文件',
  'metric.elapsed': '耗时 {duration}',
  'metric.tokens': '{total} tokens（入 {input} / 出 {output}）',
  'metric.cacheHit': '缓存命中 {percent}%',
  'total.label': '合计',
}

/** English dictionary. */
export const en: Record<FocusKey, string> = {
  'view.focus': 'Focus',
  'summary.turn': 'Turn {turn}',
  'summary.turnRange': 'Turns {from}–{to}',
  'summary.running': 'running',
  'summary.truncated': 'Older history is not loaded; the figures below cover the loaded window only.',
  'summary.empty': 'No earlier turns yet.',
  'summary.loadOlder': 'Load earlier history',
  'summary.latestHeading': 'Current turn',
  'summary.collapsedHeading': '{count} earlier turns collapsed',
  'summary.expand': 'Expand this turn',
  'summary.collapse': 'Collapse this turn',
  'metric.steps': '{count} steps',
  'metric.calls': '{count} calls',
  'metric.linesAdded': '+{added}',
  'metric.linesRemoved': '-{removed} lines',
  'metric.files': '{count} files',
  'metric.elapsed': 'ran {duration}',
  'metric.tokens': '{total} tokens ({input} in / {output} out)',
  'metric.cacheHit': '{percent}% cache hit',
  'total.label': 'Total',
}
