import { describe, it, expect, beforeAll, vi } from 'vitest';
import { defineComponent, ComponentSystem } from './index';

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
    expect(window.__componentSystem).toBeUndefined();
    defineComponent('thing', { init: vi.fn() });
    expect(window.__componentSystem).toBeInstanceOf(ComponentSystem);
  });

  it('registers definitions on the shared singleton', async () => {
    const init = vi.fn();
    defineComponent('widget', { init });

    const el = document.createElement('div');
    el.setAttribute('data-component', 'widget');
    document.body.appendChild(el);

    await window.__componentSystem!.scan();
    expect(init).toHaveBeenCalledOnce();
  });

  it('reuses the same singleton across defineComponent calls', () => {
    const before = window.__componentSystem;
    defineComponent('another', { init: vi.fn() });
    expect(window.__componentSystem).toBe(before);
  });
});
