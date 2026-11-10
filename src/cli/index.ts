import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../lib/config";
import { runCommand } from "../lib/process";
import { runLocalPipeline } from "../pipeline/run";
import { runCompareAsr, runSingleTranscription } from "../pipeline/transcribe";
import type { TranscriberId } from "../adapters/transcriber";
import { costRecordSchema } from "../schemas/manifest";
import { runClipPlanning } from "../pipeline/plan-clips";

const program = new Command();
program
  .name("vclip")
  .description("Local AI-assisted clip production pipeline")
  .version("0.1.0");

program.command("init")
  .description("Check local tools and configuration")
  .action(async () => {
    const config = await loadConfig();
    const checks = await Promise.all([
      checkCommand("node", ["--version"]),
      checkCommand("ffmpeg", ["-version"]),
      checkCommand("ffprobe", ["-version"]),
    ]);
    checks.forEach(({ name, value, error }) => {
      console.log(error ? `MISSING ${name}: ${error}` : `OK ${name}: ${value}`);
    });
    const missing = config.requiredEnv.filter((name) => !process.env[name]);
    if (missing.length) console.log(`MISSING environment variables: ${missing.join(", ")}`);
    else console.log(config.requiredEnv.length ? "OK required environment variables" : "OK no provider API keys required for the local pipeline");
    if (checks.some((check) => check.error) || missing.length) process.exitCode = 1;
  });

program.command("run")
  .description("Probe one local media file and extract normalized audio")
  .argument("<media-file>", "Path to a creator-provided local media file")
  .option("--out <directory>", "New run directory; defaults to config.yaml setting")
  .action(async (mediaFile: string, options: { out?: string }) => {
    const config = await loadConfig();
    const result = await runLocalPipeline(mediaFile, options.out, config);
    console.log(`Run complete: ${result.runDirectory}`);
    console.log(`Duration: ${result.durationSeconds.toFixed(2)} seconds`);
    console.log(`Audio: ${result.audioPath}`);
    console.log(`Manifest: ${result.manifestPath}`);
    console.log("Estimated provider cost: $0.000000 (no provider calls in this milestone)");
  });

program.command("cost")
  .description("Show the cost record for a completed local run")
  .argument("<run-directory>")
  .action(async (runDirectory: string) => {
    const costPath = join(resolve(runDirectory), "cost.json");
    const parsed: unknown = JSON.parse(await readFile(costPath, "utf8"));
    console.log(JSON.stringify(costRecordSchema.parse(parsed), null, 2));
  });

program.command("compare-asr")
  .description("Run every configured transcriber on the same local media file")
  .argument("<media-file>", "Local video or audio file")
  .option("--out <directory>", "New output directory; defaults to config.yaml setting")
  .option("--language <code>", "Optional BCP-47 language hint; omit for automatic detection")
  .action(async (mediaFile: string, options: { out?: string; language?: string }) => {
    const config = await loadConfig();
    console.log("Preparing one local normalized audio file for all configured transcribers.");
    console.log("Gemini uploads that audio to Google only when a key, creator consent, unpaid-data acknowledgement, and free-tier-only confirmation are all configured.");
    const result = await runCompareAsr(mediaFile, config, options.out, options.language);
    console.log(`ASR comparison saved: ${result.runDirectory}`);
    for (const record of result.records) {
      const suffix = record.transcriptPath ? ` -> ${record.transcriptPath}` : ` (${record.reason ?? record.status})`;
      console.log(`${record.id}: ${record.status}; model=${record.model}; elapsed=${record.elapsedMs}ms; estimated=$${record.estimatedCostUsd.toFixed(6)}${suffix}`);
      for (const warning of record.cleanupWarnings) console.warn(`${record.id} cleanup warning: ${warning}`);
    }
    if (result.succeeded === 0) process.exitCode = 1;
  });

program.command("transcribe")
  .description("Save one provider transcript as transcript.json")
  .argument("<media-file>", "Local video or audio file")
  .option("--provider <provider>", "faster-whisper or gemini", "faster-whisper")
  .option("--out <directory>", "New output directory; defaults to config.yaml setting")
  .option("--language <code>", "Optional BCP-47 language hint; omit for automatic detection")
  .action(async (mediaFile: string, options: { provider: string; out?: string; language?: string }) => {
    if (options.provider !== "faster-whisper" && options.provider !== "gemini") {
      throw new Error("--provider must be faster-whisper or gemini");
    }
    const config = await loadConfig();
    const provider = options.provider as TranscriberId;
    if (!config.transcription.providers.includes(provider)) {
      throw new Error(`${provider} is not listed in transcription.providers in config.yaml`);
    }
    const result = await runSingleTranscription(mediaFile, provider, config, options.out, options.language);
    for (const record of result.records) {
      console.log(`${record.id}: ${record.status}; model=${record.model}; elapsed=${record.elapsedMs}ms; estimated=$${record.estimatedCostUsd.toFixed(6)}`);
      if (record.transcriptPath) console.log(`Transcript: ${result.runDirectory}/${record.transcriptPath}`);
      if (record.reason) console.error(record.reason);
    }
    if (result.succeeded === 0) process.exitCode = 1;
  });

program.command("plan")
  .description("Propose, critique, validate and snap clips from a saved transcript (M3; no rendering)")
  .argument("<transcript-file>", "A vclip transcript.json file")
  .option("--out <directory>", "New output directory; defaults to config.yaml setting")
  .option("--model <model-id>", "Temporary, explicitly priced Gemini model override for this run")
  .action(async (transcriptFile: string, options: { out?: string; model?: string }) => {
    const config = await loadConfig();
    const configuredModel = config.reasoner.model;
    let modelSelectionReason: string | undefined;
    if (options.model) {
      if (!config.pricing.gemini?.[options.model]) throw new Error(`No reviewed price is configured for ${options.model}; refusing model override`);
      config.reasoner.model = options.model;
      modelSelectionReason = options.model === configuredModel
        ? "Explicit run override matches the configured model."
        : `Temporary run-only override from ${configuredModel} to ${options.model}; the configured default was retained after repeated 503/timeout errors. The API model catalog listed this alternative for this key.`;
      console.log(modelSelectionReason);
    }
    console.log("Sending transcript text to the configured reasoner; audio/video files are not uploaded in M3.");
    console.log(`Model: ${config.reasoner.provider}/${config.reasoner.model}; spend cap: $${config.runtime.maxRunCostUsd.toFixed(2)}.`);
    const result = await runClipPlanning(transcriptFile, config, options.out, undefined, modelSelectionReason);
    console.log(`Planning complete: ${result.runDirectory}`);
    console.log(`Edit IR: ${result.editIrPath}`);
    console.log(`Rejected candidates: ${result.rejectedPath}`);
    console.log(`Cost record: ${result.costPath}`);
    console.log(`Accepted clips: ${result.clips.length}`);
    for (const clip of result.clips) console.log(`${clip.id} ${clip.start_s.toFixed(3)}-${clip.end_s.toFixed(3)}s: ${clip.reason}`);
    console.log("M3 does not render video clips.");
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : "Unexpected failure"}`);
  process.exitCode = 1;
});

async function checkCommand(name: string, args: string[]): Promise<{ name: string; value?: string; error?: string }> {
  try {
    const { stdout } = await runCommand(name, args, { timeoutMs: 10_000 });
    const firstLine = stdout.split(/\r?\n/).find(Boolean) ?? "available";
    return { name, value: firstLine.trim() };
  } catch (error) {
    return { name, error: error instanceof Error ? error.message : "not available" };
  }
}
