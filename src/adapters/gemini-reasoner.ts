import { z } from "zod";
import type { AppConfig } from "../schemas/config";
import type { Reasoner, ModelUsage } from "./reasoner";

const responseSchema = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() }).passthrough()).optional() }).passthrough() }).passthrough()).optional(),
  usageMetadata: z.object({ promptTokenCount: z.number().int().nonnegative().optional(), candidatesTokenCount: z.number().int().nonnegative().optional() }).passthrough().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();

export class GeminiReasoner implements Reasoner {
  readonly id = "gemini";
  readonly model: string;
  constructor(private readonly config: AppConfig) { this.model = config.reasoner.model; }

  async availability(): Promise<{ available: boolean; reason?: string }> {
    const options = this.config.reasoner;
    if (!process.env[options.apiKeyEnv]) return { available: false, reason: `${options.apiKeyEnv} is not set` };
    if (process.env[options.creatorConsentEnv]?.toLowerCase() !== "true") return { available: false, reason: `${options.creatorConsentEnv}=true is required before transcript text can be sent` };
    if (process.env[options.unpaidDataUseAckEnv]?.toLowerCase() !== "true") return { available: false, reason: `${options.unpaidDataUseAckEnv}=true is required for unpaid-tier data-use acknowledgement` };
    if (process.env[options.freeTierOnlyEnv]?.toLowerCase() !== "true") return { available: false, reason: `${options.freeTierOnlyEnv}=true is required; vclip cannot inspect Google billing settings` };
    return { available: true };
  }

  async generateJson<T>(prompt: string, _schema: import("zod").ZodType<T>): Promise<{ data: unknown; usage: ModelUsage }> {
    const ready = await this.availability();
    if (!ready.available) throw new Error(ready.reason ?? "Gemini is not configured");
    const apiKey = process.env[this.config.reasoner.apiKeyEnv]!;
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.reasoner.timeoutMs);
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: this.config.reasoner.maxOutputTokens, temperature: 0.2 } }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500).replaceAll(apiKey, "[redacted]");
        throw new Error(`Gemini JSON request failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Gemini returned an unexpected JSON response shape");
      const text = parsed.data.candidates?.flatMap((candidate) => candidate.content.parts ?? []).map((part) => part.text ?? "").join("").trim();
      if (!text) throw new Error(parsed.data.error?.message ?? "Gemini returned no JSON content");
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new Error("Gemini returned invalid JSON text"); }
      return { data, usage: { inputTokens: parsed.data.usageMetadata?.promptTokenCount ?? null, outputTokens: parsed.data.usageMetadata?.candidatesTokenCount ?? null, elapsedMs: Date.now() - started } };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`Gemini request exceeded ${this.config.reasoner.timeoutMs} ms`);
      throw error;
    } finally { clearTimeout(timeout); }
  }
}
