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
- **Hears the whole meeting, not just you** — click *"+ Meeting tab audio"* and share your Google Meet / Zoom tab. Its audio becomes a second transcript channel, so every line is attributed: **You** vs **Room**.
- **Wake phrase, fuzzy-matched** — "hey copilot", "hey co-pilot", "hey, copilot…" all work. Say the phrase alone and it waits for your question.
- **Grounded answers** — "what did we decide", "who owns the follow-up", "summarize the last ten minutes" are answered from the transcript with timestamps, not hallucinated.
- **Speaks in 2–3 sentences** — answers are generated in spoken style and streamed sentence-by-sentence into TTS, so time-to-first-word stays low.
- **Barge-in** — say the wake phrase again (or hit *Stop speaking*) while it's talking and it shuts up instantly and listens.
- **Echo-aware** — mic capture runs with echo cancellation, and anything transcribed while ThirdChair itself is speaking is flagged so it doesn't take its own voice as meeting content.
- **Transcript export** — one click downloads the speaker-attributed, timestamped transcript for minutes/notes.

## Quickstart

You need an [ElevenLabs API key](https://elevenlabs.io/) (free tier works) and a brain — [Anthropic](https://console.anthropic.com/) by default, or a **free** one (see below).

```bash
git clone https://github.com/RudraMantri123/thirdchair
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

## Run it 100% free

No key can be bundled with the repo — but the whole stack runs free, two ways:

### Zero keys at all (fully local — macOS, Linux, Windows)

Two pieces: whisper.cpp for listening, and whatever speech engine your OS
already ships for talking.

**1. Install whisper.cpp**

```bash
brew install whisper-cpp                      # macOS
```
On **Linux**, check your distro first, otherwise build it:
```bash
git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp
cmake -B build && cmake --build build -j --config Release
# put build/bin on PATH, or set WHISPER_SERVER_BIN to the server binary
```
On **Windows**, download a release build from
[whisper.cpp/releases](https://github.com/ggerganov/whisper.cpp/releases) and set
`WHISPER_SERVER_BIN` to the extracted server executable.

**2. Get the model** (same on every OS)

```bash
curl -L --create-dirs -o ~/.cache/whisper/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

`small.en` is the default because it is much more robust in the conditions a
real room produces, and the latency cost is negligible — both measured on an
M-series Mac (`scripts/ingest-eval.ts`, `scripts/stt-latency-eval.ts`):

| | clean | office noise | quiet speaker | latency / utterance |
|---|---|---|---|---|
| `base.en` (~150 MB) | 15.2% | 21.7% | 26.1% | 78 ms |
| `small.en` (~490 MB) | **17.4%** | **15.2%** | **17.4%** | 130 ms |

base.en edges it on pristine audio, but meetings are not pristine. Set
`WHISPER_MODEL` to `ggml-base.en.bin` on a slow machine.

**3. Check and run**

```bash
npm run doctor        # says exactly what's missing, if anything
npm run voice:local   # starts whisper-server on :8788
```

Then set `THIRDCHAIR_VOICE=local` in `.env` (already the default when no
ElevenLabs key is present) plus a free brain (below). Nothing leaves your
machine.

**Speech output** uses the engine your OS already has, so there is usually
nothing to install:

| OS | Engine | Notes |
|---|---|---|
| macOS | `say` | Always present. Emits our target rate directly. |
| Linux | `piper` › `espeak-ng` › `espeak` | `sudo apt install espeak-ng` for the quick option. For much better voices install [piper](https://github.com/rhasspy/piper) and set `PIPER_MODEL=/path/to/voice.onnx`. |
| Windows | PowerShell `System.Speech` | Always present. |
| anything | `THIRDCHAIR_TTS_CMD` | Escape hatch: any command taking `-w <out.wav> -f <text.txt>`. |

Whatever the engine emits is normalized to mono 16-bit PCM at one rate by
`server/audio/speech.ts`, so the rest of the pipeline never sees the
difference. Text is always passed to these engines through a temp **file**,
never interpolated into a shell or PowerShell command — meeting speech is
untrusted input and must never be parsed as code.

> Corporate network blocking Hugging Face? Fetch OpenAI's original weights from
> their own CDN and convert them with whisper.cpp's
> `models/convert-pt-to-ggml.py`.

Verify the whole loop without a microphone: `npx tsx scripts/e2e-voice-test.ts` synthesizes a spoken question, streams it in as fake mic audio, and prints every event through to the spoken answer.

### Free tiers (better quality)

- **Voice (STT + TTS):** the ElevenLabs **free tier** includes enough credits for real testing — sign up and copy the key.
- **Brain, option A — Groq (free tier, very fast):** grab a free key at [console.groq.com/keys](https://console.groq.com/keys) (no card), then in `.env`:

  ```
  THIRDCHAIR_BRAIN=groq
  GROQ_API_KEY=gsk_...
  ```

- **Brain, option B — Ollama (no key at all, fully local):** install [Ollama](https://ollama.com), run `ollama pull llama3.2`, then in `.env`:

  ```
  THIRDCHAIR_BRAIN=ollama
  ```

Claude gives the best grounded answers; Groq is the best free-and-fast option; Ollama is the private/offline option. All three stream sentence-by-sentence into the same TTS pipeline.

## Using it in a real meeting

1. Join your meeting in the browser as usual.
2. In the ThirdChair tab, **Start listening**, then **+ Meeting tab audio** and pick the meeting tab (tick *"also share tab audio"* in Chrome's picker).
3. ThirdChair now transcribes both you and everyone else. Address it out loud whenever you need it; the answer plays through your speakers, so the room hears it through your mic.

> **Consent matters.** ThirdChair transcribes conversations. Many jurisdictions require all-party consent to record or transcribe a call — tell your meeting you're running it. Nothing is stored server-side; the transcript lives in memory for the session and dies with it.

## Configuration

Everything is in `.env`:

| Variable | Default | What it does |
|---|---|---|
| `THIRDCHAIR_VOICE` | auto | `elevenlabs` when a key is set, else `local` (whisper.cpp + macOS say) |
| `ELEVENLABS_API_KEY` | — | STT (Scribe v2 Realtime) + TTS (Flash v2.5) |
| `WHISPER_URL` | `http://localhost:8788` | whisper-server endpoint for local voice |
| `THIRDCHAIR_VAD_THRESHOLD` | `600` | Mic energy gate for local voice detection |
| `THIRDCHAIR_BRAIN` | `claude` | `claude`, `groq` (free tier), or `ollama` (free, local, keyless) |
| `ANTHROPIC_API_KEY` | — | Required when brain is `claude` |
| `GROQ_API_KEY` | — | Required when brain is `groq` (free at console.groq.com) |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Any Groq-hosted model |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `localhost:11434` / `llama3.2` | Local Ollama endpoint and model |
| `OLLAMA_NUM_CTX` | `8192` | Context window (sizes the KV cache). Measured, see [Memory footprint](#memory-footprint); `6144` fits ordinary talk. A prompt that would not fit grows it instead of being truncated |
| `THIRDCHAIR_OLLAMA_LIFECYCLE` | `session` | `session`: load the model when listening starts, release it when the last session stops. `daemon`: leave it to Ollama's keep-alive |
| `THIRDCHAIR_OLLAMA_LEASE_MIN` | `10` | keep_alive lease while a meeting is live, renewed at half this interval |
| `THIRDCHAIR_PROFILE` | `default` | `low-memory`: `qwen2.5:1.5b` and whisper `base.en` (q5_1 if present) unless set explicitly. Costs answer quality; see below |
| `ELEVENLABS_VOICE_ID` | Rachel | Any voice from your ElevenLabs voice library |
| `WAKE_PHRASE` | `hey copilot` | Whatever you want to call it |
| `THIRDCHAIR_MODEL` | `claude-opus-5` | Claude model for answers |
| `THIRDCHAIR_EFFORT` | `low` | `low` = fastest spoken answers, `high` = deepest reasoning |
| `PORT` | `8787` | Server port |
| `THIRDCHAIR_STT_CONNECT_TIMEOUT_MS` | `5000` | Cloud STT connect deadline; a miss falls back to local whisper.cpp |
| `THIRDCHAIR_STT_COMMIT_TIMEOUT_MS` | `8000` | Local: per-utterance whisper call. Cloud: last partial → commit (the partial is promoted on a miss) |
| `THIRDCHAIR_LLM_FIRST_TOKEN_TIMEOUT_MS` | `2500` | No token by then → speak "One moment." and keep waiting |
| `THIRDCHAIR_LLM_TOTAL_TIMEOUT_MS` | `25000` | Whole answer; a miss aborts it and speaks an apology |
| `THIRDCHAIR_TTS_FIRST_BYTE_TIMEOUT_MS` | `4000` | Cloud: falls back to local speech. Local: continues as text |
| `THIRDCHAIR_LATENCY_LOG` | `logs/latency.jsonl` | Per-turn latency records (JSONL); `off` disables |
| `THIRDCHAIR_RECORD` / `THIRDCHAIR_RECORD_DIR` | off / `recordings` | Record each session's input audio for replay |
| `THIRDCHAIR_SAY_VOICE` | system default | macOS `say` voice; a silent default voice is detected and replaced with Samantha |
| `ELEVENLABS_WS_BASE` | `wss://api.elevenlabs.io` | Override for fault injection (e.g. `ws://127.0.0.1:1` forces both fallbacks) |

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
  session.ts    one browser connection = one session; wires it all together,
                per-turn deadlines, fallbacks, holding phrase
  latency.ts    per-turn monotonic marks, p50/p95, JSONL turn log
  recording.ts  opt-in input recording for scripts/replay.ts
  ollama.ts     local model lifecycle + context-window guard (see Memory footprint)
shared/         websocket protocol types shared by both sides
```

Latency budget per answer: STT commit (~150 ms after you stop) → Claude first sentence (streamed) → Flash TTS first audio (~75 ms model latency) → playback. In practice the voice starts within roughly a second of you finishing the question.

Per-component numbers measured on the local path: [Latency budget & resilience](#latency-budget--resilience).

### Input audio: what we control, and what only the OS can

Transcription quality is decided before a single byte reaches the model. The
capture path is short but every stage can quietly ruin the signal, and several
of the biggest levers are not ours at all — they belong to the operating
system.

**What the pipeline does now**

| Stage | Choice | Why |
|---|---|---|
| Sample rate | `AudioContext({sampleRate: 16000})` | Delegates resampling from the device's native 48 kHz to the browser's own resampler. We previously decimated 3:1 with linear interpolation and **no lowpass** — a 10 kHz tone folded back to 6 kHz at *half* its amplitude. Never decimate without filtering. |
| Fallback | windowed-sinc in the worklet | Safari/Firefox may refuse a 16 kHz context. Falling back to "no resampling" would emit 48 kHz audio labelled 16 kHz — 3× too fast and unintelligible. |
| Voice detection | noise-floor-relative, minimum statistics | A fixed threshold both misses soft talkers and false-triggers in a loud room. Measured 7/10 → 9/10 across simulated conditions. |
| Pre-roll | 1 s ring per channel | Energy VAD is late by construction; without it the wake phrase gets clipped and the question is lost. 32 kB. |
| Int16 cast | clamp before scaling | An out-of-range float wraps on cast, turning a loud peak into full-scale noise of the *opposite sign*. |
| Feedback | one-shot notices | Clipping and too-low level are user-fixable, so we say so — once, not as a nag. |

Reproduce with `npx tsx scripts/vad-eval.ts` and
`npx tsx scripts/resample-quality-eval.ts`.

**Where the OS is doing the heavy lifting**

The single best noise suppression available to this app is not in this app.
Every desktop OS ships voice processing below the browser, and it is better
than anything reachable from inside a page:

| OS | Feature | Where the user turns it on |
|---|---|---|
| macOS | Voice Isolation (Core Audio `AUVoiceIO`) | Control Centre → Mic Mode, while the mic is live |
| Windows | Voice Focus / audio enhancements | Settings → System → Sound → the input device |
| Linux | PipeWire/PulseAudio WebRTC echo-cancel | `pactl load-module module-echo-cancel`, then select that source |

The app detects your platform and names the right one, rather than assuming
macOS.

This matters concretely: the one condition our detector still fails is a quiet
talker in a room louder than they are (~4 dB SNR). No threshold fixes that,
because the information isn't in the signal. OS voice processing fixes it by
*removing the room* — which is why the app points at it instead of pretending a
better heuristic would do.

Other places the OS decides quality for you:

- **The device rate is not your choice.** Consumer audio hardware runs at 44.1
  or 48 kHz (every input on the Mac this was built on reports 48 kHz), so
  *something* always resamples to the 16 kHz speech models want. Better the
  platform's optimized resampler than a hand-rolled loop on the audio thread.
- **Bluetooth is the biggest single quality loss.** When a headset's mic
  becomes active the link drops to a narrowband, heavily compressed voice
  profile — no amount of downstream processing recovers it. The app now
  detects this and says so; the fix is choosing the built-in mic.
- **The browser sandbox caps what a web app can reach.** From a page you get
  WebRTC's AEC/NS/AGC via `getUserMedia` constraints and nothing more. A native
  helper could use the voice-processing unit directly, pick a specific
  `AudioDeviceID`, and set the IO buffer size.
- **System audio capture is an OS capability, not a web one.** We use
  `getDisplayMedia` and ask the user to tick "share tab audio", which is clumsy
  and tab-scoped — but it is the one route that works identically on all three
  platforms, which is why it's what ships. Each OS has a better native answer:
  macOS ScreenCaptureKit (`SCStream` audio, 13+) or Core Audio process taps
  (`AudioHardwareCreateProcessTap`, 14.2+); Windows WASAPI loopback; Linux a
  PipeWire monitor source. All capture per-app audio with no virtual driver
  (BlackHole, VB-Cable). On the roadmap as an optional native helper.
- **Permissions are the OS's, and they fail closed.** Mic access — and, for any
  screen/system audio route, screen-recording permission — are separate grants
  on macOS (TCC) and Windows, and a portal prompt under Wayland. Denial looks
  like *silence*, not an error, which is why the app reports what it actually
  received instead of assuming it got what it asked for.
- **Long meetings fight power management.** An hour-long session can be cut
  short by idle sleep, and background-tab throttling starves timers. The
  per-OS fix differs (`IOPMAssertion` / `caffeinate` on macOS,
  `SetThreadExecutionState` on Windows, a `systemd-inhibit` lock on Linux), so
  it belongs in a native helper rather than the page.
- **The audio thread is real-time and unforgiving.** The AudioWorklet runs on a
  high-priority render thread where a missed deadline is a dropout, not a
  slowdown — which is the other reason resampling belongs to the platform's
  optimized code rather than to a JS loop in `process()`.

**If you want the best possible input today**, in order of effect: use a wired
or built-in mic rather than Bluetooth; turn on Voice Isolation in Control
Centre; get within about arm's length of the mic; and share the meeting tab's
audio so remote participants are captured directly instead of through your
speakers and back into your mic.

### Memory: how an hour of speech becomes a prompt

`server/memory/` is the part worth reading. It exists because the obvious
implementation — keep a rolling transcript, slide a window over it, paste it
into every prompt — is pathological, and measurably so:

| | sliding window | append-only segments |
|---|---|---|
| mean prompt eval (local llama3, 50-min meeting) | 9,655 ms | **1,261 ms** |
| worst case | 15,058 ms | **1,737 ms** |
| fact recall over 60 minutes | 43% | **100%** |
| stable-prefix reuse | 0.1% | **79–90%** |

Reproduce with `npx tsx scripts/before-after-eval.ts`.

The governing rule, derived from measurement rather than taste:

> Prompt-eval cost is proportional to the number of tokens **after** the first
> byte that differs from the cached prefix. So order prompt sections by how
> often they change, ascending — and make everything early append-only.

Which gives the layout `system → sealed segments → live tail → retrieved spans
→ question`. Derived context sits next to the question, never in the system
prompt, because a rewrite there costs only its own tokens.

Concretely:

- **Sealed segments.** Every ~40 utterances the tail is sealed at a speaker
  boundary into an immutable segment. Its digest, its verbatim text and its
  decisions are all rendered **once**, at seal time, and never recomputed. The
  prompt is therefore one append-only stream of frozen chunks. This is why the
  new system gets *faster* as a meeting grows while the old one fell off a
  cliff at minute 25.
- **Two profiles.** On Claude a 60-minute meeting is only ~20–35k tokens, so
  nothing is compacted and recall is total. On a local 8k model, sealed
  segments contribute an **extractive** digest — salient lines quoted verbatim
  plus lookup hints. Extractive, not abstractive, because a summarizer LLM call
  would evict the single prompt-cache slot and make the *next* spoken answer
  pay a cold prompt eval. (Verified: two alternating prompt shapes both sit at
  ~5.5 s forever, and `OLLAMA_NUM_PARALLEL=2` does not help.)
- **A decision journal that never forgets or lies.** Decisions, actions and
  blockers are extracted into a bi-temporal journal modeled on Graphiti. When
  someone contradicts an earlier decision, the old claim is *not* deleted — its
  validity window is closed and a new claim appended noting what it revises.
  So "what did we decide about pricing?" gets the current answer, and "when did
  that change?" still works. It also keeps rendered lines immutable, which is
  what protects the cache.
- **Retrieval without embeddings.** BM25 with mem0's query-length-adaptive
  logistic normalization, combined with recency and importance, MMR for
  diversity. An embedding round-trip on the answer path is latency this app
  does not have.
- **Everything on the answer path is arithmetic.** No LLM call, no embedding,
  no I/O between question and first spoken word.

Prior art this borrows from, with thanks: [Graphiti](https://github.com/getzep/graphiti)
(bi-temporal edge invalidation, the deterministic dedup cascade),
[mem0](https://github.com/mem0ai/mem0) (hybrid scoring, entity extraction, the
NONE event), [Letta/MemGPT](https://github.com/letta-ai/letta) (memory tiers,
off-path maintenance, approximate token counting),
[langmem](https://github.com/langchain-ai/langmem) (append-only log with a
derived view), [Haystack](https://github.com/deepset-ai/haystack) (two-fraction
hysteresis, segment-as-atomic-unit), and [Pipecat](https://github.com/pipecat-ai/pipecat)
/ [LiveKit Agents](https://github.com/livekit/agents) (record what was *spoken*,
not what was generated).

### Design notes (patterns borrowed from Recall.ai)

The architecture deliberately mirrors how [Recall.ai](https://docs.recall.ai/docs/real-time-websocket-endpoints) structures meeting bots:

- **Unmixed audio channels, not diarization.** Recall attributes speech by giving you [separate audio streams per participant](https://docs.recall.ai/docs/how-to-get-separate-audio-per-participant-realtime) instead of guessing speakers from a mixed signal. ThirdChair does the same at its scale: the mic and the shared meeting tab travel as separate tagged channels, each with its own Scribe STT stream, so speaker attribution is a property of the stream — free and always correct.
- **Explicit lifecycle states.** Like a Recall bot's `joining → in_call_recording → done` status events, a session here is a state machine (`idle → listening → awaiting_question → thinking → speaking`) and every transition is an event on the wire. The UI renders state; it never infers it.
- **Typed event stream.** Everything between browser and server is a discriminated-union message (`shared/protocol.ts`) — binary frames for audio, JSON events for everything else, one shared type definition on both sides.
- **Reliability semantics.** Server-side ping/terminate heartbeats reap dead sessions; the client reconnects with exponential backoff and re-arms itself mid-meeting.
- **Artifact retrieval.** As with Recall's post-call transcript API, the full speaker-attributed transcript is exportable at any point during the session.

## Latency budget & resilience

Every answer is a **turn** with a latency budget. The server stamps monotonic
marks at each hop — VAD commit → final transcript → wake match → LLM request →
first token → first sentence → TTS request → first audio byte — and the client
reports when the first answer chunk actually becomes audible. Each turn becomes
one JSON line in `logs/latency.jsonl` (schema: `TurnRecord` in
`shared/protocol.ts`), rolling p50/p95 per component are kept in memory, and
the UI shows the last turn as a stacked bar with the running p50/p95.

```bash
npx tsx scripts/latency-report.ts               # table + logs/latency-report.html
THIRDCHAIR_RECORD=1 npm run dev                 # record input audio to recordings/
npx tsx scripts/replay.ts recordings/<f>.tcrec  # replay in real time (--fast, --repeat N)
npx tsx scripts/replay.ts --synth "hey copilot, what is two plus two?" --out recordings/q.tcrec
```

Replay sends the recorded frames through the same websocket and pipeline as a
live session, so it produces the same records and exits non-zero if a turn
fails — usable as a latency regression test.

**Measured on the local path only** — whisper.cpp `base.en` + Ollama
`llama3.2` (3B, Q4_K_M) + macOS `say`, on an Apple M5 Pro. 17 warm turns
replaying one recorded question ("hey copilot, what is two plus two?"); with
n = 17, p95 is effectively the maximum. Playback is reported by the headless
replay client on receipt; one browser turn measured 55 ms there, which
includes the browser's 50 ms jitter lead-in.

| component (ms) | p50 | p95 |
|---|---|---|
| STT (VAD commit → transcript) | 73 | 388 |
| wake / turn overhead | 0 | 2 |
| LLM time to first token | 78 | 176 |
| LLM first token → first sentence to TTS | 109 | 1170 |
| TTS time to first byte (`say`, whole sentence) | 464 | 544 |
| transport / playback (headless) | 0 | 1 |
| **end-to-end, VAD commit → first audio** | **711** | **2120** |

Not included: the local VAD waits 700 ms of silence before it commits, so
add that to get end of speech → first audio. On this path `say` dominates —
it renders a whole sentence before returning any audio — and the p95 tail is
the model's first sentence running long.

Failure handling, each exercised with fault injection on the same machine:

| fault | behaviour | measured |
|---|---|---|
| cloud STT + TTS unreachable (`ELEVENLABS_WS_BASE=ws://127.0.0.1:1`) | both fall back to local for the session; UI shows a *degraded* badge | turns answered at 642 and 760 ms end-to-end |
| cold Ollama (model load) | first-token deadline (2.5 s) speaks "One moment.", answer follows | first token 2848 ms, answer audio at 4036 ms |
| LLM total deadline missed (forced to 90 ms) | answer aborted, apology spoken, back to listening | outcome `llm_timeout` |
| brain unreachable | apology spoken, error shown | outcome `error`, apology audible at 578 ms |
| barge-in | in-flight LLM, TTS and every turn timer cancelled | outcome `barged_in` |

## Memory footprint

On the fully local path three processes hold memory: the Ollama runner (model
weights + KV cache), whisper-server, and ThirdChair's own Node process. All
numbers below were measured on one machine with
`scripts/memory-report.ts`, which samples every process while a replay drives
the real pipeline and prints a table:

```bash
npx tsx scripts/memory-report.ts --run "npx tsx scripts/meeting-regression.ts"
npx tsx scripts/memory-report.ts --duration 30            # just watch
```

"Footprint" is macOS `phys_footprint` (Activity Monitor's *Memory* column):
it includes Metal allocations and compressed pages, which RSS misses — an idle
whisper-server shows ~10 MB RSS while owning ~210 MB. `ollama ps` size is
Ollama's own accounting of weights + KV cache + compute graph.

**Setup.** Apple M5 Pro, 24 GB, Ollama 0.20.7 (Metal; flash attention is
already *auto → enabled* for llama3.2 on this build), llama3.2 3B Q4_K_M,
whisper.cpp `base.en`, macOS `say`. ThirdChair talked to a dedicated Ollama
daemon; **another unrelated benchmark was running on a second Ollama daemon
on the same GPU throughout**, so latency moved by up to a second between
otherwise identical runs; no latency claim below rests on those deltas except
the first-turn model load. Quality and memory
were measured with `scripts/meeting-regression.ts`: an 8-minute synthesized
meeting (70 utterances) that states seven facts in the first minute, buries
them under 45 lines of ordinary talk so they are sealed into history, then
asks about them through the full voice pipeline (VAD → whisper → wake phrase
→ memory → model → voice), scored by keyword.

### Before / after

| | `ollama ps` in meeting | runner footprint | idle (+15 s after the meeting) | regression score | e2e p50 / p95 | 1st-turn TTFT |
|---|---|---|---|---|---|---|
| `main` as shipped — **ran at num_ctx 4096**, see 1. | 2,623 MB | 635 MB | resident until Ollama's 5-min timer | 6/8 | 2,371 / 5,717 ms | 3,729 ms (cold) |
| 1. fixed: num_ctx 8192 actually applied, f16 KV | 3,238 MB | 1,071 MB | 3,238 MB | 6/8 | 1,644 / 4,465 ms | 3,429 ms (cold, 2.1 s load) |
| 2. + KV cache q8_0 (daemon setting) | 2,790 MB | 663 MB | 2,790 MB | 5/8 ¹ | 1,531 / 1,903 ms | ¹ |
| 3. + num_ctx 6144 (opt-in) | 2,578 MB | 546 MB | 2,578 MB | 6/8 | 2,572 / 3,357 ms | 2,143 ms (cold) |
| 4. + session lifecycle, at 6144 | 2,578 MB | 543 MB | **0 MB** | 6/8 | 2,053 / 2,807 ms | 1,300 ms (preloaded) |
| **new defaults: 8192 + q8_0 + session lifecycle** | **2,790 MB** | **662 MB** | **0 MB** | **6/8** | 2,056 / 3,188 ms | **1,250 ms** (preloaded) |
| 5. low-memory profile: `qwen2.5:1.5b` + `base.en-q5_1` (opt-in) | 1,318 MB | 255 MB | 0 MB | 5/8, visibly worse answers | 1,627 / 2,739 ms | 696 ms |
| (rejected) `llama3.2:1b` + `base.en-q5_1` | 1,760 MB | 284 MB | 0 MB | 2/8 | — | — |

ThirdChair's Node process sat at 25–130 MB RSS and 12–20 MB heap in every
configuration; nothing here changes it measurably. whisper-server `base.en`
stayed at 209–283 MB footprint (peaks during inference).

The 6/8 ceiling is the same in every 3B row and is not memory-related: one
question's wake phrase is misheard by `base.en` ("Here couple it…") in every
run, and the 3B model fails "what is the project codeword?" every time, from
an unaltered prompt. ¹ The q8_0 run's first question hit an 11.6 s cold load
(fresh daemon, contended GPU) and was barged in by the next question; the
other six answered questions had the same outcomes as the f16 run.

**What changed, and why each is or isn't a default**

1. **`main` was not applying `num_ctx` at all.** The Ollama brain used the
   OpenAI-compatible endpoint, which ignores `options`, so every request ran
   at Ollama's 4096 default (`ollama ps` during the run: `CONTEXT 4096`).
   Ollama does not reject an oversized prompt: a 1,843-token prompt sent with
   a 1,024 window came back with `prompt_eval_count` 1024, no error, and only
   a `truncating input prompt` line in the daemon log. Prompts in a long
   meeting reach ~5,200 tokens (below), so `main` would have silently
   dropped the start of the meeting — the exact bug that once cut recall to
   43%. The Ollama brain now uses the native `/api/chat`, which honours
   `num_ctx` and `keep_alive` and reports exact prompt token counts. This
   *costs* memory relative to `main` (the fix row), and is not optional.
2. **KV cache q8_0: −448 MB** (KV 896 → 476 MiB at 8192, per the runner's
   own log). Answers unchanged on the regression set. This is an Ollama
   *server* setting, so ThirdChair cannot set it for you — recommended:

   ```bash
   OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 ollama serve
   ```
3. **num_ctx: measured, guarded, and still 8192 by default.** It was sized
   from measurement, not guessed: `scripts/prompt-size-probe.ts` drives the
   memory layer through three 2-hour meetings and has Ollama count every
   rendered prompt with the model's own tokenizer and chat template.

   | 2-hour meeting | largest prompt | at minute |
   |---|---|---|
   | ordinary talk | 5,236 tokens | 80 |
   | half the talk is figures, ticket ids, versions | 7,642 tokens | 98 |
   | every utterance a 30 s monologue (upper bound) | 7,476 tokens | 80 |

   The memory layer caps history, so prompts peak and then plateau rather
   than growing with the meeting. But its cap is a bytes/4 estimate, and
   number-dense talk packs ~1.5x more tokens per byte, which is why that
   meeting peaks highest. 8192 is the measured maximum plus the answer
   reserve, so it stays the default. `OLLAMA_NUM_CTX=6144` fits ordinary talk
   and saves 212 MB at f16 (row 3), ~120 MB at q8_0; when a meeting outgrows
   it, the guard below grows the window once rather than truncating.

   **The guard.** Because a too-small window fails silently, every request is
   now checked before it is sent. The estimate counts word/digit/punctuation
   pieces — bytes per token is useless here, measured anywhere from 2.25
   (figures) to 4.8 (prose) — and is corrected per meeting from the previous
   prompt's exact count, since consecutive prompts share almost all their
   content. Across all three meetings above the corrected estimate never
   under-counted by more than 20 tokens, inside the 256-token answer reserve. It
   does over-count large jumps: in the monologue meeting it asked for 8,324
   tokens of window for a 7,476-token prompt, so that meeting grows to 9,216.
   If prompt + reserve would not fit, the window grows (one model reload,
   logged as `[ctx-guard]`) instead of truncating; after each answer the
   exact count is checked again. Verified by forcing `OLLAMA_NUM_CTX=2048`
   against a 6,723-token prompt with a fact in its first line: the guard grew
   the window to 8192 and the answer contained the fact. Exact count,
   estimate, window and load time are now in every turn record (`llm` in
   `logs/latency.jsonl`).
4. **Session lifecycle (default): idle model memory 2.8 GB → 0.** The model is
   loaded when listening starts (927 ms here, off the answer path), held with
   a renewed 10-minute lease for the meeting, and released with
   `keep_alive: 0` when the last session stops. Before, the model idled for
   five minutes after the last question — and, worse, a meeting quiet for
   more than five minutes unloaded it and paid a cold start on the next
   question. With preloading, the first turn's model load fell from 2,139 ms to
   61 ms (first-turn TTFT 3,429 → 1,250 ms; the rest is evaluating a prompt
   the cache has not seen yet). If a question does arrive while the model is still loading, the
   existing 2.5 s first-token deadline speaks "One moment." (seen in practice: a
   fresh daemon took 11.6 s to load and the phrase covered it; in the 200-session
   leak run below, 27 questions arrived during the preload and all 27 were
   covered by it). Unloading is daemon-wide; set
   `THIRDCHAIR_OLLAMA_LIFECYCLE=daemon` if other tools share the model.
5. **Low-memory profile: opt-in, not default.** `THIRDCHAIR_PROFILE=low-memory`
   halves the model's memory (2,578 → 1,318 MB) with `qwen2.5:1.5b`, but
   answers get worse: 5/8, with rambling, a wrong owner ("You own the security
   questionnaire"), and prompt text leaking into speech. `llama3.2:1b` was
   worse still (2/8, it parroted the decision journal) and was rejected. Use
   it when the alternative is not running at all.

### Speech recognition models

Quantized whisper models were made locally with `whisper-quantize` (no
download needed). Word error rate from `scripts/ingest-eval.ts` (46 words,
6 utterances, the production decode settings), footprint after use,
mean latency on a 7.2 s utterance from `scripts/stt-latency-eval.ts`
(contended GPU, so latency is indicative only):

| model | clean | office noise | quiet speaker | footprint | latency |
|---|---|---|---|---|---|
| `base.en` | 19.6% | 28.3% | 37.0% | 221 MB | 356 ms |
| `base.en-q5_1` | 19.6% | 26.1% | 30.4% | 152 MB | 580 ms |
| `small.en` | 19.6% | 19.6% | 21.7% | 678 MB | 1,291 ms |
| `small.en-q5_1` | 19.6% | 19.6% | 17.4% | **380 MB** | 629 ms |

`small.en-q5_1` matched `small.en` (one word better on the quiet speaker) at
**−298 MB**, so `npm run voice:local` now loads a `-q5_1` copy whenever one
exists next to the model (`scripts/lib/whisper-model.ts`):

```bash
cd ~/.cache/whisper && whisper-quantize ggml-small.en.bin ggml-small.en-q5_1.bin q5_1
```

On a 46-word set one word is 2.2 points, so treat these as "no regression",
not as quantization being *better*. `tiny.en` was not evaluated: no copy was
obtainable on this machine without Hugging Face.

### Leaks and bounded buffers

Two replays, sampled every 10–15 s by `memory-report.ts` with the new
defaults:

| run | turns | ThirdChair heap | ThirdChair RSS | heap trend |
|---|---|---|---|---|
| 200 sessions × 1 question (`replay.ts --repeat 200 --fast`), 13 min | 191 answered ² | 11.3 → 16.1 MB (15.5 at end) | 27–76 MB | +3.6 MB/h |
| one 44-minute meeting, 64 questions, 310 utterances (`meeting-regression.ts --long`), 15 min | 54 answered ³ | 11.5 → 16.3 MB (15.4 at end) | 30–81 MB | +5.7 MB/h |

Trends are least squares after the first quarter (warm-up excluded); both are
flat within GC noise, and nothing needed fixing on the Node side. The model
was loaded and released 200 times in the first run (preload 233–2,185 ms,
200 releases logged, `ollama ps` at 0 when it ended), and whisper-server stayed at
209–283 MB throughout. ² The other 9 runs ended before whisper returned
(the harness's 500 ms settle window, on a contended GPU); none errored.
³ The other 10 questions were never triggered (wake phrase or question
misheard by `base.en`); 42/54
answered correctly, and the largest real prompt was 2,256 tokens.

Every buffer on the audio path is now bounded by construction:

| buffer | bound |
|---|---|
| utterance / pre-roll (local STT) | fixed rings, 30 s and 1 s |
| local STT queue | **was unbounded** (a stalled whisper-server grew it while people kept talking); now 4 utterances, oldest dropped with an error |
| cloud STT reconnect queue | 50 frames |
| input recording | **writes were never back-pressured**; now drops input past 8 MB of unflushed backlog, with a warning |
| latency window | 500 turns per component |
| transcript / memory | grows with the meeting by design (it *is* the meeting); prompt contribution is bounded by `historyBudget` |
| browser playback queue | one `AudioBufferSourceNode` per scheduled chunk, released on `ended` / barge-in |

## Roadmap

- [ ] Native macOS capture helper: ScreenCaptureKit / Core Audio process taps
      for per-app meeting audio, the voice-processing unit for OS-grade AEC and
      noise suppression, and an `IOPMAssertion` so a long meeting can't be cut
      short by idle sleep
- [ ] A real VAD model (Silero) for the low-SNR case energy detection can't win
- [ ] Headless bot mode: join Meet/Zoom as a participant (Recall.ai or livekit)
- [ ] Tool use: let it check your calendar / docs / tickets before answering
- [ ] Per-speaker diarization in the transcript
- [ ] "Meeting minutes" export at session end
- [ ] Interrupt-free whisper mode (answer only in the UI, no voice)

PRs welcome — the codebase is deliberately small and readable.

## License

MIT
