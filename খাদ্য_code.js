//khaddo tottho appscript (খাদ্য তথ্য)
/** Meal-fund API. Google Sheets stays the source of truth.
 *  Same code in BOTH scripts (খাদ্য তথ্য and বেলা হিসাব). Only SOURCE_URL differs.
 *
 *  Grocery entries live in the "GroceryLog" tab (one row per purchase: date, time, বাজারকর্তা, amount, details).
 *  Deposits live in the "DepositLog" tab (one row per deposit). The date tables in the sheet are drawn from these logs:
 *  a date with 3 purchases gets 3 rows (extra rows are inserted under the date, time in the column next to the date).
 *  Edits typed directly into the বেলা হিসাব bazar block are pushed back to খাদ্য তথ্য (see onBazarEdit / bazarSweep).
 *  Entries that have no বাজারকর্তা stay in খাদ্য তথ্য / the app and are never touched by the বেলা হিসাব sync. */
const FIREBASE_API_KEY = 'AIzaSyAfp6ACmE3d-9iAieAp1knA40qKEbdcx7Y'; // same key as firebase-config.js
const NAMES = ['Shohan', 'Naved', 'Salman', 'Rifat', 'Shihab', 'Ashmit'];
const MONTHS = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11};
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MEMBER_HEADERS = ['Email', 'Name', 'Admin', 'AddFor', 'AddSpending', 'CanGrocery', 'CanFunds', 'CanMeals', 'FundsFor', 'MealsFor', 'Views'];
const VIEW_KEYS = ['sheetMeals','sheetSpending','sheetDeposits','myDep','resid','due','lastFund','lastDate','lastGrocery','totalFund','totalSpent','left'];
// In the "বেলা হিসাব" (Bazar hisab) script this is the খাদ্য তথ্য web app URL. In the খাদ্য তথ্য script it stays ''.
const SOURCE_URL = '';
// Password the two scripts use to talk to each other without a signed-in user (must be IDENTICAL in both scripts).
const SYNC_SECRET = 'Df1hJC8NJnIE7Bwm7cIGfY4iJmUh6RQN';

// TEMPORARY RULE (Bazar hisab only, October 2026): when copying from khaddo, show 'N/A' as BLANK for these dates.
const BLANK_NA_FROM = '2026-10-01';
const BLANK_NA_TO = '2026-10-08';

const GL_HEAD = ['ID', 'Date', 'Time', 'Person', 'Amount', 'Details', 'AddedByEmail', 'AddedByName'];
const DL_HEAD = ['ID', 'Date', 'Time', 'Person', 'Amount', 'AddedByEmail', 'AddedByName'];
const MAX_PER_DATE = 15;
const SHEET_USER = 'বেলা হিসাব sheet';

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function main_() { return ss_().getSheets()[0]; }   // the FIRST tab is always the current month
function tz_() { return ss_().getSpreadsheetTimeZone(); }
function doGet() { return ContentService.createTextOutput('Meal fund API is running'); }

function doPost(e) {
  let out;
  try { out = handle_(JSON.parse(e.postData.contents)); }
  catch (err) { out = { ok: false, error: String(err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Auth: verify the Firebase (Google) sign-in token ----------
function verify_(idToken) {
  if (!idToken) throw new Error('Not signed in');
  const cache = CacheService.getScriptCache();
  const key = 't' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).slice(0, 40);
  const hit = cache.get(key);
  if (hit) return hit;
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText()), u = j.users && j.users[0];
  if (!u || !u.email || !u.emailVerified) throw new Error('Invalid sign-in');
  const email = u.email.toLowerCase();
  cache.put(key, email, 300);
  return email;
}

// ---------- Helpers ----------
function tab_(name, headers, textFirstCol) {
  let s = ss_().getSheetByName(name);
  if (!s) {
    try {
      s = ss_().insertSheet(name, ss_().getNumSheets());
      s.appendRow(headers);
      if (textFirstCol) s.getRange(1, 1, s.getMaxRows(), 1).setNumberFormat('@');
    } catch (e) {                                   // another request created it at the same moment
      s = ss_().getSheetByName(name);
      if (!s) throw e;
    }
  }
  return s;
}
// tab whose first columns (1-based list) are plain text, so dates / times are never auto-converted
function textTab_(name, headers, textCols) {
  let s = ss_().getSheetByName(name);
  if (!s) {
    try {
      s = ss_().insertSheet(name, ss_().getNumSheets());
      s.appendRow(headers);
      textCols.forEach(function (c) { s.getRange(1, c, s.getMaxRows(), 1).setNumberFormat('@'); });
    } catch (e) {                                   // another request created it at the same moment
      s = ss_().getSheetByName(name);
      if (!s) throw e;
    }
  }
  return s;
}

function dateKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  const m = String(v || '').match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (mo === undefined) return null;
  return m[3] + '-' + String(mo + 1).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
}
function num_(x) { const n = Number(x); return (x === '' || x === null || x === undefined || isNaN(n)) ? 0 : n; }
function bool_(x) { return x === true || String(x).toUpperCase() === 'TRUE'; }
function colLetter_(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
function flat_(x) { return String(x || '').replace(/[\s\u200c\u200d]+/g, '').toLowerCase(); }
function p2_(n) { return (n < 10 ? '0' : '') + n; }
function r2_(x) { return Math.round(x * 100) / 100; }
function newId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function cellOf_(L, r, c) { const x = (L.v[r] || [])[c]; return x === undefined ? '' : x; }
function cleanDet_(x) { const d = String(x === null || x === undefined ? '' : x).trim(); return d === 'N/A' ? '' : d; }
function normBazar_(x) {
  const s = String(x || '').trim();
  if (!s || s === 'N/A') return '';
  const low = s.toLowerCase();
  return NAMES.find(function (n) { return low.indexOf(n.toLowerCase()) === 0; }) || s;
}
function nowParts_() {
  const d = new Date();
  return { date: Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'), time: Utilities.formatDate(d, tz_(), 'HH:mm') };
}
// '8:05', '08.05', '8:05 PM', a time Date from the sheet  ->  'HH:mm'  ('' if it is not a time)
function normTime_(x) {
  if (x instanceof Date) return Utilities.formatDate(x, tz_(), 'HH:mm');
  const s = String(x === null || x === undefined ? '' : x).trim();
  const m = s.match(/^(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*:\s*\d{2})?\s*([AaPp][Mm])?$/);
  if (!m) return '';
  let h = Number(m[1]); const mi = Number(m[2]);
  if (m[3]) { if (h < 1 || h > 12) return ''; h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0); }
  if (h > 23 || mi > 59) return '';
  return p2_(h) + ':' + p2_(mi);
}
// No entries for a date/time that has not happened yet. The phone's clock is trusted when it is within a day of the sheet's clock (time zones).
function checkNotFuture_(date, time, req) {
  const srv = nowParts_();
  let today = srv.date, now = srv.time;
  if (req && /^\d{4}-\d{2}-\d{2}$/.test(String(req.today || ''))) {
    const dd = Math.abs(Date.parse(req.today) - Date.parse(srv.date)) / 86400000;
    if (dd <= 1) { today = req.today; if (/^\d{2}:\d{2}$/.test(String(req.now || ''))) now = req.now; }
  }
  if (date > today) throw new Error('You cannot add an entry for a future date (' + date + ')');
  if (date === today && time && time > now) throw new Error('You cannot add an entry for a time that has not come yet (' + time + ')');
}

// Finds the date tables automatically, wherever they sit in the sheet.
// A date may span several consecutive rows: the first row is the real one, the rest are "extra" rows (more grocery purchases).
function primary_(run) {
  let dup = false;
  for (let i = 1; i < run.length; i++) if (run[i].k === run[i - 1].k) { dup = true; break; }
  return dup ? run.filter(function (o, i) { return i === 0 || o.k !== run[i - 1].k; }) : run;
}
function layout_(sheet) {
  const sh = sheet || main_(), v = sh.getDataRange().getValues();
  const width = v.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
  let dateCol = -1, best = 0;
  for (let c = 0; c < width; c++) {
    let n = 0;
    for (let r = 0; r < v.length; r++) if (dateKey_((v[r] || [])[c])) n++;
    if (n > best) { best = n; dateCol = c; }
  }
  if (dateCol < 0) throw new Error('No dates found in the first tab');
  const runs = []; let cur = null;
  for (let r = 0; r < v.length; r++) {
    const k = dateKey_((v[r] || [])[dateCol]);
    if (k) { if (!cur) { cur = []; runs.push(cur); } cur.push({ r: r, k: k }); } else cur = null;
  }
  // new sheet: ONE date column with three blocks side by side (meal | bazar | deposit)
  if (runs.length < 3) return blocksLayout_(sh, v, width, dateCol, runs);

  const colsFor = function (start) {
    for (let r = start - 1; r >= Math.max(0, start - 5); r--) {
      const m = {};
      for (let c = dateCol + 1; c <= dateCol + 12; c++) {
        const t = String((v[r] || [])[c] || '').trim().toLowerCase();
        NAMES.forEach(function (n) { if (t && t.indexOf(n.toLowerCase()) === 0) m[n] = c; });
      }
      if (Object.keys(m).length >= 3) return m;
    }
    throw new Error('Name header row not found above a table');
  };

  // spending table: amount + details are (merged) cells; write to the left-most cell of each merge
  const first = runs[1][0].r;
  let amountCol = -1, detailsCol = -1;
  const merges = sh.getRange(first + 1, dateCol + 2, 1, 20).getMergedRanges()
    .map(function (x) { return x.getColumn() - 1; }).sort(function (a, b) { return a - b; });
  if (merges.length >= 2) { amountCol = merges[0]; detailsCol = merges[1]; }
  else {
    for (let r = first - 1; r >= Math.max(0, first - 4); r--)
      for (let c = dateCol + 1; c < width; c++) {
        const t = String((v[r] || [])[c] || '').trim().toLowerCase();
        if (t === 'spending') amountCol = c;
        if (t === 'details') detailsCol = c;
      }
    if (amountCol < 0) amountCol = dateCol + 2;
    if (detailsCol < 0) detailsCol = amountCol + 7;
  }

  return { kind: 'stacked', sh: sh, v: v, dateCol: dateCol,
    meals: { rows: primary_(runs[0]), cols: colsFor(runs[0][0].r) },
    spend: { rows: runs[1], amountCol: amountCol, detailsCol: detailsCol },
    dep: { rows: primary_(runs[2]), cols: colsFor(runs[2][0].r) },
    bazar: { col: -1, rows: null } };
}

// Side-by-side layout: one date column, then three blocks of 6 name columns: মিল হিসাব | বাজার হিসাব | জমা টাকার হিসাব.
// The bazar amount is written in the cell of the বাজারকর্তা person; the time sits in the column right of the date.
function blocksLayout_(sh, v, width, dateCol, runs) {
  const run = runs.reduce(function (a, b) { return b.length > a.length ? b : a; }, runs[0]);
  const start = run[0].r;
  let hr = -1, hits = [];
  for (let r = start - 1; r >= Math.max(0, start - 6) && hr < 0; r--) {
    const m = [];
    for (let c = dateCol + 1; c < width; c++) {
      const t = String((v[r] || [])[c] || '').trim().toLowerCase();
      if (!t) continue;
      const n = NAMES.find(function (x) { return t.indexOf(x.toLowerCase()) === 0; });
      if (n) m.push({ c: c, n: n });
    }
    if (m.length >= 12) { hr = r; hits = m; }
  }
  if (hr < 0) throw new Error('Sheet layout not recognised (no row with the names three times above the dates)');
  const groups = []; let cur = null;
  hits.forEach(function (h) {
    if (!cur || cur.cols[h.n] !== undefined) { cur = { cols: {}, min: h.c, max: h.c }; groups.push(cur); }
    cur.cols[h.n] = h.c; cur.max = h.c;
  });
  if (groups.length < 3) throw new Error('Sheet layout not recognised (expected 3 blocks of names, found ' + groups.length + ')');
  const roleOf = function (g) {          // use the block titles (মিল / বাজার / জমা) when they are there
    for (let r = hr - 1; r >= Math.max(0, hr - 5); r--)
      for (let c = Math.max(0, g.min - 1); c <= Math.min(width - 1, g.max + 1); c++) {
        const t = flat_((v[r] || [])[c]);
        if (!t) continue;
        if (t.indexOf('মিল') >= 0) return 'meal';
        if (t.indexOf('জমা') >= 0) return 'dep';
        if (t.indexOf('বাজার') >= 0 && t.indexOf('খরচ') < 0) return 'bazar';
      }
    return '';
  };
  const order = ['meal', 'bazar', 'dep'], roles = {};
  groups.forEach(function (g, i) { const role = roleOf(g) || order[i]; if (!roles[role]) roles[role] = g; });
  if (!roles.meal || !roles.bazar || !roles.dep) throw new Error('Sheet layout not recognised (could not tell the meal / bazar / deposit blocks apart)');
  return { kind: 'blocks', sh: sh, v: v, dateCol: dateCol,
    meals: { rows: primary_(run), cols: roles.meal.cols },
    dep: { rows: primary_(run), cols: roles.dep.cols },
    spend: { rows: run, cols: roles.bazar.cols, amountCol: -1, detailsCol: -1 },
    bazar: { col: -1, rows: null } };
}

// ---------- Members / permissions ----------
function listOf_(x) {
  return String(x || '').split(',').map(function (n) { return n.trim(); }).filter(function (n) { return NAMES.indexOf(n) >= 0; });
}
function members_() {
  const s = tab_('Members', MEMBER_HEADERS);
  const want = MEMBER_HEADERS.slice(3), have = s.getRange(1, 4, 1, want.length).getValues()[0];
  if (have.join('|') !== want.join('|')) s.getRange(1, 4, 1, want.length).setValues([want]);
  const d = s.getDataRange().getValues(), out = [];
  for (let i = 1; i < d.length; i++) {
    const email = String(d[i][0] || '').trim().toLowerCase();
    if (!email) continue;
    const blank = function (x) { return x === '' || x === null || x === undefined; };
    const canGrocery = blank(d[i][5]) ? bool_(d[i][4]) : bool_(d[i][5]);
    const legacy = blank(d[i][8]) && blank(d[i][9]);
    const oldFor = listOf_(d[i][3]);
    const fundsFor = legacy ? ((blank(d[i][6]) || bool_(d[i][6])) ? oldFor : []) : listOf_(d[i][8]);
    const mealsFor = legacy ? ((blank(d[i][7]) || bool_(d[i][7])) ? oldFor : []) : listOf_(d[i][9]);
    const union = NAMES.filter(function (n) { return fundsFor.indexOf(n) >= 0 || mealsFor.indexOf(n) >= 0; });
    const views = blank(d[i][10]) ? VIEW_KEYS.slice()
      : String(d[i][10]).split(',').map(function (k) { return k.trim(); }).filter(function (k) { return VIEW_KEYS.indexOf(k) >= 0; });
    out.push({
      email: email, name: String(d[i][1] || '').trim(), row: i + 1, admin: bool_(d[i][2]),
      addFor: union, fundsFor: fundsFor, mealsFor: mealsFor, views: views,
      addSpending: canGrocery, canGrocery: canGrocery, canFunds: fundsFor.length > 0, canMeals: mealsFor.length > 0
    });
  }
  return out;
}
function me_(email) {
  const m = members_().find(function (x) { return x.email === email; });
  if (!m) throw new Error(email + ' is not on the group list');
  return { email: m.email, name: m.name, admin: m.admin, addFor: m.addFor, fundsFor: m.fundsFor, mealsFor: m.mealsFor, views: m.views,
    addSpending: m.addSpending, canGrocery: m.canGrocery, canFunds: m.canFunds, canMeals: m.canMeals };
}
function admin_(me) { if (!me.admin) throw new Error('Admin only'); }

// ---------- Notes + who-added metadata ----------
function notes_() {
  const s = tab_('MealDetails', ['Date', 'Person', 'Lunch', 'Dinner'], true);
  const d = s.getDataRange().getValues(), out = {};
  for (let i = 1; i < d.length; i++) {
    const k = dateKey_(d[i][0]) || String(d[i][0]);
    out[d[i][1] + '|' + k] = { lunch: String(d[i][2] || ''), dinner: String(d[i][3] || '') };
  }
  return out;
}
function depositMeta_() { return tab_('DepositMeta', ['Date', 'Person', 'AddedByEmail', 'AddedByName'], true); }
function metaRow_(sheet, keys) {
  const d = sheet.getDataRange().getValues();
  for (let i = 1; i < d.length; i++) {
    const got = keys.map(function (_, j) { return j === 0 ? (dateKey_(d[i][0]) || String(d[i][0])) : String(d[i][j] || ''); });
    if (keys.every(function (k, j) { return got[j] === String(k); })) return i + 1;
  }
  return 0;
}
function saveDepositMeta_(date, person, me) {
  const s = depositMeta_(), r = metaRow_(s, [date, person]);
  if (r) s.getRange(r, 1, 1, 4).setValues([[date, person, me.email, me.name]]);
  else s.appendRow([date, person, me.email, me.name]);
}
function depMetaMap_() {
  const d = depositMeta_().getDataRange().getValues(), o = {};
  for (let i = 1; i < d.length; i++) {
    if (!d[i][2]) continue;
    o[(dateKey_(d[i][0]) || String(d[i][0])) + '|' + d[i][1]] = { email: String(d[i][2] || ''), name: String(d[i][3] || '') };
  }
  return o;
}

// ---------- Grocery log (one row per purchase) ----------
function glTab_() { return textTab_('GroceryLog', GL_HEAD, [1, 2, 3]); }
function readLog_() {
  const s = glTab_(), n = s.getLastRow() - 1;
  if (n < 1) return [];
  return s.getRange(2, 1, n, GL_HEAD.length).getValues().filter(function (r) { return r[0] !== '' && r[1] !== ''; }).map(function (r) {
    return { id: String(r[0]), date: dateKey_(r[1]) || String(r[1]), time: normTime_(r[2]), person: String(r[3] || ''), amount: num_(r[4]),
      details: String(r[5] || ''), email: String(r[6] || ''), name: String(r[7] || '') };
  });
}
function writeLog_(entries) {
  const s = glTab_(), last = s.getLastRow();
  if (last > 1) s.getRange(2, 1, last - 1, GL_HEAD.length).clearContent();
  if (entries.length) s.getRange(2, 1, entries.length, GL_HEAD.length).setValues(entries.map(function (e) {
    return [e.id, e.date, e.time || '', e.person, e.amount, e.details || '', e.email || '', e.name || ''];
  }));
}
function sortEntries_(list) {
  return list.map(function (e, i) { return { e: e, i: i }; }).sort(function (a, b) {
    return a.e.date.localeCompare(b.e.date) || (a.e.time || '').localeCompare(b.e.time || '') || (a.i - b.i);
  }).map(function (x) { return x.e; });
}
function latestSpendDate_(log) { return log.reduce(function (m, e) { return num_(e.amount) > 0 && e.date > m ? e.date : m; }, ''); }
function detailLine_(e) { return (e.time ? '[' + e.time + '] ' : '') + (e.person || '') + (e.details ? ': ' + e.details : ''); }

// ---------- Deposit log (one row per deposit) ----------
function dlTab_() { return textTab_('DepositLog', DL_HEAD, [1, 2, 3]); }
function readDepositLog_() {
  const s = dlTab_(), n = s.getLastRow() - 1;
  if (n < 1) return [];
  return s.getRange(2, 1, n, DL_HEAD.length).getValues().filter(function (r) { return r[0] !== '' && r[1] !== ''; }).map(function (r) {
    return { id: String(r[0]), date: dateKey_(r[1]) || String(r[1]), time: normTime_(r[2]), person: String(r[3] || ''), amount: num_(r[4]),
      email: String(r[5] || ''), name: String(r[6] || '') };
  });
}
function writeDepositLog_(entries) {
  const s = dlTab_(), last = s.getLastRow();
  if (last > 1) s.getRange(2, 1, last - 1, DL_HEAD.length).clearContent();
  if (entries.length) s.getRange(2, 1, entries.length, DL_HEAD.length).setValues(entries.map(function (e) {
    return [e.id, e.date, e.time || '', e.person, e.amount, e.email || '', e.name || ''];
  }));
}

// One-time: turn amounts that already sit in the sheet into log rows (so nothing is lost when upgrading).
function legacyRows_(name) {
  const s = ss_().getSheetByName(name);
  if (!s || s.getLastRow() < 2) return [];
  return s.getRange(2, 1, s.getLastRow() - 1, s.getLastColumn()).getValues();
}
function migrateOnce_() {
  const P = PropertiesService.getScriptProperties();
  if (P.getProperty('GL_MIGRATED') === '1') return;
  const lock = LockService.getScriptLock(), had = lock.hasLock();
  if (!had) lock.waitLock(20000);                    // only one request may run the one-time migration
  try {
    if (P.getProperty('GL_MIGRATED') === '1') return;
    const gl = glTab_(); dlTab_();
    if (gl.getLastRow() < 2) {
      const L = layout_(), entries = [];
      if (L.kind === 'blocks') {
        const bd = {};
        legacyRows_('BazarDetails').forEach(function (r) { if (r[0]) bd[(dateKey_(r[0]) || String(r[0])) + '|' + r[1]] = r; });
        L.spend.rows.forEach(function (o) {
          NAMES.forEach(function (n) {
            const c = L.spend.cols[n], a = c === undefined ? 0 : num_(cellOf_(L, o.r, c));
            if (a > 0) { const m = bd[o.k + '|' + n]; entries.push({ id: newId_(), date: o.k, time: '', person: n, amount: a, details: m ? cleanDet_(m[2]) : '', email: m ? String(m[3] || '') : '', name: m ? String(m[4] || '') : '' }); }
          });
        });
      } else {
        const sm = {}, notes = notes_();
        legacyRows_('SpendingMeta').forEach(function (r) { if (r[1]) sm[dateKey_(r[0]) || String(r[0])] = r; });
        L.spend.rows.forEach(function (o) {
          const a = num_(cellOf_(L, o.r, L.spend.amountCol));
          if (a > 0) {
            const ex = notes['*BAZAR*|' + o.k], m = sm[o.k];
            entries.push({ id: newId_(), date: o.k, time: '', person: ex ? normBazar_(ex.lunch) : '', amount: a, details: cleanDet_(cellOf_(L, o.r, L.spend.detailsCol)),
              email: m ? String(m[1] || '') : '', name: m ? String(m[2] || '') : '' });
          }
        });
      }
      if (entries.length) writeLog_(entries);
    }
    P.setProperty('GL_MIGRATED', '1');
  } finally { if (!had) lock.releaseLock(); }
}


// RECOVERY (খাদ্য তথ্য script only): rebuild the grocery log from the amounts / details that sit in the sheet cells.
// Use it after restoring an old version of the sheet. Run it BEFORE opening the app.
function rebuildLogFromSheet() {
  if (SOURCE_URL) throw new Error('Run this in the খাদ্য তথ্য script, not in the বেলা হিসাব script');
  PropertiesService.getScriptProperties().deleteProperty('GL_MIGRATED');
  const gl = glTab_();
  if (gl.getLastRow() > 1) gl.getRange(2, 1, gl.getLastRow() - 1, GL_HEAD.length).clearContent();
  migrateOnce_();
  Logger.log('Grocery log rebuilt: ' + readLog_().length + ' entries');
}

// ---------- Drawing the grocery log into the sheet ----------
function groups_(L) {                       // rows of the spending table grouped by date (consecutive rows with the same date)
  const out = [];
  L.spend.rows.forEach(function (o) {
    const g = out[out.length - 1];
    if (g && g.k === o.k) g.rows.push(o.r); else out.push({ k: o.k, rows: [o.r] });
  });
  return out;
}
function blankSpec_(L) { return L.kind === 'blocks' ? { t: '', c: {}, n: {} } : { a: 0, d: '' }; }
function specOf_(L, e) {
  if (L.kind === 'blocks') { const c = {}, n = {}; c[e.person] = e.amount; if (String(e.details || '').trim()) n[e.person] = String(e.details).trim(); return { t: e.time || '', c: c, n: n }; }
  return { a: e.amount, d: detailLine_(e).trim() };
}
function curSpec_(L, r, notes) {
  if (L.kind === 'blocks') {
    const c = {}, n = {}, t = normTime_(cellOf_(L, r, L.dateCol + 1));
    NAMES.forEach(function (nm) {
      const col = L.spend.cols[nm]; if (col === undefined) return;
      const a = num_(cellOf_(L, r, col));
      if (a > 0) { c[nm] = a; const nt = String(((notes[r] || [])[col]) || '').trim(); if (nt) n[nm] = nt; }
    });
    return Object.keys(c).length ? { t: t, c: c, n: n } : { t: '', c: {}, n: {} };
  }
  const a = num_(cellOf_(L, r, L.spend.amountCol));
  return a > 0 ? { a: a, d: cleanDet_(cellOf_(L, r, L.spend.detailsCol)) } : { a: 0, d: '' };
}
function writeRow_(L, r, sp) {
  const sh = L.sh;
  if (L.kind === 'blocks') {
    NAMES.forEach(function (nm) {
      const col = L.spend.cols[nm]; if (col === undefined) return;
      const rg = sh.getRange(r + 1, col + 1);
      if (rg.isPartOfMerge()) rg.getMergedRanges().forEach(function (m) { m.breakApart(); });
      if (sp.c[nm]) { rg.setValue(sp.c[nm]); rg.setNote(sp.n[nm] || ''); } else { rg.setValue(''); rg.setNote(''); }
    });
    const tr = sh.getRange(r + 1, L.dateCol + 2); tr.setNumberFormat('@'); tr.setValue(sp.t || '');
  } else {
    sh.getRange(r + 1, L.spend.amountCol + 1).setValue(sp.a > 0 ? sp.a : '');
    const d = sh.getRange(r + 1, L.spend.detailsCol + 1); d.setValue(sp.d || ''); d.setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  }
}
// make the date group have exactly want.length rows (insert / delete extra rows under the date), then write them
function applyRows_(L, g, want) {
  const sh = L.sh, r0 = g.rows[0], cur = g.rows.length, need = want.length;
  let rows = g.rows.slice();
  if (need > cur) {
    const add = need - cur, last = g.rows[cur - 1], maxC = sh.getMaxColumns();
    sh.insertRowsAfter(last + 1, add);
    for (let i = 1; i <= add; i++) {
      const nr = last + i;
      if (L.kind === 'blocks') {                       // format only (do not repeat the meal / deposit numbers), then the date
        sh.getRange(r0 + 1, 1, 1, maxC).copyTo(sh.getRange(nr + 1, 1, 1, maxC), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
        sh.getRange(nr + 1, L.dateCol + 1).setValue(sh.getRange(r0 + 1, L.dateCol + 1).getValue());
      } else {                                         // copy the whole row so merged amount / details cells come along
        sh.getRange(r0 + 1, 1, 1, maxC).copyTo(sh.getRange(nr + 1, 1, 1, maxC));
      }
      rows.push(nr);
    }
  } else if (need < cur) {
    sh.deleteRows(rows[need] + 1, cur - need);
    rows = rows.slice(0, need);
  }
  rows.forEach(function (r, i) { writeRow_(L, r, want[i]); });
}
// Draw the log into the sheet. Only dates whose rows differ are touched. onlyDates = array of dates, or null for all.
function renderGrocery_(log, onlyDates) {
  const L = layout_(), notes = L.kind === 'blocks' ? L.sh.getDataRange().getNotes() : null;
  const by = {}, only = onlyDates ? onlyDates.reduce(function (m, d) { m[d] = 1; return m; }, {}) : null;
  sortEntries_(log).forEach(function (e) {
    if (L.kind === 'blocks' && NAMES.indexOf(e.person) < 0) return;     // cannot be placed without a বাজারকর্তা column (it stays safe in the log)
    (by[e.date] = by[e.date] || []).push(e);
  });
  const jobs = [];
  groups_(L).forEach(function (g) {
    if (only && !only[g.k]) return;
    const want = (by[g.k] || []).map(function (e) { return specOf_(L, e); });
    if (!want.length) want.push(blankSpec_(L));
    const have = g.rows.map(function (r) { return curSpec_(L, r, notes); });
    if (JSON.stringify(want) !== JSON.stringify(have)) jobs.push({ g: g, want: want });
  });
  if (!jobs.length) return 0;
  jobs.sort(function (a, b) { return b.g.rows[0] - a.g.rows[0]; });          // bottom first, so row numbers above stay valid
  jobs.forEach(function (j) { applyRows_(L, j.g, j.want); });
  SpreadsheetApp.flush();
  applyTotals_(true);
  return jobs.length;
}

// ---------- Totals ----------
function totalRow_(L, run) {
  const end = run[run.length - 1].r;
  for (let r = end + 1; r < Math.min(L.v.length, end + 8); r++) if (/^total/i.test(String((L.v[r] || [])[L.dateCol] || '').trim())) return r;
  return -1;
}
// overwrite=false: fill empty total cells. overwrite=true: only re-point existing =SUM(...) cells at the (possibly longer) date table.
function applyTotals_(overwrite) {
  const L = layout_(), sh = L.sh;
  const put = function (row, col, first, last) {
    const c = sh.getRange(row + 1, col + 1), f = c.getFormula();
    if (f) { if (!(overwrite && /^=SUM\(/i.test(f))) return; } else if (overwrite) return;
    const l = colLetter_(col + 1);
    c.setFormula('=SUM(' + l + (first + 1) + ':' + l + (last + 1) + ')');
  };
  const tables = L.kind === 'blocks' ? [L.meals, L.dep, L.spend] : [L.meals, L.dep];
  tables.forEach(function (t) {
    const run = L.kind === 'blocks' ? L.spend.rows : t.rows, tr = totalRow_(L, run);
    if (tr < 0) return;
    NAMES.forEach(function (n) { const c = t.cols[n]; if (c !== undefined) put(tr, c, run[0].r, run[run.length - 1].r); });
  });
  if (L.kind === 'stacked') {
    const run = L.spend.rows, tr = totalRow_(L, run);
    if (tr >= 0) put(tr, L.spend.amountCol, run[0].r, run[run.length - 1].r);
  }
}

// ---------- Actions ----------
function handle_(req) {
  let me;
  if (req.secret) {                      // the other sheet talking to this one (no signed-in user)
    if (!SYNC_SECRET || req.secret !== SYNC_SECRET) throw new Error('Bad sync secret');
    if (['load', 'importBazar'].indexOf(req.action) < 0) throw new Error('Not allowed');
    me = { email: '', name: SHEET_USER, admin: false, addFor: [], fundsFor: [], mealsFor: [], views: VIEW_KEYS.slice(),
      addSpending: false, canGrocery: false, canFunds: false, canMeals: false };
  } else me = me_(verify_(req.idToken));
  if (req.action === 'load') return load_(me);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let info = null;
  try {
    migrateOnce_();
    switch (req.action) {
      case 'setMeal': setMeal_(me, req); break;
      case 'addDeposit':
        // admin, or a person the admin allowed to add funds for this member (add only)
        if (!(me.admin || me.fundsFor.indexOf(req.person) >= 0))
          throw new Error('You are not allowed to add funds for ' + req.person);
        addDeposit_(me, req);
        if (!me.admin) log_(me, 'deposit', req.person, 'Deposit \u09F3' + Number(req.amount) + ' for ' + req.person + ' (' + req.date + ')');
        break;
      case 'editDeposit': editDeposit_(me, req); break;
      case 'addSpending': {
        if (!(me.admin || me.canGrocery)) throw new Error('You are not allowed to add grocery spending');
        const added = addSpending_(me, req);
        if (!me.admin) log_(me, 'spending', '', 'Grocery \u09F3' + added.reduce(function (t, e) { return t + e.amount; }, 0) + ' on ' + req.date +
          ' (' + added.map(function (e) { return (e.time ? e.time + ' ' : '') + e.person + ' \u09F3' + e.amount; }).join(', ') + ')');
        break;
      }
      case 'editSpending': editSpending_(me, req); break;
      case 'clearDeposit': admin_(me); clearDeposit_(req); break;
      case 'clearSpending': admin_(me); clearSpending_(req); break;
      case 'saveMember': admin_(me); saveMember_(req); break;
      case 'makeAdmin': admin_(me); makeAdmin_(req); break;
      case 'savePerms': admin_(me); savePerms_(req); break;
      case 'ackAlerts': admin_(me); ack_(req); break;
      case 'importBazar': info = importBazar_(req); break;
      // the app calls this on the other sheet after every change. Any group member may trigger it
      // (it only copies data FROM the source sheet), otherwise members' saves would fail to sync.
      case 'syncFromSource': info = syncFromSource_(me, req.idToken); break;
      default: throw new Error('Unknown action');
    }
  } finally { lock.releaseLock(); }
  return Object.assign({ ok: true }, info || {});
}

function load_(me) {
  migrateOnce_();
  const L = layout_(), v = L.v;
  const cell = function (r, c) { const x = (v[r] || [])[c]; return x === undefined ? '' : x; };
  const out = { ok: true, me: me, names: NAMES, layout: L.kind, meals: {}, deposits: {}, spending: [], mealDates: [], depDates: [], bazarRows: null, depositLog: [] };
  L.meals.rows.forEach(function (o) {
    out.mealDates.push(o.k); out.meals[o.k] = {};
    NAMES.forEach(function (n) { out.meals[o.k][n] = L.meals.cols[n] === undefined ? '' : cell(o.r, L.meals.cols[n]); });
  });
  L.dep.rows.forEach(function (o) {
    out.depDates.push(o.k); out.deposits[o.k] = {};
    NAMES.forEach(function (n) { out.deposits[o.k][n] = L.dep.cols[n] === undefined ? '' : cell(o.r, L.dep.cols[n]); });
  });

  // grocery: every purchase of this month, oldest first
  const sheetDates = {};
  L.spend.rows.forEach(function (o) { sheetDates[o.k] = 1; });
  out.spending = sortEntries_(readLog_().filter(function (e) { return sheetDates[e.date]; })).map(function (e) {
    return { id: e.id, date: e.date, time: e.time, amount: e.amount, details: e.details, bazarKorta: e.person, addedByEmail: e.email, addedByName: e.name };
  });
  if (L.kind === 'blocks') {              // the rows of the bazar block exactly as they are in the sheet (for the Sheet view)
    out.bazarRows = L.spend.rows.map(function (o) {
      const cells = {}; NAMES.forEach(function (n) { const c = L.spend.cols[n]; cells[n] = c === undefined ? '' : cell(o.r, c); });
      return { date: o.k, time: normTime_(cell(o.r, L.dateCol + 1)), cells: cells };
    });
  }

  // deposits: each deposit, plus (if the sheet cell holds more / less than the entries add up to) one "sheet entry" for the difference
  const depSet = {}, sums = {};
  out.depDates.forEach(function (d) { depSet[d] = 1; });
  readDepositLog_().forEach(function (e) {
    if (!depSet[e.date]) return;
    out.depositLog.push({ id: e.id, date: e.date, time: e.time, person: e.person, amount: e.amount, addedByEmail: e.email, addedByName: e.name, pseudo: false });
    sums[e.date + '|' + e.person] = r2_((sums[e.date + '|' + e.person] || 0) + e.amount);
  });
  out.depDates.forEach(function (d) {
    NAMES.forEach(function (n) {
      const diff = r2_(num_(out.deposits[d][n]) - (sums[d + '|' + n] || 0));
      if (Math.abs(diff) >= 0.01) out.depositLog.push({ id: 'rest|' + d + '|' + n, date: d, time: '', person: n, amount: diff, addedByEmail: '', addedByName: '', pseudo: true });
    });
  });
  out.depMeta = depMetaMap_();
  out.mealNotes = notes_();
  if (me.admin) { out.members = members_(); out.alerts = alerts_(); }
  return out;
}

// A person's sheet cell = number of meals: each filled box counts 1 (or the number typed in it).
function mealCount_(a, b) {
  let t = 0;
  [a, b].forEach(function (x) {
    x = String(x || '').trim();
    if (!x) return;
    t += /^[0-9]+(\.[0-9]+)?$/.test(x) ? parseFloat(x) : 1;
  });
  return t;
}
function setMeal_(me, q) {
  if (NAMES.indexOf(q.person) < 0) throw new Error('Unknown person');
  const mode = me.admin ? 'admin' : (me.name === q.person ? 'self' : (me.mealsFor.indexOf(q.person) >= 0 ? 'add' : ''));
  if (!mode) throw new Error('You are not allowed to edit meals for ' + q.person);
  const L = layout_(), row = L.meals.rows.find(function (o) { return o.k === q.date; });
  if (!row) throw new Error('That date is not in the sheet');
  const lunch = String(q.lunch || '').slice(0, 300), dinner = String(q.dinner || '').slice(0, 300);
  const range = L.sh.getRange(row.r + 1, L.meals.cols[q.person] + 1);
  if (mode === 'add') {
    const cur = range.getValue(), ex = notes_()[q.person + '|' + q.date] || { lunch: '', dinner: '' };
    const has = cur !== '' && cur !== null && cur !== 'N/A';
    if (!lunch && !dinner) throw new Error('Nothing to add');
    if (has && !ex.lunch && !ex.dinner) throw new Error('This entry already exists. Only the admin can change it');
    if ((ex.lunch && lunch !== ex.lunch) || (ex.dinner && dinner !== ex.dinner)) throw new Error('Saved entries can only be changed by the admin');
  }
  const n = mealCount_(lunch, dinner);
  range.setValue(n > 0 ? n : '');
  const s = tab_('MealDetails', ['Date', 'Person', 'Lunch', 'Dinner'], true), d = s.getDataRange().getValues();
  let r = -1;
  for (let i = 1; i < d.length; i++) if ((dateKey_(d[i][0]) || String(d[i][0])) === q.date && d[i][1] === q.person) { r = i + 1; break; }
  if (r < 0) r = s.getLastRow() + 1;
  s.getRange(r, 1, 1, 4).setValues([[q.date, q.person, lunch, dinner]]);
  if (mode === 'add') log_(me, 'meal', q.person, 'Meal details for ' + q.person + ' on ' + q.date);
}

// ---------- Deposits ----------
function depCell_(q) {
  if (NAMES.indexOf(q.person) < 0) throw new Error('Unknown person');
  const L = layout_(), row = L.dep.rows.find(function (o) { return o.k === q.date; });
  if (!row) throw new Error('That date is not in the sheet');
  return { L: L, range: L.sh.getRange(row.r + 1, L.dep.cols[q.person] + 1) };
}
function setDepCell_(c, val) { val = r2_(val); c.range.setValue(val > 0 ? val : ''); }
function addDeposit_(me, q) {
  const amt = Number(q.amount); if (!isFinite(amt) || amt <= 0) throw new Error('Enter a valid amount');
  const c = depCell_(q), np = nowParts_();
  setDepCell_(c, num_(c.range.getValue()) + amt);
  const dl = readDepositLog_();
  dl.push({ id: newId_(), date: q.date, time: np.time, person: q.person, amount: amt, email: me.email, name: me.name });
  writeDepositLog_(dl);
  saveDepositMeta_(q.date, q.person, me);
}
function latestDepositDate_(L, person) {
  let best = '';
  L.dep.rows.forEach(function (o) { if (num_((L.v[o.r] || [])[L.dep.cols[person]]) > 0 && o.k > best) best = o.k; });
  return best;
}
// Edit one deposit entry (id), or the "sheet entry" (id 'rest|date|person'). Admin: any. A member: only their own latest deposit date.
function editDeposit_(me, q) {
  const amt = Number(q.amount), id = String(q.id || ''), isRest = id.indexOf('rest|') === 0;
  if (!isFinite(amt) || (!isRest && amt < 0)) throw new Error('Enter a valid amount');
  const c = depCell_(q);
  if (!me.admin) {
    if (me.name !== q.person) throw new Error('Only the admin or ' + q.person + ' can edit this deposit');
    if (amt <= 0) throw new Error('Only the admin can remove a deposit');
    if (latestDepositDate_(c.L, q.person) !== q.date) throw new Error('You can only edit your own latest deposit');
  }
  const dl = readDepositLog_(), cur = num_(c.range.getValue());
  const mine = dl.filter(function (e) { return e.date === q.date && e.person === q.person; });
  const sum = mine.reduce(function (t, e) { return t + e.amount; }, 0);
  let old;
  if (!id) { old = cur; setDepCell_(c, amt); }
  else if (isRest) { old = cur - sum; setDepCell_(c, sum + amt); }
  else {
    const e = mine.find(function (x) { return x.id === id; });
    if (!e) throw new Error('Deposit entry not found');
    old = e.amount;
    setDepCell_(c, cur - e.amount + amt);
    if (amt > 0) e.amount = amt; else dl.splice(dl.indexOf(e), 1);
    writeDepositLog_(dl);
  }
  if (!me.admin) log_(me, 'deposit', q.person, 'Edited deposit on ' + q.date + ': \u09F3' + r2_(old) + ' \u2192 \u09F3' + amt);
}
function clearDeposit_(q) {
  const c = depCell_(q), id = String(q.id || ''), dl = readDepositLog_(), cur = num_(c.range.getValue());
  const mine = dl.filter(function (e) { return e.date === q.date && e.person === q.person; });
  if (!id) { c.range.setValue(''); writeDepositLog_(dl.filter(function (e) { return mine.indexOf(e) < 0; })); }
  else if (id.indexOf('rest|') === 0) setDepCell_(c, mine.reduce(function (t, e) { return t + e.amount; }, 0));
  else {
    const e = mine.find(function (x) { return x.id === id; });
    if (!e) throw new Error('Deposit entry not found');
    setDepCell_(c, cur - e.amount);
    writeDepositLog_(dl.filter(function (x) { return x !== e; }));
  }
  if (!id || mine.length <= 1) {                     // nothing left for this person on this date: forget who added it
    const s = depositMeta_(), r = metaRow_(s, [q.date, q.person]);
    if (r && num_(c.range.getValue()) <= 0) s.getRange(r, 1, 1, 4).setValues([['', '', '', '']]);
  }
}

// ---------- Grocery actions ----------
function cleanItem_(it, date, q) {
  const person = String(it.bazarKorta || it.person || '').trim();
  if (NAMES.indexOf(person) < 0) throw new Error('Choose the \u09AC\u09BE\u099C\u09BE\u09B0\u0995\u09B0\u09CD\u09A4\u09BE (who did the bazar) for every purchase');
  const amount = Number(it.amount); if (!isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount for every purchase');
  const time = normTime_(it.time);
  if (!time) throw new Error('Enter the time of every purchase');
  checkNotFuture_(date, time, q);
  return { person: person, amount: amount, time: time, details: String(it.details || '').trim().slice(0, 3000) };
}
// q.items = [{ bazarKorta, time, amount, details }, ...]  all on q.date. Every item becomes its own row under that date in the sheet.
function addSpending_(me, q) {
  const date = String(q.date || '');
  const items = Array.isArray(q.items) && q.items.length ? q.items : [{ bazarKorta: q.bazarKorta, time: q.time || nowParts_().time, amount: q.amount, details: q.details }];
  const L = layout_();
  if (!L.spend.rows.some(function (o) { return o.k === date; })) throw new Error('That date is not in the sheet');
  const fresh = items.map(function (it) { return cleanItem_(it, date, q); });      // validate everything first: nothing is saved if one is wrong
  const log = readLog_();
  if (log.filter(function (e) { return e.date === date; }).length + fresh.length > MAX_PER_DATE) throw new Error('Too many purchases on one date (max ' + MAX_PER_DATE + ')');
  const added = fresh.map(function (f) {
    return { id: newId_(), date: date, time: f.time, person: f.person, amount: f.amount, details: f.details, email: me.email, name: me.name };
  });
  const all = log.concat(added);
  writeLog_(all);
  renderGrocery_(all, [date]);
  return added;
}
// Admin: any entry. A member with the grocery permission: only an entry of the latest date, and only if they added it.
function editSpending_(me, q) {
  const log = readLog_(), e = log.find(function (x) { return x.id === String(q.id || ''); });
  if (!e) throw new Error('Grocery entry not found');
  const amt = Number(q.amount); if (!isFinite(amt) || amt < 0) throw new Error('Enter a valid amount');
  const person = q.bazarKorta ? String(q.bazarKorta).trim() : e.person;
  if (NAMES.indexOf(person) < 0) throw new Error('Choose the \u09AC\u09BE\u099C\u09BE\u09B0\u0995\u09B0\u09CD\u09A4\u09BE from the listed people');
  const time = q.time !== undefined && q.time !== '' ? normTime_(q.time) : e.time;
  if (q.time !== undefined && q.time !== '' && !time) throw new Error('Enter a valid time');
  if (!me.admin) {
    if (!me.canGrocery) throw new Error('You do not have the grocery permission');
    if (amt <= 0) throw new Error('Only the admin can remove a grocery entry');
    if (latestSpendDate_(log) !== e.date) throw new Error('Only the latest grocery entries can be edited');
    if (!e.email || e.email !== me.email) throw new Error('Only the person who added this entry (or the admin) can edit it');
  }
  if (time !== e.time) checkNotFuture_(e.date, time, q);
  const old = e.amount;
  if (amt === 0) log.splice(log.indexOf(e), 1);
  else { e.amount = amt; e.person = person; e.time = time; if (q.details !== undefined) e.details = String(q.details).trim().slice(0, 3000); }
  writeLog_(log); renderGrocery_(log, [e.date]);
  if (!me.admin) log_(me, 'spending', '', 'Edited grocery on ' + e.date + ': \u09F3' + old + ' \u2192 \u09F3' + amt);
}
function clearSpending_(q) {
  const log = readLog_(), e = log.find(function (x) { return x.id === String(q.id || ''); });
  if (!e) throw new Error('Grocery entry not found');
  const rest = log.filter(function (x) { return x !== e; });
  writeLog_(rest); renderGrocery_(rest, [e.date]);
}

function saveMember_(q) {
  if (NAMES.indexOf(q.name) < 0) throw new Error('Unknown name');
  const email = String(q.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid Google email');
  const list = members_(), s = tab_('Members', MEMBER_HEADERS);
  if (list.some(function (m) { return m.email === email && m.name !== q.name; })) throw new Error('That email is already used by someone else');
  const cur = list.find(function (m) { return m.name === q.name; });
  if (cur) s.getRange(cur.row, 1).setValue(email);
  else s.appendRow([email, q.name, false, '', false, false, false, false, '', '', '']);
}
function makeAdmin_(q) {
  const email = String(q.email || '').trim().toLowerCase(), list = members_(), s = tab_('Members', MEMBER_HEADERS);
  if (!list.some(function (m) { return m.email === email; })) throw new Error('Not a member');
  list.forEach(function (m) { s.getRange(m.row, 3).setValue(m.email === email); });
}
function savePerms_(q) {
  const email = String(q.email || '').trim().toLowerCase(), m = members_().find(function (x) { return x.email === email; });
  if (!m) throw new Error('Not a member');
  const clean = function (a) { return (Array.isArray(a) ? a : []).filter(function (n) { return NAMES.indexOf(n) >= 0 && n !== m.name; }); };
  const funds = clean(q.fundsFor), meals = clean(q.mealsFor);
  const union = NAMES.filter(function (n) { return funds.indexOf(n) >= 0 || meals.indexOf(n) >= 0; });
  const views = (Array.isArray(q.views) ? q.views : []).filter(function (k) { return VIEW_KEYS.indexOf(k) >= 0; });
  tab_('Members', MEMBER_HEADERS).getRange(m.row, 4, 1, 8).setValues([[union.join(','), !!q.canGrocery, !!q.canGrocery,
    funds.length > 0, meals.length > 0, funds.join(',') || '-', meals.join(',') || '-', views.join(',') || '-']]);
}

// ---------- Activity log + alerts for the admin ----------
function activity_() { return tab_('Activity', ['Time', 'By', 'Type', 'For', 'Detail', 'Acknowledged'], true); }
function log_(me, type, forName, detail) {
  const s = activity_(), r = s.getLastRow() + 1;
  s.getRange(r, 1, 1, 6).setValues([[new Date().toISOString(), me.name, type, forName || '', String(detail).slice(0, 500), false]]);
}
function alerts_() {
  const d = activity_().getDataRange().getValues(), out = [];
  for (let i = 1; i < d.length; i++) {
    if (!d[i][0] || bool_(d[i][5])) continue;
    out.push({ row: i + 1, time: String(d[i][0]), by: d[i][1], type: d[i][2], forName: d[i][3], detail: d[i][4] });
  }
  return out.slice(-100);
}
function ack_(q) {
  const s = activity_(), d = s.getDataRange().getValues();
  if (d.length < 2) return;
  const col = [];
  for (let i = 1; i < d.length; i++) {
    let v = bool_(d[i][5]);
    if (!v && d[i][0] && (q.all || (q.type && d[i][2] === q.type))) v = true;
    col.push([v]);
  }
  s.getRange(2, 6, col.length, 1).setValues(col);
}

// ---------- One-time setup: run this once from the editor ----------
function setup() {
  tab_('Members', MEMBER_HEADERS);
  tab_('MealDetails', ['Date', 'Person', 'Lunch', 'Dinner'], true);
  activity_(); members_(); depositMeta_(); glTab_(); dlTab_();
  migrateOnce_();
  applyTotals_(false);
}

// ---------- Monthly rollover ----------
// The FIRST tab is always the current month. When a new month begins, this copies it (same layout, formats,
// merged cells, formulas), blanks all entries, writes the new month's dates (one row per day), and renames the OLD tab
// to its month, e.g. "October 2026". The grocery / deposit logs of the old month are renamed along with it.
function monthlyRollover() { return rollover_(false); }       // runs by itself every day (~1 AM); acts only once a new month has begun
function rolloverNextMonthNow() { return rollover_(true); }   // optional: build the month after the current tab right now
function installMonthlyTrigger() {                            // run ONCE from the editor, in each script
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'monthlyRollover') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('monthlyRollover').timeBased().everyDays(1).atHour(1).create();
}

function rollover_(force) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = ss_(), cur = main_(), first = layout_(cur).meals.rows[0].k;
    const y = Number(first.slice(0, 4)), m = Number(first.slice(5, 7));
    let ty = y, tm = m + 1;
    if (tm > 12) { tm = 1; ty++; }
    if (!force) {
      const today = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM');
      if (first.slice(0, 7) >= today) { Logger.log('Nothing to do: the first tab is already ' + first.slice(0, 7)); return 'Nothing to do'; }
      ty = Number(today.slice(0, 4)); tm = Number(today.slice(5, 7));
    }
    let liveName = cur.getName(), archive = MONTH_NAMES[m - 1] + ' ' + y, k = 2;
    while (archive !== cur.getName() && ss.getSheetByName(archive)) archive = MONTH_NAMES[m - 1] + ' ' + y + ' (' + (k++) + ')';
    if (liveName === archive) liveName = 'Current month';

    const copy = cur.copyTo(ss);
    copy.setName('new_' + Date.now());
    try { prepareMonth_(copy, ty, tm); }
    catch (e) { ss.deleteSheet(copy); throw e; }

    cur.setName(archive);
    copy.setName(liveName);
    ss.setActiveSheet(copy);
    ss.moveActiveSheet(1);
    ['GroceryLog', 'DepositLog'].forEach(function (n) {           // keep last month's logs next to last month's tab
      const t = ss.getSheetByName(n);
      if (t) { try { t.setName(n + ' ' + archive); } catch (e) { Logger.log('Could not rename ' + n + ': ' + e.message); } }
    });
    const msg = 'New tab for ' + MONTH_NAMES[tm - 1] + ' ' + ty + ' is ready. The old tab is now "' + archive + '".';
    Logger.log(msg);
    return msg;
  } finally { lock.releaseLock(); }
}

function removeExtras_(sh) {                 // extra rows (more purchases on one date) are not carried into a new month
  const L = layout_(sh), dup = [];
  const runs = L.kind === 'blocks' ? [L.spend.rows] : [L.meals.rows, L.spend.rows, L.dep.rows];
  runs.forEach(function (run) { run.forEach(function (o, i) { if (i > 0 && o.k === run[i - 1].k) dup.push(o.r); }); });
  dup.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r + 1); });
}

// Turns a copy of the old tab into an empty tab for the given month (month = 1..12).
function prepareMonth_(sh, year, month) {
  const days = new Date(year, month, 0).getDate();
  const distinct = function (L) {
    const runs = [];
    [L.meals.rows, L.spend.rows, L.dep.rows].forEach(function (r) { if (runs.indexOf(r) < 0) runs.push(r); });
    return runs;
  };
  removeExtras_(sh);

  // 1) one row per day in every date table (work bottom-to-top so the row numbers above stay valid)
  let L = layout_(sh);
  const fromCol = L.dateCol + 1, width = sh.getMaxColumns() - L.dateCol;
  distinct(L).sort(function (a, b) { return b[0].r - a[0].r; }).forEach(function (rows) {
    const n = rows.length, firstRow = rows[0].r + 1, lastRow = rows[n - 1].r + 1;
    if (days > n) {
      if (n < 2) throw new Error('A date table needs at least 2 rows to be copied');
      const add = days - n;
      sh.insertRowsBefore(lastRow, add);
      for (let i = 0; i < add; i++) sh.getRange(lastRow - 1, fromCol, 1, width).copyTo(sh.getRange(lastRow + i, fromCol, 1, width));
    } else if (days < n) {
      sh.deleteRows(firstRow + days, n - days);
    }
  });
  SpreadsheetApp.flush();

  // 2) write the new dates and blank the entries (formulas, if any, are kept)
  L = layout_(sh);
  const tz = tz_(), dateVals = [];
  for (let d = 1; d <= days; d++) dateVals.push([Utilities.parseDate(year + '-' + p2_(month) + '-' + p2_(d), tz, 'yyyy-MM-dd')]);
  distinct(L).forEach(function (rows) {
    if (rows.length !== days) throw new Error('Row count mismatch: expected ' + days + ' rows, found ' + rows.length);
    sh.getRange(rows[0].r + 1, L.dateCol + 1, days, 1).setValues(dateVals);
  });
  const clearCol = function (rows, col) {
    if (col === undefined || col < 0) return;
    const rng = sh.getRange(rows[0].r + 1, col + 1, rows.length, 1);
    rng.setValues(rng.getFormulas().map(function (r) { return [r[0] || '']; }));
  };
  NAMES.forEach(function (n) {
    clearCol(L.meals.rows, L.meals.cols[n]);
    clearCol(L.dep.rows, L.dep.cols[n]);
    if (L.kind === 'blocks') clearCol(L.spend.rows, L.spend.cols[n]);
  });
  if (L.kind === 'blocks') {                       // grocery details are cell notes, times sit next to the date: clear them too
    NAMES.forEach(function (n) {
      const c = L.spend.cols[n];
      if (c !== undefined) sh.getRange(L.spend.rows[0].r + 1, c + 1, L.spend.rows.length, 1).clearNote();
    });
    sh.getRange(L.spend.rows[0].r + 1, L.dateCol + 2, L.spend.rows.length, 1).clearContent();
  } else {
    clearCol(L.spend.rows, L.spend.amountCol);
    clearCol(L.spend.rows, L.spend.detailsCol);
  }
  SpreadsheetApp.flush();
}

// ---------- Sync: copy the source sheet's data into THIS sheet (layout untouched) ----------
function writeCol_(sh, rows, col, valueOf) {        // rows = the real (first) row of every date; extra rows in between are left alone
  const r0 = rows[0].r, rng = sh.getRange(r0 + 1, col + 1, rows[rows.length - 1].r - r0 + 1, 1);
  const vals = rng.getValues(), fx = rng.getFormulas();
  rows.forEach(function (o) {
    const i = o.r - r0;
    let v = valueOf(o.k);
    if (v === undefined || fx[i][0]) return;          // not in source / keep formulas
    if (v === null) v = '';
    if (String(vals[i][0]) !== String(v)) sh.getRange(o.r + 1, col + 1).setValue(v);
  });
}
function rewriteTab_(name, headers, rows) {
  const s = tab_(name, headers, true), last = s.getLastRow();
  if (last > 1) s.getRange(2, 1, last - 1, headers.length).clearContent();
  if (rows.length) s.getRange(2, 1, rows.length, headers.length).setValues(rows);
}
function callSource_(body) {
  const resp = UrlFetchApp.fetch(SOURCE_URL, { method: 'post', contentType: 'text/plain', followRedirects: true, muteHttpExceptions: true, payload: JSON.stringify(body) });
  let j;
  try { j = JSON.parse(resp.getContentText()); } catch (e) { throw new Error('Source sheet did not answer (check SOURCE_URL and its deployment access)'); }
  if (!j.ok) throw new Error('Source sheet: ' + (j.error || 'request failed'));
  return j;
}
function syncFromSource_(me, idToken) {
  if (!SOURCE_URL) throw new Error("SOURCE_URL is not set in this sheet's script");
  const first = layout_();
  if (first.kind === 'blocks') pushFromSheet_(first);      // anything typed by hand in this sheet goes to the source BEFORE we overwrite it
  const src = callSource_({ action: 'load', idToken: idToken });

  const L = layout_(), sh = L.sh, warn = [];
  const blankNa = function (k, v) {
    return (k >= BLANK_NA_FROM && k <= BLANK_NA_TO && String(v).trim().toUpperCase() === 'N/A') ? '' : v;
  };

  // meals + deposits: same cells, same people, same dates
  NAMES.forEach(function (n) {
    if (L.meals.cols[n] !== undefined) writeCol_(sh, L.meals.rows, L.meals.cols[n], function (k) { return src.meals && src.meals[k] ? blankNa(k, src.meals[k][n]) : undefined; });
    if (L.dep.cols[n] !== undefined) writeCol_(sh, L.dep.rows, L.dep.cols[n], function (k) { return src.deposits && src.deposits[k] ? blankNa(k, src.deposits[k][n]) : undefined; });
  });

  // deposit log (each deposit)
  writeDepositLog_((src.depositLog || []).filter(function (e) { return !e.pseudo; }).map(function (e) {
    return { id: e.id, date: e.date, time: e.time || '', person: e.person, amount: num_(e.amount), email: e.addedByEmail || '', name: e.addedByName || '' };
  }));

  // grocery log: copy every purchase, then draw them (extra rows are inserted / removed under each date).
  // Entries with no বাজারকর্তা are kept in the log but simply not drawn in this sheet (no warning).
  const glog = (src.spending || []).filter(function (e) { return num_(e.amount) > 0; }).map(function (e) {
    return { id: e.id, date: e.date, time: e.time || '', person: e.bazarKorta || '', amount: num_(e.amount), details: cleanDet_(e.details), email: e.addedByEmail || '', name: e.addedByName || '' };
  });
  writeLog_(glog);
  renderGrocery_(glog, null);

  // notes (lunch / dinner text) + who-added info
  const notes = [];
  Object.keys(src.mealNotes || {}).forEach(function (key) {
    const i = key.indexOf('|'), person = key.slice(0, i), date = key.slice(i + 1), n = src.mealNotes[key];
    if (person === '*BAZAR*') return;
    notes.push([date, person, n.lunch || '', n.dinner || '']);
  });
  rewriteTab_('MealDetails', ['Date', 'Person', 'Lunch', 'Dinner'], notes);
  const dm = [];
  Object.keys(src.depMeta || {}).forEach(function (key) {
    const i = key.indexOf('|'), m = src.depMeta[key];
    dm.push([key.slice(0, i), key.slice(i + 1), m.email || '', m.name || '']);
  });
  rewriteTab_('DepositMeta', ['Date', 'Person', 'AddedByEmail', 'AddedByName'], dm);

  return { warn: warn.join('; ') };
}

// ---------- বেলা হিসাব -> খাদ্য তথ্য: purchases typed by hand in the bazar block ----------
// Reads the bazar block (date, time column next to the date, person columns, cell notes = details).
function sheetEntries_(L) {
  const notes = L.sh.getDataRange().getNotes(), out = {};
  groups_(L).forEach(function (g) {
    const list = [];
    g.rows.forEach(function (r) {
      const t = normTime_(cellOf_(L, r, L.dateCol + 1));
      NAMES.forEach(function (nm) {
        const col = L.spend.cols[nm]; if (col === undefined) return;
        const a = num_(cellOf_(L, r, col));
        if (a > 0) list.push({ time: t, person: nm, amount: a, note: String(((notes[r] || [])[col]) || '').trim() });
      });
    });
    out[g.k] = list;
  });
  return out;
}
// Match what is in the sheet with the entries we already know (same person + time first, then same person), keeping their id / details / author.
function reconcile_(date, sheetList, existing) {
  const left = existing.slice(), matched = sheetList.map(function () { return null; });
  sheetList.forEach(function (s, i) {
    const j = left.findIndex(function (e) { return e.person === s.person && e.time === s.time; });
    if (j >= 0) matched[i] = left.splice(j, 1)[0];
  });
  sheetList.forEach(function (s, i) {
    if (matched[i]) return;
    const j = left.findIndex(function (e) { return e.person === s.person; });
    if (j >= 0) matched[i] = left.splice(j, 1)[0];
  });
  return sheetList.map(function (s, i) {
    const e = matched[i];
    return { id: e ? e.id : '', date: date, time: s.time, person: s.person, amount: s.amount, details: s.note || (e ? e.details : ''),
      email: e ? e.email : '', name: e ? e.name : SHEET_USER };
  });
}
function sig_(list) {
  return JSON.stringify(list.map(function (e) { return [e.time || '', e.person, Number(e.amount), String(e.details || '').trim()]; })
    .sort(function (a, b) { return JSON.stringify(a) < JSON.stringify(b) ? -1 : 1; }));
}
function pushFromSheet_(L) {
  if (!SOURCE_URL) return 0;
  const log = readLog_(), today = nowParts_().date, sheet = sheetEntries_(L), byDate = {}, changes = {};
  log.forEach(function (e) { (byDate[e.date] = byDate[e.date] || []).push(e); });
  let future = 0;
  Object.keys(sheet).forEach(function (d) {
    if (d > today) { if (sheet[d].length) future++; return; }                 // never push future dates
    // entries that have no বাজারকর্তা cannot be shown in this sheet, so they are carried along untouched (never deleted)
    const keep = (byDate[d] || []).filter(function (e) { return NAMES.indexOf(e.person) < 0; });
    const known = (byDate[d] || []).filter(function (e) { return NAMES.indexOf(e.person) >= 0; });
    const merged = reconcile_(d, sheet[d], known).concat(keep);
    if (sig_(merged) !== sig_(byDate[d] || [])) changes[d] = merged;
  });
  if (future) { try { ss_().toast('Grocery entries on future dates are ignored and will be cleared.', 'বেলা হিসাব', 8); } catch (e) { /* no UI */ } }
  const dates = Object.keys(changes);
  if (!dates.length) return 0;
  const res = callSource_({ action: 'importBazar', secret: SYNC_SECRET, changes: changes });
  const canon = res.entries || {};
  const next = log.filter(function (e) { return !canon[e.date]; });         // replace those dates with the source's version (it knows the ids)
  Object.keys(canon).forEach(function (d) { canon[d].forEach(function (e) { next.push(e); }); });
  writeLog_(next);
  return dates.length;
}
// Runs (as an installable trigger) after every manual edit in this spreadsheet.
function onBazarEdit(e) {
  try {
    if (!SOURCE_URL || !e || !e.range) return;
    if (e.range.getSheet().getSheetId() !== main_().getSheetId()) return;
    const L = layout_();
    if (L.kind !== 'blocks') return;
    const r1 = e.range.getRow() - 1, r2 = e.range.getLastRow() - 1, c1 = e.range.getColumn() - 1, c2 = e.range.getLastColumn() - 1;
    const cols = NAMES.map(function (n) { return L.spend.cols[n]; }).filter(function (c) { return c !== undefined; }).concat([L.dateCol + 1]);
    if (!L.spend.rows.some(function (o) { return o.r >= r1 && o.r <= r2; }) || !cols.some(function (c) { return c >= c1 && c <= c2; })) return;
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return;                // the 5-minute sweep will pick it up
    try { pushFromSheet_(L); } finally { lock.releaseLock(); }
  } catch (err) { Logger.log('onBazarEdit: ' + err.message); }    // not pushed now: bazarSweep retries every 5 minutes
}
// Safety net: catches note edits (Sheets does not fire onEdit for notes) and pushes that failed earlier.
function bazarSweep() {
  if (!SOURCE_URL) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try { const L = layout_(); if (L.kind === 'blocks') pushFromSheet_(L); }
  catch (err) { Logger.log('bazarSweep: ' + err.message); }
  finally { lock.releaseLock(); }
}
function installBazarTriggers() {                     // run ONCE from the editor in the বেলা হিসাব script
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['onBazarEdit', 'bazarSweep'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onBazarEdit').forSpreadsheet(ss_()).onEdit().create();
  ScriptApp.newTrigger('bazarSweep').timeBased().everyMinutes(5).create();
}

// খাদ্য তথ্য side: receives the purchases found in the বেলা হিসাব sheet. For every date it was given, the log of that date is replaced.
function importBazar_(q) {
  if (SOURCE_URL) throw new Error('Only the খাদ্য তথ্য sheet accepts this');
  const L = layout_(), valid = {}, today = nowParts_().date, log = readLog_(), out = {}, changes = q.changes || {};
  L.spend.rows.forEach(function (o) { valid[o.k] = 1; });
  Object.keys(changes).forEach(function (d) {
    if (!valid[d] || d > today) return;
    const old = log.filter(function (e) { return e.date === d; });
    out[d] = (changes[d] || []).slice(0, MAX_PER_DATE).map(function (s) {
      const person = String(s.person || ''), amount = Number(s.amount), prev = s.id ? old.find(function (o) { return o.id === s.id; }) : null;
      if (!(amount > 0)) return null;
      if (NAMES.indexOf(person) < 0 && !prev) return null;                     // an unknown person is only accepted for an entry that already existed
      return { id: prev ? prev.id : newId_(), date: d, time: normTime_(s.time), person: person, amount: amount, details: String(s.details || '').trim().slice(0, 3000),
        email: prev ? prev.email : String(s.email || ''), name: prev ? prev.name : String(s.name || SHEET_USER) };
    }).filter(Boolean);
    // entries of this date that have no বাজারকর্তা are never removed by a sync from the other sheet
    const kept = out[d].map(function (e) { return e.id; });
    old.forEach(function (e) { if (NAMES.indexOf(e.person) < 0 && kept.indexOf(e.id) < 0) out[d].push(e); });
  });
  const dates = Object.keys(out);
  if (!dates.length) return { entries: {} };
  const next = log.filter(function (e) { return dates.indexOf(e.date) < 0; });
  dates.forEach(function (d) { out[d].forEach(function (e) { next.push(e); }); });
  writeLog_(next);
  renderGrocery_(next, dates);
  log_({ name: SHEET_USER }, 'spending', '', 'Grocery changed in the বেলা হিসাব sheet on ' + dates.join(', '));
  return { entries: out };
}
