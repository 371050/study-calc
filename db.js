
const CALC_DB_NAME = "calc_progress_db";
const CALC_DB_VERSION = 1;

function openCalcDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CALC_DB_NAME, CALC_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const series = db.createObjectStore("series", { keyPath: "id", autoIncrement: true });
      series.createIndex("by_sort", "sortOrder");
      series.createIndex("by_name", "name", { unique: true });

      const problems = db.createObjectStore("problems", { keyPath: "id", autoIncrement: true });
      problems.createIndex("by_series", "seriesId");
      problems.createIndex("by_series_kind_no", ["seriesId", "kind", "number"], { unique: true });

      const attempts = db.createObjectStore("attempts", { keyPath: "id", autoIncrement: true });
      attempts.createIndex("by_problem", "problemId");
      attempts.createIndex("by_problem_no", ["problemId", "attemptNo"], { unique: true });
      attempts.createIndex("by_problem_date", ["problemId", "doneDate"], { unique: true });
      attempts.createIndex("by_date", "doneDate");
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function tx2(db, storeNames, mode = "readonly") {
  const t = db.transaction(storeNames, mode);
  return { t, stores: storeNames.reduce((acc, n) => (acc[n] = t.objectStore(n), acc), {}) };
}
async function getAll2(db, store) {
  return new Promise((resolve, reject) => {
    const { stores } = tx2(db, [store]);
    const req = stores[store].getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result ?? []);
  });
}

/* Series */
async function listSeries(db) {
  const all = await getAll2(db, "series");
  all.sort((a,b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  return all;
}
async function addSeries(db, name) {
  name = name.trim();
  if (!name) throw new Error("シリーズ名が空です");
  const current = await listSeries(db);
  const sortOrder = current.length ? Math.max(...current.map(s => s.sortOrder ?? 0)) + 1 : 0;
  const { t, stores } = tx2(db, ["series"], "readwrite");
  stores.series.add({ name, sortOrder, createdAt: new Date().toISOString() });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function moveSeries(db, seriesId, direction) {
  const all = await listSeries(db);
  const idx = all.findIndex(s => s.id === seriesId);
  if (idx < 0) return;
  const j = idx + direction;
  if (j < 0 || j >= all.length) return;
  [all[idx], all[j]] = [all[j], all[idx]];
  const { t, stores } = tx2(db, ["series"], "readwrite");
  all.forEach((s,i) => { s.sortOrder = i; stores.series.put(s); });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}

/* Problems */
async function getOrCreateProblem(db, seriesId, kind, number) {
  const { t, stores } = tx2(db, ["problems"], "readwrite");
  const idx = stores.problems.index("by_series_kind_no");
  const req = idx.get([seriesId, kind, number ?? null]);
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const found = req.result;
      if (found) return resolve(found.id);
      const addReq = stores.problems.add({ seriesId, kind, number: number ?? null, createdAt: new Date().toISOString() });
      addReq.onerror = () => reject(addReq.error);
      addReq.onsuccess = () => resolve(addReq.result);
    };
    t.onerror = () => reject(t.error);
  });
}
async function listProblemsBySeries(db, seriesId) {
  return new Promise((resolve, reject) => {
    const { stores } = tx2(db, ["problems"]);
    const idx = stores.problems.index("by_series");
    const req = idx.getAll(IDBKeyRange.only(seriesId));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const all = req.result ?? [];
      all.sort((a,b) =>
        a.kind.localeCompare(b.kind, "ja") ||
        ((a.number ?? 0) - (b.number ?? 0)) ||
        (a.id - b.id)
      );
      resolve(all);
    };
  });
}
async function deleteProblem(db, problemId) {
  const { t, stores } = tx2(db, ["attempts","problems"], "readwrite");
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

/* Attempts */
async function listAttemptsByProblem(db, problemId) {
  return new Promise((resolve, reject) => {
    const { stores } = tx2(db, ["attempts"]);
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
  const { t, stores } = tx2(db, ["attempts"], "readwrite");
  stores.attempts.add({
    problemId, attemptNo, doneDate,
    minutes: minutes ?? null,
    score: score ?? null,
    att, createdAt: new Date().toISOString()
  });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function updateAttempt(db, attemptId, patch) {
  const { t, stores } = tx2(db, ["attempts"], "readwrite");
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
  const { t, stores } = tx2(db, ["attempts"], "readwrite");
  stores.attempts.delete(attemptId);
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function renumberAttempts(db, problemId) {
  const all = await listAttemptsByProblem(db, problemId);
  const sorted = [...all].sort((a,b) => a.doneDate.localeCompare(b.doneDate) || (a.id - b.id));
  const { t, stores } = tx2(db, ["attempts"], "readwrite");
  sorted.forEach((a,i) => { a.attemptNo = i + 1; stores.attempts.put(a); });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}

/* Status / Due */
function intervalDaysByAtt(att) {
  if (att === "×") return 7;
  if (att === "△") return 14;
  return 0; // ○は復習不要
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

/* Export / Import */
async function exportCalcJson(db) {
  const series = await getAll2(db, "series");
  const problems = await getAll2(db, "problems");
  const attempts = await getAll2(db, "attempts");
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), series, problems, attempts };
}
async function importCalcJsonOverwrite(db, data) {
  if (!data || !data.series || !data.problems || !data.attempts) throw new Error("不正なJSON（series/problems/attempts が必須）");
  const { t, stores } = tx2(db, ["attempts","problems","series"], "readwrite");
  stores.attempts.clear(); stores.problems.clear(); stores.series.clear();
  data.series.forEach(s => stores.series.put(s));
  data.problems.forEach(p => stores.problems.put(p));
  data.attempts.forEach(a => stores.attempts.put(a));
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}

/* Local YYYY-MM-DD */
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
