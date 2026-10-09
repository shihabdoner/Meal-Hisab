import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, SCRIPT_URL } from "./firebase-config.js";

const $ = id => document.getElementById(id);
const NAMES = ["Shohan", "Naved", "Salman", "Rifat", "Shihab", "Ashmit"];
const fmt = n => "৳" + (Math.round(n * 100) / 100).toLocaleString("en-US");
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const todayIso = iso(new Date());
const num = x => {
  const n = Number(x);
  return (x === "" || x == null || isNaN(n)) ? 0 : n;
};
const lab = d => new Date(d + "T00:00:00").toLocaleDateString("en-US", {
  weekday: "short", month: "short", day: "numeric"
});

$("monthLabel").textContent = new Date().toLocaleDateString("en-US", {
  month: "long", year: "numeric"
});
$("today").textContent = new Date().toLocaleDateString("en-US", {
  weekday: "long", year: "numeric", month: "long", day: "numeric"
});
["spDate", "depDate", "mealDate"].forEach(i => $(i).value = todayIso);

function fillNameSelect(id, includeBlank = true) {
  const sel = $(id);
  if (!sel) return;

  const keep = sel.value;
  sel.textContent = "";

  if (includeBlank) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = id === "adminPreview" ? "Your admin view" : "— নাম নির্বাচন করুন —";
    sel.appendChild(o);
  }

  NAMES.forEach(n => {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  });

  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}

["fundWho", "mealWho", "spBazarKorta", "permPerson", "adminPreview"]
  .forEach(id => fillNameSelect(id));

if (SCRIPT_URL.startsWith("PASTE_")) {
  $("setup").hidden = false;
  throw new Error("SCRIPT_URL not set");
}

const auth = getAuth(initializeApp(firebaseConfig));
let me = null, S = null, busy = false, poll = null, previewName = "";

// ---------- API ----------
async function api(action, payload = {}) {
  const idToken = await auth.currentUser.getIdToken();
  const r = await fetch(SCRIPT_URL, {
    method: "POST",
    body: JSON.stringify({ action, idToken, ...payload })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Request failed");
  return j;
}

async function act(action, payload) {
  try {
    await api(action, payload);
    await refresh(true);
    return true;
  } catch (e) {
    alert(e.message);
    return false;
  }
}

// ---------- Sign-in ----------
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

$("gBtn").onclick = async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (
      e.code === "auth/popup-blocked" ||
      e.code === "auth/operation-not-supported-in-this-environment"
    ) {
      signInWithRedirect(auth, provider);
    } else if (
      e.code !== "auth/popup-closed-by-user" &&
      e.code !== "auth/cancelled-popup-request"
    ) {
      $("loginMsg").textContent = "Sign-in failed: " + (e.code || e.message);
    }
  }
};

$("out").onclick = $("deniedOut").onclick = () => signOut(auth);
$("refresh").onclick = () => refresh(true);

function showLogin(msg, denied) {
  $("app").hidden = true;
  $("login").hidden = false;
  $("loginMsg").textContent = msg || "Sign in with the Google account the admin added for you.";
  $("gBtn").hidden = !!denied;
  $("deniedOut").hidden = !denied;
}

function setLive(on) {
  const l = $("live");
  l.textContent = on ? "● live" : "● offline";
  l.className = "live " + (on ? "on" : "off");
}

onAuthStateChanged(auth, user => {
  clearInterval(poll);
  me = null;
  S = null;
  setLive(false);

  if (!user) return showLogin();

  $("loginMsg").textContent = "Loading…";
  refresh(true);
  poll = setInterval(() => {
    if (!document.hidden && me) refresh();
  }, 15000);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && auth.currentUser) refresh();
});

async function refresh(force) {
  if (busy && !force) return;
  busy = true;

  try {
    S = await api("load");
    me = S.me;
    setLive(true);

    ["fundWho", "mealWho", "spBazarKorta"].forEach(id => {
      if ($(id).options.length !== NAMES.length + 1) fillNameSelect(id);
    });

    $("login").hidden = true;
    $("app").hidden = false;

    applyRole();
    render();
    renderAlerts();
    syncMeal();
  } catch (e) {
    if (/group list/i.test(e.message)) {
      showLogin(e.message + ". Ask the admin to add this email.", true);
    } else {
      setLive(false);
      if (!me) showLogin("Could not reach the sheet: " + e.message, true);
    }
  } finally {
    busy = false;
  }
}

// ---------- Admin preview and permissions ----------
function effectiveName() {
  return me && me.admin && previewName ? previewName : (me ? me.name : "");
}

function effectiveMember() {
  return (S && S.members || []).find(x => x.name === effectiveName()) || me;
}

function isPreview() {
  return !!(me && me.admin && previewName);
}

function applyRole() {
  const view = effectiveMember();

  $("me").textContent =
    `${me.name} · ${me.admin ? "Admin" : "Member"}${isPreview() ? " (preview: " + previewName + ")" : ""}`;

  document.querySelectorAll(".adminOnly").forEach(el => {
    el.hidden = !me.admin || isPreview();
  });

  $("adminPreview").hidden = !me.admin;

  if (me.admin && $("adminPreview").options.length !== NAMES.length + 1) {
    const old = $("adminPreview").value;
    $("adminPreview").textContent = "";

    const own = document.createElement("option");
    own.value = "";
    own.textContent = "Your admin view";
    $("adminPreview").appendChild(own);

    NAMES.forEach(n => {
      const o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      $("adminPreview").appendChild(o);
    });

    $("adminPreview").value = old || previewName;
  }

  $("previewNotice").hidden = !isPreview();

  const allowGrocery = isPreview()
    ? !!(view && (view.admin || view.addSpending || view.canGrocery))
    : !!(me.admin || me.addSpending || me.canGrocery);

  $("spendAddBox").hidden = !allowGrocery;
  $("spForm").querySelectorAll("input,textarea,select,button").forEach(el => {
    el.disabled = isPreview();
  });

  ["fundWho", "mealWho"].forEach(id => {
    if (!$(id).value) $(id).value = effectiveName();
  });

  if (me.admin && !isPreview() && !$("memberList").contains(document.activeElement)) {
    renderMembers();
  }

  if (
    me.admin &&
    !isPreview() &&
    !$("permEditor").contains(document.activeElement) &&
    document.activeElement !== $("permPerson")
  ) {
    renderPermissionEditor();
  }
}

// ---------- Rendering ----------
function relDate(d) {
  if (!d) return "N/A";
  if (d === todayIso) return "TODAY";

  const y = new Date();
  y.setDate(y.getDate() - 1);

  if (d === iso(y)) return "YESTERDAY";

  return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
    day: "numeric", month: "short", year: "numeric"
  });
}

const monthKey = todayIso.slice(0, 7);

const monthSpent = () =>
  S.spending
    .filter(e => e.date.slice(0, 7) === monthKey)
    .reduce((t, e) => t + num(e.amount), 0);

function balanceOf(n) {
  const share = monthSpent() / NAMES.length;
  const dep = S.depDates.reduce((t, d) => t + num(S.deposits[d][n]), 0);

  return {
    dep,
    share,
    bal: Math.round((dep - share) * 100) / 100
  };
}

function render() {
  const viewName = effectiveName();
  const viewMember = effectiveMember();
  const m = balanceOf(viewName);

  $("myDep").textContent = fmt(m.dep);
  $("myRes").textContent = fmt(Math.max(m.bal, 0));
  $("myDue").textContent = fmt(Math.max(-m.bal, 0));
  $("dueCard").classList.toggle("neg", m.bal < 0);
  $("resNote").textContent = `Share ${fmt(m.share)} (${fmt(monthSpent())} ÷ ${NAMES.length})`;

  const lastBazar = [...S.spending]
    .filter(e => e.date <= todayIso && num(e.amount) > 0)
    .sort((x, y) => x.date.localeCompare(y.date))
    .pop();

  $("lastDate").textContent = relDate(lastBazar && lastBazar.date);

  const fund = S.depDates.reduce(
    (t, d) => t + NAMES.reduce((u, n) => u + num(S.deposits[d][n]), 0), 0
  );

  const spent = S.spending.filter(e => e.date <= todayIso);
  const out = spent.reduce((t, e) => t + num(e.amount), 0);

  $("fund").textContent = fmt(fund);
  $("spent").textContent = fmt(out);
  $("left").textContent = fmt(fund - out);
  $("leftcard").classList.toggle("neg", fund - out < 0);

  const last = [...spent]
    .filter(e => num(e.amount) > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .pop();

  $("last").textContent = last ? fmt(num(last.amount)) : "N/A";
  $("lastd").textContent = last
    ? `${last.date}${last.details && last.details !== "N/A" ? " · " + last.details : ""}${last.bazarKorta ? " · বাজারকর্তা: " + last.bazarKorta : ""}`
    : "";

  const fundEntries = [];

  S.depDates.forEach(d => NAMES.forEach(n => {
    const amount = num(S.deposits[d][n]);
    if (amount > 0) fundEntries.push({ date: d, person: n, amount });
  }));

  fundEntries.sort((a, b) => a.date.localeCompare(b.date));
  const lf = fundEntries[fundEntries.length - 1];

  $("lastFund").textContent = lf ? fmt(lf.amount) : "N/A";
  $("lastFundMeta").textContent = lf ? `${lf.date} · ${lf.person}` : "";

  const sl = $("spList");
  sl.textContent = "";

  const sp = S.spending
    .filter(e => num(e.amount) > 0)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!sp.length) sl.textContent = "No spending yet";

  sp.forEach(e => {
    const editable = isPreview()
      ? !!(e.addedByEmail && viewMember &&
        e.addedByEmail === viewMember.email &&
        e.date === latestSpendingDateBy(viewMember.email))
      : (me.admin ||
        (e.addedByEmail && e.addedByEmail === me.email &&
        e.date === latestSpendingDateBy(me.email)));

    sl.appendChild(spendingRowEl(e, editable));
  });

  const who = $("fundWho").value;
  $("fundPerson").hidden = !who;

  const canFund = isPreview()
    ? !!(viewMember && (
        viewMember.admin ||
        who === viewMember.name ||
        (viewMember.canFunds !== false && (viewMember.addFor || []).includes(who))
      ))
    : (me.admin ||
        who === me.name ||
        ((me.canFunds !== false) && (me.addFor || []).includes(who)));

  $("depForm").hidden = !(who && canFund);
  $("depForm").querySelectorAll("input,button").forEach(el => {
    el.disabled = isPreview();
  });

  if (who) {
    const mine = S.depDates
      .filter(d => num(S.deposits[d][who]) > 0)
      .sort();

    $("pt").textContent = fmt(mine.reduce((t, d) => t + num(S.deposits[d][who]), 0));

    const dl = $("deps");
    dl.textContent = "";

    if (!mine.length) dl.textContent = "এখনো কোনো জমা নেই";

    mine.slice().reverse().forEach(d => {
      const amount = num(S.deposits[d][who]);
      const latestOwn = d === mine[mine.length - 1] && who === me.name;
      const editable = isPreview()
        ? (who === viewName && d === mine[mine.length - 1])
        : (me.admin || latestOwn);

      dl.appendChild(rowEl(
        d, fmt(amount), null,
        editable ? () => editDeposit(d, who, amount) : null
      ));
    });
  }

  const mealWho = $("mealWho").value;
  $("mealPerson").hidden = !mealWho;

  if (mealWho) {
    renderMealHistory(mealWho);
    syncMeal();
  }

  renderTables();
}

function latestSpendingDateBy(email) {
  const authored = S.spending
    .filter(e => e.addedByEmail === email && num(e.amount) > 0)
    .map(e => e.date)
    .sort();

  return authored[authored.length - 1] || "";
}

function spendingRowEl(e, editable) {
  const r = document.createElement("div");
  r.className = "row spendingRow";

  const a = document.createElement("span");
  a.className = "spendingDescription";

  const date = document.createElement("b");
  date.className = "sp-date";
  date.textContent = e.date;
  a.appendChild(date);

  if (e.details && e.details !== "N/A") a.append(" · " + e.details);
  if (e.bazarKorta) a.append(" · বাজারকর্তা: " + e.bazarKorta);

  const b = document.createElement("span");
  const v = document.createElement("b");
  v.textContent = fmt(num(e.amount));
  b.appendChild(v);

  if (editable) {
    const x = document.createElement("button");
    x.className = "editBtn";
    x.textContent = "Edit";
    x.disabled = isPreview();
    x.onclick = () => editSpending(e);
    b.appendChild(x);
  }

  if (me.admin && !isPreview()) {
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.title = "Clear";
    x.onclick = () => {
      if (confirm("Clear this entry in the sheet?")) {
        act("clearSpending", { date: e.date });
      }
    };
    b.appendChild(x);
  }

  r.append(a, b);
  return r;
}

function renderMealHistory(name) {
  const box = $("mealHistory");
  box.textContent = "";

  const rows = Object.entries(S.mealNotes || {})
    .filter(([k, v]) => k.startsWith(name + "|") && (v.lunch || v.dinner))
    .map(([k, v]) => ({ date: k.slice(name.length + 1), ...v }))
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!rows.length) {
    box.textContent = "No meal details yet";
    return;
  }

  rows.forEach(e => {
    const r = document.createElement("div");
    r.className = "row mealHistoryRow";

    const a = document.createElement("span");
    const d = document.createElement("b");
    d.className = "sp-date";
    d.textContent = e.date;
    a.appendChild(d);

    const det = document.createElement("span");
    det.textContent = `দুপুর: ${e.lunch || "—"} · রাত: ${e.dinner || "—"}`;

    r.append(a, det);
    box.appendChild(r);
  });
}

async function editDeposit(date, person, current) {
  const raw = prompt(
    `Edit ${person}'s fund for ${date} (set the total for this date):`,
    String(current)
  );

  if (raw === null) return;

  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) {
    alert("Enter a valid amount (0 or more).");
    return;
  }

  await act("editDeposit", { date, person, amount });
}

async function editSpending(e) {
  const amountRaw = prompt(`Edit grocery amount for ${e.date}:`, String(e.amount));
  if (amountRaw === null) return;

  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) {
    alert("Enter a valid amount (0 or more).");
    return;
  }

  const details = prompt("Edit grocery details:", e.details || "");
  if (details === null) return;

  const manager = prompt(
    "বাজারকর্তা (enter one or more listed names, separated by comma):",
    e.bazarKorta || ""
  );
  if (manager === null) return;

  await act("editSpending", { date: e.date, amount, details, bazarKorta: manager });
}

function rowEl(left, right, onDel, onEdit) {
  const r = document.createElement("div");
  r.className = "row";

  const a = document.createElement("span");
  a.textContent = left;

  const b = document.createElement("span");
  const v = document.createElement("b");
  v.textContent = right;
  b.appendChild(v);

  if (onEdit) {
    const x = document.createElement("button");
    x.className = "editBtn";
    x.textContent = "Edit";
    x.disabled = isPreview();
    x.onclick = onEdit;
    b.appendChild(x);
  }

  if (onDel) {
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.title = "Clear";
    x.onclick = () => {
      if (confirm("Clear this entry in the sheet?")) onDel();
    };
    b.appendChild(x);
  }

  r.append(a, b);
  return r;
}

function table(head, rows, total, hl) {
  const t = document.createElement("table");
  t.className = "sheetTbl";

  const hr = t.createTHead().insertRow();
  head.forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  });

  const tb = t.createTBody();

  rows.forEach(([key, ...cells]) => {
    const tr = tb.insertRow();
    if (key === hl) tr.className = "today";

    [lab(key), ...cells].forEach(c => {
      const td = tr.insertCell();
      td.textContent = c === undefined || c === null ? "" : c;
      if (String(c).includes("\n")) td.style.whiteSpace = "pre-line";
    });
  });

  if (total) {
    const tr = tb.insertRow();
    tr.className = "total";
    total.forEach(c => {
      tr.insertCell().textContent = c;
    });
  }

  return t;
}

function renderTables() {
  const sums = (dates, src) =>
    NAMES.map(n => dates.reduce((t, d) => t + num(src[d][n]), 0));

  const put = (id, el) => {
    const b = $(id);
    b.textContent = "";
    b.appendChild(el);
  };

  put("tblMeals", table(
    ["Tarikh", ...NAMES],
    S.mealDates.map(d => [d, ...NAMES.map(n => S.meals[d][n])]),
    ["Total meal", ...sums(S.mealDates, S.meals)],
    todayIso
  ));

  put("tblDeposits", table(
    ["Tarikh", ...NAMES],
    S.depDates.map(d => [d, ...NAMES.map(n => S.deposits[d][n])]),
    ["Total", ...sums(S.depDates, S.deposits).map(fmt)],
    todayIso
  ));

  put("tblSpending", table(
    ["Tarikh", "Spending", "Details"],
    S.spending.map(e => [e.date, e.amount, e.details]),
    ["Total spending", fmt(S.spending.reduce((t, e) => t + num(e.amount), 0)), ""],
    todayIso
  ));
}

// ---------- Member management ----------
function renderMembers() {
  const box = $("memberList");
  box.textContent = "";

  NAMES.forEach(name => {
    const u = (S.members || []).find(x => x.name === name);

    const row = document.createElement("div");
    row.className = "mrow";

    const label = document.createElement("div");
    label.className = "mname";
    label.textContent = name + (u && u.admin ? " · Admin" : " · Member");

    const input = document.createElement("input");
    input.type = "email";
    input.placeholder = "Google email";
    input.value = u ? u.email : "";

    const save = document.createElement("button");
    save.textContent = "Save";
    save.onclick = () => act("saveMember", { name, email: input.value });

    row.append(label, input, save);

    if (u && !u.admin) {
      const mk = document.createElement("button");
      mk.textContent = "Make admin";
      mk.onclick = () => {
        if (confirm(`Make ${name} the admin? You will become a regular member.`)) {
          act("makeAdmin", { email: u.email });
        }
      };
      row.appendChild(mk);
    }

    box.appendChild(row);
  });
}

function renderPermissionEditor() {
  const sel = $("permPerson");
  const keep = sel.value;
  sel.textContent = "";

  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— Select person —";
  sel.appendChild(blank);

  NAMES.filter(n => n !== me.name).forEach(n => {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  });

  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  syncPermissionEditor();
}

function syncPermissionEditor() {
  const name = $("permPerson").value;
  const u = (S.members || []).find(x => x.name === name);

  $("permEditor").hidden = !u;
  if (!u) return;

  $("permGrocery").checked = !!u.canGrocery;
  $("permFunds").checked = !!u.canFunds;
  $("permMeals").checked = !!u.canMeals;

  const box = $("permWho");
  box.textContent = "";

  NAMES.filter(n => n !== name).forEach(n => {
    const l = document.createElement("label");
    l.className = "chip";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = n;
    cb.checked = (u.addFor || []).includes(n);

    l.append(cb, " " + n);
    box.appendChild(l);
  });
}

$("permPerson").addEventListener("change", syncPermissionEditor);

$("savePerms").addEventListener("click", async () => {
  const name = $("permPerson").value;
  const u = (S.members || []).find(x => x.name === name);
  if (!u) return;

  const addFor = [...$("permWho").querySelectorAll("input:checked")]
    .map(x => x.value);

  const ok = await act("savePerms", {
    email: u.email,
    addFor,
    canGrocery: $("permGrocery").checked,
    canFunds: $("permFunds").checked,
    canMeals: $("permMeals").checked
  });

  if (ok) {
    $("savePerms").blur();
    renderPermissionEditor();
  }
});

// ---------- Forms ----------
$("spForm").addEventListener("submit", async e => {
  e.preventDefault();

  await act("addSpending", {
    date: $("spDate").value,
    amount: $("spAmt").value,
    details: $("spDet").value.trim(),
    bazarKorta: $("spBazarKorta").value
  });

  $("spAmt").value = "";
  $("spDet").value = "";
  $("spBazarKorta").value = "";
});

$("depForm").addEventListener("submit", async e => {
  e.preventDefault();

  await act("addDeposit", {
    date: $("depDate").value,
    person: $("fundWho").value,
    amount: $("depAmt").value
  });

  $("depAmt").value = "";
});

// ---------- Meal details ----------
const noteKey = () => `${$("mealWho").value}|${$("mealDate").value}`;

function mealMode() {
  const who = $("mealWho").value;

  if (!me || !S || !who || !S.mealDates.includes($("mealDate").value) || isPreview()) {
    return null;
  }

  if (me.admin || who === me.name) return "full";

  if (me.canMeals !== false && (me.addFor || []).includes(who)) return "add";

  return null;
}

function setEditable() {
  const mode = mealMode();
  const who = $("mealWho").value;
  const date = $("mealDate").value;

  let roL = true, roD = true;

  if (mode === "full") {
    roL = false;
    roD = false;
  } else if (mode === "add") {
    const n = ((S && S.mealNotes) || {})[`${who}|${date}`] || {
      lunch: "", dinner: ""
    };

    const cell = S.meals[date] ? S.meals[date][who] : "";
    const locked = cell !== "" && cell != null && cell !== "N/A" && !n.lunch && !n.dinner;

    roL = locked || !!n.lunch;
    roD = locked || !!n.dinner;
  }

  $("lunch").readOnly = roL;
  $("dinner").readOnly = roD;

  const previewAdd = isPreview() &&
    effectiveMember() &&
    effectiveMember().canMeals !== false &&
    (effectiveMember().addFor || []).includes(who);

  $("mealSave").hidden = !(mode === "add" && (!roL || !roD)) && !previewAdd;
  $("mealSave").disabled = isPreview();

  $("status").textContent = isPreview()
    ? "Preview only — editing is disabled"
    : !who || !S ? ""
    : !S.mealDates.includes(date) ? "This date is not in the sheet"
    : mode === "add"
      ? "Add-only: fill an empty box and press Save. Saved entries can only be changed by the admin."
      : mode === "full"
        ? "Tip: a box with 1 (or any text) counts as that many meals in the sheet"
        : "View only — only this person, the admin or a permitted person can add";
}

function syncMeal() {
  if (!$("mealWho").value) return;

  const n = (S.mealNotes || {})[noteKey()] || { lunch: "", dinner: "" };

  if (document.activeElement !== $("lunch")) $("lunch").value = n.lunch;
  if (document.activeElement !== $("dinner")) $("dinner").value = n.dinner;

  setEditable();
}

async function sendMeal() {
  $("status").textContent = "Saving…";

  try {
    await api("setMeal", {
      person: $("mealWho").value,
      date: $("mealDate").value,
      lunch: $("lunch").value,
      dinner: $("dinner").value
    });

    $("status").textContent = "Saved to sheet ✓";
    refresh(true);
  } catch (e) {
    $("status").textContent = "Save failed: " + e.message;
  }
}

let t;

function saveMeal() {
  if (mealMode() !== "full") return;

  $("status").textContent = "Saving…";
  clearTimeout(t);
  t = setTimeout(sendMeal, 600);
}

$("mealSave").onclick = () => {
  if (mealMode() === "add") sendMeal();
};

["lunch", "dinner"].forEach(i => {
  $(i).addEventListener("input", saveMeal);
});

$("mealWho").addEventListener("change", () => {
  $("lunch").value = "";
  $("dinner").value = "";
  render();
  syncMeal();
});

$("fundWho").addEventListener("change", render);

$("adminPreview").addEventListener("change", () => {
  previewName = $("adminPreview").value === me.name
    ? ""
    : $("adminPreview").value;

  $("adminPreview").value = previewName;

  if (previewName) {
    $("fundWho").value = previewName;
    $("mealWho").value = previewName;
  } else {
    $("fundWho").value = me.name;
    $("mealWho").value = me.name;
  }

  applyRole();
  render();
  syncMeal();
});

$("mealDate").addEventListener("change", () => {
  $("lunch").value = "";
  $("dinner").value = "";
  syncMeal();
});

// ---------- Print / Save as PDF ----------
function rTable(head, rows, foot) {
  const t = document.createElement("table");
  const hr = t.createTHead().insertRow();

  head.forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  });

  const tb = t.createTBody();

  rows.forEach(r => {
    const tr = tb.insertRow();
    r.forEach(c => {
      tr.insertCell().textContent = c;
    });
  });

  if (foot) {
    const tr = tb.insertRow();
    tr.className = "rp-total";
    foot.forEach(c => {
      tr.insertCell().textContent = c;
    });
  }

  return t;
}

function buildReport(parts) {
  const R = $("report");
  R.textContent = "";

  const add = (cls, text) => {
    const e = document.createElement("div");
    e.className = cls;
    e.textContent = text;
    R.appendChild(e);
  };

  const month = new Date().toLocaleDateString("en-US", {
    month: "long", year: "numeric"
  });

  add("rp-h1", `খাদ্য তথ্য — ${month}`);
  add("rp-sub", `Printed ${new Date().toLocaleString("en-GB")} · ${me.name}`);

  const spentM = monthSpent();

  if (parts.includes("my")) {
    const m = balanceOf(me.name);

    add("rp-h2", `My data — ${me.name}`);

    R.appendChild(rTable(["Item", "Amount"], [
      ["My deposit to fund", fmt(m.dep)],
      [`My share (${fmt(spentM)} ÷ ${NAMES.length})`, fmt(m.share)],
      [m.bal < 0 ? "My Due" : "My residual", fmt(Math.abs(m.bal))]
    ]));

    add("rp-h3", "My deposits");

    const mine = S.depDates.filter(d => num(S.deposits[d][me.name]) > 0);

    if (mine.length) {
      R.appendChild(rTable(
        ["Date", "Amount"],
        mine.map(d => [d, fmt(num(S.deposits[d][me.name]))]),
        ["Total", fmt(m.dep)]
      ));
    } else {
      add("rp-note", "No deposits yet");
    }
  }

  if (parts.includes("fund")) {
    const fund = S.depDates.reduce(
      (t, d) => t + NAMES.reduce((u, n) => u + num(S.deposits[d][n]), 0), 0
    );

    const out = S.spending
      .filter(e => e.date <= todayIso)
      .reduce((t, e) => t + num(e.amount), 0);

    add("rp-h2", "Fund data");

    R.appendChild(rTable(["Item", "Amount"], [
      ["Total fund", fmt(fund)],
      ["Total spending", fmt(out)],
      ["Money left in the fund", fmt(fund - out)]
    ]));

    add("rp-h3", `Everyone (equal share ${fmt(spentM / NAMES.length)})`);

    const rows = NAMES.map(n => {
      const b = balanceOf(n);
      return [
        n, fmt(b.dep), fmt(b.share),
        b.bal >= 0 ? fmt(b.bal) : "",
        b.bal < 0 ? fmt(-b.bal) : ""
      ];
    });

    R.appendChild(rTable(["Name", "Deposit", "Share", "Residual", "Due"], rows));
  }

  if (parts.includes("bazar")) {
    const sp = S.spending
      .filter(e => num(e.amount) > 0)
      .sort((x, y) => x.date.localeCompare(y.date));

    add("rp-h2", "Bazar data");

    if (sp.length) {
      R.appendChild(rTable(
        ["Date", "Amount", "Details", "বাজারকর্তা"],
        sp.map(e => [
          e.date, fmt(num(e.amount)),
          e.details === "N/A" ? "" : e.details,
          e.bazarKorta || ""
        ]),
        ["Total", fmt(sp.reduce((t, e) => t + num(e.amount), 0)), "", ""]
      ));
    } else {
      add("rp-note", "No bazar entries yet");
    }
  }
}

function printReport(parts) {
  if (!S || !me) return;

  buildReport(parts);

  const old = document.title;
  document.title = `khaddo-${monthKey}-${parts.join("-")}`;

  window.addEventListener("afterprint", () => {
    document.title = old;
  }, { once: true });

  window.print();
}

document.querySelectorAll("[data-p]").forEach(b => {
  b.onclick = () => printReport(
    b.dataset.p === "all" ? ["my", "fund", "bazar"] : [b.dataset.p]
  );
});

// ---------- Admin alerts ----------
function alertLine(x) {
  const d = document.createElement("div");
  d.className = "alertLine";

  const when = new Date(x.time);
  const ts = isNaN(when) ? "" : when.toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
  });

  d.textContent = `${ts} · ${x.by}: ${x.detail}`;
  return d;
}

function renderAlerts() {
  const list = (S && S.alerts) || [];
  const bar = $("alertBar");

  bar.textContent = "";
  bar.hidden = !list.length;

  if (list.length) {
    const head = document.createElement("div");
    head.className = "alertHead";

    const tt = document.createElement("span");
    tt.textContent = `⚠ ${list.length} new ${list.length > 1 ? "entries" : "entry"} by permitted people`;

    const b = document.createElement("button");
    b.textContent = "Acknowledged";
    b.onclick = () => act("ackAlerts", { all: true });

    head.append(tt, b);
    bar.appendChild(head);

    list.slice(-8).reverse().forEach(x => bar.appendChild(alertLine(x)));

    if (list.length > 8) {
      const m = document.createElement("div");
      m.className = "alertLine";
      m.textContent = `+ ${list.length - 8} more`;
      bar.appendChild(m);
    }
  }

  ["deposit", "spending", "meal"].forEach(type => {
    const items = list.filter(x => x.type === type);

    document.querySelectorAll(`.alertDot[data-alert="${type}"]`).forEach(el => {
      el.hidden = !items.length;
      el.textContent = `⚠ ${items.length}`;
    });

    document.querySelectorAll(`.secAlert[data-alert="${type}"]`).forEach(el => {
      el.textContent = "";
      el.hidden = !items.length;

      if (!items.length) return;

      items.slice().reverse().forEach(x => el.appendChild(alertLine(x)));

      const b = document.createElement("button");
      b.textContent = "Acknowledged";
      b.onclick = () => act("ackAlerts", { type });
      el.appendChild(b);
    });
  });
}
