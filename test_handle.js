// Run:  FULL_SCRIPT=../app_v2/apps_script/khaddo_tottho.gs node test_handle.js
// SIMULATED: the real assembled script runs in Node with mocked Apps Script services; the spreadsheet itself is not touched.
const vm = require('vm'), fs = require('fs'), crypto = require('crypto'), assert = require('assert');
const file = process.env.FULL_SCRIPT; if (!file) { console.error('set FULL_SCRIPT'); process.exit(2); }
let pass = 0, fail = 0; const out = [];
const t = (n, f) => { try { f(); pass++; out.push('PASS  ' + n); } catch (e) { fail++; out.push('FAIL  ' + n + '\n        ' + e.message); } };
function ctx0(secret) {
  const props = secret ? { SYNC_SECRET: secret } : {}, cache = {};
  const c = { console, Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty() {}, deleteProperty() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
    Utilities: { DigestAlgorithm: { SHA_256: 's' }, computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s)).digest()), getUuid: () => crypto.randomUUID() },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {}, tryLock: () => true, hasLock: () => false }) } };
  vm.createContext(c); vm.runInContext(fs.readFileSync(file, 'utf8'), c);
  c.migrateOnce_ = () => {};
  return c;
}
const admin = { email: 'a@x', name: 'Shihab', admin: true, fundsFor: [], mealsFor: [], canGrocery: true, views: [] };
const member = { email: 'm@x', name: 'Rifat', admin: false, fundsFor: ['Rifat'], mealsFor: [], canGrocery: false, views: [] };
const call = (c, req) => vm.runInContext('handle_(' + JSON.stringify(req) + ')', c);

t('secret path: unset secret -> rejected (fails closed)', () => { const c = ctx0(''); assert.throws(() => call(c, { secret: 'x'.repeat(30), action: 'load' }), /Bad sync secret/); });
t('secret path: wrong secret -> rejected', () => { const c = ctx0('s'.repeat(30)); assert.throws(() => call(c, { secret: 'w'.repeat(30), action: 'load' }), /Bad sync secret/); });
t('secret path: right secret may only load / importBazar, nothing else', () => {
  const c = ctx0('s'.repeat(30));
  for (const a of ['addDeposit', 'savePerms', 'makeAdmin', 'clearSpending', 'reconcile', 'setMeal']) assert.throws(() => call(c, { secret: 's'.repeat(30), action: a }), /Not allowed/, a);
});
t('audit report is admin only', () => { const c = ctx0(''); c.verify_ = () => 'm@x'; c.me_ = () => member; assert.throws(() => call(c, { action: 'reconcile', idToken: 't' }), /Admin only/); });
t('audit report runs for admin', () => { const c = ctx0(''); c.verify_ = () => 'a@x'; c.me_ = () => admin; c.auditReport_ = () => ({ ok: true, issueCount: 0 }); assert.strictEqual(call(c, { action: 'reconcile', idToken: 't' }).issueCount, 0); });
t('same requestId twice -> action runs ONCE, second answer says duplicate', () => {
  const c = ctx0(''); let n = 0; c.verify_ = () => 'm@x'; c.me_ = () => member; c.addDeposit_ = () => { n++; return true; }; c.log_ = () => {};
  const rq = { action: 'addDeposit', idToken: 't', person: 'Rifat', date: '2026-10-14', amount: 5, requestId: 'req-12345678' };
  const a = call(c, rq), b = call(c, rq);
  assert.strictEqual(n, 1); assert.ok(!a.duplicate); assert.strictEqual(b.duplicate, true); assert.strictEqual(b.ok, true);
});
t('different user, same requestId -> not treated as a duplicate', () => {
  const c = ctx0(''); let n = 0; c.addDeposit_ = () => { n++; return true; }; c.log_ = () => {}; c.verify_ = () => 'x';
  c.me_ = () => member; call(c, { action: 'addDeposit', idToken: 't', person: 'Rifat', date: 'd', amount: 5, requestId: 'req-12345678' });
  c.me_ = () => ({ ...member, email: 'other@x' }); call(c, { action: 'addDeposit', idToken: 't', person: 'Rifat', date: 'd', amount: 5, requestId: 'req-12345678' });
  assert.strictEqual(n, 2);
});
t('a FAILED write is not remembered (the retry really runs)', () => {
  const c = ctx0(''); let n = 0; c.verify_ = () => 'm@x'; c.me_ = () => member; c.log_ = () => {};
  c.addDeposit_ = () => { n++; if (n === 1) throw new Error('boom'); return true; };
  const rq = { action: 'addDeposit', idToken: 't', person: 'Rifat', date: 'd', amount: 5, requestId: 'req-87654321' };
  assert.throws(() => call(c, rq), /boom/); assert.strictEqual(call(c, rq).ok, true); assert.strictEqual(n, 2);
});
t('permissions still enforced: member cannot add funds for someone else', () => {
  const c = ctx0(''); c.verify_ = () => 'm@x'; c.me_ = () => member; c.addDeposit_ = () => { throw new Error('should not run'); };
  assert.throws(() => call(c, { action: 'addDeposit', idToken: 't', person: 'Naved', date: 'd', amount: 5 }), /not allowed to add funds/);
});
t('permissions still enforced: non-admin cannot clear / save permissions', () => {
  const c = ctx0(''); c.verify_ = () => 'm@x'; c.me_ = () => member;
  for (const a of ['clearSpending', 'clearDeposit', 'savePerms', 'saveMember', 'makeAdmin', 'ackAlerts']) assert.throws(() => call(c, { action: a, idToken: 't' }), /Admin only/, a);
});
t('permissions still enforced: grocery needs the permission', () => {
  const c = ctx0(''); c.verify_ = () => 'm@x'; c.me_ = () => member;
  assert.throws(() => call(c, { action: 'addSpending', idToken: 't', date: 'd' }), /not allowed to add grocery/);
});
t('mirror merge function keeps its original 3-argument form (no name clash)', () => {
  const c = ctx0('');
  const r = vm.runInContext("reconcile_('2026-10-14', [{time:'09:00',person:'Rifat',amount:5,note:''}], [{id:'abc',person:'Rifat',time:'09:00',details:'d',email:'e',name:'n'}])", c);
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].id, 'abc');
});
console.log(out.join('\n') + `\n\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
