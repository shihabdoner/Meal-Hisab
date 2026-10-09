import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, SCRIPT_URL } from "./firebase-config.js";

const $ = id => document.getElementById(id);
const NAMES = ["Shohan", "Naved", "Salman", "Rifat", "Shihab", "Ashmit"];
const fmt = n => "৳" + (Math.round(n * 100) / 100).toLocaleString("en-US");
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const todayIso = iso(new Date());
const num = x => { const n = Number(x); return (x === "" || x == null || isNaN(n)) ? 0 : n; };
const lab = d => new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

$("monthLabel").textContent = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
$("today").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
["spDate", "depDate", "mealDate"].forEach(i => $(i).value = todayIso);

if (SCRIPT_URL.startsWith("PASTE_")) { $("setup").hidden = false; throw new Error("SCRIPT_URL not set"); }

const auth = getAuth(initializeApp(firebaseConfig));
let me = null, S = null, busy = false, poll = null;

// ---------- API (Google Apps Script web app on top of the sheet) ----------
async function api(action, payload = {}) {
  const idToken = await auth.currentUser.getIdToken();
  const r = await fetch(SCRIPT_URL, { method: "POST", body: JSON.stringify({ action, idToken, ...payload }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Request failed");
  return j;
}
async function act(action, payload) {
  try { await api(action, payload); await refresh(true); }
  catch (e) { alert(e.message); }
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

function showLogin(msg, denied) {
  $("app").hidden = true; $("login").hidden = false;
  $("loginMsg").textContent = msg || "Sign in with the Google account the admin added for you.";
  $("gBtn").hidden = !!denied; $("deniedOut").hidden = !denied;
}
function setLive(on) { const l = $("live"); l.textContent = on ? "● live" : "● offline"; l.className = "live " + (on ? "on" : "off"); }

onAuthStateChanged(auth, user => {
  clearInterval(poll); me = null; S = null; setLive(false);
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
    applyRole(); render(); syncMeal();
  } catch (e) {
    if (/group list/i.test(e.message)) showLogin(e.message + ". Ask the admin to add this email.", true);
    else { setLive(false); if (!me) showLogin("Could not reach the sheet: " + e.message, true); }
  } finally { busy = false; }
}

function applyRole() {
  $("me").textContent = `${me.name} · ${me.admin ? "Admin" : "Member"}`;
  document.querySelectorAll(".adminOnly").forEach(el => el.hidden = !me.admin);
  if (!$("who").value && NAMES.includes(me.name)) { $("who").value = me.name; }
  if (me.admin && !$("memberList").contains(document.activeElement)) renderMembers();
}

// ---------- Rendering ----------
function relDate(d) {
  if (!d) return "N/A";
  if (d === todayIso) return "TODAY";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (d === iso(y)) return "YESTERDAY";
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

// Equal split: this month's total spending / number of people. Balance = my deposit - my share.
// Positive balance = residual, negative = due.
const monthKey = todayIso.slice(0, 7);
const monthSpent = () => S.spending.filter(e => e.date.slice(0, 7) === monthKey).reduce((t, e) => t + num(e.amount), 0);
function balanceOf(n) {
  const share = monthSpent() / NAMES.length;
  const dep = S.depDates.reduce((t, d) => t + num(S.deposits[d][n]), 0);
  return { dep, share, bal: Math.round((dep - share) * 100) / 100 };
}

function render() {
  const m = balanceOf(me.name);
  $("myDep").textContent = fmt(m.dep);
  $("myRes").textContent = fmt(Math.max(m.bal, 0));
  $("myDue").textContent = fmt(Math.max(-m.bal, 0));
  $("dueCard").classList.toggle("neg", m.bal < 0);
  $("resNote").textContent = `Share ${fmt(m.share)} (${fmt(monthSpent())} ÷ ${NAMES.length})`;
  const lastBazar = [...S.spending].filter(e => e.date <= todayIso && num(e.amount) > 0).sort((x, y) => x.date.localeCompare(y.date)).pop();
  $("lastDate").textContent = relDate(lastBazar && lastBazar.date);

  const fund = S.depDates.reduce((t, d) => t + NAMES.reduce((u, n) => u + num(S.deposits[d][n]), 0), 0);
  const spent = S.spending.filter(e => e.date <= todayIso);
  const out = spent.reduce((t, e) => t + num(e.amount), 0);
  $("fund").textContent = fmt(fund);
  $("spent").textContent = fmt(out);
  $("left").textContent = fmt(fund - out);
  $("leftcard").classList.toggle("neg", fund - out < 0);
  const last = [...spent].filter(e => num(e.amount) > 0).sort((a, b) => a.date.localeCompare(b.date)).pop();
  $("last").textContent = last ? fmt(num(last.amount)) : "N/A";
  $("lastd").textContent = last ? `${last.date}${last.details && last.details !== "N/A" ? " · " + last.details : ""}` : "";

  const sl = $("spList"); sl.textContent = "";
  const sp = S.spending.filter(e => num(e.amount) > 0).sort((a, b) => b.date.localeCompare(a.date));
  if (!sp.length) sl.textContent = "No spending yet";
  sp.forEach(e => sl.appendChild(rowEl(`${e.date}${e.details && e.details !== "N/A" ? " · " + e.details : ""}`, fmt(num(e.amount)),
    me.admin && (() => act("clearSpending", { date: e.date })))));

  const who = $("who").value;
  $("person").hidden = !who;
  if (who) {
    const mine = S.depDates.filter(d => num(S.deposits[d][who]) > 0);
    $("pt").textContent = fmt(mine.reduce((t, d) => t + num(S.deposits[d][who]), 0));
    const dl = $("deps"); dl.textContent = "";
    if (!mine.length) dl.textContent = "এখনো কোনো জমা নেই";
    mine.forEach(d => dl.appendChild(rowEl(d, fmt(num(S.deposits[d][who])), me.admin && (() => act("clearDeposit", { date: d, person: who })))));
  }
  renderTables();
}

function rowEl(left, right, onDel) {
  const r = document.createElement("div"); r.className = "row";
  const a = document.createElement("span"); a.textContent = left;
  const b = document.createElement("span");
  const v = document.createElement("b"); v.textContent = right; b.appendChild(v);
  if (onDel) {
    const x = document.createElement("button"); x.className = "x"; x.textContent = "✕"; x.title = "Clear";
    x.onclick = () => { if (confirm("Clear this entry in the sheet?")) onDel(); };
    b.appendChild(x);
  }
  r.append(a, b); return r;
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
  put("tblSpending", table(["Tarikh", "Spending", "Details"], S.spending.map(e => [e.date, e.amount, e.details]),
    ["Total spending", fmt(S.spending.reduce((t, e) => t + num(e.amount), 0)), ""], todayIso));
}

function renderMembers() {
  const box = $("memberList"); box.textContent = "";
  NAMES.forEach(name => {
    const u = (S.members || []).find(x => x.name === name);
    const row = document.createElement("div"); row.className = "mrow";
    const label = document.createElement("div"); label.className = "mname";
    label.textContent = name + (u && u.admin ? "· Admin" : "· Member");
    const input = document.createElement("input"); input.type = "email"; input.placeholder = "Google email";
    input.value = u ? u.email : "";
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

// ---------- Forms (admin only; the script enforces it too) ----------
$("spForm").addEventListener("submit", async e => {
  e.preventDefault();
  await act("addSpending", { date: $("spDate").value, amount: $("spAmt").value, details: $("spDet").value.trim() });
  $("spAmt").value = ""; $("spDet").value = "";
});
$("depForm").addEventListener("submit", async e => {
  e.preventDefault();
  await act("addDeposit", { date: $("depDate").value, person: $("who").value, amount: $("depAmt").value });
  $("depAmt").value = "";
});

// ---------- Meals: lunch/dinner boxes (sheet cell = number of meals; text kept in the MealDetails tab) ----------
const noteKey = () => `${$("who").value}|${$("mealDate").value}`;
const canEditMeal = () => !!(me && S && (me.admin || $("who").value === me.name) && S.mealDates.includes($("mealDate").value));
function setEditable() {
  const ok = canEditMeal();
  $("lunch").readOnly = !ok; $("dinner").readOnly = !ok;
  const who = $("who").value;
  $("status").textContent = !who || !S ? "" : !S.mealDates.includes($("mealDate").value) ? "This date is not in the sheet"
    : !ok ? "View only — only this person or the admin can edit" : "Tip: a box with 1 (or any text) counts as that many meals in the sheet";
}
function syncMeal() {
  if (!$("who").value) return;
  const n = (S.mealNotes || {})[noteKey()] || { lunch: "", dinner: "" };
  if (document.activeElement !== $("lunch")) $("lunch").value = n.lunch;
  if (document.activeElement !== $("dinner")) $("dinner").value = n.dinner;
  setEditable();
}
let t;
function saveMeal() {
  if (!canEditMeal()) return;
  $("status").textContent = "Saving…";
  clearTimeout(t);
  t = setTimeout(async () => {
    try {
      await api("setMeal", { person: $("who").value, date: $("mealDate").value, lunch: $("lunch").value, dinner: $("dinner").value });
      $("status").textContent = "Saved to sheet ✓";
      refresh();
    } catch (e) { $("status").textContent = "Save failed: " + e.message; }
  }, 600);
}
["lunch", "dinner"].forEach(i => $(i).addEventListener("input", saveMeal));
$("who").addEventListener("change", () => { $("lunch").value = ""; $("dinner").value = ""; render(); syncMeal(); });
$("mealDate").addEventListener("change", () => { $("lunch").value = ""; $("dinner").value = ""; syncMeal(); });


// ---------- Print / Save as PDF (my data, fund data, bazar data) ----------
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
  add("rp-sub", `Printed ${new Date().toLocaleString("en-GB")} · ${me.name}`);
  const spentM = monthSpent();

  if (parts.includes("my")) {
    const m = balanceOf(me.name);
    add("rp-h2", `My data — ${me.name}`);
    R.appendChild(rTable(["Item", "Amount"], [
      ["My deposit to fund", fmt(m.dep)],
      [`My share (${fmt(spentM)} ÷ ${NAMES.length})`, fmt(m.share)],
      [m.bal < 0 ? "My Due" : "My residual", fmt(Math.abs(m.bal))]]));
    add("rp-h3", "My deposits");
    const mine = S.depDates.filter(d => num(S.deposits[d][me.name]) > 0);
    if (mine.length) R.appendChild(rTable(["Date", "Amount"], mine.map(d => [d, fmt(num(S.deposits[d][me.name]))]), ["Total", fmt(m.dep)]));
    else add("rp-note", "No deposits yet");
  }

  if (parts.includes("fund")) {
    const fund = S.depDates.reduce((t, d) => t + NAMES.reduce((u, n) => u + num(S.deposits[d][n]), 0), 0);
    const out = S.spending.filter(e => e.date <= todayIso).reduce((t, e) => t + num(e.amount), 0);
    add("rp-h2", "Fund data");
    R.appendChild(rTable(["Item", "Amount"], [["Total fund", fmt(fund)], ["Total spending", fmt(out)], ["Money left in the fund", fmt(fund - out)]]));
    add("rp-h3", `Everyone (equal share ${fmt(spentM / NAMES.length)})`);
    const rows = NAMES.map(n => { const b = balanceOf(n); return [n, fmt(b.dep), fmt(b.share), b.bal >= 0 ? fmt(b.bal) : "", b.bal < 0 ? fmt(-b.bal) : ""]; });
    R.appendChild(rTable(["Name", "Deposit", "Share", "Residual", "Due"], rows));
  }

  if (parts.includes("bazar")) {
    const sp = S.spending.filter(e => num(e.amount) > 0).sort((x, y) => x.date.localeCompare(y.date));
    add("rp-h2", "Bazar data");
    if (sp.length) R.appendChild(rTable(["Date", "Amount", "Details"],
      sp.map(e => [e.date, fmt(num(e.amount)), e.details === "N/A" ? "" : e.details]),
      ["Total", fmt(sp.reduce((t, e) => t + num(e.amount), 0)), ""]));
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
