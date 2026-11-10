# Shanaya

Shanaya is a React Three Fiber companion UI with Groq, Ollama, browser WebLLM, native on-device inference, native speech synthesis, and an optional Pinecall voice-call path.

## Web development

```bash
npm install
npm install --prefix server
npm install --prefix client
```

Put `GROQ_API_KEY` in `server/.env` for Groq mode. For local Ollama, set `OLLAMA_BASE_URL` and `OLLAMA_MODEL`. Start the API and Vite client together with `npm run dev` from the project root.

## Capacitor iOS and Android

Install the packages, build the Vite app, and add platform projects from `client/`:

```bash
cd client
npm install
npm run build
npx cap add ios
npx cap add android
npx cap sync
npx cap open ios
```

Run `npx cap open android` to open Android Studio. After web or plugin changes, run `npm run build && npx cap sync` from `client/`. This repo contains the Capacitor config; generate the native `ios/` and `android/` projects with the commands above.

For testing on a phone, set `VITE_API_BASE_URL` in `client/.env.local` to an API URL the phone can reach. Use HTTPS outside local development. Set `CLIENT_ORIGIN` in `server/.env` to the web origin plus Capacitor origins.

The native LLM plugin is experimental and requires supported devices. Its text model requires iOS 26 with Apple Intelligence, or a compatible Android device with Google Play Services Gemini Nano. Android requires `minSdkVersion = 28` in `android/variables.gradle`. On Android, the model is downloaded once through Google Play Services while online; use **Prepare offline AI** before disconnecting. Availability varies by device.

For native calls, add these keys to `ios/App/App/Info.plist` after adding iOS:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Microphone access is needed for Shanaya voice calls.</string>
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
  <string>voip</string>
</array>
```

On native platforms the app requests microphone permission when the user taps **Call**. The Pinecall plugin merges its Android Telecom service and manifest permissions during `npx cap sync`.

Provision a Pinecall agent and a trusted server-side token issuer that uses the Pinecall SDK/API key to return `{ token, server }`. Set its URL as `PINECALL_TOKEN_URL` in `server/.env` and the agent slug in `client/.env.local` as `VITE_PINECALL_AGENT_ID`. The app server proxies the short-lived token to the phone; the Pinecall key stays on the issuer. Phone builds need a reachable `VITE_API_BASE_URL` for chat and the token endpoint. Pinecall voice calls use an online voice service and are not part of offline mode. CallKit requires a physical iOS device; Android uses its Telecom call UI.

## Offline speech

`SpeechService` selects a locally installed OS voice for English (`en-US`), Hindi (`hi-IN`), or Marathi (`mr-IN`) and avoids voices marked as network-required. It prefers a system voice named Charvi if one is installed. The Capgo speech-synthesis plugin cannot load the Mithi v1 Flash model itself. Mithi's published weights and Python inference code need a separate native model port to use the actual Charvi voice on iOS and Android; until then, Shanaya uses the device's offline voice.
