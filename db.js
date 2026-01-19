
// ==== IndexedDB 層 ====
const DB_NAME = "study_pwa_db";
const DB_VERSION = 2; // 既存からの置換でも問題なし（必要に応じてインクリメント）

// ローカル YYYY-MM-DD
function toYmdLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
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
      if (!db.objectStoreNames.contains("subjects")) {
        const subjects = db.createObjectStore("subjects", { keyPath: "id", autoIncrement: true });
        subjects.createIndex("by_sort", "sortOrder");
        subjects.createIndex("by_name", "name", { unique: true });
      }

      // units
      if (!db.objectStoreNames.contains("units")) {
        const units = db.createObjectStore("units", { keyPath: "id", autoIncrement: true });
        units.createIndex("by_subject", "subjectId");
        units.createIndex("by_subject_code", ["subjectId", "unitCode"], { unique: true });
      }

      // reviews
      if (!db.objectStoreNames.contains("reviews")) {
        const reviews = db.createObjectStore("reviews", { keyPath: "id", autoIncrement: true });
        reviews.createIndex("by_unit", "unitId");
        reviews.createIndex("by_unit_no", ["unitId", "reviewNo"], { unique: true });
        reviews.createIndex("by_unit_date", ["unitId", "doneDate"], { unique: true });
        reviews.createIndex("by_date", "doneDate");
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function tx(db, storeNames, mode="readonly") {
  const t = db.transaction(storeNames, mode);
  return { t, stores: storeNames.reduce((acc, n)=>(acc[n]=t.objectStore(n), acc), {}) };
}
async function getAll(db, store) {
  return new Promise((resolve, reject) => {
    const { stores } = tx(db, [store]);
    const req = stores[store].getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result ?? []);
  });
}

async function clearAll(db) {
  const { t, stores } = tx(db, ["reviews", "units", "subjects"], "readwrite");
  stores.reviews.clear();
  stores.units.clear();
  stores.subjects.clear();
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// 既定の教科セット（最初に空なら自動投入）
async function seedDefaultSubjects(db) {
  const existing = await getAll(db, "subjects");
  if (existing.length) return;
  const defaults = ["消費税法", "所得税法", "法人税法", "住民税", "国税徴収法"];
  const { t, stores } = tx(db, ["subjects"], "readwrite");
  defaults.forEach((name, i) => stores.subjects.add({ name, sortOrder: i, createdAt: new Date().toISOString() }));
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function listSubjects(db) {
  const subs = await getAll(db, "subjects");
  subs.sort((a,b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, "ja"));
  return subs;
}
async function addSubject(db, name) {
  name = name.trim();
  if (!name) throw new Error("教科名が空です");
  const subs = await listSubjects(db);
  const sortOrder = subs.length ? Math.max(...subs.map(s => s.sortOrder ?? 0)) + 1 : 0;
  const { t, stores } = tx(db, ["subjects"], "readwrite");
  stores.subjects.add({ name, sortOrder, createdAt: new Date().toISOString() });
  return new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function moveSubject(db, subjectId, direction) {
  const subs = await listSubjects(db);
  const idx = subs.findIndex(s => s.id === subjectId);
  if (idx < 0) return;
  const j = idx + direction;
  if (j < 0 || j >= subs.length) return;
  [subs[idx], subs[j]] = [subs[j], subs[idx]];
  const { t, stores } = tx(db, ["subjects"], "readwrite");
  subs.forEach((s, i) => { s.sortOrder = i; stores.subjects.put(s); });
  return new Promise((resolve, reject)=>{ t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}

async function getOrCreateUnit(db, subjectId, unitCode) {
  unitCode = unitCode.trim();
  const { t, stores } = tx(db, ["units"], "readwrite");
  const idx = stores.units.index("by_subject_code");
  const req = idx.get([subjectId, unitCode]);
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const found = req.result;
      if (found) return resolve(found.id);
      const addReq = stores.units.add({ subjectId, unitCode, title: "", createdAt: new Date().toISOString() });
      addReq.onerror = () => reject(addReq.error);
      addReq.onsuccess = () => resolve(addReq.result);
    };
    t.onerror = () => reject(t.error);
  });
}
async function updateUnitTitle(db, unitId, title) {
  const { t, stores } = tx(db, ["units"], "readwrite");
  const req = stores.units.get(unitId);
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const u = req.result;
      if (!u) return resolve();
      u.title = title;
      stores.units.put(u);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
async function deleteUnit(db, unitId) {
  // cascade delete（手動）
  const { t, stores } = tx(db, ["reviews", "units"], "readwrite");
  const rIndex = stores.reviews.index("by_unit");
  const rReq = rIndex.getAll(IDBKeyRange.only(unitId));
  return new Promise((resolve, reject) => {
    rReq.onerror = () => reject(rReq.error);
    rReq.onsuccess = () => {
      (rReq.result ?? []).forEach(r => stores.reviews.delete(r.id));
      stores.units.delete(unitId);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
async function listUnitsBySubject(db, subjectId) {
  // インデックスを使用（高速）
  return new Promise((resolve, reject) => {
    const { stores } = tx(db, ["units"]);
    const idx = stores.units.index("by_subject");
    const req = idx.getAll(IDBKeyRange.only(subjectId));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const all = req.result ?? [];
      all.sort((a,b) => a.unitCode.localeCompare(b.unitCode, "ja"));
      resolve(all);
    };
  });
}

async function listReviewsByUnit(db, unitId) {
  // インデックスを使用（高速）
  return new Promise((resolve, reject) => {
    const { stores } = tx(db, ["reviews"]);
    const idx = stores.reviews.index("by_unit");
    const req = idx.getAll(IDBKeyRange.only(unitId));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const all = req.result ?? [];
      all.sort((a,b) =>
        (a.reviewNo - b.reviewNo) ||
        a.doneDate.localeCompare(b.doneDate) ||
        (a.id - b.id)
      );
      resolve(all);
    };
  });
}
async function getNextReviewNo(db, unitId) {
  const revs = await listReviewsByUnit(db, unitId);
  if (!revs.length) return 1;
  return Math.max(...revs.map(r => r.reviewNo)) + 1;
}
async function insertReview(db, unitId, reviewNo, doneDate) {
  const { t, stores } = tx(db, ["reviews"], "readwrite");
  stores.reviews.add({ unitId, reviewNo, doneDate, createdAt: new Date().toISOString() });
  return new Promise((resolve, reject)=>{ t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function deleteReview(db, reviewId) {
  const { t, stores } = tx(db, ["reviews"], "readwrite");
  stores.reviews.delete(reviewId);
  return new Promise((resolve, reject)=>{ t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
async function updateReview(db, reviewId, unitId, newReviewNo, newDoneDate) {
  const { t, stores } = tx(db, ["reviews"], "readwrite");
  const req = stores.reviews.get(reviewId);
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const r = req.result;
      if (!r) return resolve();
      r.reviewNo = newReviewNo;
      r.doneDate = newDoneDate;
      r.createdAt = new Date().toISOString();
      stores.reviews.put(r);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
async function renumberReviews(db, unitId) {
  const revs = await listReviewsByUnit(db, unitId);
  const sorted = [...revs].sort((a,b) => a.doneDate.localeCompare(b.doneDate) || (a.id - b.id));
  const { t, stores } = tx(db, ["reviews"], "readwrite");
  sorted.forEach((r, i) => { r.reviewNo = i+1; stores.reviews.put(r); });
  return new Promise((resolve, reject)=>{ t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}

// 復習間隔：1回目→+1日 / 2回目→+7日 / 3回目→+14日 / 4回目以降→+20日
function intervalDays(lastReviewNo) {
  if (lastReviewNo === 1) return 1;
  if (lastReviewNo === 2) return 7;
  if (lastReviewNo === 3) return 14;
  return 20;
}

async function computeUnitStatus(db, unit) {
  const revs = await listReviewsByUnit(db, unit.id);
  if (!revs.length) { return { lastNo: 0, lastDate: "", nextDue: "" }; }
  const lastNo = Math.max(...revs.map(r => r.reviewNo));
  // 同回数の中で最新 id を採用
  const candidates = revs.filter(r => r.reviewNo === lastNo).sort((a,b)=> b.id - a.id);
  const lastDate = candidates[0].doneDate;
  const next = addDaysLocal(lastDate, intervalDays(lastNo));
  return { lastNo, lastDate, nextDue: next };
}

// Export / Import
async function exportJson(db) {
  const subjects = await getAll(db, "subjects");
  const units = await getAll(db, "units");
  const reviews = await getAll(db, "reviews");
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), subjects, units, reviews };
}
async function importJsonOverwrite(db, data) {
  if (!data || !data.subjects || !data.units || !data.reviews) {
    throw new Error("不正なJSON形式です（subjects/units/reviews が必須）");
  }
  await clearAll(db);
  const { t, stores } = tx(db, ["subjects","units","reviews"], "readwrite");
  data.subjects.forEach(s => stores.subjects.put(s));
  data.units.forEach(u => stores.units.put(u));
  data.reviews.forEach(r => stores.reviews.put(r));
  return new Promise((resolve, reject)=>{ t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
}
