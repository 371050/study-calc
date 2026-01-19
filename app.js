
let cdb;
let currentSeriesId = null;
let selectedProblemId = null;
let selectedAttemptId = null;

function $(id){ return document.getElementById(id); }
function escapeHtml(s){ return String(s).replace(/[&<>\"']/g, c => ({'&':'&','<':'<','>':'>','"':'"','\'':'\''}[c])); }
function toast(msg){ $("log").textContent = msg; setTimeout(()=>{$("log").textContent="";}, 3000); }

/* 入力パース："1-1 問題3" / "1-1 総合1" / "第2回 答練" */
function parseQuick(text) {
  const parts = text.trim().split(/[、\s]+/).map(s=>s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = p.match(/^(?<series>(?:\d+\-\d+|第\d+回))\s*(?<kind>問題|総合|答練)\s*(?<num>\d+)?$/);
    if (!m) { out.push({ error: p }); continue; }
    const { series, kind } = m.groups;
    const number = (kind === "答練") ? null : (m.groups.num ? Number(m.groups.num) : null);
    if (kind !== "答練" && (number===null || !Number.isInteger(number) || number<=0)) { out.push({ error: p }); continue; }
    out.push({ series, kind, number });
  }
  return out;
}

async function refreshSeries(selectId=null) {
  const list = await listSeries(cdb);
  const sel = $("seriesSelect"); sel.innerHTML = "";
  list.forEach(s => { const opt = document.createElement("option"); opt.value = s.id; opt.textContent = s.name; sel.appendChild(opt); });
  if (list.length) { currentSeriesId = selectId ?? currentSeriesId ?? list[0].id; sel.value = currentSeriesId; } else { currentSeriesId = null; }
  await refreshAll();
}
async function refreshAll() { await refreshDue(); await refreshUpcoming(); await refreshMatrix(); await refreshAttempts(); }

async function refreshDue() {
  const tbody = $("dueTable").querySelector("tbody"); tbody.innerHTML = "";
  const seriesList = await listSeries(cdb); const sMap = new Map(seriesList.map(s => [s.id, s]));
  const problems = await getAll2(cdb, "problems");
  const today = new Date(); today.setHours(0,0,0,0);
  const rows = [];
  for (const p of problems) {
    const st = await computeProblemStatus(cdb, p);
    if (st.hide || !st.nextDue) continue;
    const due = new Date(st.nextDue); due.setHours(0,0,0,0);
    if (due <= today) {
      const overdue = Math.max(0, Math.round((today - due) / (1000*60*60*24)));
      rows.push({ seriesOrder: sMap.get(p.seriesId)?.sortOrder ?? 999, series: sMap.get(p.seriesId)?.name ?? "", label: problemLabel(p), lastNo: st.lastNo, lastDate: st.lastDate, nextDue: st.nextDue, overdue });
    }
  }
  rows.sort((a,b) => a.seriesOrder - b.seriesOrder || b.overdue - a.overdue || a.nextDue.localeCompare(b.nextDue) || a.label.localeCompare(b.label, "ja"));
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(r.series)}</td><td>${escapeHtml(r.label)}</td><td>${r.lastNo}</td><td>${r.lastDate}</td><td>${r.nextDue}</td><td>${r.overdue}</td>`;
    tbody.appendChild(tr);
  }
}
async function refreshUpcoming() {
  const tbody = $("upcomingTable").querySelector("tbody"); tbody.innerHTML = "";
  const seriesList = await listSeries(cdb); const sMap = new Map(seriesList.map(s => [s.id, s]));
  const problems = await getAll2(cdb, "problems");
  const today = new Date(); today.setHours(0,0,0,0);
  const end = new Date(today); end.setDate(end.getDate() + 7);
  const rows = [];
  for (const p of problems) {
    const st = await computeProblemStatus(cdb, p);
    if (st.hide || !st.nextDue) continue;
    const due = new Date(st.nextDue); due.setHours(0,0,0,0);
    if (today <= due && due <= end) rows.push({ due: st.nextDue, seriesOrder: sMap.get(p.seriesId)?.sortOrder ?? 999, series: sMap.get(p.seriesId)?.name ?? "", label: problemLabel(p), lastNo: st.lastNo, lastDate: st.lastDate });
  }
  rows.sort((a,b) => a.due.localeCompare(b.due) || a.seriesOrder - b.seriesOrder || a.label.localeCompare(b.label, "ja"));
  let lastDue = null;
  for (const r of rows) {
    if (r.due !== lastDue) { const g = document.createElement("tr"); g.className = "group"; g.innerHTML = `<td>${r.due}</td><td colspan="4"></td>`; tbody.appendChild(g); lastDue = r.due; }
    const tr = document.createElement("tr");
    tr.innerHTML = `<td></td><td>${escapeHtml(r.series)}</td><td>${escapeHtml(r.label)}</td><td>${r.lastNo}</td><td>${r.lastDate}</td>`;
    tbody.appendChild(tr);
  }
}
function problemLabel(p) { return (p.kind === "答練") ? "答練" : `${p.kind}${p.number}`; }

async function refreshMatrix() {
  const thead = $("matrixHeaderRow"); const tbody = $("matrixTable").querySelector("tbody");
  thead.innerHTML = "<th>問題</th>"; tbody.innerHTML = ""; if (!currentSeriesId) return;
  const problems = await listProblemsBySeries(cdb, Number(currentSeriesId));
  let maxNo = 0; const attemptsMap = new Map();
  for (const p of problems) {
    const atts = await listAttemptsByProblem(cdb, p.id);
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
  const currentSeriesName = $("seriesSelect").selectedOptions[0]?.textContent ?? "";
  $("formSeries").value = currentSeriesName; $("formKind").value = p.kind; $("formNumber").value = (p.kind === "答練") ? "" : (p.number ?? "");
}
function highlightSelection() {
  const rows = $("matrixTable").querySelectorAll("tbody tr");
  rows.forEach(r => r.style.outline = (Number(r.dataset.problemId) === selectedProblemId) ? "2px solid #7aa2ff" : "none");
}

async function refreshAttempts() {
  const tbody = $("attemptsTable").querySelector("tbody"); tbody.innerHTML = "";
  selectedAttemptId = null; $("editNo").value = ""; $("editDate").value = ""; $("editTime").value = ""; $("editScore").value = ""; $("editAtt").value = "○";
  if (!selectedProblemId) return;
  const list = await listAttemptsByProblem(cdb, selectedProblemId);
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

async function initCalc() {
  cdb = await openCalcDb();
  const today = toYmdLocal(new Date());
  $("quickDate").value = today; $("formDate").value = today;

  if ("serviceWorker" in navigator) { navigator.serviceWorker.register("./sw.js").catch(()=>{}); }
  await refreshSeries();

  $("seriesSelect").onchange = async (e) => { currentSeriesId = Number(e.target.value); selectedProblemId = null; selectedAttemptId = null; await refreshAll(); };
  $("addSeriesBtn").onclick = async () => { const name = prompt("追加するシリーズ名（例：1-1 / 第2回）を入力"); if (!name) return; try { await addSeries(cdb, name); await refreshSeries(); } catch(e){ alert(e.message); } };
  $("seriesUpBtn").onclick = async () => { if (!currentSeriesId) return; await moveSeries(cdb, Number(currentSeriesId), -1); await refreshSeries(Number(currentSeriesId)); };
  $("seriesDownBtn").onclick = async () => { if (!currentSeriesId) return; await moveSeries(cdb, Number(currentSeriesId), +1); await refreshSeries(Number(currentSeriesId)); };

  $("recordQuickBtn").onclick = async () => {
    const entries = parseQuick($("quickInput").value);
    const doneDate = $("quickDate").value;
    const minutes = $("quickTime").value ? Number($("quickTime").value) : null;
    const score = $("quickScore").value ? Number($("quickScore").value) : null;
    const att = $("quickAtt").value;
    if (!doneDate) return alert("学習日を入れてください");

    for (const it of entries) {
      if (it.error) { toast(`形式エラー: ${it.error}`); continue; }
      const sList = await listSeries(cdb); let s = sList.find(x => x.name === it.series);
      if (!s) { await addSeries(cdb, it.series); s = (await listSeries(cdb)).find(x => x.name === it.series); }
      const problemId = await getOrCreateProblem(cdb, s.id, it.kind, it.number);
      const nextNo = await getNextAttemptNo(cdb, problemId);
      try { await insertAttempt(cdb, problemId, nextNo, doneDate, minutes, score, att); } catch (e) { /* 同日 or 同回数重複 */ }
    }
    $("quickInput").value = ""; $("quickTime").value = ""; $("quickScore").value = "";
    toast("記録しました"); await refreshAll();
  };

  $("addOrRecordBtn").onclick = async () => {
    const seriesName = $("formSeries").value.trim();
    const kind = $("formKind").value;
    const number = $("formNumber").value ? Number($("formNumber").value) : null;
    const doneDate = $("formDate").value;
    const minutes = $("formTime").value ? Number($("formTime").value) : null;
    const score = $("formScore").value ? Number($("formScore").value) : null;
    const att = $("formAtt").value;
    if (!seriesName) return alert("シリーズを入れてください");
    if (!doneDate) return alert("学習日を入れてください");
    if (kind !== "答練" && (!Number.isInteger(number) || number <= 0)) return alert("問題番号は1以上の整数です");

    const sList = await listSeries(cdb); let s = sList.find(x => x.name === seriesName);
    if (!s) { await addSeries(cdb, seriesName); s = (await listSeries(cdb)).find(x => x.name === seriesName); }
    const problemId = await getOrCreateProblem(cdb, s.id, kind, number);
    const nextNo = await getNextAttemptNo(cdb, problemId);
    try { await insertAttempt(cdb, problemId, nextNo, doneDate, minutes, score, att); }
    catch (e) { return alert("同じ学習日/回数が既にあるようです"); }
    selectedProblemId = problemId; toast(`追加/記録: ${seriesName} ${kind}${number??""} ${doneDate} ${nextNo}回目`); await refreshAll();
  };

  $("deleteProblemBtn").onclick = async () => {
    if (!selectedProblemId) return alert("削除する問題をマトリクスから選んでください");
    if (!confirm("この問題を削除（履歴も全て削除）してよいですか？")) return;
    await deleteProblem(cdb, selectedProblemId);
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
    const list = await listAttemptsByProblem(cdb, selectedProblemId);
    if (list.some(a => a.id !== selectedAttemptId && a.attemptNo === newNo)) return alert(`回数 ${newNo} は既にあります`);
    if (list.some(a => a.id !== selectedAttemptId && a.doneDate === newDate)) return alert(`学習日 ${newDate} は既にあります`);
    try { await updateAttempt(cdb, selectedAttemptId, { attemptNo: newNo, doneDate: newDate, minutes: newMin, score: newScore, att: newAtt }); }
    catch (e) { return alert("一意制約に抵触しました（回数 or 日付の重複）"); }
    toast("編集しました"); await refreshAll();
  };

  $("deleteAttemptBtn").onclick = async () => {
    if (!selectedAttemptId) return alert("削除する履歴を選んでください");
    if (!confirm("この学習履歴を削除してもよいですか？")) return;
    await deleteAttempt(cdb, selectedAttemptId);
    selectedAttemptId = null; toast("削除しました"); await refreshAll();
  };

  $("renumberBtn").onclick = async () => {
    if (!selectedProblemId) return alert("再採番する問題を選んでください");
    if (!confirm("この問題の履歴を日付順に1..nへ再採番します。よろしいですか？")) return;
    await renumberAttempts(cdb, selectedProblemId); toast("再採番しました"); await refreshAll();
  };

  $("exportBtn").onclick = async () => {
    const data = await exportCalcJson(cdb);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `calc-sync-${toYmdLocal(new Date())}.json`; a.click(); URL.revokeObjectURL(url);
  };
  $("importFile").onchange = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      if (!confirm("インポートします。この端末のデータは上書きされます。よろしいですか？")) return;
      await importCalcJsonOverwrite(cdb, data);
      toast("インポート完了"); selectedProblemId = null; selectedAttemptId = null; await refreshSeries();
    } catch (err) { alert("インポート失敗: " + err.message); }
    finally { e.target.value = ""; }
  };
  $("wipeBtn").onclick = async () => {
    if (!confirm("この端末のデータを全消去します。よろしいですか？")) return;
    const t = cdb.transaction(["attempts","problems","series"], "readwrite");
    t.objectStore("attempts").clear(); t.objectStore("problems").clear(); t.objectStore("series").clear();
    await new Promise((res,rej)=>{ t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); });
    selectedProblemId = null; selectedAttemptId = null; await refreshSeries(); toast("全消去しました");
