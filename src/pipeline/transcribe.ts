import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { AppConfig } from "../schemas/config";
import { transcriptSchema, type TranscriptDocument } from "../schemas/transcript";
import { assertWithinRunBudget, createCostEntry } from "../lib/cost";
import { extractAudio } from "./extract-audio";
import { mediaDurationSeconds, probeMedia } from "./probe";
import type { Transcriber, TranscriberId, TranscriptionResult } from "../adapters/transcriber";
import { FasterWhisperTranscriber } from "../adapters/local-faster-whisper";
import { GeminiTranscriber } from "../adapters/gemini-transcriber";

interface ProviderRecord {
  id: TranscriberId;
  model: string;
  status: "completed" | "skipped" | "failed";
  reason?: string;
  elapsedMs: number;
  transcriptPath?: string;
  estimatedCostUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cleanupWarnings: string[];
}

export interface AsrRunResult {
  runDirectory: string;
  records: ProviderRecord[];
  succeeded: number;
}

export async function runCompareAsr(inputPath: string, config: AppConfig, outputPath?: string, language?: string): Promise<AsrRunResult> {
  const requested = config.transcription.providers;
  return runAsr(inputPath, requested, config, outputPath, true, language);
}

export async function runSingleTranscription(
  inputPath: string,
  providerId: TranscriberId,
  config: AppConfig,
  outputPath?: string,
  language?: string,
): Promise<AsrRunResult> {
  return runAsr(inputPath, [providerId], config, outputPath, false, language);
}

async function runAsr(
  inputPath: string,
  providerIds: TranscriberId[],
  config: AppConfig,
  outputPath: string | undefined,
  comparison: boolean,
  language?: string,
): Promise<AsrRunResult> {
  const sourcePath = resolve(inputPath);
  await access(sourcePath);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error("Input must be a regular file");
  const runDirectory = resolve(outputPath ?? join(config.runtime.defaultOutputDirectory, `${runName(sourcePath)}${comparison ? "_asr" : "_transcript"}`));
  try { await access(runDirectory); throw new Error(`Output directory already exists: ${runDirectory}`); }
  catch (error) { if (error instanceof Error && error.message.startsWith("Output directory already exists:")) throw error; }
  await mkdir(runDirectory, { recursive: true });

  const tempDirectory = await mkdtemp(join(tmpdir(), "vclip-asr-"));
  const audioPath = join(tempDirectory, "normalized.wav");
  const startedAt = new Date();
  const records: ProviderRecord[] = [];
  const providerCalls: Array<Record<string, unknown>> = [];
  let sourceDuration = 0;

  try {
    const probe = await probeMedia(sourcePath);
    sourceDuration = mediaDurationSeconds(probe);
    if (!probe.streams.some((stream) => stream.codec_type === "audio")) throw new Error("Input has no audio stream");
    await extractAudio(sourcePath, audioPath);
    const hash = await sha256(sourcePath);
    const providers = createProviders(config);

    const gemini = providers.find((provider) => provider.id === "gemini");
    const geminiReady = gemini && providerIds.includes("gemini") ? await gemini.availability() : undefined;
    let geminiReservedCost = 0;
    if (gemini && geminiReady?.available) {
      const rate = config.pricing.gemini?.[gemini.model];
      if (!rate) throw new Error(`No reviewed price configured for ${gemini.model}; refusing to call provider`);
      geminiReservedCost = createCostEntry(config, "gemini", gemini.model, { audioSeconds: sourceDuration }).estimatedCostUsd;
      assertWithinRunBudget(geminiReservedCost, config.runtime.maxRunCostUsd);
    }

    for (const providerId of providerIds) {
      const provider = providers.find((candidate) => candidate.id === providerId);
      if (!provider) {
        records.push(skipped(providerId, "Provider is not implemented"));
        continue;
      }
      const availability = providerId === "gemini" && geminiReady ? geminiReady : await provider.availability();
      if (!availability.available) {
        records.push({
          id: provider.id,
          model: provider.model,
          status: "skipped",
          reason: availability.reason ?? "Provider is not configured",
          elapsedMs: 0,
          estimatedCostUsd: 0,
          inputTokens: null,
          outputTokens: null,
          cleanupWarnings: [],
        });
        continue;
      }

      const providerStarted = Date.now();
      try {
        const result = await provider.transcribe(audioPath, {
          audioSeconds: sourceDuration,
          maxRunCostUsd: config.runtime.maxRunCostUsd,
          language,
        });
        const transcript = makeTranscript(result, sourcePath, hash, sourceDuration, startedAt);
        const relativeTranscriptPath = comparison
          ? join("transcripts", provider.id, "transcript.json")
          : "transcript.json";
        const absoluteTranscriptPath = join(runDirectory, relativeTranscriptPath);
        await mkdir(resolve(absoluteTranscriptPath, ".."), { recursive: true });
        await writeJsonNew(absoluteTranscriptPath, transcript);
        records.push({
          id: provider.id,
          model: provider.model,
          status: "completed",
          elapsedMs: result.elapsedMs || Date.now() - providerStarted,
          transcriptPath: relativeTranscriptPath,
          estimatedCostUsd: result.estimatedCostUsd,
          inputTokens: result.providerUsage.inputTokens,
          outputTokens: result.providerUsage.outputTokens,
          cleanupWarnings: result.cleanupWarnings,
        });
        providerCalls.push({
          provider: provider.id,
          model: provider.model,
          usage: {
            inputTokens: result.providerUsage.inputTokens,
            outputTokens: result.providerUsage.outputTokens,
            audioSeconds: sourceDuration,
          },
          estimatedCostUsd: result.estimatedCostUsd,
          costBasis: result.costBasis,
          elapsedMs: result.elapsedMs,
        });
      } catch (error) {
        const estimatedCost = provider.id === "gemini" ? geminiReservedCost : 0;
        records.push({
          id: provider.id,
          model: provider.model,
          status: "failed",
          reason: error instanceof Error ? error.message : "Provider failed",
          elapsedMs: Date.now() - providerStarted,
          estimatedCostUsd: estimatedCost,
          inputTokens: null,
          outputTokens: null,
          cleanupWarnings: [],
        });
        if (provider.id === "gemini") {
          providerCalls.push({
            provider: provider.id,
            model: provider.model,
            usage: { inputTokens: null, outputTokens: null, audioSeconds: sourceDuration },
            estimatedCostUsd: estimatedCost,
            costBasis: "Reserved estimate; request failed before confirmed usage was returned.",
            elapsedMs: Date.now() - providerStarted,
          });
        }
      }
    }

    const totalCost = providerCalls.reduce((sum, call) => sum + Number(call.estimatedCostUsd ?? 0), 0);
    assertWithinRunBudget(totalCost, config.runtime.maxRunCostUsd);
    await writeJsonNew(join(runDirectory, "cost.json"), {
      currency: "USD",
      estimatedTotalUsd: totalCost,
      providerCalls,
      localProcessing: {
        sourceDurationSeconds: sourceDuration,
        note: "Local processing wall time is recorded per provider; CPU/GPU time is not monetarily priced.",
      },
    });
    await writeJsonNew(join(runDirectory, "comparison.json"), {
      schemaVersion: "vclip-asr-comparison/0.1",
      mode: comparison ? "compare" : "single",
      source: { fileName: basename(sourcePath), sha256: hash, durationSeconds: sourceDuration },
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      records,
      note: "No accuracy ranking is produced. Evaluate transcripts against a human reference before making accuracy claims.",
    });
    return { runDirectory, records, succeeded: records.filter((record) => record.status === "completed").length };
  } catch (error) {
    await writeJsonNew(join(runDirectory, "failure.json"), {
      failedAt: new Date().toISOString(),
      sourceFileName: basename(sourcePath),
      safeMessage: error instanceof Error ? error.message : "ASR run failed",
      partialProviderRecords: records,
    }).catch(() => undefined);
    throw error;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function createProviders(config: AppConfig): Transcriber[] {
  return [new FasterWhisperTranscriber(config), new GeminiTranscriber(config)];
}

function makeTranscript(
  result: TranscriptionResult,
  sourcePath: string,
  hash: string,
  durationSeconds: number,
  startedAt: Date,
): TranscriptDocument {
  return transcriptSchema.parse({
    schemaVersion: "vclip-transcript/0.1",
    provider: { id: result.provider, model: result.model, version: result.version },
    source: { fileName: basename(sourcePath), sha256: hash, durationSeconds },
    language: result.language,
    speakerLabels: result.speakerLabels,
    transcriptText: result.transcriptText,
    segments: result.segments,
    words: result.words,
    timing: { startedAt: startedAt.toISOString(), elapsedMs: result.elapsedMs },
    usage: {
      audioSeconds: durationSeconds,
      inputTokens: result.providerUsage.inputTokens,
      outputTokens: result.providerUsage.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      costBasis: result.costBasis,
    },
    cleanupWarnings: result.cleanupWarnings,
  });
}

function skipped(id: TranscriberId, reason: string): ProviderRecord {
  return { id, model: "unknown", status: "skipped", reason, elapsedMs: 0, estimatedCostUsd: 0, inputTokens: null, outputTokens: null, cleanupWarnings: [] };
}

function runName(sourcePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = basename(sourcePath).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "media";
  return `${stamp}_${stem}`;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function writeJsonNew(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", encoding: "utf8" });
}
