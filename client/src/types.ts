export type Emotion = "happy" | "sad" | "angry" | "neutral" | "surprised" | "thinking";

export type InferenceMode = "groq" | "webllm" | "ollama" | "native";

export type SpeechLanguage = "en-US" | "hi-IN" | "mr-IN";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};
