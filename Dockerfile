# Multi-stage build: frontend (pnpm), BFF (Go), UBI minimal runtime.
#
# Red Hat UBI images, pinned by tag and digest (Dependabot bumps both). go-toolset's Go must be at
# least bff/go.mod's go line. The runtime is ubi-minimal, not ubi-micro, because ubi-micro has no
# CA bundle and the BFF calls the hub and the backend over TLS. The builders run as their default
# user 1001, so the sources are copied in as 1001.

FROM registry.access.redhat.com/ubi9/nodejs-22:9.8-1792441643@sha256:1d423d9a54713c59859c77f35ae7d2e61d330993aa4f28fe979c920038c4c867 AS frontend-builder
WORKDIR /opt/app-root/src/frontend
RUN npm install -g pnpm@11.22.0
COPY --chown=1001:0 frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
# The dependency patches pnpm-workspace.yaml names, which the install applies.
COPY --chown=1001:0 frontend/patches/ ./patches/
RUN pnpm install --frozen-lockfile
COPY --chown=1001:0 frontend/ ./
RUN pnpm run build

FROM registry.access.redhat.com/ubi9/go-toolset:1.26.10-1792592174@sha256:d4d25f236c2b3cd27eb407e3b3478bef0b75d644ee6d11772217f537be926b11 AS bff-builder
ARG TARGETOS
ARG TARGETARCH
# Not VERSION: go-toolset sets ENV VERSION (its Go version), which would override the build arg.
ARG CONSOLE_VERSION=dev
WORKDIR /opt/app-root/src/bff
COPY --chown=1001:0 bff/go.mod bff/go.sum ./
RUN go mod download
COPY --chown=1001:0 bff/ ./
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -ldflags "-s -w -X github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/api.Version=${CONSOLE_VERSION}" -o /tmp/out/bff ./cmd

FROM registry.access.redhat.com/ubi9/ubi-minimal:9.8-1791898448@sha256:c4c285d42941ebb2bd4da878479008e1e4536bb599aad1dbe568f89de9053661
WORKDIR /
# Owned by root and world-readable, so OpenShift's arbitrary UID (group 0) can run and serve them.
COPY --from=bff-builder --chown=0:0 /tmp/out/bff /bff
COPY --from=frontend-builder --chown=0:0 /opt/app-root/src/frontend/dist /static
USER 1001
EXPOSE 8080
ENTRYPOINT ["/bff"]
CMD ["--static-assets-dir=/static"]
