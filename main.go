// datatable-go emits the frontend resources for the dataset/DataTable stack
// (the TS contract types, the headless useDataSet controller, and the MUI
// DataTable component) into a consumer's source tree, with a provenance +
// update header on each file so updates and local edits can be tracked.
//
// It is a STATIC resource emitter, not a schema-driven codegen: nothing here
// reads your SQL or GraphQL. The dataset request/response contract is universal
// (it mirrors the metaquery dataset envelope), so every consumer gets the same
// files. That's why this is its own tool, not a sqlc plugin.
//
// Usage:
//
//	datatable-go resources --types               --out DIR   # contract only
//	datatable-go resources --headless            --out DIR   # + useDataSet
//	datatable-go resources --component=mui       --out DIR   # + DataTable (MUI)
//	datatable-go resources --all                 --out DIR   # everything
//	datatable-go resources --component=mui --out DIR --check  # report drift, write nothing
//
// Tiers nest: --component implies --headless implies --types.
//
// Each emitted file carries one of two header styles, by edit policy:
//   - Generated (the pure contract): "DO NOT EDIT" — overwrite on update;
//     --check exits non-zero if it was edited, is stale, or is missing.
//   - Scaffold (hook + component): "safe to edit" — you own your copy;
//     --check only REPORTS upstream/edit drift (exit 0).
//
// Drift is detected from the stamped header: `version:` vs this binary's
// Version, and `digest:` (sha256 of the file body) vs a recompute of the body
// on disk — so an edit (digest mismatch) is distinguished from upstream moving
// (version mismatch, body still pristine).
package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Version is the released resource version. Bump on any resources/* change.
const Version = "0.1.1"

//go:embed resources/types.ts resources/useDataSet.ts resources/DataTable.tsx
var resourceFS embed.FS

// bodySentinel marks the end of the generated header; everything after the line
// (and its trailing newline) is the verbatim resource body used for digesting.
const bodySentinel = "// @datatable-go:body — body below is verbatim; the header above is generated"

type tier int

const (
	tierTypes     tier = iota // pure contract types (zero deps)
	tierHeadless              // + useDataSet controller (react, react-query)
	tierComponent            // + DataTable component (+ mui, react-virtual)
)

type policy int

const (
	generated policy = iota // DO NOT EDIT — regenerate on update
	scaffold                // yours to edit — track drift, don't clobber
)

type resource struct {
	out     string // emitted filename
	file    string // path within the embed FS
	tier    tier   // lowest tier that includes this file
	policy  policy
	variant string // "" = always; else only for that --component variant
}

var manifest = []resource{
	{out: "types.ts", file: "resources/types.ts", tier: tierTypes, policy: generated},
	{out: "useDataSet.ts", file: "resources/useDataSet.ts", tier: tierHeadless, policy: scaffold},
	{out: "DataTable.tsx", file: "resources/DataTable.tsx", tier: tierComponent, policy: scaffold, variant: "mui"},
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "datatable-go: "+err.Error())
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 || args[0] != "resources" {
		usage()
		return fmt.Errorf("expected subcommand %q", "resources")
	}
	opt, err := parseFlags(args[1:])
	if err != nil {
		return err
	}
	sel := selected(opt)
	if len(sel) == 0 {
		return fmt.Errorf("nothing selected — pass --types, --headless, --component=<v>, or --all")
	}
	if opt.check {
		return checkAll(sel, opt.out)
	}
	return emitAll(sel, opt.out)
}

type options struct {
	max     tier
	variant string // chosen component variant ("" until --component/--all)
	out     string
	check   bool
}

func parseFlags(args []string) (options, error) {
	o := options{max: -1}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--types":
			o.max = maxTier(o.max, tierTypes)
		case a == "--headless":
			o.max = maxTier(o.max, tierHeadless)
		case a == "--all":
			o.max = maxTier(o.max, tierComponent)
			o.variant = "mui" // today the only variant
		case strings.HasPrefix(a, "--component="):
			v := strings.TrimPrefix(a, "--component=")
			if !knownVariant(v) {
				return o, fmt.Errorf("unknown component variant %q (have: mui)", v)
			}
			o.max = maxTier(o.max, tierComponent)
			o.variant = v
		case strings.HasPrefix(a, "--out="):
			o.out = strings.TrimPrefix(a, "--out=")
		case a == "--out":
			if i+1 >= len(args) {
				return o, fmt.Errorf("--out needs a value: --out DIR or --out=DIR")
			}
			i++
			o.out = args[i]
		case a == "--check":
			o.check = true
		default:
			return o, fmt.Errorf("unknown flag %q", a)
		}
	}
	if o.max < 0 {
		return o, fmt.Errorf("no tier selected")
	}
	if o.out == "" {
		return o, fmt.Errorf("--out DIR is required")
	}
	return o, nil
}

func selected(o options) []resource {
	var out []resource
	for _, r := range manifest {
		if r.tier > o.max {
			continue
		}
		if r.variant != "" && r.variant != o.variant {
			continue
		}
		out = append(out, r)
	}
	return out
}

func emitAll(sel []resource, outDir string) error {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	for _, r := range sel {
		body, err := resourceFS.ReadFile(r.file)
		if err != nil {
			return err
		}
		content := stamp(r, string(body))
		dst := filepath.Join(outDir, r.out)
		if err := os.WriteFile(dst, []byte(content), 0o644); err != nil {
			return err
		}
		fmt.Printf("wrote %s  (%s, %s)\n", dst, tierFlag(r.tier), policyName(r.policy))
	}
	return nil
}

func checkAll(sel []resource, outDir string) error {
	failed := false
	for _, r := range sel {
		body, err := resourceFS.ReadFile(r.file)
		if err != nil {
			return err
		}
		upstream := digest(string(body))
		dst := filepath.Join(outDir, r.out)
		raw, err := os.ReadFile(dst)
		if err != nil {
			fmt.Printf("%-14s MISSING\n", r.out)
			failed = true
			continue
		}
		st := classify(string(raw), upstream)
		fmt.Printf("%-14s %s\n", r.out, st.describe(r.policy))
		if r.policy == generated && st.kind != stateClean {
			failed = true
		}
	}
	if failed {
		return fmt.Errorf("drift detected in a generated resource — run the matching emit to update")
	}
	return nil
}

type stateKind int

const (
	stateClean   stateKind = iota // body == upstream && header version == Version
	stateStale                    // body == upstream but header version != Version
	stateBehind                   // body == its own stamp, but upstream moved (unedited, out of date)
	stateEdited                   // body != its own stamp (locally edited)
	stateNoStamp                  // no datatable-go header found
)

type state struct {
	kind          stateKind
	headerVersion string
}

var (
	reVersion = regexp.MustCompile(`(?m)^// version: (\S+)`)
	reDigest  = regexp.MustCompile(`(?m)^//\s+.*digest: sha256:([0-9a-f]+)`)
)

func classify(onDisk, upstreamDigest string) state {
	idx := strings.Index(onDisk, "\n"+bodySentinel+"\n")
	if idx < 0 {
		return state{kind: stateNoStamp}
	}
	header := onDisk[:idx]
	body := onDisk[idx+len("\n"+bodySentinel+"\n"):]
	bodyDigest := digest(body)

	ver := ""
	if m := reVersion.FindStringSubmatch(header); m != nil {
		ver = m[1]
	}
	stamped := ""
	if m := reDigest.FindStringSubmatch(header); m != nil {
		stamped = m[1]
	}

	switch {
	case bodyDigest == upstreamDigest && ver == Version:
		return state{stateClean, ver}
	case bodyDigest == upstreamDigest:
		return state{stateStale, ver}
	case stamped == bodyDigest:
		// body is exactly what was stamped (unedited) but differs from upstream
		return state{stateBehind, ver}
	default:
		return state{stateEdited, ver}
	}
}

func (s state) describe(p policy) string {
	switch s.kind {
	case stateClean:
		return "OK (matches v" + Version + ")"
	case stateStale:
		return "OK — content matches, header version " + s.headerVersion + " (re-emit to refresh stamp)"
	case stateBehind:
		if p == generated {
			return "BEHIND — upstream moved to v" + Version + " (regenerate)"
		}
		return "BEHIND — upstream moved to v" + Version + " (unedited; pull or merge when ready)"
	case stateEdited:
		if p == generated {
			return "EDITED — generated file changed locally (revert or upstream the change)"
		}
		return "EDITED — local changes vs v" + s.headerVersion + " (yours; you own this copy)"
	default:
		return "NO STAMP — not emitted by datatable-go (won't track)"
	}
}

// stamp prepends the provenance/update header to a resource body.
func stamp(r resource, body string) string {
	var lead, edit string
	if r.policy == generated {
		lead = "Code generated by datatable-go v" + Version + " — DO NOT EDIT."
		edit = "regenerate: datatable-go resources " + tierFlag(r.tier) + " --out <dir>"
	} else {
		lead = "Scaffolded from datatable-go v" + Version + " — safe to edit (you own this copy)."
		edit = "check drift: datatable-go resources " + tierFlag(r.tier) + " --out <dir> --check"
	}
	h := []string{
		"// " + lead,
		"// source: github.com/iodesystems/datatable-go",
		"// " + edit,
		"// version: " + Version + "   digest: sha256:" + digest(body),
		bodySentinel,
	}
	return strings.Join(h, "\n") + "\n" + body
}

func digest(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func tierFlag(t tier) string {
	switch t {
	case tierTypes:
		return "--types"
	case tierHeadless:
		return "--headless"
	default:
		return "--component=mui"
	}
}

func policyName(p policy) string {
	if p == generated {
		return "generated"
	}
	return "scaffold"
}

func maxTier(a, b tier) tier {
	if a > b {
		return a
	}
	return b
}

func knownVariant(v string) bool { return v == "mui" }

func usage() {
	fmt.Fprint(os.Stderr, `datatable-go — emit the dataset/DataTable frontend resources

  datatable-go resources --types            --out DIR
  datatable-go resources --headless         --out DIR
  datatable-go resources --component=mui    --out DIR
  datatable-go resources --all              --out DIR
  datatable-go resources --component=mui --out DIR --check

Tiers nest: --component implies --headless implies --types.
--check writes nothing; it reports drift and exits non-zero on a changed
generated file (scaffold drift is reported but exits 0).
`)
}
