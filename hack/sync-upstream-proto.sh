#!/usr/bin/env bash
# Refresh the vendored copy of the backend's real proto and record where it came from.
#
#   hack/sync-upstream-proto.sh <ref>      a branch, tag or commit of the backend repository
#
# Writes mock/proto/upstream/ai_grid.proto unchanged from the backend and the resolved
# commit into mock/proto/upstream/COMMIT. Then run `make -C bff test`: the drift test in
# bff/internal/protodrift fails when the draft in mock/proto is no longer a superset of
# the backend's file, which is the signal to update the draft (or adopt the backend's
# package and delete it). .github/workflows/drift.yaml runs both nightly against main.
#
# The fetch lands in a temporary directory; the vendored files are replaced only once
# it succeeded, so a network error or a moved file leaves the previous copy in place.
#
#   BACKEND_REPO  git URL (default: the repo= line of COMMIT)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="${ROOT}/mock/proto/upstream"
COMMIT_FILE="${UPSTREAM}/COMMIT"
REF="${1:-}"
if [[ -z "${REF}" ]]; then
  echo "usage: $0 <ref>" >&2
  exit 2
fi
REPO="${BACKEND_REPO:-$(sed -n 's/^repo=//p' "${COMMIT_FILE}")}"
PROTO_PATH="$(sed -n 's/^path=//p' "${COMMIT_FILE}")"
OWNER_REPO="${REPO#https://github.com/}"
OWNER_REPO="${OWNER_REPO%.git}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
FETCHED="${TMP}/ai_grid.proto"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  SHA="$(gh api "repos/${OWNER_REPO}/commits/${REF}" --jq .sha)"
  gh api -H "Accept: application/vnd.github.raw" "repos/${OWNER_REPO}/contents/${PROTO_PATH}?ref=${SHA}" > "${FETCHED}"
else
  git clone -q --filter=blob:none --no-checkout "${REPO}" "${TMP}/repo"
  git -C "${TMP}/repo" fetch -q origin "${REF}" || true
  SHA="$(git -C "${TMP}/repo" rev-parse "${REF}^{commit}" 2>/dev/null || git -C "${TMP}/repo" rev-parse "origin/${REF}^{commit}")"
  git -C "${TMP}/repo" show "${SHA}:${PROTO_PATH}" > "${FETCHED}"
fi

if ! grep -q '^syntax' "${FETCHED}"; then
  echo "error: ${PROTO_PATH} at ${SHA} does not look like a proto file; keeping the vendored copy" >&2
  exit 1
fi

cat > "${TMP}/COMMIT" <<COMMIT
# Source of upstream/ai_grid.proto: the backend's real proto, vendored unchanged.
# Update with hack/sync-upstream-proto.sh <ref>; hack/dev-backend.sh checks out this commit.
repo=${REPO}
commit=${SHA}
path=${PROTO_PATH}
COMMIT
mv "${FETCHED}" "${UPSTREAM}/ai_grid.proto"
mv "${TMP}/COMMIT" "${COMMIT_FILE}"
echo "==> ${UPSTREAM}/ai_grid.proto now at ${SHA} (${REF}); run 'make -C bff test' for the drift test"
