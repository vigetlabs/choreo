import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Choreo, type CleanupFn } from './choreo';

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

let sys: Choreo;

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

  // happy-dom reports 'complete', which would trigger the constructor's
  // late-load fallback scan; pin to 'loading' so tests control scanning.
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    get: () => 'loading',
  });

  sys = new Choreo();
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
      refAll: unknown;
      log: unknown;
      system: Choreo;
    };

    expect(ctx.element).toBe(el);
    expect(ctx.viewport).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    expect(ctx.prefersReducedMotion).toBe(false); // matchMedia stub returns matches: false
    expect(ctx.ac).toBeInstanceOf(AbortController);
    expect(typeof ctx.find).toBe('function');
    expect(typeof ctx.findAll).toBe('function');
    expect(typeof ctx.ref).toBe('function');
    expect(typeof ctx.refAll).toBe('function');
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

  it('scans on construction when the document has already finished loading', async () => {
    // Module loaded after the load event (e.g. dynamic import) — the load
    // listener would never fire, so the constructor schedules the scan itself.
    Object.defineProperty(document, 'readyState', {
      configurable: true,
      get: () => 'complete',
    });
    const late = new Choreo();
    const init = vi.fn();
    late.register('foo', { init });
    addComponent('foo');

    await new Promise(r => setTimeout(r, 0));
    expect(init).toHaveBeenCalledOnce();
    late.dispose();
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

  it('astro:page-load mid-scan queues a re-scan instead of dropping the navigation', async () => {
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
    // Navigation fires while the first scan is still running
    document.dispatchEvent(new Event('astro:page-load'));

    // Not re-entered concurrently
    expect(initCount).toBe(1);

    resolveInit(); // first init settles
    await vi.waitFor(() => expect(initCount).toBe(2)); // queued re-scan ran
    resolveInit(); // let the re-scan's init settle
    await first;
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

  it('does not match a [data-ref] on the component element itself', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let capturedRef!: (name: string) => Element | null;
    sys.register('foo', { init: ctx => { capturedRef = ctx.ref; } });

    const wrapper = addComponent('foo');
    wrapper.setAttribute('data-ref', 'root');

    await sys.scan();

    expect(capturedRef('root')).toBeNull();
    warnSpy.mockRestore();
  });

  it('returns the descendant when the component element shares the ref name', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let capturedRef!: (name: string) => Element | null;
    sys.register('foo', { init: ctx => { capturedRef = ctx.ref; } });

    const wrapper = addComponent('foo');
    wrapper.setAttribute('data-ref', 'panel');
    const child = addRef(wrapper, 'panel');

    await sys.scan();

    expect(capturedRef('panel')).toBe(child);
    warnSpy.mockRestore();
  });
});

// refAll

describe('refAll', () => {
  it('returns every matching ref in document order', async () => {
    let capturedRefAll!: (name: string) => Element[];
    sys.register('foo', { init: ctx => { capturedRefAll = ctx.refAll; } });

    const wrapper = addComponent('foo');
    const first = addRef(wrapper, 'item');
    addRef(wrapper, 'other');
    const second = addRef(wrapper, 'item');
    const third = addRef(wrapper, 'item');

    await sys.scan();

    expect(capturedRefAll('item')).toEqual([first, second, third]);
  });

  it('excludes the component element itself', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let capturedRefAll!: (name: string) => Element[];
    sys.register('foo', { init: ctx => { capturedRefAll = ctx.refAll; } });

    const wrapper = addComponent('foo');
    wrapper.setAttribute('data-ref', 'item');
    const child = addRef(wrapper, 'item');

    await sys.scan();

    expect(capturedRefAll('item')).toEqual([child]);
    warnSpy.mockRestore();
  });

  it('returns an empty array for a ref that does not exist', async () => {
    let capturedRefAll!: (name: string) => Element[];
    sys.register('foo', { init: ctx => { capturedRefAll = ctx.refAll; } });
    addComponent('foo');
    await sys.scan();
    expect(capturedRefAll('ghost')).toEqual([]);
  });

  it('returns an array (not NodeList)', async () => {
    let capturedRefAll!: (name: string) => Element[];
    sys.register('foo', { init: ctx => { capturedRefAll = ctx.refAll; } });
    addComponent('foo');
    await sys.scan();
    expect(Array.isArray(capturedRefAll('ghost'))).toBe(true);
  });

  it('is scoped to the component element, not the whole document', async () => {
    let capturedRefAll!: (name: string) => Element[];
    sys.register('foo', { init: ctx => { capturedRefAll = ctx.refAll; } });

    const wrapper = addComponent('foo');
    const inside = addRef(wrapper, 'item');
    addRef(document.body, 'item'); // same name, outside the component

    await sys.scan();

    expect(capturedRefAll('item')).toEqual([inside]);
  });

  it('reaches into nested components (accepted convention, matches findAll)', async () => {
    let capturedRefAll!: (name: string) => Element[];
    sys.register('gallery', { init: ctx => { capturedRefAll = ctx.refAll; } });
    sys.register('carousel', { init: () => {} });

    const gallery = addComponent('gallery');
    const own = addRef(gallery, 'item');
    const carousel = addComponent('carousel', gallery);
    const nested = addRef(carousel, 'item');

    await sys.scan();

    expect(capturedRefAll('item')).toEqual([own, nested]);
  });
});

// data-ref on the component root (dev warning)

describe('root data-ref warning', () => {
  it('warns when ref() asks for a name the component element carries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let capturedRef!: (name: string) => Element | null;
    sys.register('accordion', { init: ctx => { capturedRef = ctx.ref; } });

    const wrapper = addComponent('accordion');
    wrapper.setAttribute('data-ref', 'root');

    await sys.scan();
    capturedRef('root');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[accordion] ref('root') skips the component element"),
      wrapper,
    );
    expect(warnSpy.mock.calls[0]?.[0]).toContain('Use `element`');
    warnSpy.mockRestore();
  });

  it('warns from refAll() too, naming the helper that was called', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let capturedRefAll!: (name: string) => Element[];
    sys.register('gallery', { init: ctx => { capturedRefAll = ctx.refAll; } });

    const wrapper = addComponent('gallery');
    wrapper.setAttribute('data-ref', 'item');

    await sys.scan();
    capturedRefAll('item');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[gallery] refAll('item') skips the component element"),
      wrapper,
    );
    warnSpy.mockRestore();
  });

  it('warns even when descendants matched — the root is still being skipped', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let capturedRefAll!: (name: string) => Element[];
    sys.register('gallery', { init: ctx => { capturedRefAll = ctx.refAll; } });

    const wrapper = addComponent('gallery');
    wrapper.setAttribute('data-ref', 'item');
    addRef(wrapper, 'item');

    await sys.scan();

    expect(capturedRefAll('item')).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('stays silent for an ordinary miss', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let capturedRef!: (name: string) => Element | null;
    sys.register('foo', { init: ctx => { capturedRef = ctx.ref; } });

    const wrapper = addComponent('foo');
    wrapper.setAttribute('data-ref', 'root');

    await sys.scan();
    capturedRef('ghost'); // different name — nothing to nudge about

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('stays silent when the component element has no data-ref', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let capturedRef!: (name: string) => Element | null;
    sys.register('foo', { init: ctx => { capturedRef = ctx.ref; } });

    const wrapper = addComponent('foo');
    const trigger = addRef(wrapper, 'trigger');

    await sys.scan();

    expect(capturedRef('trigger')).toBe(trigger);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
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

// pagehide

// happy-dom's PageTransitionEvent constructor ignores the persisted option,
// so stamp the flag onto a plain Event instead.
function pagehideEvent(persisted: boolean): Event {
  const e = new Event('pagehide');
  Object.defineProperty(e, 'persisted', { value: persisted });
  return e;
}

describe('pagehide', () => {
  it('destroys instances on real unload (persisted: false)', async () => {
    const cleanup = vi.fn();
    sys.register('foo', { init: () => cleanup });
    addComponent('foo');
    await sys.scan();

    window.dispatchEvent(pagehideEvent(false));
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('leaves instances intact when the page enters the bfcache (persisted: true)', async () => {
    const cleanup = vi.fn();
    sys.register('foo', { init: () => cleanup });
    addComponent('foo');
    await sys.scan();

    window.dispatchEvent(pagehideEvent(true));
    expect(cleanup).not.toHaveBeenCalled();
  });
});

// Manual re-scan

describe('manual re-scan', () => {
  it('scan() skips elements that already have a live instance', async () => {
    const init = vi.fn();
    sys.register('card', { init });
    addComponent('card');
    await sys.scan();
    expect(init).toHaveBeenCalledTimes(1);

    await sys.scan(); // nothing new — no duplicate instances
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('scan() picks up elements added to the DOM after the initial scan', async () => {
    const init = vi.fn();
    sys.register('card', { init });
    addComponent('card');
    await sys.scan();

    addComponent('card');
    await sys.scan();
    expect(init).toHaveBeenCalledTimes(2);
  });

  it('after destroy(), scan() re-initializes all elements', async () => {
    const init = vi.fn();
    sys.register('card', { init });
    addComponent('card');
    await sys.scan();
    sys.destroy();
    await sys.scan();
    expect(init).toHaveBeenCalledTimes(2);
  });
});

// Error isolation

describe('error isolation', () => {
  it('a throwing cleanup does not prevent other cleanups from running', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goodCleanup = vi.fn();
    sys.register('bad', { init: () => () => { throw new Error('boom'); } });
    sys.register('good', { init: () => goodCleanup });
    addComponent('bad');
    addComponent('good');
    await sys.scan();

    expect(() => sys.destroy()).not.toThrow();
    expect(goodCleanup).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a throwing subscriber does not prevent other subscribers from firing', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    sys.on('resize', bad);
    sys.on('resize', good);

    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);

    expect(bad).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('a scan failure triggered by astro:page-load logs instead of rejecting unhandled', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sys.register('a', { deps: ['b'], init: vi.fn() });
    sys.register('b', { deps: ['a'], init: vi.fn() });
    addComponent('a');
    addComponent('b');

    document.dispatchEvent(new Event('astro:page-load'));
    await new Promise(r => setTimeout(r, 0));

    expect(errorSpy).toHaveBeenCalledWith('[choreo] scan failed', expect.any(Error));
    errorSpy.mockRestore();
  });
});

// on() with pre-aborted signal

describe('on() with an already-aborted signal', () => {
  it('never adds the listener (matches DOM addEventListener semantics)', () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    ac.abort();
    const cb = vi.fn();

    sys.on('resize', cb, { signal: ac.signal });
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(250);

    expect(cb).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ref name escaping

describe('ref name escaping', () => {
  it('matches ref names containing CSS-significant characters', async () => {
    let capturedRef!: (name: string) => Element | null;
    sys.register('foo', { init: ctx => { capturedRef = ctx.ref; } });

    const wrapper = addComponent('foo');
    const odd = addRef(wrapper, 'we"ird]name');

    await sys.scan();

    expect(capturedRef('we"ird]name')).toBe(odd);
    expect(capturedRef('nope"nope')).toBeNull(); // no throw, no match
  });

  it('does not let a ref name smuggle in a second selector', async () => {
    let capturedRef!: (name: string) => Element | null;
    let capturedRefAll!: (name: string) => Element[];
    sys.register('foo', {
      init: ctx => { capturedRef = ctx.ref; capturedRefAll = ctx.refAll; },
    });

    const wrapper = addComponent('foo');
    addRef(wrapper, 'ok');

    await sys.scan();

    // Interpolated, this name would build the selector list
    // [data-ref="a"], [data-ref="ok"] and return the element named 'ok'.
    expect(capturedRef('a"], [data-ref="ok')).toBeNull();
    expect(capturedRefAll('a"], [data-ref="ok')).toEqual([]);
  });
});
