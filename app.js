import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, setDoc, deleteDoc, onSnapshot, writeBatch, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = id => document.getElementById(id);
const NAMES = ["Shohan", "Naved", "Salman", "Rifat", "Shihab", "Ashmit"];
const fmt = n => "৳" + (Math.round(n * 100) / 100).toLocaleString("en-US");
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const todayIso = iso(new Date());
const sum = a => a.reduce((t, e) => t + (Number(e.amount) || 0), 0);

$("today").textContent = new Date().toLocaleDateString("en-US", {weekday:"long", year:"numeric", month:"long", day:"numeric"});
["spDate","depDate","mealDate"].forEach(i => $(i).value = todayIso);

if (firebaseConfig.apiKey.startsWith("YOUR_")) { $("setup").hidden = false; throw new Error("Firebase not configured"); }

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let me = null;                       // { email, name, admin }
let deposits = [], spending = [], usersList = [];
let unsubs = [], userUnsub = null, usersUnsub = null, mealUnsub = null, started = false;

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

function showLogin(msg, denied) {
  $("app").hidden = true; $("login").hidden = false;
  $("loginMsg").textContent = msg || "Sign in with the Google account the admin added for you.";
  $("gBtn").hidden = !!denied; $("deniedOut").hidden = !denied;
}

function stopAll() {
  unsubs.forEach(u => u()); unsubs = [];
  if (userUnsub) { userUnsub(); userUnsub = null; }
  if (usersUnsub) { usersUnsub(); usersUnsub = null; }
  if (mealUnsub) { mealUnsub(); mealUnsub = null; }
  started = false; me = null; deposits = []; spending = []; usersList = [];
}

onAuthStateChanged(auth, user => {
  stopAll();
  setLive(false);
  if (!user) return showLogin();
  const email = (user.email || "").toLowerCase();
  // Watch my membership doc: it decides access and role, and updates live (e.g. admin handover)
  userUnsub = onSnapshot(doc(db, "users", email), snap => {
    if (!snap.exists()) {
      unsubs.forEach(u => u()); unsubs = []; started = false; me = null;
      return showLogin(`${email} is not on the group list. Ask the admin to add this email.`, true);
    }
    me = { email, ...snap.data() };
    if (!started) startData();
    applyRole();
  }, () => showLogin("Could not check access. Try again.", true));
});

// ---------- Data ----------
function setLive(on) { const l = $("live"); l.textContent = on ? "● live" : "● offline"; l.className = "live " + (on ? "on" : "off"); }

function startData() {
  started = true;
  $("login").hidden = true; $("app").hidden = false;
  unsubs.push(onSnapshot(collection(db, "deposits"), s => {
    deposits = s.docs.map(d => ({ id: d.id, ...d.data() }));
    setLive(!s.metadata.fromCache); render();
  }, () => setLive(false)));
  unsubs.push(onSnapshot(collection(db, "spending"), s => {
    spending = s.docs.map(d => ({ id: d.id, ...d.data() })); render();
  }));
}

function applyRole() {
  $("me").textContent = `${me.name} · ${me.admin ? "👑 Admin" : "Member"}`;
  document.querySelectorAll(".adminOnly").forEach(el => el.hidden = !me.admin);
  if (me.admin && !usersUnsub) {
    usersUnsub = onSnapshot(collection(db, "users"), s => {
      usersList = s.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!$("memberList").contains(document.activeElement)) renderMembers();
    });
  } else if (!me.admin && usersUnsub) { usersUnsub(); usersUnsub = null; usersList = []; }
  if (!$("who").value && NAMES.includes(me.name)) { $("who").value = me.name; watchMeal(); }
  render(); setEditable();
}

// ---------- Rendering ----------
function render() {
  if (!me) return;
  const spent = spending.filter(e => e.date <= todayIso);
  const fund = sum(deposits), out = sum(spent);
  $("fund").textContent = fmt(fund);
  $("spent").textContent = fmt(out);
  $("left").textContent = fmt(fund - out);
  $("leftcard").classList.toggle("neg", fund - out < 0);

  const key = e => e.date + String(e.createdAt?.seconds || 0).padStart(12, "0");
  const last = [...spent].sort((a, b) => key(a).localeCompare(key(b))).pop();
  $("last").textContent = last ? fmt(last.amount) : "N/A";
  $("lastd").textContent = last ? `${last.date}${last.details ? " · " + last.details : ""}` : "";

  const sl = $("spList"); sl.textContent = "";
  if (!spending.length) sl.textContent = "No spending yet";
  [...spending].sort((a, b) => b.date.localeCompare(a.date)).forEach(e =>
    sl.appendChild(rowEl(`${e.date}${e.details ? " · " + e.details : ""}`, fmt(e.amount), me.admin && (() => remove("spending", e.id)))));

  const who = $("who").value;
  $("person").hidden = !who;
  if (!who) return;
  const mine = deposits.filter(e => e.person === who).sort((a, b) => a.date.localeCompare(b.date));
  $("pt").textContent = fmt(sum(mine));
  const dl = $("deps"); dl.textContent = "";
  if (!mine.length) dl.textContent = "এখনো কোনো জমা নেই";
  mine.forEach(e => dl.appendChild(rowEl(e.date, fmt(e.amount), me.admin && (() => remove("deposits", e.id)))));
}

function rowEl(left, right, onDel) {
  const r = document.createElement("div"); r.className = "row";
  const a = document.createElement("span"); a.textContent = left;
  const b = document.createElement("span");
  const v = document.createElement("b"); v.textContent = right; b.appendChild(v);
  if (onDel) {
    const x = document.createElement("button"); x.className = "x"; x.textContent = "✕"; x.title = "Delete";
    x.onclick = () => { if (confirm("Delete this entry?")) onDel(); };
    b.appendChild(x);
  }
  r.append(a, b); return r;
}
const remove = (col, id) => deleteDoc(doc(db, col, id)).catch(() => alert("Not allowed"));

function renderMembers() {
  const box = $("memberList"); box.textContent = "";
  NAMES.forEach(name => {
    const u = usersList.find(x => x.name === name);
    const row = document.createElement("div"); row.className = "mrow";
    const label = document.createElement("div"); label.className = "mname";
    label.textContent = name + (u && u.admin ? " 👑" : "");
    const input = document.createElement("input"); input.type = "email"; input.placeholder = "Google email";
    input.value = u ? u.id : "";
    const save = document.createElement("button"); save.textContent = "Save";
    save.onclick = () => saveMember(name, input.value);
    row.append(label, input, save);
    if (u && !u.admin) {
      const mk = document.createElement("button"); mk.textContent = "Make admin";
      mk.onclick = () => makeAdmin(u);
      row.appendChild(mk);
    }
    box.appendChild(row);
  });
}

async function saveMember(name, val) {
  const email = val.trim().toLowerCase();
  const cur = usersList.find(u => u.name === name);
  if (!email.includes("@")) return alert("Enter a valid Google email");
  if (usersList.some(u => u.id === email && u.name !== name)) return alert("That email is already used by someone else");
  if (cur && cur.admin && cur.id !== email && !confirm("Changing the admin's email moves admin access to the new email. Continue?")) return;
  const b = writeBatch(db);
  if (cur && cur.id !== email) b.delete(doc(db, "users", cur.id));
  b.set(doc(db, "users", email), { name, admin: !!(cur && cur.admin) });
  try { await b.commit(); } catch { alert("Not allowed"); }
}

async function makeAdmin(target) {
  if (!confirm(`Make ${target.name} the admin? You will become a regular member.`)) return;
  const b = writeBatch(db);
  b.update(doc(db, "users", me.email), { admin: false });
  b.update(doc(db, "users", target.id), { admin: true });
  try { await b.commit(); } catch { alert("Not allowed"); }
}

// ---------- Forms (admin only; rules enforce it too) ----------
$("spForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await addDoc(collection(db, "spending"), { amount: Number($("spAmt").value), date: $("spDate").value, details: $("spDet").value.trim(), createdAt: serverTimestamp() });
    $("spAmt").value = ""; $("spDet").value = "";
  } catch { alert("Not allowed"); }
});
$("depForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await addDoc(collection(db, "deposits"), { person: $("who").value, amount: Number($("depAmt").value), date: $("depDate").value, createdAt: serverTimestamp() });
    $("depAmt").value = "";
  } catch { alert("Not allowed"); }
});

// ---------- Meals (realtime, autosave; editable only by that person or the admin) ----------
const canEditMeal = () => me && (me.admin || $("who").value === me.name);
function setEditable() {
  const ok = !!canEditMeal();
  $("lunch").readOnly = !ok; $("dinner").readOnly = !ok;
  $("status").textContent = $("who").value && !ok ? "View only — only this person or the admin can edit" : "";
}
const mealId = () => `${$("who").value}_${$("mealDate").value}`;
function watchMeal() {
  if (mealUnsub) { mealUnsub(); mealUnsub = null; }
  $("lunch").value = ""; $("dinner").value = ""; setEditable();
  if (!me || !$("who").value || !$("mealDate").value) return;
  mealUnsub = onSnapshot(doc(db, "meals", mealId()), s => {
    const d = s.exists() ? s.data() : {};
    if (document.activeElement !== $("lunch")) $("lunch").value = d.lunch || "";
    if (document.activeElement !== $("dinner")) $("dinner").value = d.dinner || "";
  });
}
let t;
function saveMeal() {
  if (!canEditMeal()) return;
  $("status").textContent = "Saving…";
  clearTimeout(t);
  t = setTimeout(async () => {
    try {
      await setDoc(doc(db, "meals", mealId()), { person: $("who").value, date: $("mealDate").value, lunch: $("lunch").value, dinner: $("dinner").value, updatedAt: serverTimestamp() }, { merge: true });
      $("status").textContent = "Saved ✓";
    } catch { $("status").textContent = "Save failed — not allowed or offline"; }
  }, 500);
}
["lunch", "dinner"].forEach(i => $(i).addEventListener("input", saveMeal));
$("who").addEventListener("change", () => { render(); watchMeal(); });
$("mealDate").addEventListener("change", watchMeal);
