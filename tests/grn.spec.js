import { test, expect } from '@playwright/test';

import { LoginPage } from '../pages/LoginPage.js';
import { SelectOrganizationDialog } from '../pages/SelectOrganizationDialog.js';
import { DTFOWSPage } from '../pages/DTFOWSPage.js';
import { InboxPage, GrnPage, GrnSearchPage, GRN_LABELS } from '../pages/GrnPage.js';

/**
 * GRN = Goods and Service Entries
 *
 * Tab 1: Inbox > vendor row > attachment (invoice stays open)
 * Tab 2: Transact > Goods and Service Entries > Create
 *        Receiver Info > Sender Info > Entry Item > (Cost Allocation + Journal prefilled)
 *        > Validate & Save > Approve shown > Activate & Approve
 *        > Search & Edit > Vendor Name > Search > open the entry > verify every tab
 *
 * Dropdown choosers: 'first' | 'last' | ['tokens', 'that', 'must', 'all', 'appear'] | 'Exact Text'
 * (case, spaces and punctuation ignored; Pvt = Private, Ltd = Limited).
 */
const GRN = {
    // Inbox filters, then Submit
    inbox: {
        company: 'Data Pvt Ltd',   // whole name (Pvt = Private, Ltd = Limited), so "Data Industrial Work Pvt Ltd" is not picked
        period: 'previousMonth',   // From/To Date = last month (in November: 01-10 to 31-10);
        // or 'currentMonth', or { from: '01-10-2026', to: '31-10-2026' }
    },

    vendor: ['western', 'associat'],                 // Inbox row + Sender + search filter
    receiverTaxReg: ['Data Pvt Ltd', 'tamil'],       // "Data Private Limited - Tamil Nadu" ("Data Pvt Ltd" must appear as a whole)
    orderType: 'Purchase Order',
    orderNumber: 'last',                              // the latest purchase order
    modeOfDelivery: 'Offline',
    chargeType: ['transport'],                        // Additional Charge Type ...
    chargeTypeFallback: ['other'],                    // ... or "Other" when there is no transport type

    // From the invoice. '' = automatic:
    //   totalAdditionalCharge: the transport charge read from the invoice viewer (if readable)
    //   invoiceQuantity: the Balance Quantity shown for the item; receivedQuantity: = invoiceQuantity
    totalAdditionalCharge: '',
    invoiceQuantity: '',
    receivedQuantity: '',

    orderDescription: 'first',
    itemName: 'first',

    dateFormat: 'DD-MM-YYYY', // how Invoice Date is typed (the Inbox shows yyyy-mm-dd)
};

const TASK = /goods\s*(and|&)\s*services?\s*entr/i;
const CREATE_SCREEN = /^\s*create\b/i;
const SEARCH_SCREEN = /search\s*(&|and)\s*edit/i;

test.describe('GRN - Goods and Service Entries', () => {
    test.describe.configure({ mode: 'serial' });

    let context;
    let inboxTab;   // tab 1: inbox + invoice viewer
    let grnTab;     // tab 2: Transact
    let grn;
    let invoice;
    let entryId = '';

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(180_000);

        const { DATATWIN_EMAIL, DATATWIN_PASSWORD, DATATWIN_STAGE_URL, DATATWIN_ORGANIZATION } = process.env;
        if (!DATATWIN_EMAIL || !DATATWIN_PASSWORD) {
            throw new Error('DATATWIN_EMAIL / DATATWIN_PASSWORD are not set in .env');
        }

        context = await browser.newContext({ baseURL: DATATWIN_STAGE_URL || 'https://stage.datatwin.ai' });
        inboxTab = await context.newPage();

        const login = new LoginPage(inboxTab);
        const orgDialog = new SelectOrganizationDialog(inboxTab);
        const dtfows = new DTFOWSPage(inboxTab);
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

    // ---------- tab 1: the invoice ----------

    test('Inbox: Company, From/To Date (previous month), Submit, open the vendor invoice', async () => {
        test.setTimeout(180_000);
        const inbox = new InboxPage(inboxTab);
        await inbox.open();
        await inbox.applyFilters({ ...GRN.inbox, dateFormat: GRN.dateFormat });

        invoice = await inbox.findInvoice(GRN.vendor);
        expect(invoice.invoiceNo, 'The inbox row has no Invoice No').toBeTruthy();

        const text = await inbox.openAttachment(invoice.row);
        if (GRN.totalAdditionalCharge === '') {
            GRN.totalAdditionalCharge = InboxPage.transportChargeFrom(text);
            console.log(
                GRN.totalAdditionalCharge
                    ? `Transport charge read from the invoice: ${GRN.totalAdditionalCharge}`
                    : 'Transport charge not readable from the invoice viewer - set GRN.totalAdditionalCharge in the spec.'
            );
        }
    });

    // ---------- tab 2: create the Goods and Service Entry ----------

    test('Transact > Goods and Service Entries > Create (new tab)', async () => {
        grnTab = await context.newPage();
        await grnTab.goto(inboxTab.url()); // same session, then go to Transact
        grn = new GrnPage(grnTab);
        await grn.chooseTransact(TASK, CREATE_SCREEN);
        await expect(grn.tab(GRN_LABELS.tabs.receiver), 'The Create screen has no Receiver tab').toBeVisible({ timeout: 60_000 });
    });

    test('Receiver Info: Receiver Tax Reg', async () => {
        test.setTimeout(90_000);
        await grn.fillReceiver(GRN);
    });

    test('Sender Info: vendor, invoice reference/date, purchase order, delivery, charges', async () => {
        test.setTimeout(180_000);
        await grn.fillSender(GRN, invoice);
    });

    test('Entry Item: order description, item, quantities', async () => {
        test.setTimeout(120_000);
        await grn.fillItem(GRN);
    });

    test('Cost Allocation and Journal are prefilled', async () => {
        test.setTimeout(90_000);
        await grn.checkPrefilledTabs();
    });

    test('Validate & Save', async () => {
        test.setTimeout(240_000);
        await grn.actions.validateOrganization('Validate & Save');
        entryId = await grn.readEntryId();
        console.log(entryId ? `Goods and Service Entry: ${entryId}` : 'Entry number not shown on the page yet.');
    });

    test('Approvals bar shows Approve', async () => {
        test.setTimeout(120_000);
        await grn.actions.checkApproveShown();
    });

    test('Activate & Approve (GRN created)', async () => {
        test.setTimeout(300_000);
        await grn.actions.activateOrganization(['Activate & Approve', 'Activate']);
    });

    // ---------- verify: find it again and check every tab ----------

    let search;
    let result;

    test('Search & Edit Goods and Service Entries by vendor', async () => {
        test.setTimeout(120_000);
        await grn.chooseTransact(TASK, SEARCH_SCREEN);
        search = new GrnSearchPage(grnTab);
        await search.verifyScreen();
        result = await search.searchVendor(GRN.vendor);
    });

    test('open the entry and verify all tabs', async () => {
        test.setTimeout(240_000);
        const target = await search.pickResult(result, { entryId, invoiceNo: invoice.invoiceNo });
        await search.openEntry(target);
        await search.verifyEntry(grn.entered, test.info());
    });
});