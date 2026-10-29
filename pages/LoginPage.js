import { expect } from '@playwright/test';

export class LoginPage {
    constructor(page) {
        this.page = page;
        this.emailInput = page.locator('#email');
        this.passwordInput = page.locator('#password');
        this.signInButton = page.getByRole('button', { name: 'Sign In', exact: true });
        this.adminAccessButton = page.getByRole('button', { name: 'Admin Access', exact: true });
    }

    async navigateToLoginPage() {
        await this.page.goto('/');
    }

    async login(email, password) {
        await this.emailInput.fill(email);
        await this.passwordInput.fill(password);
        await expect(this.signInButton).toBeEnabled();
        await this.signInButton.click();
        try {
            await expect(this.adminAccessButton).toBeVisible({ timeout: 5000 });
        } catch {
            if (await this.signInButton.isVisible()) {
                await this.signInButton.click();
            }
        }
    }

    // nextScreen = a locator that only exists AFTER Admin Access succeeds
    // (the org picker image or the DTFOWS card)
    async clickAdminAccess(nextScreen) {
        await expect(this.adminAccessButton).toBeVisible({ timeout: 90_000 });

        await expect(async () => {
            await this.adminAccessButton.click();
            await expect(nextScreen).toBeVisible({ timeout: 15_000 });
        }).toPass({ timeout: 90_000 });
    }
}
