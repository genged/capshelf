// Web UI assets embedded into the compiled binary.
//
// This is a committed stub (empty in source). `bun run embed-web` rewrites it
// from web/dist before `bun build --compile` so the single `capshelf` binary
// serves the UI with no external files; the Makefile restores this stub after
// compiling. When empty, `serve` falls back to reading web/dist from disk
// (the dev path).
export const WEB_ASSETS: Record<string, { type: string; base64: string }> = {};
