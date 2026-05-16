// Minimal CSV serialiser. RFC 4180-style: comma separator, "" for
// embedded quotes, CRLF line endings, header row first.

function escapeCell(v: unknown): string {
  if (v == null) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString().slice(0, 10);
  else if (typeof v === "number") s = Number.isFinite(v) ? String(v) : "";
  else s = String(v);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(rows: Array<Record<string, unknown>>, headers?: string[]): string {
  if (rows.length === 0) {
    return (headers ?? []).join(",") + "\r\n";
  }
  const cols = headers ?? Object.keys(rows[0]);
  const lines: string[] = [];
  lines.push(cols.map(escapeCell).join(","));
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCell(row[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      // BOM prefix so Excel detects UTF-8 instead of mojibake on BDT amounts
      // (cells contain no non-ASCII today, but harmless and future-proof).
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
