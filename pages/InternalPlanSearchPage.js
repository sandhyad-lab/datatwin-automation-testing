import path from 'path';
import { expect } from '@playwright/test';
import { UploadV4Page } from './UploadV4Page.js';
import { readExcel, validateAgainstExcel, reportResults } from './InternalPlanData.js';

/** Filters on the "Search Internal Plan" screen (labels as the UI shows them). */
export const SEARCH_IP_FIELDS = {
    organizationName: 'Organization Name',
    vendorName: 'Vendor Name',
    vendorId: 'Vendor ID',
    ipNumber: 'IP Number',
    status: 'Status',
};

/**
 * Transact > Internal Plan > Search & Edit Internal Plan.
 * Reuses the click-only dropdown handling of UploadV4Page (click the dropdown, click the option,
 * nothing typed; Pvt = Private, Ltd = Limited, spaces / dots / case ignored).
 */
export class InternalPlanSearchPage extends UploadV4Page {
    constructor(page) {
        super(page);
        this.heading = page.getByText(/^\s*Search Internal Plan\s*$/i).first();
        this.searchButton = page.getByRole('button', { name: /^\s*Search\s*$/i }).first();
        this.resetButton = page.getByRole('button', { name: /^\s*Reset\s*$/i }).first();
        this.noData = page.getByText(/no data found/i).first();
    }

    async verifyScreen() {
        await expect(this.heading, '"Search Internal Plan" screen did not open').toBeVisible({ timeout: 60_000 });
        await expect(this.searchButton).toBeVisible();
    }

    /**
     * Sets the filters that have a value, in order; empty / missing ones are left alone.
     * filters = { organizationName, vendorName, vendorId, ipNumber, status }
     * A value of "last" / "first" picks the last / first option of that dropdown.
     * Returns the selected texts, e.g. { organizationName: 'Data Pvt Ltd', ipNumber: 'IP00000123' }.
     */
    async setFilters(filters) {
        const selected = {};
        for (const [key, value] of Object.entries(filters)) {
            if (!value) continue;
            selected[key] = await this.setFilter(key, value);
        }
        return selected;
    }

    /**
     * Click the "field" dropdown and pick the LAST option in the list.
     * Long lists load more options while scrolling, so it scrolls to the end first.
     * Returns the option text.
     */
    async selectLast(field) {
        const control = await this.openDropdown(field);
        const options = this.openOptions();
        const placeholder = /^\s*(select.*|none|--+|no options|loading.*)?\s*$/i;

        // scroll to the bottom until no new options appear
        let previous = -1;
        for (let round = 0; round < 50; round++) {
            const count = await options.count();
            if (!count || count === previous) break;
            previous = count;
            await options.nth(count - 1).scrollIntoViewIfNeeded().catch(() => { });
            await this.page.waitForTimeout(400);
        }

        const count = await options.count();
        for (let i = count - 1; i >= 0; i--) {
            const text = (await options.nth(i).innerText().catch(() => '')).trim();
            const disabled = (await options.nth(i).getAttribute('aria-disabled').catch(() => null)) === 'true';
            if (disabled || placeholder.test(text)) continue;

            await options.nth(i).scrollIntoViewIfNeeded().catch(() => { });
            await options.nth(i).click();
            await this.page.waitForTimeout(500);
            await this.expectFieldShows(field, control, text);
            console.log(`Selected ${this.fieldName(field)}: ${text} (last of ${count} options)`);
            return text;
        }

        await this.page.keyboard.press('Escape').catch(() => { });
        throw new Error(
            `"${this.fieldName(field)}": the list has no selectable option ` +
            '(no Internal Plan for this organization yet?).'
        );
    }

    /**
     * Sets a filter: "last" picks the last option, "first" the first one,
     * anything else is matched as option text.
     */
    async setFilter(key, value) {
        const field = SEARCH_IP_FIELDS[key];
        if (!field) throw new Error(`Unknown filter "${key}". Use: ${Object.keys(SEARCH_IP_FIELDS).join(', ')}`);
        if (/^last$/i.test(value)) return this.selectLast(field);
        if (/^first$/i.test(value)) return this.selectFirst(field);
        return this.select(field, value);
    }

    /** The results table (any visible table / grid under the filters). */
    resultsTable() {
        return this.page.locator('table, [role="grid"]').locator('visible=true').last();
    }

    /**
     * Clicks Search and waits for either the results table or "No data found".
     * Returns { found, rows } where rows are the row texts (first 20).
     */
    async search() {
        await this.searchButton.click();
        console.log('Clicked Search.');

        const table = this.resultsTable();
        const deadline = Date.now() + 60_000;

        while (Date.now() < deadline) {
            if (await this.noData.isVisible().catch(() => false)) {
                console.log('Search result: "No data found".');
                return { found: false, rows: [] };
            }

            const rows = table.locator('tbody tr, [role="row"]:not(:has([role="columnheader"]))');
            const count = await rows.count().catch(() => 0);
            if (count > 0 && (await table.isVisible().catch(() => false))) {
                const texts = (await rows.allInnerTexts().catch(() => []))
                    .map(t => t.replace(/\s*\n\s*/g, ' | ').trim())
                    .filter(Boolean)
                    .slice(0, 20);
                const headers = (await table.locator('th, [role="columnheader"]').allInnerTexts().catch(() => []))
                    .map(h => h.trim())
                    .filter(Boolean);

                console.log(`Search result: ${count} row(s). Columns: ${JSON.stringify(headers)}`);
                texts.slice(0, 5).forEach((t, i) => console.log(`  row ${i + 1}: ${t}`));
                return { found: true, rows: texts, headers };
            }

            await this.page.waitForTimeout(1000);
        }

        throw new Error('After Search, neither a results table nor "No data found" appeared within 60s.');
    }

    /**
     * Sets the filters, clicks Search, and checks that results are shown.
     * When an IP Number was selected, one of the result rows must contain it.
     */
    async searchAndVerify(filters) {
        const selected = await this.setFilters(filters);
        const result = await this.search();

        expect(
            result.found,
            `"No data found" for ${JSON.stringify(selected)}. ` +
            'The search returned no Internal Plan for these filters.'
        ).toBeTruthy();

        if (selected.ipNumber) {
            const ip = this.normaliseOption(selected.ipNumber);
            expect(
                result.rows.some(r => this.normaliseOption(r).includes(ip)),
                `No result row shows the selected IP Number "${selected.ipNumber}". ` +
                `Rows: ${JSON.stringify(result.rows.slice(0, 5))}`
            ).toBeTruthy();
            console.log(`Search results show IP Number ${selected.ipNumber}.`);
        }

        return { selected, ...result };
    }

    // ---------- open an IP and read its detail page ----------

    /**
     * Clicks the IP Number in the search results and waits for its detail page.
     * Handles: detail in the same tab, in a new browser tab, or in a dialog;
     * falls back to a double click on the row and to a View / Edit / Open icon.
     * Returns the Playwright page that shows the detail.
     */
    async openIp(ipNumber) {
        const exact = new RegExp(`^\\s*${this.escapeRegExp(ipNumber)}\\s*$`, 'i');
        const row = this.resultsTable()
            .locator('tbody tr, [role="row"]')
            .filter({ hasText: ipNumber })
            .first();
        await expect(row, `"${ipNumber}" is not in the search results`).toBeVisible({ timeout: 15_000 });

        const attempts = [
            { name: `click on "${ipNumber}"`, run: async () => {
                const link = row.getByText(exact).first();
                await ((await link.count()) ? link : row).click();
            } },
            { name: 'double click on the row', run: () => row.dblclick() },
            { name: 'View / Edit / Open icon in the row', run: async () => {
                const icon = row
                    .locator('button, a, [role="button"]')
                    .filter({ has: this.page.locator('[data-testid*="Visibility"], [data-testid*="Edit"], [data-testid*="Launch"], [data-testid*="OpenInNew"]') })
                    .or(row.getByRole('button', { name: /view|edit|open/i }))
                    .or(row.locator('[aria-label*="view" i], [aria-label*="edit" i], [title*="view" i], [title*="edit" i]'))
                    .first();
                if (!(await icon.count())) throw new Error('no icon');
                await icon.click();
            } },
        ];

        for (const attempt of attempts) {
            const urlBefore = this.page.url();
            const popupPromise = this.page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null);

            const clicked = await attempt.run().then(() => true).catch(() => false);
            if (!clicked) continue;

            const popup = await popupPromise;
            if (popup) {
                await popup.waitForLoadState('domcontentloaded');
                console.log(`"${ipNumber}" opened in a new tab (${attempt.name}).`);
                await this.waitForPageReady(popup);
                return popup;
            }

            const opened = await this.waitForDetail(urlBefore, ipNumber, 30_000);
            if (opened) {
                console.log(`"${ipNumber}" opened (${attempt.name}).`);
                await this.waitForPageReady(this.page);
                return this.page;
            }
            console.warn(`"${ipNumber}": ${attempt.name} did not open the detail page, trying the next way.`);
        }

        throw new Error(
            `Could not open "${ipNumber}" from the search results ` +
            '(tried clicking the IP, double clicking the row, and a View/Edit icon).'
        );
    }

    /** True once the detail shows: search screen gone, URL changed, or a dialog with the IP. */
    async waitForDetail(urlBefore, ipNumber, timeout) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (this.page.url() !== urlBefore) return true;
            if (!(await this.heading.isVisible().catch(() => false))) return true;
            const dialog = this.page.locator('[role="dialog"]:visible').filter({ hasText: ipNumber }).first();
            if (await dialog.isVisible().catch(() => false)) return true;
            await this.page.waitForTimeout(500);
        }
        return false;
    }

    /** Waits for spinners to go and the content to settle. */
    async waitForPageReady(page) {
        await page.waitForLoadState('domcontentloaded').catch(() => { });
        const busy = page.locator(
            '.MuiCircularProgress-indeterminate:visible, .MuiLinearProgress-indeterminate:visible, [aria-busy="true"]:visible'
        ).first();
        await expect(busy).toBeHidden({ timeout: 60_000 }).catch(() => { });
        await page.waitForTimeout(2000);
    }

    /**
     * Reads everything the detail page shows, on every tab:
     *  fields: [{ label, value }]  (form fields, read-only label/value pairs, "Label: value" texts)
     *  grids:  [{ headers, rows }] (tables / grids; input values inside cells are read too)
     * Tabs about workflow / approvals / audit are skipped.
     */
    async collectDetail(page = this.page) {
        const snapshot = () =>
            page.evaluate(() => {
                const visible = el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
                };
                const skip = el => !!el.closest('nav, aside, .MuiDrawer-root, [class*="sidebar" i]');
                const clean = t => (t || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
                const valueOf = el => {
                    if (!el) return '';
                    if ('value' in el && typeof el.value === 'string') return el.value;
                    return el.textContent;
                };

                const fields = [];

                // 1. MUI form controls: label + input / select
                document.querySelectorAll('.MuiFormControl-root, .MuiTextField-root, .MuiAutocomplete-root').forEach(fc => {
                    if (!visible(fc) || skip(fc)) return;
                    const label = fc.querySelector('label, .MuiFormLabel-root, .MuiInputLabel-root');
                    if (!label) return;
                    const input = fc.querySelector('input:not([type="hidden"]):not([type="file"]), textarea');
                    let value = input ? input.value : '';
                    if (!value) value = fc.querySelector('.MuiSelect-select, .MuiChip-label, [role="combobox"]')?.textContent || '';
                    fields.push({ label: clean(label.textContent), value: clean(value) });
                });

                // 2. inputs named by aria-label / placeholder
                document.querySelectorAll('input[aria-label], textarea[aria-label]').forEach(el => {
                    if (visible(el) && !skip(el) && !el.closest('table, [role="grid"]')) {
                        fields.push({ label: clean(el.getAttribute('aria-label')), value: clean(el.value) });
                    }
                });

                // 3. read-only pairs: a short label element followed by its value
                document.querySelectorAll('body *').forEach(el => {
                    if (el.childElementCount > 1 || !visible(el) || skip(el)) return;
                    if (el.closest('table, [role="grid"], .MuiFormControl-root, button, [role="tab"], [role="option"]')) return;
                    const text = clean(el.textContent);
                    if (!text || text.length > 50) return;

                    const colon = text.match(/^([^:]{2,40}):\s*(.+)$/);
                    if (colon) fields.push({ label: clean(colon[1]), value: clean(colon[2]) });

                    const next = el.nextElementSibling || el.parentElement?.nextElementSibling;
                    if (next && visible(next) && !next.querySelector('input, select, textarea, table')) {
                        const value = clean(next.textContent);
                        if (value && value.length <= 200 && value !== text) fields.push({ label: text, value });
                    }
                });

                // 4. tables / grids
                const grids = [];
                document.querySelectorAll('table, [role="grid"]').forEach(t => {
                    if (!visible(t) || skip(t)) return;
                    const headers = [...t.querySelectorAll('th, [role="columnheader"]')].map(h => clean(h.textContent));
                    if (!headers.length) return;
                    const rows = [...t.querySelectorAll('tbody tr, [role="row"]')]
                        .filter(r => r.querySelector('td, [role="gridcell"]'))
                        .map(r =>
                            [...r.querySelectorAll('td, [role="gridcell"]')].map(c => {
                                const input = c.querySelector('input:not([type="hidden"]):not([type="checkbox"]), textarea');
                                return clean(input ? valueOf(input) : c.textContent);
                            })
                        )
                        .filter(cells => cells.some(Boolean));
                    grids.push({ headers, rows });
                });

                return { fields, grids };
            });

        const merged = { fields: [], grids: [], tabs: [] };
        const add = s => {
            for (const f of s.fields) {
                if (f.label && !merged.fields.some(m => m.label === f.label && m.value === f.value)) merged.fields.push(f);
            }
            for (const g of s.grids) {
                const id = JSON.stringify(g.headers);
                const existing = merged.grids.find(m => JSON.stringify(m.headers) === id);
                if (!existing) merged.grids.push(g);
                else if (g.rows.length > existing.rows.length) existing.rows = g.rows;
            }
        };

        add(await snapshot());

        // visit every tab of the detail page
        const tabs = page
            .getByRole('tab')
            .filter({ hasNot: page.locator('nav, aside') });
        const count = await tabs.count();
        for (let i = 0; i < count; i++) {
            const tab = tabs.nth(i);
            const name = (await tab.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            if (!name || /work\s*flow|approval|audit|history|comment|attachment|activity/i.test(name)) continue;

            await tab.evaluate(el => el.scrollIntoView({ block: 'nearest', inline: 'center' })).catch(() => { });
            const clicked = await tab.click({ timeout: 3000 }).then(() => true).catch(() => false);
            if (!clicked) continue;

            await page.waitForTimeout(800);
            merged.tabs.push(name);
            add(await snapshot());
        }

        console.log(
            `Detail page read: ${merged.fields.length} fields, ${merged.grids.length} grid(s)` +
            (merged.tabs.length ? `, tabs visited: ${merged.tabs.join(', ')}` : '')
        );
        merged.grids.forEach((g, i) => console.log(`  grid ${i + 1}: ${g.rows.length} row(s), columns ${JSON.stringify(g.headers)}`));

        return merged;
    }

    /**
     * Opens the IP from the search results, reads its detail page and compares it with the Excel.
     * Shows a PASS / FAIL / NOT FOUND table (console + HTML/CSV in the Playwright report).
     * Fails when any value differs; NOT FOUND fails only with { failOnNotFound: true }.
     */
    async openIpAndValidate(ipNumber, excelFile, testInfo, { failOnNotFound = false, sheet } = {}) {
        const excel = readExcel(excelFile, sheet);
        console.log(`Excel ${path.basename(excelFile)} (sheet "${excel.sheet}"): ${excel.rows.length} line(s), ${excel.headers.length} columns.`);

        const detailPage = await this.openIp(ipNumber);
        const detail = await this.collectDetail(detailPage);

        const results = validateAgainstExcel(excel, detail);
        const summary = await reportResults(results, testInfo, `IP ${ipNumber} vs ${path.basename(excelFile)}`);

        if (summary.notFound) {
            const labels = [...new Set(detail.fields.map(f => f.label))].slice(0, 60);
            console.log(`Labels seen on the detail page (for NOT FOUND columns): ${JSON.stringify(labels)}`);
        }

        expect(
            summary.fail,
            `${summary.fail} value(s) differ between the Excel and IP ${ipNumber} (see the table above / excel-vs-page.html)`
        ).toBe(0);
        if (failOnNotFound) {
            expect(summary.notFound, `${summary.notFound} Excel column(s) not found on the detail page`).toBe(0);
        }

        return { results, summary, detail };
    }

    async reset() {
        await this.resetButton.click();
        await this.page.waitForTimeout(1000);
    }
}
