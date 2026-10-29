import { expect } from '@playwright/test';

export class DTFOWSPage {
    constructor(page) {
        this.page = page;
        this.dtfowsCard = page.getByText('DTFOWS').first();
        this.dashboard = page.getByText('Dashboard', { exact: true }).first();
    }

    async openDTFOWS() {
        await expect(this.dtfowsCard).toBeVisible();
        await this.dtfowsCard.click();
    }

    async verifyDashboard() {
        await this.page.waitForURL('**/dashboard', { timeout: 30_000 });
        await expect(this.dashboard).toBeVisible();
    }
}