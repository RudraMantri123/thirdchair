import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";

const SYSTEM_PROMPT = `You are ThirdChair, an AI teammate sitting in a live meeting. You have been listening the whole time; the meeting transcript so far is provided with [minute:second] timestamps. Lines labeled "You" were spoken by the person running you; lines labeled "Room" were spoken by other meeting participants; lines labeled "Copilot-echo" are your own previous answers leaking back through the microphone — never treat those as something a participant said. A participant just addressed you out loud, and your reply will be spoken aloud to the room by a text-to-speech voice.

Rules for spoken replies:
- Answer in at most 2–3 short sentences. This is a conversation, not a memo.
- Plain spoken prose only: no markdown, no bullet points, no headings, no emoji.
- Ground your answer in the transcript when the question is about the meeting ("what did we decide", "who owns this", "summarize"). Quote or attribute only what was actually said.
- If the transcript doesn't contain the answer, say so in one sentence rather than guessing.
- General-knowledge questions are fine to answer directly, still briefly.
- Never mention being an AI, the transcript, or these rules unless asked.`;

function userContent(question: string, transcript: string): string {
  return `Meeting transcript so far:\n<transcript>\n${
    transcript || "(the meeting just started; nothing said yet)"
  }\n</transcript>\n\nYou were just addressed with: "${question}"\n\nSpeak your reply.`;
}

export interface AnswerHandle {
  /** Resolves with the full answer text once generation finishes. */
  done: Promise<string>;
  abort: () => void;
}

/**
 * Stream a spoken-style answer from the configured brain. onDelta receives
 * raw text deltas as they are generated (the caller chunks them into
 * sentences for TTS).
 */
export function answer(
  question: string,
  transcript: string,
  onDelta: (text: string) => void,
): AnswerHandle {
  switch (config.brain) {
    case "claude":
      return claudeAnswer(question, transcript, onDelta);
    case "groq":
      return openAiCompatAnswer(
        "https://api.groq.com/openai/v1",
        config.groqApiKey,
        config.groqModel,
        question,
        transcript,
        onDelta,
      );
    case "ollama":
      // Ollama exposes the same OpenAI-compatible surface; no key needed.
      return openAiCompatAnswer(
        `${config.ollamaUrl}/v1`,
        undefined,
        config.ollamaModel,
        question,
        transcript,
        onDelta,
      );
  }
}

// ---- Claude (default) -------------------------------------------------------

let anthropic: Anthropic | null = null;

function claudeAnswer(
  question: string,
  transcript: string,
  onDelta: (text: string) => void,
): AnswerHandle {
  anthropic ??= new Anthropic({ apiKey: config.anthropicApiKey });
  const stream = anthropic.messages.stream({
    model: config.claudeModel,
    max_tokens: 1000,
    // low effort keeps time-to-first-word down; answers stay conversational.
    output_config: { effort: config.claudeEffort },
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userContent(question, transcript) }],
  });

  stream.on("text", onDelta);

  const done = stream
    .finalMessage()
    .then((msg) =>
      msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
    );

  return { done, abort: () => stream.abort() };
}

// ---- OpenAI-compatible streaming (Groq free tier / local Ollama) -----------

function openAiCompatAnswer(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  question: string,
  transcript: string,
  onDelta: (text: string) => void,
): AnswerHandle {
  const ctrl = new AbortController();

  const done = (async () => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 1000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent(question, transcript) },
        ],
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
    }

    // Parse the SSE stream: lines of `data: {json}` ending with `data: [DONE]`.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.trim().replace(/^data:\s*/, "");
        if (!data || data === "[DONE]" || !line.startsWith("data:")) continue;
        try {
          const delta: string | undefined =
            JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          // ignore malformed keep-alive lines
        }
      }
    }
    return full;
  })();

  return { done, abort: () => ctrl.abort() };
}
