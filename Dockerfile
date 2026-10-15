# Multi-stage build: frontend (pnpm), BFF (Go), distroless runtime.
ARG NODE_BASE_IMAGE=node:22
ARG GOLANG_BASE_IMAGE=golang:1.26
ARG RUNTIME_BASE_IMAGE=gcr.io/distroless/static:nonroot

FROM ${NODE_BASE_IMAGE} AS frontend-builder
WORKDIR /src/frontend
RUN npm install -g pnpm@11.22.0
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm run build

FROM ${GOLANG_BASE_IMAGE} AS bff-builder
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src/bff
COPY bff/go.mod bff/go.sum ./
RUN go mod download
COPY bff/ ./
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -ldflags "-s -w -X github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/api.Version=${VERSION}" -o /out/bff ./cmd

FROM ${RUNTIME_BASE_IMAGE}
WORKDIR /
COPY --from=bff-builder /out/bff /bff
COPY --from=frontend-builder /src/frontend/dist /static
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/bff"]
CMD ["--static-assets-dir=/static"]
