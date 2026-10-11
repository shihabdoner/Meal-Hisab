/**
 * Finance Tracker setup: creates a Google Form (with dropdowns),
 * a linked Google Sheet, and a Summary tab like your Excel file.
 * Run createFinanceTracker() once, then check View > Logs for the links.
 */
function createFinanceTracker() {
  const CATEGORIES = [
    'Food/Eating Out', 'Rent & Bills', 'Groceries',
    'Transport & Education', 'Tech/Upgrades', 'Lost/Wasted'
  ];
  const PAYMENT_METHODS = [
    'Cash', 'Mobile Banking (e.g., bKash, Nagad)', 'Card', 'Bank Transfer'
  ];
  const BUDGET = 3000;

  // ---- Form ----
  const form = FormApp.create('Daily Expense Tracker');
  form.setDescription('Log every expense. Takes 10 seconds.');

  form.addDateItem().setTitle('Date of Expense').setRequired(true);

  form.addTextItem().setTitle('Amount (BDT)').setRequired(true)
    .setValidation(FormApp.createTextValidation()
      .setHelpText('Enter a number')
      .requireNumber().build());

  form.addTextItem().setTitle('Description (Way of Expense)').setRequired(true);

  form.addListItem().setTitle('Category')
    .setChoiceValues(CATEGORIES).setRequired(true);

  form.addListItem().setTitle('Payment Method Used')
    .setChoiceValues(PAYMENT_METHODS).setRequired(true);

  form.addScaleItem().setTitle('Was this a necessary expense?')
    .setBounds(1, 5).setLabels('Not necessary', 'Very necessary')
    .setRequired(true);

  // ---- Linked Sheet ----
  const ss = SpreadsheetApp.create('Finance Tracker');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  SpreadsheetApp.flush();

  // Wait for the responses tab to appear
  let resp = null;
  for (let i = 0; i < 10 && !resp; i++) {
    Utilities.sleep(1500);
    resp = SpreadsheetApp.openById(ss.getId()).getSheets()
      .find(s => s.getName().indexOf('Form Responses') === 0);
  }
  const respName = resp ? resp.getName() : 'Form Responses 1';
  const R = "'" + respName + "'!";

  // ---- Summary tab ----
  const sum = ss.insertSheet('Summary');
  sum.getRange('A1:D1').setValues([['Category', 'Total Spent (BDT)', '', BUDGET]]);
  sum.getRange('C1').setValue('Budget');

  CATEGORIES.forEach((cat, i) => {
    const row = i + 2;
    sum.getRange(row, 1).setValue(cat);
    sum.getRange(row, 2).setFormula(
      '=SUMIFS(' + R + 'C:C, ' + R + 'E:E, A' + row + ')');
  });

  const last = CATEGORIES.length + 1;
  sum.getRange(last + 2, 1).setValue('Total Spent');
  sum.getRange(last + 2, 2).setFormula('=SUM(B2:B' + last + ')');
  sum.getRange(last + 2, 4).setFormula(
    '=SPARKLINE(B' + (last + 2) + ',{"charttype","bar";"max",D1;' +
    '"color1",IF(B' + (last + 2) + '>D1,"red","green")})');

  sum.getRange(last + 4, 1).setValue('Budget Left');
  sum.getRange(last + 4, 2).setFormula('=D1-B' + (last + 2));

  // Spend by payment method
  const pmStart = last + 7;
  sum.getRange(pmStart - 1, 1, 1, 2).setValues([['Payment Method', 'Total (BDT)']]);
  PAYMENT_METHODS.forEach((pm, i) => {
    sum.getRange(pmStart + i, 1).setValue(pm);
    sum.getRange(pmStart + i, 2).setFormula(
      '=SUMIFS(' + R + 'C:C, ' + R + 'F:F, A' + (pmStart + i) + ')');
  });

  // Formatting
  sum.getRange('A1:D1').setFontWeight('bold').setBackground('#d9ead3');
  sum.getRange(pmStart - 1, 1, 1, 2).setFontWeight('bold').setBackground('#d9ead3');
  sum.getRange(last + 2, 1, 1, 2).setFontWeight('bold');
  sum.setColumnWidth(1, 240);
  sum.setColumnWidth(2, 130);
  sum.setColumnWidth(4, 200);
  sum.getRange('B2:B30').setNumberFormat('#,##0');

  // Spend-by-category pie chart
  const chart = sum.newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(sum.getRange('A1:B' + last))
    .setPosition(2, 6, 0, 0)
    .setOption('title', 'Spending by Category')
    .build();
  sum.insertChart(chart);

  sum.setFrozenRows(1);

  Logger.log('Form (share this to fill): ' + form.getPublishedUrl());
  Logger.log('Form (edit): ' + form.getEditUrl());
  Logger.log('Sheet: ' + ss.getUrl());
}
