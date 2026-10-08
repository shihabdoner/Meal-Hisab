# খাদ্য তথ্য v3 — Google Sheet is the database

Website (GitHub Pages) <-> Google Apps Script (bound to your sheet) <-> your Google Sheet.
Firebase is used only for Google sign-in. Members/admin live in the sheet's "Members" tab.

## Setup
1. Upload your original Excel file (or the CSV) to Google Drive, open it with Google Sheets
   (CSV has no colours/merged cells and lost the Bengali letters (they show as ????) - re-type them in the sheet or upload the .xlsx).
2. In the sheet: Extensions -> Apps Script. Delete the sample code, paste `apps-script-code.txt`, Save.
3. Choose the function `setup` in the toolbar -> Run. Approve the permissions
   (Advanced -> "Go to ... (unsafe)" -> Allow). This adds Members + MealDetails tabs and SUM formulas to the total rows.
4. Open the new **Members** tab. In row 2 type: Shihab's Gmail (lowercase) | Shihab | TRUE
5. Deploy -> New deployment -> type: Web app -> Execute as: **Me** -> Who has access: **Anyone** -> Deploy. Copy the URL (ends with /exec).
6. Put the URL in `firebase-config.js` (SCRIPT_URL). Upload `index.html`, `app.js`, `style.css`, `firebase-config.js` to GitHub.
7. Open the site, sign in as Shihab, use **Group admin** to add everyone's Gmail.

If you change the script later: Deploy -> Manage deployments -> edit -> New version.

## Notes
- Each person's meal cell = lunch + dinner count (a filled box counts 1, or the number typed). Text is kept in the MealDetails tab.
- Deposit/spending cells hold one amount per date; adding on the same date adds to the cell.
- The sheet covers the dates in column F (Oct 1-30). For a new month, copy the tab with new dates.
- Firestore is no longer used: set its rules to deny all (`allow read, write: if false;`).
