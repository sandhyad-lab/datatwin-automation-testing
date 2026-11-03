import { expect } from '@playwright/test';
import { InternalPlanSearchPage } from './InternalPlanSearchPage.js';
import { OrganizationPage, TABS } from './OrganizationPage.js';
import { reportResults } from './InternalPlanData.js';

/** Label of the organization dropdown on the search screen. */
export const ORG_SEARCH_FIELD = 'Organization Name';

/**
 * Transact > Organization Master > Search & Edit Organization Master.
 * Reuses from InternalPlanSearchPage: the click-only dropdowns, Search + results table,
 * and opening a record from the results (click the ID, double click, or View/Edit icon).
 */
export class OrganizationSearchPage extends InternalPlanSearchPage {
    constructor(page) {
        super(page);
        this.org = new OrganizationPage(page);
    }

    /** The search screen is ready when its Organization Name dropdown and Search button show. */
    async verifyScreen() {
        await expect(this.searchButton, 'Search button not shown on the Organization search screen').toBeVisible({ timeout: 60_000 });
        await this.control(ORG_SEARCH_FIELD);
    }

    /** Click the Organization Name dropdown, select `name`, click Search; results must show. */
    async searchOrganization(name) {
        await this.select(ORG_SEARCH_FIELD, name);
        const result = await this.search();
        expect(result.found, `"No data found" when searching Organization Name "${name}"`).toBeTruthy();
        return result;
    }

    /**
     * The Organization ID to open from the results:
     *  - `preferredId` (the ID read when the record was created) if it is in the results,
     *  - otherwise the ID of the LAST result row whose name matches `name`.
     */
    async organizationIdFor(name, preferredId) {
        const table = this.resultsTable();
        const { headers, rows } = await table.evaluate(t => {
            const clean = s => (s || '').replace(/\s+/g, ' ').trim();
            return {
                headers: [...t.querySelectorAll('th, [role="columnheader"]')].map(h => clean(h.textContent)),
                rows: [...t.querySelectorAll('tbody tr, [role="row"]')]
                    .filter(r => r.querySelector('td, [role="gridcell"]'))
                    .map(r => [...r.querySelectorAll('td, [role="gridcell"]')].map(c => clean(c.textContent))),
            };
        });

        if (preferredId && rows.some(r => r.some(c => c === preferredId))) {
            console.log(`Created organization ${preferredId} is in the results.`);
            return preferredId;
        }
        if (preferredId) console.warn(`Created organization ${preferredId} is not in the results; using the last matching row.`);

        const idCol = headers.findIndex(h => /organi[sz]ation\s*id/i.test(h));
        const nameCol = headers.findIndex(h => /organi[sz]ation\s*name/i.test(h));
        if (idCol < 0) throw new Error(`No "Organization ID" column in the results. Columns: ${JSON.stringify(headers)}`);

        const key = this.normaliseOption.bind(this);
        const matching = nameCol >= 0 ? rows.filter(r => key(r[nameCol]) === key(name)) : rows;
        const row = (matching.length ? matching : rows).at(-1);
        if (!row?.[idCol]) throw new Error(`No Organization ID found in the results for "${name}".`);

        console.log(`Opening Organization ID ${row[idCol]} (${matching.length} result row(s) named "${name}").`);
        return row[idCol];
    }

    /** The record is open when the "Organization Info" tab shows (or a dialog with the ID). */
    async waitForDetail(urlBefore, id, timeout) {
        const infoTab = this.org.tab(TABS.info.name);
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (await infoTab.isVisible().catch(() => false)) return true;
            const dialog = this.page.locator('[role="dialog"]:visible').filter({ hasText: id }).first();
            if (await dialog.isVisible().catch(() => false)) return true;
            await this.page.waitForTimeout(500);
        }
        return false;
    }

    /** Clicks the Organization ID in the results and waits for the organization to open. */
    async openOrganization(id) {
        const detailPage = await this.openIp(id);
        if (detailPage !== this.page) this.org = new OrganizationPage(detailPage);
        await this.org.openOrganization();
        return detailPage;
    }

    /**
     * Goes through every tab that the script filled and compares each field with the
     * script's value (uploads: a file must be there). Shows a PASS / FAIL / NOT FOUND table
     * (console + excel-vs-page.html / .csv in the Playwright report). Fails on any FAIL.
     */
    async validateAgainstScript(id, testInfo, { failOnNotFound = false } = {}) {
        const results = [];
        for (const key of Object.keys(TABS)) {
            const config = this.org.config(key);
            if (!Object.keys(config.values).length && !Object.keys(config.files).length) continue;
            results.push(...(await this.org.compareTab(key)));
        }

        const summary = await reportResults(results, testInfo, `Organization ${id} vs values entered by the script`, {
            expectedLabel: 'Entered',
        });

        expect(summary.fail, `${summary.fail} value(s) on organization ${id} differ from what the script entered (see the table)`).toBe(0);
        if (failOnNotFound) {
            expect(summary.notFound, `${summary.notFound} field(s) not found on organization ${id}`).toBe(0);
        }
        return { results, summary };
    }
}
