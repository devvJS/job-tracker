// Small helpers shared by the export modules and scripts/export.ts.

/** Code-unit string order, so results never depend on a database collation or locale. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Replaces every occurrence of the secret in s. An empty secret leaves s unchanged. */
export function redact(s: string, secret: string): string {
  return secret === "" ? s : s.split(secret).join("[redacted]");
}
