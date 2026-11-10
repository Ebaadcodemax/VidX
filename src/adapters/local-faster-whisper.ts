import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { runCommand } from "../lib/process";
import type { AppConfig } from "../schemas/config";
import type { TranscriptSegment, TranscriptWord } from "../schemas/transcript";
import type { Transcriber, TranscriptionResult } from "./transcriber";

const wordSchema = z.object({
  text: z.string(), startSeconds: z.number(), endSeconds: z.number(), confidence: z.number().optional(),
}).strict();
const workerSchema = z.object({
  language: z.string().nullable(),
  languageProbability: z.number().nullable(),
  segments: z.array(z.object({
    startSeconds: z.number(), endSeconds: z.number(), text: z.string(), words: z.array(wordSchema),
  }).strict()),
  versions: z.object({ fasterWhisper: z.string(), ctranslate2: z.string() }).strict(),
  omittedWordsWithoutPositiveDuration: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
}).strict();

export class FasterWhisperTranscriber implements Transcriber {
  readonly id = "faster-whisper" as const;
  readonly model: string;

  constructor(private readonly config: AppConfig) {
    this.model = config.transcription.local.model;
  }

  async availability(): Promise<{ available: boolean; reason?: string }> {
    const pythonPath = resolve(this.config.transcription.local.pythonPath);
    try {
      await access(pythonPath);
      await access(resolve("src/adapters/faster_whisper_worker.py"));
      return { available: true };
    } catch {
      return {
        available: false,
        reason: `Local Faster-Whisper is not installed. Create .venv-asr and install requirements-local-asr.txt (Python 3.13 is available here).`,
      };
    }
  }

  async transcribe(audioPath: string, request: { audioSeconds: number; maxRunCostUsd: number; language?: string }): Promise<TranscriptionResult> {
    const options = this.config.transcription.local;
    const workerPath = resolve("src/adapters/faster_whisper_worker.py");
    const downloadRoot = resolve(options.downloadDirectory);
    const args = [
      workerPath,
      "--audio", resolve(audioPath),
      "--model", options.model,
      "--device", options.device,
      "--compute-type", options.computeType,
      "--cpu-threads", String(options.cpuThreads),
      "--download-root", downloadRoot,
    ];
    if (request.language) args.push("--language", request.language);

    const startedAt = Date.now();
    const { stdout } = await runCommand(resolve(options.pythonPath), args, { timeoutMs: 8 * 60 * 60 * 1000 });
    const parsed = parseFasterWhisperOutput(stdout);
    const words: TranscriptWord[] = [];
    const segments: TranscriptSegment[] = [];

    for (const segment of parsed.segments) {
      const wordStartIndex = words.length;
      for (const word of segment.words) {
        if (!word.text.trim() || word.endSeconds <= word.startSeconds) continue;
        words.push({
          text: word.text,
          startSeconds: word.startSeconds,
          endSeconds: word.endSeconds,
          speakerId: null,
          ...(word.confidence === undefined ? {} : { confidence: clampProbability(word.confidence) }),
        });
      }
      if (segment.text) {
        segments.push({
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
          text: segment.text,
          speakerId: null,
          wordStartIndex,
          wordEndIndex: Math.max(wordStartIndex, words.length - 1),
        });
      }
    }

    return {
      provider: this.id,
      model: options.model,
      version: `faster-whisper/${parsed.versions.fasterWhisper}; ctranslate2/${parsed.versions.ctranslate2}`,
      language: { code: parsed.language, probability: parsed.languageProbability },
      speakerLabels: "unavailable",
      transcriptText: segments.map((segment) => segment.text).join(" ").trim(),
      segments,
      words,
      providerUsage: { inputTokens: null, outputTokens: null },
      elapsedMs: Date.now() - startedAt,
      estimatedCostUsd: 0,
      costBasis: "Local inference; no provider charge. CPU time is recorded but not priced.",
      cleanupWarnings: parsed.omittedWordsWithoutPositiveDuration
        ? [`Omitted ${parsed.omittedWordsWithoutPositiveDuration} provider word(s) with zero-length timestamps; timestamps were not fabricated.`]
        : [],
    };
  }
}

export function parseFasterWhisperOutput(jsonText: string) {
  let raw: unknown;
  try { raw = JSON.parse(jsonText); } catch { throw new Error("Local transcriber returned invalid JSON"); }
  const result = workerSchema.safeParse(raw);
  if (!result.success) throw new Error(`Local transcriber output was invalid: ${result.error.message}`);
  return result.data;
}

function clampProbability(value: number): number {
  return Math.min(1, Math.max(0, value));
}
