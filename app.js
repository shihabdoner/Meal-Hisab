import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import * as CFG from "./firebase-config.js";
const firebaseConfig = CFG.firebaseConfig;

const $ = id => document.getElementById(id);
const NAMES = ["Shohan", "Naved", "Salman", "Rifat", "Shihab", "Ashmit"];

// What the admin can show / hide for each member (keys match VIEW_KEYS in the Apps Script)
const VIEW_SHEETS = [["sheetMeals", "Meals (per day) table"], ["sheetSpending", "Grocery spending table"], ["sheetDeposits", "Deposits table"]];
const VIEW_CARDS = [["myDep", "My deposit to fund"], ["resid", "My residuals"], ["due", "My dues"], ["lastFund", "Most recent added fund"],
  ["lastDate", "সর্বশেষ বাজারের তারিখ"], ["lastGrocery", "Last grocery spending"], ["totalFund", "Total fund"], ["totalSpent", "Total spending"], ["left", "Money left in the fund"]];
const ALL_VIEWS = [...VIEW_SHEETS, ...VIEW_CARDS].map(x => x[0]);

const fmt = n => "৳" + (Math.round(n * 100) / 100).toLocaleString("en-US");
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = iso(new Date());
const nowDate = () => iso(new Date());                       // always the real "today" (the page may stay open past midnight)
const nowTime = () => { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
const monthKey = todayIso.slice(0, 7);
const num = x => { const n = Number(x); return (x === "" || x == null || isNaN(n)) ? 0 : n; };
const lab = d => new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const byWhen = (a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || "");
const cleanDet = d => (d && d !== "N/A") ? d : "";
const openMore = new Set();                                  // "See more" panels the person opened (kept across the 15 s refresh)

$("monthLabel").textContent = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
$("today").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
["spDate", "depDate", "mealDate"].forEach(i => $(i).value = todayIso);
$("spDate").max = todayIso;                                  // grocery cannot be added for a future date

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

// ---------- Members: slide-open sections ----------
document.querySelectorAll(".sec").forEach(sec => {
  const title = sec.querySelector(".secTitle");
  const body = document.createElement("div"); body.className = "secBody";
  const inner = document.createElement("div"); inner.className = "secInner";
  [...sec.children].filter(c => c !== title).forEach(c => inner.appendChild(c));
  body.appendChild(inner); sec.appendChild(body);
  const toggle = () => {
    if (!document.body.classList.contains("isMember")) return;   // admin: nothing happens
    title.setAttribute("aria-expanded", sec.classList.toggle("open"));
  };
  title.addEventListener("click", toggle);
  title.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
});
let wasMember = null;
function setMemberView(on) {
  document.body.classList.toggle("isMember", on);
  document.querySelectorAll(".sec").forEach(sec => {
    const t = sec.querySelector(".secTitle");
    if (on) { t.setAttribute("role", "button"); t.tabIndex = 0; }
    else { t.removeAttribute("role"); t.removeAttribute("tabindex"); t.removeAttribute("aria-expanded"); sec.classList.remove("open"); }
    if (on && wasMember !== true) {                // first time in member view: Meal open, others closed
      const open = sec.classList.contains("secMeal");
      sec.classList.toggle("open", open); t.setAttribute("aria-expanded", open);
    }
  });
  wasMember = on;
}

// Several Google Sheets are connected (each has its own Apps Script web app + Members tab).
const isUrl = u => /^https?:\/\//.test(u || "") && !String(u).includes("PASTE_");
const books = (Array.isArray(CFG.BOOKS) && CFG.BOOKS.length ? CFG.BOOKS : [{ id: "main", label: "খাদ্য তথ্য", url: CFG.SCRIPT_URL }]).filter(b => isUrl(b.url));
if (!books.length) { $("setup").hidden = false; throw new Error("No sheet connected"); }

// "খাদ্য তথ্য" is the source of truth: every number, history, alert and permission comes from it.
const srcBook = books.find(b => b.id === "khaddo") || books[0];
const otherBooks = books.filter(b => b !== srcBook);

const auth = getAuth(initializeApp(firebaseConfig));
let me = null;            // the real signed-in user (from the sheet's Members tab)
let U = null;             // the user whose interface is shown (= me, or a member while the admin previews)
let S = null;             // data of the source sheet (everything except the Sheet view tables)
let T = null, tblErr = ""; // data shown in the Sheet view tables
let busy = false, poll = null, previewName = "", autoSynced = false;
let inlineOpen = false, permDirty = false;
const mealDirty = { lunch: false, dinner: false };

// Sheet view: members always see "বেলা হিসাব" (id "bazar"); the admin chooses with the dropdown.
const memberIdx = Math.max(0, books.findIndex(b => b.id === "bazar"));
let adminIdx = 0;
try { const i = books.findIndex(b => b.id === localStorage.getItem("book")); if (i >= 0) adminIdx = i; } catch (e) { /* private mode */ }
const tblIdx = () => (me && me.admin && !previewName) ? adminIdx : memberIdx;
books.forEach((b, i) => { const o = document.createElement("option"); o.value = i; o.textContent = b.label; $("bookSel").appendChild(o); });
$("bookSel").value = adminIdx;
$("bookTitle").textContent = srcBook.label;
$("bookSel").addEventListener("change", () => {
  adminIdx = Number($("bookSel").value);
  try { localStorage.setItem("book", books[adminIdx].id); } catch (e) { /* ignore */ }
  refresh(true);
});

// ---------- API (Google Apps Script web app on top of each sheet) ----------
const isPreview = () => !!(me && me.admin && previewName);
async function call(url, action, payload, idToken) {
  const r = await fetch(url, { method: "POST", body: JSON.stringify({ action, idToken, ...payload }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Request failed");
  return j;
}
const loadSheet = async b => call(b.url, "load", {}, await auth.currentUser.getIdToken());
async function syncMirrors(idToken) {
  idToken = idToken || await auth.currentUser.getIdToken();
  const fails = [];
  await Promise.all(otherBooks.map(b => call(b.url, "syncFromSource", {}, idToken)
    .then(j => { if (j.warn) fails.push(b.label + ": " + j.warn); })
    .catch(e => fails.push(b.label + ": " + e.message))));
  return fails;
}
async function api(action, payload = {}) {
  if (action !== "load" && isPreview()) throw new Error("Preview mode: switch back to “Your admin view” to make changes.");
  const idToken = await auth.currentUser.getIdToken();
  // the phone's date + time go along, so the sheet can refuse entries for a day / time that has not come yet
  const body = action === "load" ? payload : { ...payload, today: nowDate(), now: nowTime() };
  const j = await call(srcBook.url, action, body, idToken);      // always the source sheet
  if (action !== "load" && otherBooks.length) {
    const fails = await syncMirrors(idToken);
    if (fails.length) throw new Error("Saved in " + srcBook.label + ", but the other sheet is not fully updated (" + fails.join("; ") + "). Press ⟳ to sync again.");
  }
  return j;
}
async function act(action, payload) {
  try { await api(action, payload); await refresh(true); return true; }
  catch (e) { alert(e.message); refresh(true); return false; }
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
$("refresh").onclick = async () => {
  if (me && me.admin && !isPreview() && otherBooks.length) {          // ⟳ also re-syncs the other sheet
    const fails = await syncMirrors().catch(e => [e.message]);
    if (fails.length) alert("Sync problem: " + fails.join("; "));
  }
  refresh(true);
};

function showLogin(msg, denied) {
  $("app").hidden = true; $("login").hidden = false;
  $("loginMsg").textContent = msg || "Sign in with the Google account the admin added for you.";
  $("gBtn").hidden = !!denied; $("deniedOut").hidden = !denied;
}
function setLive(on) { const l = $("live"); l.textContent = on ? "● live" : "● offline"; l.className = "live " + (on ? "on" : "off"); }

onAuthStateChanged(auth, user => {
  document.body.classList.remove("isMember");
  clearInterval(poll); me = null; U = null; S = null; T = null; previewName = ""; autoSynced = false; setLive(false);
  $("bookTitle").textContent = srcBook.label;
  if (!user) return showLogin();
  $("loginMsg").textContent = "Loading…";
  refresh(true);
  poll = setInterval(() => { if (!document.hidden && me) refresh(); }, 15000);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && auth.currentUser) refresh(); });

async function loadTables() {
  const b = books[tblIdx()];
  tblErr = "";
  if (b === srcBook) { T = S; return; }
  try { T = await loadSheet(b); }
  catch (e) { T = null; tblErr = b.label + ": " + e.message; }
}

async function refresh(force) {
  if (busy && !force) return;
  busy = true;
  try {
    S = await api("load"); me = S.me; setLive(true);
    $("login").hidden = true; $("app").hidden = false;
    applyRole();
    await loadTables();
    render(); renderAlerts(); syncMeal();
    if (me.admin && !autoSynced && otherBooks.length) {               // once per visit: bring the other sheet in line
      autoSynced = true;
      syncMirrors().then(f => { if (f.length) alert("Sync problem: " + f.join("; ")); });
    }
  } catch (e) {
    if (/group list/i.test(e.message)) showLogin(e.message + ". Ask the admin to add this email.", true);
    else { setLive(false); if (!me) showLogin("Could not reach the sheet: " + e.message, true); }
  } finally { busy = false; }
}

// ---------- Who is the interface for (admin preview) ----------
function effectiveMember() {
  const m = (S.members || []).find(x => x.name === previewName);
  return m || { name: previewName, email: "", admin: false, addFor: [], fundsFor: [], mealsFor: [], canGrocery: false, canFunds: false, canMeals: false, views: ALL_VIEWS };
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
  refresh(true);
});

function applyRole() {
  if (!me.admin) previewName = "";
  U = isPreview() ? effectiveMember() : me;
  $("me").textContent = `${me.name} · ${me.admin ? "Admin" : "Member"}${isPreview() ? " (previewing " + previewName + ")" : ""}`;
  $("app").classList.toggle("previewing", isPreview());
  $("previewNotice").hidden = !isPreview();
  $("adminPreview").hidden = !me.admin;
  if (me.admin) buildPreviewSelect();
  const adminView = !!(me.admin && !previewName);
  document.body.classList.toggle("isAdmin", adminView);      // members never get this class
  setMemberView(!adminView);
  $("bookBar").hidden = !(adminView && books.length > 1);
  $("bookSel").value = adminIdx;
  $("bookTitle").textContent = srcBook.label;
  document.querySelectorAll(".adminOnly").forEach(el => { el.hidden = !U.admin; });
  $("spendAddBox").hidden = !(U.admin || U.canGrocery);
  ["fundWho", "mealWho"].forEach(id => { if (!$(id).value && NAMES.includes(U.name)) $(id).value = U.name; });
  applyViews();
  if (U.admin) {
    if (!$("memberList").contains(document.activeElement)) renderMembers();
    if (!permDirty && !$("permEditor").contains(document.activeElement)) renderPermissionEditor();
  }
}

// ---------- Permissions: which cards / tables a member can see ----------
const canSee = k => !!U && (U.admin || (U.views || ALL_VIEWS).includes(k));
function applyViews() {
  const map = { myDepCard: "myDep", resFundCard: "resid", resCard: "resid", dueFundCard: "due", dueCard: "due",
    lastFundCard: "lastFund", lastFundMineCard: "lastFund", lastDateCard: "lastDate", lastGroceryCard: "lastGrocery",
    fundCard: "totalFund", spentCard: "totalSpent", leftcard: "left",
    sheetMeals: "sheetMeals", sheetSpending: "sheetSpending", sheetDeposits: "sheetDeposits" };
  Object.keys(map).forEach(id => { $(id).hidden = !canSee(map[id]); });
  document.querySelectorAll(".grid").forEach(g => {
    const cards = [...g.children];
    cards.forEach(c => c.classList.remove("fill"));
    g.hidden = cards.every(c => c.hidden);
    let pending = null;
    cards.filter(c => !c.hidden).forEach(c => {
      if (c.classList.contains("wide")) { if (pending) pending.classList.add("fill"); pending = null; }
      else pending = pending ? null : c;
    });
    if (pending) pending.classList.add("fill");      // a lone card fills the row
  });
  $("sheetHead").hidden = !["sheetMeals", "sheetSpending", "sheetDeposits"].some(canSee);
  const pa = { my: ["myDep", "resid", "due"].some(canSee), fund: ["totalFund", "totalSpent", "left"].every(canSee), bazar: canSee("sheetSpending") };
  document.querySelectorAll("[data-p]").forEach(b => { b.hidden = b.dataset.p === "all" ? !(pa.my && pa.fund && pa.bazar) : !pa[b.dataset.p]; });
  document.querySelector(".printBar").hidden = ![...document.querySelectorAll("[data-p]")].some(b => !b.hidden);
}

// ---------- Numbers ----------
function relDate(d) {
  if (!d) return "N/A";
  if (d === todayIso) return "TODAY";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (d === iso(y)) return "YESTERDAY";
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

// "in spending": my deposit - (this month's spending / people).  "in fund": my deposit - (total fund / people).
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

const dateChip = d => { const b = document.createElement("b"); b.className = "sp-date"; b.textContent = d; return b; };
const timeChip = t => { const b = document.createElement("b"); b.className = "timeChip"; b.textContent = "🕒 " + t; return b; };

// ---------- "See more" slides ----------
// target slides open / closed (max-height animation) with a small button under it
function makeSlide(target, collapsed, key, moreTxt, lessTxt) {
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "moreBtn";
  const set = open => { btn.textContent = open ? lessTxt : moreTxt; btn.setAttribute("aria-expanded", String(open)); };
  target.style.overflow = "hidden"; target.style.transition = "max-height .35s ease";
  if (openMore.has(key)) { target.style.maxHeight = "none"; set(true); } else { target.style.maxHeight = collapsed; set(false); }
  btn.onclick = () => {
    if (!openMore.has(key)) {
      openMore.add(key); set(true);
      target.style.maxHeight = target.scrollHeight + "px";
      const done = () => { if (openMore.has(key)) target.style.maxHeight = "none"; target.removeEventListener("transitionend", done); };
      target.addEventListener("transitionend", done);
    } else {
      openMore.delete(key); set(false);
      target.style.maxHeight = target.scrollHeight + "px"; void target.offsetHeight;   // start the close from the real height
      target.style.maxHeight = collapsed;
    }
  };
  return btn;
}
// long text: first lines + "See more" that slides the rest open
function clampEl(text, key) {
  const wrap = document.createElement("div"); wrap.className = "clampWrap";
  const body = document.createElement("div"); body.className = "clampBody"; body.textContent = text;
  wrap.appendChild(body);
  if (text.length > 110 || text.split("\n").length > 3) wrap.appendChild(makeSlide(body, "4.6em", "t:" + key, "See more ▾", "See less ▴"));
  return wrap;
}

// ---------- Rendering ----------
function render() {
  const st = statsFor(S, U.name, U.email);
  $("spDate").max = nowDate();
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
  const lastBazar = spent.filter(e => num(e.amount) > 0).sort(byWhen).pop();
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
    if (lastBazar.time) ld.appendChild(timeChip(lastBazar.time));
    if (lastBazar.bazarKorta) ld.append(" · বাজারকর্তা: " + lastBazar.bazarKorta);
    const det = cleanDet(lastBazar.details);
    if (det) ld.appendChild(clampEl(det, "last"));
  }

  if (!inlineOpen) renderHistories();
  const mealWho = $("mealWho").value;
  $("mealPerson").hidden = !mealWho;
  if (mealWho) renderMealHistory(mealWho);
  renderTables();
}

const latestSpendingDate = () => S.spending.filter(e => num(e.amount) > 0).map(e => e.date).sort().pop() || "";
const canEditSpending = e => U.admin || !!(U.canGrocery && e.date === latestSpendingDate() && e.addedByEmail && e.addedByEmail === U.email);
const canFundFor = who => !!(who && (U.admin || (U.fundsFor || []).includes(who)));

function renderHistories() {
  // grocery history: one block per date, every purchase of that date inside it
  const sl = $("spList"); sl.textContent = "";
  const sp = S.spending.filter(e => num(e.amount) > 0);
  if (!sp.length) sl.textContent = "No spending yet";
  const byDate = {};
  sp.forEach(e => (byDate[e.date] = byDate[e.date] || []).push(e));
  Object.keys(byDate).sort().reverse().forEach(d => sl.appendChild(spendDateEl(d, byDate[d].sort(byWhen))));

  // fund history of the selected person: every deposit (date, time, who added it) – refreshed after each add / edit
  const who = $("fundWho").value;
  $("fundPerson").hidden = !who;
  $("depForm").hidden = !canFundFor(who);
  if (!who) return;
  const mineDates = S.depDates.filter(d => num(S.deposits[d][who]) > 0).sort();
  $("pt").textContent = fmt(mineDates.reduce((t, d) => t + num(S.deposits[d][who]), 0));
  const latest = mineDates[mineDates.length - 1] || "";
  const list = (S.depositLog || []).filter(e => e.person === who).sort((a, b) => b.date.localeCompare(a.date) || (b.time || "").localeCompare(a.time || ""));
  const dl = $("deps"); dl.textContent = "";
  if (!list.length) dl.textContent = "এখনো কোনো জমা নেই";
  list.forEach(e => dl.appendChild(depositRowEl(e, who, latest)));
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

// all purchases of one date. More than 3: the rest slide open under "See N more".
function spendDateEl(d, list) {
  const box = document.createElement("div"); box.className = "spDay";
  const head = document.createElement("div"); head.className = "spDayHead";
  head.appendChild(dateChip(d));
  head.append(` ${list.length} purchase${list.length > 1 ? "s" : ""} · ${fmt(list.reduce((t, e) => t + num(e.amount), 0))}`);
  box.appendChild(head);
  const rows = list.map(spendingRowEl), LIM = 3;
  rows.slice(0, LIM).forEach(r => box.appendChild(r));
  if (rows.length > LIM) {
    const slide = document.createElement("div"); slide.className = "slide";
    rows.slice(LIM).forEach(r => slide.appendChild(r));
    box.append(slide, makeSlide(slide, "0px", "day:" + d, `See ${rows.length - LIM} more ▾`, "See less ▴"));
  }
  return box;
}
function spendingRowEl(e) {
  const r = document.createElement("div"); r.className = "row spendingRow";
  const a = document.createElement("div"); a.className = "spendingDescription";
  const top = document.createElement("div");
  if (e.time) top.appendChild(timeChip(e.time));
  top.append((e.time ? " · " : "") + "বাজারকর্তা: " + (e.bazarKorta || "—"));
  a.appendChild(top);
  const det = cleanDet(e.details);
  if (det) a.appendChild(clampEl(det, "d:" + e.id));
  const right = document.createElement("span"); right.className = "rowRight";
  right.append(amountEl(fmt(num(e.amount))),
    actionsEl(canEditSpending(e) ? () => openInline(r, { title: `Edit grocery · ${e.date}`, date: e.date, amount: e.amount, time: e.time, details: det,
        withDetails: true, withBazar: true, withTime: true, withDate: true, allowExtra: true, bazar: e.bazarKorta || "",
        save: (amount, details, bazarKorta, time, date, extra) => act("editSpending", { id: e.id, amount, details, bazarKorta, time, date, extra }) }) : null,
      U.admin ? () => act("clearSpending", { id: e.id }) : null));
  r.append(a, right);
  return r;
}

// Inline editor. Stays open during the 15 s refresh.
function openInline(rowNode, cfg) {
  inlineOpen = true;
  rowNode.textContent = ""; rowNode.classList.add("editing");
  const f = document.createElement("form"); f.className = "inlineEdit";
  const t = document.createElement("div"); t.className = "inlineTitle"; t.textContent = cfg.title;
  f.appendChild(t);
  let dt = null;
  if (cfg.withDate) {
    const l = document.createElement("label"); l.className = "inlineLabel"; l.textContent = "Date" + (U.admin ? "" : " (only the admin can change it)");
    dt = document.createElement("input"); dt.type = "date"; dt.value = cfg.date; dt.max = nowDate(); dt.required = true; dt.disabled = !U.admin;
    f.append(l, dt);
  }
  const a = document.createElement("input"); a.type = "number"; a.step = "any"; if (!cfg.allowNegative) a.min = "0"; a.required = true; a.value = cfg.amount;
  f.appendChild(a);
  let tm = null;
  if (cfg.withTime) {
    const l = document.createElement("label"); l.className = "inlineLabel"; l.textContent = "Time";
    tm = document.createElement("input"); tm.type = "time"; tm.value = cfg.time || ""; tm.required = true;
    f.append(l, tm);
  }
  let d = null;
  if (cfg.withDetails) { d = document.createElement("textarea"); d.rows = 4; d.value = cfg.details || ""; d.placeholder = "Details"; f.appendChild(d); }
  let bz = null;
  if (cfg.withBazar) {
    const l = document.createElement("label"); l.className = "inlineLabel"; l.textContent = "বাজারকর্তা";
    bz = document.createElement("select");
    [["", "— বাজারকর্তা নির্বাচন করুন —"], ...NAMES.map(n => [n, n])].forEach(([v, tx]) => { const o = document.createElement("option"); o.value = v; o.textContent = tx; bz.appendChild(o); });
    bz.value = cfg.bazar || "";
    f.append(l, bz);
  }
  // more purchases on the same date, each with its own বাজারকর্তা
  const extraBox = document.createElement("div");
  if (cfg.allowExtra) {
    const renum = () => [...extraBox.children].forEach((b, i) => { b.querySelector(".spItemTitle").textContent = "Another purchase " + (i + 1); });
    const more = document.createElement("button"); more.type = "button"; more.textContent = "+ Add another বাজারকর্তা";
    more.onclick = () => {
      const b = spItemEl(), rm = b.querySelector(".spRemove");
      b.querySelector(".spTime").value = cfg.time || nowTime();
      rm.hidden = false; rm.onclick = () => { b.remove(); renum(); };
      extraBox.appendChild(b); renum(); b.querySelector(".spWho").focus();
    };
    f.append(extraBox, more);
  }
  const bar = document.createElement("div"); bar.className = "inlineBtns";
  const ok = document.createElement("button"); ok.textContent = "Save";
  const no = document.createElement("button"); no.type = "button"; no.textContent = "Cancel";
  no.onclick = () => { inlineOpen = false; render(); };
  bar.append(ok, no); f.appendChild(bar);
  f.onsubmit = async ev => {
    ev.preventDefault();
    const day = dt ? dt.value : cfg.date;
    const extra = [...extraBox.children].map(b => ({ bazarKorta: b.querySelector(".spWho").value, time: b.querySelector(".spTime").value,
      amount: b.querySelector(".spAmt").value, details: b.querySelector(".spDet").value.trim() }));
    if (day && day > nowDate()) return alert("You cannot use a future date.");
    if (day === nowDate() && ((tm && tm.value > nowTime()) || extra.some(x => x.time > nowTime()))) return alert("That time has not come yet.");
    const done = await cfg.save(Number(a.value), d ? d.value : undefined, bz ? bz.value : undefined, tm ? tm.value : undefined, day, extra);
    if (done) { inlineOpen = false; render(); }
  };
  rowNode.appendChild(f); a.focus();
}

function depositRowEl(e, who, latestDate) {
  const r = document.createElement("div"); r.className = "row";
  const a = document.createElement("span"); a.appendChild(dateChip(e.date));
  if (e.time) a.appendChild(timeChip(e.time));
  a.append(e.pseudo ? " · sheet entry" : (e.addedByName ? " · by " + e.addedByName : ""));
  const editable = U.admin || (who === U.name && e.date === latestDate);
  const right = document.createElement("span"); right.className = "rowRight";
  right.append(amountEl(fmt(e.amount)),
    actionsEl(editable ? () => openInline(r, { title: `Edit ${who}'s fund · ${e.date}${e.time ? " " + e.time : ""}`, amount: e.amount, withDetails: false, allowNegative: !!e.pseudo,
        save: amt => act("editDeposit", { id: e.id, date: e.date, person: who, amount: amt }) }) : null,
      U.admin ? () => act("clearDeposit", { id: e.id, date: e.date, person: who }) : null));
  r.append(a, right);
  return r;
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
// Only these three tables follow the chosen sheet (T); everything else uses the source sheet (S).
function renderTables() {
  const ids = ["tblMeals", "tblDeposits", "tblSpending"];
  if (!T) { ids.forEach(id => { $(id).textContent = tblErr || "Could not load this sheet"; }); return; }
  const sums = (dates, src) => NAMES.map(n => dates.reduce((t, d) => t + num(src[d][n]), 0));
  const put = (id, el) => { const b = $(id); b.textContent = ""; b.appendChild(el); };
  put("tblMeals", table(["Tarikh", ...NAMES], T.mealDates.map(d => [d, ...NAMES.map(n => T.meals[d][n])]),
    ["Total meal", ...sums(T.mealDates, T.meals)], todayIso));
  put("tblDeposits", table(["Tarikh", ...NAMES], T.depDates.map(d => [d, ...NAMES.map(n => T.deposits[d][n])]),
    ["Total", ...sums(T.depDates, T.deposits).map(fmt)], todayIso));
  if (T.layout === "blocks" && T.bazarRows) {          // one row per purchase (extra rows under a date), with its time
    put("tblSpending", table(["Tarikh", "Time", ...NAMES], T.bazarRows.map(r => [r.date, r.time, ...NAMES.map(n => r.cells[n])]),
      ["Total", "", ...NAMES.map(n => fmt(T.bazarRows.reduce((t, r) => t + num(r.cells[n]), 0)))], todayIso));
  } else {
    const sp = T.spending.filter(e => num(e.amount) > 0).sort(byWhen);
    put("tblSpending", table(["Tarikh", "Time", "Spending", "Details", "বাজারকর্তা"], sp.map(e => [e.date, e.time, e.amount, cleanDet(e.details), e.bazarKorta || ""]),
      ["Total spending", "", fmt(sp.reduce((t, e) => t + num(e.amount), 0)), "", ""], todayIso));
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
  const vs = u.views || ALL_VIEWS;
  document.querySelectorAll("#permEditor [data-view]").forEach(i => { i.checked = vs.includes(i.dataset.view); });
  permTarget = "";
  drawPermWho(); drawPermTarget();
}
const permLabel = p => [p.funds ? "Funds" : "", p.meals ? "Meal details" : ""].filter(Boolean).join(" + ");
function drawPermWho() {
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
function drawPermTarget() {
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
[["permViewSheets", VIEW_SHEETS], ["permViewCards", VIEW_CARDS]].forEach(([box, list]) => list.forEach(([k, label]) => {
  const l = document.createElement("label"); l.className = "chip";
  const i = document.createElement("input"); i.type = "checkbox"; i.dataset.view = k;
  i.addEventListener("change", () => { permDirty = true; });
  l.append(i, " " + label); $(box).appendChild(l);
}));
$("permPerson").addEventListener("change", () => { permDirty = false; syncPermissionEditor(); });
$("savePerms").addEventListener("click", async () => {
  const name = $("permPerson").value, u = (S.members || []).find(x => x.name === name);
  if (!u) return;
  const ok = await act("savePerms", {
    email: u.email, canGrocery: $("permGrocery").checked,
    fundsFor: Object.keys(permDraft).filter(n => permDraft[n].funds), mealsFor: Object.keys(permDraft).filter(n => permDraft[n].meals),
    views: [...document.querySelectorAll("#permEditor [data-view]")].filter(i => i.checked).map(i => i.dataset.view) });
  if (ok) { permDirty = false; syncPermissionEditor(); }
});

// ---------- Grocery form: one date, one or more purchases (each with its own time and বাজারকর্তা) ----------
const spItems = $("spItems");
function spField(labelTxt, el, full) {
  const w = document.createElement("div"); w.className = "fld" + (full ? " full" : "");
  const l = document.createElement("label"); l.textContent = labelTxt;
  w.append(l, el); return w;
}
function spItemEl() {
  const box = document.createElement("div"); box.className = "spItem";
  const head = document.createElement("div"); head.className = "spItemHead";
  const title = document.createElement("span"); title.className = "spItemTitle";
  const rm = document.createElement("button"); rm.type = "button"; rm.className = "x spRemove"; rm.textContent = "✕"; rm.title = "Remove this purchase";
  rm.onclick = () => { box.remove(); renumberItems(); };
  head.append(title, rm);
  const who = document.createElement("select"); who.className = "spWho"; who.required = true;
  [["", "— বাজারকর্তা —"], ...NAMES.map(n => [n, n])].forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; who.appendChild(o); });
  const time = document.createElement("input"); time.type = "time"; time.className = "spTime"; time.required = true; time.value = nowTime();
  const amt = document.createElement("input"); amt.type = "number"; amt.className = "spAmt"; amt.min = "0"; amt.step = "any"; amt.placeholder = "Amount"; amt.required = true;
  const det = document.createElement("textarea"); det.className = "spDet"; det.rows = 3; det.placeholder = "Details (what was bought) — Enter for a new line";
  box.append(head, spField("বাজারকর্তা", who), spField("Time", time), spField("Amount", amt), spField("Details", det, true));
  return box;
}
function renumberItems() {
  const items = [...spItems.children];
  items.forEach((b, i) => { b.querySelector(".spItemTitle").textContent = "Purchase " + (i + 1); b.querySelector(".spRemove").hidden = items.length < 2; });
}
function resetItems() { spItems.textContent = ""; spItems.appendChild(spItemEl()); renumberItems(); }
resetItems();
$("spAddRow").onclick = () => { spItems.appendChild(spItemEl()); renumberItems(); spItems.lastElementChild.querySelector(".spWho").focus(); };
$("spDate").addEventListener("change", () => {
  if ($("spDate").value > nowDate()) { alert("You cannot add grocery spending for a future date."); $("spDate").value = nowDate(); }
});
$("spForm").addEventListener("submit", async e => {
  e.preventDefault();
  const date = $("spDate").value;
  if (!date) return;
  if (date > nowDate()) return alert("You cannot add grocery spending for a future date.");
  const items = [...spItems.children].map(b => ({
    bazarKorta: b.querySelector(".spWho").value, time: b.querySelector(".spTime").value,
    amount: b.querySelector(".spAmt").value, details: b.querySelector(".spDet").value.trim() }));
  if (date === nowDate() && items.some(i => i.time > nowTime())) return alert("A purchase time later than now has not come yet. Please enter the real time.");
  const ok = await act("addSpending", { date, items });
  if (ok) resetItems();
});

// ---------- Fund form ----------
$("depForm").addEventListener("submit", async e => {
  e.preventDefault();
  const ok = await act("addDeposit", { date: $("depDate").value, person: $("fundWho").value, amount: $("depAmt").value });
  if (ok) $("depAmt").value = "";
});
$("fundWho").addEventListener("change", () => { inlineOpen = false; render(); });

// ---------- Meal details: lunch / dinner ----------
const noteKey = () => `${$("mealWho").value}|${$("mealDate").value}`;
const resetMealDirty = () => { mealDirty.lunch = mealDirty.dinner = false; };
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
function autoSaveMeal() {
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
    const mine = (S.depositLog || []).filter(e => e.person === U.name).sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
    if (mine.length) R.appendChild(rTable(["Date", "Time", "Amount"], mine.map(e => [e.date, e.time || "", fmt(e.amount)]), ["Total", "", fmt(st.dep)]));
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
    const sp = S.spending.filter(e => num(e.amount) > 0).sort(byWhen);
    add("rp-h2", "Bazar data");
    if (sp.length) R.appendChild(rTable(["Date", "Time", "Amount", "Details", "বাজারকর্তা"],
      sp.map(e => [e.date, e.time || "", fmt(num(e.amount)), cleanDet(e.details), e.bazarKorta || ""]),
      ["Total", "", fmt(sp.reduce((t, e) => t + num(e.amount), 0)), "", ""]));
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
