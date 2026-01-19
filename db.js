
// ====== 計算進捗ツール IndexedDB（subjects → series → problems → attempts） ======
const CALC_DB_NAME = "calc_progress_db";
const CALC_DB_VERSION = 2; // ★ v1→v2 で subjects を導入＆マイグレーション

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

function openCalcDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CALC_DB_NAME, CALC_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldV = e.oldVersion || 0;

      // v1 には subjects が無かった
      // ---- subjects ----
      if (!db.objectStoreNames.contains("subjects")) {
        const subjects = db.createObjectStore("subjects", { keyPath: "id", autoIncrement: true });
        subjects.createIndex("by_sort", "sortOrder");
        subjects.createIndex("by_name", "name", { unique: true });
      }

      // ---- series ----
      if (!db.objectStoreNames.contains("series")) {
        const series = db.createObjectStore("series", { keyPath: "id", autoIncrement: true });
        series.createIndex("by_subject", "subjectId");
        series.createIndex("by_subject_name", ["subjectId", "name"], { unique: true });
        series.createIndex("by_sort_in_subject", ["subjectId","sortOrder"]);
      } else {
        const series = e.currentTarget.transaction.objectStore("series");
        // 新インデックス（存在しない場合のみ）
        if (!series.indexNames.contains("by_subject")) series.createIndex("by_subject", "subjectId");
        if (!series.indexNames.contains("by_subject_name")) series.createIndex("by_subject_name", ["subjectId","name"], { unique: true });
        if (!series.indexNames.contains("by_sort_in_subject")) series.createIndex("by_sort_in_subject", ["subjectId","sortOrder"]);
      }

      // ---- problems ----
      if (!db.objectStoreNames.contains("problems")) {
        const problems = db.createObjectStore("problems", { keyPath: "id", autoIncrement: true });
        problems.createIndex("by_series", "seriesId");
        problems.createIndex("by_series_kind_no", ["seriesId", "kind", "number"], { unique: true });
      }

      // ---- attempts ----
      if (!db.objectStoreNames.contains("attempts")) {
        const attempts = db.createObjectStore("attempts", { keyPath: "id", autoIncrement: true });
        attempts.createIndex("by_problem", "problemId");
        attempts.createIndex("by_problem_no", ["problemId", "attemptNo"], { unique: true });
        attempts.createIndex("by_problem_date", ["problemId", "doneDate"], { unique: true });
        attempts.createIndex("by_date", "doneDate");
      }

      // --- v1→v2 マイグレーション：series に subjectId を付与し、"共通" 科目を作る ---
      if (oldV < 2) {
        const subjects = e.currentTarget.transaction.objectStore("subjects");
        // id=1 で「共通」を作成（明示 id 指定）
        subjects.put({ id: 1, name: "共通", sortOrder: 0, createdAt: new Date().toISOString() });

        const seriesStore = e.currentTarget.transaction.objectStore("series");
        // series の全件を読み、subjectId が無ければ 1 を付与
        const getAllReq = seriesStore.getAll();
        getAllReq.onsuccess = () => {
          const list = getAllReq.result || [];
          list.forEach(s => {
            if (s.subjectId == null) { s.subjectId = 1; }
            if (s.sortOrder == null) { s.sortOrder = 0; }
            seriesStore.put(s);
          });
        };
      }
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

/* ---------- Series（科目配下） ---------- */
async function listSeriesBySubject(db, subjectId) {
  return new Promise((resolve, reject) => {
    const { stores } = tx(db, ["series"]);
    const idx = stores.series.index("by_subject");
    const req = idx.getAll(IDBKeyRange.only(subjectId));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const list = req.result ?? [];
      list.sort((a,b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, "ja"));
      resolve(list);
    };
  });
}
async function addSeries(db, subjectId, name) {
  name = name.trim();
  if (!name) throw new Error("シリーズ名が空です");
  const list = await listSeriesBySubject(db, subjectId);
  const sortOrder = list.length ? Math.max(...list.map(s => s.sortOrder ?? 0)) + 1 : 0;
  const { t, stores } = tx(db, ["series"], "readwrite");
  stores.series.add({ subjectId, name, sortOrder, createdAt: new Date().toISOString() });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function moveSeries(db, subjectId, seriesId, direction) {
  const list = await listSeriesBySubject(db, subjectId);
  const idx = list.findIndex(s => s.id === seriesId);
  if (idx < 0) return;
  const j = idx + direction;
  if (j < 0 || j >= list.length) return;
  [list[idx], list[j]] = [list[j], list[idx]];
  const { t, stores } = tx(db, ["series"], "readwrite");
  list.forEach((s,i) => { s.sortOrder = i; stores.series.put(s); });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function getOrCreateSeries(db, subjectId, name) {
  return new Promise((resolve, reject) => {
    const { stores } = tx(db, ["series"], "readwrite");
    const idx = stores.series.index("by_subject_name");
    const g = idx.get([subjectId, name]);
    g.onerror = () => reject(g.error);
    g.onsuccess = () => {
      const found = g.result;
      if (found) return resolve(found.id);
      // 新規追加（末尾）
      const addReq = stores.series.add({ subjectId, name, sortOrder: 999999, createdAt: new Date().toISOString() });
      addReq.onerror = () => reject(addReq.error);
      addReq.onsuccess = () => resolve(addReq.result);
    };
  });
}

/* ---------- Problems ---------- */
async function getOrCreateProblem(db, seriesId, kind, number /* number|null */) {
  const { t, stores } = tx(db, ["problems"], "readwrite");
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
  });
}
async function listProblemsBySeries(db, seriesId) {
  return new Promise((resolve, reject) => {
    const { stores } = tx(db, ["problems"]);
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
    minutes: minutes ?? null,
    score: score ?? null,
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
async function exportCalcJson(db) {
  const subjects = await getAll(db, "subjects");
  const series = await getAll(db, "series");
  const problems = await getAll(db, "problems");
  const attempts = await getAll(db, "attempts");
  return { schemaVersion: 2, exportedAt: new Date().toISOString(), subjects, series, problems, attempts };
}
async function importCalcJsonOverwrite(db, data) {
  // v1 互換：subjectsが無ければ作って割り当て
  if (!data || !data.problems || !data.attempts || !data.series) {
    throw new Error("不正なJSON（series/problems/attempts は必須）");
  }
  const { t, stores } = tx(db, ["attempts","problems","series","subjects"], "readwrite");
  stores.attempts.clear(); stores.problems.clear(); stores.series.clear(); stores.subjects.clear();

  let subjectIdMap = new Map();
  if (data.subjects && data.subjects.length) {
    data.subjects.forEach(s => stores.subjects.put(s));
    subjectIdMap = new Map(data.subjects.map(s => [s.id, s.id]));
  } else {
    // v1 → デフォルト科目「共通」を生成
    stores.subjects.put({ id: 1, name: "共通", sortOrder: 0, createdAt: new Date().toISOString() });
  }

  // series の subjectId が欠落していれば 1 を付与
  data.series.forEach(s => { if (s.subjectId == null) s.subjectId = 1; stores.series.put(s); });
  data.problems.forEach(p => stores.problems.put(p));
  data.attempts.forEach(a => stores.attempts.put(a));

  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
