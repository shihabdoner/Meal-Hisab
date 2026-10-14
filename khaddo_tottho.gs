//khaddo tottho appscript (খাদ্য তথ্য)  — v2 (Batch 1 applied)
/** Meal-fund API. Google Sheets stays the source of truth.
 *  Same code in BOTH scripts (খাদ্য তথ্য and বেলা হিসাব). Only SOURCE_URL (and the doGet text) differ.
 *
 *  Grocery entries live in the "GroceryLog" tab (one row per purchase: date, time, বাজারকর্তা, amount, details).
 *  Deposits live in the "DepositLog" tab (one row per deposit). The date tables in the sheet are drawn from these logs:
 *  a date with 3 purchases gets 3 rows (extra rows are inserted under the date, time in the column next to the date).
 *  Edits typed directly into the বেলা হিসাব bazar block are pushed back to খাদ্য তথ্য (see onBazarEdit / bazarSweep).
 *  Entries that have no বাজারকর্তা stay in খাদ্য তথ্য / the app and are never touched by the বেলা হিসাব sync.
 *
 *  v2: the sync secret is NOT in this file any more. Set it by hand in Project Settings → Script properties
 *  as SYNC_SECRET (identical value, at least 24 characters, in BOTH projects). */
const FIREBASE_API_KEY = 'AIzaSyAfp6ACmE3d-9iAieAp1knA40qKEbdcx7Y'; // same key as firebase-config.js (a public web key)
const NAMES = ['Shohan', 'Naved', 'Salman', 'Rifat', 'Shihab', 'Ashmit'];
const MONTHS = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11};
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MEMBER_HEADERS = ['Email', 'Name', 'Admin', 'AddFor', 'AddSpending', 'CanGrocery', 'CanFunds', 'CanMeals', 'FundsFor', 'MealsFor', 'Views'];
const VIEW_KEYS = ['sheetMeals','sheetSpending','sheetDeposits','myDep','resid','due','lastFund','lastDate','lastGrocery','totalFund','totalSpent','left'];
// In the "বেলা হিসাব" (Bazar hisab) script this is the খাদ্য তথ্য web app URL. In the খাদ্য তথ্য script it stays ''.
const SOURCE_URL = '';

// TEMPORARY RULE (Bazar hisab only, October 2026): when copying from khaddo, show 'N/A' as BLANK for these dates.
const BLANK_NA_FROM = '2026-10-01';
const BLANK_NA_TO = '2026-10-08';

const GL_HEAD = ['ID', 'Date', 'Time', 'Person', 'Amount', 'Details', 'AddedByEmail', 'AddedByName'];
const DL_HEAD = ['ID', 'Date', 'Time', 'Person', 'Amount', 'AddedByEmail', 'AddedByName'];
const MAX_PER_DATE = 15;
const SHEET_USER = 'বেলা হিসাব sheet';

// Takes the script lock. If it stays busy, nothing has been changed yet and the message starts with BUSY (the app retries it).
function getLock_(ms) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(ms); }
  catch (e) { throw new Error('BUSY: another save is still running. Nothing was changed, please try again in a few seconds.'); }
  return lock;
}
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
function parseLine_(s) {
  const names = NAMES.map(function (n) {
    return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('|');
  const m = String(s || '').match(new RegExp(
    '^\\s*(?:\\[(\\d{1,2}:\\d{2})\\]\\s*)?(' + names + ')\\b\\s*:?\\s*([\\s\\S]*)$', 'i'
  ));
  const person = m ? NAMES.find(function (n) { return n.toLowerCase() === m[2].toLowerCase(); }) : '';
  return m ? {
    time: normTime_(m[1] || ''),
    person: person || m[2],
    details: m[3].trim()
  } : { time: '', person: '', details: String(s || '').trim() };
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
  const dk = dateKeys_(sh, v, dateCol), runs = []; let cur = null;
  for (let r = 0; r < v.length; r++) {
    const k = dk[r];

    if (k) { if (!cur) { cur = []; runs.push(cur); } cur.push({ r: r, k: k }); } else cur = null;
  }
  // new sheet: ONE date column with three blocks side by side (meal | bazar | deposit)
  if (runs.length < 3) return blocksLayout_(sh, v, width, dateCol, runs, dk);

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

  return { kind: 'stacked', sh: sh, v: v, dateCol: dateCol, dk: dk, fixed: dk.fixed,
    meals: { rows: primary_(runs[0]), cols: colsFor(runs[0][0].r) },
    spend: { rows: runs[1], amountCol: amountCol, detailsCol: detailsCol },
    dep: { rows: primary_(runs[2]), cols: colsFor(runs[2][0].r) },
    bazar: { col: -1, rows: null } };
}

// Side-by-side layout: one date column, then three blocks of 6 name columns: মিল হিসাব | বাজার হিসাব | জমা টাকার হিসাব.
// The bazar amount is written in the cell of the বাজারকর্তা person; the time sits in the column right of the date.
function blocksLayout_(sh, v, width, dateCol, runs, dk) {
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
  return { kind: 'blocks', sh: sh, v: v, dateCol: dateCol, dk: dk, fixed: dk.fixed,
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
// True when the sheet already holds exactly these rows (same row count, same cell values). Values only: a difference
// (or a type that reads back differently, e.g. a date turned into a Date object) simply makes the caller rewrite as before.
function sameRows_(s, last, width, rows) {
  if (last - 1 !== rows.length) return false;
  if (!rows.length) return true;
  const cur = s.getRange(2, 1, rows.length, width).getValues();
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < width; j++) {
      const a = cur[i][j], b = rows[i][j];
      if (
        String(a === null || a === undefined ? '' : a) !==
        String(b === null || b === undefined ? '' : b)
      ) {
        return false;
      }
    }
  }
  return true;
}
// (v2: writeLog_ moved to the "v2 additions" section at the end of this file)
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
// (v2: writeDepositLog_ moved to the "v2 additions" section at the end of this file)

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
  if (!had) lock.waitLock(20000);
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
            const line = parseLine_(cleanDet_(cellOf_(L, o.r, L.spend.detailsCol)));
            entries.push({ id: newId_(), date: o.k, time: line.time, person: line.person || (ex ? normBazar_(ex.lunch) : ''), amount: a, details: line.details,
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
function groups_(L) {
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
function applyRows_(L, g, want) {
  const sh = L.sh, r0 = g.rows[0], cur = g.rows.length, need = want.length;
  let rows = g.rows.slice();
  const dc = L.dateCol + 1, dv = sh.getRange(r0 + 1, dc).getValue() || Utilities.parseDate(g.k, tz_(), 'yyyy-MM-dd'), dr = sh.getRange(r0 + 1, dc, cur, 1);
  dr.breakApart(); dr.setValue(dv);      // dissolve the merge so rows can be added or removed; mergeDates_() merges again

  if (need > cur) {
    const add = need - cur, last = g.rows[cur - 1], maxC = sh.getMaxColumns();
    sh.insertRowsAfter(last + 1, add);
    for (let i = 1; i <= add; i++) {
      const nr = last + i;
      if (L.kind === 'blocks') {
        sh.getRange(r0 + 1, 1, 1, maxC).copyTo(sh.getRange(nr + 1, 1, 1, maxC), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
        sh.getRange(nr + 1, L.dateCol + 1).setValue(sh.getRange(r0 + 1, L.dateCol + 1).getValue());
      } else {
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
function renderGrocery_(log, onlyDates) {
  const L = layout_(), notes = L.kind === 'blocks' ? L.sh.getDataRange().getNotes() : null;
  if (L.fixed && L.fixed.length) healWith_(L);          // a lost date is written back before rows are added or removed
  const by = {}, only = onlyDates ? onlyDates.reduce(function (m, d) { m[d] = 1; return m; }, {}) : null;
  sortEntries_(log).forEach(function (e) {
    if (L.kind === 'blocks' && NAMES.indexOf(e.person) < 0) return;
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
  if (jobs.length) {
  jobs.sort(function (a, b) { return b.g.rows[0] - a.g.rows[0]; });
  jobs.forEach(function (j) { applyRows_(L, j.g, j.want); });
  SpreadsheetApp.flush();
  applyTotals_(true);
  }
  return jobs.length + mergeDates_();

}

// ---------- Totals ----------
function totalRow_(L, run) {
  const end = run[run.length - 1].r;
  for (let r = end + 1; r < Math.min(L.v.length, end + 8); r++) if (/^total/i.test(String((L.v[r] || [])[L.dateCol] || '').trim())) return r;
  return -1;
}
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
  const t0 = Date.now();
  let me;
  if (req.secret) {
    if (!secretOk_(req.secret)) throw new Error('Bad sync secret');            // v2: secret comes from Script Properties
    if (['load', 'importBazar'].indexOf(req.action) < 0) throw new Error('Not allowed');
    me = { email: '', name: SHEET_USER, admin: false, addFor: [], fundsFor: [], mealsFor: [], views: VIEW_KEYS.slice(),
      addSpending: false, canGrocery: false, canFunds: false, canMeals: false };
  } else me = me_(verify_(req.idToken));
  const authMs = Date.now() - t0;                     // token check + member lookup
  if (req.action === 'load') {
    const out = load_(me);
    out.timing = Object.assign(
      {
        authMs: authMs,
        loadMs: Date.now() - t0 - authMs            // everything after auth inside load_ (includes layoutMs), not pure sheet-read time
      },
      out.timing || {}
    );
    return out;
  }
  if (req.action === 'syncFromSource') return Object.assign({ ok: true }, runSync_(me, req.idToken));   // has its own lock handling
  if (req.action === 'reconcile') { admin_(me); return auditReport_(); }          // v2: read-only health / reconciliation report
  const lock = getLock_(30000);
  let info = null;
  const rk = idemId_(req, me);                                                  // v2: a repeated request is answered, not repeated
  try {
    const seen = idemGet_(rk);
    if (seen) return Object.assign({ ok: true, duplicate: true }, seen);
    migrateOnce_();
    switch (req.action) {
      case 'setMeal': setMeal_(me, req); break;
      case 'addDeposit':
        if (!(me.admin || me.fundsFor.indexOf(req.person) >= 0))
          throw new Error('You are not allowed to add funds for ' + req.person);
        if (addDeposit_(me, req) && !me.admin) log_(me, 'deposit', req.person, 'Deposit \u09F3' + Number(req.amount) + ' for ' + req.person + ' (' + req.date + ')');
        break;
      case 'editDeposit': editDeposit_(me, req); break;
      case 'addSpending': {
        if (!(me.admin || me.canGrocery)) throw new Error('You are not allowed to add grocery spending');
        const added = addSpending_(me, req);
        if (!me.admin && added.length) log_(me, 'spending', '', 'Grocery \u09F3' + added.reduce(function (t, e) { return t + e.amount; }, 0) + ' on ' + req.date +
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
      default: throw new Error('Unknown action');
    }
    idemPut_(rk, req.action === 'importBazar' ? {} : (info || {}));
  } finally { lock.releaseLock(); }
  return Object.assign({ ok: true }, info || {});
}

function load_(me) {
  migrateOnce_();
  const tL = Date.now();
  const L = layout_(), v = L.v;
  const layoutMs = Date.now() - tL;
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
  if (L.kind === 'blocks') {
    out.bazarRows = L.spend.rows.map(function (o) {
      const cells = {}; NAMES.forEach(function (n) { const c = L.spend.cols[n]; cells[n] = c === undefined ? '' : cell(o.r, c); });
      return { date: o.k, time: normTime_(cell(o.r, L.dateCol + 1)), cells: cells };
    });
  }

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
  out.timing = { layoutMs: layoutMs };
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
  ensureRows_(s, r);                                    // v2: the tab can grow past its first 1000 rows
  const rg = s.getRange(r, 1, 1, 4);
  rg.setNumberFormat('@');                              // v2: typed text stays text (never a formula, date or number)
  rg.setValues([[q.date, q.person, lunch, dinner]]);
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
// (v2: addDeposit_ moved to the "v2 additions" section at the end of this file)
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
  if (!id || mine.length <= 1) {
    const s = depositMeta_(), r = metaRow_(s, [q.date, q.person]);
    if (r && num_(c.range.getValue()) <= 0) s.getRange(r, 1, 1, 4).setValues([['', '', '', '']]);
  }
}

// ---------- Grocery actions ----------
// (v2: cleanItem_ and addSpending_ moved to the "v2 additions" section at the end of this file)
// Admin: any entry. A member with the grocery permission: only an entry of the latest date, and only if they added it.
function editSpending_(me, q) {
  const log = readLog_(), e = log.find(function (x) { return x.id === String(q.id || ''); });
  if (!e) throw new Error('Grocery entry not found');
  const amt = validAmount_(q.amount, true);             // v2: one amount rule (0 is still allowed = admin removal)
  const person = q.bazarKorta ? String(q.bazarKorta).trim() : e.person;
  if (NAMES.indexOf(person) < 0) throw new Error('Choose the বাজারকর্তা from the listed people');
  const time = q.time !== undefined && q.time !== '' ? normTime_(q.time) : e.time;
  if (q.time !== undefined && q.time !== '' && !time) throw new Error('Enter a valid time');
  const date = q.date ? String(q.date).trim() : e.date;
  if (date !== e.date) {
    if (!me.admin) throw new Error('Only the admin can change the date of an entry');
    if (!layout_().spend.rows.some(function (o) { return o.k === date; })) throw new Error('That date is not in the sheet');
  }
  if (!me.admin) {
    if (!me.canGrocery) throw new Error('You do not have the grocery permission');
    if (amt <= 0) throw new Error('Only the admin can remove a grocery entry');
    if (latestSpendDate_(log) !== e.date) throw new Error('Only the latest grocery entries can be edited');
    if (!e.email || e.email !== me.email) throw new Error('Only the person who added this entry (or the admin) can edit it');
  }
  const extra = (Array.isArray(q.extra) ? q.extra : []).map(function (it) { return cleanItem_(it, date, q); });
  if (amt > 0 && (time !== e.time || date !== e.date)) checkNotFuture_(date, time, q);
  const count = log.filter(function (x) { return x.date === date && x !== e; }).length + (amt > 0 ? 1 : 0) + extra.length;
  if (count > MAX_PER_DATE) throw new Error('Too many purchases on one date (max ' + MAX_PER_DATE + ')');
  const oldDate = e.date, old = e.amount;
  if (amt === 0) log.splice(log.indexOf(e), 1);
  else { e.amount = amt; e.person = person; e.time = time; e.date = date; if (q.details !== undefined) e.details = String(q.details).trim().slice(0, 3000); }
  extra.forEach(function (f) { log.push({ id: newId_(), date: date, time: f.time, person: f.person, amount: f.amount, details: f.details, email: me.email, name: me.name }); });
  writeLog_(log);
  renderGrocery_(log, oldDate === date ? [date] : [oldDate, date]);
  if (!me.admin) log_(me, 'spending', '', 'Edited grocery on ' + date + ': \u09F3' + old + ' \u2192 \u09F3' + amt + (extra.length ? ' (+' + extra.length + ' more)' : ''));
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
// (v2: log_ moved to the "v2 additions" section at the end of this file)
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
function monthlyRollover() { return rollover_(false); }
function rolloverNextMonthNow() { return rollover_(true); }
function installMonthlyTrigger() {
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
    ['GroceryLog', 'DepositLog'].forEach(function (n) {
      const t = ss.getSheetByName(n);
      if (t) { try { t.setName(n + ' ' + archive); } catch (e) { Logger.log('Could not rename ' + n + ': ' + e.message); } }
    });
    const msg = 'New tab for ' + MONTH_NAMES[tm - 1] + ' ' + ty + ' is ready. The old tab is now "' + archive + '".';
    Logger.log(msg);
    return msg;
  } finally { lock.releaseLock(); }
}

function removeExtras_(sh) {
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
  if (L.kind === 'blocks') {
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
function writeCol_(sh, rows, col, valueOf) {
  const r0 = rows[0].r, rng = sh.getRange(r0 + 1, col + 1, rows[rows.length - 1].r - r0 + 1, 1);
  const vals = rng.getValues(), fx = rng.getFormulas();
  rows.forEach(function (o) {
    const i = o.r - r0;
    let v = valueOf(o.k);
    if (v === undefined || fx[i][0]) return;
    if (v === null) v = '';
    if (String(vals[i][0]) !== String(v)) sh.getRange(o.r + 1, col + 1).setValue(v);
  });
}
// (v2: rewriteTab_ moved to the "v2 additions" section at the end of this file)
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
  if (first.kind === 'blocks') pushFromSheet_(first);
  const sec = syncSecret_();                                                    // v2: from Script Properties
  const src = callSource_(sec ? { action: 'load', secret: sec } : { action: 'load', idToken: idToken });
  if (!(src.spending || []).some(function (e) { return num_(e.amount) > 0; })) {
    const here = layout_();
    if (here.kind === 'blocks') {
      const mine = sheetEntries_(here);
      const n = Object.keys(mine).reduce(function (t, d) { return t + mine[d].length; }, 0);
      if (n) throw new Error('খাদ্য তথ্য has no grocery entries but this sheet has ' + n + '. Nothing was changed.');
    }
  }

  const L = layout_(), sh = L.sh, warn = [];
  const blankNa = function (k, v) {
    return (k >= BLANK_NA_FROM && k <= BLANK_NA_TO && String(v).trim().toUpperCase() === 'N/A') ? '' : v;
  };

  NAMES.forEach(function (n) {
    if (L.meals.cols[n] !== undefined) writeCol_(sh, L.meals.rows, L.meals.cols[n], function (k) { return src.meals && src.meals[k] ? blankNa(k, src.meals[k][n]) : undefined; });
    if (L.dep.cols[n] !== undefined) writeCol_(sh, L.dep.rows, L.dep.cols[n], function (k) { return src.deposits && src.deposits[k] ? blankNa(k, src.deposits[k][n]) : undefined; });
  });

  writeDepositLog_((src.depositLog || []).filter(function (e) { return !e.pseudo; }).map(function (e) {
    return { id: e.id, date: e.date, time: e.time || '', person: e.person, amount: num_(e.amount), email: e.addedByEmail || '', name: e.addedByName || '' };
  }));

  const glog = (src.spending || []).filter(function (e) { return num_(e.amount) > 0; }).map(function (e) {
    return { id: e.id, date: e.date, time: e.time || '', person: e.bazarKorta || '', amount: num_(e.amount), details: cleanDet_(e.details), email: e.addedByEmail || '', name: e.addedByName || '' };
  });
  writeLog_(glog);
  renderGrocery_(glog, null);
  snapAll_(layout_());

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

// ---------- Bazar sheet snapshot protection ----------
function h_(s) {
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s))
  ).slice(0, 12);
}
function viewSig_(list) {
  return h_(sig_(list.map(function (s) {
    return { time: s.time, person: s.person, amount: s.amount, details: s.note };
  })));
}
function snapAll_(L) {
  const sheet = sheetEntries_(L);
  const snap = {};
  Object.keys(sheet).forEach(function (d) { snap[d] = viewSig_(sheet[d]); });
  PropertiesService.getScriptProperties().setProperty('SNAP', JSON.stringify(snap));
}
function pushFromSheet_(L) {
  if (!SOURCE_URL) return 0;
  const P = PropertiesService.getScriptProperties();
  const raw = P.getProperty('SNAP');
  if (!raw) return 0;

  const snap = JSON.parse(raw), empty = viewSig_([]), log = readLog_(), today = nowParts_().date;
  const sheet = sheetEntries_(L), byDate = {}, changes = {}, seen = [];
  log.forEach(function (e) { (byDate[e.date] = byDate[e.date] || []).push(e); });

  let future = 0;
  Object.keys(sheet).forEach(function (d) {
    const current = viewSig_(sheet[d]);
    if (current === (snap[d] || empty)) return;
    if (d > today) { future++; return; }
    seen.push(d);
    const keep = (byDate[d] || []).filter(function (e) { return NAMES.indexOf(e.person) < 0; });
    const known = (byDate[d] || []).filter(function (e) { return NAMES.indexOf(e.person) >= 0; });
    const merged = reconcile_(d, sheet[d], known).concat(keep);
    if (sig_(merged) !== sig_(byDate[d] || [])) changes[d] = merged;
  });

  if (future) {
    try { ss_().toast('Grocery entries on future dates are ignored and will be cleared.', 'বেলা হিসাব', 8); }
    catch (e) {}
  }

  const dates = Object.keys(changes);
  if (dates.length) {
    const res = callSource_({ action: 'importBazar', secret: syncSecret_(), changes: changes });   // v2: secret from Script Properties
    const canon = res.entries || {}, next = log.filter(function (e) { return !canon[e.date]; });
    Object.keys(canon).forEach(function (d) { canon[d].forEach(function (e) { next.push(e); }); });
    writeLog_(next);
  }
  seen.forEach(function (d) { snap[d] = viewSig_(sheet[d]); });
  if (seen.length) P.setProperty('SNAP', JSON.stringify(snap));
  return dates.length;
}
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
    if (!lock.tryLock(20000)) return;
    try { pushFromSheet_(L); } finally { lock.releaseLock(); }
  } catch (err) { Logger.log('onBazarEdit: ' + err.message); }
}
function bazarSweep() {
  if (!SOURCE_URL) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const L = layout_(); if (L.kind === 'blocks') pushFromSheet_(L);
    const P = PropertiesService.getScriptProperties();
    if (P.getProperty('SYNC_WANTED') !== P.getProperty('SYNC_DONE')) syncLoop_();     // a sync was asked for while the lock was busy
  }
  catch (err) { Logger.log('bazarSweep: ' + err.message); }
  finally { lock.releaseLock(); }
}
function installBazarTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['onBazarEdit', 'bazarSweep'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onBazarEdit').forSpreadsheet(ss_()).onEdit().create();
  ScriptApp.newTrigger('bazarSweep').timeBased().everyMinutes(5).create();
}

// খাদ্য তথ্য side: receives purchases from the বেলা হিসাব sheet. For each supplied date, its log is replaced.
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
      if (NAMES.indexOf(person) < 0 && !prev) return null;
      return { id: prev ? prev.id : newId_(), date: d, time: normTime_(s.time), person: person, amount: amount, details: String(s.details || '').trim().slice(0, 3000),
        email: prev ? prev.email : String(s.email || ''), name: prev ? prev.name : String(s.name || SHEET_USER) };
    }).filter(Boolean);
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

function resetBazarSnapshot() { PropertiesService.getScriptProperties().deleteProperty('SNAP'); }

// Run ONCE in the খাদ্য তথ্য script: rebuilds the grocery log from the amounts, details and বাজারকর্তা still in the sheet cells.
function restoreGroceryFromSheet() {
  if (SOURCE_URL) throw new Error('Run this in the খাদ্য তথ্য script, not in the বেলা হিসাব script');
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    if (readLog_().length) throw new Error('The grocery log is not empty, nothing was changed');
    const L = layout_();
    if (L.kind !== 'stacked') throw new Error('Expected the stacked layout in this sheet');
    let bazarCol = -1;
    for (let r = 0; r < L.v.length && bazarCol < 0; r++)
      for (let c = 0; c < L.v[r].length; c++) {
        const t = flat_(L.v[r][c]);
        if ((t.indexOf('বাজার') >= 0 && t.indexOf('কর্তা') >= 0) || t === 'bazarkorta') { bazarCol = c; break; }
      }
    const meta = {};
    legacyRows_('SpendingMeta').forEach(function (r) { if (r[1]) meta[dateKey_(r[0]) || String(r[0])] = r; });
    const entries = [];
    L.spend.rows.forEach(function (o) {
      const a = num_(cellOf_(L, o.r, L.spend.amountCol));
      if (!(a > 0)) return;
      const line = parseLine_(cleanDet_(cellOf_(L, o.r, L.spend.detailsCol)));
      const person = (bazarCol >= 0 ? normBazar_(cellOf_(L, o.r, bazarCol)) : '') || line.person || '';
      const m = meta[o.k];
      entries.push({ id: newId_(), date: o.k, time: line.time, person: person, amount: a, details: line.details,
        email: m ? String(m[1] || '') : '', name: m ? String(m[2] || '') : '' });
    });
    if (!entries.length) throw new Error('No grocery amounts found in the sheet cells');
    writeLog_(entries);
    PropertiesService.getScriptProperties().setProperty('GL_MIGRATED', '1');
    Logger.log('Restored ' + entries.length + ' entries, total ' + entries.reduce(function (t, e) { return t + e.amount; }, 0));
  } finally { lock.releaseLock(); }
}
// A date merged over several rows counts for every row of the merge
function dayNum_(k) { return Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10))) / 86400000; }
function addDays_(k, n) {
  const d = new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)) + n));
  return d.getUTCFullYear() + '-' + p2_(d.getUTCMonth() + 1) + '-' + p2_(d.getUTCDate());
}
// The date of every row of the date column. A merged date cell covers its extra rows. A blank cell between two dates is repaired:
//  - the next date is the very next day -> the blank row is one more row of the earlier date (a second purchase)
//  - the blank rows are exactly the days missing between the two dates -> a date that got lost, it is filled in
// dk.fixed lists the rows that were repaired (healWith_ writes them back into the sheet).
function dateKeys_(sh, v, dateCol) {
  const dk = v.map(function (r) { return dateKey_((r || [])[dateCol]); });
  sh.getRange(1, dateCol + 1, Math.max(v.length, 1), 1).getMergedRanges().forEach(function (m) {
    const r1 = m.getRow() - 1, r2 = Math.min(m.getLastRow() - 1, dk.length - 1), k = dk[r1];
    if (!k) return;
    for (let r = r1 + 1; r <= r2; r++) dk[r] = k;
  });
  const fixed = [];
  for (let i = 0; i < dk.length; i++) {
    if (!dk[i]) continue;
    let j = i + 1;
    while (j < dk.length && !dk[j]) j++;
    const g = j - i - 1;
    if (g >= 1 && j < dk.length) {
      const diff = dayNum_(dk[j]) - dayNum_(dk[i]);
      if (diff === 1) { for (let t = 1; t <= g; t++) { dk[i + t] = dk[i]; fixed.push(i + t); } }
      else if (diff === g + 1) { for (let t = 1; t <= g; t++) { dk[i + t] = addDays_(dk[i], t); fixed.push(i + t); } }
    }
    i = j - 1;
  }
  dk.fixed = fixed;
  return dk;
}
// Writes repaired dates back into the sheet (only blank cells that are not part of a merge).
function healWith_(L) {
  let n = 0;
  (L.fixed || []).forEach(function (r) {
    const c = L.sh.getRange(r + 1, L.dateCol + 1);
    if (c.isPartOfMerge() || String(c.getValue()).trim() !== '') return;
    c.setValue(Utilities.parseDate(L.dk[r], tz_(), 'yyyy-MM-dd')); n++;
  });
  if (n) SpreadsheetApp.flush();
  return n;
}
function healDates_() { const L = layout_(), n = healWith_(L); if (n) mergeDates_(); return n; }
// one merged date cell per date that has several purchase rows
function mergeDates_() {
  const L = layout_(), sh = L.sh, dc = L.dateCol + 1;
  let n = 0;
  groups_(L).forEach(function (g) {
    const cnt = g.rows.length; if (cnt < 2) return;
    const top = g.rows[0] + 1, ms = sh.getRange(top, dc).getMergedRanges();
    if (ms.length === 1 && ms[0].getRow() === top && ms[0].getNumRows() === cnt && ms[0].getNumColumns() === 1) return;
    const rg = sh.getRange(top, dc, cnt, 1), val = sh.getRange(top, dc).getValue();
    rg.breakApart(); sh.getRange(top, dc).setValue(val);
    rg.merge(); rg.setVerticalAlignment('middle');
    n++;
  });
  return n;
}
function mergeDateCells() { Logger.log('Merged ' + mergeDates_() + ' dates'); }   // optional: run once from the editor
function unmergeDates_(sh) {
  const L = layout_(sh), dc = L.dateCol + 1;
  groups_(L).forEach(function (g) {
    if (g.rows.length < 2) return;
    const rg = sh.getRange(g.rows[0] + 1, dc, g.rows.length, 1), v = sh.getRange(g.rows[0] + 1, dc).getValue();
    rg.breakApart(); rg.setValue(v);
  });
}

// ---------- Sync without lock time-outs ----------
// Every request leaves a stamp (SYNC_WANTED). If another sync is already running, the request returns at once:
// the running sync repeats itself when it finishes (and bazarSweep picks up anything left), so nothing is lost.
function runSync_(me, idToken) {
  PropertiesService.getScriptProperties().setProperty('SYNC_WANTED', Date.now() + '-' + Math.random().toString(36).slice(2));
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { warn: '', queued: true };
  try { return syncLoop_(me, idToken); } finally { lock.releaseLock(); }
}
function syncLoop_(me, idToken) {
  const P = PropertiesService.getScriptProperties();
  let info = { warn: '' };
  for (let i = 0; i < 3; i++) {
    const want = P.getProperty('SYNC_WANTED');
    migrateOnce_();
    info = syncFromSource_(me || {}, idToken || null);
    P.setProperty('SYNC_DONE', want || '');
    if (P.getProperty('SYNC_WANTED') === want) break;             // nobody asked again while we were working
  }
  return info;
}

// ---------- Repair: run ONCE from the editor if a row ever looks out of place ----------
// Puts back a lost date, then redraws the grocery rows from the log (খাদ্য তথ্য) or copies everything again from খাদ্য তথ্য (বেলা হিসাব).
function repairSheet() {
  const lock = getLock_(30000);
  try {
    migrateOnce_();
    const healed = healDates_();
    let msg;
    if (SOURCE_URL) { syncFromSource_({}, null); msg = 'copied again from খাদ্য তথ্য'; }
    else { const n = renderGrocery_(readLog_(), null); applyTotals_(true); msg = 'redrew the grocery rows (' + n + ' changes)'; }
    Logger.log('Repaired: ' + healed + ' lost date(s) put back, ' + msg);
    return 'Repaired: ' + healed + ' lost date(s) put back, ' + msg;
  } finally { lock.releaseLock(); }
}

function debugLayout() {
  const sh = main_(), v = sh.getDataRange().getValues();
  const width = v.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
  let dateCol = -1, best = 0;
  for (let c = 0; c < width; c++) {
    let n = 0;
    for (let r = 0; r < v.length; r++) if (dateKey_((v[r] || [])[c])) n++;
    if (n > best) { best = n; dateCol = c; }
  }
  Logger.log('First tab: "' + sh.getName() + '" | ' + v.length + ' rows x ' + width + ' cols | date column: ' + (dateCol + 1) + ' (' + best + ' dates)');
  if (dateCol < 0) return;
  const dk = dateKeys_(sh, v, dateCol), runs = []; let cur = null;
  for (let r = 0; r < v.length; r++) {
    const k = dk[r];
    if (k) { if (!cur) { cur = []; runs.push(cur); } cur.push({ r: r, k: k }); } else cur = null;
  }
  Logger.log('Date runs found: ' + runs.length + (dk.fixed && dk.fixed.length ? ' (repaired blank date rows: ' + dk.fixed.map(function (r) { return r + 1; }).join(', ') + ')' : ''));
  runs.forEach(function (run, i) {
    Logger.log('Run ' + (i + 1) + ': sheet rows ' + (run[0].r + 1) + '-' + (run[run.length - 1].r + 1) + ', ' + run.length + ' rows, ' + run[0].k + ' .. ' + run[run.length - 1].k);
    for (let r = run[0].r - 1; r >= Math.max(0, run[0].r - 6); r--) {
      let names = 0; const cells = [];
      for (let c = dateCol + 1; c <= dateCol + 12; c++) {
        const t = String((v[r] || [])[c] || '').trim();
        if (t && NAMES.some(function (n) { return t.toLowerCase().indexOf(n.toLowerCase()) === 0; })) names++;
        cells.push(t.slice(0, 10));
      }
      Logger.log('  row ' + (r + 1) + ' (names matched: ' + names + '): ' + cells.join(' | '));
    }
  });
}

// =====================================================================
//  v2 additions (Batch 1) — security, retry safety, safe writes, reconcile
// =====================================================================
// =====================================================================
//  BATCH 1 server patch — paste into BOTH Apps Script projects
//  (খাদ্য তথ্য and বেলা হিসাব). Identical in both; nothing here depends on SOURCE_URL.
//
//  Functions marked REPLACES must have their old definition DELETED
//  (a duplicate function name silently uses the last one in the file).
//  Functions marked NEW are additions. See PATCH_NOTES.md for the
//  few one-line edits inside existing functions (handle_, etc.).
//  Requires an existing: sameRows_, newId_, r2_, num_, normTime_, tz_, ss_,
//  tab_, layout_, readLog_, readDepositLog_, depCell_, setDepCell_, ...
// =====================================================================

// ---------- NEW: shared secret lives in Script Properties, never in source ----------
// Set it by hand: Project Settings → Script properties → SYNC_SECRET (same value in BOTH projects, ≥ 24 chars).
function syncSecret_() { return String(PropertiesService.getScriptProperties().getProperty('SYNC_SECRET') || ''); }
// compares every character, so the time taken does not reveal how much of a guess was right
function safeEq_(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
// fails closed: no (or a too short) secret configured = the secret path is switched off
function secretOk_(given) { const s = syncSecret_(); return s.length >= 24 && safeEq_(given, s); }

// ---------- NEW: idempotency (a repeated request must not repeat the write) ----------
const IDEM_TTL = 6 * 3600;           // seconds the "already done" marker is remembered (CacheService maximum)
const MAX_AMOUNT = 10000000;         // upper sanity bound for one amount
function idemId_(req, me) {
  const id = String((req && req.requestId) || '');
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? 'rq|' + ((me && me.email) || '') + '|' + id : '';
}
function idemGet_(key) {
  if (!key) return null;
  try { const v = CacheService.getScriptCache().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function idemPut_(key, info) {
  if (!key) return;
  try { CacheService.getScriptCache().put(key, JSON.stringify(info || {}), IDEM_TTL); } catch (e) { /* best effort; stableId_ below is the hard guarantee */ }
}
// Same requestId (+ position) always gives the same row id, so a retry after a half-finished save recognises its own rows.
function stableId_(kind, rid, i) {
  const rk = String(rid || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(rk)) return newId_();
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, kind + '|' + rk + '|' + i);
  return b.map(function (x) { return ('0' + (x & 255).toString(16)).slice(-2); }).join('').slice(0, 10);
}

// ---------- NEW: one rule for amounts ----------
function validAmount_(x, allowZero) {
  if (x === '' || x === null || x === undefined) throw new Error('Enter a valid amount');
  const n = Number(x);
  if (!isFinite(n) || n < 0 || n > MAX_AMOUNT) throw new Error('Enter a valid amount');
  const v = r2_(n);
  if (v === 0 && !allowZero) throw new Error('Enter a valid amount');
  return v;
}

// ---------- NEW: tabs that can grow, and a log write that cannot lose data half-way ----------
function ensureRows_(s, n) {
  const have = s.getMaxRows();
  if (have < n) s.insertRowsAfter(have, n - have + 200);
}
// New rows are written FIRST; only the leftover old tail is cleared afterwards.
// If setValues throws, the old content is still there. textCols (1-based) are stored as plain text,
// so "=1+1", "5/10" or "007" typed by a person can never become a formula, a date or a number.
function writeRows_(s, width, rows, textCols) {
  const last = s.getLastRow();
  if (sameRows_(s, last, width, rows)) return;
  ensureRows_(s, rows.length + 1);
  if (rows.length) {
    (textCols || []).forEach(function (c) { s.getRange(2, c, rows.length, 1).setNumberFormat('@'); });
    s.getRange(2, 1, rows.length, width).setValues(rows);
  }
  if (last - 1 > rows.length) s.getRange(rows.length + 2, 1, last - 1 - rows.length, width).clearContent();
}

// ---------- REPLACES: writeLog_ / writeDepositLog_ / rewriteTab_ ----------
function writeLog_(entries) {
  const rows = entries.map(function (e) {
    return [e.id, e.date, e.time || '', e.person, e.amount, e.details || '', e.email || '', e.name || ''];
  });
  writeRows_(glTab_(), GL_HEAD.length, rows, [1, 2, 3, 4, 6, 7, 8]);        // Amount (col 5) stays a number
}
function writeDepositLog_(entries) {
  const rows = entries.map(function (e) {
    return [e.id, e.date, e.time || '', e.person, e.amount, e.email || '', e.name || ''];
  });
  writeRows_(dlTab_(), DL_HEAD.length, rows, [1, 2, 3, 4, 6, 7]);
}
function rewriteTab_(name, headers, rows) {
  const all = headers.map(function (_, i) { return i + 1; });
  writeRows_(tab_(name, headers, true), headers.length, rows, all);
}

// ---------- REPLACES: log_ — a full or failing Activity tab must never fail a save that already happened ----------
function log_(me, type, forName, detail) {
  try {
    activity_().appendRow([new Date().toISOString(), me.name, type, forName || '', String(detail).slice(0, 500), false]);   // appendRow grows the tab
  } catch (err) { Logger.log('log_ failed: ' + err.message); }
}

// ---------- REPLACES: cleanItem_ (same rules, one amount validator) ----------
function cleanItem_(it, date, q) {
  const person = String(it.bazarKorta || it.person || '').trim();
  if (NAMES.indexOf(person) < 0) throw new Error('Choose the \u09AC\u09BE\u099C\u09BE\u09B0\u0995\u09B0\u09CD\u09A4\u09BE (who did the bazar) for every purchase');
  const amount = validAmount_(it.amount, false);
  const time = normTime_(it.time);
  if (!time) throw new Error('Enter the time of every purchase');
  checkNotFuture_(date, time, q);
  return { person: person, amount: amount, time: time, details: String(it.details || '').trim().slice(0, 3000) };
}

// ---------- REPLACES: addSpending_ (retry-safe: returns only the purchases it really added) ----------
function addSpending_(me, q) {
  const date = String(q.date || '');
  const items = Array.isArray(q.items) && q.items.length ? q.items : [{ bazarKorta: q.bazarKorta, time: q.time || nowParts_().time, amount: q.amount, details: q.details }];
  const L = layout_();
  if (!L.spend.rows.some(function (o) { return o.k === date; })) throw new Error('That date is not in the sheet');
  const fresh = items.map(function (it) { return cleanItem_(it, date, q); });
  const log = readLog_(), known = {};
  log.forEach(function (e) { known[e.id] = 1; });
  const added = [];
  fresh.forEach(function (f, i) {
    const id = stableId_('sp', q.requestId, i);
    if (known[id]) return;                              // an earlier attempt already stored this purchase
    added.push({ id: id, date: date, time: f.time, person: f.person, amount: f.amount, details: f.details, email: me.email, name: me.name });
  });
  if (log.filter(function (e) { return e.date === date; }).length + added.length > MAX_PER_DATE) throw new Error('Too many purchases on one date (max ' + MAX_PER_DATE + ')');
  const all = log.concat(added);
  if (added.length) writeLog_(all);
  renderGrocery_(all, [date]);                          // always: completes a drawing an earlier attempt did not finish
  return added;
}

// ---------- REPLACES: addDeposit_ (log row first, then the cell; returns false if this request was already applied) ----------
function addDeposit_(me, q) {
  const amt = validAmount_(q.amount, false);
  const c = depCell_(q), np = nowParts_();
  const dl = readDepositLog_(), id = stableId_('dp', q.requestId, 0);
  if (dl.some(function (e) { return e.id === id; })) return false;
  dl.push({ id: id, date: q.date, time: np.time, person: q.person, amount: amt, email: me.email, name: me.name });
  writeDepositLog_(dl);
  setDepCell_(c, num_(c.range.getValue()) + amt);
  saveDepositMeta_(q.date, q.person, me);
  return true;
}

// ---------- NEW: secret check used by handle_ (see PATCH_NOTES.md) ----------
// ---------- NEW: read-only reconciliation — admin only, changes nothing ----------
function auditReport_() {
  const L = layout_(), issues = [], out = { ok: true, kind: L.kind, issues: issues };
  out.month = L.meals.rows.length ? L.meals.rows[0].k.slice(0, 7) : '';
  out.spreadsheetTimeZone = tz_();
  out.scriptTimeZone = Session.getScriptTimeZone();
  out.secretConfigured = syncSecret_().length >= 24;
  const log = readLog_(), dl = readDepositLog_();

  // 1) values sitting on continuation rows of the meal / deposit blocks (the app reads only the first row of each date; the sheet's =SUM total counts every row)
  if (L.kind === 'blocks') {
    const primary = {};
    L.meals.rows.forEach(function (o) { primary[o.r] = 1; });
    L.spend.rows.forEach(function (o) {
      if (primary[o.r]) return;
      [['meal', L.meals.cols], ['deposit', L.dep.cols]].forEach(function (blk) {
        NAMES.forEach(function (n) {
          const col = blk[1][n];
          if (col !== undefined && num_(cellOf_(L, o.r, col)) !== 0) issues.push({ type: 'value-on-continuation-row', block: blk[0], row: o.r + 1, date: o.k, person: n, value: num_(cellOf_(L, o.r, col)) });
        });
      });
    });
  }
  // 2) grocery: log vs cells, per date
  const cellSp = {}, logSp = {};
  L.spend.rows.forEach(function (o) {
    let a = 0;
    if (L.kind === 'blocks') NAMES.forEach(function (n) { const c = L.spend.cols[n]; if (c !== undefined) a += num_(cellOf_(L, o.r, c)); });
    else a = num_(cellOf_(L, o.r, L.spend.amountCol));
    cellSp[o.k] = r2_((cellSp[o.k] || 0) + a);
  });
  log.forEach(function (e) {
    if (L.kind === 'blocks' && NAMES.indexOf(e.person) < 0) return;
    if (cellSp[e.date] !== undefined) logSp[e.date] = r2_((logSp[e.date] || 0) + e.amount);
  });
  Object.keys(cellSp).forEach(function (d) {
    if (Math.abs(cellSp[d] - (logSp[d] || 0)) >= 0.01) issues.push({ type: 'grocery-mismatch', date: d, cells: cellSp[d], log: logSp[d] || 0 });
  });
  // 3) deposits: cell vs per-entry log
  const dsum = {};
  dl.forEach(function (e) { dsum[e.date + '|' + e.person] = r2_((dsum[e.date + '|' + e.person] || 0) + e.amount); });
  L.dep.rows.forEach(function (o) {
    NAMES.forEach(function (n) {
      const c = L.dep.cols[n]; if (c === undefined) return;
      const diff = r2_(num_(cellOf_(L, o.r, c)) - (dsum[o.k + '|' + n] || 0));
      if (diff > 0.009) issues.push({ type: 'deposit-not-in-log', date: o.k, person: n, amount: diff, note: 'typed in the sheet, shown as a "sheet entry" (usually legacy)' });
      if (diff < -0.009) issues.push({ type: 'deposit-log-exceeds-cell', date: o.k, person: n, amount: diff });
    });
  });
  // 4) duplicate ids, formula-like text
  [['GroceryLog', log], ['DepositLog', dl]].forEach(function (p) {
    const seen = {}; let dup = 0;
    p[1].forEach(function (e) { if (seen[e.id]) dup++; seen[e.id] = 1; });
    if (dup) issues.push({ type: 'duplicate-ids', tab: p[0], count: dup });
  });
  const risky = log.filter(function (e) { return /^[=+\-@]/.test(String(e.details || '')); }).length;
  if (risky) issues.push({ type: 'formula-like-text', tab: 'GroceryLog', count: risky });
  // 5) tab capacity
  out.capacity = {};
  ['GroceryLog', 'DepositLog', 'DepositMeta', 'MealDetails', 'Activity'].forEach(function (n) {
    const s = ss_().getSheetByName(n);
    if (s) { out.capacity[n] = { used: s.getLastRow(), max: s.getMaxRows() }; if (s.getLastRow() > s.getMaxRows() * 0.8) issues.push({ type: 'tab-nearly-full', tab: n }); }
  });
  out.issueCount = issues.length;
  return out;
}
function reconcileReport() { Logger.log(JSON.stringify(auditReport_(), null, 1)); }   // run from the editor: read-only
function checkSecretConfigured() { Logger.log('SYNC_SECRET configured (>= 24 chars): ' + (syncSecret_().length >= 24)); }
