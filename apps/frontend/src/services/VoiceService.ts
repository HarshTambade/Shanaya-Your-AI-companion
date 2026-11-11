export type SpeechLanguage = "en-US" | "hi-IN" | "mr-IN";
const baseUrl = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, "") || "";

export class VoiceService {
  static async speak(text: string, language: SpeechLanguage): Promise<void> {
    if (!text.trim()) return;
    try {
      const response = await fetch(`${baseUrl}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/wav" },
        body: JSON.stringify({ text, language, voice: "Charvi" }),
        // Fall back to an installed system voice if Mithi is offline or slow.
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("Mithi TTS is unavailable.");
      const audioBlob = await response.blob();
      if (!audioBlob.size || audioBlob.size > 20 * 1024 * 1024) throw new Error("Mithi returned an invalid audio response.");
      const audioUrl = URL.createObjectURL(audioBlob);
      try {
        const audio = new Audio(audioUrl);
        const playback = new Promise<void>((resolve, reject) => {
          audio.addEventListener("ended", () => resolve(), { once: true });
          audio.addEventListener("error", () => reject(new Error("Mithi audio playback failed.")), { once: true });
        });
        await audio.play();
        await playback;
      } finally {
        URL.revokeObjectURL(audioUrl);
      }
    } catch {
      await this.speakWithSystemVoice(text, language);
    }
  }

  private static speakWithSystemVoice(text: string, language: SpeechLanguage): Promise<void> {
    if (!("speechSynthesis" in window)) return Promise.reject(new Error("No speech synthesis engine is available."));
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language;
    utterance.rate = 0.96;
    utterance.pitch = 1.04;
    return new Promise((resolve, reject) => {
      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error("System voice playback failed."));
      window.speechSynthesis.speak(utterance);
    });
  }
}
