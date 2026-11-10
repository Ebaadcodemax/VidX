export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (error: unknown) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export async function withRetries<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= options.maxRetries || !options.shouldRetry(error)) throw error;
      const delay = Math.min(options.baseDelayMs * (2 ** attempt), options.maxDelayMs);
      options.onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
    }
  }
}

export function isTransientProcessingError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b|temporarily unavailable|resource temporarily unavailable|timed? ?out|eagain|etimedout|econnreset/i.test(text);
}
