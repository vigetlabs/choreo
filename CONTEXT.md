# CONTEXT — Choreo

> Concise, living reference for AI sessions and future development. **Update
> this file whenever the system, decisions, or workflows change.** Last
> updated: 2026-08-17.

## What this is

**Choreo** (`@viget/choreo`) is a minimal, zero-dependency component orchestration
library for Astro/Vite sites, focused on animation. It detects `data-component`
elements in the DOM, initializes them in dependency order (Kahn's topological sort,
concurrent within waves), coordinates global events (resize, reduced-motion,
view transitions, unload), and handles cleanup.

## Files

| Path | Purpose |
|------|---------|
| `src/choreo.ts` | `Choreo` class — the entire runtime (~360 lines). All types exported here. |
| `src/index.ts` | Package entry: lazy singleton, `defineComponent()`, re-exports. SSR-safe (no-op without `window`). |
| `src/env.d.ts` | Minimal `import.meta.env` typing (avoids a vite/client dependency). |
| `src/choreo.test.ts` | Full system test suite (happy-dom). |
| `src/index.test.ts` / `src/index.ssr.test.ts` | Singleton behavior; SSR no-op (node environment). |
| `README.md` | User-facing docs — keep in sync with behavior changes. |
| `.github/workflows/release.yml` | Tag-triggered staged npm release (see Releasing). |
| `.github/workflows/check-workflows.yml` | zizmor lint of the workflows themselves. |
| `.tool-versions` | asdf pin: `nodejs 26.5.1`. Also read by CI via `node-version-file`. |

## Commands

```sh
npm test            # vitest run (75 tests, happy-dom)
npm run typecheck   # tsc --noEmit (strict)
npm pack --dry-run  # verify publish payload: LICENSE, README, package.json,
                    # src/choreo.ts, src/env.d.ts, src/index.ts — tests excluded
```

## Key design decisions (and why)

- **Raw `.ts` source, no build step** (Astro component-package convention). Consumer's
  Vite compiles it. This preserves (1) static replacement of `import.meta.env.DEV` so
  dev-only code (`window.__choreo`, `log`) tree-shakes out of production, and (2) ES
  module caching so the singleton is shared across all component `<script>`s.
  Consequence: always use the **literal** `import.meta.env.DEV` — no defensive casts,
  Vite only statically replaces the exact form.
- **No `sideEffects: false`** in package.json — importing the entry registers global
  listeners by design.
- **No deps/peerDeps** — `astro:page-load` is used via listener with a `window load`
  fallback (plus a `readyState === 'complete'` check for post-load dynamic imports),
  so it runs in any Vite site; a hard Astro peer dep would be false.
- **Lazy singleton + `typeof window` guard** in `defineComponent` — package can be
  imported for types in SSR/frontmatter without crashing.
- **`pagehide` (not `beforeunload`)** for unload cleanup — `beforeunload` fires on
  canceled navigations and blocks bfcache. Persisted pages (`e.persisted`) keep
  instances alive for restore.
- **Mid-scan `astro:page-load` queues a re-scan** (`_rescanRequested`) instead of
  dropping the navigation. Direct concurrent `scan()` calls are still ignored.
- **`scan()` skips elements with live instances** (`active` Set) — manual re-scan
  only picks up new DOM, never double-initializes.
- **Error isolation everywhere**: failing `init()`, cleanup fns, and event subscribers
  are caught + `console.warn`'d with a `[choreo]` prefix; dependents still unblock.
  Event-handler-triggered scans catch rejections (`[choreo] scan failed`).
- **`ref`/`refAll` never interpolate the name into a selector** — the rest of the ref
  implementation follows from this. `[data-ref="${name}"]` fails two ways under happy-dom:
  `we"ird]name` throws, and `a"], [data-ref="ok` builds a valid *selector list* that
  silently returns the element named `ok`. Escaping doesn't rescue it — happy-dom rejects
  escaped attribute selectors, so that variant is untestable here. `getAttribute(...) ===
  name` has no grammar, so any string is a valid ref name. `find`/`findAll` pass selectors
  through because there the parameter *is* the query; `ref(name)` takes a value, and
  splicing a value into a grammar is the bug parameterized queries exist to prevent.
- **`ref`/`refAll` share one collector** (`collectRefs`; `ref` is
  `collectRefs(...)[0] ?? null`) — the lookup must be a loop, and one loop beats two
  copies of the comparison rule. Cost: `ref` has no early return; a `first` flag would
  restore it but only saves the comparison tail, since `querySelectorAll` materializes a
  static NodeList regardless. `ref` needs an explicit `T | null` annotation —
  `noUncheckedIndexedAccess` is off, so `[0]` types as `T` but is `undefined` at runtime.
- **All four helpers are descendant-only** — one scoping rule; `element` is the way to the
  root. Self-inclusive refs shipped and were reverted (2026-08-17): no capability gained,
  at the cost of an asymmetry with `find`/`findAll`, a `root as unknown as T` cast, a
  "root first" ordering clause, and a container silently joining its own children in
  `refAll('item')`.
- **`warnRootRef` (dev-only)** replaces it — a root `data-ref` failing *silently* was the
  real complaint, and a warning fixes that without a semantic exception while teaching
  `element`. Fires whenever the root carries the requested name, including when
  descendants matched; call-site gated on literal `import.meta.env.DEV`.
- **`system.on()` with an already-aborted signal never subscribes** — matches DOM
  `addEventListener` semantics.
- **Resize is a trailing debounce (250ms)**, not a throttle — docs say "debounced".
- **Naming**: user-visible branding is Choreo (`window.__choreo`, `[choreo]` prefixes,
  class `Choreo`). Method and context-property names were deliberately kept from the
  original system (`defineComponent`, `scan`, `destroy`, `dispose`, `on/off`, ctx:
  `element/viewport/prefersReducedMotion/system/ac/find/findAll/ref/log`). `refAll`
  (2026-08-17) extends that vocabulary rather than adding a second pluralization rule.

## Testing gotchas (happy-dom)

- `document.readyState` reports `'complete'` — tests pin it to `'loading'` in
  `beforeEach` so the constructor's late-load auto-scan doesn't fire; the complete-path
  has its own dedicated test.
- `matchMedia` must be stubbed (see `beforeEach` in test files).
- `PageTransitionEvent` constructor ignores `persisted` — tests stamp the flag onto a
  plain `Event` via `Object.defineProperty` (see `pagehideEvent` helper).
- Selector parser rejects escaped characters in attribute selectors, so an escaped
  `[data-ref="…"]` query is untestable here (see ref interpolation, above).
- Tests create fresh `new Choreo()` instances and `dispose()` in `afterEach` to avoid
  ghost global listeners. `dispose()` is test-only full teardown; `destroy()` is the
  runtime instance-cleanup used between page loads.

## Publishing status & cross-repo state

- **Published: `@viget/choreo@0.1.0`** (2026-07-27), `latest`, maintainer
  `viget <fed@viget.com>`. `publishConfig.access: public` is set (scoped packages
  default private). Installs also work from a GitHub URL since there's no build step.
- Version `0.1.1` in `package.json`, MIT (LICENSE file present, © Viget Labs, LLC).
  0.1.1 is **not yet on the registry** — its first staging attempt failed (see below).
- **`repository.url` must match the building repo exactly.** Provenance embeds
  `GITHUB_REPOSITORY`; if `package.json` disagrees npm rejects the stage with
  `E422 ... Failed to validate repository information`. This bit v0.1.1 (`viget/choreo`
  vs `vigetlabs/choreo`) *after* the tarball was signed and logged to sigstore.
  Deliberately **not** guarded in CI — the registry check is authoritative, names both
  values, and fires before anything is staged; a local copy would only duplicate it.

## Releasing

`.github/workflows/release.yml` fires on a `v*` tag push and **stages** a release —
it does not publish. Flow: checkout → Node (from `.tool-versions`) → `npm i -g npm@^12`
→ `npm ci` → tag/version guard → typecheck → test → `npm pack --dry-run` →
`npm stage publish`. The staged id is written to the job summary.

**Verified working 2026-07-31**: OIDC trusted publishing authenticates `npm stage
publish`, and provenance is signed and written to the sigstore transparency log
automatically — no `--provenance` flag needed.

Nothing is installable until a maintainer approves with 2FA:

```sh
npm stage list
npm stage view <id>      # inspect the tarball before approving
npm stage approve <id>   # publishes (requires 2FA)
npm stage reject <id>    # discards
```

Decisions behind it:

- **Staged publishing over `npm publish --provenance`.** A compromised CI run cannot
  ship a release on its own; a human 2FA approval gates every version. Provenance only
  makes tampering detectable after the fact.
- **Toolchain: Node 26.5.1 + npm 12.** `.tool-versions` is the single source for both
  local and CI (`node-version-file`). Node 26 is Current, not LTS until Oct 2026 —
  low-risk here since the toolchain never reaches consumers (no build step, no
  `engines` field). It bundles npm **11.17.0**, which has no `stage` command, so CI
  installs `npm@^12.0.2` explicitly; the pinned major stops a future npm 13 from
  shifting publish semantics silently. Local approval needs the same upgrade:
  `npm i -g npm@12 && asdf reshim nodejs`.
- **`npm ci` runs *after* that upgrade, on purpose.** npm 12 defaults `allowScripts`
  off and `--allow-git`/`--allow-remote` to `none`, so no transitive `postinstall` can
  execute in the job holding publishing rights. Audited 2026-07-31: no git or
  non-registry deps, and the only install script is `fsevents` (optional,
  `os: ["darwin"]`) — never installed on `ubuntu-latest`, and its macOS warning is
  ignorable (suite passes without it). A *new* dep needing scripts fails CI; audit
  before running `npm approve-scripts`.
- **OIDC trusted publishing** (`id-token: write`, no `NPM_TOKEN` secret). Requires a
  trusted publisher on npmjs.com for `@viget/choreo` pointing at **`vigetlabs/choreo`**
  + `release.yml` — **not yet configured.** Set its allowed action to `npm stage
  publish` **only** (not `npm publish`), so a compromised run cannot publish directly.
  `npm stage list/view/approve/reject` require interactive auth and cannot use OIDC —
  approval can never happen from CI, by design.
- **Actions pinned to full commit SHAs**, `persist-credentials: false`, top-level
  `permissions: {}`. No third-party actions in the job that holds publishing rights.
- **No build step to guard** — the tarball is just `src/` (see Key design decisions),
  so there's no build-then-publish gap for an attacker to slip into.
- **No dependency cache** (`package-manager-cache: false`). setup-node v7 auto-caches
  by default; a poisoned cache entry could reach the tarball, and restoring 85 packages
  from the registry costs seconds. Also clears zizmor's `cache-poisoning` finding.
- **One zizmor suppression**: `adhoc-packages` on the npm 12 install. That audit is
  only cleared by a lockfile install, and npm 12 must exist before `npm ci` runs. Its
  rationale (unpinned sub-dependencies) doesn't apply — npm ships all 68 of its deps
  as `bundleDependencies`, so the install is one integrity-checked tarball.
- Tag must equal `package.json` version (`v0.1.0` ↔ `0.1.0`); CI fails otherwise.

## Open questions / possible future work

- True throttle option for resize (current debounce emits nothing during a
  continuous drag until it settles).
- `find`/`findAll`/`ref`/`refAll` don't stop at nested `data-component` boundaries — a
  parent can grab a child component's refs. Accepted for consistency with `findAll` over
  an ancestor walk per candidate; `refAll` sharpens it (a too-long list fails more quietly
  than a single wrong element). Pinned by a test — changing it changes all four helpers.
