import { expect } from '@playwright/test';

export class TransactPage {
    constructor(page) {
        this.page = page;

        this.transactMenu = page.getByRole('button', {
            name: 'Transact',
            exact: true
        });

        this.taskDropdown = page.locator(
            'input[name="What_you_want_to_do"]'
        );

        this.typeOfScreenDropdown = page.locator(
            'input[name="Type_of_Screen"]'
        );
    }

    async openTransact() {
        await expect(this.transactMenu).toBeVisible();
        await this.transactMenu.click();
    }

    async selectTask(taskName) {
        await expect(this.taskDropdown).toBeVisible();

        await this.taskDropdown.click();

        await this.page.getByRole('option', {
            name: taskName,
            exact: true
        }).click();
    }

    async selectTypeOfScreen(screenName) {
        await expect(this.typeOfScreenDropdown).toBeVisible();

        await this.typeOfScreenDropdown.click();

        await this.page.getByRole('option', {
            name: screenName,
            exact: true
        }).click();

        await this.page.waitForTimeout(3000);
    }
}