SHELL := /bin/bash

# AgentKit Studio only ships the plugin. DSH_ROOT points at the official
# DeepSeek Harness checkout and is never vendored into this repository.
# From agentengine/agentkit-studio this resolves to the sibling official DSH
# checkout under agent-sdk. Override it when the checkout lives elsewhere.
DSH_ROOT ?= $(abspath ../../deepseek-harness)
DSH_PROFILE ?= agentkit-studio
DSH_HOST ?= 127.0.0.1
DSH_WEB_PORT ?= 3098
# Keep the caller's package manager on PATH for existing Profile dependencies.
DSH_SOURCE_CLI := node --import tsx/esm apps/cli/src/bin.ts
PACK_DIR ?= .artifacts
DSH_VERSION ?= 0.2.0-rc.2
DSH_COMMIT ?= 639ed015397290b3745d163aafe02ffee4aa3f84
DSH_REPO ?= https://github.com/deepseek-ai/deepseek-harness.git
DSH_REF ?= dsh-v$(DSH_VERSION)
PATCH_ROOT ?= $(abspath patches/dsh-v$(DSH_VERSION))
STUDIO_DESKTOP_INPUT = $(abspath $(PACK_DIR)/desktop-plugin-input/$(PLUGIN_VERSION))
DESKTOP_PLUGIN_INPUTS ?= $(STUDIO_DESKTOP_INPUT)
DESKTOP_PLUGIN_ROOTS ?= @kingsoftcloud/agentkit-studio
DESKTOP_PLUGIN_BUNDLES ?= @kingsoftcloud/agentkit-studio
DESKTOP_PRODUCT_ICON ?= $(abspath assets/agentkit-studio-macos.png)
DESKTOP_PACKAGE = node scripts/package-desktop.mjs --source "$(DSH_ROOT)" --output "$(PACK_DIR)" --patches "$(PATCH_ROOT)" --commit "$(DSH_COMMIT)" --studio-version "$(PLUGIN_VERSION)" --dsh-version "$(DSH_VERSION)"
DESKTOP_ENV = DSH_CLIENT_TITLE='AgentKit Studio' DSH_DESKTOP_PRODUCT_ICON="$(DESKTOP_PRODUCT_ICON)" DSH_DESKTOP_PLUGIN_INPUTS="$(DESKTOP_PLUGIN_INPUTS)" DSH_DESKTOP_PLUGIN_ROOTS="$(DESKTOP_PLUGIN_ROOTS)" DSH_DESKTOP_PLUGIN_BUNDLES="$(DESKTOP_PLUGIN_BUNDLES)"
PLUGIN_VERSION := $(shell node -p "require('./package.json').version")
PLUGIN_TARBALL ?= $(abspath $(PACK_DIR)/kingsoftcloud-agentkit-studio-$(PLUGIN_VERSION).tgz)

.PHONY: check test pack release-check patch-format-check dsh-bootstrap profile-install profile-check patch-check patch-apply verify-dsh verify-dsh-sdk web-build web-dev web-start \
        desktop-build desktop-dev desktop-start desktop-package-mac-arm64 \
        desktop-package-mac-arm64-dir desktop-package-mac-x64 \
        desktop-package-mac-x64-dir desktop-package-preflight desktop-check-package desktop-package-mac-arm64-unsigned ci clean

check:
	pnpm check

test:
	pnpm test

pack:
	mkdir -p "$(PACK_DIR)"
	pnpm pack --pack-destination "$(PACK_DIR)"

release-check: check patch-format-check pack
	node scripts/check-package.mjs "$(PLUGIN_TARBALL)"
	git diff --check

# Build inputs are committed sources, never a copy of a running development checkout.
RUNTIME_SOURCES_DIR ?= $(PACK_DIR)/runtime-sources
.PHONY: runtime-source-stage
runtime-source-stage:
	node scripts/stage-runtime-sources.mjs --studio "$(CURDIR)" --source "$(DSH_ROOT)" \
		--output "$(RUNTIME_SOURCES_DIR)" --commit "$(DSH_COMMIT)" --dsh-version "$(DSH_VERSION)"

patch-format-check:
	node scripts/check-patch-format.mjs "$(PATCH_ROOT)"

# Fetch the public DSH source only when a collaborator does not already have a
# checkout. The source stays outside this repository; all later host targets
# still use the pinned commit and the versioned patches below.
dsh-bootstrap:
	@if test -e "$(DSH_ROOT)/.git"; then \
		echo "复用已有 DSH checkout：$(DSH_ROOT)"; \
	else \
		test ! -e "$(DSH_ROOT)" || (echo "DSH_ROOT 已存在但不是 Git checkout：$(DSH_ROOT)" >&2; exit 2); \
		mkdir -p "$$(dirname "$(DSH_ROOT)")"; \
		git clone --branch "$(DSH_REF)" --depth 1 "$(DSH_REPO)" "$(DSH_ROOT)"; \
	fi
	@test "$$(git -C "$(DSH_ROOT)" rev-parse HEAD)" = "$(DSH_COMMIT)" || (echo "DSH checkout 不是 $(DSH_VERSION) 基线 $(DSH_COMMIT)" >&2; exit 2)
	cd "$(DSH_ROOT)" && pnpm install --frozen-lockfile

# Install the packed plugin into a DSH profile. This is intentionally
# explicit: it mutates DSH_HOME and must not happen as a side effect of a
# read-only check or a normal package build.
profile-install: pack
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	@test -f "$(PLUGIN_TARBALL)" || (echo "插件包不存在：$(PLUGIN_TARBALL)" >&2; exit 2)
	@profile_dir="$${DSH_HOME:-$$HOME/.dsh}/profiles/$(DSH_PROFILE)"; \
	if test ! -f "$$profile_dir/package.json"; then \
		(cd "$(DSH_ROOT)" && $(DSH_SOURCE_CLI) --profile "$(DSH_PROFILE)" --from-default-profile web --dump-config >/dev/null); \
	fi
	# Keep file: references near the target Profile; long cross-directory refs overflow pnpm cache filenames.
	@digest="$$(shasum -a 256 "$(PLUGIN_TARBALL)" | cut -d ' ' -f 1)"; \
		profile_dir="$${DSH_HOME:-$$HOME/.dsh}/profiles/$(DSH_PROFILE)"; \
		profile_dir="$$(cd "$$profile_dir" && pwd -P)"; \
		input_dir="$$profile_dir/.studio-input/$$digest"; \
		mkdir -p "$$input_dir"; \
		cp "$(PLUGIN_TARBALL)" "$$input_dir/plugin.tgz"; \
		(cd "$(DSH_ROOT)" && $(DSH_SOURCE_CLI) plugin --profile "$(DSH_PROFILE)" add --force "file:$$input_dir/plugin.tgz")
	@profile_dir="$${DSH_HOME:-$$HOME/.dsh}/profiles/$(DSH_PROFILE)"; \
		node scripts/check-profile.mjs "$$profile_dir" "$(PLUGIN_VERSION)" "$(PLUGIN_TARBALL)"

# Verify a previously installed profile without mutating DSH_HOME. PROFILE_DIR
# can point at an unpacked release profile when checking a Desktop build.
profile-check:
	@profile_dir="$(PROFILE_DIR)"; \
		if test -z "$$profile_dir"; then profile_dir="$${DSH_HOME:-$$HOME/.dsh}/profiles/$(DSH_PROFILE)"; fi; \
		node scripts/check-profile.mjs "$$profile_dir" "$(PLUGIN_VERSION)"

# Patches are versioned host compatibility inputs, not runtime source. Check
# the exact DSH baseline and a clean checkout before applying any of them.
patch-check:
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	@test -d "$(PATCH_ROOT)" || (echo "补丁目录不存在：$(PATCH_ROOT)" >&2; exit 2)
	@test "$$(git -C "$(DSH_ROOT)" rev-parse HEAD)" = "$(DSH_COMMIT)" || (echo "DSH checkout 不是 $(DSH_VERSION) 基线 $(DSH_COMMIT)" >&2; exit 2)
	@test -z "$$(git -C "$(DSH_ROOT)" status --porcelain)" || (echo "DSH checkout 有未提交改动；请先清理或使用独立 checkout" >&2; exit 2)
	node scripts/check-dsh-patches.mjs "$(DSH_ROOT)" "$(PATCH_ROOT)"

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
	cd "$(DSH_ROOT)" && DSH_HOME="$${DSH_HOME:-}" $(DSH_SOURCE_CLI) --profile "$(DSH_PROFILE)" --host "$(DSH_HOST)" --no-open --port "$(DSH_WEB_PORT)"

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

desktop-package-preflight: pack
	@test -d "$(DSH_ROOT)" || (echo "DSH_ROOT 不存在：$(DSH_ROOT)" >&2; exit 2)
	@test -f "$(DSH_ROOT)/apps/desktop/scripts/prepare-package-set.ts" \
		&& grep -q "DSH_DESKTOP_PLUGIN_INPUTS" "$(DSH_ROOT)/apps/desktop/scripts/prepare-package-set.ts" \
		&& grep -q "DSH_DESKTOP_PLUGIN_BUNDLES" "$(DSH_ROOT)/apps/desktop/src/project-manager.ts" \
		|| (echo "DSH rc.2 desktop plugin package-set patch 未应用；先执行 make patch-apply DSH_ROOT=..." >&2; exit 2)
	@test -f "$(PLUGIN_TARBALL)" || (echo "插件包不存在：$(PLUGIN_TARBALL)" >&2; exit 2)
	@mkdir -p "$(STUDIO_DESKTOP_INPUT)"
	@cp "$(PLUGIN_TARBALL)" "$(STUDIO_DESKTOP_INPUT)/kingsoftcloud-agentkit-studio-$(PLUGIN_VERSION).tgz"

desktop-package-mac-arm64: desktop-package-preflight
	@test "$$(uname -s)" = "Darwin" || (echo "macOS packaging must run on macOS" >&2; exit 2)
	$(DESKTOP_ENV) $(DESKTOP_PACKAGE) --target mac-arm64

# Local artifact uses the official runtime; no release feed or upload record.
desktop-package-mac-arm64-unsigned: desktop-package-preflight
	@test "$$(uname -s)" = "Darwin" || (echo "macOS packaging must run on macOS" >&2; exit 2)
	@rg -q 'invocation.unsigned && target.platform' "$(DSH_ROOT)/apps/desktop/scripts/package-target.ts" || (echo "DSH local macOS package patch 未应用；请应用 009-local-macos-package.patch" >&2; exit 2)
	$(DESKTOP_ENV) $(DESKTOP_PACKAGE) --target mac-arm64 --unsigned

desktop-package-mac-arm64-dir: desktop-package-preflight
	@test "$$(uname -s)" = "Darwin" || (echo "macOS packaging must run on macOS" >&2; exit 2)
	$(DESKTOP_ENV) $(DESKTOP_PACKAGE) --target mac-arm64 --directory

desktop-package-mac-x64: desktop-package-preflight
	@test "$$(uname -s)" = "Darwin" || (echo "macOS packaging must run on macOS" >&2; exit 2)
	$(DESKTOP_ENV) $(DESKTOP_PACKAGE) --target mac-x64

desktop-package-mac-x64-dir: desktop-package-preflight
	@test "$$(uname -s)" = "Darwin" || (echo "macOS packaging must run on macOS" >&2; exit 2)
	$(DESKTOP_ENV) $(DESKTOP_PACKAGE) --target mac-x64 --directory

desktop-check-package:
	@test "$$(uname -s)" = "Darwin" || (echo "macOS package checks must run on macOS" >&2; exit 2)
	cd "$(DSH_ROOT)" && pnpm --filter @deepseek-ai/dsh-desktop run check:package

# CI intentionally does not require cloud keys, Codex credentials or a DSH
# checkout. The real node-store probe is a separately enabled integration job.
ci: check pack

clean:
	@test -d "$(PACK_DIR)" && find "$(PACK_DIR)" -maxdepth 1 -type f -delete || true
