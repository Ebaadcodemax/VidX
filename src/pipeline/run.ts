import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { AppConfig } from "../schemas/config";
import { assertWithinRunBudget } from "../lib/cost";
import { extractAudio } from "./extract-audio";
import { mediaDurationSeconds, probeMedia } from "./probe";

export interface RunSummary {
  runDirectory: string;
  manifestPath: string;
  audioPath: string;
  durationSeconds: number;
}

export async function runLocalPipeline(inputPath: string, outputPath: string | undefined, config: AppConfig): Promise<RunSummary> {
  const sourcePath = resolve(inputPath);
  await access(sourcePath);
  const outputDirectory = resolve(outputPath ?? join(config.runtime.defaultOutputDirectory, createRunName(sourcePath)));
  if (outputDirectory === sourcePath || isParentOf(outputDirectory, sourcePath)) {
    throw new Error("Run output directory cannot replace or contain the source file");
  }

  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error("Input must be a regular file");
  const outputExists = await exists(outputDirectory);
  if (outputExists) throw new Error(`Output directory already exists: ${outputDirectory}`);
  await mkdir(outputDirectory, { recursive: true });

  const startedAt = new Date();
  const stages: Record<string, number> = {};
  let probe;
  let sourceHash: string;
  try {
    const hashStarted = Date.now();
    sourceHash = await sha256(sourcePath);
    stages.sha256Ms = Date.now() - hashStarted;

    const probeStarted = Date.now();
    probe = await probeMedia(sourcePath);
    stages.probeMs = Date.now() - probeStarted;

    const audioStreams = probe.streams.filter((stream) => stream.codec_type === "audio");
    if (audioStreams.length === 0) throw new Error("Input has no audio stream to extract");
    const durationSeconds = mediaDurationSeconds(probe);
    const audioPath = join(outputDirectory, "audio.wav");

    const audioStarted = Date.now();
    await extractAudio(sourcePath, audioPath);
    stages.audioExtractMs = Date.now() - audioStarted;

    const cost = {
      currency: "USD",
      estimatedTotalUsd: 0,
      providerCalls: [],
      localProcessing: {
        sourceDurationSeconds: durationSeconds,
        audioExtractMs: stages.audioExtractMs,
        note: "Local CPU/FFmpeg cost is not monetarily estimated in M1; provider spend is zero because no model calls run.",
      },
    };
    assertWithinRunBudget(cost.estimatedTotalUsd, config.runtime.maxRunCostUsd);

    const manifest = {
      schemaVersion: "vclip-manifest/0.1",
      runId: basename(outputDirectory),
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      input: {
        fileName: basename(sourcePath),
        sha256: sourceHash,
        bytes: sourceStat.size,
        durationSeconds,
        formatName: probe.format.format_name ?? null,
        streams: probe.streams,
      },
      outputs: { extractedAudio: "audio.wav", format: "mono PCM signed 16-bit, 16000 Hz WAV" },
      versions: { node: process.version, pipeline: "0.1.0" },
      stages,
      providers: [],
    };

    await writeJsonNew(join(outputDirectory, "manifest.json"), manifest);
    await writeJsonNew(join(outputDirectory, "cost.json"), cost);
    return { runDirectory: outputDirectory, manifestPath: join(outputDirectory, "manifest.json"), audioPath, durationSeconds };
  } catch (error) {
    await writeJsonNew(join(outputDirectory, "failure.json"), {
      schemaVersion: "vclip-failure/0.1",
      failedAt: new Date().toISOString(),
      inputFileName: basename(sourcePath),
      stageTimingsMs: stages,
      safeMessage: error instanceof Error ? error.message : "Unknown pipeline failure",
    }).catch(() => undefined);
    throw error;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function writeJsonNew(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", encoding: "utf8" });
}

function createRunName(sourcePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = basename(sourcePath).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "media";
  return `${timestamp}_${stem}`;
}

function isParentOf(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return pathFromParent.length > 0 && pathFromParent !== ".." && !pathFromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(pathFromParent);
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
