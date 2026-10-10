import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import * as CFG from "./firebase-config.js";
const firebaseConfig = CFG.firebaseConfig;

const $ = id => document.getElementById(id);
const NAMES = ["Shohan", "Naved", "Salman", "Rifat", "Shihab", "Ashmit"];
const fmt = n => "৳" + (Math.round(n * 100) / 100).toLocaleString("en-US");
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = iso(new Date());
const monthKey = todayIso.slice(0, 7);
const num = x => { const n = Number(x); return (x === "" || x == null || isNaN(n)) ? 0 : n; };
const lab = d => new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

$("monthLabel").textContent = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
$("today").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
["spDate", "depDate", "mealDate"].forEach(i => $(i).value = todayIso);

function fillNameSelect(id, blankLabel, exclude) {
  const sel = $(id), keep = sel.value;
  sel.textContent = "";
  if (blankLabel !== undefined) {
    const o = document.createElement("option"); o.value = ""; o.textContent = blankLabel; sel.appendChild(o);
  }
  NAMES.filter(n => n !== exclude).forEach(n => {
    const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o);
  });
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}
fillNameSelect("fundWho", "— নাম নির্বাচন করুন —");
fillNameSelect("mealWho", "— নাম নির্বাচন করুন —");
fillNameSelect("spBazarKorta", "— বাজারকর্তা নির্বাচন করুন —");

// Several independent Google Sheets can be connected (each has its own Apps Script web app + Members tab).
const isUrl = u => /^https?:\/\//.test(u || "") && !String(u).includes("PASTE_");
const books = (Array.isArray(CFG.BOOKS) && CFG.BOOKS.length ? CFG.BOOKS : [{ id: "main", label: "খাদ্য তথ্য", url: CFG.SCRIPT_URL }]).filter(b => isUrl(b.url));
if (!books.length) { $("setup").hidden = false; throw new Error("No sheet connected"); }
let bookIdx = 0;
try { const i = books.findIndex(b => b.id === localStorage.getItem("book")); if (i >= 0) bookIdx = i; } catch (e) { /* private mode */ }
const book = () => books[bookIdx];
$("bookTitle").textContent = book().label;
if (books.length > 1) {
  $("bookBar").hidden = false;
  books.forEach((b, i) => { const o = document.createElement("option"); o.value = i; o.textContent = b.label; $("bookSel").appendChild(o); });
  $("bookSel").value = bookIdx;
}

const auth = getAuth(initializeApp(firebaseConfig));
let me = null;            // the real signed-in user (from the sheet's Members tab)
let U = null;             // the user whose interface is shown (= me, or a member while the admin previews)
let S = null, busy = false, poll = null, previewName = "";
let inlineOpen = false, permDirty = false;
const mealDirty = { lunch: false, dinner: false };
let spBazarDirty = false;

// ---------- API (Google Apps Script web app on top of the sheet) ----------
const isPreview = () => !!(me && me.admin && previewName);
async function api(action, payload = {}) {
  if (action !== "load" && isPreview()) throw new Error("Preview mode: switch back to “Your admin view” to make changes.");
  const idToken = await auth.currentUser.getIdToken();
  const r = await fetch(book().url, { method: "POST", body: JSON.stringify({ action, idToken, ...payload }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Request failed");
  return j;
}
async function act(action, payload) {
  try { await api(action, payload); await refresh(true); return true; }
  catch (e) { alert(e.message); return false; }
}

// ---------- Sign-in ----------
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
$("gBtn").onclick = async () => {
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") signInWithRedirect(auth, provider);
    else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request")
      $("loginMsg").textContent = "Sign-in failed: " + (e.code || e.message);
  }
};
$("out").onclick = $("deniedOut").onclick = () => signOut(auth);
$("refresh").onclick = () => refresh(true);

$("bookSel").addEventListener("change", () => {
  bookIdx = Number($("bookSel").value);
  try { localStorage.setItem("book", book().id); } catch (e) { /* ignore */ }
  $("bookTitle").textContent = book().label;
  me = null; U = null; S = null; previewName = ""; inlineOpen = false; permDirty = false; resetMealDirty(); spBazarDirty = false;
  ["fundWho", "mealWho"].forEach(id => { $(id).value = ""; });
  setLive(false);
  if (!auth.currentUser) return showLogin();
  showLogin("Loading " + book().label + "…", true); $("deniedOut").hidden = true;
  refresh(true);
});

function showLogin(msg, denied) {
  $("app").hidden = true; $("login").hidden = false;
  $("loginMsg").textContent = msg || "Sign in with the Google account the admin added for you.";
  $("gBtn").hidden = !!denied; $("deniedOut").hidden = !denied;
}
function setLive(on) { const l = $("live"); l.textContent = on ? "● live" : "● offline"; l.className = "live " + (on ? "on" : "off"); }

onAuthStateChanged(auth, user => {
  clearInterval(poll); me = null; U = null; S = null; previewName = ""; setLive(false);
  if (!user) return showLogin();
  $("loginMsg").textContent = "Loading…";
  refresh(true);
  poll = setInterval(() => { if (!document.hidden && me) refresh(); }, 15000);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && auth.currentUser) refresh(); });

async function refresh(force) {
  if (busy && !force) return;
  busy = true;
  try {
    S = await api("load"); me = S.me; setLive(true);
    $("login").hidden = true; $("app").hidden = false;
    applyRole(); render(); renderAlerts(); syncMeal(); syncSpBazar();
  } catch (e) {
    if (/group list/i.test(e.message)) showLogin(e.message + ". Ask the admin to add this email.", true);
    else { setLive(false); if (!me) showLogin("Could not reach the sheet: " + e.message, true); }
  } finally { busy = false; }
}

// ---------- Who is the interface for (admin preview) ----------
function effectiveMember() {
  const m = (S.members || []).find(x => x.name === previewName);
  return m || { name: previewName, email: "", admin: false, addFor: [], fundsFor: [], mealsFor: [], canGrocery: false, canFunds: false, canMeals: false };
}
function buildPreviewSelect() {
  const sel = $("adminPreview");
  if (sel.dataset.for === me.name) return;
  sel.dataset.for = me.name; sel.textContent = "";
  const own = document.createElement("option"); own.value = ""; own.textContent = "Your admin view"; sel.appendChild(own);
  NAMES.filter(n => n !== me.name).forEach(n => { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); });
  sel.value = previewName;
}
$("adminPreview").addEventListener("change", () => {
  previewName = $("adminPreview").value;
  const who = previewName || me.name;
  $("fundWho").value = who; $("mealWho").value = who;
  resetMealDirty(); inlineOpen = false;
  applyRole(); render(); renderAlerts(); syncMeal(); syncSpBazar();
});

function applyRole() {
  if (!me.admin) previewName = "";
  U = isPreview() ? effectiveMember() : me;
  $("me").textContent = `${me.name} · ${me.admin ? "Admin" : "Member"}${isPreview() ? " (previewing " + previewName + ")" : ""}`;
  $("app").classList.toggle("previewing", isPreview());
  $("previewNotice").hidden = !isPreview();
  $("adminPreview").hidden = !me.admin;
  if (me.admin) buildPreviewSelect();
  document.querySelectorAll(".adminOnly").forEach(el => { el.hidden = !U.admin; });
  $("spendAddBox").hidden = !(U.admin || U.canGrocery);
  ["fundWho", "mealWho"].forEach(id => { if (!$(id).value && NAMES.includes(U.name)) $(id).value = U.name; });
  if (U.admin) {
    if (!$("memberList").contains(document.activeElement)) renderMembers();
    if (!permDirty && !$("permEditor").contains(document.activeElement)) renderPermissionEditor();
  }
}

// ---------- Numbers ----------
function relDate(d) {
  if (!d) return "N/A";
  if (d === todayIso) return "TODAY";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (d === iso(y)) return "YESTERDAY";
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

// ---- stats (pure) ----
// "in spending": my deposit - (this month's spending / people).  "in fund": my deposit - (total fund / people).
// Positive balance = residual, negative = due.
function statsFor(S, name, email) {
  const r2 = x => Math.round(x * 100) / 100;
  const monthSpent = S.spending.filter(e => e.date.slice(0, 7) === monthKey).reduce((t, e) => t + num(e.amount), 0);
  const dep = S.depDates.reduce((t, d) => t + num(S.deposits[d][name]), 0);
  const fundTotal = S.depDates.reduce((t, d) => t + NAMES.reduce((u, n) => u + num(S.deposits[d][n]), 0), 0);
  const spendShare = monthSpent / NAMES.length, fundShare = fundTotal / NAMES.length;
  const entries = [];
  S.depDates.forEach(d => NAMES.forEach(n => {
    const amount = num(S.deposits[d][n]);
    if (amount > 0) entries.push({ date: d, person: n, amount, by: (S.depMeta || {})[d + "|" + n] || null });
  }));
  entries.sort((a, b) => a.date.localeCompare(b.date));
  const mine = entries.filter(e => e.by && email && e.by.email === email);
  return { dep, monthSpent, fundTotal, spendShare, fundShare,
    balSpend: r2(dep - spendShare), balFund: r2(dep - fundShare),
    lastFund: entries[entries.length - 1] || null, lastFundByMe: mine[mine.length - 1] || null };
}
// ---- end stats ----
const balanceOf = n => { const s = statsFor(S, n); return { dep: s.dep, share: s.spendShare, bal: s.balSpend }; };
const monthSpent = () => statsFor(S, NAMES[0]).monthSpent;

function setSelectValue(sel, v) {
  if (v && ![...sel.options].some(o => o.value === v)) { const o = document.createElement("option"); o.value = v; o.textContent = v; sel.appendChild(o); }
  sel.value = v || "";
}
const dateChip = d => { const b = document.createElement("b"); b.className = "sp-date"; b.textContent = d; return b; };

// ---------- Rendering ----------
function render() {
  const st = statsFor(S, U.name, U.email);
  $("myDep").textContent = fmt(st.dep);
  $("myResFund").textContent = fmt(Math.max(st.balFund, 0));
  $("myDueFund").textContent = fmt(Math.max(-st.balFund, 0));
  $("resFundNote").textContent = `Fund share ${fmt(st.fundShare)} (${fmt(st.fundTotal)} ÷ ${NAMES.length})`;
  $("dueFundCard").classList.toggle("neg", st.balFund < 0);
  $("myRes").textContent = fmt(Math.max(st.balSpend, 0));
  $("myDue").textContent = fmt(Math.max(-st.balSpend, 0));
  $("resNote").textContent = `Share ${fmt(st.spendShare)} (${fmt(st.monthSpent)} ÷ ${NAMES.length})`;
  $("dueCard").classList.toggle("neg", st.balSpend < 0);

  const lf = st.lastFund, lm = st.lastFundByMe;
  $("lastFund").textContent = lf ? fmt(lf.amount) : "N/A";
  $("lastFundMeta").textContent = lf ? `${lf.date} · ${lf.person}` : "";
  $("lastFundMine").textContent = lm ? fmt(lm.amount) : "N/A";
  $("lastFundMineMeta").textContent = lm ? `${lm.date} · for ${lm.person}` : "";

  const spent = S.spending.filter(e => e.date <= todayIso);
  const lastBazar = [...spent].filter(e => num(e.amount) > 0).sort((a, b) => a.date.localeCompare(b.date)).pop();
  $("lastDate").textContent = relDate(lastBazar && lastBazar.date);
  const out = spent.reduce((t, e) => t + num(e.amount), 0);
  $("fund").textContent = fmt(st.fundTotal);
  $("spent").textContent = fmt(out);
  $("left").textContent = fmt(st.fundTotal - out);
  $("leftcard").classList.toggle("neg", st.fundTotal - out < 0);
  $("last").textContent = lastBazar ? fmt(num(lastBazar.amount)) : "N/A";
  const ld = $("lastd"); ld.textContent = "";
  if (lastBazar) {
    ld.appendChild(dateChip(lastBazar.date));
    const det = lastBazar.details && lastBazar.details !== "N/A" ? lastBazar.details : "";
    const baz = lastBazar.bazarKorta;
    if (det) ld.append(" · " + det);
    if (baz) ld.append(" · বাজারকর্তা: " + baz);
  }

  if (!inlineOpen) renderHistories();
  const mealWho = $("mealWho").value;
  $("mealPerson").hidden = !mealWho;
  if (mealWho) renderMealHistory(mealWho);
  renderTables();
}

const latestSpendingDate = () => {
  const l = S.spending.filter(e => num(e.amount) > 0).map(e => e.date).sort().pop();
  return l || "";
};
const canEditSpending = e => U.admin || !!(U.canGrocery && e.date === latestSpendingDate() && e.addedByEmail && e.addedByEmail === U.email);
const canFundFor = who => !!(who && (U.admin || (U.fundsFor || []).includes(who)));

function renderHistories() {
  // grocery history (all dates, from the Grocery Spending table)
  const sl = $("spList"); sl.textContent = "";
  const sp = S.spending.filter(e => num(e.amount) > 0).sort((a, b) => b.date.localeCompare(a.date) || NAMES.indexOf(a.bazarKorta) - NAMES.indexOf(b.bazarKorta));
  if (!sp.length) sl.textContent = "No spending yet";
  sp.forEach(e => sl.appendChild(spendingRowEl(e)));

  // fund history of the selected person (all dates, from the Deposits table)
  const who = $("fundWho").value;
  $("fundPerson").hidden = !who;
  $("depForm").hidden = !canFundFor(who);
  if (!who) return;
  const mine = S.depDates.filter(d => num(S.deposits[d][who]) > 0).sort();
  $("pt").textContent = fmt(mine.reduce((t, d) => t + num(S.deposits[d][who]), 0));
  const dl = $("deps"); dl.textContent = "";
  if (!mine.length) dl.textContent = "এখনো কোনো জমা নেই";
  const latest = mine[mine.length - 1];
  mine.slice().reverse().forEach(d => dl.appendChild(depositRowEl(d, who, d === latest)));
}

function actionsEl(editFn, delFn) {
  const b = document.createElement("span"); b.className = "rowActions";
  if (editFn) { const x = document.createElement("button"); x.className = "editBtn"; x.textContent = "Edit"; x.onclick = editFn; b.appendChild(x); }
  if (delFn) {
    const x = document.createElement("button"); x.className = "x"; x.textContent = "✕"; x.title = "Clear";
    x.onclick = () => { if (confirm("Clear this entry in the sheet?")) delFn(); };
    b.appendChild(x);
  }
  return b;
}
function amountEl(text) { const v = document.createElement("b"); v.className = "amt"; v.textContent = text; return v; }

function spendingRowEl(e) {
  const r = document.createElement("div"); r.className = "row spendingRow";
  const a = document.createElement("span"); a.className = "spendingDescription";
  a.appendChild(dateChip(e.date));
  const det = e.details && e.details !== "N/A" ? e.details : "", baz = e.bazarKorta || "";
  if (det) a.append(" · " + det);
  if (baz) a.append(" · বাজারকর্তা: " + baz);
  const right = document.createElement("span"); right.className = "rowRight";
  right.append(amountEl(fmt(num(e.amount))),
    actionsEl(canEditSpending(e) ? () => openInline(r, { title: `Edit grocery · ${e.date}`, amount: e.amount, details: det, withDetails: true, withBazar: true, bazar: baz || "", lockBazar: S.layout === "blocks",
        save: (amount, details, bazarKorta) => act("editSpending", { date: e.date, person: baz, amount, details, bazarKorta }) }) : null,
      U.admin ? () => act("clearSpending", { date: e.date, person: baz }) : null));
  r.append(a, right);
  return r;
}
function depositRowEl(d, who, isLatest) {
  const amount = num(S.deposits[d][who]);
  const r = document.createElement("div"); r.className = "row";
  const a = document.createElement("span"); a.appendChild(dateChip(d));
  const editable = U.admin || (who === U.name && isLatest);
  const right = document.createElement("span"); right.className = "rowRight";
  right.append(amountEl(fmt(amount)),
    actionsEl(editable ? () => openInline(r, { title: `Edit ${who}'s fund · ${d} (total for this date)`, amount, withDetails: false,
        save: amt => act("editDeposit", { date: d, person: who, amount: amt }) }) : null,
      U.admin ? () => act("clearDeposit", { date: d, person: who }) : null));
  r.append(a, right);
  return r;
}

// Inline editor (keeps multi-line details). Stays open during the 15 s refresh.
function openInline(rowNode, cfg) {
  inlineOpen = true;
  rowNode.textContent = ""; rowNode.classList.add("editing");
  const f = document.createElement("form"); f.className = "inlineEdit";
  const t = document.createElement("div"); t.className = "inlineTitle"; t.textContent = cfg.title;
  const a = document.createElement("input"); a.type = "number"; a.step = "any"; a.min = "0"; a.required = true; a.value = cfg.amount;
  f.append(t, a);
  let d = null;
  if (cfg.withDetails) { d = document.createElement("textarea"); d.rows = 4; d.value = cfg.details || ""; d.placeholder = "Details"; f.appendChild(d); }
  let bz = null;
  if (cfg.withBazar) {
    const l = document.createElement("label"); l.className = "inlineLabel"; l.textContent = "বাজারকর্তা";
    bz = document.createElement("select");
    [["", "— বাজারকর্তা নির্বাচন করুন —"], ...NAMES.map(n => [n, n])].forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; bz.appendChild(o); });
    setSelectValue(bz, cfg.bazar || "");
    bz.disabled = !!cfg.lockBazar || (!U.admin && !!cfg.bazar);   // new sheet: the amount sits in that person's cell, so it is fixed. Old sheet: non-admins can only fill it while empty
    f.append(l, bz);
  }
  const bar = document.createElement("div"); bar.className = "inlineBtns";
  const ok = document.createElement("button"); ok.textContent = "Save";
  const no = document.createElement("button"); no.type = "button"; no.textContent = "Cancel";
  no.onclick = () => { inlineOpen = false; render(); };
  bar.append(ok, no); f.appendChild(bar);
  f.onsubmit = async ev => {
    ev.preventDefault();
    const done = await cfg.save(Number(a.value), d ? d.value : undefined, bz ? bz.value : undefined);
    if (done) { inlineOpen = false; render(); }
  };
  rowNode.appendChild(f); a.focus();
}

function renderMealHistory(name) {
  const box = $("mealHistory"); box.textContent = "";
  const rows = [];
  S.mealDates.forEach(d => {
    const cell = S.meals[d][name], has = cell !== "" && cell != null && cell !== "N/A";
    const n = (S.mealNotes || {})[name + "|" + d];
    if (has || (n && (n.lunch || n.dinner))) rows.push({ date: d, count: has ? cell : "", lunch: n && n.lunch, dinner: n && n.dinner });
  });
  rows.sort((a, b) => b.date.localeCompare(a.date));
  if (!rows.length) { box.textContent = "No meal entries yet"; return; }
  rows.forEach(e => {
    const r = document.createElement("div"); r.className = "row mealHistoryRow";
    const a = document.createElement("span"); a.className = "spendingDescription"; a.appendChild(dateChip(e.date));
    const parts = [];
    if (e.lunch || e.dinner) parts.push(`দুপুর: ${e.lunch || "—"} · রাত: ${e.dinner || "—"}`);
    if (parts.length) a.append(" · " + parts.join(" · "));
    r.append(a, e.count !== "" ? amountEl(`${e.count} meal${num(e.count) === 1 ? "" : "s"}`) : document.createElement("span"));
    box.appendChild(r);
  });
}

function table(head, rows, total, hl) {
  const t = document.createElement("table"); t.className = "sheetTbl";
  const hr = t.createTHead().insertRow();
  head.forEach(h => { const th = document.createElement("th"); th.textContent = h; hr.appendChild(th); });
  const tb = t.createTBody();
  rows.forEach(([key, ...cells]) => {
    const tr = tb.insertRow(); if (key === hl) tr.className = "today";
    [lab(key), ...cells].forEach(c => { const td = tr.insertCell(); td.textContent = c === undefined || c === null ? "" : c; if (String(c).includes("\n")) td.style.whiteSpace = "pre-line"; });
  });
  if (total) { const tr = tb.insertRow(); tr.className = "total"; total.forEach(c => { tr.insertCell().textContent = c; }); }
  return t;
}
function renderTables() {
  const sums = (dates, src) => NAMES.map(n => dates.reduce((t, d) => t + num(src[d][n]), 0));
  const put = (id, el) => { const b = $(id); b.textContent = ""; b.appendChild(el); };
  put("tblMeals", table(["Tarikh", ...NAMES], S.mealDates.map(d => [d, ...NAMES.map(n => S.meals[d][n])]),
    ["Total meal", ...sums(S.mealDates, S.meals)], todayIso));
  put("tblDeposits", table(["Tarikh", ...NAMES], S.depDates.map(d => [d, ...NAMES.map(n => S.deposits[d][n])]),
    ["Total", ...sums(S.depDates, S.deposits).map(fmt)], todayIso));
  if (S.layout === "blocks" && S.bazarGrid) {
    const dates = Object.keys(S.bazarGrid).sort();
    put("tblSpending", table(["Tarikh", ...NAMES], dates.map(d => [d, ...NAMES.map(n => S.bazarGrid[d][n])]),
      ["Total", ...sums(dates, S.bazarGrid).map(fmt)], todayIso));
  } else {
    put("tblSpending", table(["Tarikh", "Spending", "Details", "বাজারকর্তা"], S.spending.map(e => [e.date, e.amount, e.details, e.bazarKorta || ""]),
      ["Total spending", fmt(S.spending.reduce((t, e) => t + num(e.amount), 0)), "", ""], todayIso));
  }
}

// ---------- Admin: members + permissions ----------
function renderMembers() {
  const box = $("memberList"); box.textContent = "";
  NAMES.forEach(name => {
    const u = (S.members || []).find(x => x.name === name);
    const row = document.createElement("div"); row.className = "mrow";
    const label = document.createElement("div"); label.className = "mname";
    label.textContent = name + (u && u.admin ? " · Admin" : " · Member");
    const input = document.createElement("input"); input.type = "email"; input.placeholder = "Google email"; input.value = u ? u.email : "";
    const save = document.createElement("button"); save.textContent = "Save";
    save.onclick = () => act("saveMember", { name, email: input.value });
    row.append(label, input, save);
    if (u && !u.admin) {
      const mk = document.createElement("button"); mk.textContent = "Make admin";
      mk.onclick = () => { if (confirm(`Make ${name} the admin? You will become a regular member.`)) act("makeAdmin", { email: u.email }); };
      row.appendChild(mk);
    }
    box.appendChild(row);
  });
}
let permDraft = {}, permTarget = "";
function renderPermissionEditor() {
  const sel = $("permPerson"), keep = sel.value;
  sel.textContent = "";
  const blank = document.createElement("option"); blank.value = ""; blank.textContent = "— Select person —"; sel.appendChild(blank);
  NAMES.filter(n => n !== me.name && (S.members || []).some(m => m.name === n)).forEach(n => {
    const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o);
  });
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  syncPermissionEditor();
}
function syncPermissionEditor() {
  const name = $("permPerson").value, u = (S.members || []).find(x => x.name === name);
  $("permEditor").hidden = !u;
  if (!u) return;
  permDraft = {};
  NAMES.filter(n => n !== name).forEach(n => { permDraft[n] = { funds: (u.fundsFor || []).includes(n), meals: (u.mealsFor || []).includes(n) }; });
  $("permGrocery").checked = !!u.canGrocery;
  permTarget = "";
  drawPermWho(); drawPermTarget();
}
const permLabel = p => [p.funds ? "Funds" : "", p.meals ? "Meal details" : ""].filter(Boolean).join(" + ");
function drawPermWho() {                       // "Select who's": pick a person to set what this member may add for them
  const box = $("permWho"); box.textContent = "";
  Object.keys(permDraft).forEach(n => {
    const b = document.createElement("button"); b.type = "button";
    b.className = "whoBtn" + (n === permTarget ? " on" : "") + (permDraft[n].funds || permDraft[n].meals ? " has" : "");
    b.textContent = n + (permDraft[n].funds || permDraft[n].meals ? " ✓" : "");
    b.onclick = () => { permTarget = n; permDirty = true; drawPermWho(); drawPermTarget(); };
    box.appendChild(b);
  });
  const lines = Object.keys(permDraft).filter(n => permDraft[n].funds || permDraft[n].meals).map(n => `${n}: ${permLabel(permDraft[n])}`);
  $("permSummary").textContent = lines.length ? "Can add for → " + lines.join(" · ") : "No add-on-behalf permissions yet";
}
function drawPermTarget() {                    // that person's permissions appear after selecting them
  $("permTargetBox").hidden = !permTarget;
  if (!permTarget) return;
  $("permTargetTitle").textContent = `Permissions for ${permTarget}`;
  $("permTFunds").checked = permDraft[permTarget].funds;
  $("permTMeals").checked = permDraft[permTarget].meals;
}
["permTFunds", "permTMeals"].forEach(id => $(id).addEventListener("change", () => {
  if (!permTarget) return;
  permDraft[permTarget] = { funds: $("permTFunds").checked, meals: $("permTMeals").checked };
  permDirty = true; drawPermWho();
}));
$("permGrocery").addEventListener("change", () => { permDirty = true; });
$("permPerson").addEventListener("change", () => { permDirty = false; syncPermissionEditor(); });
$("savePerms").addEventListener("click", async () => {
  const name = $("permPerson").value, u = (S.members || []).find(x => x.name === name);
  if (!u) return;
  const ok = await act("savePerms", {
    email: u.email, canGrocery: $("permGrocery").checked,
    fundsFor: Object.keys(permDraft).filter(n => permDraft[n].funds), mealsFor: Object.keys(permDraft).filter(n => permDraft[n].meals) });
  if (ok) { permDirty = false; syncPermissionEditor(); }
});

// ---------- Forms ----------
$("spForm").addEventListener("submit", async e => {
  e.preventDefault();
  const ok = await act("addSpending", { date: $("spDate").value, amount: $("spAmt").value, details: $("spDet").value.trim(), bazarKorta: $("spBazarKorta").value });
  if (ok) { $("spAmt").value = ""; $("spDet").value = ""; spBazarDirty = false; syncSpBazar(); }
});
// বাজারকর্তা is one person per date: pre-fill it from the sheet, and lock it for non-admins once set
function syncSpBazar() {
  if (!S) return;
  if (S.layout === "blocks") { $("spBazarKorta").disabled = false; return; }   // new sheet: several people can shop on one date
  const ex = (S.bazar || {})[$("spDate").value] || "";
  if (!spBazarDirty) setSelectValue($("spBazarKorta"), ex);
  $("spBazarKorta").disabled = !U.admin && !!ex;
}
$("spBazarKorta").addEventListener("change", () => { spBazarDirty = true; });
$("spDate").addEventListener("change", () => { spBazarDirty = false; syncSpBazar(); });
$("depForm").addEventListener("submit", async e => {
  e.preventDefault();
  const ok = await act("addDeposit", { date: $("depDate").value, person: $("fundWho").value, amount: $("depAmt").value });
  if (ok) $("depAmt").value = "";
});
$("fundWho").addEventListener("change", () => { inlineOpen = false; render(); });

// ---------- Meal details: lunch / dinner / বাজারকর্তা ----------
// Sheet cell = number of meals (a filled box counts 1, or the number typed); the text is kept in the MealDetails tab.
const noteKey = () => `${$("mealWho").value}|${$("mealDate").value}`;
const resetMealDirty = () => { mealDirty.lunch = mealDirty.dinner = false; };
// full = admin or own meals (auto-save). add = permitted person adding for someone else (fill empty boxes, press Save).
function mealMode() {
  const who = $("mealWho").value, date = $("mealDate").value;
  if (!U || !S || !who || !S.mealDates.includes(date)) return null;
  if (U.admin || who === U.name) return "full";
  if ((U.mealsFor || []).includes(who)) return "add";
  return null;
}
function setEditable() {
  const mode = mealMode(), who = $("mealWho").value, date = $("mealDate").value;
  if (!S) return;
  const n = (S.mealNotes || {})[`${who}|${date}`] || { lunch: "", dinner: "" };
  let roL = true, roD = true;
  if (mode === "full") { roL = false; roD = false; }
  else if (mode === "add") {
    const cell = S.meals[date] ? S.meals[date][who] : "";
    const locked = cell !== "" && cell != null && cell !== "N/A" && !n.lunch && !n.dinner;
    roL = locked || !!n.lunch; roD = locked || !!n.dinner;
  }
  $("lunch").readOnly = roL; $("dinner").readOnly = roD;
  $("mealSave").hidden = !(mode === "add" && (!roL || !roD));
  $("status").textContent = !who ? ""
    : !S.mealDates.includes(date) ? "This date is not in the sheet"
    : mode === "add" ? "Add-only: fill an empty box and press Save. Saved entries can only be changed by the admin."
    : mode === "full" ? "Tip: a box with 1 (or any text) counts as that many meals in the sheet"
    : "View only — only this person, the admin or a permitted person can add";
}
function syncMeal() {
  if (!$("mealWho").value) return;
  const n = (S.mealNotes || {})[noteKey()] || { lunch: "", dinner: "" };
  if (!mealDirty.lunch && document.activeElement !== $("lunch")) $("lunch").value = n.lunch;
  if (!mealDirty.dinner && document.activeElement !== $("dinner")) $("dinner").value = n.dinner;
  setEditable();
}
async function sendMeal() {
  $("status").textContent = "Saving…";
  try {
    await api("setMeal", { person: $("mealWho").value, date: $("mealDate").value, lunch: $("lunch").value, dinner: $("dinner").value });
    resetMealDirty();
    $("status").textContent = "Saved to sheet ✓";
    refresh(true);
  } catch (e) { $("status").textContent = "Save failed: " + e.message; }
}
let saveTimer;
function autoSaveMeal() {                      // auto-save (full mode only)
  if (mealMode() !== "full") return;
  $("status").textContent = "Saving…";
  clearTimeout(saveTimer); saveTimer = setTimeout(sendMeal, 600);
}
$("mealSave").onclick = () => { if (mealMode() === "add") sendMeal(); };
["lunch", "dinner"].forEach(k => $(k).addEventListener("input", () => { mealDirty[k] = true; autoSaveMeal(); }));
const clearMealFields = () => { resetMealDirty(); $("lunch").value = ""; $("dinner").value = ""; };
$("mealWho").addEventListener("change", () => { clearMealFields(); render(); syncMeal(); });
$("mealDate").addEventListener("change", () => { clearMealFields(); syncMeal(); });

// ---------- Print / Save as PDF ----------
function rTable(head, rows, foot) {
  const t = document.createElement("table");
  const hr = t.createTHead().insertRow();
  head.forEach(h => { const th = document.createElement("th"); th.textContent = h; hr.appendChild(th); });
  const tb = t.createTBody();
  rows.forEach(r => { const tr = tb.insertRow(); r.forEach(c => { tr.insertCell().textContent = c; }); });
  if (foot) { const tr = tb.insertRow(); tr.className = "rp-total"; foot.forEach(c => { tr.insertCell().textContent = c; }); }
  return t;
}
function buildReport(parts) {
  const R = $("report"); R.textContent = "";
  const add = (cls, text) => { const e = document.createElement("div"); e.className = cls; e.textContent = text; R.appendChild(e); };
  const month = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
  add("rp-h1", `খাদ্য তথ্য — ${month}`);
  add("rp-sub", `Printed ${new Date().toLocaleString("en-GB")} · ${U.name}`);
  const st = statsFor(S, U.name, U.email);

  if (parts.includes("my")) {
    add("rp-h2", `My data — ${U.name}`);
    R.appendChild(rTable(["Item", "Amount"], [
      ["My deposit to fund", fmt(st.dep)],
      [`My fund share (${fmt(st.fundTotal)} ÷ ${NAMES.length})`, fmt(st.fundShare)],
      [st.balFund < 0 ? "My due in fund" : "My residual in fund", fmt(Math.abs(st.balFund))],
      [`My spending share (${fmt(st.monthSpent)} ÷ ${NAMES.length})`, fmt(st.spendShare)],
      [st.balSpend < 0 ? "My due in spending" : "My residual in spending", fmt(Math.abs(st.balSpend))]]));
    add("rp-h3", "My deposits");
    const mine = S.depDates.filter(d => num(S.deposits[d][U.name]) > 0);
    if (mine.length) R.appendChild(rTable(["Date", "Amount"], mine.map(d => [d, fmt(num(S.deposits[d][U.name]))]), ["Total", fmt(st.dep)]));
    else add("rp-note", "No deposits yet");
  }
  if (parts.includes("fund")) {
    const out = S.spending.filter(e => e.date <= todayIso).reduce((t, e) => t + num(e.amount), 0);
    add("rp-h2", "Fund data");
    R.appendChild(rTable(["Item", "Amount"], [["Total fund", fmt(st.fundTotal)], ["Total spending", fmt(out)], ["Money left in the fund", fmt(st.fundTotal - out)]]));
    add("rp-h3", `Everyone (spending share ${fmt(st.spendShare)}, fund share ${fmt(st.fundShare)})`);
    const rows = NAMES.map(n => { const s = statsFor(S, n);
      return [n, fmt(s.dep), s.balFund >= 0 ? fmt(s.balFund) : "", s.balFund < 0 ? fmt(-s.balFund) : "", s.balSpend >= 0 ? fmt(s.balSpend) : "", s.balSpend < 0 ? fmt(-s.balSpend) : ""]; });
    R.appendChild(rTable(["Name", "Deposit", "Residual in fund", "Due in fund", "Residual in spending", "Due in spending"], rows));
  }
  if (parts.includes("bazar")) {
    const sp = S.spending.filter(e => num(e.amount) > 0).sort((x, y) => x.date.localeCompare(y.date) || NAMES.indexOf(x.bazarKorta) - NAMES.indexOf(y.bazarKorta));
    add("rp-h2", "Bazar data");
    if (sp.length) R.appendChild(rTable(["Date", "Amount", "Details", "বাজারকর্তা"],
      sp.map(e => [e.date, fmt(num(e.amount)), e.details === "N/A" ? "" : e.details, e.bazarKorta || ""]),
      ["Total", fmt(sp.reduce((t, e) => t + num(e.amount), 0)), "", ""]));
    else add("rp-note", "No bazar entries yet");
  }
}
function printReport(parts) {
  if (!S || !me) return;
  buildReport(parts);
  const old = document.title;
  document.title = `khaddo-${monthKey}-${parts.join("-")}`;
  window.addEventListener("afterprint", () => { document.title = old; }, { once: true });
  window.print();
}
document.querySelectorAll("[data-p]").forEach(b => {
  b.onclick = () => printReport(b.dataset.p === "all" ? ["my", "fund", "bazar"] : [b.dataset.p]);
});

// ---------- Admin alerts (entries made or edited by permitted people) ----------
function alertLine(x) {
  const d = document.createElement("div"); d.className = "alertLine";
  const when = new Date(x.time), ts = isNaN(when) ? "" : when.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  d.textContent = `${ts} · ${x.by}: ${x.detail}`; return d;
}
function renderAlerts() {
  const list = (U && U.admin && S && S.alerts) || [];      // never shown while previewing a member
  const bar = $("alertBar"); bar.textContent = ""; bar.hidden = !list.length;
  if (list.length) {
    const head = document.createElement("div"); head.className = "alertHead";
    const tt = document.createElement("span"); tt.textContent = `⚠ ${list.length} new ${list.length > 1 ? "entries" : "entry"} by permitted people`;
    const b = document.createElement("button"); b.textContent = "Acknowledged"; b.onclick = () => act("ackAlerts", { all: true });
    head.append(tt, b); bar.appendChild(head);
    list.slice(-8).reverse().forEach(x => bar.appendChild(alertLine(x)));
    if (list.length > 8) { const m = document.createElement("div"); m.className = "alertLine"; m.textContent = `+ ${list.length - 8} more`; bar.appendChild(m); }
  }
  ["deposit", "spending", "meal"].forEach(type => {
    const items = list.filter(x => x.type === type);
    document.querySelectorAll(`.alertDot[data-alert="${type}"]`).forEach(el => { el.hidden = !items.length; el.textContent = `⚠ ${items.length}`; });
    document.querySelectorAll(`.secAlert[data-alert="${type}"]`).forEach(el => {
      el.textContent = ""; el.hidden = !items.length; if (!items.length) return;
      items.slice().reverse().forEach(x => el.appendChild(alertLine(x)));
      const b = document.createElement("button"); b.textContent = "Acknowledged"; b.onclick = () => act("ackAlerts", { type }); el.appendChild(b);
    });
  });
}
