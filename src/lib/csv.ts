/**
 * A small RFC 4180 CSV parser (#22): comma-separated fields, double-quoted
 * fields that may hold commas, quotes (doubled) and line breaks, CRLF or LF
 * line ends, a leading UTF-8 BOM ignored. It needs no dependency (STACK-1).
 */

export class CsvError extends Error {
  /** The 1-based line on which the problem was found. */
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = 'CsvError';
  }
}

/** Every record of `text` as an array of fields, in order; a trailing line break adds no record. */
export function parseCsv(text: string): string[][] {
  const input = text.startsWith('﻿') ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let fieldStarted = false;

  const endField = () => { record.push(field); field = ''; afterQuote = false; fieldStarted = false; };
  const endRecord = () => { endField(); records.push(record); record = []; };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') { field += '"'; index += 1; } else { quoted = false; afterQuote = true; }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }
    if (char === ',') { endField(); continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      endRecord();
      line += 1;
      continue;
    }
    if (afterQuote) throw new CsvError('A quoted field must end at a comma or the end of the line.', line);
    if (char === '"') {
      if (fieldStarted) throw new CsvError('A quote may only start a field.', line);
      quoted = true;
      fieldStarted = true;
      continue;
    }
    field += char;
    fieldStarted = true;
  }
  if (quoted) throw new CsvError('A quoted field is not closed.', line);
  if (fieldStarted || afterQuote || record.length) endRecord();
  return records;
}

/** Whether every field of a record is empty after trimming (Google Sheets exports its empty rows as `,,,`). */
export function isEmptyRecord(record: readonly string[]) {
  return record.every((value) => value.trim() === '');
}
