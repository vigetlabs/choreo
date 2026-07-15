import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentSystem, type CleanupFn } from './system';

// Helpers

function addComponent(name: string, parent: Element = document.body): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('data-component', name);
  parent.appendChild(el);
  return el;
}

function addRef(parent: Element, refName: string): HTMLElement {
  const el = document.createElement('span');
  el.setAttribute('data-ref', refName);
  parent.appendChild(el);
  return el;
}

// Fixtures

let sys: ComponentSystem;

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });

  sys = new ComponentSystem();
});

afterEach(() => {
  sys.dispose();
  document.body.innerHTML = '';
});

// Registration

describe('Registration', () => {
  it('stores a component definition and init is called on scan', async () => {
    const init = vi.fn();
    sys.register('foo', { init });
    addComponent('foo');
    await sys.scan();
    expect(init).toHaveBeenCalledOnce();
  });

  it('duplicate registration overwrites the previous definition', async () => {
    const init1 = vi.fn();
    const init2 = vi.fn();
    sys.register('foo', { init: init1 });
    sys.register('foo', { init: init2 });
    addComponent('foo');
    await sys.scan();
    expect(init2).toHaveBeenCalledOnce();
    expect(init1).not.toHaveBeenCalled();
  });
});

// DOM Scan

describe('DOM scan', () => {
  it('finds all [data-component] elements', async () => {
    const init = vi.fn();
    sys.register('card', { init });
    addComponent('card');
    addComponent('card');
    addComponent('card');
    await sys.scan();
    expect(init).toHaveBeenCalledTimes(3);
  });

  it('silently ignores unknown component names', async () => {
    addComponent('unknown-component');
    await expect(sys.scan()).resolves.not.toThrow();
  });
});

// Init Order

describe('Init order', () => {
  it('wave 0 inits before wave 1', async () => {
    const order: string[] = [];
    sys.register('nav', { init: () => { order.push('nav'); } });
    sys.register('hero', { deps: ['nav'], init: () => { order.push('hero'); } });
    addComponent('nav');
    addComponent('hero');
    await sys.scan();
    expect(order).toEqual(['nav', 'hero']);
  });

  it('async dep in wave 0 blocks wave 1 from starting', async () => {
    const order: string[] = [];
    let resolveNav!: () => void;

    sys.register('nav', {
      init: () =>
        new Promise<void>(resolve => {
          resolveNav = resolve;
        }).then(() => { order.push('nav'); }),
    });
    sys.register('hero', { deps: ['nav'], init: () => { order.push('hero'); } });

    addComponent('nav');
    addComponent('hero');

    const scanPromise = sys.scan();

    // hero should not have started yet
    expect(order).toEqual([]);

    resolveNav();
    await scanPromise;

    expect(order).toEqual(['nav', 'hero']);
  });
});

// Multi-instance

describe('Multi-instance', () => {
  it('initializes all 50 instances of the same component', async () => {
    const inits: Element[] = [];
    sys.register('card', { init: ctx => { inits.push(ctx.element); } });
    for (let i = 0; i < 50; i++) addComponent('card');
    await sys.scan();
    expect(inits).toHaveLength(50);
  });

  it('each instance receives its own AbortController', async () => {
    const acs: AbortController[] = [];
    sys.register('card', { init: ctx => { acs.push(ctx.ac); } });
    addComponent('card');
    addComponent('card');
    await sys.scan();
    expect(acs).toHaveLength(2);
    expect(acs[0]).not.toBe(acs[1]);
  });
});

// Circular dependency

describe('Circular dependency', () => {
  it('throws with the names of cyclic components', async () => {
    sys.register('a', { deps: ['b'], init: vi.fn() });
    sys.register('b', { deps: ['a'], init: vi.fn() });
    addComponent('a');
    addComponent('b');
    await expect(sys.scan()).rejects.toThrow('Circular dependency detected among:');
  });

  it('error message includes the cyclic component names', async () => {
    sys.register('hero', { deps: ['carousel'], init: vi.fn() });
    sys.register('carousel', { deps: ['hero'], init: vi.fn() });
    addComponent('hero');
    addComponent('carousel');
    await expect(sys.scan()).rejects.toThrow(/hero|carousel/);
  });
});

// Cleanup

describe('Cleanup', () => {
  it('ac.abort() fires before the cleanup function', async () => {
    const order: string[] = [];
    sys.register('foo', {
      init: ctx => {
        ctx.ac.signal.addEventListener('abort', () => order.push('abort'));
        return () => order.push('cleanup');
      },
    });
    addComponent('foo');
    await sys.scan();
    sys.destroy();
    expect(order).toEqual(['abort', 'cleanup']);
  });

  it('undefined return from init is safe — no errors on destroy', async () => {
    sys.register('foo', { init: () => undefined });
    addComponent('foo');
    await sys.scan();
    expect(() => sys.destroy()).not.toThrow();
  });

  it('cleanup fn from async init is called even when destroy fires during await', async () => {
    const cleanup = vi.fn();
    let resolveInit!: (fn: CleanupFn) => void;

    sys.register('slow', {
      init: () => new Promise<CleanupFn>(resolve => { resolveInit = resolve; }),
    });

    addComponent('slow');
    void sys.scan();       // start scan, do not await
    sys.destroy();         // destroy while init is still pending
    resolveInit(cleanup);  // init resolves with a cleanup fn after destroy
    await new Promise(r => setTimeout(r, 0));

    expect(cleanup).toHaveBeenCalledOnce();
  });
});

// Async readiness

describe('Async readiness', () => {
  it('dependent component waits for async dep init to resolve', async () => {
    const order: string[] = [];
    let resolveNav!: () => void;

    sys.register('nav', {
      init: () =>
        new Promise<void>(r => {
          resolveNav = r;
        }).then(() => { order.push('nav'); }),
    });
    sys.register('hero', { deps: ['nav'], init: () => { order.push('hero'); } });

    addComponent('nav');
    addComponent('hero');

    const p = sys.scan();
    resolveNav();
    await p;

    expect(order[0]).toBe('nav');
    expect(order[1]).toBe('hero');
  });
});

// Context values

describe('Context values', () => {
  it('provides correct element, viewport shape, prefersReducedMotion, ac, and helpers', async () => {
    let captured: Parameters<typeof vi.fn>[0] | null = null;

    sys.register('foo', {
      init: ctx => {
        captured = ctx as unknown as typeof captured;
      },
    });

    const el = addComponent('foo');
    await sys.scan();

    const ctx = captured as unknown as {
      element: Element;
      viewport: { width: number; height: number };
      prefersReducedMotion: boolean;
      ac: AbortController;
      find: unknown;
      findAll: unknown;
      ref: unknown;
      log: unknown;
      system: ComponentSystem;
    };

    expect(ctx.element).toBe(el);
    expect(ctx.viewport).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    expect(ctx.prefersReducedMotion).toBe(false); // matchMedia stub returns matches: false
    expect(ctx.ac).toBeInstanceOf(AbortController);
    expect(typeof ctx.find).toBe('function');
    expect(typeof ctx.findAll).toBe('function');
    expect(typeof ctx.ref).toBe('function');
    expect(typeof ctx.log).toBe('function');
    expect(ctx.system).toBe(sys);
  });
});

// Viewport update

describe('Viewport update', () => {
  it('viewport object is mutated in place after a resize event', async () => {
    vi.useFakeTimers();

    let capturedViewport!: { width: number; height: number };
    sys.register('foo', { init: ctx => { capturedViewport = ctx.viewport as typeof capturedViewport; } });
    addComponent('foo');
    await sys.scan();

    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);

    expect(capturedViewport.width).toBe(800);
    expect(capturedViewport.height).toBe(600);

    vi.useRealTimers();
  });
});

// Error resilience

describe('Error resilience', () => {
  it('throwing init logs a warning and does not crash the system', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sys.register('bad', { init: () => { throw new Error('boom'); } });
    addComponent('bad');
    await expect(sys.scan()).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('other components still init when one throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goodInit = vi.fn();
    sys.register('bad', { init: () => { throw new Error('boom'); } });
    sys.register('good', { init: goodInit });
    addComponent('bad');
    addComponent('good');
    await sys.scan();
    expect(goodInit).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('failed init still allows dependents to start (readyPromise resolves)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dependentInit = vi.fn();
    sys.register('nav', { init: () => { throw new Error('nav failed'); } });
    sys.register('hero', { deps: ['nav'], init: dependentInit });
    addComponent('nav');
    addComponent('hero');
    await sys.scan();
    expect(dependentInit).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

// Page load

describe('Page load', () => {
  it('astro:page-load destroys instances and re-scans', async () => {
    let initCount = 0;
    let resolveSecond!: () => void;
    const secondDone = new Promise<void>(r => { resolveSecond = r; });

    sys.register('foo', {
      init: () => {
        initCount++;
        if (initCount === 2) resolveSecond();
      },
    });

    addComponent('foo');
    await sys.scan();
    expect(initCount).toBe(1);

    document.dispatchEvent(new Event('astro:page-load'));
    await secondDone;
    expect(initCount).toBe(2);
  });

  it('destroy is called before re-scan — cleanup fn runs', async () => {
    const cleanupCalls: number[] = [];
    let resolveSecond!: () => void;
    const secondDone = new Promise<void>(r => { resolveSecond = r; });
    let callCount = 0;

    sys.register('foo', {
      init: () => {
        callCount++;
        if (callCount === 2) resolveSecond();
        return () => { cleanupCalls.push(1); };
      },
    });

    addComponent('foo');
    await sys.scan();

    document.dispatchEvent(new Event('astro:page-load'));
    await secondDone;
    expect(cleanupCalls).toHaveLength(1);
  });
});

// window load fallback

describe('window load fallback', () => {
  it('triggers initial scan when astro:page-load never fires', async () => {
    let resolveInit!: () => void;
    const initDone = new Promise<void>(r => { resolveInit = r; });

    sys.register('foo', {
      init: () => { resolveInit(); },
    });
    addComponent('foo');

    window.dispatchEvent(new Event('load'));
    await initDone;
  });

  it('is a no-op when scan is already in progress (astro:page-load fired first)', async () => {
    let initCount = 0;
    let resolveInit!: () => void;

    sys.register('slow', {
      init: () => {
        initCount++;
        return new Promise<void>(r => { resolveInit = r; });
      },
    });
    addComponent('slow');

    // Simulate ClientRouter: astro:page-load fires first (starts scan)
    document.dispatchEvent(new Event('astro:page-load'));

    // Then window load fires — should be a no-op because scanning=true
    window.dispatchEvent(new Event('load'));

    resolveInit();
    await new Promise(r => setTimeout(r, 0));

    expect(initCount).toBe(1);
  });
});

// Concurrent scan

describe('Concurrent scan', () => {
  it('second scan() call while one is in progress is ignored', async () => {
    let initCount = 0;
    let resolveInit!: () => void;

    sys.register('slow', {
      init: () => {
        initCount++;
        return new Promise<void>(r => { resolveInit = r; });
      },
    });
    addComponent('slow');

    const first = sys.scan();
    const second = sys.scan(); // should return immediately

    await second; // resolves right away
    expect(initCount).toBe(1); // only one init started

    resolveInit();
    await first;
    expect(initCount).toBe(1);
  });

  it('second astro:page-load mid-scan is ignored', async () => {
    let initCount = 0;
    let resolveInit!: () => void;

    sys.register('slow', {
      init: () => {
        initCount++;
        return new Promise<void>(r => { resolveInit = r; });
      },
    });
    addComponent('slow');

    const first = sys.scan();
    // Simulate second page-load while scanning
    document.dispatchEvent(new Event('astro:page-load'));

    expect(initCount).toBe(1);

    resolveInit();
    await first;
    expect(initCount).toBe(1);
  });
});

// Missing dep

describe('Missing dep', () => {
  it('component with dep absent from DOM inits without blocking', async () => {
    const init = vi.fn();
    sys.register('hero', { deps: ['nav'], init }); // nav not in DOM
    addComponent('hero');
    await sys.scan();
    expect(init).toHaveBeenCalledOnce();
  });
});

// system.on / off

describe('system.on / off', () => {
  it('resize callback fires on resize', async () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    sys.on('resize', cb);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ viewport: expect.any(Object) }));
    vi.useRealTimers();
  });

  it('off stops the callback from firing', async () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    sys.on('resize', cb);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);
    expect(cb).toHaveBeenCalledOnce();

    sys.off('resize', cb);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);
    expect(cb).toHaveBeenCalledOnce(); // still once
    vi.useRealTimers();
  });

  it('removing a subscriber during emit does not skip other subscribers', () => {
    vi.useFakeTimers();
    const cb1 = vi.fn();
    const cb3 = vi.fn();
    // cb2 removes cb3 from the subscriber set mid-emit
    const cb2 = vi.fn(() => sys.off('resize', cb3));

    sys.on('resize', cb1);
    sys.on('resize', cb2);
    sys.on('resize', cb3);

    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);

    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
    expect(cb3).toHaveBeenCalledOnce(); // snapshot ensures cb3 still fires this cycle
    vi.useRealTimers();
  });
});

// AbortController signal

describe('AbortController', () => {
  it('signal passed to system.on auto-removes the listener on abort', () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const cb = vi.fn();

    sys.on('resize', cb, { signal: ac.signal });
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);
    expect(cb).toHaveBeenCalledOnce();

    ac.abort();
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);
    expect(cb).toHaveBeenCalledOnce(); // not called again

    vi.useRealTimers();
  });
});

// Mixed cleanup

describe('Mixed cleanup', () => {
  it('one ac.abort() removes both DOM and system listeners', async () => {
    vi.useFakeTimers();

    const clickCb = vi.fn();
    const resizeCb = vi.fn();
    let capturedEl!: Element;

    sys.register('foo', {
      init: ctx => {
        capturedEl = ctx.element;
        ctx.element.addEventListener('click', clickCb, { signal: ctx.ac.signal });
        ctx.system.on('resize', resizeCb, { signal: ctx.ac.signal });
      },
    });

    addComponent('foo');
    await sys.scan();

    capturedEl.dispatchEvent(new Event('click'));
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);
    expect(clickCb).toHaveBeenCalledOnce();
    expect(resizeCb).toHaveBeenCalledOnce();

    sys.destroy(); // aborts all instance ACs

    capturedEl.dispatchEvent(new Event('click'));
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);
    expect(clickCb).toHaveBeenCalledOnce(); // not again
    expect(resizeCb).toHaveBeenCalledOnce(); // not again

    vi.useRealTimers();
  });
});

// find / findAll

describe('find / findAll', () => {
  it('find is scoped to the component element', async () => {
    let capturedFind!: (s: string) => Element | null;
    sys.register('foo', { init: ctx => { capturedFind = ctx.find; } });

    const wrapper = addComponent('foo');
    const inner = document.createElement('span');
    inner.className = 'target';
    wrapper.appendChild(inner);

    // Same class outside the component
    const outer = document.createElement('span');
    outer.className = 'target';
    document.body.appendChild(outer);

    await sys.scan();

    expect(capturedFind('.target')).toBe(inner);
    expect(capturedFind('.target')).not.toBe(outer);
  });

  it('findAll returns only elements within the component element', async () => {
    let capturedFindAll!: (s: string) => Element[];
    sys.register('foo', { init: ctx => { capturedFindAll = ctx.findAll; } });

    const wrapper = addComponent('foo');
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('span');
      el.className = 'item';
      wrapper.appendChild(el);
    }
    const outer = document.createElement('span');
    outer.className = 'item';
    document.body.appendChild(outer);

    await sys.scan();

    expect(capturedFindAll('.item')).toHaveLength(3);
  });

  it('find returns null when no match', async () => {
    let capturedFind!: (s: string) => Element | null;
    sys.register('foo', { init: ctx => { capturedFind = ctx.find; } });
    addComponent('foo');
    await sys.scan();
    expect(capturedFind('.nope')).toBeNull();
  });

  it('findAll returns an array (not NodeList)', async () => {
    let capturedFindAll!: (s: string) => Element[];
    sys.register('foo', { init: ctx => { capturedFindAll = ctx.findAll; } });
    addComponent('foo');
    await sys.scan();
    expect(Array.isArray(capturedFindAll('.nope'))).toBe(true);
  });
});

// ref

describe('ref', () => {
  it('finds [data-ref] element within the component', async () => {
    let capturedRef!: (name: string) => Element | null;
    sys.register('foo', { init: ctx => { capturedRef = ctx.ref; } });

    const wrapper = addComponent('foo');
    const trigger = addRef(wrapper, 'trigger');

    await sys.scan();

    expect(capturedRef('trigger')).toBe(trigger);
  });

  it('returns null for a ref that does not exist', async () => {
    let capturedRef!: (name: string) => Element | null;
    sys.register('foo', { init: ctx => { capturedRef = ctx.ref; } });
    addComponent('foo');
    await sys.scan();
    expect(capturedRef('ghost')).toBeNull();
  });

  it('is scoped to the component element, not the whole document', async () => {
    let capturedRef!: (name: string) => Element | null;
    sys.register('foo', { init: ctx => { capturedRef = ctx.ref; } });

    addComponent('foo');
    // Add same ref name outside the component
    const outsideRef = document.createElement('div');
    outsideRef.setAttribute('data-ref', 'panel');
    document.body.appendChild(outsideRef);

    await sys.scan();

    expect(capturedRef('panel')).toBeNull(); // not found inside component
  });
});

// log

describe('log', () => {
  it('calls console.log with [name] prefix in dev mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    sys.register('hero', {
      init: ctx => { ctx.log('init', { x: 1 }); },
    });
    addComponent('hero');
    await sys.scan();

    expect(logSpy).toHaveBeenCalledWith('[hero] init', { x: 1 }, expect.any(Element));
    logSpy.mockRestore();
  });

  it('calling log does not throw', async () => {
    sys.register('foo', { init: ctx => { ctx.log('msg'); } });
    addComponent('foo');
    await expect(sys.scan()).resolves.not.toThrow();
  });
});

// dispose()

describe('dispose()', () => {
  it('removes global resize listener — no ghost handlers', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    sys.on('resize', cb);

    sys.dispose();

    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(300);

    expect(cb).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('removes astro:page-load listener — no scan after dispose', async () => {
    const init = vi.fn();
    sys.register('foo', { init });
    addComponent('foo');

    sys.dispose();

    document.dispatchEvent(new Event('astro:page-load'));
    await new Promise(r => setTimeout(r, 10));

    expect(init).not.toHaveBeenCalled();
  });

  it('removes window load listener — no scan after dispose', async () => {
    const init = vi.fn();
    sys.register('foo', { init });
    addComponent('foo');

    sys.dispose();

    window.dispatchEvent(new Event('load'));
    await new Promise(r => setTimeout(r, 10));

    expect(init).not.toHaveBeenCalled();
  });

  it('calls destroy() on dispose — instance cleanup runs', async () => {
    const cleanup = vi.fn();
    sys.register('foo', { init: () => cleanup });
    addComponent('foo');
    await sys.scan();

    sys.dispose();

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('clears all subscribers on dispose — calling dispose() twice does not throw', () => {
    const cb = vi.fn();
    sys.on('resize', cb);
    sys.dispose(); // clears subscribers + removes listeners
    expect(() => sys.dispose()).not.toThrow(); // second dispose on empty state is safe
  });
});
