import { describe, it, expect, beforeAll, vi } from 'vitest';
import { defineComponent, defineGlobal, Choreo } from './index';

beforeAll(() => {
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
});

describe('defineComponent (browser)', () => {
  it('lazily creates the singleton and exposes it on window in dev', () => {
    expect(window.__choreo).toBeUndefined();
    defineComponent('thing', { init: vi.fn() });
    expect(window.__choreo).toBeInstanceOf(Choreo);
  });

  it('registers definitions on the shared singleton', async () => {
    const init = vi.fn();
    defineComponent('widget', { init });

    const el = document.createElement('div');
    el.setAttribute('data-component', 'widget');
    document.body.appendChild(el);

    await window.__choreo!.scan();
    expect(init).toHaveBeenCalledOnce();
  });

  it('reuses the same singleton across defineComponent calls', () => {
    const before = window.__choreo;
    defineComponent('another', { init: vi.fn() });
    expect(window.__choreo).toBe(before);
  });
});

// Registered last on purpose: this file shares one module-level singleton across
// cases, and a global is always present — it would initialize on any scan a
// later test triggers.
describe('defineGlobal (browser)', () => {
  it('registers on the same shared singleton and initializes with no element', async () => {
    const init = vi.fn();
    defineGlobal('shared-global', { init });

    await window.__choreo!.scan();

    expect(init).toHaveBeenCalledOnce();
  });
});
