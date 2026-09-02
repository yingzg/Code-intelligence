import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitNexusRunner = (args: string[], options: { cwd: string }) => Promise<unknown>;

export async function runGitNexusJson(args: string[], options: { cwd: string }): Promise<unknown> {
  const runner = join(options.cwd, ".gitnexus", "run.cjs");
  const result = await execFileAsync("node", [runner, ...args], {
    cwd: options.cwd,
    maxBuffer: 20 * 1024 * 1024
  });

  return JSON.parse(result.stdout) as unknown;
}
