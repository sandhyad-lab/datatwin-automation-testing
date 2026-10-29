import { test } from '@playwright/test';

import { LoginPage } from '../pages/LoginPage.js';
import { SelectOrganizationDialog } from '../pages/SelectOrganizationDialog.js';
import { DTFOWSPage } from '../pages/DTFOWSPage.js';
import { TransactPage } from '../pages/TransactPage.js';
import { OrganizationPage, TABS } from '../pages/OrganizationPage.js';

// Optional: full edit URL of a DRAFT / editable record that already has data, e.g.
// https://preprod.datatwin.ai/Dynamic_Forms?token=OrganizationMaster&action=edit&orgId=...&docId=...
// Needed for the prefilled checks on tabs that have no `values`.
// The "Create" screen is blank, so tabs with `values` are filled by the "fill values" test instead.
const EDIT_URL = process.env.DATATWIN_ORG_EDIT_URL;

test.describe('Organization Master Workflow', () => {
    // One shared page and each test mutates state, so run in order and stop cascading mess.
    test.describe.configure({ mode: 'serial' });

    let context;
    let page;
    let org;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(180_000);

        const {
            DATATWIN_EMAIL,
            DATATWIN_PASSWORD,
            DATATWIN_STAGE_URL,
            DATATWIN_ORGANIZATION,
        } = process.env;

        if (!DATATWIN_EMAIL || !DATATWIN_PASSWORD) {
            throw new Error('DATATWIN_EMAIL / DATATWIN_PASSWORD are not set in .env');
        }

        context = await browser.newContext({
            baseURL: DATATWIN_STAGE_URL || 'https://stage.datatwin.ai',
        });

        page = await context.newPage();

        const login = new LoginPage(page);
        const orgDialog = new SelectOrganizationDialog(page);
        const dtfows = new DTFOWSPage(page);
        const transact = new TransactPage(page);

        org = new OrganizationPage(page);

        const organizationName = DATATWIN_ORGANIZATION || 'Vendor Management System';

        await login.navigateToLoginPage();
        await login.login(DATATWIN_EMAIL, DATATWIN_PASSWORD);

        await login.clickAdminAccess(
            orgDialog.option(organizationName).or(dtfows.dtfowsCard).first()
        );

        await orgDialog.selectIfShown(organizationName, dtfows.dtfowsCard);

        await dtfows.openDTFOWS();
        await dtfows.verifyDashboard();

        if (EDIT_URL) {
            await page.goto(EDIT_URL);
        } else {
            await transact.openTransact();
            await transact.selectTask('Organization Master');
            await transact.selectTypeOfScreen('Create Organization Master');
        }

        await org.openOrganization();
    });

    test.afterAll(async () => {
        await context?.close();
    });

    for (const key of Object.keys(TABS)) {
        const tab = TABS[key];
        const hasValues = Object.keys(tab.values).length > 0;

        if (hasValues) {
            test(`fill values: ${tab.name}`, async () => {
                test.skip(
                    !!EDIT_URL,
                    'EDIT_URL points to an existing record; filling is only for Create / Draft'
                );

                await org.openTab(key);
                await org.fillTab(key);
            });
        }

        test(`validate ${tab.name} fields and asterisks`, async () => {
            await org.openTab(key);
            await org.validateTab(key);
            await org.validateAsterisks(key);
        });

        test(`prefilled mandatory values: ${tab.name}`, async () => {
            test.skip(
                !EDIT_URL && !hasValues,
                'No data on this tab: set DATATWIN_ORG_EDIT_URL or add values'
            );

            await org.openTab(key);
            await org.validatePrefilled(key);
        });

    }
});