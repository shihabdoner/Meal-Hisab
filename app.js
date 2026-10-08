import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, doc, addDoc, setDoc, deleteDoc, onSnapshot, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = id => document.getElementById(id);
const fmt = n => "৳" + (Math.round(n * 100) / 100).toLocaleString("en-US");
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const todayIso = iso(new Date());

$("today").textContent = new Date().toLocaleDateString("en-US", {weekday:"long", year:"numeric", month:"long", day:"numeric"});
["spDate","depDate","mealDate"].forEach(i => $(i).value = todayIso);

if (firebaseConfig.apiKey.startsWith("YOUR_")) { $("setup").hidden = false; throw new Error("Firebase not configured"); }

const db = getFirestore(initializeApp(firebaseConfig));
let deposits = [], spending = [], mealUnsub = null;

// ---------- Realtime listeners ----------
function setLive(on){ const l=$("live"); l.textContent = on ? "● live" : "● offline"; l.className = "live " + (on ? "on" : "off"); }

onSnapshot(collection(db, "deposits"), s => {
  deposits = s.docs.map(d => ({ id: d.id, ...d.data() }));
  setLive(!s.metadata.fromCache); render();
}, () => setLive(false));

onSnapshot(collection(db, "spending"), s => {
  spending = s.docs.map(d => ({ id: d.id, ...d.data() }));
  render();
});

// ---------- Rendering ----------
const sum = a => a.reduce((t, e) => t + (Number(e.amount) || 0), 0);

function render() {
  const spent = spending.filter(e => e.date <= todayIso);
  const fund = sum(deposits), out = sum(spent);
  $("fund").textContent = fmt(fund);
  $("spent").textContent = fmt(out);
  $("left").textContent = fmt(fund - out);
  $("leftcard").classList.toggle("neg", fund - out < 0);

  const last = [...spent].sort((a,b) => (a.date + (a.createdAt?.seconds||0)).localeCompare(b.date + (b.createdAt?.seconds||0))).pop();
  $("last").textContent = last ? fmt(last.amount) : "N/A";
  $("lastd").textContent = last ? `${last.date}${last.details ? " · " + last.details : ""}` : "";

  const sl = $("spList"); sl.textContent = "";
  [...spending].sort((a,b) => b.date.localeCompare(a.date)).forEach(e =>
    sl.appendChild(rowEl(`${e.date}${e.details ? " · " + e.details : ""}`, fmt(e.amount), () => remove("spending", e.id))));

  const who = $("who").value;
  $("person").hidden = !who;
  if (!who) return;
  const mine = deposits.filter(e => e.person === who).sort((a,b) => a.date.localeCompare(b.date));
  $("pt").textContent = fmt(sum(mine));
  const dl = $("deps"); dl.textContent = "";
  if (!mine.length) dl.textContent = "এখনো কোনো জমা নেই";
  mine.forEach(e => dl.appendChild(rowEl(e.date, fmt(e.amount), () => remove("deposits", e.id))));
}

function rowEl(left, right, onDel) {
  const r = document.createElement("div"); r.className = "row";
  const a = document.createElement("span"); a.textContent = left;
  const b = document.createElement("span");
  const v = document.createElement("b"); v.textContent = right;
  const x = document.createElement("button"); x.className = "x"; x.textContent = "✕"; x.title = "Delete";
  x.onclick = () => { if (confirm("Delete this entry?")) onDel(); };
  b.append(v, x); r.append(a, b); return r;
}
const remove = (col, id) => deleteDoc(doc(db, col, id));

// ---------- Forms ----------
$("spForm").addEventListener("submit", async e => {
  e.preventDefault();
  await addDoc(collection(db, "spending"), { amount: Number($("spAmt").value), date: $("spDate").value, details: $("spDet").value.trim(), createdAt: serverTimestamp() });
  $("spAmt").value = ""; $("spDet").value = "";
});
$("depForm").addEventListener("submit", async e => {
  e.preventDefault();
  await addDoc(collection(db, "deposits"), { person: $("who").value, amount: Number($("depAmt").value), date: $("depDate").value, createdAt: serverTimestamp() });
  $("depAmt").value = "";
});

// ---------- Meals (realtime, autosave) ----------
const mealId = () => `${$("who").value}_${$("mealDate").value}`;
function watchMeal() {
  if (mealUnsub) { mealUnsub(); mealUnsub = null; }
  $("lunch").value = ""; $("dinner").value = ""; $("status").textContent = "";
  if (!$("who").value || !$("mealDate").value) return;
  mealUnsub = onSnapshot(doc(db, "meals", mealId()), s => {
    const d = s.exists() ? s.data() : {};
    if (document.activeElement !== $("lunch")) $("lunch").value = d.lunch || "";
    if (document.activeElement !== $("dinner")) $("dinner").value = d.dinner || "";
  });
}
let t;
function saveMeal() {
  $("status").textContent = "Saving…";
  clearTimeout(t);
  t = setTimeout(async () => {
    try {
      await setDoc(doc(db, "meals", mealId()), { person: $("who").value, date: $("mealDate").value, lunch: $("lunch").value, dinner: $("dinner").value, updatedAt: serverTimestamp() }, { merge: true });
      $("status").textContent = "Saved ✓";
    } catch { $("status").textContent = "Save failed — check connection"; }
  }, 500);
}
["lunch","dinner"].forEach(i => $(i).addEventListener("input", saveMeal));
$("who").addEventListener("change", () => { render(); watchMeal(); });
$("mealDate").addEventListener("change", watchMeal);
render();
