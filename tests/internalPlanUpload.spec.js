import { test } from '@playwright/test';

import { LoginPage } from '../pages/LoginPage.js';
import { SelectOrganizationDialog } from '../pages/SelectOrganizationDialog.js';
import { DTFOWSPage } from '../pages/DTFOWSPage.js';
import { UploadV4Page, UPLOAD_V4_FIELDS } from '../pages/UploadV4Page.js';
import { TransactPage } from '../pages/TransactPage.js';
import { InternalPlanSearchPage } from '../pages/InternalPlanSearchPage.js';
import { INTERNAL_PLAN_FILE } from '../pages/InternalPlanData.js';

/**
 * Internal Plan upload: AP > Upload V4 > pick Company, Transaction Type, Theme > Upload File.
 * Each dropdown is clicked open and the option is clicked in the list (nothing is typed).
 * Matching ignores case, spaces and dots, and treats Pvt = Private, Ltd = Limited,
 * so "Data Pvt Ltd" matches "Data Pvt. Ltd" / "Data Private Limited".
 * If no option matches, the error lists every option in the dropdown.
 */
const INTERNAL_PLAN = {
    company: 'Data Pvt Ltd',
    transactionType: 'InternalPlan',
    // Theme: the first option in the list is selected
    // The file to upload AND to validate against: set in pages/InternalPlanData.js
    // (test-data/TRBH00027_1_1.xlsx) or with INTERNAL_PLAN_FILE in .env.
    file: INTERNAL_PLAN_FILE,
    // true: an Excel column that is not shown on the detail page also fails the test
    failOnNotFound: false,
};

const UPLOAD_TEST_TIMEOUT = (Number(process.env.DATATWIN_UPLOAD_TIMEOUT_MS) || 180_000) + 120_000;

test.describe('AP Upload V4 - Internal Plan', () => {
    // one shared page; each step depends on the previous one
    test.describe.configure({ mode: 'serial' });

    let context;
    let page;
    let upload;

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
        upload = new UploadV4Page(page);

        const organizationName = DATATWIN_ORGANIZATION || 'Vendor Management System';

        // same login steps as the Organization Master spec
        await login.navigateToLoginPage();
        await login.login(DATATWIN_EMAIL, DATATWIN_PASSWORD);
        await login.clickAdminAccess(
            orgDialog.option(organizationName).or(dtfows.dtfowsCard).first()
        );
        await orgDialog.selectIfShown(organizationName, dtfows.dtfowsCard);
        await dtfows.openDTFOWS();
        await dtfows.verifyDashboard();
    });

    test.afterAll(async () => {
        await context?.close();
    });

    test('open AP > Upload V4', async () => {
        await upload.openUploadV4();
    });

    test('select company, transaction type and theme', async () => {
        await upload.select(UPLOAD_V4_FIELDS.company, INTERNAL_PLAN.company);
        await upload.select(UPLOAD_V4_FIELDS.transactionType, INTERNAL_PLAN.transactionType);
        await upload.selectFirst(UPLOAD_V4_FIELDS.theme);
    });

    test('upload internal plan file', async () => {
        test.setTimeout(UPLOAD_TEST_TIMEOUT);
        await upload.uploadFile(INTERNAL_PLAN.file);
    });

    // ---------- after the upload: find it in Search & Edit Internal Plan ----------

    test('open Transact > Internal Plan > Search & Edit Internal Plan', async () => {
        const transact = new TransactPage(page);
        await transact.openTransact();
        await transact.selectTask('Internal Plan');
        await transact.selectTypeOfScreen('Search & Edit Internal Plan');
        await new InternalPlanSearchPage(page).verifyScreen();
    });

    let selectedIp;

    test('search: Data Pvt Ltd + last IP Number shows results', async () => {
        const search = new InternalPlanSearchPage(page);
        const result = await search.searchAndVerify({
            organizationName: INTERNAL_PLAN.company,
            ipNumber: 'last', // the newest IP (from this upload) is normally at the end of the list
        });
        selectedIp = result.selected.ipNumber;
    });

    test('open the IP and validate its details against the Excel', async () => {
        test.setTimeout(180_000);
        const search = new InternalPlanSearchPage(page);
        await search.openIpAndValidate(selectedIp, INTERNAL_PLAN.file, test.info(), {
            failOnNotFound: INTERNAL_PLAN.failOnNotFound,
        });
    });
});
