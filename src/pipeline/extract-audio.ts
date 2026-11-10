import { access } from "node:fs/promises";
import { runCommand } from "../lib/process";
import { isTransientProcessingError, withRetries } from "../lib/retry";

export async function extractAudio(inputPath: string, outputPath: string): Promise<number> {
  let retries = 0;
  await withRetries(() => runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
    "-i", inputPath,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    outputPath,
  ], { timeoutMs: 15 * 60 * 1000 }), {
    maxRetries: 2,
    baseDelayMs: 250,
    maxDelayMs: 1_000,
    shouldRetry: isTransientProcessingError,
    onRetry: (attempt, delay) => { retries = attempt; console.warn(`FFmpeg audio extraction transient failure; retry ${attempt}/2 in ${delay}ms.`); },
  });
  await access(outputPath);
  return retries;
}
