package fakebackend

import (
	"log/slog"
	"testing"
	"time"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestInvalidCarriesFieldViolations(t *testing.T) {
	fields := map[string]string{
		"name":                           "Use lowercase letters, numbers, and hyphens.",
		"identityProvider.config.issuer": "Enter a valid HTTP or HTTPS URL.",
	}
	st := status.Convert(invalid(joinMessages(fields), fields))
	if st.Code() != codes.InvalidArgument {
		t.Fatalf("code %v", st.Code())
	}
	if want := "Enter a valid HTTP or HTTPS URL. Use lowercase letters, numbers, and hyphens."; st.Message() != want {
		t.Fatalf("summary %q, want %q", st.Message(), want)
	}
	var got []*errdetails.BadRequest_FieldViolation
	for _, d := range st.Details() {
		if br, ok := d.(*errdetails.BadRequest); ok {
			got = append(got, br.GetFieldViolations()...)
		}
	}
	if len(got) != 2 || got[0].GetField() != "identityProvider.config.issuer" || got[1].GetField() != "name" {
		t.Fatalf("violations %v, want both fields in path order", got)
	}
	for _, v := range got {
		if v.GetDescription() != fields[v.GetField()] {
			t.Errorf("%s: %q", v.GetField(), v.GetDescription())
		}
	}
}

// fieldViolations are the BadRequest field violations of err, by field.
func fieldViolations(err error) map[string]string {
	out := map[string]string{}
	for _, d := range status.Convert(err).Details() {
		if br, ok := d.(*errdetails.BadRequest); ok {
			for _, v := range br.GetFieldViolations() {
				out[v.GetField()] = v.GetDescription()
			}
		}
	}
	return out
}

// fixedNow is the clock of newRepoServer.
var fixedNow = time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)

// newRepoServer is a server on the shipped fixtures whose clock stands still
// at fixedNow.
func newRepoServer(t *testing.T) *Server {
	t.Helper()
	fx, err := Load(repoFixtures)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(fx, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	s.SetClock(func() time.Time { return fixedNow })
	return s
}
