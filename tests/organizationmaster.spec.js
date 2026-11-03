import { test } from '@playwright/test';

import { LoginPage } from '../pages/LoginPage.js';
import { SelectOrganizationDialog } from '../pages/SelectOrganizationDialog.js';
import { DTFOWSPage } from '../pages/DTFOWSPage.js';
import { TransactPage } from '../pages/TransactPage.js';
import { OrganizationPage, TABS } from '../pages/OrganizationPage.js';
import { OrganizationSearchPage } from '../pages/OrganizationSearchPage.js';

// "Type of Screen" option used to find the saved organization again.
// Change it here if the dropdown words it differently.
const ORG_SEARCH_SCREEN = 'Search & Edit Organization Master';

// Optional: full edit URL of a DRAFT / editable record that already has data, e.g.
// https://preprod.datatwin.ai/Dynamic_Forms?token=OrganizationMaster&action=edit&orgId=...&docId=...
// Needed for the prefilled checks on tabs that have no `values`.
// The "Create" screen is blank, so tabs with `values` are filled by the "fill values" test instead.
const EDIT_URL = process.env.DATATWIN_ORG_EDIT_URL;

// Validate & Save waits 1 minute per attempt (DATATWIN_VALIDATE_TIMEOUT_MS) and is retried
// once on a 502/503/504 (DATATWIN_VALIDATE_RETRIES). Activate waits up to 3 minutes
// (DATATWIN_ACTIVATE_TIMEOUT_MS). Each test gets extra time on top for the clicks around it.
const VALIDATE_MS = Number(process.env.DATATWIN_VALIDATE_TIMEOUT_MS) || 60_000;
const VALIDATE_RETRIES = Number.isFinite(Number(process.env.DATATWIN_VALIDATE_RETRIES))
    ? Number(process.env.DATATWIN_VALIDATE_RETRIES)
    : 1;
const VALIDATE_TEST_TIMEOUT = VALIDATE_MS * (VALIDATE_RETRIES + 1) + 90_000;
const ACTIVATE_TEST_TIMEOUT = (Number(process.env.DATATWIN_ACTIVATE_TIMEOUT_MS) || 180_000) + 120_000;

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

    // ---------- per-tab tests (titles include the tab name, so they are unique) ----------
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

    // ---------- record-level tests: run ONCE, after every tab is filled ----------
    // (These were inside the loop before, which registered each title 9 times
    //  and caused Playwright's "duplicate test title" error.)

    // Values can look filled but be lost when the tab changes. Re-open every tab
    // right before saving and confirm the mandatory values (and uploads) are still there.
    test('all mandatory values still present before save', async () => {
        test.skip(!!EDIT_URL, 'Only needed for new records');

        for (const key of Object.keys(TABS)) {
            if (!Object.keys(TABS[key].values).length) continue;
            await org.openTab(key);
            await org.validatePrefilled(key);
        }
    });

    // 1. Validate & Save: waits for the server (1 min), retries once on 502/503/504,
    //    and fails with the reason (request still running, server error, or nothing sent).
    // ID of the organization this run created (read after Validate & Save, used by the search below)
    let createdOrgId = '';

    test('validate and save organization record', async () => {
        test.skip(!!EDIT_URL, 'Validate is for new records');
        test.setTimeout(VALIDATE_TEST_TIMEOUT);
        await org.validateOrganization('Validate & Save');

        createdOrgId = await org.readOrganizationId();
        console.log(createdOrgId ? `Created Organization ID: ${createdOrgId}` : 'Organization ID not shown on the page yet.');
    });

    // 2. The Approvals bar under the form must show Approve (checked only, not clicked).
    test('approvals bar shows Approve', async () => {
        test.skip(!!EDIT_URL, 'Approval is for new records');
        test.setTimeout(120_000);
        await org.checkApproveShown();
    });

    // 3. Activate (next to Validate) -> "Activate & Approve" from its menu
    //    (falls back to "Activate" if that is the only option).
    test('activate and approve organization', async () => {
        test.skip(!!EDIT_URL, 'Activate is for new records');
        test.setTimeout(ACTIVATE_TEST_TIMEOUT);
        await org.activateOrganization(['Activate & Approve', 'Activate']);
    });

    // ---------- find the saved organization again and check every tab ----------

    let orgSearch;
    let orgIdToOpen;

    // 4. Transact > Organization Master > Search & Edit Organization Master >
    //    Organization Name dropdown = the name the script created > Search
    test('search the created organization', async () => {
        test.skip(!!EDIT_URL, 'Search is for the organization created by this run');
        test.setTimeout(120_000);

        const transact = new TransactPage(page);
        await transact.openTransact();
        await transact.selectTask('Organization Master');
        await transact.selectTypeOfScreen(ORG_SEARCH_SCREEN);

        orgSearch = new OrganizationSearchPage(page);
        await orgSearch.verifyScreen();

        const name = TABS.info.values['Organization Name'];
        await orgSearch.searchOrganization(name);
        orgIdToOpen = await orgSearch.organizationIdFor(name, createdOrgId);
    });

    // 5. Click the Organization ID, then compare every tab with the values the script entered
    test('open the organization and validate every tab', async () => {
        test.skip(!!EDIT_URL, 'Search is for the organization created by this run');
        test.setTimeout(240_000);

        await orgSearch.openOrganization(orgIdToOpen);
        await orgSearch.validateAgainstScript(orgIdToOpen, test.info());
    });
});
