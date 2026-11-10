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
import { runRendering } from "../pipeline/render";
import { createBlindReview, createReviewSheet, evaluate, planPurge, purge } from "../pipeline/review-eval";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

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

program.command("render")
  .description("Render validated Edit IR clips as captioned 9:16 H.264/AAC videos (M4)")
  .argument("<source-video>", "Original local source video used for planning")
  .argument("<edit-ir>", "Validated M3 edit_ir.json")
  .argument("<transcript>", "Matching M2 transcript.json with word timestamps")
  .option("--out <directory>", "New output directory; defaults to config.yaml setting")
  .action(async (sourceVideo: string, editIr: string, transcript: string, options: { out?: string }) => {
    const config = await loadConfig();
    const output = options.out ?? join(config.runtime.defaultOutputDirectory, `render_${Date.now()}`);
    const result = await runRendering(sourceVideo, editIr, transcript, output);
    console.log(`Render complete: ${result.runDirectory}`);
    for (const clip of result.clips) {
      console.log(`${clip.id}: ${clip.videoPath}; ${clip.probe.streams.find((stream) => stream.codec_type === "video")?.width}x${clip.probe.streams.find((stream) => stream.codec_type === "video")?.height}; ${clip.durationSeconds.toFixed(3)}s; ${clip.elapsedMs}ms`);
    }
    console.log(`Elapsed: ${result.elapsedMs}ms; estimated direct service cost: $${result.estimatedCostUsd.toFixed(6)}`);
  });

program.command("review")
  .description("Generate an offline clip review sheet (M5)")
  .argument("<run-directory>", "Completed M4 render run directory")
  .option("--edit-ir <file>", "Matching validated edit_ir.json (defaults to run directory)")
  .option("--transcript <file>", "Matching transcript.json (defaults to run directory)")
  .option("--compare <folder>", "Build blind A/B pairs against clips in this folder")
  .option("--key-dir <folder>", "Private directory for the blind mapping key", "C:/vclip-data/blind-keys")
  .action(async (runDirectory: string, options: { editIr?: string; transcript?: string; compare?: string; keyDir: string }) => {
    const reviewOptions = { editIrPath: options.editIr, transcriptPath: options.transcript, keyDirectory: options.keyDir };
    const result = options.compare
      ? await createBlindReview(runDirectory, options.compare, reviewOptions)
      : await createReviewSheet(runDirectory, reviewOptions);
    console.log(`Review sheet: ${result.htmlPath}`);
    if ("csvPath" in result) console.log(`Fallback CSV: ${result.csvPath}`);
    if ("keyPath" in result) console.log(`Blind key stored separately: ${result.keyPath}`);
    console.log(options.compare
      ? "Share only the blind-review folder. Its clip files have opaque names; the A/B mapping key is stored separately. The page makes no network requests."
      : "The review page is self-contained and makes no network requests. Copy the rendered clips with the review folder when sharing it.");
  });

program.command("eval")
  .description("Summarize ratings and locally recorded production metrics (M5)")
  .option("--eval-dir <folder>", "Folder containing ratings CSV files", "C:/vclip-data/eval")
  .option("--runs-dir <folder>", "Folder containing local run artifacts", "C:/vclip-data/runs")
  .option("--out <file>", "Markdown report path", "C:/vclip-data/eval/report.md")
  .action(async (options: { evalDir: string; runsDir: string; out: string }) => {
    const result = await evaluate(options.evalDir, options.runsDir, options.out);
    console.log(`Read ${result.ratings} valid ratings; skipped ${result.malformed} malformed rows.`);
    console.log(`Evaluation report: ${result.reportPath}`);
  });

program.command("purge")
  .description("Delete a creator's or run's local artifacts and associated ratings (M5)")
  .argument("<creator-or-run>", "Exact run ID or creator ID/name recorded in local metadata")
  .option("--dry-run", "Show what would be deleted without changing files")
  .option("--runs-dir <folder>", "Run directory", "C:/vclip-data/runs")
  .option("--eval-dir <folder>", "Evaluation/rating directory", "C:/vclip-data/eval")
  .option("--key-dir <folder>", "Blind comparison key directory", "C:/vclip-data/blind-keys")
  .action(async (target: string, options: { dryRun?: boolean; runsDir: string; evalDir: string; keyDir: string }) => {
    if (options.dryRun) {
      const plan = await planPurge(target, options.runsDir, options.evalDir, options.keyDir);
      const ratingCount = Object.values(plan.ratingRowsByFile).reduce((a, b) => a + b, 0);
      console.log(`Dry run: ${plan.runDirs.length} run folder(s), ${plan.keyDirs.length} key folder(s), and ${ratingCount} rating row(s) match.`);
      for (const dir of plan.runDirs) console.log(`Would delete run: ${dir}`);
      for (const dir of plan.keyDirs) console.log(`Would delete private comparison key: ${dir}`);
      for (const [file, count] of Object.entries(plan.ratingRowsByFile)) if (count) console.log(`Would remove ${count} rating row(s) from ${file}`);
      return;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(`Permanently delete matching runs and ratings for "${target}"? Type DELETE to continue: `);
      const result = await purge(target, options.runsDir, options.evalDir, false, async () => answer === "DELETE", options.keyDir);
      console.log(`Purge complete: deleted ${result.deletedRuns} run folder(s) and ${result.deletedKeys} private key folder(s), removed ${result.removedRatings} rating row(s). A content-free audit entry was written outside the project.`);
    } finally { rl.close(); }
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
