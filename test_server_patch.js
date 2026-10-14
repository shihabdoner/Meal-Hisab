// Run:  node test_server_patch.js
// SIMULATED tests: the patch is executed in Node with mocked Apps Script services
// (PropertiesService, CacheService, Utilities, SpreadsheetApp-like sheets).
// They prove the logic of the new functions. They do NOT prove behaviour on real Google Sheets.
const vm = require('vm'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');

let pass = 0, fail = 0;
const results = [];
function t(name, fn) { try { fn(); pass++; results.push('PASS  ' + name); } catch (e) { fail++; results.push('FAIL  ' + name + '\n        ' + e.message); } }

// ---- helpers copied VERBATIM from the existing scripts (unchanged by the patch) ----
const preamble = `
const NAMES = ['Shohan','Naved','Salman','Rifat','Shihab','Ashmit'];
const GL_HEAD = ['ID','Date','Time','Person','Amount','Details','AddedByEmail','AddedByName'];
const DL_HEAD = ['ID','Date','Time','Person','Amount','AddedByEmail','AddedByName'];
const MAX_PER_DATE = 15;
function p2_(n) { return (n < 10 ? '0' : '') + n; }
function r2_(x) { return Math.round(x * 100) / 100; }
function num_(x) { const n = Number(x); return (x === '' || x === null || x === undefined || isNaN(n)) ? 0 : n; }
function newId_() { return 'RANDOM' + Math.random().toString(16).slice(2, 6); }
function cellOf_(L, r, c) { const x = (L.v[r] || [])[c]; return x === undefined ? '' : x; }
function normTime_(x) {
  const s = String(x === null || x === undefined ? '' : x).trim();
  const m = s.match(/^(\\d{1,2})\\s*[:.]\\s*(\\d{2})(?:\\s*:\\s*\\d{2})?\\s*([AaPp][Mm])?$/);
  if (!m) return '';
  let h = Number(m[1]); const mi = Number(m[2]);
  if (m[3]) { if (h < 1 || h > 12) return ''; h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0); }
  if (h > 23 || mi > 59) return '';
  return p2_(h) + ':' + p2_(mi);
}
function sameRows_(s, last, width, rows) {
  if (last - 1 !== rows.length) return false;
  if (!rows.length) return true;
  const cur = s.getRange(2, 1, rows.length, width).getValues();
  for (let i = 0; i < rows.length; i++) for (let j = 0; j < width; j++) {
    const a = cur[i][j], b = rows[i][j];
    if (String(a === null || a === undefined ? '' : a) !== String(b === null || b === undefined ? '' : b)) return false;
  }
  return true;
}
`;

// ---- mocks ----
function makeSheet(width, maxRows, name) {
  const s = { name, data: [], maxRows, fmt: {}, failNextSetValues: false, appendFails: false };
  s.getLastRow = () => { let l = 0; s.data.forEach((r, i) => { if (r && r.some(c => c !== '' && c != null)) l = i + 1; }); return l; };
  s.getMaxRows = () => s.maxRows;
  s.insertRowsAfter = (_, n) => { s.maxRows += n; };
  s.getRange = (r, c, nr = 1, nc = 1) => ({
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((s.data[r - 1 + i] || [])[c - 1 + j] ?? ''))),
    setValues: v => {
      if (s.failNextSetValues) { s.failNextSetValues = false; throw new Error('simulated failure'); }
      if (r - 1 + nr > s.maxRows) throw new Error('coordinates outside the dimensions of the sheet');
      v.forEach((row, i) => { s.data[r - 1 + i] = s.data[r - 1 + i] || []; row.forEach((x, j) => { s.data[r - 1 + i][c - 1 + j] = x; }); });
    },
    clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (s.data[r - 1 + i]) s.data[r - 1 + i][c - 1 + j] = ''; },
    setNumberFormat: f => { for (let j = 0; j < nc; j++) s.fmt[c + j] = f; },
  });
  s.appendRow = row => { if (s.appendFails) throw new Error('simulated append failure'); s.data[s.getLastRow()] = row.slice(); s.maxRows = Math.max(s.maxRows, s.data.length); };
  return s;
}
function sandbox(extra = {}) {
  const props = {}, cache = {};
  const ctx = {
    console, Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s)).digest()).map(b => b > 127 ? b - 256 : b),
    },
    Session: { getScriptTimeZone: () => 'Asia/Dhaka' },
    __props: props, __cache: cache, ...extra,
  };
  vm.createContext(ctx);
  if (process.env.FULL_SCRIPT) {        // integration mode: the real, assembled Apps Script file
    vm.runInContext(fs.readFileSync(process.env.FULL_SCRIPT, 'utf8'), ctx);
    ctx.newId_ = () => 'RANDOM' + Math.random().toString(16).slice(2, 6);
  } else vm.runInContext(preamble + fs.readFileSync(__dirname + '/server_patch.gs', 'utf8'), ctx);
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);

// ================= Secret handling =================
t('secret: empty / short / unset secret is rejected (fails closed)', () => {
  const c = sandbox();
  assert.strictEqual(run(c, "secretOk_('anything')"), false);
  c.__props.SYNC_SECRET = 'short';
  assert.strictEqual(run(c, "secretOk_('short')"), false);
});
t('secret: correct value accepted, wrong / prefix / empty rejected', () => {
  const c = sandbox(); const s = 'a'.repeat(24) + 'XYZ';
  c.__props.SYNC_SECRET = s;
  assert.strictEqual(run(c, `secretOk_(${JSON.stringify(s)})`), true);
  assert.strictEqual(run(c, `secretOk_(${JSON.stringify(s.slice(0, -1))})`), false);
  assert.strictEqual(run(c, `secretOk_(${JSON.stringify(s + 'x')})`), false);
  assert.strictEqual(run(c, "secretOk_('')"), false);
  assert.strictEqual(run(c, 'secretOk_(undefined)'), false);
});

// ================= Idempotency ids =================
t('requestId validation: only 8-64 safe chars accepted', () => {
  const c = sandbox();
  assert.strictEqual(run(c, "idemId_({requestId:'abc'},{email:'x'})"), '');
  assert.strictEqual(run(c, "idemId_({requestId:'has space 12345'},{email:'x'})"), '');
  assert.strictEqual(run(c, "idemId_({requestId:'abcdef12-3456'},{email:'x@y'})"), 'rq|x@y|abcdef12-3456');
});
t('stableId_: deterministic, 10 chars, differs by kind and position', () => {
  const c = sandbox();
  const a = run(c, "stableId_('sp','req-12345678',0)"), b = run(c, "stableId_('sp','req-12345678',0)");
  assert.strictEqual(a, b); assert.strictEqual(a.length, 10);
  assert.notStrictEqual(a, run(c, "stableId_('sp','req-12345678',1)"));
  assert.notStrictEqual(a, run(c, "stableId_('dp','req-12345678',0)"));
  assert.ok(/^RANDOM/.test(run(c, "stableId_('sp','bad',0)")), 'no valid requestId falls back to a random id');
});

// ================= Amounts =================
t('validAmount_: accepts normal, rounds to 2dp, rejects 0 / negative / NaN / huge / blank', () => {
  const c = sandbox();
  assert.strictEqual(run(c, 'validAmount_("12.345", false)'), 12.35);   // JS rounding of 12.345 -> 12.35 here
  assert.strictEqual(run(c, 'validAmount_(450, false)'), 450);
  for (const bad of ['0', '-5', 'abc', '', 'null', '1e9', '0.001', 'Infinity']) {
    assert.throws(() => run(c, `validAmount_(${bad === 'null' ? 'null' : JSON.stringify(bad)}, false)`), /valid amount/, 'should reject ' + bad);
  }
  assert.strictEqual(run(c, 'validAmount_(0, true)'), 0);
});

// ================= Safe log writes =================
function writeRowsCtx() { return sandbox(); }
t('writeRows_: failure of setValues leaves the OLD rows intact (old code cleared first)', () => {
  const c = writeRowsCtx(); const s = makeSheet(3, 1000, 'L');
  s.data = [['H', 'H', 'H'], ['a', '1', 'x'], ['b', '2', 'y'], ['c', '3', 'z']];
  c.s = s; s.failNextSetValues = true;
  assert.throws(() => run(c, "writeRows_(s, 3, [['n','9','q'],['m','8','w']], [1])"), /simulated/);
  assert.deepStrictEqual(s.data.slice(1, 4), [['a', '1', 'x'], ['b', '2', 'y'], ['c', '3', 'z']]);
});
t('writeRows_: shorter list clears only the old tail; longer list grows the tab', () => {
  const c = writeRowsCtx(); const s = makeSheet(2, 5, 'L');
  s.data = [['H', 'H'], ['a', 1], ['b', 2], ['c', 3]]; c.s = s;
  run(c, "writeRows_(s, 2, [['x',9]], [1])");
  assert.deepStrictEqual(s.data.slice(1, 4), [['x', 9], ['', ''], ['', '']]);
  const s2 = makeSheet(2, 5, 'L2'); s2.data = [['H', 'H']]; c.s2 = s2;
  const many = Array.from({ length: 30 }, (_, i) => ['r' + i, i]); c.many = many;
  run(c, 'writeRows_(s2, 2, many, [1])');                      // 30 rows into a 5-row tab: old code would throw
  assert.strictEqual(s2.getLastRow(), 31); assert.ok(s2.maxRows >= 31);
});
t('writeRows_: identical content is not rewritten; text columns are formatted as text', () => {
  const c = writeRowsCtx(); const s = makeSheet(2, 50, 'L');
  s.data = [['H', 'H'], ['a', '1']]; c.s = s; let writes = 0;
  const orig = s.getRange; s.getRange = (...a) => { const r = orig(...a); const sv = r.setValues; r.setValues = v => { writes++; return sv(v); }; return r; };
  run(c, "writeRows_(s, 2, [['a','1']], [1])"); assert.strictEqual(writes, 0);
  run(c, "writeRows_(s, 2, [['=1+1','2']], [1])"); assert.strictEqual(writes, 1);
  assert.strictEqual(s.fmt[1], '@');
});
t('log_: a full / failing Activity tab does not throw (the save already happened)', () => {
  const c = sandbox(); const a = makeSheet(6, 1000, 'Activity'); a.appendFails = true; c.activity_ = () => a;
  assert.doesNotThrow(() => run(c, "log_({name:'M'},'deposit','x','d')"));
  a.appendFails = false;
  run(c, "log_({name:'M'},'deposit','x','d')");
  assert.strictEqual(a.getLastRow(), 1);
});
t('log_: appends past row 1000 (old getRange(lastRow+1) design could not)', () => {
  const c = sandbox(); const a = makeSheet(6, 1000, 'Activity'); c.activity_ = () => a;
  for (let i = 0; i < 1000; i++) a.data[i] = ['x'];
  run(c, "log_({name:'M'},'meal','x','d')");
  assert.strictEqual(a.getLastRow(), 1001);
});

// ================= addSpending_ / addDeposit_ retry safety =================
function spendCtx() {
  const c = sandbox({ MAX_PER_DATE_TEST: 15 });
  c.store = []; c.renderCalls = 0; c.renderFailOnce = false;
  c.layout_ = () => ({ spend: { rows: [{ r: 1, k: '2026-10-14' }] } });
  c.readLog_ = () => c.store.map(e => ({ ...e }));
  c.writeLog_ = all => { c.store = all.map(e => ({ ...e })); };
  c.renderGrocery_ = () => { c.renderCalls++; if (c.renderFailOnce) { c.renderFailOnce = false; throw new Error('simulated draw failure'); } };
  c.checkNotFuture_ = () => {}; c.nowParts_ = () => ({ date: '2026-10-14', time: '10:00' });
  return c;
}
const me = "({email:'a@x',name:'Ashmit'})";
const q = rid => `({date:'2026-10-14', requestId:${JSON.stringify(rid)}, items:[{bazarKorta:'Rifat',time:'09:00',amount:'450',details:'x'}]})`;
t('addSpending_: same request twice stores ONE purchase', () => {
  const c = spendCtx();
  assert.strictEqual(run(c, `addSpending_(${me}, ${q('req-AAAA1111')}).length`), 1);
  assert.strictEqual(run(c, `addSpending_(${me}, ${q('req-AAAA1111')}).length`), 0);
  assert.strictEqual(c.store.length, 1);
});
t('addSpending_: retry after a failed DRAW does not duplicate, and finishes the drawing', () => {
  const c = spendCtx(); c.renderFailOnce = true;
  assert.throws(() => run(c, `addSpending_(${me}, ${q('req-BBBB2222')})`), /draw failure/);
  assert.strictEqual(c.store.length, 1, 'log written before the failure');
  run(c, `addSpending_(${me}, ${q('req-BBBB2222')})`);
  assert.strictEqual(c.store.length, 1, 'no duplicate on retry'); assert.strictEqual(c.renderCalls, 2, 'retry re-ran the drawing');
});
t('addSpending_: two DIFFERENT requests both store (not over-deduplicated)', () => {
  const c = spendCtx();
  run(c, `addSpending_(${me}, ${q('req-CCCC3333')})`); run(c, `addSpending_(${me}, ${q('req-DDDD4444')})`);
  assert.strictEqual(c.store.length, 2);
});
t('addSpending_: multi-item request gets distinct stable ids; retry adds none', () => {
  const c = spendCtx();
  const two = `({date:'2026-10-14', requestId:'req-EEEE5555', items:[{bazarKorta:'Rifat',time:'09:00',amount:'1'},{bazarKorta:'Salman',time:'10:00',amount:'2'}]})`;
  run(c, `addSpending_(${me}, ${two})`); run(c, `addSpending_(${me}, ${two})`);
  assert.strictEqual(c.store.length, 2); assert.notStrictEqual(c.store[0].id, c.store[1].id);
});
t('addSpending_: rejects bad amount / person before writing anything', () => {
  const c = spendCtx();
  assert.throws(() => run(c, `addSpending_(${me}, ({date:'2026-10-14',items:[{bazarKorta:'Rifat',time:'09:00',amount:'-3'}]}))`), /valid amount/);
  assert.throws(() => run(c, `addSpending_(${me}, ({date:'2026-10-14',items:[{bazarKorta:'Nobody',time:'09:00',amount:'3'}]}))`), /Choose/);
  assert.strictEqual(c.store.length, 0);
});
t('addSpending_: 16th purchase on one date is refused', () => {
  const c = spendCtx();
  c.store = Array.from({ length: 15 }, (_, i) => ({ id: 'i' + i, date: '2026-10-14', time: '08:00', person: 'Rifat', amount: 1, details: '', email: '', name: '' }));
  assert.throws(() => run(c, `addSpending_(${me}, ${q('req-FFFF6666')})`), /Too many/);
});
function depCtx() {
  const c = sandbox(); c.dl = []; c.cell = 0; c.metaCalls = 0;
  c.depCell_ = () => ({ range: { getValue: () => c.cell } }); c.setDepCell_ = (_, v) => { c.cell = v; };
  c.nowParts_ = () => ({ time: '07:31' }); c.readDepositLog_ = () => c.dl.map(e => ({ ...e }));
  c.writeDepositLog_ = a => { c.dl = a.map(e => ({ ...e })); }; c.saveDepositMeta_ = () => { c.metaCalls++; };
  return c;
}
t('addDeposit_: repeated request adds the amount ONCE (cell and log)', () => {
  const c = depCtx(); const call = "addDeposit_(({email:'a@x',name:'A'}), ({date:'2026-10-13',person:'Shohan',amount:'1000',requestId:'req-GGGG7777'}))";
  assert.strictEqual(run(c, call), true); assert.strictEqual(run(c, call), false);
  assert.strictEqual(c.cell, 1000); assert.strictEqual(c.dl.length, 1); assert.strictEqual(c.metaCalls, 1);
});
t('addDeposit_: second legit deposit the same day still adds (different request)', () => {
  const c = depCtx();
  run(c, "addDeposit_(({email:'a@x',name:'A'}), ({date:'2026-10-13',person:'Shohan',amount:'1000',requestId:'req-HHHH8888'}))");
  run(c, "addDeposit_(({email:'a@x',name:'A'}), ({date:'2026-10-13',person:'Shohan',amount:'200',requestId:'req-IIII9999'}))");
  assert.strictEqual(c.cell, 1200); assert.strictEqual(c.dl.length, 2);
});
t('addDeposit_: invalid amount changes nothing', () => {
  const c = depCtx();
  assert.throws(() => run(c, "addDeposit_(({email:'a@x',name:'A'}), ({date:'2026-10-13',person:'Shohan',amount:'0',requestId:'req-JJJJ0000'}))"), /valid amount/);
  assert.strictEqual(c.cell, 0); assert.strictEqual(c.dl.length, 0);
});

// ================= reconcile_ =================
t('reconcile_: finds the real deposit-on-continuation-row pattern seen in Bazar_hisab (row 16)', () => {
  const c = sandbox();
  const cols = i => Object.fromEntries(['Shohan', 'Naved', 'Salman', 'Rifat', 'Shihab', 'Ashmit'].map((n, k) => [n, i + k]));
  const v = []; for (let r = 0; r < 20; r++) v.push(new Array(25).fill(''));
  // rows (0-based): 14 = 9 Oct primary, 15 = 9 Oct continuation, 16 = 10 Oct
  v[15][17] = 780;   // Salman deposit on the continuation row   (col index 17 = Salman in dep block)
  v[14][18] = 0;
  c.layout_ = () => ({ kind: 'blocks', v, meals: { rows: [{ r: 14, k: '2026-10-09' }, { r: 16, k: '2026-10-10' }], cols: cols(2) },
    dep: { rows: [{ r: 14, k: '2026-10-09' }, { r: 16, k: '2026-10-10' }], cols: cols(15) },
    spend: { rows: [{ r: 14, k: '2026-10-09' }, { r: 15, k: '2026-10-09' }, { r: 16, k: '2026-10-10' }], cols: cols(9) } });
  c.readLog_ = () => []; c.readDepositLog_ = () => []; c.tz_ = () => 'America/Los_Angeles';
  c.ss_ = () => ({ getSheetByName: () => ({ getLastRow: () => 30, getMaxRows: () => 1000 }) });
  const r = run(c, 'auditReport_()');
  const hit = r.issues.filter(i => i.type === 'value-on-continuation-row');
  assert.strictEqual(hit.length, 1); assert.strictEqual(hit[0].row, 16); assert.strictEqual(hit[0].person, 'Salman'); assert.strictEqual(hit[0].value, 780);
  assert.strictEqual(r.spreadsheetTimeZone, 'America/Los_Angeles'); assert.strictEqual(r.secretConfigured, false);
});
t('reconcile_: flags tab above 80% capacity, duplicate ids and formula-like text; clean data reports none', () => {
  const c = sandbox(); const v = [new Array(5).fill('')];
  c.layout_ = () => ({ kind: 'stacked', v, meals: { rows: [{ r: 0, k: '2026-10-01' }] }, dep: { rows: [], cols: {} }, spend: { rows: [{ r: 0, k: '2026-10-01' }], amountCol: 1 } });
  c.tz_ = () => 'x'; c.readDepositLog_ = () => [];
  c.readLog_ = () => [{ id: 'a', date: '2026-10-01', person: 'Rifat', amount: 5, details: '=HYPERLINK()' }, { id: 'a', date: '2026-10-01', person: 'Rifat', amount: 0, details: '' }];
  c.ss_ = () => ({ getSheetByName: n => ({ getLastRow: () => n === 'Activity' ? 900 : 5, getMaxRows: () => 1000 }) });
  const types = run(c, 'auditReport_()').issues.map(i => i.type);
  ['duplicate-ids', 'formula-like-text', 'tab-nearly-full', 'grocery-mismatch'].forEach(x => assert.ok(types.includes(x), 'missing ' + x));
  c.readLog_ = () => []; c.ss_ = () => ({ getSheetByName: () => ({ getLastRow: () => 5, getMaxRows: () => 1000 }) });
  assert.strictEqual(run(c, 'auditReport_().issueCount'), 0);
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
