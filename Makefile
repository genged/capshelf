BIN_DIR ?= $(HOME)/.local/bin

.PHONY: install dev build test typecheck lint check smoke smoke-modes smoke-skills smoke-settings smoke-mcp smoke-codex-config smoke-bootstrap smoke-metadata smoke-team-sync smoke-bundles clean deps

deps:
	bun install

build: deps
	bun run build

install: build
	mkdir -p $(BIN_DIR)
	cp dist/capshelf $(BIN_DIR)/capshelf
	chmod +x $(BIN_DIR)/capshelf
	@echo "✓ installed → $(BIN_DIR)/capshelf"
	@echo "  ensure $(BIN_DIR) is on your PATH"

test:
	bun test

typecheck: deps
	bun run typecheck

lint:
	bun run lint

check: typecheck lint test smoke

dev:
	bun run src/cli.ts

smoke: smoke-modes smoke-skills smoke-settings smoke-mcp smoke-codex-config smoke-bootstrap smoke-metadata smoke-team-sync smoke-bundles

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

smoke-team-sync: deps
	@./scripts/smoke-team-sync.sh

smoke-bundles: deps
	@./scripts/smoke-bundles.sh

clean:
	rm -rf dist node_modules bun.lockb
