import type { Diagnostic } from "./schemas.js";

export function diagnostic(input: Diagnostic): Diagnostic {
  return input;
}

export function warning(code: Diagnostic["code"], message: string, suggested_action?: string): Diagnostic {
  return {
    level: "warning",
    code,
    message,
    suggested_action
  };
}
