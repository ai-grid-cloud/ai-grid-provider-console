package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/clusters"
)

const maxBodyBytes = 1 << 20

func (a *App) listClusters(w http.ResponseWriter, r *http.Request) {
	c, err := a.clients.ClientFor(r.Context())
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	out, err := clusters.List(r.Context(), c)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, out)
}

func (a *App) getCluster(w http.ResponseWriter, r *http.Request) {
	c, err := a.clients.ClientFor(r.Context())
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	out, err := clusters.Get(r.Context(), c, r.PathValue("name"))
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, out)
}

func (a *App) patchCluster(w http.ResponseWriter, r *http.Request) {
	var update clusters.Update
	if err := decodeBody(r, &update); err != nil {
		a.respondError(w, r, err)
		return
	}
	c, err := a.clients.ClientFor(r.Context())
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	out, err := clusters.Patch(r.Context(), c, r.PathValue("name"), update)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, out)
}

func (a *App) listLocations(w http.ResponseWriter, r *http.Request) {
	c, err := a.clients.ClientFor(r.Context())
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	out, err := clusters.Locations(r.Context(), c)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, out)
}

// decodeBody reads a JSON body strictly: unknown fields and trailing data are
// rejected with 422.
func decodeBody(r *http.Request, into any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		if errors.Is(err, io.EOF) {
			return Errorf(http.StatusUnprocessableEntity, "request body is required")
		}
		return Errorf(http.StatusUnprocessableEntity, "invalid request body: "+err.Error())
	}
	if dec.More() {
		return Errorf(http.StatusUnprocessableEntity, "request body must contain a single JSON object")
	}
	return nil
}
