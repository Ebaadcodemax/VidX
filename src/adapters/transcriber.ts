import type { TranscriptSegment, TranscriptWord } from "../schemas/transcript";

export type TranscriberId = "faster-whisper" | "gemini";

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface TranscriptionResult {
  provider: TranscriberId;
  model: string;
  version: string;
  language: { code: string | null; probability: number | null };
  speakerLabels: "provider" | "unavailable";
  transcriptText: string;
  segments: TranscriptSegment[];
  words: TranscriptWord[];
  providerUsage: ProviderUsage;
  elapsedMs: number;
  estimatedCostUsd: number;
  costBasis: string;
  cleanupWarnings: string[];
}

export interface Transcriber {
  readonly id: TranscriberId;
  readonly model: string;
  availability(): Promise<{ available: boolean; reason?: string }>;
  transcribe(audioPath: string, options: { audioSeconds: number; maxRunCostUsd: number; language?: string }): Promise<TranscriptionResult>;
}
