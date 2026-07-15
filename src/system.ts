export interface Viewport {
  width: number;
  height: number;
}

export interface ComponentContext {
  element: HTMLElement;
  viewport: Readonly<Viewport>;
  prefersReducedMotion: boolean;
  system: ComponentSystem;
  ac: AbortController;
  find: <T extends Element>(selector: string) => T | null;
  findAll: <T extends Element>(selector: string) => T[];
  ref: <T extends Element>(name: string) => T | null;
  log: (msg: string, ...args: unknown[]) => void;
}

export type CleanupFn = () => void;

export interface ComponentDefinition {
  deps?: string[];
  init(ctx: ComponentContext): void | CleanupFn | Promise<void | CleanupFn>;
}

type EventMap = {
  resize: { viewport: Viewport };
  motionchange: { prefersReducedMotion: boolean };
};

type SystemEvent = keyof EventMap;
type AnyEventCallback = (payload: EventMap[SystemEvent]) => void;

interface Instance {
  name: string;
  element: HTMLElement;
  ac: AbortController;
  cleanup: CleanupFn | undefined;
}

export class ComponentSystem {
  private definitions = new Map<string, ComponentDefinition>();
  private instances: Instance[] = [];
  private viewport: Viewport;
  private prefersReducedMotion: boolean;
  private subscribers = new Map<string, Set<AnyEventCallback>>();
  private scanning = false;
  private _scanTriggered = false;

  private _resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private _mediaQuery: MediaQueryList;

  private readonly _onResize: () => void;
  private readonly _onMotionChange: (e: MediaQueryListEvent) => void;
  private readonly _onPageLoad: () => void;
  private readonly _onBeforeUnload: () => void;
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
      if (this.scanning) return;
      this.destroy();
      void this.scan();
    };

    this._onBeforeUnload = () => {
      this.destroy();
    };

    // Fallback initial scan for sites without <ClientRouter />.
    // If astro:page-load already fired (or fires synchronously during this same
    // load event via ClientRouter), _scanTriggered will be true and we skip.
    this._onLoad = () => {
      if (!this._scanTriggered) void this.scan();
    };

    window.addEventListener('resize', this._onResize);
    mq.addEventListener('change', this._onMotionChange);
    document.addEventListener('astro:page-load', this._onPageLoad);
    window.addEventListener('beforeunload', this._onBeforeUnload);
    window.addEventListener('load', this._onLoad, { once: true });
  }

  register(name: string, def: ComponentDefinition): void {
    this.definitions.set(name, def);
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this._scanTriggered = true;
    this.scanning = true;

    try {
      const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-component]'));

      const known = elements.filter(el => {
        const name = el.getAttribute('data-component');
        return name !== null && this.definitions.has(name);
      });

      if (known.length === 0) return;

      const namesPresent = new Set(
        known.map(el => el.getAttribute('data-component') as string),
      );

      const waves = this._computeWaves(namesPresent);

      for (const wave of waves) {
        await Promise.all(
          wave.flatMap(name => {
            const def = this.definitions.get(name)!;
            return known
              .filter(el => el.getAttribute('data-component') === name)
              .map(el => this._initInstance(name, el, def));
          }),
        );
      }
    } finally {
      this.scanning = false;
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
      const def = this.definitions.get(name)!;
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

  private async _initInstance(
    name: string,
    element: HTMLElement,
    def: ComponentDefinition,
  ): Promise<void> {
    const ac = new AbortController();
    const instance: Instance = { name, element, ac, cleanup: undefined };
    this.instances.push(instance);

    const ctx: ComponentContext = {
      element,
      viewport: this.viewport,
      prefersReducedMotion: this.prefersReducedMotion,
      system: this,
      ac,
      find: <T extends Element>(selector: string) => element.querySelector<T>(selector),
      findAll: <T extends Element>(selector: string) =>
        Array.from(element.querySelectorAll<T>(selector)),
      ref: <T extends Element>(refName: string) =>
        element.querySelector<T>(`[data-ref="${refName}"]`),
      log: (import.meta as { env?: { DEV?: boolean } }).env?.DEV
        ? (msg: string, ...args: unknown[]) =>
            console.log(`[${name}] ${msg}`, ...args, element)
        : () => {},
    };

    try {
      const result = await def.init(ctx);
      if (typeof result === 'function') {
        // If destroy() ran while init was awaiting, call cleanup immediately
        // rather than storing it on an already-destroyed instance.
        if (ac.signal.aborted) {
          result();
        } else {
          instance.cleanup = result;
        }
      }
    } catch (err) {
      console.warn(`[ComponentSystem] '${name}' init failed on`, element);
      console.warn(err);
    }
  }

  destroy(): void {
    for (const instance of this.instances) {
      instance.ac.abort();
      instance.cleanup?.();
    }
    this.instances = [];
  }

  dispose(): void {
    this.destroy();
    this.subscribers.clear();
    window.removeEventListener('resize', this._onResize);
    this._mediaQuery.removeEventListener('change', this._onMotionChange);
    document.removeEventListener('astro:page-load', this._onPageLoad);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
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
      cb(payload);
    }
  }
}
