/** Settings row layout shared by the composer's single-choice preferences. */
import { useState } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PreferenceSelectRow.module.css'

/** Localized row copy, choices, and the live selection. */
export interface PreferenceSelectRowProps<T extends string> {
  readonly title: string
  readonly description: string
  /** Choice ids in menu order. */
  readonly order: readonly T[]
  /** Localized label for every choice id. */
  readonly labels: Readonly<Record<T, string>>
  readonly selected: T
  readonly onSelect: (id: T) => void
}

/**
 * Render a titled preference with a menu selector.
 * @param props - localized copy, choices, and selection callbacks.
 * @returns the preference row.
 */
export function PreferenceSelectRow<T extends string>({
  title, description, order, labels, selected, onSelect,
}: PreferenceSelectRowProps<T>) {
  const [open, setOpen] = useState(false)
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{title}</div>
        <div className={css.desc}>{description}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={order.map(id => ({ id, label: labels[id] }))}
        selectedId={selected}
        onSelect={(id) => {
          setOpen(false)
          onSelect(id as T)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          >
            {labels[selected]}
            <IconChevronDownOutlineRegular className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
