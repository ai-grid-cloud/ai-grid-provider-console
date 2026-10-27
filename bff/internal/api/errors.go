package api

import (
	"context"
	"errors"
	"net/http"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// statusError carries an HTTP status chosen by the handler.
type statusError struct {
	status  int
	message string
}

func (e *statusError) Error() string { return e.message }

// errHub marks a failed call to the hub API; the detail stays in the log.
var errHub = errors.New("hub request failed")

// Errorf builds an error that maps to a specific HTTP status.
func Errorf(status int, message string) error {
	return &statusError{status: status, message: message}
}

// respondError maps an error to a status and writes it.
func (a *App) respondError(w http.ResponseWriter, r *http.Request, err error) {
	code, message := classify(err)
	if code >= http.StatusInternalServerError {
		a.log(r).Error("request failed", "method", r.Method, "path", r.URL.Path, "status", code, "error", err)
	} else {
		a.log(r).Debug("request rejected", "method", r.Method, "path", r.URL.Path, "status", code, "error", err)
	}
	writeErrorFields(w, code, message, fieldErrors(err))
}

// fieldErrors returns the per-field messages in a BadRequest detail, keyed by
// the JSON path the frontend form uses. Only InvalidArgument (HTTP 422) carries
// them; on any other code the details stay out of the response.
func fieldErrors(err error) map[string]string {
	st, ok := status.FromError(err)
	if !ok || st.Code() != codes.InvalidArgument {
		return nil
	}
	var out map[string]string
	for _, d := range st.Details() {
		if br, ok := d.(*errdetails.BadRequest); ok {
			for _, v := range br.GetFieldViolations() {
				if out == nil {
					out = map[string]string{}
				}
				if _, dup := out[v.GetField()]; !dup {
					out[v.GetField()] = v.GetDescription()
				}
			}
		}
	}
	return out
}

// classify maps handler and gRPC errors to HTTP. The backend's message is kept
// for client-caused failures so the user sees what it said; infrastructure
// failures get a generic message and the detail goes to the log.
func classify(err error) (int, string) {
	var se *statusError
	if errors.As(err, &se) {
		return se.status, se.message
	}
	// Before the deadline: a hub that is too slow (hub.Config's timeout) is a
	// hub failure, not the backend's.
	if errors.Is(err, errHub) {
		return http.StatusBadGateway, "the hub could not confirm the caller's permissions; try again"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return http.StatusGatewayTimeout, "the AI Grid backend did not answer in time"
	}
	if st, ok := status.FromError(err); ok {
		msg := st.Message()
		switch st.Code() {
		case codes.InvalidArgument, codes.OutOfRange:
			return http.StatusUnprocessableEntity, msg
		case codes.Unauthenticated:
			return http.StatusUnauthorized, "the AI Grid backend rejected the credentials; log in again"
		case codes.PermissionDenied:
			return http.StatusForbidden, msg
		case codes.NotFound:
			return http.StatusNotFound, msg
		case codes.AlreadyExists, codes.Aborted:
			return http.StatusConflict, msg
		case codes.FailedPrecondition:
			return http.StatusPreconditionFailed, msg
		case codes.ResourceExhausted:
			return http.StatusTooManyRequests, "the AI Grid backend is rate limiting requests; try again shortly"
		case codes.Unimplemented:
			return http.StatusNotImplemented, "the AI Grid backend does not support this operation yet"
		case codes.DeadlineExceeded:
			return http.StatusGatewayTimeout, "the AI Grid backend did not answer in time"
		case codes.Unavailable, codes.Canceled:
			return http.StatusServiceUnavailable, "the AI Grid backend is unavailable; try again"
		case codes.OK:
			return http.StatusInternalServerError, "internal server error"
		}
		return http.StatusBadGateway, "the AI Grid backend failed to process the request"
	}
	return http.StatusInternalServerError, "internal server error"
}
