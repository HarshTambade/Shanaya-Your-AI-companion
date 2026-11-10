import { SpeechSynthesis } from "@capgo/capacitor-speech-synthesis";
import type { SpeechLanguage } from "../types";

const voiceNames: Record<SpeechLanguage, string[]> = {
  "en-US": ["charvi", "samantha", "aria", "female", "woman"],
  "hi-IN": ["charvi", "lekha", "female", "woman"],
  "mr-IN": ["charvi", "female", "woman"],
};

export class SpeechService {
  static async speak(text: string, language: SpeechLanguage) {
    const { voices } = await SpeechSynthesis.getVoices();
    const languagePrefix = language.split("-")[0].toLowerCase();
    const offlineVoices = voices.filter(
      (voice) => voice.language.toLowerCase().startsWith(languagePrefix) && !voice.isNetworkConnectionRequired,
    );

    // The OS speech plugin cannot load Mithi safetensors. It can select Charvi only if that voice is installed as a system voice.
    const preferredTerms = voiceNames[language];
    const voice = offlineVoices.find((candidate) => candidate.name.toLowerCase().includes("charvi"))
      || offlineVoices.find((candidate) => preferredTerms.some((term) => candidate.name.toLowerCase().includes(term)))
      || offlineVoices.find((candidate) => candidate.gender === "female")
      || offlineVoices[0];

    if (!voice) {
      throw new Error(`No offline ${language} voice is installed. Download a native voice in your device language settings.`);
    }

    await SpeechSynthesis.speak({
      text,
      language,
      voiceId: voice.id,
      pitch: 1.05,
      rate: 0.9,
      volume: 0.95,
      queueStrategy: "Flush",
    });
    return voice.name;
  }

  static async cancel() {
    await SpeechSynthesis.cancel();
  }
}
