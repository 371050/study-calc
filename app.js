
let db;
let currentSubjectId = null;
let selectedProblemId = null;
let selectedAttemptId = null;

function $(id){ return document.getElementById(id); }
function escapeHtml(s){
  return String(s).replace(/[&<>\"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}
function toast(msg){ $("log").textContent = msg; setTimeout(()=>{$("log").textContent="";}, 3000); }

/* ---- 正規化ユーティリティ ---- */
function normalizeHalfWidth(s) {
  if (!s) return "";
  // 全角数字→半角
  const z2hDigit = ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  s = s.replace(/[０-９]/g, z2hDigit);
  // 全角スペース→半角
  s = s.replace(/\u3000/g, " ");
  // 全角ハイフン/長音など→半角-
  s = s.replace(/[－ー―〜～]/g, "-");
  // 連続空白圧縮
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
const UNIT_RE = /^\d+\-\d+$/;

/** 「問題3 / 第2回 / 3 / 2」から数値Nを抽出 */
function extractNumberFromLabel(label) {
  const s = normalizeHalfWidth(label);
  // "問題3" / "第3回" / "3" のいずれもOK
  let m = s.match(/^問題\s*(\d+)$/);
  if (m) return Number(m[1]);
  m = s.match(/^第?\s*(\d+)\s*回?$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+)$/);
  if (m) return Number(m[1]);
  return null;
}

function problemLabel(p) {
  if (p.kind === "問題") return `${p.unitCode} 問題${p.number}`;
  if (p.kind === "確認テスト") return `確認テスト 第${p.number}回`;
  return `答練 第${p.number}回`;
}

/* ---- Subjects ---- */
async function refreshSubjects(selectId=null) {
  const subs = await listSubjects(db);
  const sel = $("subjectSelect");
  sel.innerHTML = "";
  subs.forEach(s => { const opt = document.createElement("option"); opt.value = s.id; opt.textContent = s.name; sel.appendChild(opt); });
  if (subs.length) {
    currentSubjectId = selectId ?? currentSubjectId ?? subs[0].id;
    sel.value = currentSubjectId;
  } else {
    currentSubjectId = null;
  }
  await refreshAll();
}

async function refreshAll() {
  await refreshDue();
  await refreshUpcoming();
  await refreshMatrix();
  await refreshAttempts();
}

/* ---- Due / Upcoming ---- */
async function refreshDue() {
  const tbody = $("dueTable").querySelector("tbody"); tbody.innerHTML = "";
  const subs = await listSubjects(db); const subMap = new Map(subs.map(s => [s.id, s]));
  const problems = await getAll(db, "problems");
  const today = new Date(); today.setHours(0,0,0,0);
  const rows = [];

  for (const p of problems) {
    const st = await computeProblemStatus(db, p);
    if (st.hide || !st.nextDue) continue;
    const due = new Date(st.nextDue); due.setHours(0,0,0,0);
    if (due <= today) {
      const subj = subMap.get(p.subjectId);
      const overdue = Math.max(0, Math.round((today - due)/(1000*60*60*24)));
      rows.push({
        subjectOrder: subj?.sortOrder ?? 999,
        subject: subj?.name ?? "",
        label: problemLabel(p),
        p,
        lastNo: st.lastNo, lastDate: st.lastDate, nextDue: st.nextDue, overdue
      });
    }
  }

  rows.sort((a,b) =>
    (a.subjectOrder - b.subjectOrder) ||
    problemComparator(a.p, b.p) ||
    b.overdue - a.overdue ||
    a.nextDue.localeCompare(b.nextDue)
  );

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.subject)}</td>
      <td>${escapeHtml(r.label)}</td>
      <td>${r.lastNo}</td>
      <td>${r.lastDate}</td>
      <td>${r.nextDue}</td>
      <td>${r.overdue}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function refreshUpcoming() {
  const tbody = $("upcomingTable").querySelector("tbody"); tbody.innerHTML = "";
  const subs = await listSubjects(db); const subMap = new Map(subs.map(s => [s.id, s]));
  const problems = await getAll(db, "problems");
  const today = new Date(); today.setHours(0,0,0,0);
  const end = new Date(today); end.setDate(end.getDate() + 7);
  const rows = [];

  for (const p of problems) {
    const st = await computeProblemStatus(db, p);
    if (st.hide || !st.nextDue) continue;
    const due = new Date(st.nextDue); due.setHours(0,0,0,0);
    if (today <= due && due <= end) {
      const subj = subMap.get(p.subjectId);
      rows.push({
        due: st.nextDue,
        subjectOrder: subj?.sortOrder ?? 999,
        subject: subj?.name ?? "",
        label: problemLabel(p),
        p,
        lastNo: st.lastNo, lastDate: st.lastDate
      });
    }
  }

  rows.sort((a,b) =>
    a.due.localeCompare(b.due) ||
    (a.subjectOrder - b.subjectOrder) ||
    problemComparator(a.p, b.p)
  );

  let lastDue = null;
  for (const r of rows) {
    if (r.due !== lastDue) {
      const g = document.createElement("tr");
      g.className = "group";
      g.innerHTML = `<td>${r.due}</td><td colspan="4"></td>`;
      tbody.appendChild(g);
      lastDue = r.due;
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td></td>
      <td>${escapeHtml(r.subject)}</td>
      <td>${escapeHtml(r.label)}</td>
      <td>${r.lastNo}</td>
      <td>${r.lastDate}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---- Matrix（教科内のフラット問題一覧） ---- */
async function refreshMatrix() {
  const thead = $("matrixHeaderRow"); const tbody = $("matrixTable").querySelector("tbody");
  thead.innerHTML = "<th>問題</th>"; tbody.innerHTML = "";
  if (!currentSubjectId) return;

  const problems = await listProblemsBySubject(db, Number(currentSubjectId));

  let maxNo = 0; const attemptsMap = new Map();
  for (const p of problems) {
    const atts = await listAttemptsByProblem(db, p.id);
    attemptsMap.set(p.id, atts);
    if (atts.length) maxNo = Math.max(maxNo, Math.max(...atts.map(a=>a.attemptNo)));
  }
  for (let i=1; i<=Math.max(maxNo, 5); i++) { const th = document.createElement("th"); th.textContent = `${i}回目`; thead.appendChild(th); }

  for (const p of problems) {
    const tr = document.createElement("tr"); tr.dataset.problemId = p.id;
    tr.innerHTML = `<td class="nowrap">${escapeHtml(problemLabel(p))}</td>`;
    const atts = attemptsMap.get(p.id) ?? []; const byNo = new Map(atts.map(a => [a.attemptNo, a])); const cols = Math.max(maxNo, 5);
    for (let i=1; i<=cols; i++) {
      const a = byNo.get(i); const td = document.createElement("td"); td.className = "center";
      if (a) {
        const pill = document.createElement("div");
        pill.className = "pill " + (a.att==="○" ? "-ok" : a.att==="△" ? "-mid" : "-ng");
        pill.textContent = a.att;
        pill.title = `${a.doneDate} / ${a.minutes??"-"}分 / ${a.score??"-"}点`;
        pill.onclick = () => { selectedProblemId = p.id; selectedAttemptId = a.id; fillEditForm(a); highlightSelection(); refreshAttempts(); };
        td.appendChild(pill);
      } else { td.textContent = ""; }
      tr.appendChild(td);
    }
    tr.onclick = () => { selectedProblemId = p.id; selectedAttemptId = null; highlightSelection(); refreshAttempts(); fillProblemForm(p); };
    tbody.appendChild(tr);
  }
  highlightSelection();
}
function fillEditForm(a) {
  $("editNo").value = a.attemptNo; $("editDate").value = a.doneDate;
  $("editTime").value = a.minutes ?? ""; $("editScore").value = a.score ?? ""; $("editAtt").value = a.att;
}
function fillProblemForm(p) {
  $("formKind").value = p.kind;
  $("formUnitCode").value = p.unitCode ?? "";
  $("formNumber").value = p.number ?? "";
}
function highlightSelection() {
  const rows = $("matrixTable").querySelectorAll("tbody tr");
  rows.forEach(r => r.style.outline = (Number(r.dataset.problemId) === selectedProblemId) ? "2px solid #7aa2ff" : "none");
}

/* ---- 履歴表 ---- */
async function refreshAttempts() {
  const tbody = $("attemptsTable").querySelector("tbody"); tbody.innerHTML = "";
  selectedAttemptId = null;
  $("editNo").value = ""; $("editDate").value = ""; $("editTime").value = ""; $("editScore").value = ""; $("editAtt").value = "○";
  if (!selectedProblemId) return;
  const list = await listAttemptsByProblem(db, selectedProblemId);
  for (const a of list) {
    const tr = document.createElement("tr"); tr.dataset.attemptId = a.id;
    tr.innerHTML = `<td>${a.id}</td><td>${a.attemptNo}</td><td>${a.doneDate}</td><td>${a.minutes??""}</td><td>${a.score??""}</td><td>${a.att}</td>`;
    tr.onclick = () => { selectedAttemptId = a.id; fillEditForm(a); highlightAttemptSel(); };
    tbody.appendChild(tr);
  }
}
function highlightAttemptSel() {
  const rows = $("attemptsTable").querySelectorAll("tbody tr");
  rows.forEach(r => r.style.outline = (Number(r.dataset.attemptId)===selectedAttemptId) ? "2px solid #7aa2ff" : "none");
}

/* ---- 初期化 ---- */
async function init() {
  db = await openDb();
  await seedDefaultSubjects(db);

  const today = toYmdLocal(new Date());
  $("quickDate").value = today; $("formDate").value = today;

  // 初期到達度（復習予定に乗せやすいよう △）
  $("quickAtt").value = "△";
  $("formAtt").value  = "△";

  // 「種類」に応じて単元コード欄の表示切替（クイック/フォーム）
  function toggleRowsByKind() {
    const qk = $("quickKind").value;
    $("quickUnitRow").classList.toggle("hide", qk !== "問題");
    const fk = $("formKind").value;
    $("formUnitRow").classList.toggle("hide", fk !== "問題");
  }
  $("quickKind").addEventListener("change", toggleRowsByKind);
  $("formKind").addEventListener("change", toggleRowsByKind);
  toggleRowsByKind();

  if ("serviceWorker" in navigator) { navigator.serviceWorker.register("./sw.js").catch(()=>{}); }

  await refreshSubjects();

  // 教科イベント
  $("subjectSelect").onchange = async (e) => {
    currentSubjectId = Number(e.target.value);
    selectedProblemId = null; selectedAttemptId = null;
    await refreshAll();
  };
  $("addSubjectBtn").onclick = async () => {
    const name = prompt("追加する教科名（例：消費税法）を入力");
    if (!name) return;
    try { await addSubject(db, name); await refreshSubjects(currentSubjectId); }
    catch(e){ alert(e.message); }
  };
  $("subjectUpBtn").onclick = async () => {
    if (!currentSubjectId) return; await moveSubject(db, Number(currentSubjectId), -1); await refreshSubjects(Number(currentSubjectId));
  };
  $("subjectDownBtn").onclick = async () => {
    if (!currentSubjectId) return; await moveSubject(db, Number(currentSubjectId), +1); await refreshSubjects(Number(currentSubjectId));
  };

  // クイック記録（新仕様）
  $("recordQuickBtn").onclick = async () => {
    if (!currentSubjectId) return alert("教科を選んでください");

    const kind = $("quickKind").value;               // 問題 / 確認テスト / 答練
    let unitCode = $("quickUnitCode").value.trim();  // 種類=問題の時だけ使用
    let numberLabel = $("quickNumberLabel").value.trim();

    // 正規化（全角→半角 等）
    unitCode = normalizeHalfWidth(unitCode);
    numberLabel = normalizeHalfWidth(numberLabel);

    const doneDate = $("quickDate").value;
    const minutes = $("quickTime").value ? Number($("quickTime").value) : null;
    const score = $("quickScore").value ? Number($("quickScore").value) : null;
    const att = $("quickAtt").value;

    if (!doneDate) return alert("学習日を入れてください");

    const num = extractNumberFromLabel(numberLabel);
    if (!Number.isInteger(num) || num <= 0) {
      return alert("番号ラベルから正しい数字が読み取れません（例：問題3 / 第2回 / 3 / 2）");
    }
    if (kind === "問題") {
      if (!UNIT_RE.test(unitCode)) return alert("単元コードは 1-1 形式（数字-数字）です");
    } else {
      unitCode = null;
    }

    // 問題を作成/取得 → attempt 追加
    const problemId = await getOrCreateProblem(db, Number(currentSubjectId), kind, unitCode, num);
    const nextNo = await getNextAttemptNo(db, problemId);
    try {
      await insertAttempt(db, problemId, nextNo, doneDate, minutes, score, att);
    } catch (e) {
      return alert("同じ学習日/回数が既にあるようです");
    }

    // 入力欄リセット（種類は維持）
    $("quickNumberLabel").value = "";
    $("quickTime").value = "";
    $("quickScore").value = "";
    if (kind === "問題") $("quickUnitCode").value = "";

    toast("記録しました");
    await refreshAll();
  };

  // フォーム記録（従来どおり）
  $("addOrRecordBtn").onclick = async () => {
    if (!currentSubjectId) return alert("教科を選んでください");
    const kind = $("formKind").value;
    const unitCodeRaw = $("formUnitCode").value.trim();
    const unitCode = kind === "問題" ? normalizeHalfWidth(unitCodeRaw) : null;
    const number = $("formNumber").value ? Number($("formNumber").value) : null;
    const doneDate = $("formDate").value;
    const minutes = $("formTime").value ? Number($("formTime").value) : null;
    const score = $("formScore").value ? Number($("formScore").value) : null;
    const att = $("formAtt").value;

    if (!doneDate) return alert("学習日を入れてください");
    if (!Number.isInteger(number) || number <= 0) return alert("番号は1以上の整数です");
    if (kind === "問題" && (!UNIT_RE.test(unitCode))) return alert("単元コードは 1-1 形式（数字-数字）です");

    const problemId = await getOrCreateProblem(db, Number(currentSubjectId), kind, unitCode, number);
    const nextNo = await getNextAttemptNo(db, problemId);
    try { await insertAttempt(db, problemId, nextNo, doneDate, minutes, score, att); }
    catch (e) { return alert("同じ学習日/回数が既にあるようです"); }
    selectedProblemId = problemId;
    toast(`追加/記録: ${problemLabel({kind, unitCode, number})} ${doneDate} ${nextNo}回目`);
    await refreshAll();
  };

  $("deleteProblemBtn").onclick = async () => {
    if (!selectedProblemId) return alert("削除する問題をマトリクスから選んでください");
    if (!confirm("この問題を削除（履歴も全て削除）してよいですか？")) return;
    await deleteProblem(db, selectedProblemId);
    selectedProblemId = null; selectedAttemptId = null; await refreshAll();
  };

  $("updateAttemptBtn").onclick = async () => {
    if (!selectedProblemId || !selectedAttemptId) return alert("編集する履歴を選んでください");
    const newNo = Number($("editNo").value);
    const newDate = $("editDate").value;
    const newMin = $("editTime").value ? Number($("editTime").value) : null;
    const newScore = $("editScore").value ? Number($("editScore").value) : null;
    const newAtt = $("editAtt").value;
    if (!Number.isInteger(newNo) || newNo <= 0) return alert("回数は正の整数です");
    if (!newDate) return alert("日付を入れてください");
    const list = await listAttemptsByProblem(db, selectedProblemId);
    if (list.some(a => a.id !== selectedAttemptId && a.attemptNo === newNo)) return alert(`回数 ${newNo} は既にあります`);
    if (list.some(a => a.id !== selectedAttemptId && a.doneDate === newDate)) return alert(`学習日 ${newDate} は既にあります`);
    try { await updateAttempt(db, selectedAttemptId, { attemptNo: newNo, doneDate: newDate, minutes: newMin, score: newScore, att: newAtt }); }
    catch (e) { return alert("一意制約に抵触しました（回数 or 日付の重複）"); }
    toast("編集しました"); await refreshAll();
  };

  $("deleteAttemptBtn").onclick = async () => {
    if (!selectedAttemptId) return alert("削除する履歴を選んでください");
    if (!confirm("この学習履歴を削除してもよいですか？")) return;
    await deleteAttempt(db, selectedAttemptId);
    selectedAttemptId = null; toast("削除しました"); await refreshAll();
  };

  $("renumberBtn").onclick = async () => {
    if (!selectedProblemId) return alert("再採番する問題を選んでください");
    if (!confirm("この問題の履歴を日付順に1..nへ再採番します。よろしいですか？")) return;
    await renumberAttempts(db, selectedProblemId); toast("再採番しました"); await refreshAll();
  };

  // Export / Import / Wipe
  $("exportBtn").onclick = async () => {
    const data = await exportJson(db);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `calc-flat-sync-${toYmdLocal(new Date())}.json`; a.click(); URL.revokeObjectURL(url);
  };
  $("importFile").onchange = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      if (!confirm("インポートします。この端末のデータは上書きされます。よろしいですか？")) return;
      await importJsonOverwrite(db, data);
      toast("インポート完了"); selectedProblemId = null; selectedAttemptId = null; await refreshSubjects();
    } catch (err) { alert("インポート失敗: " + err.message); }
    finally { e.target.value = ""; }
  };
  $("wipeBtn").onclick = async () => {
    if (!confirm("この端末のデータを全消去します。よろしいですか？")) return;
    const t = db.transaction(["attempts","problems","subjects"], "readwrite");
    t.objectStore("attempts").clear(); t.objectStore("problems").clear(); t.objectStore("subjects").clear();
    await new Promise((res,rej)=>{ t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); });
    await seedDefaultSubjects(db);
    selectedProblemId = null; selectedAttemptId = null; await refreshSubjects(); toast("全消去しました");
  };
}

window.addEventListener("load", init);
``
