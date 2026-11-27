import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * The resubmittal response letter the PM sends back to the city with a revised set: who it is to, the project
 * and revision, a short cover note, and a table pairing each city comment with the firm's response.
 */
export type LetterInput = {
  firmName: string;
  date: string; // already formatted, e.g. "November 27, 2026"
  to: string; // multi-line address block
  project: { name: string; number: string; address: string; jurisdiction: string; permit_number: string };
  revNumber: number;
  revTitle: string;
  intro: string;
  closing: string;
  signer: string;
  signerTitle: string;
  comments: { number: string; sheet: string; discipline: string; body: string; response: string; fixedIn: string }[];
};

const W = 612;
const H = 792;
const M = 54;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.38, 0.42, 0.5);
const LINE = rgb(0.78, 0.8, 0.85);
const HEAD = rgb(0.92, 0.94, 0.97);
const NAVY = rgb(0.07, 0.13, 0.23);

/** Standard PDF fonts only cover Windows-1252. Anything else becomes a close ASCII stand-in or "?". */
function cleaner(font: PDFFont) {
  const ok = new Set(font.getCharacterSet());
  const swap: Record<string, string> = { '≥': '>=', '≤': '<=', '±': '+/-', '→': '->', '←': '<-', '×': 'x', ' ': ' ', '\t': '  ' };
  return (t: string) =>
    [...t]
      .map((c) => (ok.has(c.codePointAt(0)!) ? c : swap[c] ?? (c.trim() ? '?' : ' ')))
      .join('');
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = '';
    for (let w of words) {
      // Break words longer than the column (long URLs, sheet lists without spaces).
      while (font.widthOfTextAtSize(w, size) > width) {
        let n = w.length - 1;
        while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

export async function resubmittalPdf(input: LetterInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Resubmittal response, ${input.project.name}, Rev ${input.revNumber}`);
  doc.setAuthor(input.firmName);
  doc.setCreator('Arc');
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const clean = cleaner(reg);

  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const text = (t: string, x: number, size: number, font = reg, color = INK) => page.drawText(clean(t), { x, y, size, font, color });
  const para = (t: string, size = 10.5, font = reg, color = INK, x = M, width = W - 2 * M, lead = 1.45) => {
    for (const l of wrap(clean(t), font, size, width)) {
      ensure(size * lead);
      text(l, x, size, font, color);
      y -= size * lead;
    }
  };
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const ensure = (h: number) => {
    if (y - h < M + 24) newPage();
  };

  // Letterhead
  page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: NAVY });
  text(input.firmName, M, 15, bold, NAVY);
  y -= 16;
  text('Resubmittal response to plan review comments', M, 9.5, reg, MUTED);
  y -= 28;
  text(input.date, M, 10.5);
  y -= 26;

  // Recipient
  for (const l of input.to.split('\n').filter((x) => x.trim())) para(l, 10.5);
  y -= 12;

  // Re: block
  const re: [string, string][] = [
    ['Project', input.project.name],
    ['Address', input.project.address],
    ['Permit no.', input.project.permit_number],
    ['Project no.', input.project.number],
    ['Revision', `Rev ${input.revNumber}${input.revTitle ? `, ${input.revTitle}` : ''}`],
  ];
  text('Re:', M, 10.5, bold);
  for (const [k, v] of re.filter(([, v]) => v)) {
    page.drawText(clean(k), { x: M + 34, y, size: 10.5, font: bold, color: INK });
    const lines = wrap(clean(v), reg, 10.5, W - 2 * M - 110);
    lines.forEach((l, i) => {
      page.drawText(l, { x: M + 110, y: y - i * 15, size: 10.5, font: reg, color: INK });
    });
    y -= 15 * lines.length;
  }
  y -= 14;

  if (input.intro) {
    para(input.intro);
    y -= 10;
  }

  // Comment / response table
  const cols = [
    { title: 'No.', w: 38 },
    { title: 'Sheet', w: 56 },
    { title: 'City comment', w: (W - 2 * M - 94) * 0.5 },
    { title: 'Response', w: (W - 2 * M - 94) * 0.5 },
  ];
  const size = 9;
  const lead = 12;
  const pad = 6;
  const header = () => {
    const h = lead + pad * 2;
    ensure(h + lead * 2);
    page.drawRectangle({ x: M, y: y - h, width: W - 2 * M, height: h, color: HEAD, borderColor: LINE, borderWidth: 0.6 });
    let x = M;
    for (const c of cols) {
      page.drawText(c.title, { x: x + pad, y: y - pad - size, size, font: bold, color: INK });
      x += c.w;
    }
    y -= h;
  };
  header();
  for (const c of input.comments) {
    const cells = [
      { lines: wrap(clean(c.number || '-'), bold, size, cols[0].w - pad * 2), font: bold },
      { lines: wrap(clean(c.sheet || '-'), reg, size, cols[1].w - pad * 2), font: reg },
      { lines: wrap(clean((c.discipline ? `${c.discipline}: ` : '') + c.body), reg, size, cols[2].w - pad * 2), font: reg },
      {
        lines: wrap(clean((c.response || 'Response pending.') + (c.fixedIn ? `\n(Revised in ${c.fixedIn})` : '')), reg, size, cols[3].w - pad * 2),
        font: reg,
        muted: !c.response,
      },
    ];
    // A row may be taller than a page; draw it in slices so nothing is cut.
    let start = 0;
    const tallest = Math.max(...cells.map((x) => x.lines.length));
    while (start < tallest) {
      const room = Math.floor((y - (M + 24) - pad * 2) / lead);
      if (room < 2) {
        newPage();
        header();
        continue;
      }
      const n = Math.min(room, tallest - start);
      const h = n * lead + pad * 2;
      page.drawRectangle({ x: M, y: y - h, width: W - 2 * M, height: h, borderColor: LINE, borderWidth: 0.6 });
      let x = M;
      cells.forEach((cell, i) => {
        if (i > 0) page.drawLine({ start: { x, y }, end: { x, y: y - h }, thickness: 0.6, color: LINE });
        cell.lines.slice(start, start + n).forEach((l, j) => {
          page.drawText(l, { x: x + pad, y: y - pad - size - j * lead + 1, size, font: cell.font, color: (cell as any).muted ? MUTED : INK });
        });
        x += cols[i].w;
      });
      y -= h;
      start += n;
      if (start < tallest) {
        newPage();
        header();
      }
    }
  }
  y -= 20;

  if (input.closing) {
    para(input.closing);
    y -= 14;
  }
  ensure(70);
  para('Sincerely,');
  y -= 26;
  if (input.signer) para(input.signer, 10.5, bold);
  if (input.signerTitle) para(input.signerTitle, 10, reg, MUTED);
  para(input.firmName, 10, reg, MUTED);

  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    const label = clean(`${input.project.name} · Rev ${input.revNumber} · Page ${i + 1} of ${pages.length}`);
    pg.drawText(label, { x: M, y: M - 22, size: 8, font: reg, color: MUTED });
  });
  return doc.save();
}
