import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { basename } from "node:path";
import { z } from "zod";
import { assertWithinRunBudget, createCostEntry } from "../lib/cost";
import { runCommand } from "../lib/process";
import type { AppConfig } from "../schemas/config";
import type { TranscriptSegment, TranscriptWord } from "../schemas/transcript";
import type { Transcriber, TranscriptionResult } from "./transcriber";

const interactionSchema = z.object({
  status: z.string().optional(),
  steps: z.array(z.object({
    content: z.array(z.object({
      annotations: z.array(z.unknown()).optional(),
      text: z.string().optional(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
  usage: z.object({
    total_input_tokens: z.number().int().nonnegative().optional(),
    total_output_tokens: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
}).passthrough();

const wordAnnotationSchema = z.object({
  type: z.literal("word_info"),
  text: z.string().optional(),
  word: z.string().optional(),
  speaker: z.string().optional(),
  start_offset: z.string(),
  end_offset: z.string(),
}).passthrough();

export class GeminiTranscriber implements Transcriber {
  readonly id = "gemini" as const;
  readonly model: string;

  constructor(private readonly config: AppConfig) {
    this.model = config.transcription.gemini.model;
  }

  async availability(): Promise<{ available: boolean; reason?: string }> {
    const options = this.config.transcription.gemini;
    if (!process.env[options.apiKeyEnv]) return { available: false, reason: `${options.apiKeyEnv} is not set` };
    if (process.env[options.creatorConsentEnv]?.toLowerCase() !== "true") {
      return { available: false, reason: `${options.creatorConsentEnv}=true is required before creator audio can be uploaded` };
    }
    if (process.env[options.unpaidDataUseAckEnv]?.toLowerCase() !== "true") {
      return { available: false, reason: `${options.unpaidDataUseAckEnv}=true is required; Google's unpaid tier may use submitted content to improve products` };
    }
    if (process.env[options.freeTierOnlyEnv]?.toLowerCase() !== "true") {
      return { available: false, reason: `${options.freeTierOnlyEnv}=true is required to confirm the Gemini key/project is restricted to unpaid usage; vclip cannot inspect Google billing settings` };
    }
    return { available: true };
  }

  async transcribe(audioPath: string, options: { audioSeconds: number; maxRunCostUsd: number; language?: string }): Promise<TranscriptionResult> {
    const availability = await this.availability();
    if (!availability.available) throw new Error(availability.reason ?? "Gemini is not configured");

    if (!this.config.pricing.gemini?.[this.model]) throw new Error(`No reviewed Gemini price configured for ${this.model}; refusing to call provider`);
    const reserve = createCostEntry(this.config, "gemini", this.model, { audioSeconds: options.audioSeconds });
    assertWithinRunBudget(reserve.estimatedCostUsd, options.maxRunCostUsd);

    const maxSeconds = this.config.transcription.gemini.maxTimestampMinutes * 60;
    if (options.audioSeconds > maxSeconds) {
      throw new Error(`Gemini word timestamps and speaker labels are limited to ${this.config.transcription.gemini.maxTimestampMinutes} minutes; split the audio in a later milestone or use local Faster-Whisper`);
    }

    const apiKey = process.env[this.config.transcription.gemini.apiKeyEnv]!;
    const startedAt = Date.now();
    const cleanupWarnings: string[] = [];
    let remoteFileName: string | undefined;
    let parsed: ReturnType<typeof parseGeminiInteraction> | undefined;
    let providerError: unknown;

    try {
      const remoteFile = await uploadGeminiFile(audioPath, apiKey);
      remoteFileName = remoteFile.name;
      parsed = await createGeminiTranscription(remoteFile, apiKey, this.model, options.language);
    } catch (error) {
      providerError = error;
    } finally {
      if (remoteFileName) {
        try { await deleteGeminiFile(remoteFileName, apiKey); }
        catch (error) { cleanupWarnings.push(error instanceof Error ? error.message : "Failed to delete uploaded Gemini file"); }
      }
    }

    if (providerError) {
      const cleanup = cleanupWarnings.length ? `; cleanup warning: ${cleanupWarnings.join("; ")}` : "";
      throw new Error(`${providerError instanceof Error ? providerError.message : "Gemini transcription failed"}${cleanup}`);
    }
    if (!parsed) throw new Error("Gemini returned no transcription result");

    const observedCost = createCostEntry(this.config, "gemini", this.model, { audioSeconds: options.audioSeconds });
    return {
      provider: this.id,
      model: this.model,
      version: `Gemini Interactions API; interaction ${parsed.interactionId}`,
      language: { code: null, probability: null },
      speakerLabels: parsed.words.some((word) => word.speakerId !== null) ? "provider" : "unavailable",
      transcriptText: parsed.words.map((word) => word.text).join(" "),
      segments: toSegments(parsed.words),
      words: parsed.words,
      providerUsage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens },
      elapsedMs: Date.now() - startedAt,
      estimatedCostUsd: observedCost.estimatedCostUsd,
      costBasis: "Conservative published Standard-tier estimate from configured USD/minute rate; actual free-tier charge may be $0. No paid service tier is intentionally requested.",
      cleanupWarnings: [
        ...cleanupWarnings,
        ...(parsed.outOfOrderWordAnnotations
          ? [`Chronologically sorted ${parsed.outOfOrderWordAnnotations} out-of-order Gemini word annotation(s); timestamps were preserved.`]
          : []),
        ...(parsed.omittedWordAnnotations
          ? [`Omitted ${parsed.omittedWordAnnotations} Gemini word annotation(s) with missing text or invalid duration; timestamps were not fabricated.`]
          : []),
      ],
    };
  }
}

export function parseGeminiInteraction(jsonText: string): {
  interactionId: string;
  words: TranscriptWord[];
  omittedWordAnnotations: number;
  outOfOrderWordAnnotations: number;
  inputTokens: number | null;
  outputTokens: number | null;
} {
  let raw: unknown;
  try { raw = JSON.parse(jsonText); } catch { throw new Error("Gemini returned invalid JSON"); }
  const parsed = interactionSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Gemini response shape was invalid: ${parsed.error.message}`);
  if (parsed.data.status && parsed.data.status !== "completed") throw new Error(`Gemini interaction status was ${parsed.data.status}`);

  const words: TranscriptWord[] = [];
  let omittedWordAnnotations = 0;
  for (const step of parsed.data.steps ?? []) {
    for (const content of step.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        const result = wordAnnotationSchema.safeParse(annotation);
        if (!result.success) continue;
        const value = result.data;
        const text = (value.text ?? value.word ?? "").trim();
        const startSeconds = parseDuration(value.start_offset);
        const endSeconds = parseDuration(value.end_offset);
        if (!text || endSeconds <= startSeconds) {
          omittedWordAnnotations += 1;
          continue;
        }
        words.push({ text, startSeconds, endSeconds, speakerId: value.speaker ?? null });
      }
    }
  }
  if (!words.length) throw new Error("Gemini returned no word-level timestamp annotations; refusing to invent timestamps");
  let outOfOrderWordAnnotations = 0;
  for (let index = 1; index < words.length; index += 1) {
    if (words[index]!.startSeconds < words[index - 1]!.startSeconds) outOfOrderWordAnnotations += 1;
  }
  words.sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
  return {
    interactionId: "interaction-id-not-returned",
    words,
    omittedWordAnnotations,
    outOfOrderWordAnnotations,
    inputTokens: parsed.data.usage?.total_input_tokens ?? null,
    outputTokens: parsed.data.usage?.total_output_tokens ?? null,
  };
}

async function uploadGeminiFile(audioPath: string, apiKey: string): Promise<{ name: string; uri: string; mimeType: string }> {
  const fileStat = await stat(audioPath);
  const mimeType = "audio/wav";
  const displayName = `vclip-${randomUUID()}-${basename(audioPath)}`;
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(fileStat.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!start.ok) throw await responseError("Gemini file upload initialization", start, apiKey);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini did not return a resumable upload URL");

  const uploaded = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Length": String(fileStat.size),
      "Content-Type": mimeType,
    },
    body: Readable.toWeb(createReadStream(audioPath)) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!uploaded.ok) throw await responseError("Gemini file upload", uploaded, apiKey);
  const raw: unknown = await uploaded.json();
  const shape = z.object({ file: z.object({ name: z.string(), uri: z.string(), mimeType: z.string().optional() }).passthrough() }).safeParse(raw);
  if (!shape.success) throw new Error("Gemini file upload returned unexpected metadata");
  return { name: shape.data.file.name, uri: shape.data.file.uri, mimeType: shape.data.file.mimeType ?? mimeType };
}

async function createGeminiTranscription(
  file: { uri: string; mimeType: string },
  apiKey: string,
  model: string,
  language?: string,
): Promise<ReturnType<typeof parseGeminiInteraction>> {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ type: "audio", uri: file.uri, mime_type: file.mimeType }],
      generation_config: {
        transcription_config: {
          mode: { type: "verbatim", timestamp_granularities: ["word"], diarization_mode: "speaker" },
          ...(language ? { language_codes: [language] } : {}),
        },
      },
      store: false,
    }),
  });
  if (!response.ok) throw await responseError("Gemini transcription", response, apiKey);
  const body = await response.text();
  const result = parseGeminiInteraction(body);
  const json: unknown = JSON.parse(body);
  const maybeId = z.object({ id: z.string().optional() }).passthrough().safeParse(json);
  return { ...result, interactionId: maybeId.success ? maybeId.data.id ?? "not-returned" : "not-returned" };
}

async function deleteGeminiFile(name: string, apiKey: string): Promise<void> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name.split("/").map(encodeURIComponent).join("/")}`, {
    method: "DELETE",
    headers: { "x-goog-api-key": apiKey },
  });
  if (!response.ok && response.status !== 404) throw await responseError("Gemini file deletion", response, apiKey);
}

async function responseError(operation: string, response: Response, apiKey: string): Promise<Error> {
  const body = (await response.text()).slice(0, 500).replaceAll(apiKey, "[redacted]");
  return new Error(`${operation} failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

function parseDuration(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(value);
  if (!match) throw new Error(`Unsupported Gemini duration offset: ${value}`);
  return Number(match[1]);
}

function toSegments(words: TranscriptWord[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: Array<{ word: TranscriptWord; index: number }> = [];
  const flush = () => {
    if (!current.length) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    segments.push({
      startSeconds: first.word.startSeconds,
      endSeconds: last.word.endSeconds,
      text: current.map(({ word }) => word.text).join(" "),
      speakerId: first.word.speakerId,
      wordStartIndex: first.index,
      wordEndIndex: last.index,
    });
    current = [];
  };
  words.forEach((word, index) => {
    const previous = current[current.length - 1]?.word;
    const sentenceEnded = previous && /[.!?]$/.test(previous.text);
    const speakerChanged = previous && previous.speakerId !== word.speakerId;
    const longPause = previous && word.startSeconds - previous.endSeconds > 0.8;
    if (sentenceEnded || speakerChanged || longPause) flush();
    current.push({ word, index });
  });
  flush();
  return segments;
}
