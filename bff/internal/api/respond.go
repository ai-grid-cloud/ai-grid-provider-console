package api

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// envelope wraps every successful JSON response. List endpoints that page
// add `meta`; everything else has `data` only.
type envelope struct {
	Data any       `json:"data"`
	Meta *ListMeta `json:"meta,omitempty"`
}

// ListMeta describes one page of a paged list: how many items came back,
// how many match in total, and the offset and limit that were applied.
// Limit is omitted when the caller asked for everything.
type ListMeta struct {
	Size   int  `json:"size"`
	Total  int  `json:"total"`
	Offset int  `json:"offset"`
	Limit  *int `json:"limit,omitempty"`
}

// errorBody is the JSON shape of every error response.
type errorBody struct {
	Error errorPayload `json:"error"`
}

type errorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeJSON encodes v before it commits the status, so an encoding failure
// (a value JSON cannot carry, such as a NaN) is a 500 with an error body, not
// a 200 with a truncated one.
func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		status = http.StatusInternalServerError
		body, _ = json.Marshal(errorBody{Error: errorPayload{Code: strconv.Itoa(status), Message: "internal server error"}})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
}

func writeData(w http.ResponseWriter, status int, v any) {
	writeJSON(w, status, envelope{Data: v})
}

func writeList(w http.ResponseWriter, status int, v any, meta ListMeta) {
	writeJSON(w, status, envelope{Data: v, Meta: &meta})
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, errorBody{Error: errorPayload{Code: strconv.Itoa(status), Message: message}})
}
