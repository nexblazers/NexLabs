// Small shared helpers (no browser APIs, so they can be unit-tested in Node).

export const soqlStr = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export const xmlEsc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const htmlEsc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Run fn over items with limited concurrency.
export async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Convert a 15-char Salesforce Id to 18-char (case-safe) form.
export function to18(id) {
  id = String(id || '').trim();
  if (id.length !== 15) return id;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  let suffix = '';
  for (let block = 0; block < 3; block++) {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      const c = id.charAt(block * 5 + i);
      if (c >= 'A' && c <= 'Z') n += 1 << i;
    }
    suffix += chars.charAt(n);
  }
  return id + suffix;
}

// RFC 4180 CSV parser -> array of objects keyed by header.
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

export function toCSV(rows) {
  const q = v => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(q).join(',')).join('\r\n');
}
