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
DSH_VERSION ?= 0.1.7-rc.2
DSH_COMMIT ?= 477b4f420553e8a52c2fbccc464d7561b239c443
PATCH_ROOT ?= $(abspath patches/dsh-v$(DSH_VERSION))
PLUGIN_VERSION := $(shell node -p "require('./package.json').version")
PLUGIN_TARBALL ?= $(abspath $(PACK_DIR)/kingsoftcloud-agentkit-studio-$(PLUGIN_VERSION).tgz)

.PHONY: check test pack release-check profile-install patch-check patch-apply verify-dsh verify-dsh-sdk web-build web-dev web-start \
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

release-check: check pack
	node scripts/check-package.mjs "$(PLUGIN_TARBALL)"
	git diff --check

# Install the packed plugin into a DSH profile. This is intentionally
# explicit: it mutates DSH_HOME and must not happen as a side effect of a
# read-only check or a normal package build.
profile-install: pack
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	@test -f "$(PLUGIN_TARBALL)" || (echo "插件包不存在：$(PLUGIN_TARBALL)" >&2; exit 2)
	@profile_dir="$${DSH_HOME:-$$HOME/.dsh}/profiles/$(DSH_PROFILE)"; \
	if test ! -f "$$profile_dir/package.json"; then \
		(cd "$(DSH_ROOT)" && pnpm dsh --profile "$(DSH_PROFILE)" --from-default-profile web --dump-config >/dev/null); \
	fi
	cd "$(DSH_ROOT)" && pnpm dsh plugin --profile "$(DSH_PROFILE)" add "file:$(PLUGIN_TARBALL)"

# Patches are versioned host compatibility inputs, not runtime source. Check
# the exact DSH baseline and a clean checkout before applying any of them.
patch-check:
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	@test -d "$(PATCH_ROOT)" || (echo "补丁目录不存在：$(PATCH_ROOT)" >&2; exit 2)
	@test "$$(git -C "$(DSH_ROOT)" rev-parse HEAD)" = "$(DSH_COMMIT)" || (echo "DSH checkout 不是 $(DSH_VERSION) 基线 $(DSH_COMMIT)" >&2; exit 2)
	@test -z "$$(git -C "$(DSH_ROOT)" status --porcelain)" || (echo "DSH checkout 有未提交改动；请先清理或使用独立 checkout" >&2; exit 2)
	@set -e; for patch in "$(PATCH_ROOT)"/*.patch; do git -C "$(DSH_ROOT)" apply --check "$$patch"; done

patch-apply: patch-check
	@set -e; for patch in "$(PATCH_ROOT)"/*.patch; do git -C "$(DSH_ROOT)" apply "$$patch"; done

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
	cd "$(DSH_ROOT)" && DSH_HOME="$${DSH_HOME:-}" pnpm dsh --profile "$(DSH_PROFILE)" --host "$(DSH_HOST)" --no-open --port "$(DSH_WEB_PORT)"

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
