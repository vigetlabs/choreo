export interface Viewport {
  width: number;
  height: number;
}

export interface GlobalContext {
  viewport: Readonly<Viewport>;
  prefersReducedMotion: boolean;
  system: Choreo;
  ac: AbortController;
  log: (msg: string, ...args: unknown[]) => void;
}

// Extends rather than ComponentContext + Omit: a new shared field is then a
// deliberate choice of which interface carries it, and the two can't drift.
export interface ComponentContext extends GlobalContext {
  element: HTMLElement;
  find: <T extends Element>(selector: string) => T | null;
  findAll: <T extends Element>(selector: string) => T[];
  ref: <T extends Element>(name: string) => T | null;
  refAll: <T extends Element>(name: string) => T[];
}

export type CleanupFn = () => void;

export interface ComponentDefinition {
  deps?: string[];
  init(ctx: ComponentContext): void | CleanupFn | Promise<void | CleanupFn>;
}

export interface GlobalDefinition {
  deps?: string[];
  init(ctx: GlobalContext): void | CleanupFn | Promise<void | CleanupFn>;
}

// One registry keyed by name — the wave loop and _computeWaves both look a name
// up, and the discriminant narrows `def` at the call site that inits it.
type Registration =
  | { kind: 'component'; def: ComponentDefinition }
  | { kind: 'global'; def: GlobalDefinition };

type EventMap = {
  resize: { viewport: Viewport };
  motionchange: { prefersReducedMotion: boolean };
};

type SystemEvent = keyof EventMap;
type AnyEventCallback = (payload: EventMap[SystemEvent]) => void;

// `element` is null for globals, which have no DOM node.
interface Instance {
  name: string;
  element: HTMLElement | null;
  ac: AbortController;
  cleanup: CleanupFn | undefined;
}

// Every descendant [data-ref="refName"] of root, in document order — backs both
// ref and refAll. Compares attribute values instead of interpolating refName
// into a selector, which throws or silently matches the wrong element.
function collectRefs<T extends Element>(root: HTMLElement, refName: string): T[] {
  const found: T[] = [];
  for (const el of root.querySelectorAll<T>('[data-ref]')) {
    if (el.getAttribute('data-ref') === refName) found.push(el);
  }
  return found;
}

// Flags a data-ref on the component's own root, which refs never match.
// Callers gate this on import.meta.env.DEV so it drops out of production.
function warnRootRef(name: string, element: HTMLElement, refName: string, helper: string): void {
  if (element.getAttribute('data-ref') !== refName) return;
  console.warn(
    `[${name}] ${helper}('${refName}') skips the component element, which carries ` +
      `data-ref="${refName}" — refs match descendants only. Use \`element\` for the root.`,
    element,
  );
}

// Names the failing unit, with the element when there is one.
function warnFailure(instance: Instance, stage: string, err: unknown): void {
  if (instance.element) {
    console.warn(`[choreo] '${instance.name}' ${stage} failed on`, instance.element);
  } else {
    console.warn(`[choreo] global '${instance.name}' ${stage} failed`);
  }
  console.warn(err);
}

export class Choreo {
  private definitions = new Map<string, Registration>();
  private instances: Instance[] = [];
  private active = new Set<HTMLElement>();
  private activeGlobals = new Set<string>();
  private viewport: Viewport;
  private prefersReducedMotion: boolean;
  private subscribers = new Map<string, Set<AnyEventCallback>>();
  private scanning = false;
  private _scanTriggered = false;
  private _rescanRequested = false;

  private _resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private _mediaQuery: MediaQueryList;

  private readonly _onResize: () => void;
  private readonly _onMotionChange: (e: MediaQueryListEvent) => void;
  private readonly _onPageLoad: () => void;
  private readonly _onPageHide: (e: PageTransitionEvent) => void;
  private readonly _onLoad: () => void;

  constructor() {
    this.viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._mediaQuery = mq;
    this.prefersReducedMotion = mq.matches;

    this._onResize = () => {
      if (this._resizeTimer !== null) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        this.viewport.width = window.innerWidth;
        this.viewport.height = window.innerHeight;
        this._emit('resize', { viewport: this.viewport });
      }, 250);
    };

    this._onMotionChange = (e: MediaQueryListEvent) => {
      this.prefersReducedMotion = e.matches;
      this._emit('motionchange', { prefersReducedMotion: this.prefersReducedMotion });
    };

    this._onPageLoad = () => {
      // A navigation while a scan is running must not be dropped — queue a
      // re-scan so the new page's components still initialize.
      if (this.scanning) {
        this._rescanRequested = true;
        return;
      }
      this.destroy();
      this.scan().catch(err => console.error('[choreo] scan failed', err));
    };

    // pagehide (not beforeunload): beforeunload also fires on navigations the
    // user cancels, and blocks the back/forward cache in some browsers. When
    // the page is persisted into the bfcache, instances are left intact so the
    // page resumes working on restore.
    this._onPageHide = (e: PageTransitionEvent) => {
      if (!e.persisted) this.destroy();
    };

    // Fallback initial scan for sites without <ClientRouter />.
    // If astro:page-load already fired (or fires synchronously during this same
    // load event via ClientRouter), _scanTriggered will be true and we skip.
    this._onLoad = () => {
      if (!this._scanTriggered) {
        this.scan().catch(err => console.error('[choreo] scan failed', err));
      }
    };

    window.addEventListener('resize', this._onResize);
    mq.addEventListener('change', this._onMotionChange);
    document.addEventListener('astro:page-load', this._onPageLoad);
    window.addEventListener('pagehide', this._onPageHide);

    if (document.readyState === 'complete') {
      // Module loaded after the load event (e.g. dynamic import) — the load
      // listener would never fire, so schedule the fallback scan directly.
      queueMicrotask(this._onLoad);
    } else {
      window.addEventListener('load', this._onLoad, { once: true });
    }
  }

  register(name: string, def: ComponentDefinition): void {
    this.definitions.set(name, { kind: 'component', def });
  }

  registerGlobal(name: string, def: GlobalDefinition): void {
    this.definitions.set(name, { kind: 'global', def });
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this._scanTriggered = true;
    this.scanning = true;

    try {
      const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-component]'));

      const known = elements.filter(el => {
        if (this.active.has(el)) return false;
        const name = el.getAttribute('data-component');
        return name !== null && this.definitions.get(name)?.kind === 'component';
      });

      // A global's registration is its presence — there is no element to find.
      // Live ones are excluded so a repeat scan never builds a second.
      const namesPresent = new Set<string>();
      for (const [name, reg] of this.definitions) {
        if (reg.kind === 'global' && !this.activeGlobals.has(name)) namesPresent.add(name);
      }
      for (const el of known) {
        namesPresent.add(el.getAttribute('data-component') as string);
      }

      if (namesPresent.size > 0) {
        const waves = this._computeWaves(namesPresent);

        for (const wave of waves) {
          await Promise.all(
            wave.flatMap(name => {
              const reg = this.definitions.get(name)!;
              if (reg.kind === 'global') return [this._initGlobal(name, reg.def)];
              return known
                .filter(el => el.getAttribute('data-component') === name)
                .map(el => this._initInstance(name, el, reg.def));
            }),
          );
        }
      }
    } finally {
      this.scanning = false;
    }

    if (this._rescanRequested) {
      this._rescanRequested = false;
      this.destroy();
      return this.scan();
    }
  }

  private _computeWaves(namesPresent: Set<string>): string[][] {
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const name of namesPresent) {
      inDegree.set(name, 0);
      dependents.set(name, []);
    }

    for (const name of namesPresent) {
      const { def } = this.definitions.get(name)!;
      const deps = (def.deps ?? []).filter(d => namesPresent.has(d));
      for (const dep of deps) {
        inDegree.set(name, inDegree.get(name)! + 1);
        dependents.get(dep)!.push(name);
      }
    }

    const waves: string[][] = [];
    let queue = Array.from(namesPresent).filter(n => inDegree.get(n) === 0);
    let processed = 0;

    while (queue.length > 0) {
      waves.push([...queue]);
      processed += queue.length;
      const next: string[] = [];
      for (const name of queue) {
        for (const dependent of dependents.get(name)!) {
          const deg = inDegree.get(dependent)! - 1;
          inDegree.set(dependent, deg);
          if (deg === 0) next.push(dependent);
        }
      }
      queue = next;
    }

    if (processed < namesPresent.size) {
      const cyclic = Array.from(namesPresent).filter(n => inDegree.get(n)! > 0);
      throw new Error(`Circular dependency detected among: ${cyclic.join(', ')}`);
    }

    return waves;
  }

  private _initInstance(
    name: string,
    element: HTMLElement,
    def: ComponentDefinition,
  ): Promise<void> {
    const ac = new AbortController();
    const instance: Instance = { name, element, ac, cleanup: undefined };
    this.instances.push(instance);
    this.active.add(element);

    const ctx: ComponentContext = {
      element,
      viewport: this.viewport,
      prefersReducedMotion: this.prefersReducedMotion,
      system: this,
      ac,
      find: <T extends Element>(selector: string) => element.querySelector<T>(selector),
      findAll: <T extends Element>(selector: string) =>
        Array.from(element.querySelectorAll<T>(selector)),
      // `[0]` types as T (noUncheckedIndexedAccess is off) but is undefined at
      // runtime on an empty array.
      ref: <T extends Element>(refName: string): T | null => {
        if (import.meta.env.DEV) warnRootRef(name, element, refName, 'ref');
        return collectRefs<T>(element, refName)[0] ?? null;
      },
      refAll: <T extends Element>(refName: string) => {
        if (import.meta.env.DEV) warnRootRef(name, element, refName, 'refAll');
        return collectRefs<T>(element, refName);
      },
      log: import.meta.env.DEV
        ? (msg: string, ...args: unknown[]) =>
            console.log(`[${name}] ${msg}`, ...args, element)
        : () => {},
    };

    return this._runInit(instance, () => def.init(ctx));
  }

  private _initGlobal(name: string, def: GlobalDefinition): Promise<void> {
    const ac = new AbortController();
    const instance: Instance = { name, element: null, ac, cleanup: undefined };
    this.instances.push(instance);
    // Marked before the first await so a re-entrant scan can't build a second.
    this.activeGlobals.add(name);

    const ctx: GlobalContext = {
      viewport: this.viewport,
      prefersReducedMotion: this.prefersReducedMotion,
      system: this,
      ac,
      log: import.meta.env.DEV
        ? (msg: string, ...args: unknown[]) => console.log(`[${name}] ${msg}`, ...args)
        : () => {},
    };

    return this._runInit(instance, () => def.init(ctx));
  }

  // Takes a thunk, not a promise: a synchronous throw from init has to land in
  // the same catch as a rejection.
  private async _runInit(
    instance: Instance,
    run: () => void | CleanupFn | Promise<void | CleanupFn>,
  ): Promise<void> {
    try {
      const result = await run();
      if (typeof result === 'function') {
        // If destroy() ran while init was awaiting, call cleanup immediately
        // rather than storing it on an already-destroyed instance.
        if (instance.ac.signal.aborted) {
          result();
        } else {
          instance.cleanup = result;
        }
      }
    } catch (err) {
      warnFailure(instance, 'init', err);
    }
  }

  destroy(): void {
    for (const instance of this.instances) {
      instance.ac.abort();
      try {
        instance.cleanup?.();
      } catch (err) {
        warnFailure(instance, 'cleanup', err);
      }
    }
    this.instances = [];
    this.active.clear();
    this.activeGlobals.clear();
  }

  dispose(): void {
    this.destroy();
    this.subscribers.clear();
    window.removeEventListener('resize', this._onResize);
    this._mediaQuery.removeEventListener('change', this._onMotionChange);
    document.removeEventListener('astro:page-load', this._onPageLoad);
    window.removeEventListener('pagehide', this._onPageHide);
    window.removeEventListener('load', this._onLoad);
    if (this._resizeTimer !== null) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
  }

  on<E extends SystemEvent>(
    event: E,
    callback: (payload: EventMap[E]) => void,
    options?: { signal?: AbortSignal },
  ): void {
    // Match DOM addEventListener semantics: an already-aborted signal means
    // the listener is never added.
    if (options?.signal?.aborted) return;

    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, new Set());
    }
    this.subscribers.get(event)!.add(callback as AnyEventCallback);

    options?.signal?.addEventListener(
      'abort',
      () => this.off(event, callback),
      { once: true },
    );
  }

  off<E extends SystemEvent>(
    event: E,
    callback: (payload: EventMap[E]) => void,
  ): void {
    this.subscribers.get(event)?.delete(callback as AnyEventCallback);
  }

  private _emit<E extends SystemEvent>(event: E, payload: EventMap[E]): void {
    const subs = this.subscribers.get(event);
    if (!subs) return;
    for (const cb of [...subs]) {
      try {
        cb(payload);
      } catch (err) {
        console.warn(`[choreo] '${event}' subscriber threw`, err);
      }
    }
  }
}
