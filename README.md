# খাদ্য তথ্য — v2 edition

```
app_v2/
  frontend/    index.html  app.js  sw.js        ← replace these three files
  apps_script/ khaddo_tottho.gs  bazar_hisab.gs ← replace the code in each Apps Script project
```
Not changed, keep yours: `style.css`, `manifest.json`, `firebase-config.js`, `img/`, icons.

The two scripts are generated from one source and differ in exactly three places: the header line, `SOURCE_URL`, and the `doGet` text.
`bazar_hisab.gs` already contains your খাদ্য তথ্য web-app URL as `SOURCE_URL`.

## What is new

| Area | Change |
|---|---|
| Duplicates | Every write carries a request id. Pressing Add twice, a timeout, or a busy script can no longer add a grocery entry or deposit twice. The app retries automatically (up to 3 tries). |
| Secret | `SYNC_SECRET` is no longer in the code. It lives in Script Properties and the sync path is off until you set it (24+ characters). |
| Safe saves | Logs are written new-first, old-tail-last. A failed write keeps the old rows. |
| Text safety | Details, notes and name columns are stored as plain text (`=1+1`, `5/10` stay text). |
| Room to grow | `Activity` and `MealDetails` no longer stop at 1000 rows; a failing alert write cannot make a successful save look like an error. |
| Amounts | One amount rule everywhere: above 0 (0 only for admin removal), at most 2 decimals, at most 10,000,000. |
| Health report | Admin-only, read-only. Run `reconcileReport()` in the editor (output in Executions → Logs). Also shows both timezones. |
| App | No popup when a background refresh fails; a page left open overnight rolls to the new day; service worker `khaddo-v6`. |
| Drift | Both scripts now share the empty-source guard (previously only in বেলা হিসাব). |

## Deploy (do on COPIES first; see batch1/PATCH_NOTES.md Part 3 for the full checklist)
1. Copy both spreadsheets. Copy both script projects.
2. In **both** projects: Project Settings → Script properties → add `SYNC_SECRET` = the same new random value (24+ characters). Run `checkSecretConfigured()` — it should log `true`.
3. Paste `khaddo_tottho.gs` into the খাদ্য তথ্য project and `bazar_hisab.gs` into the বেলা হিসাব project (replace everything). Authorize if asked.
4. Deploy a new version of **খাদ্য তথ্য, then বেলা হিসাব, back to back** (Deploy → Manage deployments → edit → New version). Between the two, the mirror sync reports "Bad sync secret" — safe, nothing is written.
5. Upload the three frontend files. Reload twice (the service worker updates on the second load).
6. As admin: press ⟳, check the "● live" label, add a test grocery entry, press Add twice, confirm one row. Then run `reconcileReport()`.

Rollback: Deploy → Manage deployments → pick the previous version; restore the old frontend files; the old code still has its old `SYNC_SECRET` constant, so keep your old file.

## Tests (all simulated in Node with mocked Apps Script services; nothing touched a real spreadsheet)
- `batch1/test_server_patch.js` — 21 tests (run against the patch, and again against each full script)
- `batch1/test_handle.js` — 12 tests of the request router on each full script
- Frontend: syntax check passes and every element id used by `app.js` exists in `index.html`. Browser behaviour is NOT tested.
