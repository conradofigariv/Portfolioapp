/**
 * Whether a metric (a project's metrics, the hero's stats) is worth showing to
 * a visitor: its **value** has to contain a letter or a digit.
 *
 * Both grids are a fixed three columns for the owner to fill, and plenty of
 * portfolios — anyone who isn't in product — have nothing to put in them. An
 * empty value, or the starter copy's "—", on a public page reads as a gap, so
 * those are hidden; a label alone ("Metric") says nothing without its value.
 * The owner's editor always shows all three, so they can still be filled in.
 *
 * Shared by the page and the PDF so both drop the same ones. No imports on
 * purpose: the PDF model is kept dependency-free.
 */
export function metricHasValue(valueText: string): boolean {
  return /[\p{L}\p{N}]/u.test(valueText)
}

/** Tailwind needs whole class names in the source, not built strings. */
export const METRIC_GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
}
