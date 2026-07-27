<div align="center">

![Choreo](.github/assets/choreo-static.png 'Choreo')

**Choreo** is a minimal, library-agnostic, component choreography layer for [Astro](https://astro.build) projects, focused on motion and interactive components.

</div>

---

- **Automatic DOM detection** via `data-component` attributes
- **Dependency-ordered initialization** using Kahn's topological sort (BFS)
- **Async readiness signaling** — Component signal their "ready" state
- **Global event coordination** — Coordinates commonly tracked events: resize, prefers-reduced-motion, view transitions, unload
- **Multiple instances** — every matching element gets its own isolated instance
- **Single-file Astro component editing** — designed for single-file components in `.astro` with `<script>` tags
- **Resilient error handling** — components fail without crashing the system
- **Zero dependencies, no build step** — raw TypeScript source that your own project's Vite compiles

## Installation

```sh
npm install @viget/choreo
```

Intended for use in any Vite-based site; Astro's `<ClientRouter />` view transitions are supported out of the box, with a `window` `load` fallback for plain MPA sites.

## Quick start

```html
---
// src/components/Accordion.astro
---
<!-- data-component marks component root -->
<div data-component="accordion">
  <!-- data-ref marks a child element for easy retrieval later -->
  <button data-ref="trigger">Open</button>
  <div data-ref="panel">...</div>
</div>

<script>
  import { defineComponent } from '@viget/choreo';

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

This shows a simple example of setting up a component and invoking Choreo.

1. Each component is identified with a `data-component` and a unique name
2. (Optional) Child elements that will be needed later are marked with `data-ref` and a unique name, accessed via the `ref()` helper later.
3. The co-located `<script>` tag imports Choreo and uses the wrapping `defineComponent()` function and the name of the component to attach to (ex. `accordion`).
4. Runtime logic lives in the `init()` function, which receives commonly needed info from Choreo (see Component Context).

Script duduping is currently handled by default in Astro. The script runs once, and isolated instances are created for every matching component during the scan.

## API

### `defineComponent(name, definition)`

The main wrapper function. Registers a component definition with the shared Choreo singleton.

The component definition expects two shapes:

1. `deps` (Default of `[]`) An array of other components that are dependencies. Choreo will ensure everything in this array initialize first. Dependencies that are absent from the DOM will silently fail (no blocking).
2. `init()` The runtime of the component, that receives commonly used information from Choreo (see Component Context)

```typescript
import { defineComponent } from '@viget/choreo';

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
| `element` | `HTMLElement` | The DOM element bound to this instance (identified by `data-component`) |
| `viewport` | `Readonly<Viewport>` | Live reference — always current `{ width, height }` |
| `prefersReducedMotion` | `boolean` | Value at time of init |
| `system` | `Choreo` | System reference for `on`/`off` event subscription |
| `ac` | `AbortController` | System-managed controller — aborted on destroy |
| `find` | `<T extends Element>(selector: string) => T \| null` | `querySelector` scoped to `element` |
| `findAll` | `<T extends Element>(selector: string) => T[]` | `querySelectorAll` scoped to `element`, returns an array |
| `ref` | `<T extends Element>(name: string) => T \| null` | Finds `[data-ref="name"]` within `element` |
| `log` | `(msg: string, ...args: unknown[]) => void` | Dev-only logger prefixed with the component name |

### `system.on(event, callback, options?)` / `system.off(event, callback)`

Opt-in subscription to global system events:

| Event | Callback payload |
|-------|-----------------|
| `'resize'` | `{ viewport: Viewport }` (debounced 250ms — fires once resizing settles) |
| `'motionchange'` | `{ prefersReducedMotion: boolean }` |

When an `AbortSignal` is passed, the listener is removed automatically on abort — one `AbortController` can clean up DOM and system listeners together. An already-aborted signal means the listener is never added, matching DOM `addEventListener` semantics. A subscriber that throws is logged and skipped; it never blocks other subscribers.

```typescript
system.on('resize', ({ viewport }) => { /* ... */ }, { signal: ac.signal });
```

### Cleanup lifecycle

On destroy (page navigation, unload):

1. The instance's `ac.abort()` fires — removes all listeners registered with `ac.signal`
2. The cleanup function returned from `init()` runs (if any)

Components that route all listeners through `ac.signal` need no return value. A cleanup function that throws is logged and skipped — it never blocks other instances' cleanup.

## Dependency ordering

Components declare `deps: string[]`. Initialization runs in waves:

```
Wave 0: ['footer', 'nav']   // no deps
Wave 1: ['hero']            // deps: ['nav']
Wave 2: ['carousel']        // deps: ['hero']
```

Waves run sequentially; instances within a wave initialize concurrently. A failed `init()` logs a warning but still unblocks its dependents. Circular dependencies throw: `"Circular dependency detected among: hero, carousel"`.

## Global events (auto-wired)

| Event | Behavior |
|-------|----------|
| `window resize` | Debounced 250ms → updates `viewport`, emits `'resize'` |
| `prefers-reduced-motion` change | Updates state, emits `'motionchange'` |
| `astro:page-load` | Destroys all instances, re-scans the DOM (a navigation that lands mid-scan queues a re-scan rather than being dropped) |
| `window load` | Fallback initial scan for sites without `<ClientRouter />`; if the module loads after the `load` event (e.g. via dynamic import), the scan is scheduled immediately |
| `window pagehide` | Destroys all instances on real unloads. When the page enters the back/forward cache (`persisted: true`), instances are left intact so the restored page keeps working |

## Debugging

In development the singleton is exposed as `window.__choreo` (stripped from production builds):

```js
__choreo.instances   // active instances
__choreo.viewport    // current viewport
__choreo.scanning    // scan in progress?
__choreo.scan()      // scan for newly added [data-component] elements
```

Elements that already have a live instance are skipped by `scan()`, so calling it manually only picks up elements added to the DOM since the last scan — it never double-initializes.

The `log` context helper prefixes output with the component name, and is a no-op in production:

```
[hero] init { width: 1440, height: 900 }
```

## Development

```sh
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

Tests live alongside the source in `src/*.test.ts` and are excluded from the published package.

## AI

AI (Claude Code) was used as an assistant to accelerate feature development, streamline QA, and to help catch errors before they ship. Read more about [how we use AI at Viget](https://www.viget.com/ai).

Lightweight provisions have been made for code assistants for future feature development:

| File | Purpose |
|-------|----------|
| `CLAUDE.md` | Automatically read by Claude, points to context and sets boundaries |
| `CONTEXT.md` | Living reference for AI agents to supply commands, architecture, and reasoning for future sessions |
