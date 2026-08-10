/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LOCAL_FILE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
