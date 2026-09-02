import type { Confidence } from "../schemas.js";

export function confidenceFromScore(score: number): Confidence {
  if (score >= 0.85) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

export function downgradeForStale(confidence: Confidence, stale: boolean): Confidence {
  if (!stale) return confidence;
  if (confidence === "high") return "medium";
  if (confidence === "medium") return "low";
  return "low";
}
