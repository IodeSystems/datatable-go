package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSelectionNests(t *testing.T) {
	cases := []struct {
		name string
		opt  options
		want []string
	}{
		{"types", options{max: tierTypes}, []string{"types.ts"}},
		{"headless", options{max: tierHeadless}, []string{"types.ts", "useDataSet.ts"}},
		{"component", options{max: tierComponent, variant: "mui"}, []string{"types.ts", "useDataSet.ts", "DataTable.tsx"}},
		{"component-no-variant-drops-mui", options{max: tierComponent, variant: ""}, []string{"types.ts", "useDataSet.ts"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := names(selected(c.opt))
			if strings.Join(got, ",") != strings.Join(c.want, ",") {
				t.Fatalf("got %v want %v", got, c.want)
			}
		})
	}
}

func TestEmitThenCheckClean(t *testing.T) {
	dir := t.TempDir()
	sel := selected(options{max: tierComponent, variant: "mui"})
	if err := emitAll(sel, dir); err != nil {
		t.Fatal(err)
	}
	// Every emitted file must carry the body sentinel + a digest header.
	for _, r := range sel {
		raw, err := os.ReadFile(filepath.Join(dir, r.out))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), bodySentinel) {
			t.Fatalf("%s missing body sentinel", r.out)
		}
		if !strings.Contains(string(raw), "digest: sha256:") {
			t.Fatalf("%s missing digest", r.out)
		}
	}
	// A freshly emitted tree is CLEAN for every file → check passes.
	if err := checkAll(sel, dir); err != nil {
		t.Fatalf("check on pristine tree should pass, got: %v", err)
	}
}

func TestCheckDetectsEdit(t *testing.T) {
	dir := t.TempDir()
	// contract.ts is the only Generated file; editing it must fail --check.
	gen := manifest[0]
	if gen.policy != generated || gen.out != "types.ts" {
		t.Fatalf("manifest[0] assumption broke: %+v", gen)
	}
	sel := []resource{gen}
	if err := emitAll(sel, dir); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, gen.out)
	raw, _ := os.ReadFile(p)
	edited := string(raw) + "\nexport const sneaky = 1\n"
	if err := os.WriteFile(p, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := checkAll(sel, dir); err == nil {
		t.Fatal("check should fail on an edited generated file")
	}

	// classify should label it EDITED, not BEHIND (the stamp no longer matches).
	body, _ := resourceFS.ReadFile(gen.file)
	st := classify(edited, digest(string(body)))
	if st.kind != stateEdited {
		t.Fatalf("want stateEdited, got %v", st.kind)
	}
}

func TestCheckDetectsUpstreamMoved(t *testing.T) {
	dir := t.TempDir()
	gen := manifest[0]
	sel := []resource{gen}
	if err := emitAll(sel, dir); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, gen.out))
	// Simulate upstream moving: classify the on-disk (unedited) file against a
	// DIFFERENT upstream digest. Body still matches its own stamp → BEHIND.
	st := classify(string(raw), "deadbeef")
	if st.kind != stateBehind {
		t.Fatalf("want stateBehind, got %v", st.kind)
	}
}

func names(rs []resource) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.out
	}
	return out
}
