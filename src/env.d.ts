// Minimal typing for the Vite-injected import.meta.env, so the package
// type-checks without depending on vite/client.
interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
