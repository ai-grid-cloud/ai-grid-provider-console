package api

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// assetsPrefix is where Vite writes the bundle. Every file it puts there has a
// content hash in its name (`index-BPyNsiKc.css`, `RedHatDisplayVF-D7m-OdR-.woff2`:
// base64url, so not only hex), so a changed file gets a new URL and the old
// one can be cached for good. The root files (`index.html`, the favicon) keep
// their names and are revalidated.
const assetsPrefix = "/assets/"

// spaHandler serves the built frontend and falls back to index.html for client
// routes so deep links work.
type spaHandler struct {
	dir   string
	files http.Handler
}

func newSPAHandler(dir string) http.Handler {
	return &spaHandler{dir: dir, files: http.FileServer(http.Dir(dir))}
}

// setPageSecurityHeaders is sent with every file of the SPA. The console must
// not be framed, not even by another app under the cluster's `*.apps` domain,
// which is same-site, so SameSite=Lax on the proxy's cookie doesn't stop it
// (clickjacking an admin's session): frame-ancestors for current browsers,
// X-Frame-Options for older ones. nosniff keeps a browser from running a file
// as another type than the one sent, and the referrer stays on the console.
func setPageSecurityHeaders(h http.Header) {
	h.Set("Content-Security-Policy", "frame-ancestors 'none'")
	h.Set("X-Frame-Options", "DENY")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "same-origin")
}

func (s *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	clean := path.Clean("/" + r.URL.Path)
	r.URL.Path = clean // the file server and ServeFile see only the cleaned path
	setPageSecurityHeaders(w.Header())
	target := filepath.Join(s.dir, filepath.FromSlash(clean))
	if info, err := os.Stat(target); err == nil && !info.IsDir() {
		if strings.HasPrefix(clean, assetsPrefix) {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		s.files.ServeHTTP(w, r)
		return
	}
	if strings.Contains(path.Base(clean), ".") && clean != "/" {
		// A missing file with an extension is a real 404, not a client route.
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, filepath.Join(s.dir, "index.html"))
}
