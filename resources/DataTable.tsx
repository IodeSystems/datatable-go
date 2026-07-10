import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import {
  Box,
  Checkbox,
  CircularProgress,
  Fab,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Zoom,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import { KeyboardArrowUp, ViewColumn } from '@mui/icons-material'
import type { DataSetController } from './useDataSet'

// toolbarWrapper seam — how the search/column toolbar is wrapped. Lets a host app
// inject behavior (e.g. promote-into-app-bar on scroll) WITHOUT this component
// importing anything app-specific. `render(promoted)` returns the toolbar content;
// the wrapper decides whether/how it's "promoted" (default: never → plain toolbar).
export type ToolbarWrapper = (render: (promoted: boolean) => ReactNode) => ReactNode
const passthroughWrapper: ToolbarWrapper = (render) => render(false)

// App-wide default for toolbarWrapper, so a host app sets the behavior once instead
// of threading it through every <DataTable>. Empty default = pure passthrough, which
// is the correct standalone behavior. redline binds promote-on-scroll here (see
// appBarPromote.tsx / AppShell).
export const DataTableConfigContext = createContext<{ toolbarWrapper?: ToolbarWrapper }>({})

export type Column<Row> = {
  field: string // row property key (camelCase)
  header: string
  sortable?: boolean
  // Server column name to sort by (snake_case), if different from `field`.
  // Must be in the handler's orderable set. Defaults to `field`.
  sortField?: string
  align?: 'left' | 'right'
  render?: (row: Row) => ReactNode
}

const storageKey = (tableId: string) => `dt-cols:${tableId}`

// The server sorts by snake_case column names; column `field`s are camelCase JSON keys.
// Default the sort field to the snake_case of `field` (a column may still override with an
// explicit `sortField` when the column alias differs).
const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())

const loadHidden = (tableId?: string): Set<string> => {
  if (!tableId) return new Set()
  try {
    const raw = localStorage.getItem(storageKey(tableId))
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

// Lean, reusable list table: search box + column-config gear + sortable headers +
// server pagination, driven entirely by a useDataSet controller. Pass `tableId` to
// persist the hidden-column set across reloads (localStorage). Selection / partition
// search from redline's DataTable are deferred.
export function DataTable<Row>({
  columns,
  ds,
  rowKey,
  searchPlaceholder = 'Search…',
  tableId,
  hideHeader = false,
  hideColumnConfig = false,
  header,
  contentIfEmpty,
  cardRender,
  virtualize = false,
  toolbarWrapper,
}: {
  columns: Column<Row>[]
  ds: DataSetController<Row>
  rowKey: (row: Row) => string
  searchPlaceholder?: string
  // Stable id for persisting column visibility. Omit for in-memory only.
  tableId?: string
  // Hide the column-header row (for a single rich/stacked column, e.g. the coach roster).
  hideHeader?: boolean
  // Hide the column-config gear (pointless with one column).
  hideColumnConfig?: boolean
  // Optional content rendered inside the card, above the search toolbar — e.g. a title,
  // chips, summary stats — so they live within the dataset card instead of floating above it.
  header?: ReactNode
  // When the dataset is empty (no rows, not loading, no error), render this centered in
  // place of the table/toolbar/pagination — a plain-language "why it's empty / when to
  // expect values" message instead of a bare empty grid. Omit for the default "No results."
  contentIfEmpty?: ReactNode
  // Mobile card escape hatch: on the narrow (below-sm) breakpoint, render each row as a
  // single full-width cell of your own markup instead of the default per-column
  // "Label   value" stack. The row is still a real table row (desktop stays the columnar
  // grid unchanged) — this only swaps what a row LOOKS like once the columns can't fit a
  // phone. Lets a caller design a compact card (title + a few key figures) rather than
  // dumping every column as a line. Ignored when `virtualize` is on.
  cardRender?: (row: Row) => ReactNode
  // Virtualize the row region (TanStack Virtual) — render only visible rows. Intended for
  // a single rich/stacked column (e.g. the coach roster, hideHeader) where a full page can
  // be hundreds of rows; column alignment isn't relied on. Default false.
  virtualize?: boolean
  // Wraps the search/column toolbar. Overrides the app-wide DataTableConfigContext
  // default; omit both for a plain (non-promoting) toolbar. See ToolbarWrapper.
  toolbarWrapper?: ToolbarWrapper
}) {
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden(tableId))
  const [menuEl, setMenuEl] = useState<null | HTMLElement>(null)
  // Prop > app-wide context default > passthrough. Keeps the component dependency-free.
  const cfg = useContext(DataTableConfigContext)
  const wrapToolbar = toolbarWrapper ?? cfg.toolbarWrapper ?? passthroughWrapper

  // Keep the search box value local so typing stays snappy and doesn't churn the
  // dataset (which would refetch + re-render the whole table on every keystroke).
  // Debounce pushing it to the dataset: the query — and thus the table body — only
  // re-renders once typing pauses.
  const [searchInput, setSearchInput] = useState(ds.search)
  // Pull EXTERNAL ds.search changes (e.g. a row clicking ds.setSearch to filter to a
  // value) into the input. Without this, the debounce below treats the stale (empty)
  // input as the source of truth and clobbers the external search back ~300ms later —
  // "click a donor → filters → flashes back to wide open" (cr #116). appliedSearch
  // tracks values WE pushed, so a self-push is ignored (never overwrites a keystroke).
  const appliedSearch = useRef(ds.search)
  useEffect(() => {
    if (ds.search !== appliedSearch.current) {
      appliedSearch.current = ds.search
      setSearchInput(ds.search)
    }
  }, [ds.search])
  useEffect(() => {
    if (searchInput === ds.search) return
    const t = setTimeout(() => {
      appliedSearch.current = searchInput
      ds.setSearch(searchInput)
    }, 300)
    return () => clearTimeout(t)
  }, [searchInput, ds])

  const toggle = (field: string) => {
    const next = new Set(hidden)
    if (next.has(field)) {
      next.delete(field)
    } else {
      if (columns.length - next.size <= 1) return // keep at least one column visible
      next.add(field)
    }
    setHidden(next)
    if (tableId) {
      try {
        localStorage.setItem(storageKey(tableId), JSON.stringify([...next]))
      } catch {
        /* storage unavailable — fall back to in-memory */
      }
    }
  }

  // Memoize so the reference is stable across re-renders that don't touch columns
  // (e.g. the debounced-fetch spinner), keeping the memoized body below from
  // re-rendering. `columns` is stable while typing (parent doesn't re-render).
  const visible = useMemo(() => columns.filter((c) => !hidden.has(c.field)), [columns, hidden])

  // Below sm, if the caller supplied a cardRender, each row collapses to a single
  // full-width custom card instead of the per-column stack. Matches the same 599.95px
  // breakpoint the mobile stacked-card CSS uses (theme sm). Not used in the virtualized path.
  const theme = useTheme()
  const compactCard = useMediaQuery(theme.breakpoints.down('sm')) && !!cardRender

  // Memoize the rows: returning the same element reference lets React skip
  // reconciling the table body when the render was triggered by something other
  // than the results (search-box keystrokes, the fetch spinner). Recomputes only
  // when the data/columns actually change.
  const body = useMemo(
    () => (
      <TableBody>
        {ds.error && (
          <TableRow>
            <TableCell colSpan={visible.length} data-label="" sx={{ color: 'error.main' }}>
              {ds.error.message}
            </TableCell>
          </TableRow>
        )}
        {!ds.error && ds.rows.length === 0 && !ds.isLoading && (
          <TableRow>
            <TableCell colSpan={visible.length} data-label="" sx={{ color: 'text.secondary' }}>
              No results.
            </TableCell>
          </TableRow>
        )}
        {ds.rows.map((row) => (
          <TableRow key={rowKey(row)} data-testid={`row-${rowKey(row)}`} hover>
            {compactCard ? (
              // One full-width cell carrying the caller's custom card. data-label="" reuses
              // the mobile "unlabeled cell" rule (full width, no ::before label). colSpan is
              // cosmetic here (tbody is display:block below sm) but keeps the row valid.
              <TableCell colSpan={visible.length} data-label="">
                {cardRender!(row)}
              </TableCell>
            ) : (
              visible.map((c) => (
                // data-label feeds the mobile stacked-card layout: below sm the header row
                // is hidden and each cell shows its column header inline (via CSS ::before).
                <TableCell key={c.field} align={c.align} data-label={c.header} sx={{ whiteSpace: 'nowrap' }}>
                  {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.field] ?? '')}
                </TableCell>
              ))
            )}
          </TableRow>
        ))}
      </TableBody>
    ),
    [ds.rows, ds.error, ds.isLoading, visible, rowKey, compactCard, cardRender],
  )

  // Empty-state override: when there are no rows (and we're not loading/erroring) and the
  // caller supplied contentIfEmpty, replace the whole table chrome with a centered message
  // (cr #66) — clearer than a bare grid with one "No results." row.
  if (contentIfEmpty && !ds.error && !ds.isLoading && ds.rows.length === 0) {
    return (
      <Paper data-testid={tableId} sx={{ borderRadius: { xs: 0, md: 1 } }}>
        {header && <Box sx={{ px: 2, pt: 2, pb: 1 }}>{header}</Box>}
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            gap: 1,
            px: 3,
            py: 6,
            color: 'text.secondary',
          }}
        >
          {contentIfEmpty}
        </Box>
      </Paper>
    )
  }

  return (
    // Square corners while the screen wrapper drops its side padding (< md), so the
    // table reads edge-to-edge on mobile/narrow; rounded again on wide screens.
    <Paper data-testid={tableId} sx={{ borderRadius: { xs: 0, md: 1 } }}>
      {header && <Box sx={{ px: 2, pt: 2, pb: 1 }}>{header}</Box>}
      {wrapToolbar((promoted) => (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              width: '100%',
              px: promoted ? 0 : 2,
              py: promoted ? 0 : 1,
              ...(promoted ? {} : { borderBottom: 1, borderColor: 'divider' }),
            }}
          >
            <TextField
              size="small"
              placeholder={searchPlaceholder}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              inputProps={{ 'data-testid': 'datatable-search' }}
              sx={{
                // Fixed 320 on desktop; on mobile grow to fill the row and allow
                // shrinking (minWidth:0) so it doesn't overflow / split the toolbar
                // line on narrow screens.
                width: { xs: 'auto', sm: 320 },
                flexGrow: { xs: 1, sm: 0 },
                minWidth: 0,
                // On the app bar (dark/primary) the field needs light-on-dark styling.
                ...(promoted && {
                  '& .MuiOutlinedInput-root': { color: 'inherit', backgroundColor: 'rgba(255,255,255,0.12)' },
                  '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.4)' },
                  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.7)' },
                  '& .MuiInputBase-input::placeholder': { color: 'rgba(255,255,255,0.7)', opacity: 1 },
                }),
              }}
            />
            {ds.isFetching && <CircularProgress size={18} color={promoted ? 'inherit' : 'primary'} />}
            {/* Spacer pushes the column gear to the right on desktop. On mobile the
                search field grows instead, so hide the spacer to keep the gear inline. */}
            <Box sx={{ flexGrow: 1, display: { xs: 'none', sm: 'block' } }} />
            {!hideColumnConfig && (
              <Tooltip title="Columns">
                <IconButton
                  size="small"
                  color="inherit"
                  aria-label="configure columns"
                  onClick={(e) => setMenuEl(e.currentTarget)}
                >
                  <ViewColumn />
                </IconButton>
              </Tooltip>
            )}
            <Menu anchorEl={menuEl} open={!!menuEl} onClose={() => setMenuEl(null)}>
              {columns
                .filter((c) => c.header) // unlabeled columns (e.g. row actions) aren't toggleable
                .map((c) => (
                  <MenuItem key={c.field} dense onClick={() => toggle(c.field)}>
                    <ListItemIcon sx={{ minWidth: 0, mr: 1 }}>
                      <Checkbox
                        edge="start"
                        size="small"
                        checked={!hidden.has(c.field)}
                        tabIndex={-1}
                        disableRipple
                        sx={{ p: 0 }}
                      />
                    </ListItemIcon>
                    <ListItemText primary={c.header || c.field} />
                  </MenuItem>
                ))}
            </Menu>
          </Box>
      ))}
      {virtualize && !ds.error && ds.rows.length > 0 ? (
        <VirtualRows rows={ds.rows} columns={visible} rowKey={rowKey} />
      ) : (
      <TableContainer>
        <Table
          size="small"
          sx={{
            // Mobile stacked-card layout (cr #140): a 5–6 column grid can't fit a phone,
            // so cells wrap into an unreadable mess. Below sm, drop the grid — hide the
            // header row and render each row as a card of "Label   value" lines (the label
            // comes from each cell's data-label via ::before). Desktop keeps the grid.
            '@media (max-width:599.95px)': {
              '& thead': { display: 'none' },
              '& tbody': { display: 'block' },
              '& tbody tr': {
                display: 'block',
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                mb: 1.5,
                p: 1,
              },
              '& tbody td': {
                display: 'flex',
                // MUI's alignRight cell sets flex-direction:row-reverse; force row so
                // the ::before label stays left and the value right for every cell.
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 2,
                border: 0,
                px: 1,
                py: 0.5,
                whiteSpace: 'normal',
                textAlign: 'right',
              },
              // The column header, shown as the left-hand label of each card line.
              '& tbody td::before': {
                content: 'attr(data-label)',
                fontWeight: 600,
                color: 'text.secondary',
                textAlign: 'left',
                flexShrink: 0,
                marginRight: 2,
              },
              // Unlabeled cells (an icon-only actions column, or the colSpan
              // error/"No results." row) — no label, let the content use the full width.
              '& tbody td[data-label=""]': { justifyContent: 'flex-start', textAlign: 'left' },
              '& tbody td[data-label=""]::before': { content: '""', margin: 0 },
            },
          }}
        >
          {!hideHeader && (
            <TableHead>
              <TableRow>
                {visible.map((c) => (
                  <TableCell key={c.field} align={c.align} sx={{ whiteSpace: 'nowrap' }}>
                    {c.sortable ? (
                      (() => {
                        const sf = c.sortField ?? toSnake(c.field)
                        const active = ds.sort?.field === sf
                        return (
                          <TableSortLabel
                            active={active}
                            direction={active ? (ds.sort!.order === 'ASC' ? 'asc' : 'desc') : 'asc'}
                            onClick={() => ds.toggleSort(sf)}
                          >
                            {c.header}
                          </TableSortLabel>
                        )
                      })()
                    ) : (
                      c.header
                    )}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
          )}
          {body}
        </Table>
      </TableContainer>
      )}
      <TablePagination
        component="div"
        count={ds.total}
        page={ds.page}
        rowsPerPage={ds.pageSize}
        onPageChange={(_, p) => ds.setPage(p)}
        onRowsPerPageChange={(e) => ds.setPageSize(parseInt(e.target.value, 10))}
        rowsPerPageOptions={[25, 50, 100, 200, 500]}
      />
    </Paper>
  )
}

// VirtualRows renders only the visible rows (TanStack Virtual) for a tall single-column
// list — the coach roster can be ~500 rich member cards; rendering them all janks scroll.
// Heights are measured (cards vary), so no fixed row height is assumed.
//
// It virtualizes against the WINDOW (not an inner scroll container) so the list is part
// of the page's single scroll: the program switcher / tabs / stats band / search above it
// scroll away normally, then the roster keeps scrolling in the same gesture (cr #113 — the
// old nested inner-scroll pane felt clunky on mobile). scrollMargin = the list's offset
// down the document; it's stable while scrolling because the search bar leaves a
// same-height placeholder when it promotes into the app bar (via the injected toolbarWrapper).
function VirtualRows<Row>({
  rows,
  columns,
  rowKey,
}: {
  rows: Row[]
  columns: Column<Row>[]
  rowKey: (row: Row) => string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  // The list's distance from the top of the document. Re-measured on mount, resize, and
  // when the row count changes (data settling shifts the content above it).
  useLayoutEffect(() => {
    const measure = () => {
      const el = listRef.current
      if (!el) return
      setScrollMargin(el.getBoundingClientRect().top + window.scrollY)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [rows.length])

  const v = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 96,
    overscan: 8,
    scrollMargin,
  })

  // Floating "back to top": once the window has scrolled a screenful past the list's top,
  // surface a button that jumps back to the top of the page.
  const [showTop, setShowTop] = useState(false)
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > scrollMargin + window.innerHeight)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [scrollMargin])
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' })

  return (
    <>
      <Box ref={listRef} sx={{ position: 'relative', height: v.getTotalSize() }}>
        {v.getVirtualItems().map((vi) => {
          const row = rows[vi.index]
          return (
            <Box
              key={rowKey(row)}
              data-testid={`row-${rowKey(row)}`}
              data-index={vi.index}
              ref={v.measureElement}
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start - scrollMargin}px)`,
                px: 2,
                py: 0.5,
                borderBottom: 1,
                borderColor: 'divider',
              }}
            >
              {columns.map((c) => (
                <Box key={c.field}>
                  {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.field] ?? '')}
                </Box>
              ))}
            </Box>
          )
        })}
      </Box>
      <Zoom in={showTop}>
        <Fab
          color="primary"
          size="medium"
          aria-label="Back to top"
          onClick={scrollToTop}
          sx={{ position: 'fixed', bottom: 24, right: 24, zIndex: (t) => t.zIndex.fab }}
        >
          <KeyboardArrowUp />
        </Fab>
      </Zoom>
    </>
  )
}
