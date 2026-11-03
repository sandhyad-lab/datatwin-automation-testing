import { test } from '@playwright/test';

import { LoginPage } from '../pages/LoginPage.js';
import { SelectOrganizationDialog } from '../pages/SelectOrganizationDialog.js';
import { DTFOWSPage } from '../pages/DTFOWSPage.js';
import { TransactPage } from '../pages/TransactPage.js';
import { InternalPlanSearchPage } from '../pages/InternalPlanSearchPage.js';
import { INTERNAL_PLAN_FILE } from '../pages/InternalPlanData.js';

/**
 * Search & Edit Internal Plan: finds the uploaded Internal Plan, opens it and
 * compares its details with the Excel that was uploaded.
 * (internalPlanUpload.spec.js runs the same steps right after uploading.)
 *
 * filters are set in this order; leave a value empty ('') to skip that filter.
 * "last" / "first" pick the last / first option of that dropdown.
 */
const SEARCH = {
    filters: {
        organizationName: 'Data Pvt Ltd',
        ipNumber: 'last', // the newest IP is normally at the end of the list
        vendorName: '',
        vendorId: '',
        status: '',
    },
    // the Excel to compare with (same file as the upload; INTERNAL_PLAN_FILE in .env overrides it)
    excelFile: INTERNAL_PLAN_FILE,
    // true: an Excel column that is not shown on the detail page also fails the test
    failOnNotFound: false,
};

test.describe('Internal Plan - Search & Edit', () => {
    test.describe.configure({ mode: 'serial' });

    let context;
    let page;
    let search;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(180_000);

        const { DATATWIN_EMAIL, DATATWIN_PASSWORD, DATATWIN_STAGE_URL, DATATWIN_ORGANIZATION } = process.env;
        if (!DATATWIN_EMAIL || !DATATWIN_PASSWORD) {
            throw new Error('DATATWIN_EMAIL / DATATWIN_PASSWORD are not set in .env');
        }

        context = await browser.newContext({ baseURL: DATATWIN_STAGE_URL || 'https://stage.datatwin.ai' });
        page = await context.newPage();

        const login = new LoginPage(page);
        const orgDialog = new SelectOrganizationDialog(page);
        const dtfows = new DTFOWSPage(page);
        search = new InternalPlanSearchPage(page);

        const organizationName = DATATWIN_ORGANIZATION || 'Vendor Management System';

        // same login steps as the other specs
        await login.navigateToLoginPage();
        await login.login(DATATWIN_EMAIL, DATATWIN_PASSWORD);
        await login.clickAdminAccess(orgDialog.option(organizationName).or(dtfows.dtfowsCard).first());
        await orgDialog.selectIfShown(organizationName, dtfows.dtfowsCard);
        await dtfows.openDTFOWS();
        await dtfows.verifyDashboard();
    });

    test.afterAll(async () => {
        await context?.close();
    });

    test('open Transact > Internal Plan > Search & Edit Internal Plan', async () => {
        const transact = new TransactPage(page);
        await transact.openTransact();
        await transact.selectTask('Internal Plan');
        await transact.selectTypeOfScreen('Search & Edit Internal Plan');
        await search.verifyScreen();
    });

    let selectedIp;

    test('Data Pvt Ltd + last IP Number: search shows results', async () => {
        const result = await search.searchAndVerify(SEARCH.filters);
        selectedIp = result.selected.ipNumber;
    });

    test('open the IP and validate its details against the Excel', async () => {
        test.setTimeout(180_000);
        await search.openIpAndValidate(selectedIp, SEARCH.excelFile, test.info(), {
            failOnNotFound: SEARCH.failOnNotFound,
        });
    });
});
