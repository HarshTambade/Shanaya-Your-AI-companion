import { Capacitor } from "@capacitor/core";
import { TalkMode } from "@elizaos/capacitor-talkmode";
import type { TalkModeErrorEvent, TalkModeTranscriptEvent } from "@elizaos/capacitor-talkmode";
import { requestCallMicrophonePermission } from "./callPermissions";
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
  let latestTranscript = "";
  let errorReported = false;
  let restartTimer: number | undefined;

  const restartRecognition = () => {
    if (stopped || errorReported) return;
    finalTranscriptSeen = false;
    latestTranscript = "";
    try {
      recognition.start();
    } catch {
      restartTimer = window.setTimeout(restartRecognition, 150);
    }
  };

  recognition.lang = language;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript?.trim();
      if (!result.isFinal && transcript && transcript !== latestTranscript) {
        finalTranscriptSeen = false;
      }
      if (!transcript || (result.isFinal && finalTranscriptSeen)) continue;
      latestTranscript = transcript;
      if (result.isFinal) finalTranscriptSeen = true;
      onTranscript(transcript, result.isFinal);
    }
  };
  recognition.onerror = ({ error }) => {
    if (error === "aborted" || stopped) return;
    if (error === "no-speech") {
      restartTimer = window.setTimeout(restartRecognition, 150);
      return;
    }
    errorReported = true;
    onError?.(error === "not-allowed" || error === "service-not-allowed"
      ? "Allow microphone access in your browser to use speech input."
      : error === "audio-capture"
        ? "No microphone is available. Connect a microphone and try again."
          : `Speech recognition failed (${error}).`);
  };
  recognition.onend = () => {
    if (stopped || errorReported) return;
    if (latestTranscript && !finalTranscriptSeen) {
      finalTranscriptSeen = true;
      onTranscript(latestTranscript, true);
    }
    restartTimer = window.setTimeout(restartRecognition, 150);
  };

  try {
    recognition.start();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Could not start browser speech recognition.");
  }

  return async () => {
    stopped = true;
    if (restartTimer !== undefined) window.clearTimeout(restartTimer);
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

    // Ask through the native permission API before creating a TalkMode session;
    // its own start method also guards the mic in case platform state changes.
    if (!(await requestCallMicrophonePermission())) {
      throw new Error("Microphone access was denied. Enable it in your device settings to use voice input.");
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
