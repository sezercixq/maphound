/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "1" for end-to-end builds that expose the pipeline debug hook. */
  readonly VITE_MH_E2E?: string;
}
