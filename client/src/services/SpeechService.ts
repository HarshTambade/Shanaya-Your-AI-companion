import { Capacitor } from "@capacitor/core";
import { SpeechSynthesis } from "@capgo/capacitor-speech-synthesis";
import type { SpeechLanguage } from "../types";
import { apiUrl } from "./api";
import { getNetworkStatus } from "./AIService";

const voiceNames: Record<SpeechLanguage, string[]> = {
  "en-US": ["charvi", "zoe", "ava", "aria", "allison", "samantha", "victoria", "serena", "female", "woman"],
  "hi-IN": ["charvi", "lekha", "aditi", "neelam", "swara", "female", "woman"],
  "mr-IN": ["charvi", "aditi", "swara", "lekha", "female", "woman"],
};

const softVoiceStyle = { pitch: 1.18, rate: 0.84, volume: 0.86 };

function preferredVoice<T extends { name: string }>(voices: T[], language: SpeechLanguage) {
  for (const term of voiceNames[language]) {
    const match = voices.find((voice) => voice.name.toLowerCase().includes(term));
    if (match) return match;
  }
  return undefined;
}

function speakInBrowser(text: string, language: SpeechLanguage) {
  const synthesis = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synthesis || typeof SpeechSynthesisUtterance === "undefined") {
    throw new Error(`Speech output is unavailable for ${language} on this device.`);
  }

  return new Promise<string>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    const prefix = language.split("-")[0].toLowerCase();
    const voices = synthesis.getVoices();
    const matchingVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith(prefix));
    const softFemaleVoices = matchingVoices.filter((voice) => !/\b(male|david|fred|daniel|james|tom|alex)\b/i.test(voice.name));
    const voice = preferredVoice(softFemaleVoices, language)
      ?? softFemaleVoices.find((candidate) => /\b(female|woman)\b/i.test(candidate.name))
      ?? softFemaleVoices[0]
      ?? preferredVoice(matchingVoices, language)
      ?? matchingVoices[0];
    if (voice) utterance.voice = voice;
    utterance.lang = language;
    utterance.pitch = softVoiceStyle.pitch;
    utterance.rate = softVoiceStyle.rate;
    utterance.volume = softVoiceStyle.volume;
    utterance.onend = () => resolve(voice?.name || `${language} system voice`);
    utterance.onerror = (event) => reject(new Error(event.error === "not-allowed"
      ? "Allow speech output in your browser and try again."
      : `Browser speech output failed (${event.error}).`));
    synthesis.cancel();
    synthesis.speak(utterance);
  });
}

export class SpeechService {
  static async speak(text: string, language: SpeechLanguage) {
    const network = await getNetworkStatus().catch(() => ({ connected: typeof navigator === "undefined" || navigator.onLine }));
    try {
      if (!network.connected) throw new Error("Use the installed device voice while offline.");
      const response = await fetch(apiUrl("/api/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 5000), language }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const audioBlob = await response.blob();
        if (audioBlob.size > 0) {
          const audioUrl = URL.createObjectURL(audioBlob);
          try {
            const audio = new Audio(audioUrl);
            audio.playbackRate = 0.96;
            await new Promise<void>((resolve, reject) => {
              audio.onended = () => resolve();
              audio.onerror = () => reject(new Error("Mithi audio playback failed."));
              void audio.play().catch(reject);
            });
            return "Charvi · Mithi v1 Flash";
          } finally {
            URL.revokeObjectURL(audioUrl);
          }
        }
      }
    } catch {
      // The Mithi service is optional; continue with a voice installed on the device.
    }

    if (Capacitor.getPlatform() === "web") return speakInBrowser(text, language);

    try {
      const { voices } = await SpeechSynthesis.getVoices();
      const languagePrefix = language.split("-")[0].toLowerCase();
      const offlineVoices = voices.filter(
        (voice) => voice.language.toLowerCase().startsWith(languagePrefix) && !voice.isNetworkConnectionRequired,
      );

      // The OS speech plugin can select Charvi only if that voice is installed as a system voice.
      const voice = preferredVoice(offlineVoices, language)
        || offlineVoices.find((candidate) => candidate.gender === "female")
        || offlineVoices[0];

      if (!voice) {
        throw new Error(`No offline ${language} voice is installed. Download a native voice in your device language settings.`);
      }

      await SpeechSynthesis.speak({
        text,
        language,
        voiceId: voice.id,
        pitch: softVoiceStyle.pitch,
        rate: softVoiceStyle.rate,
        volume: softVoiceStyle.volume,
        queueStrategy: "Flush",
      });
      return voice.name;
    } catch (error) {
      if (typeof window !== "undefined" && window.speechSynthesis) return speakInBrowser(text, language);
      throw error;
    }
  }

  static async cancel() {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    try {
      await SpeechSynthesis.cancel();
    } catch {
      // Browser speech is already cancelled above; the native plugin may not exist on web.
    }
  }
}
