import { Capacitor } from "@capacitor/core";
import { TalkMode } from "@elizaos/capacitor-talkmode";
import type { TalkModeErrorEvent, TalkModeTranscriptEvent } from "@elizaos/capacitor-talkmode";
import type { SpeechLanguage } from "../types";

export type TranscriptListener = (text: string, isFinal: boolean) => void;

type BrowserSpeechResult = { isFinal: boolean; 0?: { transcript?: string } };
type BrowserSpeechEvent = { resultIndex: number; results: ArrayLike<BrowserSpeechResult> };
type BrowserSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: BrowserSpeechEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function getBrowserRecognitionConstructor() {
  const speechWindow = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

function startBrowserSession(language: SpeechLanguage, onTranscript: TranscriptListener, onError?: (message: string) => void) {
  const Recognition = getBrowserRecognitionConstructor();
  if (!Recognition) {
    throw new Error("Speech input is unavailable in this browser. Use Chrome or Edge and allow microphone access.");
  }

  const recognition = new Recognition();
  let stopped = false;
  let finalTranscriptSeen = false;
  recognition.lang = language;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript?.trim();
      if (!transcript || (result.isFinal && finalTranscriptSeen)) continue;
      if (result.isFinal) finalTranscriptSeen = true;
      onTranscript(transcript, result.isFinal);
    }
  };
  recognition.onerror = ({ error }) => {
    if (error === "aborted" || stopped) return;
    onError?.(error === "not-allowed" || error === "service-not-allowed"
      ? "Allow microphone access in your browser to use speech input."
      : error === "audio-capture"
        ? "No microphone is available. Connect a microphone and try again."
        : error === "no-speech"
          ? "No speech was detected. Tap Speak and try again."
          : `Speech recognition failed (${error}).`);
  };
  recognition.onend = () => {
    if (!stopped && !finalTranscriptSeen) onError?.("Speech input stopped before a transcript was received. Tap Speak to try again.");
  };

  try {
    recognition.start();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Could not start browser speech recognition.");
  }

  return async () => {
    stopped = true;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.stop();
  };
}

export class VoiceService {
  static async startSession(
    language: SpeechLanguage,
    onTranscript: TranscriptListener,
    onError?: (message: string) => void,
  ) {
    if (Capacitor.getPlatform() === "web") {
      return startBrowserSession(language, onTranscript, onError);
    }

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
