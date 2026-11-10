# Shanaya — Your AI Companion

Shanaya is an interactive AI companion with a conversational chat interface, a 3D avatar, emotion-aware responses, speech output, voice-call support, and multiple inference options. It runs as a web application and can also be packaged for iOS and Android with Capacitor.

## Features

- Interactive 3D avatar rendered with React Three Fiber and Three.js
- Emotion-aware responses and avatar reactions:
  `happy`, `sad`, `angry`, `neutral`, `surprised`, and `thinking`
- Four inference modes:
  - **Cloud AI** for fast hosted responses
  - **WebLLM Local** for browser-based inference using WebGPU
  - **Local Ollama** for inference through a locally hosted Ollama server
  - **On-device AI** through Capacitor Local LLM on supported mobile devices
- Automatic offline fallback:
  - Web browsers use WebLLM when disconnected
  - Native apps use the on-device model when disconnected
- Optional speech replies in English, Hindi, and Marathi
- Optional Pinecall voice calls through browser or native call integrations
- Responsive layout with mobile safe-area support
- TypeScript, Tailwind CSS, Vite, and Capacitor-based mobile builds

## Architecture

```text
Browser / iOS / Android
          |
          v
   React + Vite client
          |
          +--> Cloud AI service
          +--> Ollama server
          +--> WebLLM in the browser
          +--> Capacitor Local LLM on supported devices
          |
          v
   Express API server
          |
          +--> Cloud model fallback chain
          +--> Ollama API
          +--> Pinecall token issuer
```

The client is in [`client/`](./client), and the API server is in [`server/`](./server). The API keeps provider secrets on the server; the browser only receives the public client configuration from `client/.env`.

## Requirements

- Node.js 20 or newer
- npm
- A modern browser for web development
- WebGPU support for WebLLM
- Ollama, if using Local Ollama
- Xcode and CocoaPods for iOS builds
- Android Studio and an Android SDK for Android builds

## Quick start

### 1. Install dependencies

Install dependencies in the root, client, and server directories:

```bash
npm install
npm install --prefix client
npm install --prefix server
```

### 2. Configure the API server

Copy the server environment template:

```bash
cp server/.env.example server/.env
```

To use Cloud AI, configure the cloud provider key on the API server:

```dotenv
PORT=3001
CLIENT_ORIGIN=http://localhost:5173,capacitor://localhost,http://localhost,https://localhost
CLOUD_API_KEY=your_cloud_provider_api_key
```

Never commit `server/.env`. It is ignored by Git.

### 3. Configure the client

Copy the client environment template:

```bash
cp client/.env.example client/.env
```

For browser development, the default empty API base URL works when the client and API are served behind the same origin. If Vite runs on `http://localhost:5173` and the API runs directly on port `3001`, set:

```dotenv
VITE_API_BASE_URL=http://localhost:3001
VITE_PINECALL_AGENT_ID=shanaya
```

### 4. Start the application

From the project root:

```bash
npm run dev
```

This starts:

- The API at `http://localhost:3001`
- The Vite client at the URL printed by Vite, normally `http://localhost:5173`

You can also start each process separately:

```bash
npm run dev:server
npm run dev:client
```

Verify the API is running:

```bash
curl http://localhost:3001/api/health
```

Expected response:

```json
{"status":"ok"}
```

## Environment variables

### Client: `client/.env`

| Variable | Required | Description |
| --- | --- | --- |
| `VITE_API_BASE_URL` | For a separate API origin | Base URL used for `/api/chat` and the Pinecall token endpoint. For a phone, use a reachable HTTPS URL or your computer's LAN IP during development. |
| `VITE_PINECALL_AGENT_ID` | For Pinecall calls | Public Pinecall agent slug. Defaults to `shanaya` in the client. |

### Server: `server/.env`

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | API port. Defaults to `3001`. |
| `CLIENT_ORIGIN` | No | Comma-separated list of allowed CORS origins. |
| `CLOUD_API_KEY` | For Cloud AI | Server-side cloud provider API key. |
| `CLOUD_MODEL_FALLBACKS` | No | Comma-separated cloud models tried in order when a request fails. |
| `OLLAMA_BASE_URL` | For Ollama | Ollama server URL. Defaults to `http://localhost:11434`. |
| `OLLAMA_MODEL` | For Ollama | Ollama model name. Defaults to `gurubot/self-after-dark:latest`. |
| `PINECALL_TOKEN_URL` | For voice calls | Trusted server-side endpoint that returns `{ "token": "...", "server": "..." }`. |

The server's default cloud model fallback list is defined in [`server/index.js`](./server/index.js). Keep the configured model names current for your provider account.

## Inference modes

### Cloud AI

Cloud requests go through the Express API, which keeps `CLOUD_API_KEY` off the client. Prompts are sent to the configured cloud provider, which applies its own data retention policy. The API requests JSON responses containing a reply and one of Shanaya's supported emotions.

### WebLLM Local

WebLLM runs in the browser using WebGPU. The first request may download and initialize the browser model, and browser storage is used for subsequent loads. If WebGPU is unavailable, use Cloud AI, Ollama, or the native mobile mode.

### Local Ollama

Install and run Ollama separately, then make sure the selected model is available:

```bash
ollama pull gurubot/self-after-dark:latest
ollama serve
```

Set `OLLAMA_BASE_URL` and `OLLAMA_MODEL` in `server/.env` if your setup differs from the defaults. The browser still talks to the Express API; it does not call Ollama directly.

### On-device AI

On-device inference is available inside the Capacitor iOS or Android app when the device supports the installed native Local LLM implementation. Prepare or download the model while online before going offline. A device without a supported native model can use WebLLM in a compatible browser instead.

## Voice and speech

### Speech replies

The client can use installed device speech voices for:

- English (`en-US`)
- Hindi (`hi-IN`)
- Marathi (`mr-IN`)

Offline device voices are preferred. If no compatible voice is installed, download a voice for the selected language from the operating system's language or accessibility settings.

### Pinecall voice calls

Voice calls require:

1. A public agent ID in `VITE_PINECALL_AGENT_ID`
2. A trusted token issuer configured through `PINECALL_TOKEN_URL`
3. Internet access
4. Microphone permission

The token issuer must return JSON in this shape:

```json
{
  "token": "short-lived-token",
  "server": "pinecall-server-url",
  "expires_in": 3600
}
```

Do not expose a Pinecall API key in `client/.env`. The client only requests short-lived call credentials from the server endpoint at `/api/pinecall/token`.

## Mobile builds

The Capacitor app uses:

- App name: `Shanaya`
- App ID: `com.shanaya.companion`
- Web output directory: `client/dist`

Build the client and synchronize native projects:

```bash
npm run cap:sync --prefix client
```

Add native platforms once:

```bash
npm run cap:add:ios --prefix client
npm run cap:add:android --prefix client
```

Run on a connected device or emulator:

```bash
npm run cap:run:ios --prefix client
npm run cap:run:android --prefix client
```

For a physical phone, configure `VITE_API_BASE_URL` with a reachable HTTPS API URL or the development computer's LAN IP. `localhost` on a phone refers to the phone itself, not the computer running the API.

## Available scripts

### Root scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the client and server together |
| `npm run dev:client` | Start only the Vite client |
| `npm run dev:server` | Start only the API server |
| `npm run build` | Type-check and build the client |

### Client scripts

Run these with `npm run <script> --prefix client`:

| Command | Description |
| --- | --- |
| `dev` | Start Vite development server |
| `build` | Run TypeScript build and create the production bundle |
| `preview` | Preview the production bundle locally |
| `cap:sync` | Build and synchronize Capacitor projects |
| `cap:add:ios` | Add the iOS Capacitor platform |
| `cap:add:android` | Add the Android Capacitor platform |
| `cap:run:ios` | Build, sync, and run iOS |
| `cap:run:android` | Build, sync, and run Android |

### Server scripts

Run these with `npm run <script> --prefix server`:

| Command | Description |
| --- | --- |
| `dev` | Start the API with Node's watch mode |
| `start` | Start the API normally |

## API reference

### `GET /api/health`

Returns an API health response:

```json
{"status":"ok"}
```

### `POST /api/chat`

Request:

```json
{
  "mode": "cloud",
  "messages": [
    { "role": "user", "content": "Hello, Shanaya!" }
  ]
}
```

`mode` must be `cloud` or `ollama` for server-side inference. WebLLM and native inference run in the client.

Successful response:

```json
{
  "reply": "Hello! It is wonderful to hear from you.",
  "emotion": "happy"
}
```

The API accepts between 1 and 40 messages, and each message is limited to 4,000 characters.

### `GET /api/pinecall/token`

Proxies a request to the configured trusted Pinecall token issuer. Returns `503` when `PINECALL_TOKEN_URL` is not configured and `502` when the issuer fails or returns an invalid response.

## Project structure

```text
.
├── client/
│   ├── public/models/avatar.glb   # 3D avatar asset
│   ├── src/components/            # Avatar and chat UI
│   ├── src/services/              # AI, speech, network, and call integrations
│   ├── .env.example               # Client configuration template
│   └── capacitor.config.ts        # Mobile app configuration
├── server/
│   ├── index.js                   # Express API and provider adapters
│   └── .env.example               # Server configuration template
├── package.json                   # Root development commands
└── README.md
```

## Troubleshooting

- **The client cannot reach the API:** Set `VITE_API_BASE_URL` correctly and ensure the API is running. For a mobile device, do not use `localhost`.
- **Cloud requests fail:** Check `CLOUD_API_KEY`, model access, and the configured fallback model names.
- **Ollama requests fail:** Confirm `ollama serve` is running, the model has been pulled, and `OLLAMA_BASE_URL` is reachable from the API server.
- **WebLLM is unavailable:** Use a browser with WebGPU enabled, or switch to Cloud AI, Ollama, or native inference.
- **Native offline AI is unavailable:** Prepare the model while online and confirm the device supports the native Local LLM plugin.
- **Speech output does not start:** Enable voice replies, select a language, and install an offline system voice for that language.
- **Calls cannot connect:** Configure `PINECALL_TOKEN_URL`, verify the token issuer response, grant microphone permission, and check that the agent ID is correct.

## Security notes

- Keep `CLOUD_API_KEY` and any Pinecall credentials on the server.
- Do not commit `server/.env`, `client/.env`, or generated native/build directories.
- Use HTTPS for deployed clients and APIs.
- Restrict `CLIENT_ORIGIN` to the actual origins that should access the API in production.
- Use short-lived Pinecall tokens and validate them in the trusted token issuer.

## License

No license has been specified yet. Add a license before distributing or publishing the project for reuse.
