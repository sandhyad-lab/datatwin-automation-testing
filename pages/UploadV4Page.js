import fs from 'fs';
import path from 'path';
import { expect } from '@playwright/test';

/**
 * Field labels on the Upload V4 screen. A string is matched as the whole label
 * (case, spaces and a trailing * ignored); a RegExp allows several wordings.
 * Change them here if the screen words them differently.
 */
export const UPLOAD_V4_FIELDS = {
    company: 'Company',
    transactionType: 'Transaction Type',
    // "Theme", "Theme Name", "Select Theme", "Theme Name *" ...
    theme: /^\s*(select\s*)?theme(\s*name)?\s*\*?\s*$/i,
};

export class UploadV4Page {
    constructor(page) {
        this.page = page;
    }

    // ---------- helpers ----------

    escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /** Whole-text match ignoring case, spacing and a trailing * ("Upload V4" also matches "UploadV4"). */
    exactPattern(text) {
        const chars = [...text.replace(/\s+/g, '')]
            .map(c => this.escapeRegExp(c))
            .join('\\s*');
        return new RegExp(`^\\s*${chars}\\s*\\*?\\s*$`, 'i');
    }

    /** How long a slow upload may take. Override with DATATWIN_UPLOAD_TIMEOUT_MS in .env. */
    get uploadTimeout() {
        return Number(process.env.DATATWIN_UPLOAD_TIMEOUT_MS) || 180_000;
    }

    /** Text of every visible toast / alert / dialog whose text matches `regex`. */
    async visibleMessages(regex) {
        const popups = this.page
            .locator(
                '[role="alert"], [role="dialog"], [class*="toast" i], [class*="snack" i], ' +
                '[class*="notification" i], .MuiAlert-message'
            )
            .filter({ hasText: regex });

        const out = [];
        const count = await popups.count();
        for (let i = 0; i < count; i++) {
            const el = popups.nth(i);
            if (await el.isVisible().catch(() => false)) {
                out.push((await el.innerText().catch(() => '')).replace(/\s*\n\s*/g, ' ').trim());
            }
        }
        return [...new Set(out.filter(Boolean))];
    }

    // ---------- navigation ----------

    /** Sidebar item, matched by its whole text, skipping anything that is not visible. */
    sidebarItem(text) {
        return this.page.getByText(this.exactPattern(text)).locator('visible=true').first();
    }

    /** Expands "AP" in the left sidebar (it has a sub-menu). */
    async openAP() {
        const ap = this.sidebarItem('AP');
        const uploadV4 = this.sidebarItem('Upload V4');

        await expect(ap, '"AP" not found in the sidebar').toBeVisible({ timeout: 30_000 });

        if (await uploadV4.isVisible().catch(() => false)) return; // already expanded

        await ap.click();

        // a second click if the first one collapsed an already-open menu
        const shown = await uploadV4.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
        if (!shown) {
            await ap.click();
            await expect(uploadV4, '"Upload V4" did not appear under AP').toBeVisible({ timeout: 10_000 });
        }
    }

    /** Clicks AP > Upload V4 and waits for the screen to load. */
    async openUploadV4() {
        await this.openAP();
        await this.sidebarItem('Upload V4').click();

        await expect(
            this.label(UPLOAD_V4_FIELDS.company),
            `Upload V4 screen did not load (no "${UPLOAD_V4_FIELDS.company}" field)`
        ).toBeVisible({ timeout: 60_000 });
    }

    // ---------- fields ----------

    /** RegExp for a field: used as is, or built from the label text. */
    fieldPattern(field) {
        return field instanceof RegExp ? field : this.exactPattern(field);
    }

    /** Readable field name for log / error messages. */
    fieldName(field) {
        return field instanceof RegExp ? field.source : field;
    }

    /** The visible label of a field (outside the sidebar). */
    label(field) {
        return this.page
            .getByText(this.fieldPattern(field))
            .locator('visible=true')
            .filter({ hasNot: this.page.locator('nav, aside') })
            .last();
    }

    /**
     * The input / dropdown of a field. Tries, in order: accessible label, placeholder,
     * combobox name, visible label text. Keeps trying for up to 20s because some
     * dropdowns (Theme) only appear after the previous one is selected.
     */
    async control(field, { timeout = 20_000 } = {}) {
        const pattern = this.fieldPattern(field);
        const inputs = 'input:not([type="hidden"]):not([type="file"]), [role="combobox"], select';

        const candidates = [
            () => this.page.getByLabel(pattern),
            () => this.page.getByPlaceholder(pattern),
            () => this.page.getByRole('combobox', { name: pattern }),
            () =>
                this.label(field)
                    .locator(`xpath=ancestor::*[.//input[not(@type="hidden") and not(@type="file")] or .//*[@role="combobox"] or .//select][1]`)
                    .locator(inputs),
        ];

        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            for (const make of candidates) {
                const control = make().locator('visible=true').first();
                if (await control.count().catch(() => 0)) return control;
            }
            await this.page.waitForTimeout(500);
        }

        // not found: list the labels / placeholders that ARE on the screen
        const seen = await this.page
            .evaluate(() => {
                const out = new Set();
                document.querySelectorAll('label, .MuiInputLabel-root, .MuiFormLabel-root').forEach(el => {
                    if (el.offsetParent && el.innerText.trim()) out.add(el.innerText.trim());
                });
                document.querySelectorAll('input[placeholder]').forEach(el => {
                    if (el.offsetParent && el.placeholder.trim()) out.add(`placeholder: ${el.placeholder.trim()}`);
                });
                return [...out].slice(0, 30);
            })
            .catch(() => []);

        throw new Error(
            `Field "${this.fieldName(field)}" not found on the screen. ` +
            `Labels / placeholders shown: ${JSON.stringify(seen)}. ` +
            'Put the right label in UPLOAD_V4_FIELDS.'
        );
    }

    // ---------- dropdowns (click to open, click the option; never types) ----------

    /** Options of the dropdown that is currently open. */
    openOptions() {
        return this.page
            .locator('[role="option"], [role="listbox"] li, .MuiMenu-list li, .MuiAutocomplete-option')
            .locator('visible=true');
    }

    /**
     * Comparable form of an option text: lower case, "private" -> "pvt", "limited" -> "ltd",
     * and no spaces / dots / punctuation. So "Data Pvt. Ltd", "Data Private Limited" and
     * "data pvt ltd" are equal, and "Internal Plan" equals "InternalPlan".
     */
    normaliseOption(text) {
        return (text || '')
            .toLowerCase()
            .replace(/\bprivate\b/g, 'pvt')
            .replace(/\blimited\b/g, 'ltd')
            .replace(/[^a-z0-9]/g, '');
    }

    /** Texts of the options currently shown in the open dropdown. */
    async visibleOptions() {
        const texts = await this.openOptions().allInnerTexts().catch(() => []);
        return [...new Set(texts.map(t => t.trim()).filter(Boolean))];
    }

    /** Clicks the dropdown of `field` (or its arrow) until the option list is open. */
    async openDropdown(field) {
        const control = await this.control(field);
        await control.scrollIntoViewIfNeeded().catch(() => { });

        // close any dropdown that is still open from the previous field
        if (await this.openOptions().first().isVisible().catch(() => false)) {
            await this.page.keyboard.press('Escape').catch(() => { });
            await this.page.waitForTimeout(300);
        }

        await control.click();
        const opened = await this.openOptions().first()
            .waitFor({ state: 'visible', timeout: 5000 })
            .then(() => true)
            .catch(() => false);
        if (opened) return control;

        // some dropdowns open only from the arrow icon next to the field
        const arrow = control
            .locator('xpath=ancestor::*[contains(@class,"MuiAutocomplete-root") or contains(@class,"MuiFormControl-root") or contains(@class,"MuiInputBase-root")][1]')
            .locator('.MuiAutocomplete-popupIndicator, [aria-label="Open"], [data-testid="ArrowDropDownIcon"], [data-testid="KeyboardArrowDownIcon"], svg')
            .first();
        if (await arrow.isVisible().catch(() => false)) {
            await arrow.click();
        } else {
            await control.click({ force: true });
        }

        await expect(
            this.openOptions().first(),
            `Clicking the "${this.fieldName(field)}" dropdown did not open its option list`
        ).toBeVisible({ timeout: 10_000 });

        return control;
    }

    /**
     * Click the "field" dropdown, then click the option equal to `value`
     * (compared with normaliseOption). Scrolls down long lists until the option shows up.
     * Nothing is typed into the field.
     */
    async select(field, value) {
        const control = await this.openDropdown(field);
        const wanted = this.normaliseOption(value);
        const seen = new Set();

        let match = null;
        for (let round = 0; round < 30 && !match; round++) {
            const options = this.openOptions();
            const count = await options.count();

            for (let i = 0; i < count; i++) {
                const text = (await options.nth(i).innerText().catch(() => '')).trim();
                if (!text) continue;
                seen.add(text);
                if (this.normaliseOption(text) === wanted) {
                    match = { locator: options.nth(i), text };
                    break;
                }
            }
            if (match || !count) break;

            // not in the visible part: scroll the last option into view to load more
            const sizeBefore = seen.size;
            await options.nth(count - 1).scrollIntoViewIfNeeded().catch(() => { });
            await this.page.waitForTimeout(300);
            const texts = await this.visibleOptions();
            texts.forEach(t => seen.add(t));
            if (seen.size === sizeBefore) break; // end of the list
        }

        if (!match) {
            await this.page.keyboard.press('Escape').catch(() => { });
            throw new Error(
                `"${this.fieldName(field)}": no option matching "${value}". Options in the list: ${JSON.stringify([...seen])}`
            );
        }

        await match.locator.scrollIntoViewIfNeeded().catch(() => { });
        await match.locator.click();
        await this.page.waitForTimeout(500);

        await this.expectFieldShows(field, control, match.text);
        console.log(`Selected ${this.fieldName(field)}: ${match.text}`);
        return match.text;
    }

    /** Click the "field" dropdown and pick the first real option in the list. */
    async selectFirst(field) {
        const control = await this.openDropdown(field);
        const options = this.openOptions();
        const count = await options.count();

        // skip empty / placeholder entries such as "Select", "None", "--"
        const placeholder = /^\s*(select.*|none|--+|no options|loading.*)?\s*$/i;
        for (let i = 0; i < count; i++) {
            const text = (await options.nth(i).innerText().catch(() => '')).trim();
            const disabled = (await options.nth(i).getAttribute('aria-disabled').catch(() => null)) === 'true';
            if (disabled || placeholder.test(text)) continue;

            await options.nth(i).click();
            await this.page.waitForTimeout(500);
            await this.expectFieldShows(field, control, text);
            console.log(`Selected ${this.fieldName(field)}: ${text} (first option)`);
            return text;
        }

        const seen = await this.visibleOptions();
        await this.page.keyboard.press('Escape').catch(() => { });
        throw new Error(`"${this.fieldName(field)}": the list has no selectable option. Shown: ${JSON.stringify(seen)}`);
    }

    /** After selecting, the field must show the chosen option. */
    async expectFieldShows(field, control, text) {
        const shown = await control
            .evaluate(el => {
                if ('value' in el && el.value) return el.value;
                const wrapper = el.closest('.MuiFormControl-root, .MuiInputBase-root, .MuiAutocomplete-root') || el.parentElement;
                return (wrapper?.innerText || el.textContent || '').trim();
            })
            .catch(() => '');

        expect(
            this.normaliseOption(shown).includes(this.normaliseOption(text)),
            `"${this.fieldName(field)}" should show "${text}" after selecting it, but shows "${shown}"`
        ).toBeTruthy();
    }

    /** Value currently shown by a field (input value, or the selected text of a custom select). */
    async readValue(field) {
        const control = await this.control(field);
        return (
            await control.evaluate(el => {
                if ('value' in el && el.value) return el.value;
                const wrapper = el.closest('.MuiFormControl-root, .MuiInputBase-root') || el.parentElement;
                return (wrapper?.innerText || el.textContent || '').trim();
            })
        ).trim();
    }

    // ---------- upload ----------

    uploadFileButton() {
        return this.page
            .getByRole('button', { name: /^\s*upload\s*file\s*$/i })
            .or(this.page.getByText(/^\s*Upload\s*File\s*$/i))
            .locator('visible=true')
            .first();
    }

    /**
     * Uploads the file:
     *  - if "Upload File" opens the file picker, the file is given to the picker;
     *  - if the page has a file input instead, the file is set there and "Upload File" is clicked to send it.
     * Then waits for a success or error message (uploads can be slow).
     */
    async uploadFile(filePath) {
        const absolute = path.resolve(filePath);
        if (!fs.existsSync(absolute)) {
            throw new Error(
                `Upload file not found: ${absolute}. Put the file there or set INTERNAL_PLAN_FILE in .env.`
            );
        }

        const button = this.uploadFileButton();
        await expect(button, '"Upload File" button not found').toBeVisible({ timeout: 15_000 });
        await expect(button, '"Upload File" button is disabled (check Company / Transaction Type / Theme)').toBeEnabled({ timeout: 15_000 });

        // record the requests the upload sends, to report server errors
        const calls = [];
        const pending = [];
        const onResponse = response => {
            const request = response.request();
            if (!['POST', 'PUT', 'PATCH'].includes(request.method())) return;
            if (!['xhr', 'fetch'].includes(request.resourceType())) return;
            pending.push(
                response.text().catch(() => '').then(body => {
                    const text = (body || '').replace(/\s+/g, ' ');
                    calls.push({
                        url: response.url().split('?')[0],
                        status: response.status(),
                        failed:
                            response.status() >= 400 ||
                            /"(success|isSuccess|status)"\s*:\s*(false|"(error|fail|failed)")/i.test(text),
                        body: text.slice(0, 200),
                    });
                })
            );
        };
        this.page.on('response', onResponse);

        try {
            const fileInputs = this.page.locator('input[type="file"]');

            // 1. "Upload File" opens the file picker
            const chooserPromise = this.page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
            await button.click();
            const chooser = await chooserPromise;

            if (chooser) {
                await chooser.setFiles(absolute);
                console.log(`File picked: ${path.basename(absolute)}`);

                // some screens need a second click (Upload / Submit) after picking the file
                const submit = this.page
                    .getByRole('button', { name: /^\s*(upload|submit|import|process|save)\s*$/i })
                    .locator('visible=true')
                    .first();
                if (await submit.isEnabled({ timeout: 2000 }).catch(() => false)) {
                    await submit.click();
                    console.log('Clicked the submit button after picking the file.');
                }
            } else if (await fileInputs.count()) {
                // 2. file input on the page: set the file, then "Upload File" sends it
                await fileInputs.first().setInputFiles(absolute);
                console.log(`File attached: ${path.basename(absolute)}`);
                await this.page.waitForTimeout(500);
                if (await button.isEnabled().catch(() => false)) {
                    await button.click();
                }
            } else {
                throw new Error(
                    'Clicking "Upload File" did not open a file picker and the page has no file input. ' +
                    'Inspect the upload area in DevTools.'
                );
            }

            await this.waitForUploadResult(calls, pending);
        } finally {
            this.page.off('response', onResponse);
        }
    }

    /** Waits for a success / error message; fails on an error message or a rejected request. */
    async waitForUploadResult(calls, pending) {
        const timeout = this.uploadTimeout;
        const started = Date.now();
        const secs = () => Math.round((Date.now() - started) / 1000);

        const errorRe = /error|failed|invalid|mandatory|required|not allowed|cannot|mismatch|duplicate/i;
        const successRe = /success|uploaded|completed|processed|imported/i;

        while (Date.now() - started < timeout) {
            const errors = await this.visibleMessages(errorRe);
            if (errors.length) {
                throw new Error(`Upload was rejected after ${secs()}s: ${JSON.stringify(errors)}`);
            }

            await Promise.all(pending);
            const failed = calls.filter(c => c.failed);
            if (failed.length) {
                throw new Error(
                    `Upload request failed after ${secs()}s:\n  ` +
                    failed.map(c => `${c.url} -> ${c.status} ${c.body}`).join('\n  ')
                );
            }

            const success = await this.visibleMessages(successRe);
            if (success.length) {
                console.log(`Upload finished after ${secs()}s: ${success.join(' | ')}`);
                return;
            }

            await this.page.waitForTimeout(1000);
        }

        throw new Error(
            `No success or error message within ${timeout / 1000}s after uploading. ` +
            `Requests sent: ${calls.length ? calls.map(c => `${c.url} -> ${c.status}`).join(', ') : 'none'}. ` +
            'Raise DATATWIN_UPLOAD_TIMEOUT_MS in .env if it is just slow.'
        );
    }
}
