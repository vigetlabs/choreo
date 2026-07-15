import { ComponentSystem } from './system';
import type { ComponentDefinition } from './system';

export { ComponentSystem };
export type { Viewport, ComponentContext, ComponentDefinition, CleanupFn } from './system';

declare global {
  interface Window {
    __componentSystem?: ComponentSystem;
  }
}

let system: ComponentSystem | undefined;

function getSystem(): ComponentSystem {
  if (!system) {
    system = new ComponentSystem();
    if (import.meta.env.DEV) {
      window.__componentSystem = system;
    }
  }
  return system;
}

export function defineComponent(name: string, def: ComponentDefinition): void {
  // Safe to import anywhere (types, SSR); only does work in the browser.
  if (typeof window === 'undefined') return;
  getSystem().register(name, def);
}
