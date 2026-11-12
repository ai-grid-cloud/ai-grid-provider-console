# Root developer targets. See docs/dev-setup.md.
IMAGE ?= ghcr.io/ai-grid-cloud/ai-grid-provider-console
# Empty deploys the chart's backend image, the build of .backend-api-version (make backend-pin).
BACKEND_IMAGE ?=
# make image and make push default to :dev; make deploy needs TAG given (see deploy).
TAG ?= dev
# The hub's architecture, not the build machine's: an Apple-silicon Mac builds linux/amd64 too.
PLATFORM ?= linux/amd64
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
CONTAINER_ENGINE ?= $(shell command -v podman 2>/dev/null || command -v docker)

# Where the dev targets listen; set any of them when another process holds a default.
# BACKEND_ADDRESS is the backend's gRPC, which the BFF dials: make dev-cluster forwards the hub's
# backend there, make dev expects yours there, and the fakes listen there.
BACKEND_ADDRESS ?= 127.0.0.1:9090
# The backend's fake hub, which answers the BFF's access review in make dev-fake.
FAKE_HUB_ADDRESS ?= 127.0.0.1:9091
BFF_PORT ?= 8080
FRONTEND_PORT ?= 9000
# Where make dev-cluster forwards the hub's Perses to for the Monitoring page.
PERSES_ADDRESS ?= 127.0.0.1:9445
PERSES_NAMESPACE ?= openshift-cluster-observability-operator
PERSES_SERVICE ?= perses
port-of = $(lastword $(subst :, ,$(1)))

# The ai-grid-provider-backend commit whose API the console is generated from (make generate-api)
# and runs against in make dev-fake: one full commit SHA in .backend-api-version.
BACKEND_API_VERSION := $(strip $(shell cat .backend-api-version))
BACKEND_REPO ?= https://github.com/ai-grid-cloud/ai-grid-provider-backend.git
# A checkout of the backend to run in make dev-fake; empty clones BACKEND_API_VERSION into
# .cache/backend/<sha> (hack/backend-checkout.sh).
BACKEND_DIR ?=
BUF := go run github.com/bufbuild/buf/cmd/buf@v1.57.2
# The backend's real API at the pin, without its draft (ai_grid.draft.v1), and the googleapis
# commit the backend's proto/buf.lock pins, for google.rpc.BadRequest in its errors.
API_INPUT := $(BACKEND_REPO)\#ref=$(BACKEND_API_VERSION),subdir=proto
GOOGLEAPIS := buf.build/googleapis/googleapis:8ac61b9e502343289c8c42b17aa5b245
# Generates the TypeScript into $(1)/src/gen, from frontend/ (buf.gen.yaml runs the protoc-gen-es
# in frontend/node_modules: make install first).
generate-api-into = cd frontend && \
	$(BUF) generate '$(API_INPUT)' --exclude-path ai_grid/draft --template buf.gen.yaml -o "$(1)" && \
	$(BUF) generate '$(GOOGLEAPIS)' --path google/rpc/error_details.proto --template buf.gen.yaml -o "$(1)"

.PHONY: help install dev-cluster dev dev-fake backend-pin generate-api \
	dev-forward-backend dev-forward-perses dev-bff dev-frontend \
	dev-fake-backend dev-bff-fake dev-frontend-fake \
	lint test e2e check-generated-api chart-check chart-test \
	build image push manifests deploy undeploy

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } /^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

##@ Development: the console on http://127.0.0.1:9000, its BFF on :8080 (FRONTEND_PORT, BFF_PORT; docs/dev-setup.md)

install: ## Install the frontend's dependencies (once, before the targets below)
	cd frontend && pnpm install

dev-cluster: ## Against the hub of your oc login: the deployed console's backend (:9090; found in any namespace, or NAMESPACE) and Perses (:9445, with PERSES_PROJECT), port-forwarded
	@BACKEND_ADDRESS=$(BACKEND_ADDRESS) hack/forward-backend.sh --check
	@trap 'kill 0' INT TERM; \
	if [ -z "$$PERSES_URL" ] && [ -z "$$PERSES_PROJECT" ]; then \
		echo "==> Monitoring off: set PERSES_PROJECT to the Perses project whose dashboard-*-admin objects are the tabs"; \
	elif [ -z "$$PERSES_URL" ] && PERSES_ADDRESS=$(PERSES_ADDRESS) PERSES_NAMESPACE=$(PERSES_NAMESPACE) PERSES_SERVICE=$(PERSES_SERVICE) hack/forward-perses.sh --check && \
		ca=$${PERSES_CA_FILE:-$$(hack/service-ca.sh $(PERSES_NAMESPACE))}; then \
		$(MAKE) -s dev-forward-perses & \
		export PERSES_URL=https://$(PERSES_ADDRESS) PERSES_SERVER_NAME=$(PERSES_SERVICE).$(PERSES_NAMESPACE).svc PERSES_CA_FILE="$$ca"; \
	elif [ -z "$$PERSES_URL" ]; then \
		echo "==> Monitoring off"; \
	fi; \
	$(MAKE) -s dev-forward-backend & \
	$(MAKE) -s dev-bff & \
	$(MAKE) -s dev-frontend & \
	wait

dev: ## Against a backend you run yourself on BACKEND_ADDRESS (default 127.0.0.1:9090), as your oc login
	@trap 'kill 0' INT TERM; \
	$(MAKE) -s dev-bff & \
	$(MAKE) -s dev-frontend & \
	wait

dev-fake: ## Without a cluster, on the backend at .backend-api-version and its own fake hub and Keycloak (:9090-:9094; BACKEND_DIR for your checkout)
	@BACKEND_DIR='$(BACKEND_DIR)' BACKEND_REPO='$(BACKEND_REPO)' hack/backend-checkout.sh >/dev/null
	@trap 'kill 0' INT TERM; \
	$(MAKE) -s dev-fake-backend & \
	$(MAKE) -s dev-bff-fake & \
	$(MAKE) -s dev-frontend-fake & \
	wait

backend-pin: ## Move the console to backend commit SHA (a full SHA on the backend's main): .backend-api-version, frontend/src/gen and the backend image of the chart, manifests/base and the kind test
ifndef SHA
	$(error make backend-pin needs SHA, a full ai-grid-provider-backend commit whose sha-<commit> image CI has published)
endif
	hack/backend-pin.sh '$(SHA)'
	$(MAKE) --no-print-directory generate-api

generate-api: ## Regenerate frontend/src/gen from the backend's proto at .backend-api-version (buf through go run; make install first)
	rm -rf frontend/src/gen
	$(call generate-api-into,.)

# The pieces of the dev targets above, one process each, to run in separate terminals
# (docs/dev-setup.md, "Run the pieces separately"). They take the same variables.

# dev-cluster: the hub's backend, found by its label unless NAMESPACE is set (NAMESPACE, DEPLOYMENT,
# SELECTOR: hack/forward-backend.sh), and Perses (PERSES_NAMESPACE, PERSES_SERVICE).
dev-forward-backend:
	BACKEND_ADDRESS=$(BACKEND_ADDRESS) hack/forward-backend.sh

dev-forward-perses:
	PERSES_ADDRESS=$(PERSES_ADDRESS) PERSES_NAMESPACE=$(PERSES_NAMESPACE) PERSES_SERVICE=$(PERSES_SERVICE) hack/forward-perses.sh

# dev-cluster and dev: the BFF against BACKEND_ADDRESS and the hub of your oc login, and the Vite
# dev server, which sends `oc whoami -t` as the caller's token.
dev-bff:
	$(MAKE) -C bff run PORT=$(BFF_PORT) BACKEND_ADDRESS=$(BACKEND_ADDRESS)

dev-frontend:
	cd frontend && BFF_URL=http://127.0.0.1:$(BFF_PORT) FRONTEND_PORT=$(FRONTEND_PORT) pnpm dev

# dev-fake: the backend's own make dev-fake from a checkout at .backend-api-version
# (.cache/backend/<sha>, or BACKEND_DIR), with its gRPC on BACKEND_ADDRESS and its fake hub on
# FAKE_HUB_ADDRESS (its other ports, when set: DEV_HTTP_PORT, DEV_KEYCLOAK_PORT, DEV_DRAFT_PORT);
# the BFF against it, relaying /ai_grid.v1.*, with --fake-backend (the banner, and no login proxy);
# and the Vite dev server as dev-user with a fixture token (AUTH_TOKEN=viewer-token AUTH_USER=viewer
# for a user who isn't a provider admin).
dev-fake-backend:
	@dir="$$(BACKEND_DIR='$(BACKEND_DIR)' BACKEND_REPO='$(BACKEND_REPO)' hack/backend-checkout.sh)" && \
	MAKEFLAGS= $(MAKE) -C "$$dir" dev-fake \
		DEV_GRPC_PORT=$(call port-of,$(BACKEND_ADDRESS)) DEV_HUB_PORT=$(call port-of,$(FAKE_HUB_ADDRESS)) \
		$(foreach v,DEV_HTTP_PORT DEV_KEYCLOAK_PORT DEV_DRAFT_PORT,$(if $($(v)),$(v)=$($(v))))

dev-bff-fake:
	FAKE_BACKEND=true $(MAKE) -C bff run PORT=$(BFF_PORT) BACKEND_ADDRESS=$(BACKEND_ADDRESS) HUB_API_URL=http://$(FAKE_HUB_ADDRESS) HUB_CA_FILE=

dev-frontend-fake:
	cd frontend && BFF_URL=http://127.0.0.1:$(BFF_PORT) FRONTEND_PORT=$(FRONTEND_PORT) \
		AUTH_TOKEN=$${AUTH_TOKEN:-dev-token} AUTH_USER=$${AUTH_USER:-dev-user} pnpm dev

##@ Checks

lint: ## Lint the BFF (vet, golangci-lint) and the frontend (ESLint, Prettier, tsc, generated API current)
	$(MAKE) -C bff vet lint
	cd frontend && pnpm lint && pnpm format:check && pnpm typecheck
	$(MAKE) --no-print-directory check-generated-api

test: ## Run the BFF's Go tests and the frontend's unit tests
	$(MAKE) -C bff test
	cd frontend && pnpm test

e2e: ## Browser tests on the production bundle against a fake stack of their own (first run: cd frontend && pnpm exec playwright install chromium)
	cd frontend && pnpm e2e

check-generated-api: ## Fail when frontend/src/gen differs from what make generate-api writes (stale, hand-edited, missing or left-over files), or a backend image isn't the build of .backend-api-version
	hack/backend-pin.sh --check
	tmp="$$(mktemp -d)" && trap 'rm -rf "$$tmp"' EXIT && \
	($(call generate-api-into,$$tmp)) && \
	diff -r "$$tmp/src/gen" frontend/src/gen

chart-check: ## Lint the Helm chart and check its defaults render manifests/base
	hack/check-chart.sh

chart-test: ## Install the Helm chart into a throwaway kind cluster and check it works (docker, kind)
	hack/test-chart-kind.sh

##@ Build and deploy

build: ## Build the BFF binary and the frontend bundle
	$(MAKE) -C bff build
	cd frontend && pnpm build

image: ## Build the container image for PLATFORM (default linux/amd64)
	$(CONTAINER_ENGINE) build --platform $(PLATFORM) --build-arg CONSOLE_VERSION=$(VERSION) -t $(IMAGE):$(TAG) .

push: ## Push the container image
	$(CONTAINER_ENGINE) push $(IMAGE):$(TAG)

manifests: ## Render manifests/base (not an install path: the chart is; kept for undeploy's fallback and the takeover test)
	kustomize build manifests/base

deploy: ## Deploy IMAGE:TAG to the current cluster with the Helm chart (needs cluster-admin for the OAuthClient)
# TAG must be given: the default :dev is never published, and the Recreate rollout stops the
# running pod before the new one pulls, so a missing tag takes the hub's console down.
ifeq ($(origin TAG),file)
	$(error make deploy needs TAG, a tag the registry has: TAG=sha-<full commit> for CI's, or the one you pushed with make push)
endif
	BACKEND_IMAGE=$(BACKEND_IMAGE) hack/deploy.sh $(IMAGE):$(TAG)

undeploy: ## Remove the release, its secrets and its OAuthClient
	hack/undeploy.sh
