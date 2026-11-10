/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_PINECALL_AGENT_ID?: string;
  readonly VITE_OFFLINE_MODEL_URL?: string;
  readonly VITE_AVATAR_MODEL_URL?: string;
}
