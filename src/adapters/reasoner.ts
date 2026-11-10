import type { ZodType } from "zod";

export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number;
}

export interface Reasoner {
  readonly id: string;
  readonly model: string;
  availability(): Promise<{ available: boolean; reason?: string }>;
  generateJson<T>(prompt: string, schema: ZodType<T>): Promise<{ data: unknown; usage: ModelUsage }>;
}
