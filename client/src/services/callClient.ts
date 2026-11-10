import { CallClient } from "@pinecall/ionic";

// Keep one client instance for the app lifetime; the native CallKit/Telecom session outlives UI renders.
export const shanayaCallClient = new CallClient();

export const pinecallAgentId = import.meta.env.VITE_PINECALL_AGENT_ID?.trim() || "";
