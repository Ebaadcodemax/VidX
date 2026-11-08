import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { configSchema, type AppConfig } from "../schemas/config";

export async function loadConfig(filePath = resolve(process.cwd(), "config.yaml")): Promise<AppConfig> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read config file at ${filePath}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error) {
    throw new Error(`Config YAML is invalid: ${errorMessage(error)}`);
  }

  const result = configSchema.safeParse(parsed ?? {});
  if (!result.success) {
    throw new Error(`Config is invalid: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
