# Call Flow Studio

A visual editor for **AIServant call scripts** (`instructions.instructionTree`): the steps a phone agent goes
through in a call and the arrows between them. On top of the editor:

- **Real test calls.** It dials a real phone with the open script, through AIServant's `POST /sip/makecall`.
- **Live call tracking.** While the call runs, the diagram shows the current step and the path so far, plus what
  the decision model ("החלטה") read on every turn, the transcript, and an option to listen in.
- **Call replay.** An ended call's recording plays back with the diagram moving in sync.
- **Voice library.** Per-account tables of reply starters and reaction sounds, and a recorded clip per voice for
  every wording. Clips can be recorded, uploaded, or generated with Cartesia, then cut and word-timed.
- **AI chat.** It builds and edits scripts, on the "fast brain" LLM (מוח מהיר) or on a built-in rule-based helper.

This project covers only the scripts and the call. Accounts, leads, campaigns and the rest of the system are
expected to live elsewhere. The UI is in Hebrew (RTL). The code and this document are in English.

**Names used in this project**

| Name | What it is |
|---|---|
| **החלטה** (decision) | AIServant's small, fast model that reads what the caller said and picks the arrow, the starter or the reaction. In the editor, a question step (`kind: "ask"`) is also called "החלטה". |
| **מוח מהיר** (fast brain) | The LLM that writes the agent's replies in a call. In the studio it is also the model behind the AI chat. |
| **starter** | 1–3 words played the instant the call reaches a step, so the caller hears no silence while the reply is generated. |

---

## Running it

```bash
npm install
cp .env.example .env      # then fill in the AIServant secret and account
npm run dev               # http://localhost:5173
```

`npm run dev` serves the React app **and** a small local server (`server/`, mounted as Vite middleware).
The local server is required. It holds every secret, signs the requests to AIServant and Cartesia, and saves
the studio's data to disk. Production build: `npm run build`, then `npm run preview`, which serves the same
local API on port 4173.

### `.env`

| Variable | Used for |
|---|---|
| `YOAVHAIK_API_BASE_URL` | AIServant base URL (default `https://yoavhaik.com:7025`) |
| `AISERVANT_SHARED_SECRET` | Sent to AIServant as `X-Api-Key`; also signs the live-listen ticket. **Never sent to the browser.** |
| `DEMO_LEADS_OWNER_UID` | The account (agency uid): `X-Agency-Id` and makecall's `apiKey`. Can be overridden in Settings (kept in `data/account.json`). |
| `SPEECH_CLIPS_BACKEND` | `aiservant` (AIServant's `/SpeechClips` API) or `local` (a stand-in under `data/speech/`, same rules) |
| `CARTESIA_API_KEY` | Optional. Generating clips in the voice library. |
| `CARTESIA_MODEL`, `CARTESIA_VERSION` | Optional. Default `sonic-3.6` and `2026-08-14`. |
| `CALLFLOW_DATA_DIR` | Optional. Where the local server keeps its files (default `./data`). |

### `data/` (git-ignored)

| File | What |
|---|---|
| `state.json` (+ `state.prev.json`) | The workspace: scripts, agents, settings. Written on every change. At startup, the newer of disk and browser wins. |
| `account.json` | The account chosen in Settings, if not the `.env` one |
| `calls.jsonl` | Every makecall request and AIServant's answer (a debug log) |
| `live/<callId>.json` | Everything recorded about a followed call: status, transcript, script events |
| `recordings/<callId>.mp3` | Finished calls' recordings, fetched once from AIServant |
| `speech/<agency>/…` | Voice-library stand-in data (local backend), and word timings saved from the studio |

---

## Architecture

```
Browser (React 19, Vite)                     Local server (Node, server/*.js)             Outside
────────────────────────                     ─────────────────────────────────            ───────
editor, live view, voice library  ──HTTP──▶  /local-api/*                          ──▶   AIServant (REST + WebSocket)
                                   ◀─SSE──   adds X-Api-Key / X-Agency-Id,         ──▶   Cartesia (TTS)
                                              signs listen tickets, keeps data/
AI chat (builder agent) ──────────────────────────────────────────────────────────▶   fast-brain LLM (user's own key)
```

The browser never sees the AIServant secret or the Cartesia key. The account (`X-Agency-Id`) is always decided
on the server, never taken from a browser request. The only call the browser makes outside localhost is the
AI chat's LLM request, with the key the user typed in Settings.

### Source map

```
index.html, src/main.jsx      boot: load state from disk, start disk sync, mount <App>
src/App.jsx                   two layouts: the editor (#/studio, #/agents) and the voice library page (#/voices)

src/lib/core.js               the workspace model (flows, nodes, edges), node types, undo/redo, auto-layout, routes, event bus
src/lib/useCF.js              React hook: re-render on any emitted event
src/lib/canvas.js             the diagram: pan/zoom, drag, connect ports, edge drawing, live-call highlighting
src/lib/script.js             flow ⇄ instructionTree, the makecall body, validation (AIServant's rules + editor warnings)
src/lib/templates.js          ready sales scripts
src/lib/files.js              import/export of studio files (.json) and instructionTree files
src/lib/localStore.js         disk persistence through /local-api/state (localStorage is a cache)
src/lib/settings.js           settings + the account; speechMs (how long a starter sounds)
src/lib/agents.js             agents: flow + Cartesia voice + personality
src/lib/dialer.js             placeCall → /local-api/makecall
src/lib/liveCalls.js          the live/replayed call shown in the panel and on the canvas; replay sync
src/lib/speechClips.js        voice library client (tables, clips, Cartesia)
src/lib/audioEdit.js          decode / waveform / cut / μ-law WAV encode / mic recording / word-timing helpers
src/lib/chat.js               the AI chat's message store
src/lib/builder.js            the builder agent: LLM loop with tools, approvals, cost meter
src/lib/agentOps.js           the agent's tools on the flow (add_step, connect, …) in AIServant vocabulary
src/lib/computer.js           the agent's visible mouse and keyboard (read_screen / click / type)
src/lib/pricing.js            fast-brain model ids, prices, model list, token count
src/lib/assistant.js          the rule-based chat helper used when there is no fast-brain key

src/pages/Workspace.jsx       the editor: canvas, toolbar, step editor, flow panel, chat
src/pages/Agents.jsx          agents (over the editor)
src/pages/Voices.jsx          the voice library
src/components/*              Canvas, Toolbar, Inspector (step editor), FlowPanel (flow-wide instructions, global
                              arrows, tools), ExportModal + DialPanel (JSON and real calls), LiveCall (live panel,
                              calls list, replay player), WaveEditor, Settings, Menu, Chat, AgentCursor, Icon, TopNav
src/styles/studio.css         design tokens, canvas, toolbar, chat, agents
src/styles/app.css            everything else

server/local-api.js           the /local-api routes (below)
server/live-calls.js          following calls: polling + the listen WebSocket, SSE to browsers, data/live
server/speech-clips.js        voice library backends (AIServant / local stand-in) and Cartesia generation
server/account.js             the account (.env default or set by hand)
vite.config.js                reads .env, mounts the local server
```

---

## The script model

A **flow** in the studio is a diagram. `script.js` turns it into AIServant's `instructionTree` (`buildTree`), and
back (`treeToFlow`, used by import).

```js
flow = {
  id, name, business,
  nodes: [{ id, type, key, title, text, starter, maxVisits, x, y, ...typeFields }],
  edges: [{ id, from, port, to }],           // port: option id | 'out' | 'failed' | 'answered' | 'fallback'
  instructions: { personality, context, goldenRules, hotWords, values: [{ key, value }], mode: 'tree' | 'text', text },
  globalArrows: [{ id, when, examples: [], to }],
  aiTools: [{ name, description, url, timeoutMs, shouldInvokeAnswer, params: [{ name, type, description, required }] }],
}
```

| Studio node `type` | instructionTree `kind` | Arrows (`{ when, description?, to }`) |
|---|---|---|
| `start` / `say` | `say` | one: `when` = the expected reaction (default "ממשיך") |
| `ask` ("החלטה") | `ask` (+ `slot`) | one per option (`when` = option label, `description` = its phrasings joined by ", "); or a single `answered` (free answer); optional `unclear` |
| `action` | `action` (+ `tool`) | `ok`, `failed` |
| `end` | `end` | none |

Field mapping: `key` → step `id`, `title` → `goal`, `text` → `context`, `starter`, `maxVisits`.

The format itself is defined by AIServant: the call-script spec document from Yoav ("the format doc"; code comments
cite its sections, e.g. §7 validation and §8 makecall), and the server's OpenAPI at `{YOAVHAIK_API_BASE_URL}/openapi/v1.json`.
`{name}` placeholders in texts are filled from `instructions.values`.

The makecall body (`buildMakeCall`) looks like this:

```js
{
  apiKey,                    // the account uid, forced by the server
  to,
  cartesiaSettings: { voice, voiceGender },
  leadInfo: { name },
  aiTools,                   // the flow's webhook tools; the dialer's built-ins are never sent
  instructions: { personality, context, goldenRules, hotWords, values, instructionTree },
}
```

AIServant accepts `instructionTree` **or** the legacy `text`, exactly one of them. The studio sends the tree unless
a flow is switched to text mode.

**Validation.** `validate()` runs on every change. It applies the rules AIServant enforces (it answers `400
Invalid script:` otherwise): one start step, reachable steps, unique ids and slots, reserved words (`answered`,
`unclear`, `ok`, `failed`, `none`), tools that exist, and so on. It also adds editor warnings:
- starters that don't fit every arrow leading to their step;
- options that aren't connected;
- duplicate arrow names in one scope (only the first can ever be taken);
- placeholder tool URLs.

A script with errors can't be dialed.

**Agents** (`agents.js`) attach a voice and a personality to a flow. An agent's `cartesiaVoiceId` wins over the
default voice in Settings. Its personality is written into `instructions.personality` when the flow has none.

---

## Talking to AIServant (Yoav's server)

**Auth.** Every request from the local server carries:
- `X-Api-Key: <AISERVANT_SHARED_SECRET>`;
- `X-Agency-Id: <account uid>`.

The live socket authenticates with a signed ticket instead (below).

| Purpose | AIServant endpoint | Used by |
|---|---|---|
| Place a call | `POST /sip/makecall` (body above) → `{ callId, … }` | `/local-api/makecall` |
| A call's status, transcript, state reports | `GET /Calls/{callId}` | live tracking (polled every 1.5 s), `/local-api/call/:id` |
| Call history | `GET /Calls?limit=…` (and `&status=…`) | the calls list in the toolbar |
| Recording | `GET /Calls/{callId}/recording` → MP3, 2 channels (agent / customer), 8 kHz | replay |
| Live events and audio | WebSocket `/Conversation/listen/ws` | live tracking |
| Minutes left | `GET /Credits/{agency}/balance` | the AI chat before a real call |
| Voice library | `/SpeechClips/…` (below) | `#/voices` |

### Placing a call

The dial window (toolbar **"שיחת בדיקה"**, or Export → "חיוג אמיתי") builds the makecall body for the open flow
and sends it to `POST /local-api/makecall`. Then the local server:
1. forces `apiKey` to the server's account and adds the auth headers;
2. forwards the body to `/sip/makecall`;
3. logs the request and the answer to `data/calls.jsonl`;
4. on success, starts following the new `callId`.

AIServant's answer is shown as it is, including `400 Invalid script:` and ASP.NET validation errors.

### Following a call live (`server/live-calls.js`)

For each followed call, the server does two things at once:

1. **Polls `GET /Calls/{callId}`** every 1.5 s for status (`pending | active | ended | failed`), the transcript
   and state reports. It keeps listening 20 s after the end, for the final events.
2. **Listens on `wss://…/Conversation/listen/ws`.**
   - The first frame is `{ ticket, callid, events }`.
   - `ticket` is an HS256 JWT `{ agencyId, callId, scope: "listen", exp }`, signed with the shared secret,
     minted per connection with a 60 s expiry. It never leaves the server.
   - The socket can connect while the call rings; events start at answer, and the transcript so far is replayed first.
   - Events used: `transcript`, `tentative_transcript`, `start_speech` / `end_speech`, `call_answered`,
     `call_ending`, `call_closed`, `voicemail`, `state_report`, `tool_call_start` / `tool_call_end`, and the script ones:
     - `script_moved` `{ From, To, Pick, Likelihood, Path, Slots, Tools, TurnsOffScript }`: the decision model's
       pick on each caller turn;
     - `script_result` `{ FinalStep, Path, Slots, Tools, … }`: the outcome.
   - Listening in: subscribe to `audio`, then relay the browser's WebRTC offer and ICE through
     `/local-api/live/:id/rtc` (`webrtc_offer`, `webrtc_answer`, `ice_candidate`).

Browsers get a snapshot from `GET /local-api/live/:id` and updates from `GET /local-api/live/:id/stream`
(Server-Sent Events). Every record is saved to `data/live/<callId>.json`.

**Replay** plays `GET /local-api/live/:id/recording`: the recording is fetched once and served from disk with
Range. The diagram moves with the audio:
- the recording starts at the call's `startTime` (answer);
- `script_moved` events carry the local server's receive time;
- transcript lines carry AIServant's time (the end of the utterance);
- `liveCalls.js` aligns the two clocks by the median offset over transcript events.

A call has step data only if the studio followed it live.

**How the AIServant side behaves today**
- **Moves.** The position in the script moves only on a caller turn or a tool result. So a `say` step waits for
  the caller to say something, and no `script_moved` arrives at call start.
- **Pending change.** Asked of Yoav on 2026-11-25 ("option A"):
  - a one-arrow `say` step continues straight into the next step, in the same reply;
  - a `script_moved` comes at call start (`From` empty, `To` = start).
- **Arrow `description`.** The decision model reads it to decide whether an arrow was taken; `when` stays the slot value.
- **Duplicate `when`.** With two arrows of the same `when` in one scope, only the first can be taken. A step arrow
  with the same `when` as a global arrow overrides it on that step.

### Voice library (`/SpeechClips`, `server/speech-clips.js`)

Each account has two tables, `starter` and `reaction`. A table is a list of options
`{ name, description (English, read by the decision model), texts[] }`.

**Required options** (the studio locks them):
- `starter`: `understood`, `understood_long`, `great_question`, `good_question`;
- `reaction`: `understood`, with at least 2 texts.

`none` is AIServant's own and must not be sent.

Each text gets a clip per Cartesia voice (a GUID):
- the audio is a mono WAV: 16-bit PCM at 16 or 24 kHz, or μ-law at 8 kHz. The studio always produces **8 kHz μ-law**;
- the clip comes with word timestamps `{ words, start, end }` (seconds). AIServant uses them to know how much of a
  starter the caller heard before interrupting.

| AIServant | Local route |
|---|---|
| `GET /SpeechClips/{kind}/table` (the account's, or the built-in) | `GET /local-api/speech/:kind/table` |
| `PUT /SpeechClips/{kind}/table` (204, or 400 with a plain-text reason) | `PUT /local-api/speech/:kind/table` |
| `PUT /SpeechClips/{voiceId}/{kind}/clip`: multipart `text`, `audio`, `timestamps` (a JSON string) | `PUT /local-api/speech/:voice/:kind/clip` (JSON with base64 audio; the server builds the multipart) |
| `GET /SpeechClips/{voiceId}/{kind}/clip?text=` (200 WAV / 404) | `GET /local-api/speech/:voice/:kind/clip?text=` |
| no list endpoint: one GET per text | `POST /local-api/speech/:voice/:kind/status` |

AIServant doesn't return a clip's timestamps. The local server keeps the ones it saved
(`GET /local-api/speech/:voice/:kind/timestamps`), so a saved clip reopens with its own timings.

**Generating with Cartesia.** `POST https://api.cartesia.ai/tts/sse` with:
- `Authorization: Bearer …` and `Cartesia-Version`;
- `output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 }`;
- `add_timestamps: true`, `language: "he"`.

The audio chunks are wrapped into a WAV, and the timestamps come back with it. The user can type what Cartesia
should say (different spelling, niqqud, `[laughter]`). The clip is still saved under the table's text.

**Recordings and uploads** are decoded in the browser, cut, resampled to 8 kHz μ-law, and given estimated word
timings that the user drags into place on the waveform.

---

## Local API reference (`server/local-api.js`)

Every route answers only pages from this machine: requests whose `Origin` is not localhost are refused.

| Route | |
|---|---|
| `GET /local-api/info` | `{ hasSecret, agencyId, envAgencyId, agencyOverridden, api, dataDir, savedAt }` |
| `PUT /local-api/account` | `{ agencyId }`: set the account ('' = back to `.env`) |
| `GET/PUT /local-api/state` | the workspace (`data/state.json`, written atomically) |
| `GET /local-api/balance` | AIServant minutes left |
| `GET /local-api/calls` | the makecall log |
| `POST /local-api/makecall` | `{ flowName, flowId, body }` → AIServant `/sip/makecall` |
| `GET /local-api/call/:id` | AIServant `GET /Calls/{id}` as is |
| `GET /local-api/live` | history (AIServant `GET /Calls`) + followed calls |
| `GET /local-api/live/:id`, `…/stream` | a call's record; SSE updates |
| `POST /local-api/live/:id/watch` | start following a call |
| `POST /local-api/live/:id/rtc` | WebRTC signalling for listening in |
| `GET /local-api/live/:id/recording` | the recording (cached, Range) |
| `GET /local-api/speech/config` | `{ backend, tts, ttsModel }` |
| `…/speech/:kind/table`, `…/speech/:voice/:kind/(clip,status,timestamps)`, `POST …/speech/tts` | voice library (above) |

---

## The AI chat

**With a fast-brain key** (Settings → מוח מהיר), the chat runs `builder.js`. It is an LLM agent with function calling.
- **Tools on the open flow:** `add_step`, `connect`, `set_instructions`, `validate`, …
- **Tools on the app, like a person:** `read_screen`, `click`, `type`, `navigate`, with a visible cursor.
- **Real calls:** `real_call`, `get_call_result`, `check_balance`.

Before a run the user sees the model and the estimated cost. During the run, every change appears live on the diagram.

**Hard rules, enforced in code, not left to the model:**
- a plan must be approved before building into an empty flow;
- deleting, loading a template over work, and real calls need an explicit approval card;
- real calls only go to a number the user typed in the chat, and only for a script without errors.

The provider is Google's Generative Language API: model ids and prices are in `pricing.js`. The request goes
straight from the browser with the user's key.

**Without a key**, `assistant.js` answers simple Hebrew commands by pattern matching. For example: build from a
template, add a question or an option, set a starter, open the dial window.

---

## Security notes

- **Secrets stay on the server.** The AIServant secret and the Cartesia key never reach the browser bundle or a
  response. The listen ticket is minted per connection and expires in 60 s.
- **The account is server-side.** `X-Agency-Id`, and makecall's `apiKey`, always come from the server config.
- **Only this machine.** The local API refuses requests from other origins. Don't expose the dev server to a
  network: `npm run dev` binds to localhost.
- **`data/` holds private data:** transcripts, phone numbers in `calls.jsonl`, recordings, and the fast-brain key
  inside `state.json`. It is git-ignored; keep it out of shared copies.
