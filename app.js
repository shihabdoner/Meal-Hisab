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
function render() {
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
    [lab(key), ...cells].forEach(c => { tr.insertCell().textContent = c === undefined || c === null ? "" : c; });
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
