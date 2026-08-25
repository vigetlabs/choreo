import { Choreo } from './choreo';
import type { ComponentDefinition, GlobalDefinition } from './choreo';

export { Choreo };
export type {
  Viewport,
  ComponentContext,
  ComponentDefinition,
  GlobalContext,
  GlobalDefinition,
  CleanupFn,
} from './choreo';

declare global {
  interface Window {
    __choreo?: Choreo;
  }
}

let system: Choreo | undefined;

function getSystem(): Choreo {
  if (!system) {
    system = new Choreo();
    if (import.meta.env.DEV) {
      window.__choreo = system;
    }
  }
  return system;
}

export function defineComponent(name: string, def: ComponentDefinition): void {
  // Safe to import anywhere (types, SSR); only does work in the browser.
  if (typeof window === 'undefined') return;
  getSystem().register(name, def);
}

export function defineGlobal(name: string, def: GlobalDefinition): void {
  // Safe to import anywhere (types, SSR); only does work in the browser.
  if (typeof window === 'undefined') return;
  getSystem().registerGlobal(name, def);
}
