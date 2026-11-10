import { describe, expect, it, vi } from "vitest";
import { isTransientProcessingError, withRetries } from "../src/lib/retry";

describe("bounded retries", () => {
  it("retries transient failures with capped exponential delays", async () => {
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 503"))
      .mockRejectedValueOnce(new Error("resource temporarily unavailable"))
      .mockResolvedValue("ok");
    await expect(withRetries(operation, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 15, shouldRetry: isTransientProcessingError, sleep })).resolves.toBe("ok");
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 15]);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent failures or exceed the retry limit", async () => {
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const permanent = vi.fn().mockRejectedValue(new Error("Invalid data found when processing input"));
    await expect(withRetries(permanent, { maxRetries: 4, baseDelayMs: 1, maxDelayMs: 1, shouldRetry: isTransientProcessingError, sleep })).rejects.toThrow("Invalid data");
    expect(permanent).toHaveBeenCalledTimes(1);

    const transient = vi.fn().mockRejectedValue(new Error("HTTP 503"));
    await expect(withRetries(transient, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, shouldRetry: isTransientProcessingError, sleep })).rejects.toThrow("503");
    expect(transient).toHaveBeenCalledTimes(3);
  });
});
