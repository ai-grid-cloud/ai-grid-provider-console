// Package contractguard tests properties of the vendored backend contract that buf lint
// does not check.
//
// buf lint checks style, not semantics, so a `(buf.validate.field).string.pattern` that
// accepts everything passes it. One shipped in review as
// `^$|^(([0-9])+[h|m|s])|None$`: alternation binds loosest, so the middle branch has no
// trailing `$` and the last has no leading `^`, and protovalidate matches partially — which
// made "5mbogus", "garbageNone" and "5|" all valid. These tests fail on that shape.
package contractguard_test

import (
	"regexp"
	"strings"
	"testing"

	"buf.build/gen/go/bufbuild/protovalidate/protocolbuffers/go/buf/validate"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	_ "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/contract/ai_grid/v1"
)

// garbage is a string no field of this contract legitimately accepts: control characters,
// spaces and punctuation that no identifier, URI, duration or label permits.
const garbage = "\x00 !! \n ZZ~garbage~ZZ \t ;; \x00"

// stringPatterns walks every message field in the contract and returns the ones carrying a
// string pattern rule, keyed by their full name.
func stringPatterns(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	protoregistry.GlobalFiles.RangeFiles(func(fd protoreflect.FileDescriptor) bool {
		if !strings.HasPrefix(string(fd.Package()), "ai_grid.") {
			return true
		}
		var walk func(protoreflect.MessageDescriptors)
		walk = func(msgs protoreflect.MessageDescriptors) {
			for i := 0; i < msgs.Len(); i++ {
				msg := msgs.Get(i)
				fields := msg.Fields()
				for j := 0; j < fields.Len(); j++ {
					field := fields.Get(j)
					rules, ok := proto.GetExtension(field.Options(), validate.E_Field).(*validate.FieldRules)
					if !ok || rules == nil {
						continue
					}
					if s := rules.GetString_(); s != nil && s.Pattern != nil {
						out[string(field.FullName())] = s.GetPattern()
					}
				}
				walk(msg.Messages())
			}
		}
		walk(fd.Messages())
		return true
	})
	if len(out) == 0 {
		t.Fatal("no string patterns found in the contract; the walk is broken, not the contract")
	}
	return out
}

// A pattern that accepts obvious garbage is not constraining anything.
func TestPatternsRejectGarbage(t *testing.T) {
	t.Parallel()

	for field, pattern := range stringPatterns(t) {
		re, err := regexp.Compile(pattern)
		if err != nil {
			t.Errorf("%s: pattern %q does not compile: %v", field, pattern, err)
			continue
		}
		if re.MatchString(garbage) {
			t.Errorf("%s: pattern %q accepts garbage, so it constrains nothing", field, pattern)
		}
	}
}

// protovalidate matches partially, so every alternative needs its own anchors. Checking the
// whole pattern is not enough: `^a|b$` is anchored at both ends and still matches "xbx".
func TestPatternAlternativesAreAnchored(t *testing.T) {
	t.Parallel()

	for field, pattern := range stringPatterns(t) {
		for _, alt := range splitTopLevel(pattern) {
			if !strings.HasPrefix(alt, "^") || !strings.HasSuffix(alt, "$") {
				t.Errorf("%s: alternative %q in %q is unanchored, so it matches anywhere in the input; "+
					"wrap the alternation instead, as in ^(a|b)$", field, alt, pattern)
			}
		}
	}
}

// Proves the two checks above fail on the pattern that reached review, so that a guard which
// cannot fail is never mistaken for a contract that is clean.
func TestChecksCatchTheHistoricalBug(t *testing.T) {
	t.Parallel()

	const bad = `^$|^(([0-9])+[h|m|s])|None$`

	var unanchored int
	for _, alt := range splitTopLevel(bad) {
		if !strings.HasPrefix(alt, "^") || !strings.HasSuffix(alt, "$") {
			unanchored++
		}
	}
	if unanchored != 2 {
		t.Errorf("anchoring check found %d unanchored alternatives in %q, want 2 "+
			"(the middle branch has no $, the last has no ^)", unanchored, bad)
	}

	// `[h|m|s]` is a class containing a pipe, so the pattern also accepts "5|".
	re := regexp.MustCompile(bad)
	for _, junk := range []string{"5mbogus", "garbageNone", "5|"} {
		if !re.MatchString(junk) {
			t.Errorf("expected the historical pattern to wrongly accept %q; if it no longer does, "+
				"this regression test has drifted from the bug it documents", junk)
		}
	}

	// The fix it should have been.
	fixed := regexp.MustCompile(`^$|^([0-9]+[hms]|None)$`)
	for _, junk := range []string{"5mbogus", "garbageNone", "5|"} {
		if fixed.MatchString(junk) {
			t.Errorf("the corrected pattern still accepts %q", junk)
		}
	}
	for _, valid := range []string{"", "5m", "1h", "30s", "None"} {
		if !fixed.MatchString(valid) {
			t.Errorf("the corrected pattern rejects the valid value %q", valid)
		}
	}
}

// splitTopLevel splits on `|` outside groups, classes and escapes — the precedence that
// makes an unwrapped alternation leak.
func splitTopLevel(pattern string) []string {
	var parts []string
	var current strings.Builder
	depth, inClass, escaped := 0, false, false
	for _, r := range pattern {
		switch {
		case escaped:
			escaped = false
		case r == '\\':
			escaped = true
		case inClass:
			if r == ']' {
				inClass = false
			}
		case r == '[':
			inClass = true
		case r == '(':
			depth++
		case r == ')':
			depth--
		case r == '|' && depth == 0:
			parts = append(parts, current.String())
			current.Reset()
			continue
		}
		current.WriteRune(r)
	}
	return append(parts, current.String())
}
