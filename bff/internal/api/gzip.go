package api

import (
	"compress/gzip"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// gzipMinSize is the smallest body worth compressing: below it, gzip's header
// and the CPU cost more than the bytes saved.
const gzipMinSize = 1024

// gzipTypes are the media types the console sends that compress well: the
// SPA's HTML, CSS, JavaScript and SVG, and the JSON API. Fonts, images and
// anything else are sent as they are.
var gzipTypes = map[string]bool{
	"text/html":              true,
	"text/css":               true,
	"application/javascript": true,
	"text/javascript":        true,
	"application/json":       true,
	"image/svg+xml":          true,
}

var gzipWriters = sync.Pool{New: func() any { return gzip.NewWriter(io.Discard) }}

// compress gzips the answers that are worth it (gzipWriter) for a client that
// accepts gzip. It wraps every handler: the JSON API, the SPA and the Perses
// relay, whose answers keep the Content-Encoding Perses gave them.
func compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gw := &gzipWriter{rw: w, accepts: acceptsGzip(r)}
		defer func() {
			// Re-panicked from here, the panic keeps the stack of the handler
			// that panicked for recoverPanic's log line.
			if rec := recover(); rec != nil {
				panic(gw.abandon(rec))
			}
		}()
		next.ServeHTTP(gw, r)
		gw.finish()
	})
}

// acceptsGzip reports whether the answer to r may be gzipped: the request is
// not a HEAD (whose headers must match an uncompressed GET's), it asks for no
// byte range (the ranges are of the uncompressed file), and its
// Accept-Encoding lines accept gzip (RFC 9110, section 12.5.3): an entry
// naming gzip decides with its q, and only without one does `*` stand for
// it. A q of 0, or one that does not parse, makes its entry a refusal; a
// coding listed twice counts with its lowest q, the safe reading.
func acceptsGzip(r *http.Request) bool {
	if r.Method == http.MethodHead || r.Header.Get("Range") != "" {
		return false
	}
	gzipQ, anyQ := -1.0, -1.0 // -1: not listed
	for _, value := range r.Header.Values("Accept-Encoding") {
		for part := range strings.SplitSeq(value, ",") {
			coding, params, _ := strings.Cut(part, ";")
			switch strings.ToLower(strings.TrimSpace(coding)) {
			case "gzip":
				gzipQ = lowestQ(gzipQ, qValue(params))
			case "*":
				anyQ = lowestQ(anyQ, qValue(params))
			}
		}
	}
	if gzipQ >= 0 {
		return gzipQ > 0
	}
	return anyQ > 0
}

func lowestQ(seen, q float64) float64 {
	if seen < 0 {
		return q
	}
	return min(seen, q)
}

// qValue is the weight in an Accept-Encoding entry's parameters: 1 without a
// q, 0 for one that is not a qvalue (RFC 9110, section 12.4.2: 0 to 1, digits
// and a point only, so no "1e0" or "NaN").
func qValue(params string) float64 {
	for param := range strings.SplitSeq(params, ";") {
		name, value, ok := strings.Cut(param, "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(name), "q") {
			continue
		}
		value = strings.TrimSpace(value)
		if value == "" || strings.Trim(value, "0123456789.") != "" {
			return 0
		}
		q, err := strconv.ParseFloat(value, 64)
		if err != nil || q > 1 {
			return 0
		}
		return q
	}
	return 1
}

// gzipWriter decides when the handler commits the status whether the answer
// is compressed. It is sent as it is when the client doesn't accept gzip, the
// status has no body (1xx, 204, 304), the handler already set a
// Content-Encoding or a Content-Range, the type is not in gzipTypes, or the
// Content-Length is under gzipMinSize. Otherwise the body is held until it
// reaches gzipMinSize (then compressed; a shorter body is sent as it is) or
// the handler flushes, which starts the compressed stream at once so a
// streaming answer still arrives part by part.
type gzipWriter struct {
	rw      http.ResponseWriter
	accepts bool
	status  int  // the status the handler wrote; 0 until then
	held    bool // a compressible answer whose size is not known yet
	buf     []byte
	gz      *gzip.Writer // non-nil once compressing
}

func (g *gzipWriter) Header() http.Header { return g.rw.Header() }

// Unwrap lets http.ResponseController reach the connection's writer.
func (g *gzipWriter) Unwrap() http.ResponseWriter { return g.rw }

func (g *gzipWriter) WriteHeader(code int) {
	if g.status != 0 {
		return // a second WriteHeader is ignored, as net/http does
	}
	if code < 200 {
		g.rw.WriteHeader(code) // informational: the real status follows
		return
	}
	g.status = code
	h := g.rw.Header()
	mediaType, _, _ := mime.ParseMediaType(h.Get("Content-Type"))
	compressible := gzipTypes[mediaType] && code != http.StatusNoContent && code != http.StatusNotModified &&
		h.Get("Content-Encoding") == "" && h.Get("Content-Range") == ""
	if compressible {
		addVary(h, "Accept-Encoding")
	}
	if !compressible || !g.accepts {
		g.rw.WriteHeader(code)
		return
	}
	if n, err := strconv.ParseInt(h.Get("Content-Length"), 10, 64); err == nil {
		if n < gzipMinSize {
			g.rw.WriteHeader(code)
			return
		}
		g.startGzip()
		return
	}
	g.held = true
}

func (g *gzipWriter) Write(p []byte) (int, error) {
	if g.status == 0 {
		g.WriteHeader(http.StatusOK)
	}
	switch {
	case g.gz != nil:
		return g.gz.Write(p)
	case g.held:
		g.buf = append(g.buf, p...)
		if len(g.buf) >= gzipMinSize {
			g.startGzip()
			if err := g.writeHeld(); err != nil {
				return 0, err
			}
		}
		return len(p), nil
	}
	return g.rw.Write(p)
}

// Flush sends what the handler wrote so far, compressed when the answer is,
// then flushes the connection, so a streaming answer (the relay's) is not held.
func (g *gzipWriter) Flush() {
	if g.status == 0 {
		g.WriteHeader(http.StatusOK)
	}
	if g.held && g.gz == nil {
		g.startGzip()
		_ = g.writeHeld()
	}
	if g.gz != nil {
		_ = g.gz.Flush()
	}
	_ = http.NewResponseController(g.rw).Flush()
}

// startGzip commits the status with Content-Encoding: gzip. The length of the
// compressed body isn't known, and byte ranges would be of the uncompressed
// one, so neither is announced.
func (g *gzipWriter) startGzip() {
	h := g.rw.Header()
	h.Set("Content-Encoding", "gzip")
	h.Del("Content-Length")
	h.Del("Accept-Ranges")
	g.rw.WriteHeader(g.status)
	g.gz = gzipWriters.Get().(*gzip.Writer)
	g.gz.Reset(g.rw)
}

func (g *gzipWriter) writeHeld() error {
	buf := g.buf
	g.buf, g.held = nil, false
	_, err := g.gz.Write(buf)
	return err
}

// finish ends the answer once the handler returns: a held body that stayed
// under gzipMinSize goes out as it is, a compressed one gets its gzip trailer.
func (g *gzipWriter) finish() {
	switch {
	case g.gz != nil:
		_ = g.gz.Close()
		g.gz.Reset(io.Discard)
		gzipWriters.Put(g.gz)
		g.gz = nil
	case g.held:
		g.held = false
		g.rw.WriteHeader(g.status)
		_, _ = g.rw.Write(g.buf)
		g.buf = nil
	}
}

// abandon drops the answer of a handler that panicked with rec, and returns
// the panic to pass on to recoverPanic. When nothing reached the connection
// yet (no status, or a short body still held, which is dropped) that is rec
// itself, so recoverPanic sends its clean 500. Once the answer is under way (a
// plain status sent, or gzip started), a 500's JSON appended to it would
// corrupt it, so the panic becomes committedPanic: recoverPanic logs it and
// cuts the connection. A gzip stream gets no trailer: the client sees it cut,
// not complete. http.ErrAbortHandler (the relay aborting) passes as it is.
func (g *gzipWriter) abandon(rec any) any {
	committed := g.status != 0 && !g.held
	if g.gz != nil {
		g.gz.Reset(io.Discard)
		gzipWriters.Put(g.gz)
		g.gz = nil
	}
	g.buf, g.held = nil, false
	if err, ok := rec.(error); !committed || ok && errors.Is(err, http.ErrAbortHandler) {
		return rec
	}
	return committedPanic{value: rec}
}

// addVary adds a token to the Vary header unless it is there already.
func addVary(h http.Header, token string) {
	for _, v := range h.Values("Vary") {
		for part := range strings.SplitSeq(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return
			}
		}
	}
	h.Add("Vary", token)
}
