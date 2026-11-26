/**
 * Turns a pasted city correction letter into separate comments, without AI.
 * Numbered items ("1.", "2)", "#3", "Comment 4:") start a new comment; short
 * header lines such as "STRUCTURAL" or "Planning Review:" set the discipline
 * for the items under them; sheet references like A-101 or S2.1 are picked up.
 */
export type ParsedComment = { number: string; sheet: string; discipline: string; body: string };

const ITEM = /^\s*(?:comment\s*|item\s*|#)?(\d{1,3}[a-z]?)\s*[.):\-–]\s+(.*)$/i;
const SHEET = /\b([A-Z]{1,2}-?\d{1,3}(?:\.\d{1,2})?[A-Z]?)\b/;

function headerOf(line: string): string | null {
  const t = line.trim().replace(/:$/, '').trim();
  if (!t || t.length > 40 || /\d/.test(t)) return null;
  const isCaps = t === t.toUpperCase() && /[A-Z]/.test(t);
  const isLabel = line.trim().endsWith(':') && t.split(/\s+/).length <= 4;
  if (!isCaps && !isLabel) return null;
  return t
    .toLowerCase()
    .replace(/\b(review|comments?|division|department|dept)\b/g, '')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function parseLetter(text: string): ParsedComment[] {
  const out: ParsedComment[] = [];
  let discipline = '';
  let cur: ParsedComment | null = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = line.match(ITEM);
    if (m) {
      if (cur) out.push(cur);
      cur = { number: m[1], sheet: '', discipline, body: m[2].trim() };
      continue;
    }
    const h = headerOf(line);
    if (h !== null) {
      if (cur) out.push(cur);
      cur = null;
      discipline = h;
      continue;
    }
    if (cur) cur.body += ' ' + line.trim();
  }
  if (cur) out.push(cur);
  for (const c of out) {
    const s = c.body.match(SHEET);
    if (s) c.sheet = s[1];
  }
  return out.filter((c) => c.body.length > 0);
}
