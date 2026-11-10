import { TalkMode } from "@elizaos/capacitor-talkmode";
import type { TalkModeErrorEvent, TalkModeTranscriptEvent } from "@elizaos/capacitor-talkmode";
import type { SpeechLanguage } from "../types";

export type TranscriptListener = (text: string, isFinal: boolean) => void;

export class VoiceService {
  static async startSession(
    language: SpeechLanguage,
    onTranscript: TranscriptListener,
    onError?: (message: string) => void,
  ) {
    let finalTranscriptSeen = false;
    const transcriptListener = await TalkMode.addListener("transcript", (event: TalkModeTranscriptEvent) => {
      const transcript = event.transcript.trim();
      if (!transcript || (event.isFinal && finalTranscriptSeen)) return;
      if (event.isFinal) finalTranscriptSeen = true;
      onTranscript(transcript, event.isFinal);
    });
    const errorListener = await TalkMode.addListener("error", (event: TalkModeErrorEvent) => {
      onError?.(event.message);
    });

    try {
      const result = await TalkMode.start({
        config: {
          stt: { engine: "web", language },
          silenceWindowMs: 800,
          interruptOnSpeech: false,
        },
      });
      if (!result.started) throw new Error(result.error || "TalkMode could not start speech recognition.");
    } catch (error) {
      await Promise.all([transcriptListener.remove(), errorListener.remove()]);
      throw error;
    }

    return async () => {
      await TalkMode.stop();
      await Promise.all([transcriptListener.remove(), errorListener.remove()]);
    };
  }
}
