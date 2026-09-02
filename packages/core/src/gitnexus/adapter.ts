import { runGitNexusJson } from "./cli.js";

export type GitNexusAdapterOptions = {
  run?: (args: string[], options: { cwd: string }) => Promise<unknown>;
};

export type GitNexusContextInput = {
  repoPath: string;
  repo: string;
  symbol: string;
  limit?: number;
};

export type GitNexusQueryInput = {
  repoPath: string;
  repo: string;
  query: string;
  limit?: number;
};

export type GitNexusTraceInput = {
  repoPath: string;
  repo: string;
  from: string;
  to: string;
  fromUid?: string;
  fromFile?: string;
  toUid?: string;
  toFile?: string;
  depth?: number;
};

export function createGitNexusAdapter(options: GitNexusAdapterOptions = {}) {
  const run = options.run ?? ((args, runOptions) => runGitNexusJson(args, runOptions));

  return {
    status: (input: { repoPath: string }) => run(["status"], { cwd: input.repoPath }),
    query: (input: GitNexusQueryInput) => run([
      "query",
      input.query,
      "--repo",
      input.repo,
      "--limit",
      String(input.limit ?? 5)
    ], { cwd: input.repoPath }),
    context: (input: GitNexusContextInput) => run([
      "context",
      input.symbol,
      "--repo",
      input.repo,
      "--limit",
      String(input.limit ?? 10)
    ], { cwd: input.repoPath }),
    trace: (input: GitNexusTraceInput) => run(traceArgs(input), { cwd: input.repoPath })
  };
}

function traceArgs(input: GitNexusTraceInput): string[] {
  const args = [
    "trace",
    input.from,
    input.to,
    "--repo",
    input.repo,
    "--depth",
    String(input.depth ?? 10)
  ];

  if (input.fromUid) args.push("--from-uid", input.fromUid);
  if (input.fromFile) args.push("--from-file", input.fromFile);
  if (input.toUid) args.push("--to-uid", input.toUid);
  if (input.toFile) args.push("--to-file", input.toFile);

  return args;
}
