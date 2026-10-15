# BFF developer targets. Run from this directory.
PORT ?= 8080
HUB_NAMESPACE ?= ai-grid
LOG_LEVEL ?= debug
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/api.Version=$(VERSION)

.PHONY: all fmt vet lint test build run tidy

all: build

fmt: ## gofmt all packages
	gofmt -l -w .

vet:
	go vet ./...

lint: ## golangci-lint (install: brew install golangci-lint)
	golangci-lint run

test:
	go test -race -count=1 ./...

build: ## build ./bin/bff
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o bin/bff ./cmd

run: ## run against the cluster from your kubeconfig; callers must send the token header
	go run -ldflags "$(LDFLAGS)" ./cmd --port=$(PORT) --hub-namespace=$(HUB_NAMESPACE) --log-level=$(LOG_LEVEL)

tidy:
	go mod tidy
