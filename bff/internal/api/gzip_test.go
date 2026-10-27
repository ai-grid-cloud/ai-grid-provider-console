package api

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend/backendtest"
)

func gunzip(t *testing.T, body []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("not gzip: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gunzip: %v", err)
	}
	return out
}

func withGzip(req *http.Request) *http.Request {
	req.Header.Set("Accept-Encoding", "gzip, deflate, br")
	return req
}

// assertPlain checks an answer that must go out as the handler wrote it.
func assertPlain(t *testing.T, what string, rec *httptest.ResponseRecorder, want []byte) {
	t.Helper()
	if ce := rec.Header().Get("Content-Encoding"); ce == "gzip" {
		t.Errorf("%s: gzipped, want it as it is", what)
	}
	if want != nil && !bytes.Equal(rec.Body.Bytes(), want) {
		t.Errorf("%s: body = %q, want %q", what, rec.Body.String(), want)
	}
}

func TestGzipCompressesJSONAndAssets(t *testing.T) {
	fake := &backendtest.Fake{}
	for i := range 20 {
		c := proto.Clone(richCluster()).(*aigridv1.ManagedCluster)
		c.Name = fmt.Sprintf("site-%02d", i)
		fake.Clusters = append(fake.Clusters, c)
	}
	dir := t.TempDir()
	js := []byte(strings.Repeat("export const answer = 42;\n", 200))
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "index-BPyNsiKc.js"), js, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>index</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.StaticAssetsDir = dir
	app := newTestApp(t, cfg, fake)

	plain := serve(app, asUser(http.MethodGet, "/api/v1/clusters"))
	if plain.Code != http.StatusOK || plain.Body.Len() < gzipMinSize {
		t.Fatalf("list: %d, %d bytes", plain.Code, plain.Body.Len())
	}
	if plain.Header().Get("Content-Encoding") != "" || plain.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("a client without gzip: headers %v", plain.Header())
	}
	zipped := serve(app, withGzip(asUser(http.MethodGet, "/api/v1/clusters")))
	if zipped.Header().Get("Content-Encoding") != "gzip" || zipped.Header().Get("Vary") != "Accept-Encoding" || zipped.Header().Get("Content-Length") != "" {
		t.Fatalf("list with gzip: headers %v", zipped.Header())
	}
	if got := gunzip(t, zipped.Body.Bytes()); !bytes.Equal(got, plain.Body.Bytes()) {
		t.Fatalf("the gzipped list decodes to %q, want %q", got, plain.Body.String())
	}
	if zipped.Body.Len() >= plain.Body.Len() {
		t.Errorf("gzip did not shrink the list: %d >= %d bytes", zipped.Body.Len(), plain.Body.Len())
	}

	asset := serve(app, withGzip(httptest.NewRequest(http.MethodGet, "/assets/index-BPyNsiKc.js", nil)))
	if asset.Code != http.StatusOK || asset.Header().Get("Content-Encoding") != "gzip" || asset.Header().Get("Content-Length") != "" || asset.Header().Get("Accept-Ranges") != "" {
		t.Fatalf("asset with gzip: %d %v", asset.Code, asset.Header())
	}
	if got := gunzip(t, asset.Body.Bytes()); !bytes.Equal(got, js) {
		t.Fatal("the gzipped asset does not decode to the file")
	}
	if asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || asset.Header().Get("X-Frame-Options") != "DENY" {
		t.Errorf("asset headers lost: %v", asset.Header())
	}

	// HEAD and Range answer about the uncompressed file.
	head := serve(app, withGzip(httptest.NewRequest(http.MethodHead, "/assets/index-BPyNsiKc.js", nil)))
	if head.Header().Get("Content-Encoding") != "" || head.Header().Get("Content-Length") != fmt.Sprint(len(js)) {
		t.Errorf("HEAD: %v", head.Header())
	}
	ranged := withGzip(httptest.NewRequest(http.MethodGet, "/assets/index-BPyNsiKc.js", nil))
	ranged.Header.Set("Range", "bytes=0-9")
	rec := serve(app, ranged)
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("Range: %d", rec.Code)
	}
	assertPlain(t, "Range", rec, js[:10])

	// A small answer is not worth it.
	small := serve(app, withGzip(asUser(http.MethodGet, "/api/v1/config")))
	if small.Code != http.StatusOK || small.Body.Len() >= gzipMinSize {
		t.Fatalf("config: %d, %d bytes", small.Code, small.Body.Len())
	}
	assertPlain(t, "small JSON", small, nil)
	if small.Header().Get("Vary") != "Accept-Encoding" {
		t.Errorf("small JSON: Vary = %q", small.Header().Get("Vary"))
	}
	assertPlain(t, "index.html", serve(app, withGzip(httptest.NewRequest(http.MethodGet, "/", nil))), []byte("<html>index</html>"))
}

func TestGzipLeavesOtherAnswersAlone(t *testing.T) {
	big := bytes.Repeat([]byte("a"), 4*gzipMinSize)
	cases := []struct {
		name    string
		handler http.HandlerFunc
		accept  string
	}{
		{"already encoded", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Encoding", "br")
			_, _ = w.Write(big)
		}, "gzip"},
		{"not compressible", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "font/woff2")
			_, _ = w.Write(big)
		}, "gzip"},
		{"no content type", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			_, _ = w.Write(big)
		}, "gzip"},
		{"gzip refused with q=0", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(big)
		}, "br, gzip;q=0"},
		{"no Accept-Encoding", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(big)
		}, ""},
		{"small, written in parts", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/css")
			_, _ = w.Write(big[:100])
			_, _ = w.Write(big[:100])
		}, "gzip"},
		{"small with a length", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/css")
			w.Header().Set("Content-Length", "100")
			_, _ = w.Write(big[:100])
		}, "gzip"},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		if tc.accept != "" {
			req.Header.Set("Accept-Encoding", tc.accept)
		}
		rec := httptest.NewRecorder()
		compress(tc.handler).ServeHTTP(rec, req)
		want := big
		if strings.HasPrefix(tc.name, "small") {
			want = big[:100]
			if tc.name == "small, written in parts" {
				want = big[:200]
			}
		}
		assertPlain(t, tc.name, rec, want)
		if tc.name == "already encoded" && rec.Header().Get("Content-Encoding") != "br" {
			t.Errorf("already encoded: Content-Encoding = %q", rec.Header().Get("Content-Encoding"))
		}
	}

	for _, code := range []int{http.StatusNoContent, http.StatusNotModified} {
		rec := httptest.NewRecorder()
		req := withGzip(httptest.NewRequest(http.MethodGet, "/x", nil))
		compress(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(code)
		})).ServeHTTP(rec, req)
		if rec.Code != code || rec.Header().Get("Content-Encoding") != "" || rec.Body.Len() != 0 {
			t.Errorf("%d: %d %v %q", code, rec.Code, rec.Header(), rec.Body.String())
		}
	}

	// A long compressible answer with a status other than 200 keeps it.
	rec := httptest.NewRecorder()
	compress(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write(big)
	})).ServeHTTP(rec, withGzip(httptest.NewRequest(http.MethodGet, "/x", nil)))
	if rec.Code != http.StatusUnprocessableEntity || !bytes.Equal(gunzip(t, rec.Body.Bytes()), big) {
		t.Errorf("422: %d", rec.Code)
	}
}

// A handler that writes, flushes and writes again (the Perses relay streaming
// an answer) delivers the first part, decodable, before it finishes: through
// the request log's recorder and the gzip writer, as in App.Handler.
func TestGzipStreamsFlushedParts(t *testing.T) {
	app := newTestApp(t, testConfig(t), nil)
	release := make(chan struct{})
	first, second := `{"part":1}`, `{"part":2}`
	srv := httptest.NewServer(app.logRequests(compress(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, first)
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("flush through the middleware: %v", err)
		}
		<-release
		_, _ = io.WriteString(w, second)
	}))))
	defer srv.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()

	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Header.Set("Accept-Encoding", "gzip")
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}, Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding = %q", resp.Header.Get("Content-Encoding"))
	}
	zr, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(first))
	read := make(chan error, 1)
	go func() { _, err := io.ReadFull(zr, got); read <- err }()
	select {
	case err := <-read:
		if err != nil || string(got) != first {
			t.Fatalf("first part = %q, %v", got, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the flushed part did not arrive before the handler finished")
	}
	close(release)
	rest, err := io.ReadAll(zr)
	if err != nil || string(rest) != second {
		t.Fatalf("second part = %q, %v", rest, err)
	}
}

func TestAcceptsGzip(t *testing.T) {
	cases := []struct {
		accept []string // one entry per Accept-Encoding line
		want   bool
	}{
		{[]string{"gzip"}, true},
		{[]string{"GZIP"}, true},
		{[]string{"gzip;q=0.5"}, true},
		{[]string{"gzip; q=0.5"}, true},
		{[]string{"br, gzip;q=0"}, false},
		{[]string{"gzip;q=0.000"}, false},
		// An explicit gzip entry decides; `*` stands only for codings not listed.
		{[]string{"gzip;q=0, *;q=1"}, false},
		{[]string{"*;q=1, gzip;q=0"}, false},
		{[]string{"gzip;q=0", "*"}, false},
		{[]string{"*", "gzip;q=0"}, false},
		{[]string{"*"}, true},
		{[]string{"br", "*;q=0.1"}, true},
		{[]string{"*;q=0"}, false},
		{[]string{"*;q=0, gzip"}, true},
		{[]string{"br", "gzip"}, true},
		{[]string{"identity"}, false},
		{[]string{"identity, br"}, false},
		{nil, false},
		// A q that does not parse makes its entry unacceptable.
		{[]string{"gzip;q=high"}, false},
		{[]string{"gzip;q=2"}, false},
		{[]string{"gzip;q=NaN"}, false},
		{[]string{"gzip;q=1e0"}, false},
		{[]string{"gzip;q="}, false},
		{[]string{"gzip;q=high, *"}, false},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		for _, v := range tc.accept {
			req.Header.Add("Accept-Encoding", v)
		}
		if got := acceptsGzip(req); got != tc.want {
			t.Errorf("Accept-Encoding %q: acceptsGzip = %v, want %v", tc.accept, got, tc.want)
		}
	}
}

// panicChain is App.Handler's middleware around one handler, with the logs kept.
func panicChain(t *testing.T, h http.HandlerFunc) (http.Handler, *lockedBuffer) {
	t.Helper()
	logs := &lockedBuffer{}
	app := NewApp(testConfig(t), slog.New(slog.NewTextHandler(logs, nil)), backendtest.Start(t, &backendtest.Fake{}), startHub(t, &fakeHub{allowed: true}))
	return app.recoverPanic(app.logRequests(compress(h))), logs
}

// A panic before anything reached the connection (no status yet, or a short
// body still held) is the clean JSON 500 recoverPanic writes, never gzipped.
func TestGzipPanicBeforeTheAnswerIsA500(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"before any write": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			panic("boom")
		},
		"with a held body": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(bytes.Repeat([]byte("a"), gzipMinSize/2))
			panic("boom")
		},
	}
	for name, h := range cases {
		chain, logs := panicChain(t, h)
		rec := httptest.NewRecorder()
		chain.ServeHTTP(rec, withGzip(httptest.NewRequest(http.MethodGet, "/x", nil)))
		if rec.Code != http.StatusInternalServerError || rec.Header().Get("Content-Encoding") != "" {
			t.Errorf("%s: %d, Content-Encoding %q", name, rec.Code, rec.Header().Get("Content-Encoding"))
		}
		if body := rec.Body.String(); !strings.HasPrefix(body, `{"error"`) || strings.Contains(body, "aaaa") {
			t.Errorf("%s: body = %q, want only the 500's error", name, body)
		}
		if n := strings.Count(logs.String(), "panic serving request"); n != 1 {
			t.Errorf("%s: panic logged %d times:\n%s", name, n, logs.String())
		}
	}
}

// A panic once the answer is under way (gzip started, a flushed part sent, or
// a plain status written) cuts the connection: a 500's JSON appended to it
// would be an answer the client cannot decode. The panic is still logged, once,
// with the stack of the handler that panicked, and a gzip stream gets no trailer,
// so the client sees it cut rather than complete.
func TestGzipPanicAfterTheAnswerStartedAborts(t *testing.T) {
	cases := []struct {
		name    string
		gzipped bool
		handler http.HandlerFunc
	}{
		{"after compression started", true, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(bytes.Repeat([]byte("a"), 2*gzipMinSize))
			panic("boom")
		}},
		{"after a flush", true, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"part":1}`))
			w.(http.Flusher).Flush()
			panic("boom")
		}},
		{"after a plain status", false, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "font/woff2")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("font"))
			panic("boom")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			chain, logs := panicChain(t, tc.handler)
			rec := httptest.NewRecorder()
			func() {
				defer func() {
					if got, _ := recover().(error); !errors.Is(got, http.ErrAbortHandler) {
						t.Errorf("recovered %v, want http.ErrAbortHandler so net/http cuts the connection", got)
					}
				}()
				chain.ServeHTTP(rec, withGzip(httptest.NewRequest(http.MethodGet, "/x", nil)))
			}()
			if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "internal server error") {
				t.Errorf("wrote a 500 into the answer: %d %q", rec.Code, rec.Body.String())
			}
			if tc.gzipped {
				if rec.Header().Get("Content-Encoding") != "gzip" {
					t.Fatalf("Content-Encoding = %q", rec.Header().Get("Content-Encoding"))
				}
				if zr, err := gzip.NewReader(bytes.NewReader(rec.Body.Bytes())); err == nil {
					if _, err := io.ReadAll(zr); err == nil {
						t.Error("the cut gzip stream decodes as complete: it got its trailer")
					}
				}
			}
			out := logs.String()
			if n := strings.Count(out, "panic serving request"); n != 1 || !strings.Contains(out, "panic=boom") {
				t.Errorf("panic logged %d times, want once with its value:\n%s", n, out)
			}
			if !strings.Contains(out, "TestGzipPanicAfterTheAnswerStartedAborts") {
				t.Errorf("the logged stack does not reach the handler that panicked:\n%s", out)
			}
		})
	}
}

// The relay aborting a compressed answer (Perses went away mid-answer) is not
// a panic to log: http.ErrAbortHandler passes through as it is.
func TestGzipAbortAfterCompressionIsNotLogged(t *testing.T) {
	chain, logs := panicChain(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"partial":`))
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	})
	defer func() {
		if got, _ := recover().(error); !errors.Is(got, http.ErrAbortHandler) {
			t.Errorf("recovered %v, want http.ErrAbortHandler", got)
		}
		if strings.Contains(logs.String(), "panic serving request") {
			t.Errorf("an abort logged as a panic:\n%s", logs.String())
		}
	}()
	chain.ServeHTTP(httptest.NewRecorder(), withGzip(httptest.NewRequest(http.MethodGet, "/x", nil)))
	t.Fatal("the abort did not reach net/http")
}
