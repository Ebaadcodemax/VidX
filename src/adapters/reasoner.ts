import type { ZodType } from "zod";

export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number;
  responseStatus?: string;
  thoughtTokens?: number | null;
}

export interface Reasoner {
  readonly id: string;
  readonly model: string;
  readonly endpoint?: string;
  availability(): Promise<{ available: boolean; reason?: string }>;
  countInputTokens?(prompt: string): Promise<number>;
  generateJson<T>(prompt: string, schema: ZodType<T>): Promise<{ data: unknown; usage: ModelUsage }>;
}

export class RetryableReasonerError extends Error {
  constructor(message: string, readonly statusCode: 429 | 503, readonly retryAfterMs?: number) {
    super(message);
    this.name = "RetryableReasonerError";
  }
}
