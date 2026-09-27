SHELL := /bin/bash

# AgentKit Studio only ships the plugin. DSH_ROOT points at the official
# DeepSeek Harness checkout and is never vendored into this repository.
# From agentengine/agentkit-studio this resolves to the sibling official DSH
# checkout under agent-sdk. Override it when the checkout lives elsewhere.
DSH_ROOT ?= $(abspath ../../deepseek-harness)
DSH_PROFILE ?= agentkit-studio
DSH_HOST ?= 127.0.0.1
DSH_WEB_PORT ?= 3098
PACK_DIR ?= .artifacts

.PHONY: check test pack verify-dsh verify-dsh-sdk web-build web-dev web-start \
        desktop-build desktop-dev desktop-start desktop-package-mac-arm64 \
        desktop-package-mac-arm64-dir desktop-package-mac-x64 \
        desktop-package-mac-x64-dir desktop-check-package ci clean

check:
	pnpm check

test:
	pnpm test

pack:
	mkdir -p "$(PACK_DIR)"
	pnpm pack --pack-destination "$(PACK_DIR)"

verify-dsh:
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	AGENTKIT_DSH_ROOT="$(DSH_ROOT)" pnpm verify-dsh

verify-dsh-sdk:
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	AGENTKIT_DSH_ROOT="$(DSH_ROOT)" pnpm verify-dsh-sdk

# Build the official DSH web frontend. This does not copy DSH into this repo;
# it verifies the pinned host checkout can produce the browser artifact.
web-build:
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	cd "$(DSH_ROOT)" && pnpm run build:web

# Browser development uses the official DSH web host. The profile must already
# contain this plugin and any optional provider packages.
web-dev:
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	cd "$(DSH_ROOT)" && DSH_HOME="$${DSH_HOME:-}" pnpm dsh --profile "$(DSH_PROFILE)" web --host "$(DSH_HOST)" --no-open --port "$(DSH_WEB_PORT)"

web-start: web-dev

# Build the official Electron package inputs. Packaging a signed distributable
# remains a macOS-only release concern; this target is the local compile gate.
desktop-build:
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	cd "$(DSH_ROOT)" && pnpm run build:desktop

# Electron is an optional official host. These targets do not make the plugin
# depend on Electron and do not package Python/KsADK into the app.
desktop-dev:
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	cd "$(DSH_ROOT)" && DSH_HOME="$${DSH_HOME:-}" pnpm run dev:desktop

desktop-start:
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	cd "$(DSH_ROOT)" && DSH_HOME="$${DSH_HOME:-}" pnpm run start:desktop

desktop-package-mac-arm64:
	@test "$$(uname -s)" = "Darwin" || (echo "macOS packaging must run on macOS" >&2; exit 2)
	cd "$(DSH_ROOT)" && pnpm run package:desktop:mac:arm64

desktop-package-mac-arm64-dir:
	@test "$$(uname -s)" = "Darwin" || (echo "macOS packaging must run on macOS" >&2; exit 2)
	cd "$(DSH_ROOT)" && pnpm run package:desktop:mac:arm64:dir

desktop-package-mac-x64:
	@test "$$(uname -s)" = "Darwin" || (echo "macOS packaging must run on macOS" >&2; exit 2)
	cd "$(DSH_ROOT)" && pnpm run package:desktop:mac:x64

desktop-package-mac-x64-dir:
	@test "$$(uname -s)" = "Darwin" || (echo "macOS packaging must run on macOS" >&2; exit 2)
	cd "$(DSH_ROOT)" && pnpm run package:desktop:mac:x64:dir

desktop-check-package:
	@test "$$(uname -s)" = "Darwin" || (echo "macOS package checks must run on macOS" >&2; exit 2)
	cd "$(DSH_ROOT)" && pnpm --filter @deepseek-ai/dsh-desktop run check:package

# CI intentionally does not require cloud keys, Codex credentials or a DSH
# checkout. The real node-store probe is a separately enabled integration job.
ci: check pack

clean:
	@test -d "$(PACK_DIR)" && find "$(PACK_DIR)" -maxdepth 1 -type f -delete || true
