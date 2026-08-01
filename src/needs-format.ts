import type { ItemNeeds } from "./metadata";

export function formatDeclaredNeeds(needs: ItemNeeds): string | null {
  const parts: string[] = [];
  if (needs.env.length > 0) parts.push(`reads env: ${needs.env.join(", ")}`);
  if (needs.bin.length > 0) {
    parts.push(`needs on PATH: ${needs.bin.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
