import fs from 'fs';
import path from 'path';
import { readExcel } from './excelReader.js';

/** The Internal Plan file that is uploaded and then validated (override with INTERNAL_PLAN_FILE in .env). */
export const INTERNAL_PLAN_FILE = process.env.INTERNAL_PLAN_FILE || 'test-data/TRBH00027_1_1.xlsx';

export { readExcel };

// ---------- value comparison ----------

/** Text key: lower case, Pvt = Private, Ltd = Limited, no spaces / punctuation. */
export function normaliseText(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/\bprivate\b/g, 'pvt')
        .replace(/\blimited\b/g, 'ltd')
        .replace(/[^a-z0-9]/g, '');
}

/** Number from "7,00,00,000.00", "₹ 700000000", "1,500.50"; null when the text is not a number. */
function toNumber(text) {
    const t = String(text ?? '').trim().replace(/^(₹|rs\.?|inr|\$)\s*/i, '').replace(/,/g, '');
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Possible yyyy-mm-dd keys of a date text (dd-mm-yyyy, yyyy-mm-dd, mm/dd/yyyy, 01-Jul-2026 ...). */
function dateKeys(text) {
    const t = String(text ?? '').trim().replace(/[T\s].*$/, '');
    const key = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) return [key(m[1], +m[2], +m[3])];

    m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m) {
        const keys = [];
        if (+m[2] <= 12) keys.push(key(m[3], +m[2], +m[1])); // dd-mm-yyyy
        if (+m[1] <= 12) keys.push(key(m[3], +m[1], +m[2])); // mm-dd-yyyy
        return keys;
    }

    m = t.match(/^(\d{1,2})[-/.\s]([a-z]{3})[a-z]*[-/.\s](\d{4})$/i);
    if (m && MONTHS[m[2].toLowerCase()]) return [key(m[3], MONTHS[m[2].toLowerCase()], +m[1])];

    return null;
}

/**
 * true / false, or null when there is nothing to compare (empty Excel value).
 * Numbers are compared as numbers, dates as dates (format ignored), text without
 * case / spaces / punctuation (and Pvt = Private, Ltd = Limited).
 */
export function valuesMatch(expected, actual) {
    const e = String(expected ?? '').trim();
    const a = String(actual ?? '').trim();
    if (!e) return null;
    if (!a) return false;

    const en = toNumber(e);
    const an = toNumber(a);
    if (en !== null && an !== null) return Math.abs(en - an) < 0.005;

    const ed = dateKeys(e);
    const ad = dateKeys(a);
    if (ed && ad) return ed.some(k => ad.includes(k));

    return normaliseText(e) === normaliseText(a);
}

// ---------- validation ----------

/**
 * Compares every Excel column with the detail page.
 * detail = { fields: [{ label, value }], grids: [{ headers: [], rows: [[]] }] }
 *  - a column that is a header of a grid on the page is compared row by row
 *    (rows matched by "Line ID" when both have it, otherwise by position);
 *  - otherwise a form field / label with the same name is compared with the Excel value;
 *  - otherwise the column is NOT FOUND on the page.
 * Returns [{ column, row, expected, actual, status, where }]
 * status: PASS | FAIL | NOT FOUND | SKIP (empty in Excel)
 */
export function validateAgainstExcel(excel, detail) {
    const results = [];
    const key = normaliseText;

    // the grid that shares the most columns with the Excel sheet
    const excelKeys = new Set(excel.headers.map(key));
    const grids = detail.grids
        .map(g => ({ ...g, keys: g.headers.map(key), overlap: g.headers.filter(h => excelKeys.has(key(h))).length }))
        .filter(g => g.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap);
    const grid = grids[0];

    // Excel row index -> grid row
    let gridRowFor = () => undefined;
    if (grid) {
        const lineCol = grid.keys.indexOf(key('Line ID'));
        const hasLineIds = lineCol >= 0 && excel.headers.some(h => key(h) === key('Line ID'));
        gridRowFor = (excelRow, i) => {
            if (hasLineIds) {
                const wanted = excelRow[excel.headers.find(h => key(h) === key('Line ID'))];
                const byId = grid.rows.find(r => valuesMatch(wanted, r[lineCol]));
                if (byId) return byId;
            }
            return grid.rows[i];
        };

        results.push({
            column: '(line count)',
            row: '',
            expected: String(excel.rows.length),
            actual: String(grid.rows.length),
            status: grid.rows.length >= excel.rows.length ? 'PASS' : 'FAIL',
            where: 'grid',
        });
    }

    const fieldValues = label =>
        detail.fields.filter(f => key(f.label) === key(label)).map(f => f.value).filter(v => v !== '');

    for (const column of excel.headers) {
        const col = grid ? grid.keys.indexOf(key(column)) : -1;

        if (col >= 0) {
            excel.rows.forEach((excelRow, i) => {
                const expected = excelRow[column] ?? '';
                const row = gridRowFor(excelRow, i);
                const actual = row ? row[col] ?? '' : '(row missing)';
                const match = valuesMatch(expected, row ? actual : '');
                results.push({
                    column,
                    row: `line ${i + 1}`,
                    expected,
                    actual,
                    status: match === null ? 'SKIP (empty in Excel)' : match ? 'PASS' : 'FAIL',
                    where: 'grid',
                });
            });
            continue;
        }

        // header-level field: the same for every line, so compare the distinct Excel values
        const expectedValues = [...new Set(excel.rows.map(r => r[column] ?? '').filter(Boolean))];
        const expected = expectedValues.join(' / ');
        const actualValues = fieldValues(column);

        if (!expectedValues.length) {
            results.push({ column, row: '', expected: '', actual: actualValues[0] ?? '', status: 'SKIP (empty in Excel)', where: actualValues.length ? 'field' : '' });
        } else if (!actualValues.length) {
            results.push({ column, row: '', expected, actual: '', status: 'NOT FOUND', where: '' });
        } else {
            const ok = expectedValues.every(e => actualValues.some(a => valuesMatch(e, a)));
            results.push({ column, row: '', expected, actual: [...new Set(actualValues)].join(' / '), status: ok ? 'PASS' : 'FAIL', where: 'field' });
        }
    }

    return results;
}

// ---------- report ----------

export function summarise(results) {
    const count = s => results.filter(r => r.status.startsWith(s)).length;
    return { pass: count('PASS'), fail: count('FAIL'), notFound: count('NOT FOUND'), skipped: count('SKIP') };
}

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const html = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Prints the results as a table, writes CSV + HTML next to the test output,
 * and attaches both to the Playwright HTML report.
 */
export async function reportResults(results, testInfo, title = 'Excel vs page', { expectedLabel = 'Excel' } = {}) {
    const summary = summarise(results);

    console.log(`\n${title}: ${summary.pass} PASS, ${summary.fail} FAIL, ${summary.notFound} NOT FOUND, ${summary.skipped} skipped`);
    console.table(results.map(r => ({ Column: r.column, Line: r.row, [expectedLabel]: r.expected, Page: r.actual, Result: r.status })));

    const csv = [
        ['Column', 'Line', `${expectedLabel} value`, 'Page value', 'Result', 'Found in'].map(csvCell).join(','),
        ...results.map(r => [r.column, r.row, r.expected, r.actual, r.status, r.where].map(csvCell).join(',')),
    ].join('\r\n');

    const colour = s => (s === 'PASS' ? '#d6f5d6' : s === 'FAIL' ? '#f8d0d0' : s === 'NOT FOUND' ? '#fff1c2' : '#eeeeee');
    const page = `<!doctype html><meta charset="utf-8"><title>${html(title)}</title>
<style>body{font:14px system-ui,sans-serif;margin:16px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}</style>
<h2>${html(title)}</h2>
<p>${summary.pass} PASS · ${summary.fail} FAIL · ${summary.notFound} NOT FOUND · ${summary.skipped} skipped</p>
<table><tr><th>Column</th><th>Line</th><th>${html(expectedLabel)} value</th><th>Page value</th><th>Result</th><th>Found in</th></tr>
${results.map(r => `<tr style="background:${colour(r.status)}"><td>${html(r.column)}</td><td>${html(r.row)}</td><td>${html(r.expected)}</td><td>${html(r.actual)}</td><td>${html(r.status)}</td><td>${html(r.where)}</td></tr>`).join('\n')}
</table>`;

    if (testInfo) {
        const csvPath = testInfo.outputPath('excel-vs-page.csv');
        const htmlPath = testInfo.outputPath('excel-vs-page.html');
        fs.mkdirSync(path.dirname(csvPath), { recursive: true });
        fs.writeFileSync(csvPath, csv);
        fs.writeFileSync(htmlPath, page);
        await testInfo.attach('excel-vs-page.html', { path: htmlPath, contentType: 'text/html' });
        await testInfo.attach('excel-vs-page.csv', { path: csvPath, contentType: 'text/csv' });
        console.log(`Report: ${htmlPath}`);
    }

    return summary;
}
