# Root developer targets. See docs/dev-setup.md.
IMAGE ?= quay.io/cfchase/ai-grid-provider-console
BACKEND_IMAGE ?= quay.io/ai-grid-cloud/ai-grid-backend:latest
TAG ?= dev
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
CONTAINER_ENGINE ?= $(shell command -v podman 2>/dev/null || command -v docker)

BUF ?= go run github.com/bufbuild/buf/cmd/buf@v1.57.2

.PHONY: help fetch-contract generate-contract dev dev-fake dev-fake-poc dev-backend dev-fake-backend dev-bff dev-bff-fake dev-frontend dev-frontend-fake install lint test build e2e image manifests deploy undeploy

help: ## Show targets
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

##@ Development against the cluster from your kubeconfig (run `oc login` first)

dev: ## Run the backend on :9090, the BFF on :8080 and the frontend on :9000 together
	@trap 'kill 0' INT TERM; \
	$(MAKE) -s dev-backend & \
	$(MAKE) -s dev-bff & \
	$(MAKE) -s dev-frontend & \
	wait

dev-backend: ## Run ai-grid-backend locally against your kubeconfig (clones it on first use)
	hack/dev-backend.sh

##@ Development without a cluster (fake backend and fake hub from mock/fixtures, see mock/README.md)

dev-fake: ## Run the fake backend on :9090/:9091, the BFF on :8080 and the frontend on :9000; no oc login needed
	@trap 'kill 0' INT TERM; \
	$(MAKE) -s dev-fake-backend & \
	$(MAKE) -s dev-bff-fake & \
	$(MAKE) -s dev-frontend-fake & \
	wait

dev-fake-poc: ## make dev-fake with the PoC's four sites and three models (mock/fixtures-poc), for the visual comparison
	$(MAKE) dev-fake FIXTURES=../mock/fixtures-poc

dev-fake-backend: ## Run the fake ai-grid-backend and fake hub API
	$(MAKE) -C bff fake-backend

dev-bff-fake: ## Run the BFF against the fake backend and fake hub
	$(MAKE) -C bff run-fake

dev-frontend-fake: ## Run the Vite dev server as dev-user with a fixture token (AUTH_TOKEN=viewer-token to see a non-admin)
	cd frontend && AUTH_TOKEN=$${AUTH_TOKEN:-dev-token} AUTH_USER=$${AUTH_USER:-dev-user} pnpm dev

dev-bff: ## Run the BFF; callers must send the identity headers (see hack/api.sh)
	$(MAKE) -C bff run

dev-frontend: ## Run the Vite dev server, which injects `oc whoami -t`
	cd frontend && pnpm dev

install: ## Install frontend dependencies
	cd frontend && pnpm install

##@ Contract (the backend's protobuf, vendored in contract/ — see docs/adr/0001)

fetch-contract: ## Refresh contract/ai_grid/v1 from the backend (REF=<branch|tag|sha>, default: the pinned commit)
	hack/fetch-backend-proto.sh $(REF)

generate-contract: ## Generate TypeScript for the browser and connect-go for the BFF relay
	rm -rf frontend/src/gen bff/gen/contract
	cd contract && $(BUF) generate --template buf.gen.ts.yaml --include-imports
	cd contract && $(BUF) generate --template buf.gen.go.yaml

##@ Quality

lint: ## Lint the BFF (vet, golangci-lint, buf lint on mock/proto) and the frontend (ESLint, Prettier, tsc)
	$(MAKE) -C bff vet lint lint-proto
	cd frontend && pnpm lint && pnpm format:check && pnpm typecheck

test: ## Run all tests
	$(MAKE) -C bff test
	cd frontend && pnpm test

build: ## Build the BFF binary and the frontend bundle
	$(MAKE) -C bff build
	cd frontend && pnpm build

e2e: ## Browser tests against make dev-fake-poc (Playwright; first run: cd frontend && pnpm exec playwright install chromium)
	cd frontend && pnpm e2e

##@ Packaging and deployment

image: ## Build the container image
	$(CONTAINER_ENGINE) build --build-arg VERSION=$(VERSION) -t $(IMAGE):$(TAG) .

push: ## Push the container image
	$(CONTAINER_ENGINE) push $(IMAGE):$(TAG)

manifests: ## Render the kustomize manifests
	kustomize build manifests/base

deploy: ## Deploy to the current cluster (needs cluster-admin for the OAuthClient)
	BACKEND_IMAGE=$(BACKEND_IMAGE) hack/deploy.sh $(IMAGE):$(TAG)

undeploy: ## Remove the deployment and its OAuthClient
	hack/undeploy.sh
