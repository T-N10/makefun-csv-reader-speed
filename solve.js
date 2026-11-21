// A faster drop-in for make.fun's csv-reader 1.0.0: run(input) returns the same {columns, rows, errors} for every
// input {text, header}. One pass over the text with charCodeAt; fields are cut out with slice() instead of being built
// a character at a time, and only fields holding "" pairs, CRs or quote junk are assembled from pieces.
//
// The reader is split into small functions on purpose: V8 compiles each one quickly, and the rare paths (stray CRs,
// junk after a closing quote, a quote that never closes) live out of line, so meeting one does not throw away the
// optimized code of the hot loop.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// The reading in progress (module state, reset by every run).
let T = ''; // the text
let N = 0; // its length
let P = 0; // the next character to read
let L = 1; // the line that character is on
let E = []; // the errors
let RL = 1; // the line the record starts on
let RR = null; // the record's index in rows (null: the header)
let ENDED = COMMA; // how the last field ended
let ADDED = 0; // characters kept by the last readUnquoted
let QUOTED = false; // whether the record's last field opened with a quote

function strayCr() {
  E.push({ code: 'stray_cr', line: RL, row: RR });
}

// Reads unquoted characters from p onto `value` up to the next comma or line break, dropping each CR not followed by
// LF (stray_cr). Sets P, ENDED and ADDED (the characters kept).
function readUnquoted(value, p) {
  const t = T;
  const n = N;
  let s = p;
  let added = 0;
  for (;;) {
    if (p >= n) {
      added += p - s;
      value += t.slice(s, p);
      P = p;
      ENDED = END;
      break;
    }
    const d = t.charCodeAt(p);
    if (d === 44) {
      added += p - s;
      value += t.slice(s, p);
      P = p + 1;
      ENDED = COMMA;
      break;
    }
    if (d === 10) {
      added += p - s;
      value += t.slice(s, p);
      P = p + 1;
      L++;
      ENDED = LINE_BREAK;
      break;
    }
    if (d === 13) {
      added += p - s;
      value += t.slice(s, p);
      if (p + 1 < n && t.charCodeAt(p + 1) === 10) {
        P = p + 2;
        L++;
        ENDED = LINE_BREAK;
        break;
      }
      strayCr();
      p++;
      s = p;
      continue;
    }
    p++;
  }
  ADDED = added;
  return value;
}

// A quote that never closes: a literal character, and the text after it is read again as unquoted.
function unterminated(open) {
  E.push({ code: 'unterminated_quote', line: RL, row: RR });
  return readUnquoted('"', open + 1);
}

// What follows a closing quote at p that is not a comma or a line break: appended as it stands.
function junk(value, p) {
  value = readUnquoted(value, p);
  if (ADDED > 0) E.push({ code: 'quote_junk', line: RL, row: RR });
  return value;
}

// A quoted field holding "" pairs or CRs, from p (inside the quotes, after the plain run that started at seg).
function readQuotedSlow(open, seg, p, lines) {
  const t = T;
  const n = N;
  let value = '';
  for (;;) {
    if (p >= n) return unterminated(open);
    const c = t.charCodeAt(p);
    if (c === 34) {
      if (p + 1 < n && t.charCodeAt(p + 1) === 34) {
        value += t.slice(seg, p + 1);
        p += 2;
        seg = p;
        continue;
      }
      break;
    }
    if (c === 13) {
      value += t.slice(seg, p) + '\n';
      lines++;
      p += p + 1 < n && t.charCodeAt(p + 1) === 10 ? 2 : 1;
      seg = p;
      continue;
    }
    if (c === 10) lines++;
    p++;
  }
  value += t.slice(seg, p);
  L += lines;
  return afterQuote(value, p + 1);
}

// After the closing quote, at p.
function afterQuote(value, p) {
  const t = T;
  const n = N;
  if (p >= n) {
    P = p;
    ENDED = END;
    return value;
  }
  const c = t.charCodeAt(p);
  if (c === 44) {
    P = p + 1;
    ENDED = COMMA;
    return value;
  }
  if (c === 10) {
    P = p + 1;
    L++;
    ENDED = LINE_BREAK;
    return value;
  }
  if (c === 13 && p + 1 < n && t.charCodeAt(p + 1) === 10) {
    P = p + 2;
    L++;
    ENDED = LINE_BREAK;
    return value;
  }
  return junk(value, p);
}

// A field opening with the quote at `open`. Sets P and ENDED.
function readQuoted(open) {
  const t = T;
  const n = N;
  let p = open + 1;
  let lines = 0;
  for (;;) {
    if (p >= n) return unterminated(open);
    const c = t.charCodeAt(p);
    if (c === 34) break;
    if (c === 13) return readQuotedSlow(open, open + 1, p, lines);
    if (c === 10) lines++;
    p++;
  }
  if (p + 1 < n && t.charCodeAt(p + 1) === 34) return readQuotedSlow(open, open + 1, p, lines);
  L += lines;
  return afterQuote(t.slice(open + 1, p), p + 1);
}

// Reads one record from P: its fields. Sets P, ENDED and QUOTED.
function readRecord() {
  const t = T;
  const n = N;
  const fields = [];
  let p = P;
  for (;;) {
    if (p < n && t.charCodeAt(p) === 34) {
      QUOTED = true;
      fields.push(readQuoted(p));
      p = P;
      if (ENDED !== COMMA) return fields;
      continue;
    }
    QUOTED = false;
    const start = p;
    let c = 0;
    while (p < n && ((c = t.charCodeAt(p)) > 44 || (c !== 44 && c !== 10 && c !== 13))) p++;
    if (p >= n) {
      fields.push(t.slice(start, p));
      P = p;
      ENDED = END;
      return fields;
    }
    if (c === 44) {
      fields.push(t.slice(start, p));
      p++;
      continue;
    }
    if (c === 10) {
      fields.push(t.slice(start, p));
      P = p + 1;
      L++;
      ENDED = LINE_BREAK;
      return fields;
    }
    if (p + 1 < n && t.charCodeAt(p + 1) === 10) {
      fields.push(t.slice(start, p));
      P = p + 2;
      L++;
      ENDED = LINE_BREAK;
      return fields;
    }
    // A stray CR inside an unquoted field.
    fields.push(readUnquoted(t.slice(start, p), p));
    p = P;
    if (ENDED !== COMMA) return fields;
  }
}

function parse(text, header) {
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let wantHeader = header;

  T = text;
  N = n;
  P = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  L = 1;
  E = errors;

  for (;;) {
    // Lines with no characters (LF, CRLF) are no records.
    let p = P;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 10) {
        p++;
        L++;
      } else if (c === 13 && p + 1 < n && text.charCodeAt(p + 1) === 10) {
        p += 2;
        L++;
      } else break;
    }
    if (p >= n) break;
    P = p;
    RL = L;
    RR = wantHeader ? null : rows.length;
    const fields = readRecord();

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && !QUOTED && fields[0] === '') continue;

    if (width < 0) width = fields.length;
    if (wantHeader) {
      columns = fields;
      wantHeader = false;
      continue;
    }
    const k = fields.length;
    if (k < width) {
      errors.push({ code: 'short_row', line: RL, row: RR, fields: k });
      while (fields.length < width) fields.push('');
    } else if (k > width) {
      errors.push({ code: 'long_row', line: RL, row: RR, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  T = '';
  E = [];
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

export function run(input) {
  return parse(String(input.text), input.header === true);
}

// Warm-up: every branch of the reader taken once on small texts before the first real case, so the optimizing
// compilers see complete type feedback and the hot code is not thrown away the first time a rare branch is met.
// Pure: it leaves nothing behind that changes an answer (every run resets the module state).
const WARM = [
  "\uFEFFa,b,c\r\nd,e,f\n\n\r\n1,2\r\n1,2,3,4\nx\ry,z\r\r,\r\n\r\r\n\r\n\"q\",\"r\"\n\"s\"\r\n\"\"\n\"a\"\"b\",\"c\nd\",\"e\r\nf\",\"g\rh\"\n\"j\"k,\"l\"\r,\"m\"\rn\r\n\"o\"p\n\"t\"u\r\n\"v\"\r\r\n數,據,é\n\"數\"\"\",\"x\"\"\"\"y\"\r\na\"b,c\r\r\r\n,,\n\"w\"x",
  "a,b\n\"c,d\n\"\"e\r\n\rf,g\r",
  "h1,h2\r\n\"z\"",
  "\"x\"y",
  "p,q,\n1,\"2\",\"3\"\"\"\n4,5\r",
  "\"",
  "\"ab\r\ncd",
  "a,\"b\nc\"\"d\r\ne",
  "\"a\"\"b\nc\"\"d\",e\n",
  "",
  "\r",
];
for (let i = 0; i < 3; i++) for (const w of WARM) { parse(w, true); parse(w, false); }
