#!/usr/bin/env bash
# Call the local BFF as the user from `oc login`, sending the headers
# kube-auth-proxy would set.
#
#   hack/api.sh /api/v1/clusters
#   hack/api.sh /api/v1/tenants
#
# BFF_URL overrides the base URL (default http://127.0.0.1:8080).
set -euo pipefail
BFF_URL="${BFF_URL:-http://127.0.0.1:8080}"
TOKEN="${AUTH_TOKEN:-$(oc whoami -t)}"
USER_NAME="${AUTH_USER:-$(oc whoami)}"
# ${args[@]+...} below, not "${args[@]}": macOS's /bin/bash 3.2 calls an empty array unbound
# under set -u.
args=()
path=""
for a in "$@"; do
  if [[ "$a" == /* ]]; then path="$a"; else args+=("$a"); fi
done
[[ -n "$path" ]] || { echo "usage: hack/api.sh [curl options] /api/v1/<path>" >&2; exit 2; }
curl -sS -H "x-forwarded-access-token: ${TOKEN}" -H "x-forwarded-user: ${USER_NAME}" \
  ${AUTH_GROUPS:+-H "x-forwarded-groups: ${AUTH_GROUPS}"} \
  -H 'Content-Type: application/json' ${args[@]+"${args[@]}"} "${BFF_URL}${path}"
echo
