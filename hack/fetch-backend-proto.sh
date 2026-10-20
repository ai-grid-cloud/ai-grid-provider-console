#!/usr/bin/env bash
# Fetch the backend's protobuf contract into contract/ai_grid/v1 and pin the commit.
#
#   hack/fetch-backend-proto.sh [<ref>]    a branch, tag or commit (default: the pinned one)
#
# The contract lives in ai-grid-cloud/ai-grid-provider-backend (docs/adr/0001). The console
# does not author it; it vendors a pinned copy so that `make generate-contract` is
# reproducible offline and so that a diff shows exactly when the contract moved.
#
# The fetch lands in a temporary directory and replaces contract/ai_grid/v1 only once every
# file arrived, so a network error leaves the previous copy in place.
#
#   BACKEND_REPO  git URL (default: the repo= line of contract/COMMIT)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT="${ROOT}/contract"
COMMIT_FILE="${CONTRACT}/COMMIT"
REF="${1:-}"

REPO="${BACKEND_REPO:-$(sed -n 's/^repo=//p' "${COMMIT_FILE}")}"
PROTO_DIR="$(sed -n 's/^path=//p' "${COMMIT_FILE}")"
if [[ -z "${REF}" ]]; then
  REF="$(sed -n 's/^commit=//p' "${COMMIT_FILE}")"
fi
OWNER_REPO="${REPO#https://github.com/}"
OWNER_REPO="${OWNER_REPO%.git}"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
mkdir -p "${TMP}/v1"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  SHA="$(gh api "repos/${OWNER_REPO}/commits/${REF}" --jq .sha)"
  # No mapfile: bash 3.2 ships on macOS.
  gh api "repos/${OWNER_REPO}/contents/${PROTO_DIR}?ref=${SHA}" \
    --jq '.[] | select(.name | endswith(".proto")) | .name' > "${TMP}/names"
  while IFS= read -r f; do
    [[ -n "${f}" ]] || continue
    gh api -H "Accept: application/vnd.github.raw" \
      "repos/${OWNER_REPO}/contents/${PROTO_DIR}/${f}?ref=${SHA}" > "${TMP}/v1/${f}"
  done < "${TMP}/names"
else
  git clone -q --filter=blob:none --no-checkout "${REPO}" "${TMP}/repo"
  git -C "${TMP}/repo" fetch -q origin "${REF}" || true
  SHA="$(git -C "${TMP}/repo" rev-parse "${REF}^{commit}" 2>/dev/null || git -C "${TMP}/repo" rev-parse "origin/${REF}^{commit}")"
  git -C "${TMP}/repo" checkout -q "${SHA}" -- "${PROTO_DIR}"
  cp "${TMP}/repo/${PROTO_DIR}"/*.proto "${TMP}/v1/"
fi

shopt -s nullglob
FETCHED=("${TMP}"/v1/*.proto)
if [[ ${#FETCHED[@]} -eq 0 ]]; then
  echo "error: no .proto files at ${PROTO_DIR} in ${REF}; keeping the vendored copy" >&2
  exit 1
fi
for f in "${FETCHED[@]}"; do
  grep -q '^syntax' "${f}" || { echo "error: $(basename "${f}") is not a proto file; keeping the vendored copy" >&2; exit 1; }
done

cat > "${TMP}/COMMIT" <<COMMIT
# Source of contract/ai_grid/v1: the backend's protobuf contract, vendored unchanged.
# The console does not author it (docs/adr/0001-the-contract-lives-in-the-backend.md).
# Refresh with hack/fetch-backend-proto.sh <ref>, then run make generate-contract.
repo=${REPO}
commit=${SHA}
path=${PROTO_DIR}
COMMIT

rm -rf "${CONTRACT}/ai_grid/v1"
mkdir -p "${CONTRACT}/ai_grid/v1"
cp "${TMP}"/v1/*.proto "${CONTRACT}/ai_grid/v1/"
mv "${TMP}/COMMIT" "${COMMIT_FILE}"
echo "==> contract/ai_grid/v1 now at ${SHA} (${REF}), ${#FETCHED[@]} files; run 'make generate-contract'"
