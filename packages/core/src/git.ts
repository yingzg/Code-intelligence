import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname } from "node:path";
import { SOURCE_EXTENSIONS } from "./source-roots.js";

const execFileAsync = promisify(execFile);

export type GitState = {
  commit_hash?: string;
  dirty: boolean;
};

export async function readGitState(cwd: string): Promise<GitState> {
  try {
    const rev = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd });

    return {
      commit_hash: rev.stdout.trim() || undefined,
      dirty: hasSourceCodeChanges(status.stdout)
    };
  } catch {
    return { dirty: false };
  }
}

function hasSourceCodeChanges(statusOutput: string): boolean {
  for (const rawLine of statusOutput.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;

    const statusCode = line.slice(0, 2);
    if (statusCode === "??") continue;

    let path = line.slice(3).trim();
    const arrowIndex = path.indexOf(" -> ");
    if (arrowIndex >= 0) path = path.slice(arrowIndex + 4);
    path = path.replace(/^"|"$/g, "");

    if (SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  }

  return false;
}
