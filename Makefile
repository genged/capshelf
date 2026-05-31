BIN_DIR ?= $(HOME)/.local/bin

.PHONY: install dev build test check smoke smoke-modes smoke-skills smoke-settings smoke-mcp smoke-codex-config clean deps

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

check: test smoke

dev:
	bun run src/cli.ts

smoke: smoke-modes smoke-skills smoke-settings smoke-mcp smoke-codex-config

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

clean:
	rm -rf dist node_modules bun.lockb
