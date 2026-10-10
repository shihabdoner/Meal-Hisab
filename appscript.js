/** Meal-fund API. Google Sheets stays the source of truth. */
const FIREBASE_API_KEY = 'AIzaSyAfp6ACmE3d-9iAieAp1knA40qKEbdcx7Y'; // same key as firebase-config.js
const NAMES = ['Shohan', 'Naved', 'Salman', 'Rifat', 'Shihab', 'Ashmit'];
const MONTHS = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11};
const MEMBER_HEADERS = ['Email', 'Name', 'Admin', 'AddFor', 'AddSpending', 'CanGrocery', 'CanFunds', 'CanMeals', 'FundsFor', 'MealsFor', 'Views'];
const VIEW_KEYS = ['sheetMeals','sheetSpending','sheetDeposits','myDep','resid','due','lastFund','lastDate','lastGrocery','totalFund','totalSpent','left'];
// In the "বেলা হিসাব" script paste the খাদ্য তথ্য web app URL here. Leave '' in the খাদ্য তথ্য script.
const SOURCE_URL = 'https://script.google.com/macros/s/AKfycbyY2nV0nOj5WkCIdzhoQBgeQv240v8BL1cQKop6dqOlh8qIamh7iGIqK0n3d1K4zyik5Q/exec';

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function main_() { return ss_().getSheets()[0]; }
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
    s = ss_().insertSheet(name, ss_().getNumSheets());
    s.appendRow(headers);
    if (textFirstCol) s.getRange(1, 1, s.getMaxRows(), 1).setNumberFormat('@');
  }
  return s;
}
function dateKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
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

// Finds the three date tables (meals, spending, deposits) automatically, wherever they sit in the sheet.
// Also finds the "বাজারকর্তা" column (header cell) and the date table that sits right below it.
function layout_() {
  const sh = main_(), v = sh.getDataRange().getValues();
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

  // বাজারকর্তা header -> the date table right below it
  let bazarCol = -1, bazarRows = null;
  for (let r = 0; r < v.length && bazarCol < 0; r++) {
    for (let c = 0; c < width; c++) {
      const t = flat_((v[r] || [])[c]);
      if (!t) continue;
      if ((t.indexOf('বাজার') >= 0 && t.indexOf('কর্তা') >= 0) || t === 'bazarkorta' || t === 'bajarkorta') {
        const run = runs.find(function (x) { return x[0].r > r; });
        if (run && run[0].r - r <= 8) { bazarCol = c; bazarRows = run; break; }
      }
    }
  }

  return { kind: 'stacked', sh: sh, v: v, dateCol: dateCol,
    meals: { rows: runs[0], cols: colsFor(runs[0][0].r) },
    spend: { rows: runs[1], amountCol: amountCol, detailsCol: detailsCol },
    dep: { rows: runs[2], cols: colsFor(runs[2][0].r) },
    bazar: { col: bazarCol, rows: bazarRows } };
}

// Side-by-side layout: one date column, then three blocks of 6 name columns: মিল হিসাব | বাজার হিসাব | জমা টাকার হিসাব.
// The bazar amount of a date is written in the cell of the বাজারকর্তা person.
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
    meals: { rows: run, cols: roles.meal.cols },
    dep: { rows: run, cols: roles.dep.cols },
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
    // per-person lists (new). If never saved in the new format, fall back to the old "AddFor + CanFunds/CanMeals".
    const legacy = blank(d[i][8]) && blank(d[i][9]);
    const oldFor = listOf_(d[i][3]);
    const fundsFor = legacy ? ((blank(d[i][6]) || bool_(d[i][6])) ? oldFor : []) : listOf_(d[i][8]);
    const mealsFor = legacy ? ((blank(d[i][7]) || bool_(d[i][7])) ? oldFor : []) : listOf_(d[i][9]);
    const union = NAMES.filter(function (n) { return fundsFor.indexOf(n) >= 0 || mealsFor.indexOf(n) >= 0; });
    // Views: blank = everything visible (so existing members lose nothing until the admin changes it)
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

// ---------- Notes + who-added metadata (all kept in tabs of this spreadsheet) ----------
function notes_() {
  const s = tab_('MealDetails', ['Date', 'Person', 'Lunch', 'Dinner'], true);
  const d = s.getDataRange().getValues(), out = {};
  for (let i = 1; i < d.length; i++) {
    const k = dateKey_(d[i][0]) || String(d[i][0]);
    out[d[i][1] + '|' + k] = { lunch: String(d[i][2] || ''), dinner: String(d[i][3] || '') };
  }
  return out;
}
function spendingMeta_() { return tab_('SpendingMeta', ['Date', 'AddedByEmail', 'AddedByName', 'Unused'], true); }
function depositMeta_() { return tab_('DepositMeta', ['Date', 'Person', 'AddedByEmail', 'AddedByName'], true); }
function metaRow_(sheet, keys) {
  const d = sheet.getDataRange().getValues();
  for (let i = 1; i < d.length; i++) {
    const got = keys.map(function (_, j) { return j === 0 ? (dateKey_(d[i][0]) || String(d[i][0])) : String(d[i][j] || ''); });
    if (keys.every(function (k, j) { return got[j] === String(k); })) return i + 1;
  }
  return 0;
}
function saveSpendMeta_(date, me) {
  const s = spendingMeta_(), r = metaRow_(s, [date]);
  if (r) s.getRange(r, 1, 1, 3).setValues([[date, me.email, me.name]]);
  else s.appendRow([date, me.email, me.name, '']);
}
function saveDepositMeta_(date, person, me) {
  const s = depositMeta_(), r = metaRow_(s, [date, person]);
  if (r) s.getRange(r, 1, 1, 4).setValues([[date, person, me.email, me.name]]);
  else s.appendRow([date, person, me.email, me.name]);
}
function spendMetaMap_() {
  const d = spendingMeta_().getDataRange().getValues(), o = {};
  for (let i = 1; i < d.length; i++) {
    if (!d[i][1]) continue;
    o[dateKey_(d[i][0]) || String(d[i][0])] = { addedByEmail: String(d[i][1] || ''), addedByName: String(d[i][2] || '') };
  }
  return o;
}
function depMetaMap_() {
  const d = depositMeta_().getDataRange().getValues(), o = {};
  for (let i = 1; i < d.length; i++) {
    if (!d[i][2]) continue;
    o[(dateKey_(d[i][0]) || String(d[i][0])) + '|' + d[i][1]] = { email: String(d[i][2] || ''), name: String(d[i][3] || '') };
  }
  return o;
}

// ---------- বাজারকর্তা (one person per date; lives in the sheet column if there is one) ----------
function normBazar_(x) {
  const s = String(x || '').trim();
  if (!s || s === 'N/A') return '';
  const low = s.toLowerCase();
  const hit = NAMES.find(function (n) { return low.indexOf(n.toLowerCase()) === 0; });
  return hit || s;
}
function readBazar_(L, date, notes) {
  if (L.bazar.col >= 0) {
    const row = L.bazar.rows.find(function (o) { return o.k === date; });
    return row ? normBazar_((L.v[row.r] || [])[L.bazar.col]) : '';
  }
  const ex = (notes || notes_())['*BAZAR*|' + date];
  return ex ? normBazar_(ex.lunch) : '';
}
function writeBazar_(L, date, name) {
  if (L.bazar.col >= 0) {
    const row = L.bazar.rows.find(function (o) { return o.k === date; });
    if (!row) throw new Error('That date is not in the sheet');
    L.sh.getRange(row.r + 1, L.bazar.col + 1).setValue(name);
    return;
  }
  const s = tab_('MealDetails', ['Date', 'Person', 'Lunch', 'Dinner'], true), d = s.getDataRange().getValues();
  let r = -1;
  for (let i = 1; i < d.length; i++) if ((dateKey_(d[i][0]) || String(d[i][0])) === date && d[i][1] === '*BAZAR*') { r = i + 1; break; }
  if (r < 0) r = s.getLastRow() + 1;
  s.getRange(r, 1, 1, 4).setValues([[date, '*BAZAR*', name, '']]);
}

// ---------- Actions ----------
function handle_(req) {
  const email = verify_(req.idToken), me = me_(email);
  if (req.action === 'load') return load_(me);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
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
      case 'addSpending':
        if (!(me.admin || me.canGrocery)) throw new Error('You are not allowed to add grocery spending');
        addSpending_(me, req);
        if (!me.admin) log_(me, 'spending', '', 'Grocery \u09F3' + Number(req.amount) + ' on ' + req.date +
          (req.details ? ': ' + String(req.details).trim().replace(/\s+/g, ' ').slice(0, 80) : '') +
          (req.bazarKorta ? ' (\u09AC\u09BE\u099C\u09BE\u09B0\u0995\u09B0\u09CD\u09A4\u09BE: ' + req.bazarKorta + ')' : ''));
        break;
      case 'editSpending': editSpending_(me, req); break;
      case 'clearDeposit': admin_(me); clearDeposit_(req); break;
      case 'clearSpending': admin_(me); clearSpending_(req); break;
      case 'saveMember': admin_(me); saveMember_(req); break;
      case 'makeAdmin': admin_(me); makeAdmin_(req); break;
      case 'savePerms': admin_(me); savePerms_(req); break;
      case 'ackAlerts': admin_(me); ack_(req); break;
      default: throw new Error('Unknown action');
    }
  } finally { lock.releaseLock(); }
  return { ok: true };
}

function load_(me) {
  const L = layout_(), v = L.v;
  const cell = function (r, c) { const x = (v[r] || [])[c]; return x === undefined ? '' : x; };
  const out = { ok: true, me: me, names: NAMES, layout: L.kind, meals: {}, deposits: {}, spending: [], mealDates: [], depDates: [], bazar: {}, bazarGrid: null };
  L.meals.rows.forEach(function (o) {
    out.mealDates.push(o.k); out.meals[o.k] = {};
    NAMES.forEach(function (n) { out.meals[o.k][n] = L.meals.cols[n] === undefined ? '' : cell(o.r, L.meals.cols[n]); });
  });
  L.dep.rows.forEach(function (o) {
    out.depDates.push(o.k); out.deposits[o.k] = {};
    NAMES.forEach(function (n) { out.deposits[o.k][n] = L.dep.cols[n] === undefined ? '' : cell(o.r, L.dep.cols[n]); });
  });
  const notes = notes_();
  if (L.kind === 'blocks') {
    // one entry per (date, বাজারকর্তা): the amount is the person's cell; details + who added it live in the BazarDetails tab
    const bd = bazarDetailsMap_(); out.bazarGrid = {};
    L.spend.rows.forEach(function (o) {
      out.bazarGrid[o.k] = {};
      NAMES.forEach(function (n) {
        const c = L.spend.cols[n], val = c === undefined ? '' : cell(o.r, c);
        out.bazarGrid[o.k][n] = val;
        if (num_(val) > 0) {
          const m = bd[o.k + '|' + n] || {};
          out.spending.push({ date: o.k, amount: val, details: m.details || '', bazarKorta: n, addedByEmail: m.email || '', addedByName: m.name || '' });
        }
      });
    });
  } else {
    const sm = spendMetaMap_();
    L.spend.rows.forEach(function (o) {
      const meta = sm[o.k] || {}, baz = readBazar_(L, o.k, notes);
      out.bazar[o.k] = baz;
      out.spending.push({ date: o.k, amount: cell(o.r, L.spend.amountCol), details: String(cell(o.r, L.spend.detailsCol) || ''),
        bazarKorta: baz, addedByEmail: meta.addedByEmail || '', addedByName: meta.addedByName || '' });
    });
  }
  out.depMeta = depMetaMap_();
  out.bazarInSheet = L.kind === 'blocks' || L.bazar.col >= 0;
  out.mealNotes = notes;
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
  // admin: anything. self: own meals. add: permitted person adding for someone else (fill empty boxes only).
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

function depCell_(q) {
  if (NAMES.indexOf(q.person) < 0) throw new Error('Unknown person');
  const L = layout_(), row = L.dep.rows.find(function (o) { return o.k === q.date; });
  if (!row) throw new Error('That date is not in the sheet');
  return { L: L, range: L.sh.getRange(row.r + 1, L.dep.cols[q.person] + 1) };
}
function addDeposit_(me, q) {
  const amt = Number(q.amount); if (!isFinite(amt) || amt <= 0) throw new Error('Enter a valid amount');
  const c = depCell_(q);
  c.range.setValue(num_(c.range.getValue()) + amt);
  saveDepositMeta_(q.date, q.person, me);
}
function latestDepositDate_(L, person) {
  let best = '';
  L.dep.rows.forEach(function (o) { if (num_((L.v[o.r] || [])[L.dep.cols[person]]) > 0 && o.k > best) best = o.k; });
  return best;
}
// Edit = set the total for that date. Admin: any entry. A member: only their own latest deposit.
function editDeposit_(me, q) {
  const amt = Number(q.amount); if (!isFinite(amt) || amt < 0) throw new Error('Enter a valid amount');
  const c = depCell_(q);
  if (!me.admin) {
    if (me.name !== q.person) throw new Error('Only the admin or ' + q.person + ' can edit this deposit');
    if (amt <= 0) throw new Error('Only the admin can remove a deposit');
    if (latestDepositDate_(c.L, q.person) !== q.date) throw new Error('You can only edit your own latest deposit');
  }
  const old = num_(c.range.getValue());
  c.range.setValue(amt > 0 ? amt : '');
  if (!me.admin) log_(me, 'deposit', q.person, 'Edited deposit on ' + q.date + ': \u09F3' + old + ' \u2192 \u09F3' + amt);
}
function clearDeposit_(q) {
  depCell_(q).range.setValue('');
  const s = depositMeta_(), r = metaRow_(s, [q.date, q.person]);
  if (r) s.getRange(r, 1, 1, 4).setValues([['', '', '', '']]);
}

function bazarDetails_() { return tab_('BazarDetails', ['Date', 'Person', 'Details', 'AddedByEmail', 'AddedByName'], true); }
function bazarDetailsMap_() {
  const d = bazarDetails_().getDataRange().getValues(), o = {};
  for (let i = 1; i < d.length; i++) {
    if (!d[i][0]) continue;
    o[(dateKey_(d[i][0]) || String(d[i][0])) + '|' + d[i][1]] = { details: String(d[i][2] || ''), email: String(d[i][3] || ''), name: String(d[i][4] || '') };
  }
  return o;
}
// append = true (new purchase): text is added under the old text and the adder becomes the author. false (edit): text replaced, author kept.
function saveBazarDetail_(date, person, details, me, append) {
  const s = bazarDetails_(), r = metaRow_(s, [date, person]);
  if (r) {
    const old = String(s.getRange(r, 3).getValue() || '');
    s.getRange(r, 3).setValue(append ? (details ? (old ? old + '\n' + details : details) : old) : details);
    if (append) s.getRange(r, 4, 1, 2).setValues([[me.email, me.name]]);
  } else s.appendRow([date, person, details, me.email, me.name]);
}
function spendTarget_(q) {
  const L = layout_(), row = L.spend.rows.find(function (o) { return o.k === q.date; });
  if (!row) throw new Error('That date is not in the sheet');
  if (L.kind === 'blocks') {
    const person = String(q.person || q.bazarKorta || '').trim();
    if (NAMES.indexOf(person) < 0) throw new Error('Choose the \u09AC\u09BE\u099C\u09BE\u09B0\u0995\u09B0\u09CD\u09A4\u09BE (who did the bazar)');
    return { L: L, kind: 'blocks', person: person, a: L.sh.getRange(row.r + 1, L.spend.cols[person] + 1), r: row.r + 1, ac: L.spend.cols[person] + 1 };
  }
  return { L: L, kind: 'stacked', a: L.sh.getRange(row.r + 1, L.spend.amountCol + 1), d: L.sh.getRange(row.r + 1, L.spend.detailsCol + 1), r: row.r + 1, ac: L.spend.amountCol + 1 };
}
function latestSpendDate_(L) {
  let best = '';
  L.spend.rows.forEach(function (o) {
    if (L.kind === 'blocks') {
      NAMES.forEach(function (n) { const c = L.spend.cols[n]; if (c !== undefined && num_((L.v[o.r] || [])[c]) > 0 && o.k > best) best = o.k; });
    } else if (num_((L.v[o.r] || [])[L.spend.amountCol]) > 0 && o.k > best) best = o.k;
  });
  return best;
}
function spendAuthor_(L, date, person) {
  if (L.kind === 'blocks') return (bazarDetailsMap_()[date + '|' + person] || {}).email || '';
  return (spendMetaMap_()[date] || {}).addedByEmail || '';
}
// stacked sheet: বাজারকর্তা is one person per date. Non-admins can only fill it while empty / unchanged.
function applyBazar_(me, L, date, value) {
  if (value === undefined || value === null) return;
  const bazar = String(value).trim();
  if (bazar && NAMES.indexOf(bazar) < 0) throw new Error('Choose the \u09AC\u09BE\u099C\u09BE\u09B0\u0995\u09B0\u09CD\u09A4\u09BE from the listed people');
  const ex = readBazar_(L, date);
  if (bazar === ex) return;
  if (!me.admin && ex) throw new Error('\u09AC\u09BE\u099C\u09BE\u09B0\u0995\u09B0\u09CD\u09A4\u09BE for this date is already ' + ex);
  writeBazar_(L, date, bazar);
}
function addSpending_(me, q) {
  const amt = Number(q.amount); if (!isFinite(amt) || amt <= 0) throw new Error('Enter a valid amount');
  const t = spendTarget_(q), det = String(q.details || '').trim().slice(0, 3000);
  if (t.kind === 'blocks') {               // only the amount goes into the বাজারকর্তা's cell
    t.a.setValue(num_(t.a.getValue()) + amt);
    saveBazarDetail_(q.date, t.person, det, me, true);
    return;
  }
  const old = String(t.d.getValue() || '');
  applyBazar_(me, t.L, q.date, q.bazarKorta);   // validate first, nothing is written if it fails
  t.a.setValue(num_(t.a.getValue()) + amt);
  if (det) { t.d.setValue(old && old !== 'N/A' ? old + '\n' + det : det); t.d.setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP); }
  saveSpendMeta_(q.date, me);
}
// Admin: any entry. A member with the grocery permission: only the latest entry, and only if they added it.
function editSpending_(me, q) {
  const amt = Number(q.amount); if (!isFinite(amt) || amt < 0) throw new Error('Enter a valid amount');
  const t = spendTarget_(q), L = t.L;
  if (!me.admin) {
    if (!me.canGrocery) throw new Error('You do not have the grocery permission');
    if (amt <= 0) throw new Error('Only the admin can remove a grocery entry');
    if (latestSpendDate_(L) !== q.date) throw new Error('Only the latest grocery entry can be edited');
    const by = spendAuthor_(L, q.date, t.person);
    if (!by || by !== me.email) throw new Error('Only the person who added this entry (or the admin) can edit it');
  }
  const old = num_((L.v[t.r - 1] || [])[t.ac - 1]), det = String(q.details || '').trim().slice(0, 3000);
  if (t.kind === 'blocks') {
    t.a.setValue(amt > 0 ? amt : '');
    saveBazarDetail_(q.date, t.person, det, me, false);
  } else {
    applyBazar_(me, L, q.date, q.bazarKorta);
    t.a.setValue(amt > 0 ? amt : '');
    t.d.setValue(det); t.d.setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  }
  if (!me.admin) log_(me, 'spending', '', 'Edited grocery on ' + q.date + ': \u09F3' + old + ' \u2192 \u09F3' + amt);
}
function clearSpending_(q) {
  const t = spendTarget_(q);
  t.a.setValue('');
  if (t.kind === 'blocks') {
    const s = bazarDetails_(), r = metaRow_(s, [q.date, t.person]);
    if (r) s.getRange(r, 1, 1, 5).setValues([['', '', '', '', '']]);
    return;
  }
  t.d.setValue('');
  const s = spendingMeta_(), r = metaRow_(s, [q.date]);
  if (r) s.getRange(r, 1, 1, 3).setValues([['', '', '']]);
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
// Per-person permissions: fundsFor / mealsFor = the people this member may add funds / meal details for.
// views = which dashboard cards / sheet tables this member can see.
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
  activity_(); members_(); depositMeta_();
  const L = layout_(), sh = L.sh, v = L.v;
  if (L.kind === 'blocks') bazarDetails_(); else spendingMeta_();
  const totalRow = function (run) {
    const end = run[run.length - 1].r;
    for (let r = end + 1; r < Math.min(v.length, end + 8); r++) if (/^total/i.test(String((v[r] || [])[L.dateCol] || '').trim())) return r;
    return -1;
  };
  const setSum = function (row, col, first, last) {   // only fills a total cell if it has no formula yet
    const c = sh.getRange(row + 1, col + 1);
    if (c.getFormula()) return;
    const l = colLetter_(col + 1);
    c.setFormula('=SUM(' + l + (first + 1) + ':' + l + (last + 1) + ')');
  };
  const blocks = L.kind === 'blocks' ? [L.meals, L.dep, L.spend] : [L.meals, L.dep];
  blocks.forEach(function (t) {
    const tr = totalRow(t.rows); if (tr < 0) return;
    NAMES.forEach(function (n) {
      const c = t.cols[n];
      if (c !== undefined) setSum(tr, c, t.rows[0].r, t.rows[t.rows.length - 1].r);
    });
  });
  if (L.kind === 'stacked') {
    const st = totalRow(L.spend.rows);
    if (st >= 0) setSum(st, L.spend.amountCol, L.spend.rows[0].r, L.spend.rows[L.spend.rows.length - 1].r);
  }
}
