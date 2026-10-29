import { expect } from '@playwright/test';

export class SelectOrganizationDialog {
    constructor(page) {
        this.page = page;
    }

    option(name) {
        // No dependency on role="dialog" or its accessible name
        return this.page.getByAltText(name).filter({ visible: true }).first();
    }

    // Clicks the organization if the picker shows up; does nothing if it doesn't.
    // `nextScreen` is a locator for what appears when there is no picker (e.g. the DTFOWS card).
    async selectIfShown(name, nextScreen) {
        const option = this.option(name);
        await expect(option.or(nextScreen).first()).toBeVisible();

        if (await option.isVisible()) {
            await option.click();
        }
    }
}