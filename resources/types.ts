// Client-side mirror of the Go dataset.Request contract. Sent as GraphQL
// variables (enum values travel as plain strings in variables, so no special
// casing needed). int64 columns arrive as strings via the Long scalar.

export type SortDir = 'ASC' | 'DESC'

export type DataSetOrder = { field: string; order: SortDir }

export type DataSetRequest = {
  page?: number
  pageSize?: number
  ordering?: DataSetOrder[]
  search?: string
  // Base filter (same DSL as search), applied before search. Optional; the
  // search box maps to `search`. A partition affordance is a later UI item.
  partition?: string
  showCounts?: boolean
}

export type DataSetResult<Row> = {
  data: Row[]
  count?: { inQuery: number } | null
}

// dataSet adapts a gat DataSet GraphQL node ({ data, count }) to DataSetResult —
// centralizing what every list loader repeats: null-filtering `data` (and passing
// the `count.inQuery` through — now a plain `Int`/number since the P80 scalar
// policy made counts `int32`). Pass `map` to coerce/reshape each row (Long ids →
// String, narrow enums); omit it when the GraphQL row already matches Row. So a
// loader collapses to: `dataSet(res.redline2?.v1?.fooSearch, mapRow?)`.
// No-mapper overload: the row type is inferred straight from the GraphQL node, so
// a loader that needs no reshaping collapses to `dataSet(res.redline2?.v1?.fooSearch)`
// with its row type derived (the common case now that ids are plain strings — P80b —
// and counts plain numbers — P80a, so most rows already match their domain type).
export function dataSet<TRow>(
  node: { data?: ReadonlyArray<TRow | null> | null; count?: { inQuery: number } | null } | null | undefined,
): DataSetResult<TRow>
// Mapper overload: coerce Long ids → String, narrow enums, etc.
export function dataSet<TIn, TOut = TIn>(
  node: { data?: ReadonlyArray<TIn | null> | null; count?: { inQuery: number } | null } | null | undefined,
  map: (row: TIn) => TOut,
): DataSetResult<TOut>
export function dataSet<TIn, TOut = TIn>(
  node: { data?: ReadonlyArray<TIn | null> | null; count?: { inQuery: number } | null } | null | undefined,
  map?: (row: TIn) => TOut,
): DataSetResult<TOut> {
  const rows = (node?.data ?? []).filter((r): r is TIn => r != null)
  return {
    data: map ? rows.map(map) : (rows as unknown as TOut[]),
    count: node?.count ? { inQuery: node.count.inQuery } : null,
  }
}

// DataSetRow<typeof loader> — the row type a DataSet loader yields, derived from the loader's own
// return so a domain type tracks the query + mapper instead of being hand-maintained + drifting.
export type DataSetRow<L extends (...a: never[]) => unknown> =
  Awaited<ReturnType<L>> extends DataSetResult<infer R> ? R : never
