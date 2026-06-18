---
name: extract-generic-repo-patterns
description: Extract reusable, cross-project agent guidance from a repository, implementation area, or existing project-specific guides. Use when asked to review a codebase/docs and identify, propose, or write generic agent guides; convert repo-specific implementation patterns into portable instructions; separate reusable infrastructure patterns from app-specific choices; or create docs that help future agents build similar systems correctly in other projects.
---

# Extract Generic Repo Patterns

Use this skill to turn a working repo into generic agent guidance. The output
should teach another agent the reusable operating pattern without copying the
product, identifiers, business rules, or stale dependency details.

## Workflow

1. Clarify the requested output.
   - If the user asks to "propose", return guide ideas only.
   - If the user asks to "write" or "create", add or update the requested skill
     or guide.
   - If no destination is specified for a skill, prefer the repo's existing
     skills directory when obvious; otherwise use the configured Codex skills
     location.

2. Inventory existing guidance and implementation.
   - Read `docs/agent-guides/` first if present.
   - Find nearby implementation files with `rg --files`, then inspect package
     scripts, config files, tests, migrations, plugins, modules, CI, and docs.
   - Prefer real code paths over plan docs when they disagree.
   - Treat current uncommitted user changes as user-owned; do not rewrite them
     unless the task requires it.

3. Extract the pattern from multiple layers.
   - Architecture: apps, packages, shared contracts, storage, external systems.
   - Boundary contracts: schemas, API clients, frozen versions, generated types.
   - Environment/config: env files, validation, public vs secret values,
     secret-manager references, runtime channels.
   - Data and persistence: migrations, bootstrap data, object/file storage,
     transaction rules, reset behavior.
   - Provider integrations: SDK wrappers, usage tracking, retry/error
     normalization, model/config registries.
   - Platform/runtime: native modules, entitlements, signing, simulator vs
     production behavior, deployment/build phases.
   - Testing/CI: lanes, mocks, migration checks, generated output checks,
     release and compatibility tests.
   - Manual setup: account dashboards, app-store/provider consoles, DNS,
     credentials, policies, privacy/compliance answers.

4. Separate reusable from app-specific.
   - Reusable: phase splits, folder shapes, wrappers, validation layers,
     scripts, config-plugin shapes, test strategies, CI gates, docs structure.
   - App-specific: product copy, domain schemas, table names, bundle IDs,
     provider project names, prompts, categories, credentials, assets, prices,
     business rules, and policy answers.
   - Use placeholders for app-specific values, not the reviewed app's values.

5. Check current primary docs for unstable domains.
   - Search official docs for frameworks, provider SDKs, store rules, security
     standards, privacy/compliance, cloud deploy, and model APIs.
   - Cite sources when the output makes claims that can change over time.
   - Use the repo to identify patterns; use current docs to avoid fossilized
     commands, SDK names, rules, or provider capabilities.

6. Write the guide or skill.
   - Start with a short "use this when" paragraph that says the guide is a
     pattern guide, not a copy checklist.
   - Include a small target-shape diagram when it makes the system legible.
   - Give implementation order before low-level details.
   - Add environment, external-account, and manual setup steps, not only code.
   - Include verification commands or a definition of done.
   - End with "Reusable Between Apps/Projects" and "App-Specific: Do Not Copy
     Blindly" sections when the artifact is a guide.

## Guide Template

Use this structure for new generic agent guides unless the domain clearly needs
something different:

~~~markdown
# <Domain> Agent Guide

Use this when ... This is a pattern guide, not a copy checklist.

## Current Docs To Check First

- Official source 1
- Official source 2

## Target Shape

```text
<simple architecture or phase diagram>
```

## Reviewed Pattern

- Reusable observation from the repo.
- Reusable observation from scripts/tests/config.

## Implementation Order

1. Define contracts/config.
2. Add infrastructure.
3. Implement domain logic.
4. Add tests and CI.
5. Add release/deploy/manual setup.

## Environment And External Setup

- Env values and validation.
- Secret boundaries.
- Provider/account/store/dashboard tasks.

## Testing And Verification

- Unit/integration/UI/native/release checks as relevant.

## Reusable Between Projects

- Copyable structures and workflows.

## App-Specific: Do Not Copy Blindly

- Values and decisions that must change per project.

## Definition Of Done

- Observable completion criteria.
~~~

## Quality Bar

- Make the guide generic enough to apply to another project without dragging
  along the source repo's domain.
- Preserve important real identifiers only in "reviewed pattern" context; use
  placeholders in instructions.
- Do not omit non-code setup. Many repeatable patterns depend on dashboards,
  signing, credentials, account capabilities, deploy order, or manual review.
- Prefer complete implementation guidance over a high-level checklist.
- Do not create a landing page or marketing-style doc; write an operational
  guide an agent can execute.
- Avoid stale specificity. If a version, API, model, store rule, or deployment
  command is not stable, tell the agent to check the current official docs.
- Keep the artifact compact. Move deep examples into references only if the
  skill/guide becomes too large.
