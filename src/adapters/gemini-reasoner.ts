import { z } from "zod";
import type { AppConfig } from "../schemas/config";
import { RetryableReasonerError, type Reasoner, type ModelUsage } from "./reasoner";

const responseSchema = z.object({
  status: z.string().optional(),
  steps: z.array(z.object({ type: z.string().optional(), content: z.array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough()).optional() }).passthrough()).optional(),
  usage: z.object({ total_input_tokens: z.number().int().nonnegative().optional(), total_output_tokens: z.number().int().nonnegative().optional(), total_thought_tokens: z.number().int().nonnegative().optional() }).passthrough().optional(),
  errors: z.array(z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough()).optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();
const tokenCountSchema = z.object({ totalTokens: z.number().int().nonnegative() }).passthrough();

export class GeminiReasoner implements Reasoner {
  readonly id = "gemini";
  readonly model: string;
  readonly endpoint = "https://generativelanguage.googleapis.com/v1beta/interactions";
  constructor(private readonly config: AppConfig) { this.model = config.reasoner.model; }

  async availability(): Promise<{ available: boolean; reason?: string }> {
    const options = this.config.reasoner;
    if (!process.env[options.apiKeyEnv]) return { available: false, reason: `${options.apiKeyEnv} is not set` };
    if (process.env[options.creatorConsentEnv]?.toLowerCase() !== "true") return { available: false, reason: `${options.creatorConsentEnv}=true is required before transcript text can be sent` };
    if (process.env[options.unpaidDataUseAckEnv]?.toLowerCase() !== "true") return { available: false, reason: `${options.unpaidDataUseAckEnv}=true is required for unpaid-tier data-use acknowledgement` };
    if (process.env[options.freeTierOnlyEnv]?.toLowerCase() !== "true") return { available: false, reason: `${options.freeTierOnlyEnv}=true is required; vclip cannot inspect Google billing settings` };
    return { available: true };
  }

  async countInputTokens(prompt: string): Promise<number> {
    const ready = await this.availability();
    if (!ready.available) throw new Error(ready.reason ?? "Gemini is not configured");
    const apiKey = process.env[this.config.reasoner.apiKeyEnv]!;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:countTokens`, {
      method: "POST", headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300).replaceAll(apiKey, "[redacted]");
      throw new Error(`Gemini token count failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
    const parsed = tokenCountSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Gemini token count returned an unexpected response");
    return parsed.data.totalTokens;
  }

  async generateJson<T>(prompt: string, schema: import("zod").ZodType<T>): Promise<{ data: unknown; usage: ModelUsage }> {
    const ready = await this.availability();
    if (!ready.available) throw new Error(ready.reason ?? "Gemini is not configured");
    const apiKey = process.env[this.config.reasoner.apiKeyEnv]!;
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.reasoner.timeoutMs);
    const responseJsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    delete responseJsonSchema.$schema;
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: prompt,
          response_format: { type: "text", mime_type: "application/json", schema: responseJsonSchema },
          generation_config: { max_output_tokens: this.config.reasoner.maxOutputTokens, temperature: 0.2, thinking_level: this.config.reasoner.thinkingLevel },
          store: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500).replaceAll(apiKey, "[redacted]");
        if (response.status === 429 || response.status === 503) {
          const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
          throw new RetryableReasonerError(`Gemini JSON request failed with HTTP ${response.status}${body ? `: ${body}` : ""}`, response.status, retryAfterMs);
        }
        throw new Error(`Gemini JSON request failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Gemini returned an unexpected JSON response shape");
      const text = parsed.data.steps?.filter((step) => step.type === "model_output").flatMap((step) => step.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("").trim();
      let data: unknown;
      // Keep malformed output as untrusted text so the pipeline's single
      // schema-guided repair call can correct it; never parse or execute it here.
      if (!text) data = { providerStatus: parsed.data.status ?? "unknown", errors: parsed.data.errors ?? [] };
      else { try { data = JSON.parse(text); } catch { data = text; } }
      return { data, usage: { inputTokens: parsed.data.usage?.total_input_tokens ?? null, outputTokens: parsed.data.usage?.total_output_tokens ?? null, thoughtTokens: parsed.data.usage?.total_thought_tokens ?? null, responseStatus: parsed.data.status, elapsedMs: Date.now() - started } };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`Gemini request exceeded ${this.config.reasoner.timeoutMs} ms`);
      throw error;
    } finally { clearTimeout(timeout); }
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
