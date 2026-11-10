import { z } from "zod";

export const transcriptWordSchema = z.object({
  text: z.string().min(1),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  speakerId: z.string().nullable(),
  confidence: z.number().min(0).max(1).optional(),
}).strict().refine((word) => word.endSeconds > word.startSeconds, "word end must be after word start");

export const transcriptSegmentSchema = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  text: z.string(),
  speakerId: z.string().nullable(),
  wordStartIndex: z.number().int().nonnegative(),
  wordEndIndex: z.number().int().nonnegative(),
}).strict().refine((segment) => segment.endSeconds > segment.startSeconds, "segment end must be after segment start");

export const transcriptSchema = z.object({
  schemaVersion: z.literal("vclip-transcript/0.1"),
  provider: z.object({ id: z.enum(["faster-whisper", "gemini"]), model: z.string(), version: z.string() }).strict(),
  source: z.object({ fileName: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), durationSeconds: z.number().positive() }).strict(),
  language: z.object({ code: z.string().nullable(), probability: z.number().min(0).max(1).nullable() }).strict(),
  speakerLabels: z.enum(["provider", "unavailable"]),
  transcriptText: z.string(),
  segments: z.array(transcriptSegmentSchema),
  words: z.array(transcriptWordSchema),
  timing: z.object({ startedAt: z.string().datetime(), elapsedMs: z.number().nonnegative() }).strict(),
  usage: z.object({
    audioSeconds: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    estimatedCostUsd: z.number().nonnegative(),
    costBasis: z.string(),
  }).strict(),
  cleanupWarnings: z.array(z.string()),
}).strict();

export type TranscriptDocument = z.infer<typeof transcriptSchema>;
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
