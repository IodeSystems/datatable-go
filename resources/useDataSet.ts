import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { DataSetOrder, DataSetRequest, DataSetResult, SortDir } from './types'

// useDataSet owns the list UI state (page / pageSize / search / single-column
// sort) and drives a TanStack Query off a fetcher that speaks the
// DataSetRequest/Result contract. The fetcher is usually a typed GraphQL
// mutation call (gat maps POST search → mutation).
export function useDataSet<Row>(opts: {
  key: readonly unknown[]
  load: (req: DataSetRequest) => Promise<DataSetResult<Row>>
  pageSize?: number
  // Initial sort, e.g. a list that should open most-recent-first. Empty = the server's
  // own default ordering. The user can still re-sort via the column headers.
  initialOrdering?: DataSetOrder[]
}) {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(opts.pageSize ?? 100)
  const [search, setSearchRaw] = useState('')
  const [ordering, setOrdering] = useState<DataSetOrder[]>(opts.initialOrdering ?? [])

  const req: DataSetRequest = useMemo(
    () => ({ page, pageSize, ordering, search: search || undefined, showCounts: true }),
    [page, pageSize, ordering, search],
  )

  const query = useQuery({
    queryKey: [...opts.key, req],
    queryFn: () => opts.load(req),
    placeholderData: keepPreviousData,
  })

  const sort = ordering[0]

  return {
    rows: query.data?.data ?? [],
    total: query.data?.count?.inQuery ?? 0,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error as Error | null,
    page,
    pageSize,
    search,
    sort,
    setPage,
    setPageSize: (n: number) => {
      setPageSize(n)
      setPage(0)
    },
    setSearch: (s: string) => {
      setSearchRaw(s)
      setPage(0)
    },
    // Single-column toggle: none → ASC → DESC → none.
    toggleSort: (field: string) => {
      setOrdering((prev) => {
        const cur = prev[0]
        let next: SortDir | null
        if (!cur || cur.field !== field) next = 'ASC'
        else if (cur.order === 'ASC') next = 'DESC'
        else next = null
        return next ? [{ field, order: next }] : []
      })
      setPage(0)
    },
  }
}

export type DataSetController<Row> = ReturnType<typeof useDataSet<Row>>
