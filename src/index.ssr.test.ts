// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, Choreo } from './index';

describe('defineComponent (SSR / no window)', () => {
  it('is a no-op and does not throw when window is undefined', () => {
    expect(typeof window).toBe('undefined');
    expect(() => defineComponent('foo', { init: vi.fn() })).not.toThrow();
  });

  it('importing the entry does not construct the singleton', () => {
    // Module was imported at the top of this file in a windowless
    // environment — reaching this line proves construction is lazy.
    expect(typeof Choreo).toBe('function');
  });
});
