
// ====== 計算進捗ツール（フラット） IndexedDB ======
const DB_NAME = "calc_progress_flat_db";
const DB_VERSION = 1;

/* --- Local YYYY-MM-DD --- */
function toYmdLocal(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function addDaysLocal(ymd, n) {
  const [y,m,d] = ymd.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  dt.setDate(dt.getDate() + n);
  return toYmdLocal(dt);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // subjects
      const subjects = db.createObjectStore("subjects", { keyPath: "id", autoIncrement: true });
      subjects.createIndex("by_sort", "sortOrder");
      subjects.createIndex("by_name", "name", { unique: true });

      // problems（フラット）
      // kind: "問題" | "確認テスト" | "答練"
      // unitCode: string|null（問題のみ "1-1" 等）
      // number: 整数（問題番号 or 第N回のN）
      const problems = db.createObjectStore("problems", { keyPath: "id", autoIncrement: true });
      problems.createIndex("by_subject", "subjectId");
      problems.createIndex("by_subject_kind_unit_no", ["subjectId","kind","unitCode","number"], { unique: true });

      // attempts
      const attempts = db.createObjectStore("attempts", { keyPath: "id", autoIncrement: true });
      attempts.createIndex("by_problem", "problemId");
      attempts.createIndex("by_problem_no", ["problemId","attemptNo"], { unique: true });
      attempts.createIndex("by_problem_date", ["problemId","doneDate"], { unique: true });
      attempts.createIndex("by_date", "doneDate");
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function tx(db, storeNames, mode = "readonly") {
  const t = db.transaction(storeNames, mode);
  return { t, stores: storeNames.reduce((acc, n) => (acc[n] = t.objectStore(n), acc), {}) };
}
async function getAll(db, store) {
  return new Promise((resolve, reject) => {
    const { stores } = tx(db, [store]);
    const req = stores[store].getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result ?? []);
  });
}

/* ---------- Subjects（教科） ---------- */
async function seedDefaultSubjects(db) {
  const existing = await getAll(db, "subjects");
  if (existing.length) return;
  const defaults = ["消費税法", "所得税法", "法人税法", "住民税", "国税徴収法"];
  const { t, stores } = tx(db, ["subjects"], "readwrite");
  defaults.forEach((name, i) => stores.subjects.add({ name, sortOrder: i, createdAt: new Date().toISOString() }));
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function listSubjects(db) {
  const subs = await getAll(db, "subjects");
  subs.sort((a,b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, "ja"));
  return subs;
}
async function addSubject(db, name) {
  name = name.trim();
  if (!name) throw new Error("教科名が空です");
  const current = await listSubjects(db);
  const sortOrder = current.length ? Math.max(...current.map(s => s.sortOrder ?? 0)) + 1 : 0;
  const { t, stores } = tx(db, ["subjects"], "readwrite");
  stores.subjects.add({ name, sortOrder, createdAt: new Date().toISOString() });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function moveSubject(db, subjectId, direction) {
  const all = await listSubjects(db);
  const idx = all.findIndex(s => s.id === subjectId);
  if (idx < 0) return;
  const j = idx + direction;
  if (j < 0 || j >= all.length) return;
  [all[idx], all[j]] = [all[j], all[idx]];
  const { t, stores } = tx(db, ["subjects"], "readwrite");
  all.forEach((s,i) => { s.sortOrder = i; stores.subjects.put(s); });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}

/* ---------- Problems（フラット） ---------- */
async function getOrCreateProblem(db, subjectId, kind, unitCode /*nullable*/, number) {
  const { t, stores } = tx(db, ["problems"], "readwrite");
  const idx = stores.problems.index("by_subject_kind_unit_no");
  const req = idx.get([subjectId, kind, unitCode ?? null, number]);
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const found = req.result;
      if (found) return resolve(found.id);
      const addReq = stores.problems.add({ subjectId, kind, unitCode: unitCode ?? null, number, createdAt: new Date().toISOString() });
      addReq.onerror = () => reject(addReq.error);
      addReq.onsuccess = () => resolve(addReq.result);
    };
  });
}
async function listProblemsBySubject(db, subjectId) {
  return new Promise((resolve, reject) => {
    const { stores } = tx(db, ["problems"]);
    const idx = stores.problems.index("by_subject");
    const req = idx.getAll(IDBKeyRange.only(subjectId));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const all = req.result ?? [];
      all.sort(problemComparator);
      resolve(all);
    };
  });
}
function problemComparator(a, b) {
  // 並び順：①問題（unitCode昇順→number昇順）→②確認テスト（number昇順）→③答練（number昇順）
  const rank = (p) => (p.kind === "問題" ? 0 : p.kind === "確認テスト" ? 1 : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (a.kind === "問題" && b.kind === "問題") {
    const uc = (a.unitCode ?? "").localeCompare(b.unitCode ?? "", "ja");
    if (uc !== 0) return uc;
    return (a.number ?? 0) - (b.number ?? 0);
  }
  return (a.number ?? 0) - (b.number ?? 0);
}
async function deleteProblem(db, problemId) {
  const { t, stores } = tx(db, ["attempts","problems"], "readwrite");
  const idx = stores.attempts.index("by_problem");
  const r = idx.getAll(IDBKeyRange.only(problemId));
  return new Promise((resolve, reject) => {
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      (r.result ?? []).forEach(a => stores.attempts.delete(a.id));
      stores.problems.delete(problemId);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* ---------- Attempts ---------- */
async function listAttemptsByProblem(db, problemId) {
  return new Promise((resolve, reject) => {
    const { stores } = tx(db, ["attempts"]);
    const idx = stores.attempts.index("by_problem");
    const req = idx.getAll(IDBKeyRange.only(problemId));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const all = req.result ?? [];
      all.sort((a,b) =>
        (a.attemptNo - b.attemptNo) ||
        a.doneDate.localeCompare(b.doneDate) ||
        (a.id - b.id)
      );
      resolve(all);
    };
  });
}
async function getNextAttemptNo(db, problemId) {
  const all = await listAttemptsByProblem(db, problemId);
  if (!all.length) return 1;
  return Math.max(...all.map(a => a.attemptNo)) + 1;
}
async function insertAttempt(db, problemId, attemptNo, doneDate, minutes, score, att) {
  const { t, stores } = tx(db, ["attempts"], "readwrite");
  stores.attempts.add({
    problemId, attemptNo, doneDate,
    minutes: (minutes ?? null),
    score: (score ?? null),
    att, createdAt: new Date().toISOString()
  });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function updateAttempt(db, attemptId, patch) {
  const { t, stores } = tx(db, ["attempts"], "readwrite");
  const req = stores.attempts.get(attemptId);
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      Object.assign(cur, patch, { createdAt: new Date().toISOString() });
      stores.attempts.put(cur);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
async function deleteAttempt(db, attemptId) {
  const { t, stores } = tx(db, ["attempts"], "readwrite");
  stores.attempts.delete(attemptId);
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function renumberAttempts(db, problemId) {
  const all = await listAttemptsByProblem(db, problemId);
  const sorted = [...all].sort((a,b) => a.doneDate.localeCompare(b.doneDate) || (a.id - b.id));
  const { t, stores } = tx(db, ["attempts"], "readwrite");
  sorted.forEach((a,i) => { a.attemptNo = i + 1; stores.attempts.put(a); });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}

/* ---------- Status / Due ---------- */
function intervalDaysByAtt(att) {
  if (att === "×") return 7;
  if (att === "△") return 14;
  return 0; // ○ は復習不要
}
async function computeProblemStatus(db, problem) {
  const atts = await listAttemptsByProblem(db, problem.id);
  if (!atts.length) return { lastNo: 0, lastDate: "", nextDue: "", hide: true };
  const lastNo = Math.max(...atts.map(a => a.attemptNo));
  const candidates = atts.filter(a => a.attemptNo === lastNo).sort((a,b)=> b.id - a.id);
  const last = candidates[0];
  const d = intervalDaysByAtt(last.att);
  if (d === 0) return { lastNo, lastDate: last.doneDate, nextDue: "", hide: true };
  const nextDue = addDaysLocal(last.doneDate, d);
  return { lastNo, lastDate: last.doneDate, nextDue, hide: false, lastAtt: last.att };
}

/* ---------- Export / Import / Clear ---------- */
async function exportJson(db) {
  const subjects = await getAll(db, "subjects");
  const problems = await getAll(db, "problems");
  const attempts = await getAll(db, "attempts");
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), subjects, problems, attempts };
}
async function importJsonOverwrite(db, data) {
  if (!data || !data.subjects || !data.problems || !data.attempts) {
    throw new Error("不正なJSON（subjects/problems/attempts が必須）");
  }
  const { t, stores } = tx(db, ["attempts","problems","subjects"], "readwrite");
  stores.attempts.clear(); stores.problems.clear(); stores.subjects.clear();
  data.subjects.forEach(s => stores.subjects.put(s));
  data.problems.forEach(p => stores.problems.put(p));
  data.attempts.forEach(a => stores.attempts.put(a));
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
``
