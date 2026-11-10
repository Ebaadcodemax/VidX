import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Reasoner } from "../src/adapters/reasoner";
import { configSchema } from "../src/schemas/config";
import { editIrSchema, proposalSchema, proposedClipSchema } from "../src/schemas/edit-ir";
import { generateWithRepair, isWordAligned, runClipPlanning, snapClipBoundaries, validateCandidate, validateProposal } from "../src/pipeline/plan-clips";
import type { TranscriptDocument, TranscriptWord } from "../src/schemas/transcript";

const config = configSchema.parse({ pricing: { test: { mock: { inputUsdPerMillionTokens: 0.75, outputUsdPerMillionTokens: 3.75 } } } });
const rate = config.pricing.test!.mock!;
const words: TranscriptWord[] = [
  { text: "First", startSeconds: 0, endSeconds: 1, speakerId: "S1" },
  { text: "complete", startSeconds: 1, endSeconds: 2, speakerId: "S1" },
  { text: "sentence.", startSeconds: 2, endSeconds: 3, speakerId: "S1" },
  { text: "Second", startSeconds: 4, endSeconds: 5, speakerId: "S1" },
  { text: "thought", startSeconds: 5, endSeconds: 6, speakerId: "S1" },
  { text: "continues", startSeconds: 6, endSeconds: 7, speakerId: "S1" },
  { text: "here.", startSeconds: 7, endSeconds: 8, speakerId: "S1" },
  ...Array.from({ length: 18 }, (_, index) => ({ text: index === 17 ? "ends." : "word", startSeconds: 9 + index, endSeconds: 10 + index, speakerId: "S1" })),
];
const transcript = makeTranscript(words);

function makeClip(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1", start_s: 0.4, end_s: 20.4, title: "A title", hook_text: "A hook", payoff: "A point", reason: "It makes a complete point.",
    scores: { hook: 0.8, standalone: 0.9, payoff: 0.8, emotion: 0.4 }, needs_context_line: false, context_line: null,
    speakers: ["S1"], captions: { style: "default", language: "en" }, output: { aspect: "9:16", max_duration_s: 90 }, ...overrides,
  };
}

describe("Edit IR v0 schemas and deterministic checks", () => {
  it("rejects missing required fields and unknown fields", () => {
    const missing = { ...makeClip() } as Record<string, unknown>;
    delete missing.payoff;
    expect(proposedClipSchema.safeParse(missing).success).toBe(false);
    expect(proposedClipSchema.safeParse({ ...makeClip(), arbitraryCommand: "do something" }).success).toBe(false);
    expect(editIrSchema.safeParse({ version: "edit-ir/0.1", source: { file: "x.mp4", sha256: "a".repeat(64), duration_s: 30 }, language: "en", clips: [{ ...makeClip(), critic: { verdict: "keep", standalone: true, hook_strength: 5, payoff: true, reason: "Works" } }, { extra: true }] }).success).toBe(false);
  });

  it("rejects invalid scores, out-of-range timestamps and invalid duration", () => {
    expect(proposedClipSchema.safeParse(makeClip({ scores: { hook: 1.01, standalone: 0.5, payoff: 0.5, emotion: 0.5 } })).success).toBe(false);
    expect(proposedClipSchema.safeParse(makeClip({ start_s: -1 })).success).toBe(false);
    expect(validateCandidate(proposedClipSchema.parse(makeClip({ end_s: 301 })), transcript, config)).toContain("timestamps");
    expect(validateCandidate(proposedClipSchema.parse(makeClip({ end_s: 8 })), transcript, config)).toContain("duration");
  });

  it("repairs mid-word boundaries to sentence and word edges with configured padding", () => {
    const raw = proposedClipSchema.parse(makeClip());
    const snapped = snapClipBoundaries(raw, words, transcript.source.durationSeconds, 0.3);
    expect(snapped.start_s).toBe(0);
    expect(snapped.end_s).toBe(27.3);
    expect(isWordAligned(snapped.start_s, words)).toBe(true);
    expect(validateCandidate(snapped, transcript, config, true)).toBeUndefined();
    expect(snapped.start_s).not.toBe(raw.start_s);
    expect(snapped.end_s).not.toBe(raw.end_s);
    expect(validateCandidate({ ...snapped, start_s: 1 }, transcript, config, true)).toContain("sentence/word edges");
    expect(() => snapClipBoundaries({ ...raw, start_s: 40 }, words, transcript.source.durationSeconds)).toThrow("final timestamped word");
  });

  it("rejects overlapping candidates in semantic proposal validation", () => {
    const base = makeClip();
    const proposal = proposalSchema.parse({
      version: "edit-ir/0.1", source: { file: "founder-video.mp4", sha256: "b".repeat(64), duration_s: 300 }, language: "en",
      clips: [base, { ...base, id: "c2", start_s: 10, end_s: 30 }],
    });
    expect(validateProposal(proposal, transcript, config)).toContain("overlapping");
  });

  it("makes exactly one repair call when the first structured response is invalid", async () => {
    const outputs: unknown[] = [{ ok: "no", unknown: true }, { ok: "yes" }];
    const prompts: string[] = [];
    const mock: Reasoner = {
      id: "test", model: "mock",
      async availability() { return { available: true }; },
      async generateJson(prompt) { prompts.push(prompt); return { data: outputs.shift(), usage: { inputTokens: 3, outputTokens: 2, elapsedMs: 1 } }; },
    };
    const calls: Array<{ provider: string; model: string; stage: string; promptVersion: string; inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number; elapsedMs: number }> = [];
    const result = await generateWithRepair(mock, "initial", z.object({ ok: z.literal("yes") }).strict(), "test-prompt-v1", rate, calls, 0.05);
    expect(result.value).toEqual({ ok: "yes" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("REPAIR ATTEMPT");
    expect(calls).toHaveLength(2);
  });

  it("stops after one unsuccessful repair and returns no validated value", async () => {
    let count = 0;
    const mock: Reasoner = { id: "test", model: "mock", async availability() { return { available: true }; }, async generateJson() { count += 1; return { data: {}, usage: { inputTokens: 1, outputTokens: 1, elapsedMs: 1 } }; } };
    const result = await generateWithRepair(mock, "prompt", z.object({ required: z.string() }).strict(), "test-prompt-v1", rate, [], 0.05);
    expect(count).toBe(2);
    expect(result.value).toBeUndefined();
  });

  it("runs the planner end to end with mocked proposal and critic responses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vclip-m3-test-"));
    try {
      const source = { fileName: "mock-source.mp4", sha256: "c".repeat(64), durationSeconds: 300 };
      const testTranscript = makeTranscript(words).schemaVersion === "vclip-transcript/0.1"
        ? { ...makeTranscript(words), source }
        : makeTranscript(words);
      const transcriptPath = join(directory, "transcript.json");
      await writeFile(transcriptPath, JSON.stringify(testTranscript));
      const proposed = {
        version: "edit-ir/0.1", source: { file: source.fileName, sha256: source.sha256, duration_s: source.durationSeconds }, language: "hi-en",
        clips: [makeClip({ id: "clip-a", start_s: 0.4, end_s: 20.4 })],
      };
      const mockResponses: unknown[] = [proposed, { verdicts: [{ clip_id: "clip-a", verdict: "keep", standalone: true, hook_strength: 4, payoff: true, reason: "The thought is understandable and resolves cleanly.", suggested_start_s: null, suggested_end_s: null }] }];
      const mock: Reasoner = { id: "test", model: "mock", async availability() { return { available: true }; }, async generateJson() { return { data: mockResponses.shift(), usage: { inputTokens: 10, outputTokens: 20, elapsedMs: 3 } }; } };
      const testConfig = configSchema.parse({ ...config, pricing: { test: { mock: { inputUsdPerMillionTokens: 0.75, outputUsdPerMillionTokens: 3.75 } } } });
      const result = await runClipPlanning(transcriptPath, testConfig, join(directory, "plan-output"), mock);
      const written = JSON.parse(await readFile(result.editIrPath, "utf8")) as { clips: Array<{ start_s: number; end_s: number; critic: { verdict: string } }> };
      expect(written.clips).toHaveLength(1);
      expect(written.clips[0]!.start_s).toBe(0);
      expect(written.clips[0]!.end_s).toBe(27.3);
      expect(written.clips[0]!.critic.verdict).toBe("keep");
      expect(mockResponses).toHaveLength(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

function makeTranscript(inputWords: TranscriptWord[]): TranscriptDocument {
  const source = { fileName: "founder-video.mp4", sha256: "b".repeat(64), durationSeconds: 300 };
  return {
    schemaVersion: "vclip-transcript/0.1", provider: { id: "gemini", model: "test", version: "test" }, source,
    language: { code: "en", probability: null }, speakerLabels: "provider", transcriptText: inputWords.map((word) => word.text).join(" "),
    segments: [], words: inputWords, timing: { startedAt: new Date().toISOString(), elapsedMs: 1 },
    usage: { audioSeconds: 300, inputTokens: null, outputTokens: null, estimatedCostUsd: 0, costBasis: "test" }, cleanupWarnings: [],
  };
}
