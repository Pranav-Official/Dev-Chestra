/**
 * Small well-tested CSV parser for foreach csv sources: header row + RFC4180
 * quoted fields with embedded commas, quotes ("") and multiline fields.
 * Returns row objects keyed by header. Throws DevChestraError on malformed input.
 */
import { DevChestraError } from "@devchestra/core";

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  // ponytail: single-pass scanner, no dependency. Handles \r\n, \n, "" escapes and multiline quoted fields.
  while (i < text.length) {
    const char = text[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      if (field.length !== 0) {
        throw new DevChestraError("E_VALIDATION", "Malformed CSV: quote inside unquoted field");
      }
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (char === "\r" && text[i + 1] === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i += 2;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (inQuotes)
    throw new DevChestraError("E_VALIDATION", "Malformed CSV: unterminated quoted field");
  row.push(field);
  // Trailing single empty field from a final newline is not a row.
  const lastIsEmpty = row.length === 1 && row[0] === "" && rows.length > 0;
  if (!lastIsEmpty) rows.push(row);
  const nonEmpty = rows.filter((candidate) => !(candidate.length === 1 && candidate[0] === ""));
  if (nonEmpty.length === 0) return [];
  const header = (nonEmpty[0] as string[]).map((cell) => cell.trim());
  if (header.some((cell) => cell.length === 0)) {
    throw new DevChestraError("E_VALIDATION", "CSV header must not contain empty names");
  }
  if (new Set(header).size !== header.length) {
    throw new DevChestraError("E_VALIDATION", "CSV header must not contain duplicate names");
  }
  const out: Record<string, string>[] = [];
  for (const line of nonEmpty.slice(1)) {
    if (line.length !== header.length) {
      throw new DevChestraError(
        "E_VALIDATION",
        "CSV row has a different field count than the header",
        {
          details: { expected: header.length, received: line.length },
        },
      );
    }
    out.push(Object.fromEntries(header.map((name, index) => [name, line[index] as string])));
  }
  return out;
}
