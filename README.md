# 🪑 ThirdChair

**The AI teammate at the table.** ThirdChair sits in your meeting, listens to everything, and when someone says *"hey copilot, what did we decide about pricing?"* — it answers **out loud**, grounded in the actual conversation, in about a second.

No bot joining your call. No recording uploaded anywhere. One browser tab, streaming end to end.

```
you speak ──► ElevenLabs Scribe v2 Realtime (STT, ~150 ms)
                    │ rolling transcript
   wake phrase ─────┤
                    ▼
              Claude (streaming, sentence by sentence)
                    ▼
        ElevenLabs Flash v2.5 (TTS websocket, raw PCM)
                    ▼
              your speakers 🔊
```

Every hop is a websocket and the audio stays raw PCM on both sides — no file encoding, no polling, no batch steps. Claude's first sentence is being spoken while the rest is still generating.

## What it does

- **Always listening** — live transcription of your mic, with interim (partial) text in the UI and VAD-committed segments in the rolling transcript.
- **Hears the whole meeting, not just you** — click *"+ Meeting tab audio"* and share your Google Meet / Zoom tab; its audio is mixed into the same transcript. Everyone's words become context.
- **Wake phrase, fuzzy-matched** — "hey copilot", "hey co-pilot", "hey, copilot…" all work. Say the phrase alone and it waits for your question.
- **Grounded answers** — "what did we decide", "who owns the follow-up", "summarize the last ten minutes" are answered from the transcript with timestamps, not hallucinated.
- **Speaks in 2–3 sentences** — answers are generated in spoken style and streamed sentence-by-sentence into TTS, so time-to-first-word stays low.
- **Barge-in** — say the wake phrase again (or hit *Stop speaking*) while it's talking and it shuts up instantly and listens.
- **Echo-aware** — mic capture runs with echo cancellation, and anything transcribed while ThirdChair itself is speaking is flagged so it doesn't take its own voice as meeting content.

## Quickstart

You need an [ElevenLabs API key](https://elevenlabs.io/) and an [Anthropic API key](https://console.anthropic.com/).

```bash
git clone https://github.com/YOURNAME/thirdchair
cd thirdchair
npm install
cp .env.example .env   # put your two keys in
npm run dev
```

Open the Vite URL it prints (default `http://localhost:5173`), click **Start listening**, allow the mic, and say:

> "Hey copilot — introduce yourself."

For production-style serving from a single port:

```bash
npm run build
npm start        # serves the built UI + websocket on :8787
```

## Using it in a real meeting

1. Join your meeting in the browser as usual.
2. In the ThirdChair tab, **Start listening**, then **+ Meeting tab audio** and pick the meeting tab (tick *"also share tab audio"* in Chrome's picker).
3. ThirdChair now transcribes both you and everyone else. Address it out loud whenever you need it; the answer plays through your speakers, so the room hears it through your mic.

> **Consent matters.** ThirdChair transcribes conversations. Many jurisdictions require all-party consent to record or transcribe a call — tell your meeting you're running it. Nothing is stored server-side; the transcript lives in memory for the session and dies with it.

## Configuration

Everything is in `.env`:

| Variable | Default | What it does |
|---|---|---|
| `ELEVENLABS_API_KEY` | — | STT (Scribe v2 Realtime) + TTS (Flash v2.5) |
| `ANTHROPIC_API_KEY` | — | The answering brain |
| `ELEVENLABS_VOICE_ID` | Rachel | Any voice from your ElevenLabs voice library |
| `WAKE_PHRASE` | `hey copilot` | Whatever you want to call it |
| `THIRDCHAIR_MODEL` | `claude-opus-5` | Claude model for answers |
| `THIRDCHAIR_EFFORT` | `low` | `low` = fastest spoken answers, `high` = deepest reasoning |
| `PORT` | `8787` | Server port |

## Architecture

```
web/            browser client (Vite, no framework)
  capture       mic + shared-tab audio → AudioWorklet → 16 kHz Int16 PCM → ws
  playback      24 kHz Int16 PCM chunks scheduled gaplessly via Web Audio
server/         Node + TypeScript
  stt.ts        ElevenLabs Scribe v2 Realtime websocket (VAD commit strategy)
  transcript.ts rolling in-memory transcript with timestamps
  trigger.ts    fuzzy wake-phrase matching + "wake alone, question next" flow
  brain.ts      Claude streaming answer, spoken-style system prompt
  tts.ts        Flash v2.5 stream-input websocket + sentence chunker
  session.ts    one browser connection = one session; wires it all together
shared/         websocket protocol types shared by both sides
```

Latency budget per answer: STT commit (~150 ms after you stop) → Claude first sentence (streamed) → Flash TTS first audio (~75 ms model latency) → playback. In practice the voice starts within roughly a second of you finishing the question.

## Roadmap

- [ ] Headless bot mode: join Meet/Zoom as a participant (Recall.ai or livekit)
- [ ] Tool use: let it check your calendar / docs / tickets before answering
- [ ] Per-speaker diarization in the transcript
- [ ] "Meeting minutes" export at session end
- [ ] Interrupt-free whisper mode (answer only in the UI, no voice)

PRs welcome — the codebase is deliberately small and readable.

## License

MIT
