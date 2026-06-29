# capshelf web

The web UI for `capshelf serve` — a React + Vite single-page app that renders
the read-only API the server exposes (`/api/status`, `/api/catalog`,
`/api/health`). Theme: **Patina** (warm graphite neutrals, verdigris/teal
accent, OKLCH); color is reserved for drift status, monospace for SHAs/paths.

## Develop

```sh
# terminal 1 — API (from repo root)
bun run serve            # capshelf serve on :4717

# terminal 2 — Vite dev server with HMR, proxies /api to :4717
bun run web:dev          # http://localhost:5181
```

## Build

```sh
bun run web:build        # emits web/dist/
bun run serve            # serves web/dist + the API on :4717
```

`web/dist` is gitignored; run the build once after cloning (or before shipping
a binary that embeds it).

## Layout

- `src/api.ts` — typed client + presentation helpers (state → bucket/label).
- `src/components/` — `Shell` (sidebar + topbar), `Overview`, `ItemScreen`
  (master-detail + diff drawer), `Shelf`, `Bundles`, shared `bits`.
- `src/styles.css` — Patina tokens (light + dark) and all component styles.
