// Package validation holds the PoC's request rules, checked against a BFF JSON
// body. The BFF and the fake backend both use it, and TestSharedValidationCases
// runs it against mock/validation/cases.json, the cases the frontend's zod
// schemas also pass, so the three can't drift.
package validation

import "encoding/json"

// Schemas maps each schema name in mock/validation/cases.json that the Go
// side checks to its rule; FrontendOnly lists the rest.
// Every rule returns field errors keyed by JSON path, the last message per
// path (as the PoC keeps them), and nil when the body is valid.
var Schemas = map[string]func(json.RawMessage) map[string]string{}

// FrontendOnly are the schemas in mock/validation/cases.json that only the
// frontend's zod rules run: organizations are validated by the backend that
// owns them (PR 12's fake), not by this package.
var FrontendOnly = []string{"organization"}
