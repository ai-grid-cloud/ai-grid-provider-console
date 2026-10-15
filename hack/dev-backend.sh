#!/usr/bin/env bash
# Run ai-grid-backend locally against the cluster from your kubeconfig, on the
# address the BFF dials by default. Clones the backend into .cache/ on first use.
#
#   BACKEND_REPO  git URL (default https://github.com/yuvalturg/ai-grid-backend)
#   BACKEND_REF   git ref to check out (default: the commit in mock/proto/upstream/COMMIT)
#   BACKEND_DIR   use an existing checkout instead of cloning
#   LISTEN        listen address (default 127.0.0.1:9090)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${BACKEND_REPO:-https://github.com/yuvalturg/ai-grid-backend}"
DIR="${BACKEND_DIR:-${ROOT}/.cache/ai-grid-backend}"
LISTEN="${LISTEN:-127.0.0.1:9090}"
if [[ -z "${BACKEND_REF:-}" ]]; then
  # The commit whose proto is vendored in mock/proto/upstream (hack/sync-upstream-proto.sh).
  BACKEND_REF="$(sed -n 's/^commit=//p' "${ROOT}/mock/proto/upstream/COMMIT")"
fi

if [[ ! -d "${DIR}/.git" ]]; then
  echo "==> cloning ${REPO} into ${DIR}"
  git clone -q "${REPO}" "${DIR}"
fi
if [[ -n "${BACKEND_REF}" && -z "${BACKEND_DIR:-}" ]]; then
  git -C "${DIR}" fetch -q origin
  git -C "${DIR}" checkout -q "${BACKEND_REF}"
fi
echo "==> ai-grid-backend $(git -C "${DIR}" rev-parse --short HEAD) on ${LISTEN} as $(oc whoami)"
cd "${DIR}"
exec go run ./cmd/ai-grid-backend --kubeconfig "${KUBECONFIG:-$HOME/.kube/config}" --listen-address "${LISTEN}" "$@"
