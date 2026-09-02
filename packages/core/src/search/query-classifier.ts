import type { QueryType } from "../schemas.js";

export function classifyQuery(query: string, explicitType?: QueryType): QueryType {
  if (explicitType) return explicitType;

  const trimmed = query.trim();
  if (/^(GET|POST|PUT|DELETE|PATCH)\s+\//i.test(trimmed) || trimmed.startsWith("/")) return "route";
  if (/\bselect\b|\bfrom\b|\bwhere\b/i.test(trimmed)) return "sql";
  if (/Exception\b|ERROR|WARN|Broken pipe|[A-Z][A-Z0-9_]{5,}/.test(trimmed)) return "error";
  if (/^[a-zA-Z_][\w]*(_[a-zA-Z0-9]+)+$/.test(trimmed)) return "table";
  if (/^[A-Z]\w+\.\w+$/.test(trimmed)) return "symbol";

  return "semantic";
}
