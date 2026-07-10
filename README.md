# datatable-go

Emits the frontend resources for the **dataset / DataTable** stack into a
consumer's source tree, each file stamped with a provenance + update header so
updates and local edits are trackable.

It is a **static resource emitter, not a schema-driven codegen** — nothing here
reads your SQL or GraphQL. The dataset request/response contract is universal
(it mirrors the metaquery dataset envelope), so every consumer gets the same
files. That's why this is its own tool, not a sqlc plugin.

## Resources & tiers

Tiers **nest**: `--component` ⊇ `--headless` ⊇ `--types`.

| Flag | Adds | Deps | Edit policy |
|------|------|------|-------------|
| `--types` | `types.ts` — the wire contract (`DataSetRequest/Result/Order`, `dataSet()`, `DataSetRow`) | none | **generated** — DO NOT EDIT |
| `--headless` | `useDataSet.ts` — the list controller (page/search/sort + debounce) | react, react-query | **scaffold** — yours to edit |
| `--component=mui` | `DataTable.tsx` — the MUI table (toolbar, column gear, sort, pagination, virtualization) | + @mui/material, @tanstack/react-virtual | **scaffold** — yours to edit |
| `--all` | every component variant (today: mui) | — | — |

The component imports nothing app-specific. App behaviors (e.g. promote the
toolbar into the app bar on scroll) are injected via `DataTableConfigContext`
(default = passthrough) — never imported.

## Usage

```
datatable-go resources --types            --out ui/src/datatable
datatable-go resources --headless         --out ui/src/datatable
datatable-go resources --component=mui    --out ui/src/datatable
datatable-go resources --all              --out ui/src/datatable
datatable-go resources --all --out ui/src/datatable --check   # report drift, write nothing
```

## Update model

Each emitted file carries a header with `version:` and `digest: sha256:<body>`.
`--check` compares the on-disk file to this binary's embedded resources:

- **generated** files (`types.ts`): any drift — edited, behind, or missing —
  fails `--check` (non-zero exit). Regenerate to fix; never hand-edit.
- **scaffold** files (`useDataSet.ts`, `DataTable.tsx`): you own your copy.
  `--check` *reports* `EDITED` (your local changes) vs `BEHIND` (upstream
  moved, your copy still pristine) but exits 0. The stamped digest is the merge
  base when you pull a new upstream into an edited copy.

State is inferred from the header, not a lockfile: `version` mismatch ⇒ upstream
moved; `digest` ≠ recompute of the body on disk ⇒ locally edited.

## Developing

`resources/` holds the canonical bodies (header-free). Edit there, bump
`Version` in `main.go`, then:

```
go test ./...
go build -o datatable-go .
```

Consumers re-run `datatable-go resources … --out …` to pull the new version;
`--check` in their CI flags when they're behind.
