export type Emotion = "happy" | "sad" | "angry" | "neutral" | "surprised" | "thinking";

export type InferenceMode = "groq" | "webllm" | "ollama";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};
