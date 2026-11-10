import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { AppConfig } from "../schemas/config";
import { costRecordSchema, manifestSchema } from "../schemas/manifest";
import { assertWithinRunBudget } from "../lib/cost";
import { extractAudio } from "./extract-audio";
import { mediaDurationSeconds, probeMedia } from "./probe";

export interface RunSummary {
  runDirectory: string;
  manifestPath: string;
  audioPath: string;
  durationSeconds: number;
  resumed: boolean;
}

export async function runLocalPipeline(inputPath: string, outputPath: string | undefined, config: AppConfig, options: { resume?: boolean } = {}): Promise<RunSummary> {
  const sourcePath = resolve(inputPath);
  await access(sourcePath);
  const outputDirectory = resolve(outputPath ?? join(config.runtime.defaultOutputDirectory, createRunName(sourcePath)));
  if (outputDirectory === sourcePath || isParentOf(outputDirectory, sourcePath)) {
    throw new Error("Run output directory cannot replace or contain the source file");
  }

  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error("Input must be a regular file");
  const outputExists = await exists(outputDirectory);
  if (outputExists && !options.resume) throw new Error(`Output directory already exists: ${outputDirectory}`);
  if (!outputExists && options.resume) throw new Error(`Cannot resume; run directory does not exist: ${outputDirectory}`);
  if (!outputExists) await mkdir(outputDirectory, { recursive: true });

  const startedAt = new Date();
  const stages: Record<string, number> = {};
  let stage = "source validation";
  let probe;
  let sourceHash: string;
  try {
    stage = "source hashing";
    const hashStarted = Date.now();
    sourceHash = await sha256(sourcePath);
    stages.sha256Ms = Date.now() - hashStarted;

    const statePath = join(outputDirectory, "run-state.json");
    let prior: RunState | undefined;
    if (options.resume) {
      stage = "resume validation";
      prior = await readRunState(statePath);
      if (prior.sourceSha256 !== sourceHash) throw new Error("Resume refused: source file hash differs from the source recorded in this run. Start a new run directory for this file.");
    }

    stage = "media probing";
    const probeStarted = Date.now();
    probe = await probeMedia(sourcePath);
    stages.probeMs = Date.now() - probeStarted;

    const audioStreams = probe.streams.filter((stream) => stream.codec_type === "audio");
    if (audioStreams.length === 0) throw new Error("Input has no audio stream to extract");
    const durationSeconds = mediaDurationSeconds(probe);
    const audioPath = join(outputDirectory, "audio.wav");

    stage = "audio extraction";
    let resumed = false;
    let audioRetries = 0;
    if (prior?.audio.status === "completed") {
      const artifactHash = await sha256IfExists(audioPath);
      if (!artifactHash || artifactHash !== prior.audio.sha256) {
        throw new Error("Resume refused: completed audio.wav is missing or has changed. Preserve this run for diagnosis and start a fresh run.");
      }
      const audioProbe = await probeMedia(audioPath);
      if (!audioProbe.streams.some((stream) => stream.codec_type === "audio") || audioProbe.streams.some((stream) => stream.codec_type === "video")) {
        throw new Error("Resume refused: audio.wav does not contain the expected audio-only artifact. Start a fresh run.");
      }
      resumed = true;
      stages.audioExtractMs = prior.audio.elapsedMs;
      audioRetries = prior.audio.retries ?? 0;
      const existingManifest = await readJsonIfExists(join(outputDirectory, "manifest.json"));
      if (existingManifest !== undefined) {
        const parsedManifest = manifestSchema.safeParse(existingManifest);
        if (!parsedManifest.success || parsedManifest.data.input.sha256 !== sourceHash || parsedManifest.data.input.durationSeconds !== durationSeconds) {
          throw new Error("Resume refused: existing manifest is invalid or belongs to different source media. Start a fresh run.");
        }
        const existingCost = await readJsonIfExists(join(outputDirectory, "cost.json"));
        if (existingCost !== undefined && !costRecordSchema.safeParse(existingCost).success) {
          throw new Error("Resume refused: existing cost.json is invalid. Preserve the run and start a fresh run.");
        }
        if (existingCost !== undefined) {
          await rm(join(outputDirectory, "failure.json"), { force: true });
          return { runDirectory: outputDirectory, manifestPath: join(outputDirectory, "manifest.json"), audioPath, durationSeconds, resumed: true };
        }
      }
    } else {
      await writeRunState(statePath, { schemaVersion: "vclip-run-state/0.1", sourceSha256: sourceHash, audio: { status: "pending" } });
      if (prior?.audio.status === "pending") await rm(audioPath, { force: true });
      const audioStarted = Date.now();
      audioRetries = await extractAudio(sourcePath, audioPath);
      stages.audioExtractMs = Date.now() - audioStarted;
      const audioHash = await sha256(audioPath);
      stages.audioExtractRetries = audioRetries;
      await writeRunState(statePath, { schemaVersion: "vclip-run-state/0.1", sourceSha256: sourceHash, audio: { status: "completed", sha256: audioHash, elapsedMs: stages.audioExtractMs, retries: audioRetries } });
    }

    const cost = {
      currency: "USD",
      estimatedTotalUsd: 0,
      providerCalls: [],
      localProcessing: {
        sourceDurationSeconds: durationSeconds,
        audioExtractMs: stages.audioExtractMs,
        retryCount: audioRetries,
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

    await writeJsonReplace(join(outputDirectory, "manifest.json"), manifest, options.resume === true);
    await writeJsonReplace(join(outputDirectory, "cost.json"), cost, options.resume === true);
    await rm(join(outputDirectory, "failure.json"), { force: true });
    return { runDirectory: outputDirectory, manifestPath: join(outputDirectory, "manifest.json"), audioPath, durationSeconds, resumed };
  } catch (error) {
    await writeJsonReplace(join(outputDirectory, "failure.json"), {
      schemaVersion: "vclip-failure/0.1",
      failedAt: new Date().toISOString(),
      stage,
      inputFileName: basename(sourcePath),
      stageTimingsMs: stages,
      safeMessage: error instanceof Error ? error.message : "Unknown pipeline failure",
    }, true).catch(() => undefined);
    const detail = error instanceof Error ? error.message : "Unknown pipeline failure";
    throw new Error(`Stage '${stage}' failed for ${basename(sourcePath)}: ${detail}`, { cause: error });
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

interface RunState {
  schemaVersion: "vclip-run-state/0.1";
  sourceSha256: string;
  audio: { status: "pending" } | { status: "completed"; sha256: string; elapsedMs: number; retries?: number };
}

async function readRunState(path: string): Promise<RunState> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Resume refused: run-state.json is missing or invalid. Artifacts cannot be safely matched to the source; start a new run."); }
  if (!value || typeof value !== "object") throw new Error("Resume refused: run-state.json has an invalid format.");
  const state = value as Partial<RunState>;
  if (state.schemaVersion !== "vclip-run-state/0.1" || typeof state.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(state.sourceSha256) || !state.audio || !["pending", "completed"].includes(state.audio.status)) {
    throw new Error("Resume refused: run-state.json failed validation. Start a new run.");
  }
  if (state.audio.status === "completed" && (!/^[a-f0-9]{64}$/.test(state.audio.sha256) || !Number.isFinite(state.audio.elapsedMs) || (state.audio.retries !== undefined && (!Number.isInteger(state.audio.retries) || state.audio.retries < 0)))) {
    throw new Error("Resume refused: audio checkpoint is invalid. Start a new run.");
  }
  return state as RunState;
}

async function writeRunState(path: string, state: RunState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function writeJsonReplace(path: string, value: unknown, replace: boolean): Promise<void> {
  if (!replace && await exists(path)) throw new Error(`Refusing to replace existing artifact: ${path}`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256IfExists(path: string): Promise<string | undefined> {
  try { await access(path); return await sha256(path); } catch { return undefined; }
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Resume refused: ${path} is not valid JSON. Preserve this run and start a fresh run.`);
  }
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
