/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_PYTHON_FALLBACK_URL?: string;
  readonly VITE_PINECALL_AGENT_ID?: string;
  readonly VITE_OFFLINE_MODEL_URL?: string;
  readonly VITE_AVATAR_MODEL_URL?: string;
  readonly VITE_SHANAYA_ANTHROPIC_MODEL?: string;
  readonly VITE_ANDROID_DOWNLOAD_URL?: string;
  readonly VITE_IOS_DOWNLOAD_URL?: string;
  readonly VITE_MACOS_DOWNLOAD_URL?: string;
  readonly VITE_WINDOWS_DOWNLOAD_URL?: string;
  readonly VITE_LINUX_DOWNLOAD_URL?: string;
}
