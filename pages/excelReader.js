import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/**
 * Minimal .xlsx reader using only Node's built-in modules (no npm package needed).
 * readExcel(file, sheetName?) -> { sheet, headers, rows }
 *   headers: texts of the first non-empty row
 *   rows:    one object per following non-empty row, { [header]: text }
 * Dates are returned as dd-mm-yyyy, whole numbers without ".0".
 */

// ---------- zip ----------

function unzip(buffer) {
    // End Of Central Directory record (last 22+ bytes)
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid .xlsx (zip) file');

    const entries = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    const files = new Map();

    for (let n = 0; n < entries; n++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const data = buffer.subarray(start, start + compressedSize);

        files.set(name, () => (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8'));
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return files;
}

// ---------- xml helpers ----------

const decode = s =>
    s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
        if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
    });

const attr = (attrs, name) => {
    const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? decode(m[1]) : null;
};

/** All text of <t> elements inside a fragment (shared strings, inline strings). */
const textOf = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decode(m[1])).join('');

const columnIndex = ref => {
    const letters = ref.replace(/\d+/g, '');
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
};

// ---------- cell formatting ----------

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function serialToDate(serial, date1904) {
    const ms = Math.round((serial - (date1904 ? 24107 : 25569)) * 86_400_000);
    const d = new Date(ms);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

function formatNumber(text) {
    const n = Number(text);
    if (!Number.isFinite(n)) return text;
    return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15)));
}

// ---------- public ----------

export function readExcel(file, sheetName) {
    const absolute = path.resolve(file);
    if (!fs.existsSync(absolute)) throw new Error(`Excel file not found: ${absolute}`);

    const zip = unzip(fs.readFileSync(absolute));
    const read = name => (zip.has(name) ? zip.get(name)() : '');

    // shared strings
    const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]));

    // styles: which style indexes are dates
    const styles = read('xl/styles.xml');
    const customFormats = new Map(
        [...styles.matchAll(/<numFmt\b([^>]*)\/?>/g)].map(m => [Number(attr(m[1], 'numFmtId')), attr(m[1], 'formatCode') || ''])
    );
    const cellXfs = (styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || [, ''])[1];
    const dateStyles = [...cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)].map(m => {
        const id = Number(attr(m[1], 'numFmtId') || 0);
        if (BUILTIN_DATE_FORMATS.has(id)) return true;
        const code = (customFormats.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
        return /[dmy]/i.test(code) && !/^[#0.,%\s]*$/.test(code);
    });

    // workbook: sheet name -> file
    const workbook = read('xl/workbook.xml');
    const date1904 = /date1904="(1|true)"/.test(workbook);
    const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map(m => ({
        name: attr(m[1], 'name'),
        rid: attr(m[1], 'r:id'),
    }));
    const rels = new Map(
        [...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)].map(m => [attr(m[1], 'Id'), attr(m[1], 'Target')])
    );

    const sheet = sheetName ? sheets.find(s => s.name === sheetName) : sheets[0];
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found. Sheets: ${sheets.map(s => s.name).join(', ')}`);

    let target = rels.get(sheet.rid) || 'worksheets/sheet1.xml';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const sheetXml = read(target);

    // cells
    const grid = [];
    for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const c of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const attrs = c[1];
            const inner = c[2] || '';
            const ref = attr(attrs, 'r');
            const type = attr(attrs, 't');
            const style = Number(attr(attrs, 's') || 0);
            const raw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [, null])[1];

            let value = '';
            if (type === 's') value = shared[Number(raw)] ?? '';
            else if (type === 'inlineStr') value = textOf(inner);
            else if (type === 'str' || type === 'e') value = raw === null ? '' : decode(raw);
            else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
            else if (raw !== null) value = dateStyles[style] ? serialToDate(Number(raw), date1904) : formatNumber(raw);

            cells[ref ? columnIndex(ref) : cells.length] = String(value).trim();
        }
        if (cells.some(v => v)) grid.push(Array.from(cells, v => v ?? ''));
    }

    if (!grid.length) return { sheet: sheet.name, headers: [], rows: [] };

    const headers = grid[0].map(h => h.trim());
    const rows = grid.slice(1).map(r =>
        Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]).filter(([h]) => h))
    );

    return { sheet: sheet.name, headers: headers.filter(Boolean), rows };
}
