import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown process error";
    const stderr = isExecError(error) && error.stderr ? `\n${error.stderr}` : "";
    throw new Error(`${command} failed: ${detail}${stderr}`);
  }
}

function isExecError(error: unknown): error is Error & { stderr?: string } {
  return error instanceof Error && "stderr" in error;
}
