# Astro Choreo

Minimal, library-agnostic component orchestration for [Astro](https://astro.build) projects, focused on animation. Choreo handles DOM detection, dependency-ordered initialization, global event coordination, and cleanup — so component authors focus only on animation logic.

- **Automatic DOM detection** via `data-component` attributes
- **Dependency-ordered initialization** using Kahn's topological sort (BFS)
- **Async readiness signaling** — a component is "ready" when its `init()` resolves
- **Global event coordination** — resize, prefers-reduced-motion, view transitions, unload
- **Multiple instances** — every matching element gets its own isolated instance
- **Single-file Astro component editing** — define components in `.astro` `<script>` tags
- **Resilient error handling** — a failed `init()` logs a warning, never crashes the system
- **Zero dependencies, no build step** — ships raw TypeScript source that your project's Vite compiles

## Installation

```sh
npm install @viget/astro-choreo
```

Or straight from GitHub without the npm registry:

```sh
npm install viget/astro-choreo
```

The package ships `.ts` source (per [Astro's component-package convention](https://docs.astro.build/en/reference/publish-to-npm/)) and is compiled by your project's Vite — dev-only debugging code is stripped from production builds automatically. It works in any Vite-based site; Astro's `<ClientRouter />` view transitions are supported out of the box, with a `window` `load` fallback for plain MPA sites.

## Quick start

```html
---
// src/components/Accordion.astro
---
<div data-component="accordion">
  <button data-ref="trigger">Open</button>
  <div data-ref="panel">...</div>
</div>

<script>
  import { defineComponent } from '@viget/astro-choreo';

  defineComponent('accordion', {
    init({ element, ref, ac }) {
      const trigger = ref<HTMLButtonElement>('trigger');
      const panel   = ref<HTMLElement>('panel');

      trigger?.addEventListener('click', () => {
        panel?.classList.toggle('open');
      }, { signal: ac.signal }); // removed automatically on destroy
    },
  });
</script>
```

One component name per element. If `Accordion.astro` is rendered 50 times, Astro deduplicates the script — `defineComponent` runs once, and 50 isolated instances are created during the scan.

## Data Attribute Convention

- `data-component="name"` marks an element as a component root. The name is matched against registered definitions; unknown names are silently skipped.
- `data-ref="name"` names structural child elements, accessed via the `ref()` context helper.

## API

### `defineComponent(name, definition)`

Registers a component definition with the shared system singleton. Safe to import anywhere (including SSR) — it only does work in the browser.

```typescript
import { defineComponent } from '@viget/astro-choreo';

defineComponent('hero', {
  deps: ['nav'],  // optional — wait for 'nav' instances to finish init
  init({ find, findAll, ref, ac, system, viewport, prefersReducedMotion, log }) {
    const title   = ref<HTMLElement>('title');
    const buttons = findAll<HTMLButtonElement>('.btn');

    log('init', { viewport, prefersReducedMotion });

    // system.on and DOM listeners share the same AbortController
    system.on('resize', ({ viewport }) => {
      log('resize', viewport);
    }, { signal: ac.signal });

    buttons.forEach(btn =>
      btn.addEventListener('click', handleClick, { signal: ac.signal })
    );

    function handleClick() { /* ... */ }

    // ac.abort() is called automatically on destroy — return a function only
    // for non-listener cleanup (e.g. resetting animation state)
  }
});
```

### Component context

Each `init()` call receives:

| Property | Type | Description |
|----------|------|-------------|
| `element` | `HTMLElement` | The DOM element bound to this instance |
| `viewport` | `Readonly<Viewport>` | Live reference — always current `{ width, height }` |
| `prefersReducedMotion` | `boolean` | Value at time of init |
| `system` | `ComponentSystem` | System reference for `on`/`off` event subscription |
| `ac` | `AbortController` | System-managed controller — aborted on destroy |
| `find` | `<T extends Element>(selector: string) => T \| null` | `querySelector` scoped to `element` |
| `findAll` | `<T extends Element>(selector: string) => T[]` | `querySelectorAll` scoped to `element`, returns an array |
| `ref` | `<T extends Element>(name: string) => T \| null` | Finds `[data-ref="name"]` within `element` |
| `log` | `(msg: string, ...args: unknown[]) => void` | Dev-only logger prefixed with the component name |

### Definition shape

```typescript
interface ComponentDefinition {
  deps?: string[];
  init(ctx: ComponentContext): void | CleanupFn | Promise<void | CleanupFn>;
}

type CleanupFn = () => void;
```

`deps` defaults to `[]`. A dep that is registered but absent from the current DOM is silently ignored — no blocking.

### `system.on(event, callback, options?)` / `system.off(event, callback)`

Opt-in subscription to global system events:

| Event | Callback payload |
|-------|-----------------|
| `'resize'` | `{ viewport: Viewport }` (throttled 250ms) |
| `'motionchange'` | `{ prefersReducedMotion: boolean }` |

When an `AbortSignal` is passed, the listener is removed automatically on abort — one `AbortController` can clean up DOM and system listeners together:

```typescript
system.on('resize', ({ viewport }) => { /* ... */ }, { signal: ac.signal });
```

### Cleanup lifecycle

On destroy (page navigation, unload):

1. The instance's `ac.abort()` fires — removes all listeners registered with `ac.signal`
2. The cleanup function returned from `init()` runs (if any)

Components that route all listeners through `ac.signal` need no return value.

## Dependency ordering

Components declare `deps: string[]`. Initialization runs in waves computed with Kahn's topological sort:

```
Wave 0: ['footer', 'nav']   // no deps
Wave 1: ['hero']            // deps: ['nav']
Wave 2: ['carousel']        // deps: ['hero']
```

Waves run sequentially; instances within a wave initialize concurrently. A failed `init()` logs a warning but still unblocks its dependents. Circular dependencies throw: `"Circular dependency detected among: hero, carousel"`.

## Global events (auto-wired)

| Event | Behavior |
|-------|----------|
| `window resize` | Throttled 250ms → updates `viewport`, emits `'resize'` |
| `prefers-reduced-motion` change | Updates state, emits `'motionchange'` |
| `astro:page-load` | Destroys all instances, re-scans the DOM |
| `window load` | Fallback initial scan for sites without `<ClientRouter />` |
| `window beforeunload` | Destroys all instances |

## Debugging

In development the singleton is exposed as `window.__componentSystem` (stripped from production builds):

```js
__componentSystem.instances   // active instances
__componentSystem.viewport    // current viewport
__componentSystem.scanning    // scan in progress?
__componentSystem.scan()      // manually re-scan
```

The `log` context helper prefixes output with the component name and element, and is a no-op in production:

```
[hero] init { width: 1440, height: 900 }  <div data-component="hero">
```

## Development

```sh
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

Tests live alongside the source in `src/*.test.ts` and are excluded from the published package.
