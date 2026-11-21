// The entry's driver, keeping the baseline's (csv-reader 1.0.0, the house entry) conventions: the harness runs
// `node /bot/main.ts` (node22). It reads every case from /input/cases.json (a JSON array of {id, input}), answers each
// one alone with run() from solve.js, and writes /output/answers.json: a JSON array of the answers, one per case and in
// the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// What differs from the baseline's driver:
//   - The answers are written another way. In place of JSON.stringify(answers) and one writeFileSync, each answer is
//     encoded as soon as it is made, straight to UTF-8 JSON in one byte buffer, and then let go; the buffer is written
//     to the file once at the end. The encoder escapes exactly as JSON.stringify does ("\"", "\\", \b \f \n \r \t,
//     \u00xx for the other control characters, \udxxx for a lone surrogate), and hands arrays of objects (the errors)
//     to JSON.stringify itself, so the file holds the same bytes JSON.stringify(answers) would have, without the large
//     intermediate strings and without keeping the answers of earlier cases alive. The writer is warmed up on a small
//     answer first, so that V8 compiles it from complete type feedback.
//   - V8's top tier (TurboFan) is kept off. The run is one pass of well under a second, and TurboFan's compiles of the
//     hot loops cost more CPU than they save; Maglev's code is about as fast here and compiles in a millisecond.

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too). --turbo-filter=~ lets no named
// function reach TurboFan (a flag V8 has long had, read when a function is about to be optimized); it is set only on a
// V8 with Maglev (12 and later, node22 among them), so the hot code still gets an optimizing tier.
setFlagsFromString('--no-incremental-marking');
if (Number.parseInt(process.versions.v8, 10) >= 12) setFlagsFromString('--maglev --turbo-filter=~');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---- The UTF-8 JSON writer ----

let buf = new Uint8Array(64); // the encoded answers (grown as needed, written to the file once at the end)
let len = 0; // bytes held in buf
const HEX = '0123456789abcdef';

/** Makes room for k more bytes. */
function room(k: number): void {
  if (len + k > buf.length) grow(k);
}

function grow(k: number): void {
  let size = buf.length * 2;
  while (size < len + k) size *= 2;
  const next = new Uint8Array(size);
  next.set(buf.subarray(0, len));
  buf = next;
}

function ascii(s: string): void {
  const n = s.length;
  room(n);
  const b = buf;
  let j = len;
  for (let i = 0; i < n; i++) b[j++] = s.charCodeAt(i);
  len = j;
}

/** \uXXXX, lowercase hex, as JSON.stringify writes it. */
function hex4(b: Uint8Array, j: number, c: number): number {
  b[j++] = 92;
  b[j++] = 117;
  b[j++] = HEX.charCodeAt(c >> 12);
  b[j++] = HEX.charCodeAt((c >> 8) & 15);
  b[j++] = HEX.charCodeAt((c >> 4) & 15);
  b[j++] = HEX.charCodeAt(c & 15);
  return j;
}

/** The escape of an ASCII character JSON.stringify does not write as it stands. */
function escape(b: Uint8Array, j: number, c: number): number {
  let e = 0;
  if (c === 34) e = 34;
  else if (c === 92) e = 92;
  else if (c === 10) e = 110;
  else if (c === 13) e = 114;
  else if (c === 9) e = 116;
  else if (c === 8) e = 98;
  else if (c === 12) e = 102;
  else return hex4(b, j, c);
  b[j++] = 92;
  b[j++] = e;
  return j;
}

/** A string as JSON, after the byte `sep` (0: none). */
function str(s: string, sep: number): void {
  const n = s.length;
  room(6 * n + 3);
  const b = buf;
  let j = len;
  if (sep !== 0) b[j++] = sep;
  b[j++] = 34;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      if (c >= 0x20 && c !== 34 && c !== 92) b[j++] = c;
      else j = escape(b, j, c);
    } else if (c < 0x800) {
      b[j++] = 0xc0 | (c >> 6);
      b[j++] = 0x80 | (c & 63);
    } else if (c < 0xd800 || c >= 0xe000) {
      b[j++] = 0xe0 | (c >> 12);
      b[j++] = 0x80 | ((c >> 6) & 63);
      b[j++] = 0x80 | (c & 63);
    } else {
      const d = i + 1 < n ? s.charCodeAt(i + 1) : 0;
      if (c < 0xdc00 && d >= 0xdc00 && d < 0xe000) {
        const p = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        b[j++] = 0xf0 | (p >> 18);
        b[j++] = 0x80 | ((p >> 12) & 63);
        b[j++] = 0x80 | ((p >> 6) & 63);
        b[j++] = 0x80 | (p & 63);
        i++;
      } else j = hex4(b, j, c); // a lone surrogate
    }
  }
  b[j++] = 34;
  len = j;
}

function byte(c: number): void {
  room(1);
  buf[len++] = c;
}

function array(a: unknown[]): void {
  const n = a.length;
  if (n > 0) {
    const first = a[0];
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      // An array of objects (the errors): JSON.stringify's own writer is the quicker one for objects, and its text,
      // well-formed (no lone surrogate), is copied in as UTF-8: the same bytes.
      raw(JSON.stringify(a));
      return;
    }
  }
  byte(91);
  for (let i = 0; i < n; i++) {
    const v = a[i];
    if (typeof v === 'string') str(v, i > 0 ? 44 : 0);
    else {
      if (i > 0) byte(44);
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') ascii('null');
      else value(v);
    }
  }
  byte(93);
}

function object(o: Record<string, unknown>): void {
  byte(123);
  let first = true;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    str(k, first ? 0 : 44);
    first = false;
    byte(58);
    value(v);
  }
  byte(125);
}

/** Writes v as JSON.stringify would. Anything but plain data (toJSON, a class instance) goes through JSON.stringify. */
function value(v: unknown): void {
  if (typeof v === 'string') str(v, 0);
  else if (typeof v === 'number') ascii(Number.isFinite(v) ? String(v) : 'null');
  else if (typeof v === 'boolean') ascii(v ? 'true' : 'false');
  else if (v === null) ascii('null');
  else if (Array.isArray(v)) array(v);
  else if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && typeof (v as { toJSON?: unknown }).toJSON !== 'function') object(v as Record<string, unknown>);
  else raw(JSON.stringify(v) ?? 'null'); // never reached by run's answers, which are plain data
}

/** JSON text as it stands, UTF-8. */
function raw(json: string): void {
  const bytes = Buffer.from(json, 'utf8');
  room(bytes.length);
  buf.set(bytes, len);
  len += bytes.length;
}

// ---- Warm-up: every branch of the writer taken on a small answer before the real ones (grown from 64 bytes) ----
{
  const sample = {
    columns: ['a', 'b\u00e9', '\u6578'],
    rows: [['x', 'y"z\\', 'line\nbreak\r\t\b\f\u0001'], ['\ud83d\ude00', '\ud800', 'q\udc00'], ['', 'é', 'long field with words 1234567890']],
    errors: [{ code: 'short_row', line: 3, row: 1, fields: 2 }, { code: 'stray_cr', line: 1, row: null }, { code: 'long_row', line: 9, row: 5, extra: ['p', 'q'] }],
  };
  const headerless = { columns: null, rows: [[]], errors: [] }; // header: false, and empty arrays
  for (let i = 0; i < 30; i++) {
    value(sample);
    value(headerless);
    if (len > 4096) len = 0;
  }
  len = 0;
}

// The file's bytes decoded as UTF-8 by Buffer#toString: the same string readFileSync(path, 'utf8') gives (no BOM is
// dropped), and quicker to make.
const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json')).toString('utf8')) as ({ id: string; input: unknown } | null)[];

// Room for the answers up front: one and a half times the texts' length, which the answers' UTF-8 JSON rarely passes
// (grown if it does). Pages never written are never touched.
let estimate = 1 << 16;
for (const c of cases) {
  const text = (c?.input as { text?: unknown } | undefined)?.text;
  if (typeof text === 'string') estimate += text.length + (text.length >> 1);
}
buf = new Uint8Array(estimate);
len = 0;

byte(91);
for (let i = 0; i < cases.length; i++) {
  if (i > 0) byte(44);
  const answer = run(cases[i]!.input);
  cases[i] = null; // the case's text is no longer needed
  if (answer === undefined || typeof answer === 'function' || typeof answer === 'symbol') ascii('null');
  else value(answer);
}
byte(93);

const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
try {
  let done = 0;
  while (done < len) done += writeSync(fd, buf, done, len - done);
} finally {
  closeSync(fd);
}
