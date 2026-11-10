import { describe, expect, it } from "vitest";
import { parseGeminiInteraction } from "../src/adapters/gemini-transcriber";
import { parseFasterWhisperOutput } from "../src/adapters/local-faster-whisper";
import { assertWithinRunBudget, createCostEntry } from "../src/lib/cost";
import { loadConfig } from "../src/lib/config";
import { transcriptSchema } from "../src/schemas/transcript";

describe("transcript parsing", () => {
  it("parses Gemini word timestamps and speaker annotations", () => {
    const result = parseGeminiInteraction(JSON.stringify({
      id: "int_test",
      status: "completed",
      steps: [{ type: "model_output", content: [{ annotations: [
        { type: "word_info", text: "world.", speaker: "spk_1", start_offset: "0.360s", end_offset: "0.700s" },
        { type: "word_info", text: "bad", speaker: "spk_1", start_offset: "0.700s", end_offset: "0.700s" },
        { type: "word_info", text: "Hello", speaker: "spk_1", start_offset: "0.100s", end_offset: "0.350s" },
      ] }] }],
      usage: { total_input_tokens: 52, total_output_tokens: 7 },
    }));

    expect(result.words).toEqual([
      { text: "Hello", startSeconds: 0.1, endSeconds: 0.35, speakerId: "spk_1" },
      { text: "world.", startSeconds: 0.36, endSeconds: 0.7, speakerId: "spk_1" },
    ]);
    expect(result.inputTokens).toBe(52);
    expect(result.outputTokens).toBe(7);
    expect(result.omittedWordAnnotations).toBe(1);
    expect(result.outOfOrderWordAnnotations).toBe(1);
  });

  it("rejects missing or malformed word timestamps instead of inventing them", () => {
    expect(() => parseGeminiInteraction(JSON.stringify({ status: "completed", steps: [] })))
      .toThrow("no word-level timestamp annotations");
    expect(() => parseGeminiInteraction(JSON.stringify({
      status: "completed",
      steps: [{ content: [{ annotations: [{ type: "word_info", text: "Hi", start_offset: "bad", end_offset: "1s" }] }] }],
    }))).toThrow("Unsupported Gemini duration offset");
  });

  it("parses Faster-Whisper words with word timestamps", () => {
    const result = parseFasterWhisperOutput(JSON.stringify({
      language: "hi", languageProbability: 0.94,
      segments: [{ startSeconds: 0, endSeconds: 0.5, text: "नमस्ते", words: [{ text: "नमस्ते", startSeconds: 0.1, endSeconds: 0.5, confidence: 0.9 }] }],
      versions: { fasterWhisper: "1.2.1", ctranslate2: "4.8.5" }, elapsedMs: 123,
      omittedWordsWithoutPositiveDuration: 1,
    }));
    expect(result.language).toBe("hi");
    expect(result.segments[0]?.words[0]?.startSeconds).toBe(0.1);
    expect(result.omittedWordsWithoutPositiveDuration).toBe(1);
  });

  it("rejects malformed Faster-Whisper output", () => {
    expect(() => parseFasterWhisperOutput("{bad json" )).toThrow("invalid JSON");
    expect(() => parseFasterWhisperOutput(JSON.stringify({ language: "en", segments: [] })))
      .toThrow("output was invalid");
  });

  it("validates the stored transcript contract", () => {
    const result = transcriptSchema.safeParse({
      schemaVersion: "vclip-transcript/0.1",
      provider: { id: "faster-whisper", model: "small", version: "faster-whisper/1.2.1; ctranslate2/4.8.5" },
      source: { fileName: "clip.wav", sha256: "a".repeat(64), durationSeconds: 1 },
      language: { code: "en", probability: 0.9 }, speakerLabels: "unavailable", transcriptText: "hello",
      segments: [{ startSeconds: 0, endSeconds: 1, text: "hello", speakerId: null, wordStartIndex: 0, wordEndIndex: 0 }],
      words: [{ text: "hello", startSeconds: 0.1, endSeconds: 0.4, speakerId: null }],
      timing: { startedAt: new Date().toISOString(), elapsedMs: 1 },
      usage: { audioSeconds: 1, inputTokens: null, outputTokens: null, estimatedCostUsd: 0, costBasis: "local" },
      cleanupWarnings: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("M2 transcription cost guard", () => {
  it("records the configured Gemini per-minute estimate and enforces the M1 cap", async () => {
    const config = await loadConfig();
    const entry = createCostEntry(config, "gemini", "gemini-3.5-transcribe", { audioSeconds: 60 });
    expect(entry.estimatedCostUsd).toBe(0.005);
    expect(() => assertWithinRunBudget(entry.estimatedCostUsd, config.runtime.maxRunCostUsd)).not.toThrow();
    expect(() => assertWithinRunBudget(11 * entry.estimatedCostUsd, config.runtime.maxRunCostUsd)).toThrow("exceeds configured cap");
  });
});
