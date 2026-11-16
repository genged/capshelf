BIN_DIR ?= $(HOME)/.local/bin

SMOKE_JOBS ?= 4
SMOKE_TARGETS := smoke-modes smoke-skills smoke-settings smoke-mcp smoke-codex-config smoke-bootstrap smoke-metadata smoke-needs smoke-team-sync smoke-bundles smoke-pi-extensions smoke-subagents smoke-marketplace smoke-pins smoke-remote smoke-plugins smoke-older-binary smoke-ui

.PHONY: install dev build test typecheck lint check check-release-docs check-doc-citations smoke e2e $(SMOKE_TARGETS) clean deps

deps:
	bun install

build: deps
	bun run build

# Rename instead of overwrite: macOS caches the code-signature verdict per inode
# and kills a binary overwritten in place.
install: build
	mkdir -p $(BIN_DIR)
	cp dist/capshelf $(BIN_DIR)/capshelf.new
	chmod +x $(BIN_DIR)/capshelf.new
	mv -f $(BIN_DIR)/capshelf.new $(BIN_DIR)/capshelf
	@echo "✓ installed → $(BIN_DIR)/capshelf"
	@echo "  ensure $(BIN_DIR) is on your PATH"

test-all: test smoke

test:
	bun run test

typecheck: deps
	bun run typecheck

lint:
	bun run lint

check: typecheck lint check-release-docs check-doc-citations test smoke e2e

e2e: deps
	@bun run e2e

check-release-docs:
	@./scripts/check-release-docs-frozen.sh

check-doc-citations:
	@./scripts/check-doc-citations.sh

dev:
	bun run src/cli.ts

smoke:
	@$(MAKE) --no-print-directory -j$(SMOKE_JOBS) $(SMOKE_TARGETS)

smoke-modes: deps
	@./scripts/smoke-modes.sh

smoke-skills: deps
	@./scripts/smoke-skills.sh

smoke-settings: deps
	@./scripts/smoke-settings.sh

smoke-mcp: deps
	@./scripts/smoke-mcp.sh

smoke-codex-config: deps
	@./scripts/smoke-codex-config.sh

smoke-bootstrap: deps
	@./scripts/smoke-bootstrap.sh

smoke-metadata: deps
	@./scripts/smoke-metadata.sh

smoke-needs: deps
	@./scripts/smoke-needs.sh

smoke-team-sync: deps
	@./scripts/smoke-team-sync.sh

smoke-bundles: deps
	@./scripts/smoke-bundles.sh

smoke-pi-extensions: deps
	@./scripts/smoke-pi-extensions.sh

smoke-subagents: deps
	@./scripts/smoke-subagents.sh

smoke-pins: deps
	@./scripts/smoke-pins.sh

smoke-marketplace: deps
	@./scripts/smoke-marketplace.sh

smoke-remote: deps
	@./scripts/smoke-remote.sh

smoke-plugins: deps
	@./scripts/smoke-plugins.sh

smoke-older-binary: deps
	@./scripts/smoke-older-binary.sh

smoke-ui: deps
	@./scripts/smoke-ui.sh

clean:
	rm -rf dist node_modules bun.lockb
