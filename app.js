/* =====================================================================
 * Nemotron-Personas USA 다단계 추출기 — rebuilt safe-resume version
 * - USA 전용: nvidia/Nemotron-Personas-USA
 * - 1차: 정확 조건만 서버 /filter 또는 /rows로 5단계 누적 수집
 * - 2차: 누적된 1차 후보군 내부에서 키워드 정밀 필터
 * - HTTP 422 발생 시 /rows 안전 스캔 모드로 자동 전환
 * ===================================================================== */
"use strict";

const API = "https://datasets-server.huggingface.co";
const DATASET = "nvidia/Nemotron-Personas-USA";
const STAGE_SIZE = 5000;
const MAX_STAGES = 5;
const HARD_CAP = STAGE_SIZE * MAX_STAGES;
const PAGE = 100;
const MAX_SAFE_SCAN_PER_STAGE = 350000;
const WHERE_MAX_LEN = 1800;
const ANY_LABEL = "상관 없음";

const LABELS = {
  uuid: "고유ID", id: "ID", person_id: "인물 ID",
  sex: "성별", gender: "성별", age: "나이",
  marital_status: "혼인상태", relationship_status: "관계상태",
  education_level: "학력", education: "학력", highest_education: "최종학력",
  bachelors_field: "전공계열", field_of_study: "전공", major: "전공",
  occupation: "직업", job: "직업", employment_status: "고용상태", industry: "산업",
  household_income: "가구소득", income: "소득", income_level: "소득수준",
  family_type: "가족형태", household_type: "가구형태", housing_type: "주거형태",
  country: "국가", region: "지역", state: "주", city: "도시", zipcode: "우편번호", postal_code: "우편번호",
  county: "카운티", metro_area: "대도시권",
  persona: "페르소나 요약", professional_persona: "직업 페르소나", sports_persona: "스포츠 페르소나",
  arts_persona: "예술 페르소나", travel_persona: "여행 페르소나", culinary_persona: "요리 페르소나",
  family_persona: "가족 페르소나", cultural_background: "문화적 배경",
  skills_and_expertise: "기술 및 전문성", hobbies_and_interests: "취미 및 관심사",
  career_goals_and_ambitions: "경력 목표"
};

const FIELD_PRIORITY = [
  "sex", "gender", "age", "marital_status", "education_level", "bachelors_field",
  "occupation", "employment_status", "household_income", "income_level", "state", "city", "zipcode", "postal_code",
  "county", "region", "family_type", "household_type", "housing_type"
];

const EXPORT_ORDER = [
  "uuid", "id", "person_id", "sex", "gender", "age", "marital_status", "education_level", "bachelors_field",
  "occupation", "employment_status", "household_income", "income_level", "state", "city", "zipcode", "postal_code",
  "county", "region", "family_type", "household_type", "housing_type",
  "persona", "professional_persona", "sports_persona", "arts_persona", "travel_persona", "culinary_persona", "family_persona",
  "cultural_background", "skills_and_expertise", "hobbies_and_interests", "career_goals_and_ambitions"
];

const EXACT_TEXT_FIELD_RE = /^(city|zipcode|postal_code|county|occupation|job|industry)$/i;
const LOCATION_FIELD_RE = /(state|city|zipcode|postal|county|region|country|metro)/i;
const NUMERIC_FIELD_RE = /^(age|income|household_income)$/i;
const ID_FIELD_RE = /^(uuid|id|person_id)$/i;
const INTERNAL_FIELD_RE = /^(row_idx|__index_level_0__|index)$/i;
const PROSE_FIELD_RE = /(^persona$|_persona$|background|skills|hobbies|interests|goals|ambitions|traits|expertise|description|bio|narrative|summary)/i;
const TEXT_SEARCH_FIELD_RE = /(persona|background|skills|hobbies|interests|goals|ambitions|occupation|job|education|field|industry|state|city|county|zipcode|postal|family|housing|marital|sex)/i;

const state = {
  config: "default",
  split: "train",
  total: null,
  fields: [],
  filters: {},
  candidates: [],
  finalRows: [],
  stageInfo: Array.from({ length: MAX_STAGES }, (_, i) => ({ stage: i + 1, status: "대기", added: 0, completed: false })),
  nextOffset: 0,
  rawScanOffset: 0,
  fallbackUsed: false,
  activeController: null,
  cancelRequested: false,
  currentSignature: "",
  collecting: false,
  lastPreviewMode: "candidates"
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function humanize(col) {
  return String(col || "").replace(/_/g, " ").replace(/\b\w/g, m => m.toUpperCase());
}
function fieldLabel(col) { return LABELS[col] || humanize(col); }
function setBanner(message, type = "") {
  const node = $("#banner");
  node.textContent = message;
  node.className = "banner" + (type ? " " + type : "");
}
function setProgress(percent) {
  $("#collectProgressBar").style.width = Math.max(0, Math.min(100, percent || 0)) + "%";
}
function authHeaders() {
  return {};
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function checkCancel() {
  if (state.cancelRequested) throw new Error("수집이 취소되었습니다.");
}
function sqlStr(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
function q(col) {
  return '"' + String(col).replace(/"/g, '""') + '"';
}
function normText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[_\-/.,;:()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function uniqueRowKey(row) {
  return row.uuid || row.id || row.person_id || JSON.stringify(row).slice(0, 200);
}
function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}
function parseListInput(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const parts = raw.split(/[\n,;]+/).map(v => v.trim()).filter(Boolean);
  if (parts.length > 1) return [...new Set(parts)];
  return [...new Set(raw.split(/\s+/).map(v => v.trim()).filter(Boolean))];
}

function classifyHttp(status, body) {
  const b = String(body || "").toLowerCase();
  if (status === 422 || status === 400) return "invalid";
  if (status === 429 || status >= 500) return "retry";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "notfound";
  if (b.includes("loading") || b.includes("index") || b.includes("try again")) return "retry";
  return "fatal";
}
async function fetchJson(url, opts = {}) {
  const maxWaitMs = opts.maxWaitMs || 90000;
  const start = Date.now();
  let attempt = 0;
  while (true) {
    checkCancel();
    attempt++;
    let status = 0, body = "", netErr = null;
    try {
      const res = await fetch(url, { mode: "cors", headers: authHeaders(), signal: state.activeController?.signal });
      status = res.status;
      if (res.ok) return await res.json();
      body = await res.text().catch(() => "");
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("수집이 취소되었습니다.");
      netErr = err;
    }
    const kind = netErr ? "retry" : classifyHttp(status, body);
    if (kind === "invalid") {
      const e = new Error(`HTTP ${status} ${body.slice(0, 220)}`);
      e.status = status;
      e.body = body;
      throw e;
    }
    if (kind === "notfound") throw new Error("데이터셋을 찾을 수 없습니다. Dataset 이름을 확인하세요.");
    if (kind === "auth") throw new Error("접근 권한 또는 요청 제한 문제가 있습니다. 잠시 후 다시 시도해 주세요.");
    if (kind === "fatal") throw new Error(`HTTP ${status} ${body.slice(0, 220)}`);
    if (Date.now() - start > maxWaitMs) throw new Error(netErr ? `네트워크 오류: ${netErr.message}` : `HTTP ${status} ${body.slice(0, 220)}`);
    await sleep(Math.min(800 * attempt, 4000));
  }
}

async function resolveConfigSplit() {
  try {
    const url = `${API}/splits?dataset=${encodeURIComponent(DATASET)}`;
    const data = await fetchJson(url, { maxWaitMs: 30000 });
    const splits = data.splits || [];
    if (splits.length) {
      const best = splits.find(s => s.split === "train") || splits[0];
      state.config = best.config || "default";
      state.split = best.split || "train";
    }
  } catch (err) {
    state.config = "default";
    state.split = "train";
  }
}
function getColName(stat) { return stat.column_name || stat.column || stat.name || stat.feature || ""; }
function getStats(stat) { return stat.column_statistics || stat.statistics || stat.stats || {}; }
function getColType(stat) {
  const cs = getStats(stat);
  return String(stat.column_type || stat.type || stat.dtype || cs.dtype || cs.type || "").toLowerCase();
}
function normalizeFreq(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const out = {};
    raw.forEach(item => {
      if (Array.isArray(item) && item.length >= 2) out[String(item[0])] = Number(item[1]) || 0;
      else if (item && typeof item === "object") {
        const val = item.value ?? item.name ?? item.key ?? item.label;
        const cnt = item.count ?? item.frequency ?? item.freq ?? item.n;
        if (val != null) out[String(val)] = Number(cnt) || 0;
      }
    });
    return Object.keys(out).length ? out : null;
  }
  if (typeof raw === "object") return raw;
  return null;
}
function getFreq(cs) { return normalizeFreq(cs.frequencies || cs.value_counts || cs.top_values); }
function getUniqueCount(cs, freq) {
  const n = cs.n_unique ?? cs.num_unique ?? cs.unique ?? cs.distinct_count;
  if (Number.isFinite(Number(n))) return Number(n);
  return freq ? Object.keys(freq).length : null;
}
function getMinMax(cs) {
  const min = cs.min ?? cs.minimum;
  const max = cs.max ?? cs.maximum;
  if (Number.isFinite(Number(min)) && Number.isFinite(Number(max))) return { min: Number(min), max: Number(max) };
  return null;
}
function isNumericColumn(type, col, minMax) {
  if (!minMax) return false;
  if (/zip|postal|code/i.test(col)) return false;
  if (/int|float|double|decimal|number|numeric/i.test(type)) return true;
  return NUMERIC_FIELD_RE.test(col);
}
function classifyField(stat, index) {
  const col = getColName(stat);
  if (!col || INTERNAL_FIELD_RE.test(col) || ID_FIELD_RE.test(col)) return null;
  if (PROSE_FIELD_RE.test(col)) return null;
  const cs = getStats(stat);
  const type = getColType(stat);
  const freq = getFreq(cs);
  const uniqueCount = getUniqueCount(cs, freq);
  const minMax = getMinMax(cs);

  if (isNumericColumn(type, col, minMax)) {
    return { col, control: "range", bounds: minMax, sourceIndex: index, uniqueCount };
  }
  if (freq && uniqueCount != null && uniqueCount > 0 && uniqueCount <= 160) {
    const options = Object.keys(freq).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" }));
    return { col, control: "category", options, sourceIndex: index, uniqueCount };
  }
  if (EXACT_TEXT_FIELD_RE.test(col) || LOCATION_FIELD_RE.test(col)) {
    return { col, control: "exactText", sourceIndex: index, uniqueCount };
  }
  return null;
}
async function loadMeta() {
  await resolveConfigSplit();
  $("#configSplit").textContent = `${state.config} / ${state.split}`;
  const url = `${API}/statistics?dataset=${encodeURIComponent(DATASET)}&config=${encodeURIComponent(state.config)}&split=${encodeURIComponent(state.split)}`;
  const data = await fetchJson(url, { maxWaitMs: 120000 });
  state.total = data.num_examples ?? data.num_rows ?? null;
  $("#sourceSize").textContent = state.total != null ? `${formatNumber(state.total)} records` : "확인됨";
  const stats = data.statistics || [];
  state.fields = stats.map((s, i) => classifyField(s, i)).filter(Boolean);
  state.fields.sort((a, b) => {
    const ai = FIELD_PRIORITY.indexOf(a.col), bi = FIELD_PRIORITY.indexOf(b.col);
    const ap = ai === -1 ? 999 : ai, bp = bi === -1 ? 999 : bi;
    return ap === bp ? a.sourceIndex - b.sourceIndex : ap - bp;
  });
  renderFilters();
  renderSecondaryFields();
  setBanner(`미국 데이터 준비 완료 — ${state.fields.length}개 1차 정확 조건 항목을 구성했습니다.`, "ok");
}

function defaultFilterValue(field) {
  if (field.control === "range") return { any: true, min: field.bounds.min, max: field.bounds.max };
  if (field.control === "category") return [];
  return "";
}
function renderFilters() {
  const root = $("#filters");
  root.innerHTML = "";
  state.fields.forEach(field => {
    if (!(field.col in state.filters)) state.filters[field.col] = defaultFilterValue(field);
    const box = document.createElement("div");
    box.className = "field";
    const label = document.createElement("label");
    label.className = "field-title";
    label.textContent = fieldLabel(field.col);
    label.title = `원문 컬럼: ${field.col}`;
    box.appendChild(label);

    if (field.control === "range") box.appendChild(renderRange(field));
    else if (field.control === "category") box.appendChild(renderCategory(field));
    else box.appendChild(renderExactText(field));

    const hint = document.createElement("div");
    hint.className = "hint";
    if (field.control === "range") hint.textContent = `숫자 범위 · 원문 컬럼 ${field.col}`;
    else if (field.control === "category") hint.textContent = `정확 일치 선택 · 고유값 ${field.uniqueCount ?? "?"}개`;
    else hint.textContent = `정확 일치 입력 · 쉼표로 여러 값 입력 가능 · 원문 컬럼 ${field.col}`;
    box.appendChild(hint);
    root.appendChild(box);
  });
  updateSignatureNote();
}
function renderRange(field) {
  const val = state.filters[field.col];
  const wrap = document.createElement("div");
  const anyId = `any_${field.col}`;
  const anyRow = document.createElement("label");
  anyRow.className = "check-row";
  const any = document.createElement("input");
  any.type = "checkbox";
  any.id = anyId;
  any.checked = val.any;
  anyRow.appendChild(any);
  anyRow.appendChild(document.createTextNode(ANY_LABEL));
  wrap.appendChild(anyRow);

  const row = document.createElement("div");
  row.className = "range-row";
  row.style.marginTop = "10px";
  const min = document.createElement("input");
  min.type = "number";
  min.value = val.min;
  min.min = field.bounds.min;
  min.max = field.bounds.max;
  const max = document.createElement("input");
  max.type = "number";
  max.value = val.max;
  max.min = field.bounds.min;
  max.max = field.bounds.max;
  row.appendChild(min);
  row.appendChild(document.createElement("span")).textContent = "~";
  row.appendChild(max);
  wrap.appendChild(row);

  function sync() {
    state.filters[field.col] = { any: any.checked, min: min.value, max: max.value };
    min.disabled = max.disabled = any.checked;
    updateSignatureNote();
  }
  any.addEventListener("change", sync);
  min.addEventListener("input", sync);
  max.addEventListener("input", sync);
  sync();
  return wrap;
}
function renderCategory(field) {
  const selected = new Set(state.filters[field.col] || []);
  const wrap = document.createElement("div");
  const anyRow = document.createElement("label");
  anyRow.className = "check-row";
  const any = document.createElement("input");
  any.type = "checkbox";
  any.checked = selected.size === 0;
  anyRow.appendChild(any);
  anyRow.appendChild(document.createTextNode(ANY_LABEL));
  wrap.appendChild(anyRow);

  const list = document.createElement("div");
  list.className = "check-list";
  field.options.forEach(opt => {
    const row = document.createElement("label");
    row.className = "check-row";
    row.title = `원문값: ${opt}`;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(opt);
    cb.addEventListener("change", () => {
      const vals = new Set(state.filters[field.col] || []);
      if (cb.checked) vals.add(opt); else vals.delete(opt);
      state.filters[field.col] = Array.from(vals);
      any.checked = vals.size === 0;
      updateSignatureNote();
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(opt));
    list.appendChild(row);
  });
  any.addEventListener("change", () => {
    if (any.checked) {
      state.filters[field.col] = [];
      list.querySelectorAll("input").forEach(cb => { cb.checked = false; });
      updateSignatureNote();
    } else {
      any.checked = true;
    }
  });
  wrap.appendChild(list);
  return wrap;
}
function renderExactText(field) {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = exactPlaceholder(field.col);
  input.value = state.filters[field.col] || "";
  input.addEventListener("input", () => {
    state.filters[field.col] = input.value;
    updateSignatureNote();
  });
  return input;
}
function exactPlaceholder(col) {
  if (col === "city") return "예: New York, Los Angeles";
  if (col === "state") return "예: California, Texas 또는 CA";
  if (/zip|postal/i.test(col)) return "예: 10001, 90210";
  if (/occupation|job/i.test(col)) return "예: Software Engineer, Teacher";
  return "영어 원문값을 정확히 입력";
}

function activeFilterSnapshot() {
  const snap = {};
  state.fields.forEach(field => {
    const v = state.filters[field.col];
    if (field.control === "range") {
      if (v && !v.any && (v.min !== "" || v.max !== "")) snap[field.col] = { any: false, min: String(v.min), max: String(v.max) };
    } else if (field.control === "category") {
      if (Array.isArray(v) && v.length) snap[field.col] = [...v].sort();
    } else {
      const parts = parseListInput(v);
      if (parts.length) snap[field.col] = parts;
    }
  });
  return snap;
}
function conditionSignature() {
  return JSON.stringify(activeFilterSnapshot());
}
function updateSignatureNote() {
  const sig = conditionSignature();
  const changed = state.candidates.length > 0 && state.currentSignature && sig !== state.currentSignature;
  $("#filterSignatureNote").textContent = changed
    ? "현재 1차 후보군을 수집한 조건과 화면 조건이 다릅니다. 새 조건으로 수집하려면 수집 데이터 전체 리셋 후 다시 시작하는 것이 안전합니다."
    : "";
}
function buildPredicates() {
  const parts = [];
  const client = [];
  const snap = activeFilterSnapshot();
  for (const [col, val] of Object.entries(snap)) {
    const field = state.fields.find(f => f.col === col);
    if (!field) continue;
    if (field.control === "range") {
      const min = Number(val.min), max = Number(val.max);
      if (Number.isFinite(min)) parts.push(`${q(col)} >= ${min}`);
      if (Number.isFinite(max)) parts.push(`${q(col)} <= ${max}`);
      client.push({ col, type: "range", min, max });
    } else {
      const arr = Array.isArray(val) ? val.filter(Boolean) : [];
      if (!arr.length) continue;
      if (arr.length > 80) throw new Error(`${fieldLabel(col)} 조건 선택값이 너무 많습니다. 조건을 줄여 주세요.`);
      parts.push("(" + arr.map(v => `${q(col)} = ${sqlStr(v)}`).join(" OR ") + ")");
      client.push({ col, type: "exact", values: arr });
    }
  }
  const where = parts.join(" AND ");
  if (encodeURIComponent(where).length > WHERE_MAX_LEN) throw new Error("조건이 너무 길어 서버가 거부할 수 있습니다. 선택값을 줄여 주세요.");
  return { where, clientPredicates: client };
}
function rowMatchesExact(row, preds) {
  return preds.every(p => {
    if (p.type === "range") {
      const n = Number(row[p.col]);
      if (!Number.isFinite(n)) return false;
      if (Number.isFinite(p.min) && n < p.min) return false;
      if (Number.isFinite(p.max) && n > p.max) return false;
      return true;
    }
    if (p.type === "exact") {
      const rv = normText(row[p.col]);
      return p.values.some(v => rv === normText(v));
    }
    return true;
  });
}
function buildUrl(kind, where, offset, length) {
  const common = `dataset=${encodeURIComponent(DATASET)}&config=${encodeURIComponent(state.config)}&split=${encodeURIComponent(state.split)}&offset=${offset}&length=${length}`;
  if (kind === "filter" && where) return `${API}/filter?${common}&where=${encodeURIComponent(where)}`;
  return `${API}/rows?${common}`;
}
function mapRows(rows) {
  return (rows || []).map(r => r && r.row ? r.row : r).filter(Boolean);
}
function addRows(rows, stageNo) {
  const keys = new Set(state.candidates.map(uniqueRowKey));
  let added = 0;
  rows.forEach(row => {
    const key = uniqueRowKey(row);
    if (!keys.has(key)) {
      keys.add(key);
      state.candidates.push({ ...row, __collection_stage: stageNo });
      added++;
    }
  });
  return added;
}

function renderStages() {
  const root = $("#stageGrid");
  root.innerHTML = "";
  state.stageInfo.forEach(info => {
    const card = document.createElement("div");
    card.className = "stage-card" + (info.completed ? " done" : "");
    const title = document.createElement("div");
    title.className = "stage-title";
    title.textContent = `1차 후보수집-${info.stage}단계`;
    const count = document.createElement("div");
    count.className = "stage-count";
    count.textContent = `${formatNumber(info.added)} / ${formatNumber(STAGE_SIZE)}명`;
    const status = document.createElement("div");
    status.className = "stage-status";
    status.textContent = info.status;
    const btn = document.createElement("button");
    btn.className = "btn primary small";
    btn.textContent = info.completed ? "완료" : `${info.stage}단계 수집`;
    btn.disabled = state.collecting || info.completed || (info.stage > 1 && !state.stageInfo[info.stage - 2].completed);
    btn.addEventListener("click", () => collectStage(info.stage));
    card.append(title, count, status, btn);
    root.appendChild(card);
  });
}
function renderCounts() {
  $("#candidateCount").textContent = formatNumber(state.candidates.length);
  $("#finalCount").textContent = formatNumber(state.finalRows.length);
  $("#resumeOffset").textContent = formatNumber(state.nextOffset);
  $("#fallbackState").textContent = state.fallbackUsed ? "ON" : "OFF";
  $("#downloadCandidatesBtn").disabled = state.candidates.length === 0 || state.collecting;
  $("#downloadFinalBtn").disabled = state.finalRows.length === 0;
  $("#runSecondaryBtn").disabled = state.candidates.length === 0;
}
function setCollecting(on) {
  state.collecting = on;
  $("#cancelBtn").disabled = !on;
  $$("button").forEach(btn => {
    if (btn.id === "cancelBtn") return;
    if (btn.closest("#stageGrid")) return;
  });
  renderStages();
  renderCounts();
}
async function collectStage(stageNo) {
  const sig = conditionSignature();
  if (state.candidates.length > 0 && state.currentSignature && sig !== state.currentSignature) {
    const ok = confirm("현재 조건이 기존 수집 조건과 다릅니다. 기존 1차 후보군을 모두 리셋하고 새 조건으로 다시 수집할까요?");
    if (!ok) return;
    resetCollectedDataOnly();
  }
  if (!state.currentSignature) state.currentSignature = sig;
  let where = "", clientPredicates = [];
  try {
    const plan = buildPredicates();
    where = plan.where;
    clientPredicates = plan.clientPredicates;
  } catch (err) {
    setBanner(err.message || String(err), "error");
    return;
  }

  const info = state.stageInfo[stageNo - 1];
  info.status = "수집 중";
  info.added = 0;
  state.cancelRequested = false;
  state.activeController = new AbortController();
  setCollecting(true);
  setBanner(`${stageNo}단계 수집을 시작합니다.`, "");
  setProgress(0);

  let addedThisStage = 0;
  let scannedRawThisStage = 0;
  let filterFailed = false;
  try {
    while (addedThisStage < STAGE_SIZE && state.candidates.length < HARD_CAP) {
      checkCancel();
      let rows = [];
      if (!state.fallbackUsed && !filterFailed) {
        try {
          const kind = where ? "filter" : "rows";
          const url = buildUrl(kind, where, state.nextOffset, PAGE);
          const data = await fetchJson(url, { maxWaitMs: 70000 });
          rows = mapRows(data.rows);
          if (!rows.length) break;
          state.nextOffset += rows.length;
          const added = addRows(rows, stageNo);
          addedThisStage += added;
        } catch (err) {
          if (err.status === 422 || /HTTP 422|query parameter is invalid/i.test(err.message || "")) {
            filterFailed = true;
            state.fallbackUsed = true;
            setBanner("서버가 /filter offset 요청을 거부했습니다. 안전 스캔 모드로 전환하여 이어서 수집합니다.", "warn");
            await sleep(200);
            continue;
          }
          throw err;
        }
      } else {
        if (scannedRawThisStage >= MAX_SAFE_SCAN_PER_STAGE) {
          setBanner(`안전 스캔에서 ${formatNumber(MAX_SAFE_SCAN_PER_STAGE)}행을 확인했습니다. 조건이 너무 좁으면 다음 단계에서 이어서 시도하거나 조건을 완화해 주세요.`, "warn");
          break;
        }
        const url = buildUrl("rows", "", state.rawScanOffset, PAGE);
        const data = await fetchJson(url, { maxWaitMs: 70000 });
        rows = mapRows(data.rows);
        if (!rows.length) break;
        state.rawScanOffset += rows.length;
        scannedRawThisStage += rows.length;
        const matched = clientPredicates.length ? rows.filter(row => rowMatchesExact(row, clientPredicates)) : rows;
        const added = addRows(matched, stageNo);
        addedThisStage += added;
      }

      info.added = addedThisStage;
      info.status = state.fallbackUsed ? `안전 스캔 중 · raw offset ${formatNumber(state.rawScanOffset)}` : `서버 offset ${formatNumber(state.nextOffset)}`;
      $("#collectStatus").textContent = `${stageNo}단계 수집 중… 이번 단계 ${formatNumber(addedThisStage)}명 / 누적 ${formatNumber(state.candidates.length)}명`;
      setProgress((addedThisStage / STAGE_SIZE) * 100);
      renderStages();
      renderCounts();
      await sleep(30);
    }
    info.added = addedThisStage;
    info.completed = true;
    info.status = addedThisStage >= STAGE_SIZE ? "완료" : "완료 · 더 이상 가져올 후보가 적거나 조건이 좁음";
    state.finalRows = [];
    setBanner(`${stageNo}단계 완료 — ${formatNumber(addedThisStage)}명 추가, 누적 ${formatNumber(state.candidates.length)}명입니다.`, "ok");
    $("#collectStatus").textContent = `${stageNo}단계 완료 — 누적 ${formatNumber(state.candidates.length)}명`;
    setProgress(100);
    showPreview(state.candidates, "1차 누적 후보 미리보기");
  } catch (err) {
    if ((err.message || "").includes("취소")) {
      info.status = "취소됨";
      setBanner("수집이 취소되었습니다.", "warn");
      $("#collectStatus").textContent = "수집이 취소되었습니다.";
    } else {
      info.status = "오류";
      setBanner(`데이터를 가져오지 못했습니다: ${err.message || err}`, "error");
      $("#collectStatus").textContent = "오류가 발생했습니다.";
    }
  } finally {
    state.activeController = null;
    state.cancelRequested = false;
    setCollecting(false);
    renderStages();
    renderCounts();
    updateSignatureNote();
  }
}

function renderSecondaryFields() {
  const root = $("#secondaryFields");
  root.innerHTML = "";
  const cols = collectKnownColumns().filter(col => TEXT_SEARCH_FIELD_RE.test(col));
  const preferred = ["occupation", "professional_persona", "persona", "skills_and_expertise", "hobbies_and_interests", "career_goals_and_ambitions", "cultural_background", "education_level", "bachelors_field", "state", "city", "family_persona"];
  const ordered = [...new Set([...preferred.filter(c => cols.includes(c)), ...cols])];
  ordered.forEach(col => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = col;
    cb.checked = preferred.includes(col) && !["state", "city", "education_level", "bachelors_field"].includes(col);
    label.append(cb, document.createTextNode(fieldLabel(col)));
    label.title = col;
    root.appendChild(label);
  });
}
function collectKnownColumns() {
  const fromFields = state.fields.map(f => f.col);
  const fromRows = state.candidates.length ? Object.keys(state.candidates[0]) : [];
  return [...new Set([...fromFields, ...fromRows, ...EXPORT_ORDER])].filter(c => c && !c.startsWith("__"));
}
function selectedSecondaryColumns() {
  const checked = $$("#secondaryFields input:checked").map(cb => cb.value);
  return checked.length ? checked : collectKnownColumns().filter(col => TEXT_SEARCH_FIELD_RE.test(col));
}
function runSecondaryFilter() {
  const includes = parseListInput($("#includeKeywords").value).map(normText).filter(Boolean);
  const excludes = parseListInput($("#excludeKeywords").value).map(normText).filter(Boolean);
  const mode = $("#matchMode").value;
  const minMatch = Math.max(1, Number($("#minMatch").value) || 1);
  const cols = selectedSecondaryColumns();

  if (!state.candidates.length) {
    setBanner("먼저 1차 후보를 수집해 주세요.", "warn");
    return;
  }
  const result = state.candidates.filter(row => {
    const hay = normText(cols.map(col => row[col]).filter(v => v != null).join(" \n "));
    if (excludes.length && excludes.some(k => hay.includes(k))) return false;
    if (!includes.length) return true;
    const hits = includes.filter(k => hay.includes(k)).length;
    if (mode === "all") return hits === includes.length;
    if (mode === "min") return hits >= minMatch;
    return hits >= 1;
  });
  state.finalRows = result;
  $("#secondaryStatus").textContent = `2차 필터 완료 — 1차 후보 ${formatNumber(state.candidates.length)}명 중 ${formatNumber(result.length)}명 선택`;
  renderCounts();
  showPreview(result, "2차 최종 결과 미리보기");
  setBanner(`2차 정밀 필터 완료 — ${formatNumber(result.length)}명이 최종 선택되었습니다.`, "ok");
}

function orderedColumns(rows) {
  const all = new Set();
  rows.slice(0, 100).forEach(row => Object.keys(row).forEach(k => all.add(k)));
  return [...EXPORT_ORDER.filter(c => all.has(c)), ...[...all].filter(c => !EXPORT_ORDER.includes(c))];
}
function showPreview(rows, title) {
  const card = $("#previewCard");
  const table = $("#previewTable");
  card.classList.remove("hidden");
  $("#previewInfo").textContent = `${title} · 총 ${formatNumber(rows.length)}명 중 최대 30명 표시`;
  table.innerHTML = "";
  if (!rows.length) {
    table.innerHTML = "<tbody><tr><td>표시할 데이터가 없습니다.</td></tr></tbody>";
    return;
  }
  const cols = orderedColumns(rows).slice(0, 18);
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  cols.forEach(col => {
    const th = document.createElement("th");
    th.textContent = fieldLabel(col);
    th.title = col;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  const tbody = document.createElement("tbody");
  rows.slice(0, 30).forEach(row => {
    const tr = document.createElement("tr");
    cols.forEach(col => {
      const td = document.createElement("td");
      td.textContent = row[col] == null ? "" : String(row[col]);
      td.title = td.textContent;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
}

function downloadWorkbook(rows, prefix) {
  if (!rows.length) {
    setBanner("저장할 데이터가 없습니다.", "warn");
    return;
  }
  if (typeof XLSX === "undefined") {
    setBanner("엑셀 저장 라이브러리를 불러오지 못했습니다. 인터넷 연결 또는 CDN 차단 여부를 확인해 주세요.", "error");
    return;
  }
  const cols = orderedColumns(rows);
  const normalized = rows.map(row => {
    const obj = {};
    cols.forEach(col => { obj[fieldLabel(col)] = row[col] ?? ""; });
    return obj;
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(normalized);
  XLSX.utils.book_append_sheet(wb, ws, "data");
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  XLSX.writeFile(wb, `${prefix}_${ts}.xlsx`);
}
function saveJsonFile(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function saveProject() {
  const project = {
    app: "Nemotron-Personas-USA-multistage",
    version: "rebuilt-safe-resume-1.0",
    savedAt: new Date().toISOString(),
    dataset: DATASET,
    config: state.config,
    split: state.split,
    filters: state.filters,
    currentSignature: state.currentSignature,
    candidates: state.candidates,
    finalRows: state.finalRows,
    stageInfo: state.stageInfo,
    nextOffset: state.nextOffset,
    rawScanOffset: state.rawScanOffset,
    fallbackUsed: state.fallbackUsed,
    secondary: {
      includeKeywords: $("#includeKeywords").value,
      excludeKeywords: $("#excludeKeywords").value,
      matchMode: $("#matchMode").value,
      minMatch: $("#minMatch").value,
      selectedColumns: selectedSecondaryColumns()
    }
  };
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  saveJsonFile(project, `nemotron_usa_project_${ts}.json`);
}
async function openProjectFile(file) {
  try {
    const text = await file.text();
    const p = JSON.parse(text);
    if (p.dataset && p.dataset !== DATASET) {
      const ok = confirm("이 프로젝트는 현재 미국 전용 데이터셋과 다른 dataset 정보를 갖고 있습니다. 그래도 열까요?");
      if (!ok) return;
    }
    state.config = p.config || state.config;
    state.split = p.split || state.split;
    state.filters = p.filters || {};
    state.currentSignature = p.currentSignature || conditionSignature();
    state.candidates = Array.isArray(p.candidates) ? p.candidates : [];
    state.finalRows = Array.isArray(p.finalRows) ? p.finalRows : [];
    state.stageInfo = Array.isArray(p.stageInfo) && p.stageInfo.length === MAX_STAGES ? p.stageInfo : state.stageInfo;
    state.nextOffset = Number(p.nextOffset) || 0;
    state.rawScanOffset = Number(p.rawScanOffset) || 0;
    state.fallbackUsed = !!p.fallbackUsed;
    renderFilters();
    renderSecondaryFields();
    if (p.secondary) {
      $("#includeKeywords").value = p.secondary.includeKeywords || "";
      $("#excludeKeywords").value = p.secondary.excludeKeywords || "";
      $("#matchMode").value = p.secondary.matchMode || "any";
      $("#minMatch").value = p.secondary.minMatch || "2";
      if (Array.isArray(p.secondary.selectedColumns)) {
        const selected = new Set(p.secondary.selectedColumns);
        $$("#secondaryFields input").forEach(cb => cb.checked = selected.has(cb.value));
      }
    }
    renderStages();
    renderCounts();
    if (state.finalRows.length) showPreview(state.finalRows, "프로젝트에서 복원한 2차 최종 결과");
    else if (state.candidates.length) showPreview(state.candidates, "프로젝트에서 복원한 1차 후보");
    setBanner(`프로젝트를 열었습니다 — 1차 후보 ${formatNumber(state.candidates.length)}명, 최종 ${formatNumber(state.finalRows.length)}명`, "ok");
  } catch (err) {
    setBanner(`프로젝트 JSON을 열 수 없습니다: ${err.message || err}`, "error");
  }
}

function resetFilters() {
  state.fields.forEach(f => { state.filters[f.col] = defaultFilterValue(f); });
  renderFilters();
}
function resetCollectedDataOnly() {
  state.candidates = [];
  state.finalRows = [];
  state.stageInfo = Array.from({ length: MAX_STAGES }, (_, i) => ({ stage: i + 1, status: "대기", added: 0, completed: false }));
  state.nextOffset = 0;
  state.rawScanOffset = 0;
  state.fallbackUsed = false;
  state.currentSignature = conditionSignature();
  setProgress(0);
  $("#collectStatus").textContent = "수집 데이터를 리셋했습니다.";
  $("#secondaryStatus").textContent = "";
  $("#previewCard").classList.add("hidden");
  renderStages();
  renderCounts();
  updateSignatureNote();
}
function resetAll() {
  const ok = confirm("수집된 1차 후보, 2차 결과, 단계 정보, 이어받기 위치를 모두 삭제할까요?");
  if (!ok) return;
  resetCollectedDataOnly();
  setBanner("수집 데이터를 모두 리셋했습니다. 정확 조건은 유지됩니다.", "ok");
}
function bindEvents() {
  $("#cancelBtn").addEventListener("click", () => {
    state.cancelRequested = true;
    if (state.activeController) state.activeController.abort();
  });
  $("#resetFiltersBtn").addEventListener("click", resetFilters);
  $("#resetAllBtn").addEventListener("click", resetAll);
  $("#runSecondaryBtn").addEventListener("click", runSecondaryFilter);
  $("#downloadCandidatesBtn").addEventListener("click", () => downloadWorkbook(state.candidates, "Nemotron_USA_1차후보"));
  $("#downloadFinalBtn").addEventListener("click", () => downloadWorkbook(state.finalRows, "Nemotron_USA_최종결과"));
  $("#saveProjectBtn").addEventListener("click", saveProject);
  $("#openProjectInput").addEventListener("change", e => {
    const file = e.target.files && e.target.files[0];
    if (file) openProjectFile(file);
    e.target.value = "";
  });
}

async function init() {
  bindEvents();
  renderStages();
  renderCounts();
  try {
    await loadMeta();
  } catch (err) {
    setBanner(`미국 데이터 정보를 불러오지 못했습니다: ${err.message || err}`, "error");
    // 기본 필드 백업: statistics 실패 시에도 최소 동작
    state.fields = [
      { col: "sex", control: "category", options: ["male", "female"], sourceIndex: 1, uniqueCount: 2 },
      { col: "age", control: "range", bounds: { min: 0, max: 100 }, sourceIndex: 2, uniqueCount: null },
      { col: "state", control: "exactText", sourceIndex: 3, uniqueCount: null },
      { col: "city", control: "exactText", sourceIndex: 4, uniqueCount: null },
      { col: "zipcode", control: "exactText", sourceIndex: 5, uniqueCount: null },
      { col: "occupation", control: "exactText", sourceIndex: 6, uniqueCount: null }
    ];
    renderFilters();
    renderSecondaryFields();
  }
}

document.addEventListener("DOMContentLoaded", init);
