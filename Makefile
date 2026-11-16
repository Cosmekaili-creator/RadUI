# SPDX-License-Identifier: AGPL-3.0-or-later
# RadUI developer tasks. Configuration comes from the environment; optional
# machine-specific values live in the git-ignored .env.local (KEY=value lines).

-include .env.local

RADICALE_BIN ?= radicale
RADUI_THROWAWAY_DIR ?= ./.throwaway
RADUI_RADICALE_PORT ?= 15232
PYTHON ?= python3
NODE ?= node
PII_SNAPSHOT ?=

# Browser tests: Playwright lives OUTSIDE the repository (see docs/testing.md). Set RADUI_PW_DIR and
# PLAYWRIGHT_BROWSERS_PATH in .env.local. Every browser command runs under a memory cap.
RADUI_PW_DIR ?=
PLAYWRIGHT_BROWSERS_PATH ?=
CAP ?= sudo -n systemd-run --scope --quiet --uid=$(shell id -u) --gid=$(shell id -g) -p MemoryMax=2G -p MemorySwapMax=0 --

export RADICALE_BIN RADUI_THROWAWAY_DIR RADUI_RADICALE_PORT

.PHONY: test lint-licence throwaway-up throwaway-down throwaway-status clean build dist size

test:
	$(PYTHON) -m unittest discover -s backend/tests
	$(PYTHON) -m unittest discover -s tools -p 'test_*.py'
	@if [ -n "$$(find tests/unit-js -name '*.test.mjs' -print -quit)" ]; then \
	  find tests/unit-js -name '*.test.mjs' -print0 | xargs -0 $(NODE) --test; \
	else echo "no *.test.mjs files yet; skipping node --test"; fi
	$(PYTHON) tools/spdx.py
	$(PYTHON) tools/hardcode-check.py
	$(PYTHON) tools/pii-check.py $(if $(PII_SNAPSHOT),--snapshot "$(PII_SNAPSHOT)")

lint-licence:
	$(PYTHON) tools/spdx.py

throwaway-up:
	tools/throwaway/radicale.sh up

throwaway-down:
	tools/throwaway/radicale.sh down

throwaway-status:
	tools/throwaway/radicale.sh status

# Generated files of the static app: the service-worker file list src/sw-manifest.js (git-ignored; one
# SHA-256 per file, content-hash version). The app itself has no other build step. `clean` removes it.
build:
	$(PYTHON) tools/build-sw-manifest.py

# Distribution build: dist/ (git-ignored) = src/ minified file by file with the system `terser`, one flattened
# dictionary per language, plus build-info.json. Deploy it with `tools/deploy-static.sh --src dist ...`.
# Without terser: `make dist DIST_FLAGS=--no-minify`. `make size` prints the size report and checks the budget.
DIST_FLAGS ?=
SIZE_BUDGET_KB ?= 250

dist:
	$(PYTHON) tools/build-dist.py $(DIST_FLAGS)

size: dist
	$(PYTHON) tools/size-report.py --www dist --budget-kb $(SIZE_BUDGET_KB)

clean: throwaway-down
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
	rm -f src/sw-manifest.js
	rm -rf dist

.PHONY: test-roundtrip test-roundtrip-offline

# Round-trip corpus harness (starts and stops its own throwaway Radicale on a port of 15300-15309).
test-roundtrip:
	tests/roundtrip/run.sh

test-roundtrip-offline:
	tests/roundtrip/run.sh offline

.PHONY: test-integration test-security test-e2e test-deploy

# Throwaway Radicale + production plugin + real backend (ports 15290-15299 and 15320-15339).
test-integration:
	RADUI_WP10_PERF=1 $(PYTHON) -m unittest discover -s backend/tests/integration -p 'test*.py'

# Negative-security suite against a throwaway backend and Radicale (ports 15320-15339).
test-security:
	$(PYTHON) -m unittest discover -s tests/security -p 'test_*.py'

# ONE Chromium behind the rendered nginx stack, under the memory cap (ports 15320, 15330, 18100).
# E2E_SUITE=<name> picks one suite (passed on as --suite=<name>); without it the existing shell suite runs.
E2E_SUITE ?=
# E2E_WWW_FROM=dist serves the built tree (run `make dist` first); default: src
E2E_WWW_FROM ?=

test-e2e:
	$(CAP) timeout 600 env HOME="$$HOME" PATH="$$PATH" RADICALE_BIN="$(RADICALE_BIN)" NGINX_BIN="$(NGINX_BIN)" \
	  RADUI_PW_DIR="$(RADUI_PW_DIR)" PLAYWRIGHT_BROWSERS_PATH="$(PLAYWRIGHT_BROWSERS_PATH)" \
	  $(PYTHON) tests/e2e/run.py $(if $(E2E_SUITE),--suite=$(E2E_SUITE)) $(if $(E2E_WWW_FROM),--www-from=$(E2E_WWW_FROM))

# Rendered deploy templates on an unprivileged nginx, and the fail2ban filter tests.
test-deploy:
	timeout 300 $(PYTHON) -I tests/deploy/nginx_check.py
	tests/fail2ban/run.sh
