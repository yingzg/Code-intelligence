import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitNexusIndexMode = "auto" | "none" | "basic" | "full";
export type GitNexusAnalyzeProfile = "basic" | "full";
export type GitNexusFreshness = "up_to_date" | "stale" | "unknown";
export type GitNexusRunnerKind = "local" | "global" | "none";

export type GitNexusProgressEvent = {
  phase: "gitnexus";
  message: string;
  stream?: "stdout" | "stderr";
};

export type GitNexusStatus = {
  installed: boolean;
  repo_index_exists: boolean;
  freshness: GitNexusFreshness;
  runner: GitNexusRunnerKind;
  message?: string;
  raw_status?: string;
};

export async function inspectGitNexus(repoPath: string): Promise<GitNexusStatus> {
  const repo_index_exists = await hasRepoIndex(repoPath);
  const hasLocalRunner = await hasLocalGitNexusRunner(repoPath);
  const hasGlobalCommand = hasLocalRunner ? false : await isGitNexusInstalled();
  const installed = hasLocalRunner || hasGlobalCommand;
  const runner: GitNexusRunnerKind = hasLocalRunner ? "local" : hasGlobalCommand ? "global" : "none";

  if (!installed) {
    return {
      installed,
      repo_index_exists,
      freshness: "unknown",
      runner,
      message: "GitNexus 本地运行器或命令不可用"
    };
  }

  let raw_status: string | undefined;
  let freshness: GitNexusFreshness = "unknown";
  let message: string | undefined;
  if (repo_index_exists) {
    try {
      raw_status = await runGitNexusText(repoPath, ["status"]);
      freshness = parseGitNexusFreshness(raw_status);
    } catch (error) {
      message = `GitNexus 状态检查失败：${errorMessage(error)}`;
    }
  }

  return {
    installed,
    repo_index_exists,
    freshness,
    runner,
    ...(message ? { message } : {}),
    ...(raw_status ? { raw_status } : {})
  };
}

export async function runGitNexusAnalyze(
  repoPath: string,
  options: {
    profile?: GitNexusAnalyzeProfile;
    onProgress?: (event: GitNexusProgressEvent) => void;
  } = {}
): Promise<void> {
  const profile = options.profile ?? "basic";
  const args = ["analyze", ...gitNexusAnalyzeArgs(profile)];
  const command = await resolveGitNexusCommand(repoPath, args);
  options.onProgress?.({
    phase: "gitnexus",
    message: `running ${command.file} ${command.args.join(" ")}`
  });

  await spawnGitNexus(command.file, command.args, {
    cwd: repoPath,
    onProgress: options.onProgress
  });
}

async function isGitNexusInstalled(): Promise<boolean> {
  try {
    await execFileAsync("gitnexus", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function hasRepoIndex(repoPath: string): Promise<boolean> {
  try {
    return (await stat(join(repoPath, ".gitnexus"))).isDirectory();
  } catch {
    return false;
  }
}

async function hasLocalGitNexusRunner(repoPath: string): Promise<boolean> {
  try {
    await access(join(repoPath, ".gitnexus", "run.cjs"));
    return true;
  } catch {
    return false;
  }
}

async function runGitNexusText(repoPath: string, args: string[]): Promise<string> {
  const command = await resolveGitNexusCommand(repoPath, args);
  const result = await execFileAsync(command.file, command.args, {
    cwd: repoPath,
    maxBuffer: 20 * 1024 * 1024
  });

  return `${result.stdout}${result.stderr}`.trim();
}

async function resolveGitNexusCommand(repoPath: string, args: string[]): Promise<{ file: string; args: string[] }> {
  if (await hasLocalGitNexusRunner(repoPath)) {
    return {
      file: "node",
      args: [join(repoPath, ".gitnexus", "run.cjs"), ...args]
    };
  }

  return {
    file: "gitnexus",
    args
  };
}

function gitNexusAnalyzeArgs(profile: GitNexusAnalyzeProfile): string[] {
  if (profile === "full") {
    return ["--embeddings", "--skills", "--pdg", "--verbose"];
  }

  return [];
}

function parseGitNexusFreshness(output: string): GitNexusFreshness {
  if (/up[- ]?to[- ]?date|最新|已是最新/i.test(output)) {
    return "up_to_date";
  }
  if (/stale|out[- ]?of[- ]?date|needs?\s+analy|需要.*索引|过期/i.test(output)) {
    return "stale";
  }

  return "unknown";
}

async function spawnGitNexus(
  file: string,
  args: string[],
  options: {
    cwd: string;
    onProgress?: (event: GitNexusProgressEvent) => void;
  }
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const message of splitProgressLines(chunk)) {
        options.onProgress?.({ phase: "gitnexus", stream: "stdout", message });
      }
    });
    child.stderr.on("data", (chunk: string) => {
      for (const message of splitProgressLines(chunk)) {
        options.onProgress?.({ phase: "gitnexus", stream: "stderr", message });
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`GitNexus analyze failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function splitProgressLines(chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
