# capshelf — TypeScript Quality Review

_Scope: `src/` (~8,500 LOC) — a Bun-compiled CLI using `commander`, `zod`,
`smol-toml`. Reviewed against current idiomatic-TypeScript guidance._

## Executive summary

A better-than-average TypeScript codebase: a strict `tsconfig.json`
(`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`), zero `as any`, zero `@ts-ignore`, one
`as unknown`, and correct Zod usage including a textbook
`z.discriminatedUnion("source", …)` in `src/lock.ts`.

The problems were not in the type annotations but in the **process around** the
types and in **architecture**. Findings sorted by severity below; C1 and C2 are
now implemented.

---

## 🔴 Critical

### C1. Type safety was never enforced — ✅ done

`bun test`/`bun build` strip types without checking them, and nothing ran `tsc`
or a linter, so the strict config was aspirational.

**Implemented** (commit `chore: add typecheck and Biome`): added
`"typecheck": "tsc --noEmit"`, Biome (`biome.json`, `lint`/`lint:fix`/`format`
scripts), and CI jobs (a Biome `lint` job via `biomejs/setup-biome`, plus a
`typecheck` step). Biome was chosen for lint+format, **paired with `tsc`** for
type-checking — Biome v2's type-aware rules are not a type-checker and do not
catch type errors or Zod-schema/`type` drift.

> Biome's `style/noNonNullAssertion` is disabled in `biome.json` on purpose:
> `tsconfig` enables `noUncheckedIndexedAccess`, which types every indexed
> access (regex capture groups, `parts[0]` after a length check, etc.) as
> `T | undefined`, so the codebase's non-null assertions are the deliberate
> "already proven present" markers that pairs with. Flagging each one is noise
> without a safety gain; reducing them via helpers stays as optional L4 cleanup.

### C2. `process.exit()` / `console.error()` embedded in domain logic — ✅ done

84 `process.exit` and the error-path `console.error` calls were scattered
through commands and helpers, so a `: void` validator could secretly terminate
the process — untestable without spawning a subprocess.

**Implemented** (imperative shell / functional core):

- **`src/errors.ts`** — `ExitCode` contract + a `CliError` hierarchy
  (`NotFoundError` → 2, `PreconditionError` → 3, `CheckFailedError` → 4,
  `ResultExitError` → silent code-only) and the existing `GitUnavailableError`
  (7) / `UpstreamVerificationError` (4) folded in. Only `CliError` accepts an
  `exitCode`; subclasses bake theirs in.
- **`src/cli.ts`** — one boundary: `main(argv): Promise<number>` parses and runs,
  `reportError` maps `instanceof CliError` → `✗ <message>` (+ indented hint) and
  returns its code; the lone `process.exit` is the `import.meta.main` entry line,
  which also lets command modules import `cli.ts` without triggering a parse.
- **All commands + `local-config.ts`** — every `console.error(...); process.exit(N)`
  became `throw new <Error>(...)`. Messages are byte-for-byte (the boundary
  re-adds `✗ `); exit codes unchanged. Result-signaling exits (`apply`/`update`
  "some failed" → 1, `status --strict` → 4, promote drift → 4) use
  `ResultExitError`/`CheckFailedError` after the command prints its own report.

Net: exactly **one** real `process.exit` in the codebase (the boundary). The
only remaining `console.error` is an intentional `⚠` deprecation warning.
Verified: `tsc --noEmit`, `biome ci`, **120/120 tests**, and all smoke suites
pass; live exit codes (2/3/4/7) and stderr confirmed byte-for-byte.

**Follow-ups unlocked:** an `IO` seam for stdout (Phase 2) and converting the
`Bun.spawnSync` exit-code tests in `cli.test.ts` to in-process calls of `main()`
/ `expect(() => fn()).toThrow(PreconditionError)`. A lint guard forbidding
`process.exit`/error `console.error` outside `cli.ts` would keep the boundary
from eroding.

---

## 🟠 High (open)

### H1. God-files mixing concerns — `promote.ts` (~1,035 LOC), `status.ts` (~611)
Both interleave IO, git, formatting, and domain logic. With C2 done, extracting
pure analysis from side effects is now much easier.

### H2. Silent error-swallowing degrades results to empty
`status.ts` / `promote.ts` use `.catch(() => null)` / `.catch(() => [])`, making
real failures indistinguishable from "nothing found." Catch only the expected
condition (e.g. `ENOENT`) and rethrow the rest.

### H3. Type assertions at config trust boundaries
`paths.ts`, `manifest.ts`, `external.ts`, `cli.ts` `JSON.parse(...) as T` /
`opts() as GlobalOptions`. Define Zod schemas and `.parse()` them, mirroring
`lock.ts`.

---

## 🟡 Medium (open)

- **M1.** `StatusRow` / `MaterializeResult` model state with optional flags
  instead of discriminated unions + exhaustive `switch` (`assertNever`).
- **M2.** `isItemKind` casts before it validates — assert on the array, not the
  value under test.
- **M3.** Duplicated helpers (`lstatOrNull`, clone helpers) and hand-rolled
  ENOENT checks — extract a shared `fs`/`errors` util with a typed `isErrno`.
- **M4.** String-union switches in `fragments.ts` lack `default: assertNever(x)`.

## 🟢 Low (open)

- **L1.** No `type` vs `interface` convention.
- **L2.** Inconsistent `readonly`.
- **L3.** `types.d.ts` is only the `*.md` shim (fine; add a why-comment).
- **L4.** Reduce non-null assertions via small helpers (see C1 note).

---

## Suggested next order of work

1. ~~C1 — typecheck + Biome in CI~~ ✅
2. ~~C2 — `CliError` boundary, remove process exits~~ ✅
3. H3 — Zod-validate config/external boundaries.
4. H1 — split `promote.ts` / `status.ts` pure-vs-IO (now unblocked by C2).
5. M1/M4 — discriminated-union state + exhaustiveness.
6. M2/M3/L* — cleanup.
