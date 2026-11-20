import { expect } from '@playwright/test';
import { UploadV4Page } from './UploadV4Page.js';
import { InternalPlanSearchPage } from './InternalPlanSearchPage.js';
import { OrganizationPage } from './OrganizationPage.js';
import { TransactPage } from './TransactPage.js';
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
    // anchored: the search box at the top of every page says "What would you like to do today?" and must NOT match
    task: /^\s*(what\s*(would|do)\s*you\s*(like|want)\s*to\s*do\s*\??|select\s*task|task)\s*\*?\s*$/i,
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
    receiverTaxReg: /receiver.*tax\s*reg(n|istration)?(\s*(no\.?|number))?/i,
    // Sender Info
    documentType: /(document|doc\.?)\s*type/i,
    accountingDate: /(accounting|posting|acct\.?)\s*date/i,
    sender: /sender.*(name|tax\s*reg(n|istration)?)(\s*(no\.?|number))?/i,
    invoiceReference: /(invoice|inv\.?|bill)\s*ref(erence)?(\s*(no\.?|number))?/i,
    invoiceDate: /(invoice|inv\.?|bill)\s*date/i,
    orderType: /order\s*type/i,
    orderNumber: /(order|po|purchase\s*order)\s*(ref(erence)?\s*)?(number|no\.?|#|id)/i,
    modeOfDelivery: /mode\s*of\s*deliver/i,
    additionalChargeType: /(additional|addl\.?|add\.?)\s*charges?\s*type/i,
    totalAdditionalCharge: /total\s*(additional|addl\.?|add\.?)\s*charges?(\s*amount)?/i,
    // Goods and Service Entry Item (form field or grid column)
    orderDescription: /order\s*desc/i,
    itemName: /item\s*name/i,
    orderQuantity: /order\s*(qty|quantity)/i,
    balanceQuantity: /balance\s*(qty|quantity)/i,
    invoiceQuantity: /invoice\s*(qty|quantity)/i,
    receivedQuantity: /receiv(ed|e)\s*(qty|quantity)/i,
    // Search / Inbox filters
    vendorName: /vendor\s*name/i,
    organizationName: /organi[sz]ation(\s*name)?/i,                              // Search screen
    entryNumber: /(grn|srn|gse)(\s*\/\s*(srn|grn))?(\s*(no\.?|number|id))?/i,    // Search screen: "GRN/SRN Number"
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

// Captions on the GRN form can carry a marker between words, e.g. "Receiver (w) Tax Reg":
// let every field label pattern accept an optional "(x)" wherever it allows spaces.
// Every field pattern must also match the WHOLE caption (optional "*" at the end), so a lookup
// never lands on a bigger block of text that holds several fields.
for (const [key, value] of Object.entries(GRN_LABELS)) {
    if (!(value instanceof RegExp) || ['task', 'screen'].includes(key)) continue;
    let source = value.source.replace(/\\s\*/g, '\\s*(?:\\(\\w+\\)\\s*)?');
    if (!source.startsWith('^')) source = `^\\s*(?:${source})\\w*\\s*\\*?\\s*$`; // \\w*: finish a cut word (deliver -> delivery)
    GRN_LABELS[key] = new RegExp(source, value.flags);
}

/** GRN numbers: the form shows "GSE0126270000$35", lists show "GSE0126270000035" ("$" stands for 0). */
export function normaliseEntryId(id) {
    return String(id || '').trim().replace(/\$/g, '0');
}

/** Option chooser: 'first' | 'last' | ['token', 'token'] (all must be in the option) | exact text. */
function describeChooser(chooser) {
    if (chooser instanceof RegExp) return `option matching ${chooser}`;
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
    /**
     * Field lookup that always ends on the real input. On the GRN form the label is a caption
     * (<span aria-label="Receiver (w) Tax Reg">) next to the dropdown, and a label lookup can
     * return that caption itself; then the input next to it is used.
     */
    async control(field, options) {
        return this.asInput(await super.control(field, options));
    }

    async asInput(locator) {
        const isField = await locator
            .evaluate(el => el.matches('input:not([type="hidden"]), textarea, select, [role="combobox"], [contenteditable="true"]'), null, { timeout: 5000 })
            .catch(() => true);
        if (isField) return locator;

        const inside = locator.locator('input:not([type="hidden"]), textarea, [role="combobox"]').first();
        if (await inside.count()) return inside;

        // the nearest container that also holds an input: the caption's own field block
        return locator
            .locator('xpath=ancestor::*[.//input[not(@type="hidden")] or .//*[@role="combobox"]][1]')
            .locator('input:not([type="hidden"]), [role="combobox"]')
            .first();
    }

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
        const placeholder = (await control.getAttribute('placeholder', { timeout: 5000 }).catch(() => '')) || '';
        const m = placeholder.match(/(dd|mm|yyyy)([-/.])(dd|mm|yyyy)\2(dd|mm|yyyy)/i);
        if (!m) return fallback;
        return [m[1], m[3], m[4]].map(p => p.toUpperCase()).join(m[2]);
    }

    /**
     * Enters a date into a date field, in the format the field expects (from its placeholder).
     * `value` may be in any format (dd-mm-yyyy, yyyy-mm-dd ...). Works with plain inputs and
     * with date pickers that open a calendar popup:
     *   1. keyboard: focus the field and type the date
     *   2. keyboard, digits only (masked inputs)
     *   3. popup with a text-entry mode (pencil icon): type there, then OK
     *   4. popup calendar: go to the month, click the day, then OK
     * The field is held by its id, because an open popup hides the rest of the page from
     * label lookups. Returns what the field shows.
     */
    async setDate(regex, value, label, control) {
        control = control || (await this.control(regex));

        // Hold the field by a direct element handle: a date popup hides the rest of the page
        // from label / accessibility lookups, but a handle keeps pointing at the same element.
        const field = await control.elementHandle({ timeout: 10_000 });
        if (!field) throw new Error(`${label}: date field not found`);

        const placeholder = (await field.getAttribute('placeholder').catch(() => '')) || '';
        const pm = placeholder.match(/(dd|mm|yyyy)([-/.])(dd|mm|yyyy)\2(dd|mm|yyyy)/i);
        const format = pm ? [pm[1], pm[3], pm[4]].map(p => p.toUpperCase()).join(pm[2]) : 'DD-MM-YYYY';
        const text = formatDate(value, format);
        const target = parseDate(formatDate(value, 'YYYY-MM-DD'));

        const read = () =>
            field
                .evaluate(el => {
                    if (el.tagName === 'INPUT' && el.value) return el.value;
                    const box = el.closest('.MuiFormControl-root, .MuiPickersTextField-root, .MuiPickersInputBase-root') || el.parentElement;
                    const input = box?.querySelector('input');
                    if (input?.value) return input.value;
                    const sections = box?.querySelector('[role="group"], .MuiPickersSectionList-root');
                    const t = (sections?.textContent || '').trim();
                    return /\d/.test(t) ? t : '';
                })
                .catch(() => '');
        const ok = async () => valuesMatch(text, await read());

        if (await ok()) {
            console.log(`${label} already shows ${await read()}`);
            return read();
        }

        // Never clear or type into a date field that has a calendar button: on this app,
        // removing the date breaks the page. Pick the date in the calendar instead.
        const hasPicker = !!(await this.calendarButton(field));
        const isEmpty = !(await read());
        const attempts = [
            ['calendar button', () => this.pickDateInCalendar(field, target)],
            ['popup text entry', () => this.typeDateInPopup(field, text)],
        ];
        if (!hasPicker && isEmpty) {
            // plain, empty date box without a picker: typing is safe
            attempts.unshift(
                ['keyboard', () => this.typeDateWithKeyboard(field, text)],
                ['keyboard (digits only)', () => this.typeDateWithKeyboard(field, text.replace(/\D/g, ''))]
            );
        }

        const limit = (promise, ms) =>
            Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no result after ${ms / 1000}s`)), ms))]);

        const notes = [];
        let popupHtml = '';
        for (const [name, run] of attempts) {
            const started = Date.now();
            await limit(run(), 30_000).catch(e => notes.push(`${name}: ${e.message.split('\n')[0]}`));
            if (!popupHtml && (await this.datePopup().isVisible().catch(() => false))) {
                popupHtml = await this.datePopup().evaluate(el => el.outerHTML.replace(/\s+/g, ' ').slice(0, 1500)).catch(() => '');
            }
            const done = await ok();
            if (!done) await this.closeDatePopup();
            console.log(`  ${label}: tried ${name} (${Math.round((Date.now() - started) / 1000)}s), field shows "${await read()}"`);
            if (done) {
                await this.closeDatePopup();
                const shown = await read();
                console.log(`Entered ${label}: ${shown} (${name})`);
                return shown;
            }
        }

        const fieldHtml = await field
            .evaluate(el => (el.closest('.MuiFormControl-root, .MuiTextField-root, .MuiPickersTextField-root') || el.parentElement || el).outerHTML.replace(/\s+/g, ' ').slice(0, 2000))
            .catch(() => '(could not read)');
        throw new Error(
            `${label}: could not enter "${text}" (format ${format}); the field shows "${await read()}". ` +
            (notes.length ? `Notes: ${notes.join(' | ')}. ` : '') +
            `Field HTML: ${fieldHtml}` +
            (popupHtml ? ` || Popup HTML: ${popupHtml}` : ' || No popup was seen.')
        );
    }

    /** Click that falls back to a DOM click (popup buttons can sit outside the viewport). */
    async safeClick(locator) {
        const ok = await locator.click({ timeout: 3000 }).then(() => true).catch(() => false);
        if (!ok) await locator.evaluate(el => el.click(), null, { timeout: 3000 });
    }

    /** Any open date popup: MUI dialog / popper, react-datepicker, antd, flatpickr, or any modal dialog. */
    datePopup() {
        return this.page
            .locator(
                [
                    '.MuiPickersPopper-root', '.MuiPickersLayout-root', '.MuiDialog-root', '.MuiPopover-root', '.MuiPopper-root',
                    '[role="dialog"]', '[aria-modal="true"]',
                    '.react-datepicker', '.react-datepicker-popper', '.rdp', '.ant-picker-dropdown', '.flatpickr-calendar.open',
                ].join(', ')
            )
            .locator('visible=true')
            .last();
    }

    async closeDatePopup() {
        for (let i = 0; i < 2 && (await this.datePopup().isVisible().catch(() => false)); i++) {
            await this.page.keyboard.press('Escape').catch(() => { });
            await this.page.waitForTimeout(300);
        }
    }

    /** The calendar button next to a date field ("Choose date" / calendar icon; never a clear "x"), or null. */
    async calendarButton(field) {
        const handle = await field
            .evaluateHandle(el => {
                const box = el.closest('.MuiInputBase-root, .MuiPickersInputBase-root, .MuiFormControl-root') || el.parentElement;
                if (!box) return null;
                const labelled = box.querySelector('[aria-label*="choose date" i], [aria-label*="calendar" i], [aria-label*="open picker" i]');
                if (labelled) return labelled.closest('button') || labelled;
                const svg = box.querySelector('[data-testid*="Calendar"], [data-testid*="Event"], [data-testid*="DateRange"], [data-testid*="Today"]');
                if (svg) return svg.closest('button') || svg;
                return null;
            })
            .catch(() => null);
        return handle ? handle.asElement() : null;
    }

    /**
     * Opens the field's date popup if none is open yet: the calendar button next to the field,
     * or (only when there is no such button) a click on the field itself. Nothing is typed or cleared.
     */
    async ensureDatePopup(field) {
        if (await this.datePopup().isVisible().catch(() => false)) return this.datePopup();

        const opened = () => this.datePopup().waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
        const button = await this.calendarButton(field);

        if (button) {
            await button.click({ timeout: 3000 }).catch(() => button.evaluate(e => e.click()));
            if (await opened()) return this.datePopup();
            throw new Error('clicked the calendar button but no calendar opened');
        }

        await field.click({ force: true, timeout: 5000 }).catch(() => { });
        if (await opened()) return this.datePopup();
        throw new Error('no calendar button next to the field and clicking the field opened nothing');
    }

    async typeDateWithKeyboard(field, text) {
        const isInput = await field.evaluate(el => {
            el.scrollIntoView({ block: 'center' });
            if (el.tagName === 'INPUT') el.focus();
            return el.tagName === 'INPUT';
        });
        if (!isInput) await field.click({ timeout: 5000 });
        if (await this.datePopup().isVisible().catch(() => false)) throw new Error('a popup opened instead of typing');

        const kb = this.page.keyboard;
        await kb.press('Control+A');
        await kb.press('Backspace');
        await kb.type(text, { delay: 40 });
        await kb.press('Tab');
        await this.page.waitForTimeout(400);
    }

    async typeDateInPopup(field, text) {
        const popup = await this.ensureDatePopup(field);

        const pen = popup.locator('[aria-label*="text input" i], [aria-label*="keyboard" i], [data-testid="PenIcon"], [data-testid="EditIcon"]').first();
        if (!(await pen.count())) throw new Error('popup has no text-entry mode');
        await this.safeClick(pen);

        const input = popup.locator('input:not([type="hidden"])').locator('visible=true').first();
        await this.safeClick(input);
        await this.page.keyboard.press('Control+A');
        await this.page.keyboard.press('Backspace');
        await this.page.keyboard.type(text, { delay: 40 });
        await this.acceptDatePopup(popup);
    }

    async pickDateInCalendar(field, target) {
        if (!target) throw new Error('not a date');
        const popup = await this.ensureDatePopup(field);

        const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
        const wantedIndex = Number(target.y) * 12 + Number(target.m) - 1;

        // the month shown: a known header element, or the first "<Month> <yyyy>" text in the popup
        const shownMonth = async () => {
            const header = popup
                .locator('.MuiPickersCalendarHeader-label, .react-datepicker__current-month, .ant-picker-header-view, .flatpickr-current-month, .rdp-caption_label')
                .first();
            let t = ((await header.innerText({ timeout: 1000 }).catch(() => '')) || '').toLowerCase();
            if (!/\d{4}/.test(t)) t = ((await popup.innerText({ timeout: 2000 }).catch(() => '')) || '').toLowerCase();
            const m = t.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*,?\s*(\d{4})/);
            if (!m) throw new Error(`cannot read the calendar month ("${t.slice(0, 60)}")`);
            return Number(m[2]) * 12 + months.findIndex(name => name.startsWith(m[1]));
        };

        for (let step = 0; step < 36; step++) {
            const shownIndex = await shownMonth();
            if (shownIndex === wantedIndex) break;
            const button = shownIndex > wantedIndex
                ? popup.locator('[aria-label*="previous month" i], [aria-label*="prev" i], [title*="previous" i], [data-testid="ArrowLeftIcon"], .react-datepicker__navigation--previous, .ant-picker-header-prev-btn, .flatpickr-prev-month').first()
                : popup.locator('[aria-label*="next month" i], [aria-label^="next" i], [title*="next" i], [data-testid="ArrowRightIcon"], .react-datepicker__navigation--next, .ant-picker-header-next-btn, .flatpickr-next-month').first();
            await this.safeClick(button);
            await this.page.waitForTimeout(250);
        }

        const day = String(Number(target.d));
        const days = popup
            .locator('button[role="gridcell"], .MuiPickersDay-root, [role="gridcell"] button, [role="option"], .react-datepicker__day, .ant-picker-cell-in-view, .flatpickr-day, td button, td')
            .filter({ hasText: new RegExp(`^\\s*${day}\\s*$`) })
            .locator('visible=true');
        const count = await days.count();
        let clicked = false;
        for (let i = 0; i < count && !clicked; i++) {
            const cls = (await days.nth(i).getAttribute('class').catch(() => '')) || '';
            if (/outside|prev-month|next-month|disabled/i.test(cls)) continue;
            await this.safeClick(days.nth(i));
            clicked = true;
        }
        if (!clicked) throw new Error(`day ${day} not found in the calendar`);

        await this.acceptDatePopup(popup);
    }

    /** Clicks OK / Accept / Set in the popup if it has one (some pickers close by themselves). */
    async acceptDatePopup(popup) {
        await this.page.waitForTimeout(300);
        const okButton = popup.getByRole('button', { name: /^\s*(ok|accept|set|done|apply)\s*$/i }).first();
        if (await okButton.count()) await this.safeClick(okButton);
        // no Enter here: on the Inbox filter form Enter can submit and reload the page
        await this.page.waitForTimeout(400);
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

    /**
     * Options of the open dropdown: anything with the option role (as your TransactPage uses),
     * MUI lists, and react-select menus (div options with "-option" classes).
     */
    openOptions() {
        return this.page
            .getByRole('option')
            .or(this.page.locator('[role="listbox"] li, .MuiMenu-list li, .MuiAutocomplete-option'))
            .or(this.page.locator('[id^="react-select"][id*="-option-"], [class*="-menu"] [class*="-option"]'))
            .locator('visible=true');
    }

    /** Short description of an element, for error messages. */
    async describe(locator) {
        return locator
            .evaluate(el => {
                const attrs = ['id', 'role', 'placeholder', 'aria-label', 'aria-labelledby', 'name', 'type', 'readonly']
                    .map(a => (el.hasAttribute(a) ? `${a}="${el.getAttribute(a)}"` : ''))
                    .filter(Boolean)
                    .join(' ');
                const box = el.closest('.MuiFormControl-root, .MuiAutocomplete-root') || el.parentElement;
                return `<${el.tagName.toLowerCase()} ${attrs}> in ${(box?.outerHTML || '').replace(/\s+/g, ' ').slice(0, 400)}`;
            }, null, { timeout: 3000 })
            .catch(() => '(could not read)');
    }

    /** Text a dropdown currently shows (input value, or the selected text of a MUI Select). */
    async currentText(control) {
        return (
            await control
                .evaluate(el => {
                    if ('value' in el && typeof el.value === 'string' && el.value) return el.value;
                    const box = el.closest('.MuiAutocomplete-root, .MuiInputBase-root, .MuiFormControl-root, [class*="-container"]') || el;
                    return box.querySelector('.MuiSelect-select, .MuiChip-label, [class*="singleValue"]')?.textContent || '';
                }, null, { timeout: 3000 })
                .catch(() => '')
        ).trim();
    }

    /** Does `text` satisfy a chooser (exact text, or all tokens)? */
    matchesChooser(text, chooser) {
        if (chooser instanceof RegExp) return chooser.test(String(text || ''));
        const t = this.normaliseOption(text);
        if (Array.isArray(chooser)) return chooser.every(c => t.includes(this.normaliseOption(c)));
        return t === this.normaliseOption(chooser);
    }

    /** Opens a dropdown control and picks an option by chooser. Returns the picked text. */
    async chooseOption(control, chooser, name = 'dropdown') {
        await control.scrollIntoViewIfNeeded().catch(() => { });

        if (await this.openOptions().first().isVisible().catch(() => false)) {
            await this.page.keyboard.press('Escape').catch(() => { });
            await this.page.waitForTimeout(300);
        }

        // already showing the wanted option (e.g. the page remembers the last filter): leave it
        const current = await this.currentText(control);
        if (current && chooser !== 'first' && chooser !== 'last' && this.matchesChooser(current, chooser)) {
            console.log(`${name} already shows ${current}`);
            return current;
        }

        await expect(control, `${name}: the field is disabled`).toBeEnabled({ timeout: 15_000 }).catch(() => { });
        const listShown = ms => this.openOptions().first().waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);
        const arrow = control
            .locator('xpath=ancestor::*[contains(@class,"MuiAutocomplete-root") or contains(@class,"MuiFormControl-root") or contains(@class,"MuiInputBase-root") or self::td][1]')
            .locator('.MuiAutocomplete-popupIndicator, button[aria-label="Open"], [data-testid="ArrowDropDownIcon"]')
            .first();

        // several ways to open the list, retried (the page may still be loading its options)
        const ways = [
            ['click the field', () => control.click({ timeout: 5000 })],
            ['click the dropdown arrow', async () => { if (await arrow.count()) await arrow.click({ timeout: 5000 }); else throw new Error('no arrow'); }],
            ['arrow-down key', async () => { await control.focus(); await this.page.keyboard.press('ArrowDown'); }],
            ['alt + arrow-down', async () => { await control.focus(); await this.page.keyboard.press('Alt+ArrowDown'); }],
            ['type to search', async () => {
                // only for searchable fields; types the start of the wanted option (never clears anything)
                if (!(await control.isEditable().catch(() => false))) throw new Error('not editable');
                const hint = Array.isArray(chooser) ? chooser[0] : typeof chooser === 'string' && !['first', 'last'].includes(chooser) ? chooser : '';
                if (!hint) throw new Error('no text to search for');
                await control.focus();
                await this.page.keyboard.type(String(hint).slice(0, 4), { delay: 60 });
            }],
        ];
        // "No options" = the list opened but its options are not loaded yet (slow server):
        // close it, wait and reopen, for up to 45s, before trying other ways to open it
        const noOptions = this.page.locator('.MuiAutocomplete-noOptions, .MuiAutocomplete-loading').locator('visible=true').first();
        let waitedForOptions = false;
        const waitForOptions = async () => {
            if (waitedForOptions) return false; // a list that stays empty is waited for only once
            waitedForOptions = true;
            const deadline = Date.now() + 45_000;
            while (Date.now() < deadline) {
                if (await listShown(1500)) return true;
                if (!(await noOptions.isVisible().catch(() => false))) return false; // nothing opened at all
                console.log(`${name}: list shows "No options" yet, waiting for it to load...`);
                await this.page.keyboard.press('Escape').catch(() => { });
                await this.page.waitForTimeout(3000);
                await control.click({ timeout: 5000 }).catch(() => { });
            }
            return false;
        };

        let opened = false;
        for (let round = 0; round < 2 && !opened; round++) {
            for (const [wayName, run] of ways) {
                await run().catch(() => { });
                if ((opened = await listShown(round ? 5000 : 3000))) break;
                if (wayName !== 'type to search' && (opened = await waitForOptions())) break;
                await this.page.keyboard.press('Escape').catch(() => { });
            }
        }
        if (!opened) {
            // what was clicked, and any menu-like element that is visible now
            await control.click({ timeout: 3000 }).catch(() => { });
            await this.page.waitForTimeout(800);
            const menus = await this.page
                .evaluate(() =>
                    [...document.querySelectorAll('[role="listbox"], [role="menu"], [role="presentation"], [class*="menu" i], [class*="popper" i], [class*="dropdown" i], [class*="listbox" i]')]
                        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('nav, aside'); })
                        .slice(-3)
                        .map(el => el.outerHTML.replace(/\s+/g, ' ').slice(0, 500))
                )
                .catch(() => []);
            throw new Error(
                `${name}: the option list did not open (tried click, arrow, arrow-down keys, typing). The field shows "${current}". ` +
                `Clicked: ${await this.describe(control)} || Menus visible after clicking: ${menus.length ? menus.join(' ## ') : 'none'}`
            );
        }

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
        else pick = items.find(it => this.matchesChooser(it.text, chooser));

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

        // Every Validate & Save on this form goes through the Accounting Date fallback
        // (also when a spec calls grn.actions.validateOrganization directly).
        this.originalValidate = this.actions.validateOrganization.bind(this.actions);
        this.actions.validateOrganization = async (option = 'Validate & Save') =>
            this.saveCfg ? this.validateAndSave(this.saveCfg, this.saveInvoice) : this.originalValidate(option);
    }

    // ----- Transact navigation -----

    async openTransact() {
        await this.sidebarItem('Transact').click();
        const task = await this.control(GRN_LABELS.task, { timeout: 30_000 }).catch(() => null);
        if (!task) {
            throw new Error(
                `Clicked "Transact" but its first dropdown did not show (page: ${this.page.url()}). ` +
                'Check GRN_LABELS.task against the label of that dropdown.'
            );
        }
        // never the global search box in the header
        const placeholder = (await task.getAttribute('placeholder').catch(() => '')) || '';
        if (/today/i.test(placeholder)) throw new Error('The Transact task dropdown matched the header search box; adjust GRN_LABELS.task.');
    }

    /**
     * Transact > task > Type of Screen.
     * First with your TransactPage (exact option names, the same way Organization Master and
     * Internal Plan open); if that fails, with this page object's dropdown routine (RegExp match).
     *   task / screen: { name: 'Exact option text', match: /regex/ }
     */
    async chooseTransact(task, screen) {
        const transact = new TransactPage(this.page);
        try {
            await transact.openTransact();
            await transact.selectTask(task.name);
            await transact.selectTypeOfScreen(screen.name);
            console.log(`Transact: ${task.name} > ${screen.name}`);
            await this.page.waitForTimeout(1500);
            return;
        } catch (error) {
            console.warn(`TransactPage could not select "${task.name}" > "${screen.name}": ${error.message.split('\n')[0]}. Trying by pattern.`);
            await this.page.keyboard.press('Escape').catch(() => { });
        }

        await this.openTransact();
        const taskControl = await this.control(GRN_LABELS.task);
        await this.chooseOption(taskControl, task.match, 'Task').catch(async error => {
            throw new Error(`${error.message} Task field found: ${await this.describe(taskControl)}`);
        });
        await this.page.waitForTimeout(1500); // Type of Screen options load for the task
        const screenControl = await this.control(GRN_LABELS.screen);
        await this.chooseOption(screenControl, screen.match, 'Type of Screen').catch(async error => {
            throw new Error(`${error.message} Type of Screen field found: ${await this.describe(screenControl)}`);
        });
        await this.page.waitForTimeout(2000);
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
            let lookupError;
            const formField = await this.control(regex, { timeout: 3000 }).catch(e => { lookupError = e; return null; });
            if (formField) return formField;
            throw new Error(`Field or column ${regex} not found on this tab. ${lookupError?.message || ''}`);
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

    /**
     * Marks the input as belonging to `label`; fails when a different label already claimed it
     * (two labels resolving to the same dropdown would overwrite a value already set).
     */
    async claim(control, label) {
        const owner = await control
            .evaluate((el, name) => {
                const previous = el.getAttribute('data-grn-field');
                if (!previous) el.setAttribute('data-grn-field', name);
                return previous;
            }, label, { timeout: 5000 })
            .catch(() => null);
        if (owner && owner !== label) {
            throw new Error(`"${label}" resolved to the same input as "${owner}". Check GRN_LABELS for "${label}" against the caption on screen.`);
        }
    }

    /** Dropdown: pick by chooser and remember what was picked under `label`. */
    async pick(regex, chooser, label) {
        const control = await this.fieldControl(regex);
        await this.claim(control, label);
        let text = await this.chooseOption(control, chooser, label);

        // the value must stick (some selections reload the form and clear other fields)
        for (let attempt = 0; attempt < 2; attempt++) {
            await this.page.waitForTimeout(500);
            const shown = await this.currentText(control);
            if (shown && this.normaliseOption(shown).includes(this.normaliseOption(text))) break;
            if (attempt === 1) throw new Error(`${label}: chose "${text}" but the field shows "${shown}"`);
            console.warn(`${label}: "${text}" did not stick (field shows "${shown}"), choosing again.`);
            text = await this.chooseOption(control, chooser, label);
        }

        this.entered[label] = { regex, value: text };
        return text;
    }

    /** Text / number / date: type like a user, leave the field, check the value stuck. */
    async type(regex, value, label) {
        const control = await this.fieldControl(regex);
        await this.claim(control, label);
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
        await this.claim(invoiceDateControl, 'Invoice Date');
        const shownDate = await this.setDate(GRN_LABELS.invoiceDate, invoice.invoiceDate, 'Invoice Date', invoiceDateControl);
        this.entered['Invoice Date'] = { regex: GRN_LABELS.invoiceDate, value: shownDate };

        await this.pick(GRN_LABELS.orderType, cfg.orderType, 'Order Type');
        await this.page.waitForTimeout(1500); // order numbers load for the order type
        await this.selectOrder(cfg.orderNumber);

        await this.pick(GRN_LABELS.modeOfDelivery, cfg.modeOfDelivery, 'Mode of Delivery');

        // Additional Charge Type: transport if the list has it, otherwise "other"
        const chargeControl = await this.fieldControl(GRN_LABELS.additionalChargeType);
        await this.claim(chargeControl, 'Additional Charge Type');
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

        // last, because choosing the order reloads the form and can clear them
        await this.ensureSaveFields(cfg, invoice);
    }

    /**
     * The Accounting Date to use: 'today' | 'invoiceDate' | 'previousMonthEnd' | a date (any format).
     * When cfg.accountingDate is a list, the first entry is used here (validateAndSave tries the rest).
     */
    accountingDateFor(cfg, invoice) {
        const setting = Array.isArray(cfg.accountingDate) ? cfg.accountingDate[0] : cfg.accountingDate || 'today';
        const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const now = new Date();
        if (setting === 'invoiceDate') return formatDate(invoice?.invoiceDate, 'YYYY-MM-DD');
        if (setting === 'today') return iso(now);
        if (setting === 'previousMonthEnd') return iso(new Date(now.getFullYear(), now.getMonth(), 0));
        return formatDate(setting, 'YYYY-MM-DD');
    }

    /**
     * Validate & Save. When the server answers that the Accounting Date's period "is not Open",
     * the next date in cfg.accountingDate is set (calendar icon) and Validate & Save is tried again.
     * Returns the Accounting Date that was accepted.
     */
    async validateAndSave(cfg, invoice) {
        // the configured dates first, then fallbacks (a single setting like 'today' still gets them)
        const configured = Array.isArray(cfg.accountingDate) ? cfg.accountingDate : [cfg.accountingDate || 'invoiceDate'];
        const settings = [...new Set([...configured, 'invoiceDate', 'previousMonthEnd', 'today'])];
        const tried = [];

        for (let i = 0; i < settings.length; i++) {
            const date = this.accountingDateFor({ ...cfg, accountingDate: settings[i] }, invoice);
            if (tried.some(t => t.date === date)) continue; // same date as an earlier setting
            this.inDateFallback = true;
            await this.ensureSaveFields({ ...cfg, accountingDate: settings[i] }, invoice).finally(() => { this.inDateFallback = false; });

            try {
                await this.originalValidate('Validate & Save');
                console.log(`Validate & Save accepted with Accounting Date ${date} (${settings[i]}).`);
                return date;
            } catch (error) {
                const closed = /not\s*open/i.test(error.message);
                tried.push({ date, message: (error.message.match(/status: error - ([^\]]+)/) || [, error.message.split('\n')[0]])[1] });
                if (!closed) throw error;
                console.warn(`Accounting Date ${date} (${settings[i]}) is in a closed period; trying the next date.`);
                await this.page.keyboard.press('Escape').catch(() => { });
                await this.page.waitForTimeout(1500);
            }
        }

        throw new Error(
            'Validate & Save: no Accounting Date in an open period. Tried: ' +
            tried.map(t => `${t.date} -> ${t.message}`).join(' | ') +
            '. Put an open date in GRN.accountingDate (e.g. \'2026-10-15\').'
        );
    }

    /**
     * Fields the server needs for Validate & Save ("Please fill DocumentType & AccountingDate"):
     * Sender Info > Accounting Date and Document Type. Sets them when empty or wrong; safe to call
     * again right before saving.
     */
    async ensureSaveFields(cfg, invoice) {
        // remembered for validateAndSave (the Accounting Date fallback)
        if (!this.inDateFallback) {
            this.saveCfg = cfg;
            this.saveInvoice = invoice;
        }
        await this.openTab(GRN_LABELS.tabs.sender);

        // Accounting Date (calendar icon; nothing is cleared)
        const wanted = this.accountingDateFor(cfg, invoice);
        const dateControl = await this.fieldControl(GRN_LABELS.accountingDate);
        const shownDate = await dateControl.inputValue().catch(() => '');
        if (!valuesMatch(formatDate(wanted, 'YYYY-MM-DD'), shownDate)) {
            const set = await this.setDate(GRN_LABELS.accountingDate, wanted, 'Accounting Date', dateControl);
            this.entered['Accounting Date'] = { regex: GRN_LABELS.accountingDate, value: set };
        } else {
            this.entered['Accounting Date'] = { regex: GRN_LABELS.accountingDate, value: shownDate };
            console.log(`Accounting Date already ${shownDate}`);
        }

        // Document Type = Goods Receipt (without it the app builds no Cost Allocation / Journal)
        const typeControl = await this.fieldControl(GRN_LABELS.documentType);
        const shownType = await this.currentText(typeControl);
        if (shownType && this.matchesChooser(shownType, cfg.documentType)) {
            this.entered['Document Type'] = { regex: GRN_LABELS.documentType, value: shownType };
            console.log(`Document Type already ${shownType}`);
        } else {
            await this.page.evaluate(() => document.querySelectorAll('[data-grn-field="Document Type"]').forEach(el => el.removeAttribute('data-grn-field')));
            await this.pick(GRN_LABELS.documentType, cfg.documentType, 'Document Type');
        }
    }

    /**
     * Order Number: the field is a grey (read-only) box with a magnifier NEXT to it.
     * Finds the "ORDER NUMBER" caption, the magnifier in that caption's own block (never the
     * Order Type block), opens "Transaction Search", clicks the chosen order row, and checks
     * that Order Number then shows it. (Order Descriptions only exist once an order is chosen.)
     * chooser: 'latest' (highest Order Number; ties -> latest ForPrdFrom) | 'first' | 'last' | ['tokens']
     */
    async selectOrder(chooser = 'latest') {
        const found = await this.markOrderBlock();

        if (!found.ok) {
            throw new Error(
                `Order Number: no magnifier found next to the caption (captions matched: ${JSON.stringify(found.captions)}). ` +
                'Nothing was changed on the form.'
            );
        }
        return this.pickOrderInPopup(chooser);
    }

    /** Marks the Order Number block and its magnifier (data-grn-order-block / data-grn-order-search). */
    async markOrderBlock() {
        return this.page.evaluate(source => {
            const caption = new RegExp(source, 'i');
            const clean = t => (t || '').replace(/\s+/g, ' ').trim();
            const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const isSearch = el =>
                el.matches('[data-testid*="Search" i], [aria-label*="search" i], [title*="search" i]') ||
                !!el.querySelector('[data-testid*="Search" i]');

            document.querySelectorAll('[data-grn-order-block], [data-grn-order-search]').forEach(el => {
                el.removeAttribute('data-grn-order-block');
                el.removeAttribute('data-grn-order-search');
            });

            const captions = [...document.querySelectorAll('body *')].filter(
                el => el.childElementCount <= 1 && visible(el) && !el.closest('nav, aside, header, table') && caption.test(clean(el.textContent))
            );
            for (const cap of captions) {
                // climb from the caption until a block holds a magnifier; stop if the block
                // also holds another field caption (then we have left this field's block)
                for (let block = cap.parentElement, depth = 0; block && depth < 5; block = block.parentElement, depth++) {
                    const icons = [...block.querySelectorAll('button, [role="button"], svg')].filter(el => visible(el) && isSearch(el));
                    const otherCaptions = [...block.querySelectorAll('.MuiTypography-caption, label')].filter(c => c !== cap && clean(c.textContent));
                    if (otherCaptions.length) break;
                    if (icons.length) {
                        const icon = icons[0].closest('button, [role="button"]') || icons[0];
                        icon.setAttribute('data-grn-order-search', '1');
                        block.setAttribute('data-grn-order-block', '1');
                        return { ok: true, caption: clean(cap.textContent) };
                    }
                }
            }
            return { ok: false, captions: captions.map(c => clean(c.textContent)) };
        }, GRN_LABELS.orderNumber.source);
    }

    /** What the Order Number box shows ('' when not found). */
    async readOrderNumber() {
        const found = await this.markOrderBlock();
        if (!found.ok) throw new Error('Order Number block not found');
        return this.page
            .locator('[data-grn-order-block]')
            .evaluate(el => {
                const input = el.querySelector('input:not([type="hidden"])');
                return ((input && input.value) || el.innerText || '').replace(/\s+/g, ' ').trim();
            })
            .catch(() => '');
    }

    async pickOrderInPopup(chooser) {
        const readBlock = () => this.readOrderNumber().catch(() => '');
        const before = await readBlock();

        await this.page.locator('[data-grn-order-search]').click({ timeout: 5000 });
        const dialog = this.page.locator('[role="dialog"], .MuiDialog-root, .MuiModal-root:not(.MuiPopover-root)').locator('visible=true').last();
        await expect(dialog, 'Clicking the Order Number magnifier opened no popup').toBeVisible({ timeout: 15_000 });

        const rows = dialog.locator('tbody tr, [role="row"]').filter({ has: this.page.locator('td, [role="gridcell"]') });
        if (!(await rows.first().isVisible({ timeout: 5000 }).catch(() => false))) {
            const search = dialog.getByRole('button', { name: /^\s*(search|go|find|show)\s*$/i }).first();
            if (await search.count()) await search.click({ timeout: 5000 }).catch(() => { });
        }
        await expect(rows.first(), 'The Transaction Search popup shows no orders').toBeVisible({ timeout: 30_000 });

        const table = dialog.locator('table, [role="grid"]').first();
        const headers = (await table.locator('th, [role="columnheader"]').allInnerTexts().catch(() => [])).map(h => h.replace(/\s+/g, ' ').trim());
        const texts = await rows.evaluateAll(trs =>
            trs.map(tr => [...tr.querySelectorAll('td, [role="gridcell"]')].map(c => (c.textContent || '').replace(/\s+/g, ' ').trim()))
        );

        const numberCol = headers.findIndex(h => /^\s*(order|po)\s*(no\.?|number|#|id)\s*$/i.test(h));
        const fromCol = headers.findIndex(h => /for\s*prd\s*from|from\s*date|order\s*date|date/i.test(h));
        if (numberCol < 0) throw new Error(`No "Order Number" column in the popup. Columns: ${JSON.stringify(headers)}`);

        const dateKey = t => { const d = parseDate(t); return d ? `${d.y}-${d.m}-${d.d}` : ''; };
        const orders = texts
            .map((cells, i) => ({ i, number: cells[numberCol] || '', from: fromCol >= 0 ? dateKey(cells[fromCol]) : '', cells }))
            .filter(o => o.number);

        let pick;
        if (chooser === 'latest') {
            pick = [...orders].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }) || a.from.localeCompare(b.from)).at(-1);
        } else if (chooser === 'first') pick = orders[0];
        else if (chooser === 'last') pick = orders.at(-1);
        else pick = orders.find(o => this.matchesChooser(o.cells.join(' '), chooser));
        if (!pick) throw new Error(`No order ${JSON.stringify(chooser)} in the popup. Orders: ${JSON.stringify(orders.map(o => o.number))}`);

        // click the order number cell of that row (the popup closes and fills Order Number)
        const row = rows.nth(pick.i);
        const tick = row.locator('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]').first();
        if (await tick.count()) await tick.click({ timeout: 5000 }).catch(() => tick.evaluate(e => e.click()));
        else await row.locator('td, [role="gridcell"]').nth(numberCol).click({ timeout: 5000 });
        await this.page.waitForTimeout(800);

        if (await dialog.isVisible().catch(() => false)) {
            const confirm = dialog.getByRole('button', { name: /^\s*(select|ok|submit|done|apply|add|choose|confirm)\s*$/i }).first();
            if (await confirm.count()) await confirm.click({ timeout: 5000 }).catch(() => confirm.evaluate(e => e.click()));
            else await row.dblclick({ timeout: 5000 }).catch(() => { });
        }
        await expect(dialog, 'The Transaction Search popup did not close after choosing the order').toBeHidden({ timeout: 15_000 });
        await this.page.waitForTimeout(1500); // the order's details load into the form

        const shown = await readBlock();
        if (!shown.includes(pick.number)) {
            throw new Error(`Chose order ${pick.number} (period from ${pick.from || '?'}), but the Order Number box shows "${shown}" (before: "${before}").`);
        }
        console.log(`Selected Order Number: ${pick.number}${pick.from ? ` (ForPrdFrom ${pick.from})` : ''} - ${chooser} of ${orders.length} rows`);
        this.entered['Order Number'] = { regex: GRN_LABELS.orderNumber, value: pick.number };
        return pick.number;
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

    /** Cost Allocation and Journal are filled by the app when the entry is saved: they must have rows after Validate & Save. */
    async checkPrefilledTabs({ strict = false, waitMs = 20_000 } = {}) {
        const out = {};
        for (const [name, regex] of [['Cost Allocation', GRN_LABELS.tabs.costAllocation], ['Journal', GRN_LABELS.tabs.journal]]) {
            // the app fills these a little after the Entry Item tab: wait up to 30s for rows
            const deadline = Date.now() + waitMs;
            do {
                await this.openTab(regex);
                out[name] = await this.readGrid();
                if (out[name].rows.length) break;
                await this.page.waitForTimeout(3000);
            } while (Date.now() < deadline);
            console.log(`${name}: ${out[name].rows.length} row(s). Columns: ${JSON.stringify(out[name].headers)}`);
            if (!out[name].rows.length) {
                const note = `${name} tab shows no rows on the open form yet; it is checked again after reopening the saved entry from Search.`;
                if (strict) expect(out[name].rows.length, note).toBeGreaterThan(0);
                console.warn(note);
            }
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

    /** The entry number after Activate (unchanged; "$" in it is a placeholder for 0 in search lists). */
    async readFinalEntryId(fallback = '') {
        return (await this.readEntryId()) || fallback;
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
                        /^#?\s*(goods.*entr(y|ies)|gse|grn(\s*\/\s*srn)?|srn|entry|document)\s*(id|no\.?|number)\s*:?$/i.test(clean(el.textContent))
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
                // fallback: the entry number shown in the page header, e.g. GSE0126270000$19
                const match = clean(document.querySelector('main, #root, body')?.innerText).match(/\bGSE[0-9A-Z$]{6,}/);
                return match ? match[0] : '';
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

    /**
     * Search & Edit Goods and Service Entries:
     *   Organization Name (must come first: Vendor Name has no options until it is chosen)
     *   > Vendor Name > GRN/SRN Number (optional: only when the screen has it and lists the number) > Search
     */
    async searchEntry({ organization, vendor, entryId }) {
        // form fields only: the results table also has columns with these names
        const org = await this.grn.control(GRN_LABELS.organizationName);
        await this.grn.chooseOption(org, organization, 'Organization Name');
        await this.page.waitForTimeout(1500); // vendor list loads for the organization

        const vendorField = await this.grn.control(GRN_LABELS.vendorName);
        await this.grn.chooseOption(vendorField, vendor, 'Vendor Name');
        await this.page.waitForTimeout(1000);

        if (entryId) {
            const numberField = await this.grn.control(GRN_LABELS.entryNumber, { timeout: 3000 }).catch(() => null);
            if (!numberField) {
                console.log('No GRN/SRN Number filter on the search screen; searching by organization and vendor.');
            } else {
                await this.grn
                    .chooseOption(numberField, normaliseEntryId(entryId), 'GRN/SRN Number')
                    .catch(error => {
                        console.warn(`GRN/SRN Number filter not used (${error.message.split('.')[0].slice(0, 120)}); searching by organization and vendor.`);
                        return this.page.keyboard.press('Escape').catch(() => { });
                    });
            }
        }

        const result = await this.search();
        expect(result.found, `"No data found" for ${JSON.stringify({ organization, vendor, entryId })}`).toBeTruthy();
        return result;
    }

    /** Older name, kept for specs that still call it. */
    async searchVendor(vendorTokens, organization = 'Data Pvt Ltd') {
        return this.searchEntry({ organization, vendor: vendorTokens });
    }

    /**
     * Which result to open:
     *   1. the entry number, when it is in the results (the final number read after Activate);
     *   2. otherwise among rows with our invoice reference: final numbers only (draft numbers
     *      contain "$"), status Active preferred, the HIGHEST number (= the newest entry).
     */
    async pickResult(result, { entryId, invoiceNo, invoiceDate }) {
        const { headers, rows } = await this.resultsTable().evaluate(t => {
            const clean = s => (s || '').replace(/\s+/g, ' ').trim();
            return {
                headers: [...t.querySelectorAll('th, [role="columnheader"]')].map(h => clean(h.textContent)),
                rows: [...t.querySelectorAll('tbody tr, [role="row"]')]
                    .filter(r => r.querySelector('td, [role="gridcell"]'))
                    .map(r => [...r.querySelectorAll('td, [role="gridcell"]')].map(c => clean(c.textContent))),
            };
        });
        return GrnSearchPage.chooseResult(headers, rows, { entryId, invoiceNo, invoiceDate });
    }

    static chooseResult(headers, rows, { entryId, invoiceNo, invoiceDate }) {
        const col = re => headers.findIndex(h => re.test(h));
        const numberCol = Math.max(col(/grn|srn|entry\s*(id|no|number)/i), 0);
        const invoiceCol = col(/invoice\s*ref/i);
        const dateCol = col(/invoice\s*date/i);
        const statusCol = col(/^\s*status\s*$/i);
        const wanted = normaliseEntryId(entryId);

        const exact = wanted && rows.find(r => normaliseEntryId(r[numberCol]) === wanted);
        if (exact) {
            console.log(`Opening ${exact[numberCol]}${statusCol >= 0 ? ` (${exact[statusCol]})` : ''} - the entry created by this run (${entryId}).`);
            return exact[numberCol];
        }

        // fallback: rows of THIS invoice (reference + invoice date), newest number
        let pool = rows;
        if (invoiceCol >= 0 && invoiceNo) pool = pool.filter(r => r[invoiceCol] === invoiceNo);
        if (dateCol >= 0 && invoiceDate) {
            const sameDate = pool.filter(r => valuesMatch(formatDate(invoiceDate, 'DD-MM-YYYY'), r[dateCol]));
            if (sameDate.length) pool = sameDate;
        }
        if (!pool.length) throw new Error(`No search result for invoice ${invoiceNo} (${invoiceDate}). Entry ${entryId} not in the results either.`);

        const row = [...pool].sort((a, b) => normaliseEntryId(a[numberCol]).localeCompare(normaliseEntryId(b[numberCol]), undefined, { numeric: true })).at(-1);
        console.log(
            `Opening ${row[numberCol]}${statusCol >= 0 ? ` (${row[statusCol]})` : ''} - ${entryId || 'entry number'} not in the results; ` +
            `newest entry for invoice ${invoiceNo} dated ${invoiceDate} (${pool.length} of ${rows.length} rows).`
        );
        return row[numberCol];
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
            Sender: 'sender', 'Document Type': 'sender', 'Accounting Date': 'sender', 'Invoice Reference': 'sender', 'Invoice Date': 'sender', 'Order Type': 'sender',
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
                actual = label === 'Order Number' ? await this.grn.readOrderNumber() : await this.grn.readField(regex);
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
