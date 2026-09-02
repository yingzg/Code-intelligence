import { readFile } from "node:fs/promises";

export async function readSnippet(file: string, line: number, radius = 2): Promise<string> {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  const requestedLine = Number.isFinite(line) ? Math.max(1, Math.floor(line)) : 1;
  const safeLine = Math.min(requestedLine, lines.length);
  const safeRadius = Number.isFinite(radius) ? Math.max(0, Math.floor(radius)) : 0;
  const start = Math.max(1, safeLine - safeRadius);
  const end = Math.min(lines.length, safeLine + safeRadius);

  return lines.slice(start - 1, end).join("\n");
}
