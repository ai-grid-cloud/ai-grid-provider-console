# BFF developer targets. Run from this directory.
PORT ?= 8080
BACKEND_ADDRESS ?= 127.0.0.1:9090
# Hub API server for the provider-admin access review; defaults to the oc login server
# and its CA from the kubeconfig, when it carries one (hack/hub-ca.sh).
HUB_API_URL ?= $(shell oc whoami --show-server 2>/dev/null)
HUB_CA_FILE ?= $(shell ../hack/hub-ca.sh 2>/dev/null)
LOG_LEVEL ?= debug
FIXTURES ?= ../mock/fixtures
FAKE_HUB_ADDRESS ?= 127.0.0.1:9091
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/api.Version=$(VERSION)

BUF := go run github.com/bufbuild/buf/cmd/buf@v1.57.2
PROTO_DIR := ../mock/proto
# The Go toolchain that generates gen/: the go.mod `toolchain` line, else its `go` line, which is
# what CI's setup-go installs (go-version-file). protoc-gen-go formats its output with the
# go/printer of the Go that builds it, and go/printer's doc-comment rewriting differs between
# releases, so generating with whatever Go is installed can produce a gen/ that CI calls stale.
GEN_TOOLCHAIN := go$(shell awk '$$1 == "toolchain" { t = substr($$2, 3) } $$1 == "go" { g = $$2 } END { print (t != "" ? t : g) }' go.mod)

.PHONY: all fmt vet lint test golden build run run-fake fake-backend tidy generate lint-proto check-generated

all: build

fmt: ## gofmt all packages
	gofmt -l -w .

vet:
	go vet ./...

lint: ## golangci-lint (install: brew install golangci-lint)
	golangci-lint run

test:
	go test -race -count=1 ./...

golden: ## rewrite ../mock/examples, the BFF's responses for ../mock/fixtures at scenario time zero (go test checks them)
	go test -count=1 ./internal/examples -run Golden -update

build: ## build ./bin/bff and ./bin/fake-backend
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o bin/bff ./cmd
	CGO_ENABLED=0 go build -o bin/fake-backend ./cmd/fake-backend

run: ## run against the backend on BACKEND_ADDRESS (make dev-forward-backend, or one from its repository); callers must send the identity headers
	go run -ldflags "$(LDFLAGS)" ./cmd --port=$(PORT) --backend-address=$(BACKEND_ADDRESS) --hub-api-url=$(HUB_API_URL) --hub-ca-file=$(HUB_CA_FILE) --log-level=$(LOG_LEVEL)

fake-backend: ## run the fake ai-grid-backend (:9090) and fake hub API (:9091) from ../mock/fixtures
	go run ./cmd/fake-backend --fixtures=$(FIXTURES) --listen-address=$(BACKEND_ADDRESS) --hub-address=$(FAKE_HUB_ADDRESS) --log-level=$(LOG_LEVEL)

run-fake: ## run the BFF against the fake backend and fake hub; no cluster needed
	go run -ldflags "$(LDFLAGS)" ./cmd --port=$(PORT) --backend-address=$(BACKEND_ADDRESS) --hub-api-url=http://$(FAKE_HUB_ADDRESS) --fake-backend --models-namespace=ai-grid-models --log-level=$(LOG_LEVEL)

tidy:
	go mod tidy

generate: ## regenerate gen/ from ../mock/proto with the go.mod toolchain (buf and the protoc plugins run through go run; nothing to install)
	cd $(PROTO_DIR) && GOTOOLCHAIN=$(GEN_TOOLCHAIN) $(BUF) generate

lint-proto: ## buf lint on the draft proto
	cd $(PROTO_DIR) && $(BUF) lint

check-generated: ## fail when gen/ differs from what ../mock/proto generates: stale, missing or left-over files
	tmp="$$(mktemp -d)" && trap 'rm -rf "$$tmp"' EXIT && \
	sed "s#\.\./\.\./bff/gen#$$tmp/gen#" $(PROTO_DIR)/buf.gen.yaml > "$$tmp/buf.gen.yaml" && \
	(cd $(PROTO_DIR) && GOTOOLCHAIN=$(GEN_TOOLCHAIN) $(BUF) generate --template "$$tmp/buf.gen.yaml") && \
	diff -r --exclude=README.md "$$tmp/gen/ai_grid" gen/ai_grid
