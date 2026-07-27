# CONTEXT — Choreo

> Living reference for AI sessions and future development. **Update this file whenever
> the system, decisions, or workflows change.** Last updated: 2026-07-16.

## What this is

**Choreo** (`@viget/choreo`) is a minimal, zero-dependency component orchestration
library for Astro/Vite sites, focused on animation. It detects `data-component`
elements in the DOM, initializes them in dependency order (Kahn's topological sort,
concurrent within waves), coordinates global events (resize, reduced-motion,
view transitions, unload), and handles cleanup.

Formerly "Astro Choreo" / `@viget/astro-choreo` — renamed 2026-07-16. `SPEC.md` and
`PACKAGE.md` are **historical documents** using the old names; do not update them.
`README.md` is the authoritative user-facing doc.

## Files

| Path | Purpose |
|------|---------|
| `src/choreo.ts` | `Choreo` class — the entire runtime (~330 lines). All types exported here. |
| `src/index.ts` | Package entry: lazy singleton, `defineComponent()`, re-exports. SSR-safe (no-op without `window`). |
| `src/env.d.ts` | Minimal `import.meta.env` typing (avoids a vite/client dependency). |
| `src/choreo.test.ts` | Full system test suite (happy-dom). |
| `src/index.test.ts` / `src/index.ssr.test.ts` | Singleton behavior; SSR no-op (node environment). |
| `README.md` | User-facing docs — keep in sync with behavior changes. |

## Commands

```sh
npm test            # vitest run (61 tests, happy-dom)
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
- **`ref()` compares attribute values directly** (no selector interpolation) — immune
  to CSS-significant characters and happy-dom parser limits.
- **`system.on()` with an already-aborted signal never subscribes** — matches DOM
  `addEventListener` semantics.
- **Resize is a trailing debounce (250ms)**, not a throttle — docs say "debounced".
- **Naming**: user-visible branding is Choreo (`window.__choreo`, `[choreo]` prefixes,
  class `Choreo`). Method and context-property names were deliberately kept from the
  original system (`defineComponent`, `scan`, `destroy`, `dispose`, `on/off`, ctx:
  `element/viewport/prefersReducedMotion/system/ac/find/findAll/ref/log`).

## Testing gotchas (happy-dom)

- `document.readyState` reports `'complete'` — tests pin it to `'loading'` in
  `beforeEach` so the constructor's late-load auto-scan doesn't fire; the complete-path
  has its own dedicated test.
- `matchMedia` must be stubbed (see `beforeEach` in test files).
- `PageTransitionEvent` constructor ignores `persisted` — tests stamp the flag onto a
  plain `Event` via `Object.defineProperty` (see `pagehideEvent` helper).
- Selector parser rejects escaped characters in attribute selectors (why `ref()`
  avoids selector interpolation).
- Tests create fresh `new Choreo()` instances and `dispose()` in `afterEach` to avoid
  ghost global listeners. `dispose()` is test-only full teardown; `destroy()` is the
  runtime instance-cleanup used between page loads.

## Publishing status & cross-repo state

- **Not yet published; no GitHub remote.** Planned home: `github.com/viget/choreo`.
  Publishing or creating the remote requires explicit approval. `publishConfig.access:
  public` is set (scoped packages default private). Installs also work from a GitHub
  URL (`npm i viget/choreo`) since there's no build step.
- **Consumer**: the original demo repo consumes this as a `file:` dep under the OLD
  name `@viget/astro-choreo` — its package.json dep and all component imports need
  updating to `@viget/choreo`. Local folder here is still `~/repo/astro-choreo`.
- Version `0.1.0`, MIT (LICENSE file present, © Viget Labs, LLC).

## Open questions / possible future work

- True throttle option for resize (current debounce emits nothing during a
  continuous drag until it settles).
- `find`/`findAll`/`ref` don't stop at nested `data-component` boundaries — a parent
  can grab a child component's refs. Accepted convention for now; document if it bites.
- Rename local directory `~/repo/astro-choreo` → `~/repo/choreo` when creating remote.
