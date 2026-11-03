import { expect } from '@playwright/test';
import { UploadV4Page } from './UploadV4Page.js';
import { InternalPlanSearchPage } from './InternalPlanSearchPage.js';
import { OrganizationPage } from './OrganizationPage.js';
import { valuesMatch, reportResults } from './InternalPlanData.js';

/**
 * Goods and Service Entries (GRN).
 *
 * Field / tab / option names are matched loosely (case, spaces and punctuation ignored,
 * Pvt = Private, Ltd = Limited). Labels are RegExps so small wording differences still match.
 * Change them here if the screen words something differently.
 */
export const GRN_LABELS = {
    // Transact
    task: /what\s*(would|do)\s*you|^\s*task\s*\*?\s*$/i,
    screen: /type\s*of\s*screen/i,
    // tabs
    tabs: {
        receiver: /receiver/i,
        sender: /sender/i,
        item: /item/i,
        costAllocation: /cost\s*alloc/i,
        journal: /journal/i,
    },
    // Receiver Info
    receiverTaxReg: /receiver.*tax\s*reg/i,
    // Sender Info
    sender: /sender.*(name|tax\s*reg)/i,
    invoiceReference: /invoice\s*ref/i,
    invoiceDate: /^\s*invoice\s*date\s*\*?\s*$/i,
    orderType: /order\s*type/i,
    orderNumber: /order\s*(number|no\.?)/i,
    modeOfDelivery: /mode\s*of\s*deliver/i,
    additionalChargeType: /additional\s*charge\s*type/i,
    totalAdditionalCharge: /total\s*additional\s*charge/i,
    // Goods and Service Entry Item (form field or grid column)
    orderDescription: /order\s*desc/i,
    itemName: /item\s*name/i,
    orderQuantity: /order\s*(qty|quantity)/i,
    balanceQuantity: /balance\s*(qty|quantity)/i,
    invoiceQuantity: /invoice\s*(qty|quantity)/i,
    receivedQuantity: /receiv(ed|e)\s*(qty|quantity)/i,
    // Search / Inbox filters
    vendorName: /vendor\s*name/i,
    company: /^\s*(company|company\s*name|organi[sz]ation(\s*name)?)\s*\*?\s*$/i,
    fromDate: /^\s*(for\s*prd\s*from|from|start)(\s*date)?\s*\*?\s*$/i, // Inbox: "ForPrdFrom"
    toDate: /^\s*(for\s*prd\s*to|to|end)(\s*date)?\s*\*?\s*$/i,         // Inbox: "ForPrdTo"
};

/**
 * Date range for the Inbox:
 *  'previousMonth' -> 1st to last day of the month before `today` (in November: 1 Oct - 31 Oct)
 *  'currentMonth'  -> 1st of this month to today
 *  { from: '01-10-2026', to: '31-10-2026' } -> as given
 * Returned as dd-mm-yyyy (or `format`).
 */
export function dateRange(period = 'previousMonth', format = 'DD-MM-YYYY', today = new Date()) {
    const fmt = d =>
        format
            .replace('DD', String(d.getDate()).padStart(2, '0'))
            .replace('MM', String(d.getMonth() + 1).padStart(2, '0'))
            .replace('YYYY', String(d.getFullYear()));

    if (period && typeof period === 'object') return { from: formatDate(period.from, format), to: formatDate(period.to, format) };
    if (period === 'currentMonth') return { from: fmt(new Date(today.getFullYear(), today.getMonth(), 1)), to: fmt(today) };

    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const to = new Date(today.getFullYear(), today.getMonth(), 0); // day 0 = last day of the previous month
    return { from: fmt(from), to: fmt(to) };
}

/** Option chooser: 'first' | 'last' | ['token', 'token'] (all must be in the option) | exact text. */
function describeChooser(chooser) {
    return Array.isArray(chooser) ? `option containing ${JSON.stringify(chooser)}` : `"${chooser}"`;
}

/** yyyy-mm-dd / dd-mm-yyyy / dd/mm/yyyy -> { d, m, y } (null if not a date). */
function parseDate(text) {
    const t = String(text || '').trim();
    let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return { y: m[1], m: m[2].padStart(2, '0'), d: m[3].padStart(2, '0') };
    m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (m) return { y: m[3], m: m[2].padStart(2, '0'), d: m[1].padStart(2, '0') };
    return null;
}

/** Formats a date for typing: 'DD-MM-YYYY' (default), 'YYYY-MM-DD', 'MM/DD/YYYY', ... */
export function formatDate(text, format = 'DD-MM-YYYY') {
    const p = parseDate(text);
    if (!p) return text;
    return format.replace('DD', p.d).replace('MM', p.m).replace('YYYY', p.y);
}

// =====================================================================================
// Inbox: find the vendor's invoice row and open its attachment
// =====================================================================================

export class InboxPage extends UploadV4Page {
    async open() {
        await this.sidebarItem('Inbox').click();
        await this.control(GRN_LABELS.company, { timeout: 60_000 });
        await this.page.waitForTimeout(1000);
    }

    /**
     * Inbox filters: Company dropdown, From Date, To Date, then Submit.
     * filters = { company: chooser, period: 'previousMonth' | 'currentMonth' | { from, to }, dateFormat }
     */
    async applyFilters({ company, period = 'previousMonth', dateFormat = 'DD-MM-YYYY' }) {
        await this.chooseOption(await this.control(GRN_LABELS.company), company, 'Company');
        await this.page.waitForTimeout(1000);

        const { from, to } = dateRange(period, 'DD-MM-YYYY'); // converted to each field's own format when typed
        await this.setDate(GRN_LABELS.fromDate, from, 'From Date');
        await this.setDate(GRN_LABELS.toDate, to, 'To Date');

        const submit = this.page.getByRole('button', { name: /^\s*submit\s*$/i }).locator('visible=true').first();
        await expect(submit, 'Submit button not found on the Inbox').toBeEnabled({ timeout: 15_000 });
        await submit.click();
        console.log(`Inbox filtered: ${from} to ${to}, Submit clicked.`);

        // wait for the list to load
        const busy = this.page.locator('.MuiCircularProgress-indeterminate:visible, .MuiLinearProgress-indeterminate:visible, [aria-busy="true"]:visible').first();
        await this.page.waitForTimeout(1000);
        await expect(busy).toBeHidden({ timeout: 60_000 }).catch(() => { });
        await expect(
            this.page.locator('table tbody tr, [role="grid"] [role="row"]').locator('visible=true').first().or(this.page.getByText(/no data|no records/i).first()),
            'The Inbox list did not load after Submit'
        ).toBeVisible({ timeout: 60_000 });
        await this.page.waitForTimeout(1000);
    }

    /**
     * The date format a field expects, from its placeholder ("mm/dd/yyyy", "DD-MM-YYYY" ...).
     * Falls back to `fallback` when the field has no date placeholder.
     */
    async dateFormatOf(control, fallback = 'DD-MM-YYYY') {
        const placeholder = (await control.getAttribute('placeholder').catch(() => '')) || '';
        const m = placeholder.match(/(dd|mm|yyyy)([-/.])(dd|mm|yyyy)\2(dd|mm|yyyy)/i);
        if (!m) return fallback;
        return [m[1], m[3], m[4]].map(p => p.toUpperCase()).join(m[2]);
    }

    /**
     * Types a date into a date field in the format the field expects (read from its placeholder).
     * `value` may be in any format (dd-mm-yyyy, yyyy-mm-dd ...). Retries digits-only for
     * masked pickers. Returns what the field shows.
     */
    async setDate(regex, value, label, control) {
        control = control || (await this.control(regex));
        value = formatDate(value, await this.dateFormatOf(control));
        const typeIt = async text => {
            await control.click();
            await control.press('Control+A').catch(() => { });
            await control.press('Backspace').catch(() => { });
            await control.pressSequentially(text, { delay: 40 });
            await control.press('Tab').catch(() => { });
            await this.page.keyboard.press('Escape').catch(() => { }); // close a calendar popup
            await this.page.waitForTimeout(400);
        };

        await typeIt(value);
        let shown = await control.inputValue().catch(() => '');
        if (!valuesMatch(value, shown)) {
            await typeIt(value.replace(/\D/g, ''));
            shown = await control.inputValue().catch(() => '');
        }
        if (!valuesMatch(value, shown)) throw new Error(`${label}: typed "${value}" but the field shows "${shown}"`);
        console.log(`Entered ${label}: ${shown}`);
        return shown;
    }

    /** Rows of the inbox table as { cells: {header: text}, locator }. */
    async rows() {
        const table = this.page.locator('table, [role="grid"]').locator('visible=true').last();
        const headers = (await table.locator('th, [role="columnheader"]').allInnerTexts()).map(h => h.replace(/\s+/g, ' ').trim());
        const rowLocators = table.locator('tbody tr, [role="row"]').filter({ has: this.page.locator('td, [role="gridcell"]') });
        const count = await rowLocators.count();
        const out = [];
        for (let i = 0; i < count; i++) {
            const row = rowLocators.nth(i);
            const texts = await row.locator('td, [role="gridcell"]').evaluateAll(cells =>
                cells.map(c => (c.getAttribute('title') || c.textContent || '').replace(/\s+/g, ' ').trim())
            );
            out.push({ cells: Object.fromEntries(headers.map((h, j) => [h, texts[j] ?? ''])), locator: row, headers });
        }
        return out;
    }

    cell(row, regex) {
        const header = row.headers.find(h => regex.test(h));
        return header ? row.cells[header] : '';
    }

    /**
     * The first inbox row whose Vendor Name contains all `vendorTokens`
     * (narrows the list with the Vendor Name filter first when it exists).
     * Returns { vendorName, invoiceNo, invoiceDate, documentId, row }.
     */
    async findInvoice(vendorTokens) {
        // optional: Vendor Name filter at the top of the inbox
        const filter = await this.control(GRN_LABELS.vendorName, { timeout: 3000 }).catch(() => null);
        if (filter) {
            await this.chooseOption(filter, vendorTokens, 'Vendor Name filter').catch(e =>
                console.warn(`Vendor Name filter not used: ${e.message.split('\n')[0]}`)
            );
            await this.page.waitForTimeout(2000);
        }

        const wanted = vendorTokens.map(t => this.normaliseOption(t));
        const rows = await this.rows();
        const row = rows.find(r => {
            const vendor = this.normaliseOption(this.cell(r, /vendor/i));
            return wanted.every(t => vendor.includes(t));
        });

        if (!row) {
            const vendors = [...new Set(rows.map(r => this.cell(r, /vendor/i)))];
            throw new Error(`No inbox row for vendor ${JSON.stringify(vendorTokens)}. Vendors shown: ${JSON.stringify(vendors)}`);
        }

        const invoice = {
            vendorName: this.cell(row, /vendor/i),
            invoiceNo: this.cell(row, /invoice\s*(no|number)/i),
            invoiceDate: this.cell(row, /invoice\s*date/i),
            documentId: this.cell(row, /document\s*id/i),
            row: row.locator,
        };
        console.log(`Inbox: ${invoice.vendorName} | Invoice No ${invoice.invoiceNo} | Invoice Date ${invoice.invoiceDate} | Document ${invoice.documentId}`);
        return invoice;
    }

    /**
     * Clicks the row's attachment icon and leaves the invoice viewer open.
     * Returns the viewer's text when the viewer has a text layer ('' otherwise).
     */
    async openAttachment(rowLocator) {
        const table = this.page.locator('table, [role="grid"]').locator('visible=true').last();
        const headers = (await table.locator('th, [role="columnheader"]').allInnerTexts()).map(h => h.trim());
        const col = headers.findIndex(h => /attach/i.test(h));
        const cell = col >= 0 ? rowLocator.locator('td, [role="gridcell"]').nth(col) : rowLocator;
        const icon = cell.locator('button, a, svg, [role="button"]').first();

        await ((await icon.count()) ? icon : cell).click();

        const viewer = this.page.locator('[role="dialog"], .MuiDialog-root, .MuiModal-root').locator('visible=true').last();
        await expect(viewer, 'The invoice viewer did not open after clicking the attachment').toBeVisible({ timeout: 30_000 });
        await this.page.waitForTimeout(3000); // let the PDF render

        const text = (await viewer.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        console.log(`Invoice viewer open (${text.length} characters of text readable).`);
        return text;
    }

    /** Transport charge from the invoice text ("Transportation Charges ... 1,500.00"), or ''. */
    static transportChargeFrom(text) {
        const m = String(text || '').match(/transport\w*\s*(?:charges?)?[^0-9₹]{0,30}(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)/i);
        return m ? m[1].replace(/,/g, '') : '';
    }

    // ----- shared dropdown chooser (used by GrnPage too) -----

    /** Opens a dropdown control and picks an option by chooser. Returns the picked text. */
    async chooseOption(control, chooser, name = 'dropdown') {
        await control.scrollIntoViewIfNeeded().catch(() => { });

        if (await this.openOptions().first().isVisible().catch(() => false)) {
            await this.page.keyboard.press('Escape').catch(() => { });
            await this.page.waitForTimeout(300);
        }

        await control.click();
        let opened = await this.openOptions().first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
        if (!opened) {
            const arrow = control
                .locator('xpath=ancestor::*[contains(@class,"MuiAutocomplete-root") or contains(@class,"MuiFormControl-root") or contains(@class,"MuiInputBase-root") or self::td][1]')
                .locator('.MuiAutocomplete-popupIndicator, [aria-label="Open"], [data-testid="ArrowDropDownIcon"], svg')
                .first();
            await ((await arrow.count()) ? arrow : control).click({ force: true });
            opened = await this.openOptions().first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
        }
        if (!opened) throw new Error(`${name}: the option list did not open`);

        const options = this.openOptions();
        const placeholder = /^\s*(select.*|none|--+|no options|loading.*)?\s*$/i;

        // load the whole list (long lists add options while scrolling)
        let previous = -1;
        for (let round = 0; round < 50; round++) {
            const count = await options.count();
            if (!count || count === previous) break;
            previous = count;
            await options.nth(count - 1).scrollIntoViewIfNeeded().catch(() => { });
            await this.page.waitForTimeout(300);
        }

        const count = await options.count();
        const items = [];
        for (let i = 0; i < count; i++) {
            const text = (await options.nth(i).innerText().catch(() => '')).trim();
            const disabled = (await options.nth(i).getAttribute('aria-disabled').catch(() => null)) === 'true';
            if (!disabled && !placeholder.test(text)) items.push({ i, text });
        }

        let pick;
        if (chooser === 'first') pick = items[0];
        else if (chooser === 'last') pick = items.at(-1);
        else if (Array.isArray(chooser)) {
            const tokens = chooser.map(t => this.normaliseOption(t));
            pick = items.find(it => tokens.every(t => this.normaliseOption(it.text).includes(t)));
        } else pick = items.find(it => this.normaliseOption(it.text) === this.normaliseOption(chooser));

        if (!pick) {
            await this.page.keyboard.press('Escape').catch(() => { });
            throw new Error(`${name}: no ${describeChooser(chooser)}. Options: ${JSON.stringify(items.map(it => it.text))}`);
        }

        await options.nth(pick.i).scrollIntoViewIfNeeded().catch(() => { });
        await options.nth(pick.i).click();
        await this.page.waitForTimeout(700);
        console.log(`Selected ${name}: ${pick.text}`);
        return pick.text;
    }
}

// =====================================================================================
// Goods and Service Entries: create
// =====================================================================================

export class GrnPage extends InboxPage {
    constructor(page) {
        super(page);
        // Validate & Save / Approvals / Activate work the same on every master form,
        // so the Organization Master implementation is reused for them.
        this.actions = new OrganizationPage(page);
        this.entered = {}; // label -> value entered by the script (checked again after searching)
    }

    // ----- Transact navigation -----

    async openTransact() {
        await this.sidebarItem('Transact').click();
        await this.control(GRN_LABELS.task, { timeout: 30_000 });
    }

    /** Transact > task matching taskRegex > Type of Screen matching screenRegex. */
    async chooseTransact(taskRegex, screenRegex) {
        await this.openTransact();

        const task = await this.optionMatching(GRN_LABELS.task, taskRegex);
        await this.chooseOption(await this.control(GRN_LABELS.task), task, 'Task');
        await this.page.waitForTimeout(1000);

        const screen = await this.optionMatching(GRN_LABELS.screen, screenRegex);
        await this.chooseOption(await this.control(GRN_LABELS.screen), screen, 'Type of Screen');
        await this.page.waitForTimeout(2000);
    }

    /** Opens a dropdown, returns the exact text of the first option matching regex (list is closed again). */
    async optionMatching(field, regex) {
        const control = await this.control(field);
        await control.click();
        await this.openOptions().first().waitFor({ state: 'visible', timeout: 10_000 });
        const texts = await this.visibleOptions();
        await this.page.keyboard.press('Escape').catch(() => { });
        await this.page.waitForTimeout(300);
        const match = texts.find(t => regex.test(t));
        if (!match) throw new Error(`No option matching ${regex} in "${this.fieldName(field)}". Options: ${JSON.stringify(texts)}`);
        return match;
    }

    // ----- tabs -----

    tab(regex) {
        return this.page.getByRole('tab').filter({ hasText: regex }).first();
    }

    async openTab(regex) {
        const tab = this.tab(regex);
        await expect(tab, `Tab ${regex} not found`).toBeVisible({ timeout: 30_000 });
        await tab.evaluate(el => el.scrollIntoView({ block: 'nearest', inline: 'center' })).catch(() => { });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 }).catch(() => { });
        await this.page.waitForTimeout(800);
    }

    // ----- fields: a labelled form field, or a grid column (row 0) -----

    async gridCell(regex, row = 0) {
        const panel = this.page.locator('[role="tabpanel"]').locator('visible=true').last();
        const scope = (await panel.count()) ? panel : this.page;
        const table = scope.locator('table, [role="grid"]').locator('visible=true').first();
        if (!(await table.count())) return null;

        const headers = (await table.locator('th, [role="columnheader"]').allInnerTexts()).map(h => h.replace(/\s+/g, ' ').trim());
        const col = headers.findIndex(h => regex.test(h));
        if (col < 0) return null;

        return table.locator('tbody tr, [role="row"]').filter({ has: this.page.locator('td, [role="gridcell"]') }).nth(row).locator('td, [role="gridcell"]').nth(col);
    }

    /** The control for a label: a grid column on the open tab first, then a labelled form field. */
    async fieldControl(regex) {
        // a column header with this name wins (otherwise the header text would be taken
        // for a form label and the first input of the row would be used)
        const cell = await this.gridCell(regex);
        if (!cell) {
            const formField = await this.control(regex, { timeout: 3000 }).catch(() => null);
            if (formField) return formField;
            throw new Error(`Field or column ${regex} not found on this tab`);
        }

        const inside = cell.locator('input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]), [role="combobox"], textarea').first();
        if (await inside.count()) return inside;

        // cell shows text until it is clicked
        await cell.click();
        await this.page.waitForTimeout(300);
        if (await inside.count()) return inside;
        await cell.dblclick();
        await this.page.waitForTimeout(300);
        return (await inside.count()) ? inside : cell;
    }

    async readField(regex) {
        const control = await this.fieldControl(regex);
        return (
            await control.evaluate(el => {
                if ('value' in el && typeof el.value === 'string' && el.value) return el.value;
                const wrapper = el.closest('.MuiFormControl-root, .MuiInputBase-root, .MuiAutocomplete-root, td, [role="gridcell"]') || el;
                return wrapper.innerText || el.textContent || '';
            })
        ).replace(/\s+/g, ' ').trim();
    }

    /** Dropdown: pick by chooser and remember what was picked under `label`. */
    async pick(regex, chooser, label) {
        const text = await this.chooseOption(await this.fieldControl(regex), chooser, label);
        this.entered[label] = { regex, value: text };
        return text;
    }

    /** Text / number / date: type like a user, leave the field, check the value stuck. */
    async type(regex, value, label) {
        const control = await this.fieldControl(regex);
        await control.scrollIntoViewIfNeeded().catch(() => { });

        const typeIt = async text => {
            await control.click();
            await control.press('Control+A').catch(() => { });
            await control.press('Backspace').catch(() => { });
            await control.pressSequentially(String(text), { delay: 30 });
            await control.press('Tab').catch(() => { });
            await this.page.waitForTimeout(500);
        };

        await typeIt(value);
        let shown = await this.readField(regex).catch(() => '');

        // masked date inputs: retry with digits only
        if (!valuesMatch(value, shown) && /\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/.test(String(value))) {
            await typeIt(String(value).replace(/\D/g, ''));
            shown = await this.readField(regex).catch(() => '');
        }

        if (!valuesMatch(value, shown)) {
            throw new Error(`${label}: typed "${value}" but the field shows "${shown}"`);
        }
        this.entered[label] = { regex, value: String(value) };
        console.log(`Entered ${label}: ${value}`);
    }

    // ----- the three tabs the script fills -----

    async fillReceiver(cfg) {
        await this.openTab(GRN_LABELS.tabs.receiver);
        await this.pick(GRN_LABELS.receiverTaxReg, cfg.receiverTaxReg, 'Receiver Tax Reg');
        await this.page.waitForTimeout(2000); // receiver details prefill
    }

    async fillSender(cfg, invoice) {
        await this.openTab(GRN_LABELS.tabs.sender);
        await this.pick(GRN_LABELS.sender, cfg.vendor, 'Sender');
        await this.page.waitForTimeout(1500);

        await this.type(GRN_LABELS.invoiceReference, invoice.invoiceNo, 'Invoice Reference');
        const invoiceDateControl = await this.fieldControl(GRN_LABELS.invoiceDate);
        const shownDate = await this.setDate(GRN_LABELS.invoiceDate, invoice.invoiceDate, 'Invoice Date', invoiceDateControl);
        this.entered['Invoice Date'] = { regex: GRN_LABELS.invoiceDate, value: shownDate };

        await this.pick(GRN_LABELS.orderType, cfg.orderType, 'Order Type');
        await this.page.waitForTimeout(1500); // order numbers load for the order type
        await this.pick(GRN_LABELS.orderNumber, cfg.orderNumber, 'Order Number');

        await this.pick(GRN_LABELS.modeOfDelivery, cfg.modeOfDelivery, 'Mode of Delivery');

        // Additional Charge Type: transport if the list has it, otherwise "other"
        const chargeControl = await this.fieldControl(GRN_LABELS.additionalChargeType);
        let chargeType;
        try {
            chargeType = await this.chooseOption(chargeControl, cfg.chargeType, 'Additional Charge Type');
        } catch (error) {
            console.warn(`${error.message.split('.')[0]}; using ${describeChooser(cfg.chargeTypeFallback)} instead.`);
            chargeType = await this.chooseOption(chargeControl, cfg.chargeTypeFallback, 'Additional Charge Type');
        }
        this.entered['Additional Charge Type'] = { regex: GRN_LABELS.additionalChargeType, value: chargeType };

        if (cfg.totalAdditionalCharge !== '') {
            await this.type(GRN_LABELS.totalAdditionalCharge, cfg.totalAdditionalCharge, 'Total Additional Charge');
        } else {
            console.warn('Total Additional Charge: no value (not in the config and not readable from the invoice) - left as is.');
        }
    }

    async fillItem(cfg) {
        await this.openTab(GRN_LABELS.tabs.item);

        await this.pick(GRN_LABELS.orderDescription, cfg.orderDescription, 'Order Description');
        await this.page.waitForTimeout(1500); // levels / periods prefill
        await this.pick(GRN_LABELS.itemName, cfg.itemName, 'Item Name');
        await this.page.waitForTimeout(1500); // order / balance quantity load

        const balance = await this.readField(GRN_LABELS.balanceQuantity).catch(() => '');
        const ordered = await this.readField(GRN_LABELS.orderQuantity).catch(() => '');
        console.log(`Order Quantity ${ordered || '?'} | Balance Quantity ${balance || '?'}`);

        const invoiceQty = cfg.invoiceQuantity || balance;
        const receivedQty = cfg.receivedQuantity || invoiceQty;
        if (!invoiceQty) throw new Error('Invoice Quantity: not in the config and no Balance Quantity shown to default to.');

        await this.type(GRN_LABELS.invoiceQuantity, invoiceQty, 'Invoice Quantity');
        await this.type(GRN_LABELS.receivedQuantity, receivedQty, 'Received Quantity');
    }

    /** Cost Allocation and Journal are filled by the app from the other tabs: they must have rows. */
    async checkPrefilledTabs() {
        const out = {};
        for (const [name, regex] of [['Cost Allocation', GRN_LABELS.tabs.costAllocation], ['Journal', GRN_LABELS.tabs.journal]]) {
            await this.openTab(regex);
            out[name] = await this.readGrid();
            console.log(`${name}: ${out[name].rows.length} row(s). Columns: ${JSON.stringify(out[name].headers)}`);
            expect(out[name].rows.length, `${name} tab has no rows - it should be filled from the Entry Item tab`).toBeGreaterThan(0);
        }
        return out;
    }

    /** First visible grid on the open tab: { headers, rows }. */
    async readGrid() {
        const panel = this.page.locator('[role="tabpanel"]').locator('visible=true').last();
        const scope = (await panel.count()) ? panel : this.page;
        const table = scope.locator('table, [role="grid"]').locator('visible=true').first();
        if (!(await table.count())) return { headers: [], rows: [] };
        return table.evaluate(t => {
            const clean = s => (s || '').replace(/\s+/g, ' ').trim();
            return {
                headers: [...t.querySelectorAll('th, [role="columnheader"]')].map(h => clean(h.textContent)),
                rows: [...t.querySelectorAll('tbody tr, [role="row"]')]
                    .filter(r => r.querySelector('td, [role="gridcell"]'))
                    .map(r => [...r.querySelectorAll('td, [role="gridcell"]')].map(c => {
                        const input = c.querySelector('input:not([type="hidden"]):not([type="checkbox"]), textarea');
                        return clean(input ? input.value : c.textContent);
                    }))
                    .filter(cells => cells.some(Boolean)),
            };
        });
    }

    /** The entry's number shown on the record after saving (label like "GSE ID" / "Document No"), or ''. */
    async readEntryId() {
        return this.page
            .evaluate(() => {
                const clean = t => (t || '').replace(/\s+/g, ' ').trim();
                const visible = el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                };
                const labels = [...document.querySelectorAll('body *')].filter(
                    el =>
                        el.childElementCount <= 1 &&
                        visible(el) &&
                        !el.closest('table, [role="grid"], nav, aside') &&
                        /^(goods.*entr(y|ies)|gse|grn|entry|document)\s*(id|no\.?|number)\s*:?$/i.test(clean(el.textContent))
                );
                for (const label of labels) {
                    for (let el = label; el && el !== document.body; el = el.parentElement) {
                        const next = el.nextElementSibling;
                        if (next && !visible(next)) continue;
                        const value = clean(next?.textContent);
                        if (value && value.length <= 40 && !/(id|no|number)\s*:?$/i.test(value)) return value;
                        if (el.parentElement && el.parentElement.childElementCount > 2) break;
                    }
                }
                return '';
            })
            .catch(() => '');
    }
}

// =====================================================================================
// Goods and Service Entries: search & verify
// =====================================================================================

export class GrnSearchPage extends InternalPlanSearchPage {
    constructor(page) {
        super(page);
        this.grn = new GrnPage(page);
    }

    async verifyScreen() {
        await expect(this.searchButton, 'Search button not shown on the Goods and Service Entries search screen').toBeVisible({ timeout: 60_000 });
    }

    async searchVendor(vendorTokens) {
        // form field only: the results table also has a "Vendor Name" column
        const filter = await this.grn.control(GRN_LABELS.vendorName);
        await this.grn.chooseOption(filter, vendorTokens, 'Vendor Name');
        const result = await this.search();
        expect(result.found, `"No data found" for vendor ${JSON.stringify(vendorTokens)}`).toBeTruthy();
        return result;
    }

    /** Text to click in the results: the entry ID if known, else the row with the invoice reference, else the last row. */
    async pickResult(result, { entryId, invoiceNo }) {
        const rows = result.rows;
        if (entryId && rows.some(r => r.includes(entryId))) return entryId;

        const row = (invoiceNo && rows.filter(r => r.includes(invoiceNo)).at(-1)) || rows.at(-1);
        // first cell of that row (normally the entry number / link)
        const firstCell = row.split(' | ')[0].split('\t')[0].trim();
        console.log(`Opening result "${firstCell}" (${entryId ? 'entry ID not in the results' : 'no entry ID known'}).`);
        return firstCell;
    }

    /** The entry is open when its Receiver tab shows. */
    async waitForDetail(urlBefore, id, timeout) {
        const tab = this.grn.tab(GRN_LABELS.tabs.receiver);
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (await tab.isVisible().catch(() => false)) return true;
            await this.page.waitForTimeout(500);
        }
        return false;
    }

    async openEntry(text) {
        const detail = await this.openIp(text);
        if (detail !== this.page) this.grn = new GrnPage(detail);
        return detail;
    }

    /**
     * Re-reads every value the script entered (tab by tab) and checks the prefilled tabs:
     * Cost Allocation must have rows, Journal must have rows and equal Debit / Credit totals.
     */
    async verifyEntry(entered, testInfo) {
        const results = [];
        const tabFor = {
            'Receiver Tax Reg': 'receiver',
            Sender: 'sender', 'Invoice Reference': 'sender', 'Invoice Date': 'sender', 'Order Type': 'sender',
            'Order Number': 'sender', 'Mode of Delivery': 'sender', 'Additional Charge Type': 'sender', 'Total Additional Charge': 'sender',
            'Order Description': 'item', 'Item Name': 'item', 'Invoice Quantity': 'item', 'Received Quantity': 'item',
        };

        let openTab = '';
        for (const [label, { regex, value }] of Object.entries(entered)) {
            const tabKey = tabFor[label] || 'sender';
            if (tabKey !== openTab) {
                await this.grn.openTab(GRN_LABELS.tabs[tabKey]);
                openTab = tabKey;
            }
            let actual = '';
            let found = true;
            try {
                actual = await this.grn.readField(regex);
            } catch {
                found = false;
            }
            const ok = found && (valuesMatch(value, actual) || this.normaliseOption(actual).includes(this.normaliseOption(value)));
            results.push({ column: label, row: tabKey, expected: value, actual, status: !found ? 'NOT FOUND' : ok ? 'PASS' : 'FAIL', where: 'field' });
        }

        // prefilled tabs
        await this.grn.openTab(GRN_LABELS.tabs.costAllocation);
        const cost = await this.grn.readGrid();
        results.push({ column: 'Cost Allocation rows', row: 'cost allocation', expected: 'at least 1', actual: String(cost.rows.length), status: cost.rows.length ? 'PASS' : 'FAIL', where: 'grid' });

        await this.grn.openTab(GRN_LABELS.tabs.journal);
        const journal = await this.grn.readGrid();
        results.push({ column: 'Journal rows', row: 'journal', expected: 'at least 1', actual: String(journal.rows.length), status: journal.rows.length ? 'PASS' : 'FAIL', where: 'grid' });

        const num = t => Number(String(t || '').replace(/[^0-9.-]/g, '')) || 0;
        const debitCol = journal.headers.findIndex(h => /debit|\bdr\b/i.test(h));
        const creditCol = journal.headers.findIndex(h => /credit|\bcr\b/i.test(h));
        if (debitCol >= 0 && creditCol >= 0) {
            const debit = journal.rows.reduce((s, r) => s + num(r[debitCol]), 0);
            const credit = journal.rows.reduce((s, r) => s + num(r[creditCol]), 0);
            results.push({
                column: 'Journal Debit = Credit', row: 'journal', expected: debit.toFixed(2), actual: credit.toFixed(2),
                status: Math.abs(debit - credit) < 0.01 ? 'PASS' : 'FAIL', where: 'grid',
            });
        }

        const summary = await reportResults(results, testInfo, 'Goods and Service Entry vs values entered', { expectedLabel: 'Entered' });
        expect(summary.fail, `${summary.fail} check(s) failed on the saved Goods and Service Entry (see the table)`).toBe(0);
        return { results, summary };
    }
}