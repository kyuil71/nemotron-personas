/*
  K Persona Lab
  Static GitHub Pages app for nvidia/Nemotron-Personas-Korea.
  - Fetches evidence rows from Hugging Face Dataset Viewer API.
  - Builds grounded Korean UX personas.
  - Optionally calls Gemini API with evidence-only RAG prompt.
*/

const DATASET_ID = "nvidia/Nemotron-Personas-Korea";
const CONFIG = "default";
const SPLIT = "train";
const HF_BASE = "https://datasets-server.huggingface.co";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/interactions";

let state = {
  evidenceRows: [],
  personas: [],
  answer: "",
  lastPrompt: ""
};

const $ = (id) => document.getElementById(id);

function setStatus(message) {
  $("status").textContent = message;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toList(value) {
  return String(value || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
}

function getNumber(id, fallback = null) {
  const v = $(id).value.trim();
  if (v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getSettings() {
  return {
    projectTheme: $("projectTheme").value.trim(),
    concept: $("concept").value.trim(),
    question: $("question").value.trim(),
    personaCount: Math.max(1, Math.min(50, getNumber("personaCount", 12))),
    searchLimit: Math.max(20, Math.min(500, getNumber("searchLimit", 100))),
    provinces: toList($("provinces").value),
    districts: toList($("districts").value),
    ageMin: getNumber("ageMin", null),
    ageMax: getNumber("ageMax", null),
    sex: $("sex").value.trim(),
    occupationKeywords: toList($("occupationKeywords").value),
    contentKeywords: toList($("contentKeywords").value),
    geminiKey: $("geminiKey").value.trim(),
    geminiModel: $("geminiModel").value.trim() || "gemini-3.5-flash",
    temperature: Math.max(0, Math.min(1.5, getNumber("temperature", 0.3)))
  };
}

function sqlQuote(value) {
  return String(value).replaceAll("'", "''");
}

function buildWhere(settings) {
  const clauses = [];

  if (settings.ageMin !== null) clauses.push(`"age">=${settings.ageMin}`);
  if (settings.ageMax !== null) clauses.push(`"age"<=${settings.ageMax}`);

  if (settings.provinces.length) {
    const provinceClause = settings.provinces.map(v => `"province"='${sqlQuote(v)}'`).join(" OR ");
    clauses.push(`(${provinceClause})`);
  }

  if (settings.districts.length) {
    const districtClause = settings.districts.map(v => `"district"='${sqlQuote(v)}'`).join(" OR ");
    clauses.push(`(${districtClause})`);
  }

  if (settings.sex) clauses.push(`"sex"='${sqlQuote(settings.sex)}'`);

  return clauses.join(" AND ");
}

function normalizeRow(apiRow, fallbackIndex = 0) {
  const row = apiRow?.row || apiRow || {};
  return {
    _row_idx: apiRow?.row_idx ?? fallbackIndex,
    name: row.name || "",
    age: row.age ?? "",
    sex: row.sex || "",
    marital_status: row.marital_status || "",
    family_type: row.family_type || "",
    housing_type: row.housing_type || "",
    education_level: row.education_level || "",
    occupation: row.occupation || "",
    district: row.district || "",
    province: row.province || "",
    country: row.country || "",
    persona: row.persona || "",
    professional_persona: row.professional_persona || "",
    sports_persona: row.sports_persona || "",
    arts_persona: row.arts_persona || "",
    travel_persona: row.travel_persona || "",
    culinary_persona: row.culinary_persona || "",
    family_persona: row.family_persona || "",
    cultural_background: row.cultural_background || "",
    skills_and_expertise: row.skills_and_expertise || "",
    hobbies_and_interests: row.hobbies_and_interests || "",
    career_goals_and_ambitions: row.career_goals_and_ambitions || ""
  };
}

function combinedText(row) {
  return [
    row.name,
    row.occupation,
    row.persona,
    row.professional_persona,
    row.family_persona,
    row.cultural_background,
    row.skills_and_expertise,
    row.hobbies_and_interests,
    row.career_goals_and_ambitions,
    row.sports_persona,
    row.arts_persona,
    row.travel_persona,
    row.culinary_persona
  ].join(" ");
}

function clientFilter(rows, settings, relax = false) {
  return rows.filter(row => {
    const age = Number(row.age);
    if (!relax && settings.provinces.length && !settings.provinces.includes(row.province)) return false;
    if (!relax && settings.districts.length && !settings.districts.includes(row.district)) return false;
    if (!relax && settings.ageMin !== null && Number.isFinite(age) && age < settings.ageMin) return false;
    if (!relax && settings.ageMax !== null && Number.isFinite(age) && age > settings.ageMax) return false;
    if (!relax && settings.sex && row.sex !== settings.sex) return false;

    if (!relax && settings.occupationKeywords.length) {
      if (!settings.occupationKeywords.some(k => String(row.occupation).includes(k))) return false;
    }

    if (!relax && settings.contentKeywords.length) {
      const text = combinedText(row);
      if (!settings.contentKeywords.some(k => text.includes(k))) return false;
    }

    return true;
  });
}

async function hfFetch(endpoint, params) {
  const url = new URL(`${HF_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hugging Face API 오류 ${res.status}: ${text.slice(0, 220)}`);
  }
  return await res.json();
}

async function fetchByFilter(settings, offset = 0, length = 100) {
  const where = buildWhere(settings);
  if (!where) return [];
  const data = await hfFetch("filter", {
    dataset: DATASET_ID,
    config: CONFIG,
    split: SPLIT,
    where,
    offset,
    length: Math.min(100, length)
  });
  return (data.rows || []).map(normalizeRow);
}

async function fetchBySearch(query, offset = 0, length = 100) {
  const data = await hfFetch("search", {
    dataset: DATASET_ID,
    config: CONFIG,
    split: SPLIT,
    query,
    offset,
    length: Math.min(100, length)
  });
  return (data.rows || []).map(normalizeRow);
}

async function fetchRowsSlice(offset = 0, length = 100) {
  const data = await hfFetch("rows", {
    dataset: DATASET_ID,
    config: CONFIG,
    split: SPLIT,
    offset,
    length: Math.min(100, length)
  });
  return (data.rows || []).map(normalizeRow);
}

function uniqueRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row._row_idx ?? `${row.name}-${row.age}-${row.province}-${row.district}-${row.occupation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function collectEvidence(settings) {
  const desired = Math.max(settings.personaCount, 12);
  const limit = settings.searchLimit;
  let rows = [];

  setStatus("원본 데이터셋에서 조건 기반 검색 중입니다...");

  // 1) Main path: use /search for content/occupation/question keywords, then client-side filters.
  const searchTerms = uniqueRows([]);
  const terms = [
    ...settings.contentKeywords,
    ...settings.occupationKeywords,
    ...toList(settings.question.replace(/[?？.,!！]/g, ","))
  ].filter(t => t.length >= 2);

  const dedupedTerms = [...new Set(terms)].slice(0, 8);
  for (const term of dedupedTerms) {
    try {
      const found = await fetchBySearch(term, 0, Math.min(100, limit));
      rows.push(...found);
      rows = uniqueRows(rows);
      const filtered = clientFilter(rows, settings, false);
      if (filtered.length >= desired) return filtered.slice(0, limit);
    } catch (err) {
      console.warn("search failed", term, err);
    }
  }

  // 2) Structured filter path: province/age/sex only, then client keyword filtering.
  try {
    const filteredRaw = await fetchByFilter(settings, 0, Math.min(100, limit));
    rows.push(...filteredRaw);
    rows = uniqueRows(rows);
    const filtered = clientFilter(rows, settings, false);
    if (filtered.length >= desired) return filtered.slice(0, limit);
  } catch (err) {
    console.warn("filter failed", err);
  }

  // 3) Relax keyword conditions but keep demographic filters where possible.
  const relaxedSettings = { ...settings, occupationKeywords: [], contentKeywords: [] };
  try {
    const relaxedRaw = await fetchByFilter(relaxedSettings, 0, Math.min(100, limit));
    rows.push(...relaxedRaw);
    rows = uniqueRows(rows);
    const filtered = clientFilter(rows, relaxedSettings, false);
    if (filtered.length >= desired) return filtered.slice(0, limit);
  } catch (err) {
    console.warn("relaxed filter failed", err);
  }

  // 4) Last resort: first rows slice.
  if (rows.length < desired) {
    try {
      const fallbackRows = await fetchRowsSlice(0, Math.min(100, limit));
      rows.push(...fallbackRows);
    } catch (err) {
      console.warn("rows fallback failed", err);
    }
  }

  rows = uniqueRows(rows);
  const strict = clientFilter(rows, settings, false);
  if (strict.length) return strict.slice(0, limit);
  return rows.slice(0, limit);
}

function makePersona(row, index, settings) {
  const id = `UX-P-${String(index + 1).padStart(2, "0")}`;
  const userType = `${row.province || ""} ${row.district || ""} 거주 ${row.age || ""}세 ${row.occupation || ""}`.replace(/\s+/g, " ").trim();
  const context = row.family_persona || row.persona || row.professional_persona || "원본 데이터에 요약 페르소나가 제공되어 있지 않습니다.";
  const work = row.professional_persona || row.skills_and_expertise || row.occupation || "직업 맥락 정보가 제한적입니다.";
  const interests = row.hobbies_and_interests || row.cultural_background || "관심사 정보가 제한적입니다.";

  return {
    id,
    sourceRow: row._row_idx,
    name: row.name,
    age: row.age,
    sex: row.sex,
    region: `${row.province || ""} ${row.district || ""}`.trim(),
    occupation: row.occupation,
    education: row.education_level,
    marital: row.marital_status,
    familyType: row.family_type,
    housingType: row.housing_type,
    userType,
    context,
    work,
    culturalBackground: row.cultural_background,
    skills: row.skills_and_expertise,
    interests,
    goals: row.career_goals_and_ambitions,
    concept: settings.concept,
    needsHypothesis: [
      "개인화 추천의 정확성과 설명 가능성에 민감할 가능성이 있습니다.",
      "가족 또는 생활 맥락에 맞는 쉬운 설정, 권한 관리, 사용 흐름을 요구할 가능성이 있습니다.",
      "서비스가 자신의 일상·관심사·직업 맥락과 연결될 때 가치를 크게 느낄 가능성이 있습니다."
    ],
    concernsHypothesis: [
      "개인 취향과 시청 데이터 수집에 대한 프라이버시 우려가 있을 수 있습니다.",
      "AI가 가족 구성원을 잘못 인식하거나 추천을 과도하게 자동화하면 거부감이 생길 수 있습니다.",
      "초기 설정이 복잡하거나 효과가 즉시 보이지 않으면 사용 지속성이 낮아질 수 있습니다."
    ],
    interviewQuestions: [
      "현재 TV나 콘텐츠 서비스를 사용할 때 가장 불편한 순간은 언제인가요?",
      "가족 구성원별로 화면 경험이 달라지는 기능에 대해 어떻게 느끼시나요?",
      "AI가 취향을 학습하기 위해 어떤 데이터를 사용하는 것은 허용 가능하다고 보시나요?",
      "추천이 틀렸을 때 사용자가 어떻게 수정할 수 있어야 신뢰가 생길까요?",
      "이 서비스가 유료라면 어떤 가치가 확인되어야 지불할 의향이 생길까요?"
    ]
  };
}

function renderEvidence(rows) {
  const tbody = $("evidenceTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const [i, row] of rows.entries()) {
    const summary = row.persona || row.professional_persona || row.family_persona || "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>R${i + 1}<br><span class="hint">row ${escapeHtml(row._row_idx)}</span></td>
      <td>${escapeHtml(row.age)}</td>
      <td>${escapeHtml(row.sex)}</td>
      <td>${escapeHtml(`${row.province || ""} ${row.district || ""}`.trim())}</td>
      <td>${escapeHtml(row.occupation)}</td>
      <td>${escapeHtml(summary).slice(0, 520)}</td>
    `;
    tbody.appendChild(tr);
  }
  $("evidenceMeta").textContent = `${rows.length}개 근거 행`;
}

function renderPersonas(personas) {
  const wrap = $("personaCards");
  wrap.classList.remove("empty");
  if (!personas.length) {
    wrap.classList.add("empty");
    wrap.textContent = "조건에 맞는 페르소나가 없습니다.";
    return;
  }
  wrap.innerHTML = personas.map(p => `
    <article class="card">
      <h3>${escapeHtml(p.id)} · ${escapeHtml(p.name || "합성 페르소나")}</h3>
      <div class="chips">
        <span class="chip">${escapeHtml(p.region || "지역 미상")}</span>
        <span class="chip">${escapeHtml(String(p.age || "나이 미상"))}세</span>
        <span class="chip">${escapeHtml(p.sex || "성별 미상")}</span>
        <span class="chip">${escapeHtml(p.occupation || "직업 미상")}</span>
      </div>
      <p><span class="label">사용자 유형</span><br>${escapeHtml(p.userType)}</p>
      <p><span class="label">생활 맥락</span><br>${escapeHtml(p.context).slice(0, 520)}</p>
      <p><span class="label">직업 / 역량 맥락</span><br>${escapeHtml(p.work).slice(0, 520)}</p>
      <p><span class="label">관심사</span><br>${escapeHtml(p.interests).slice(0, 420)}</p>
      <p><span class="label">니즈 가설</span><br>${escapeHtml(p.needsHypothesis.join(" / "))}</p>
      <p><span class="label">인터뷰 질문</span><br>${escapeHtml(p.interviewQuestions.slice(0,3).join(" / "))}</p>
      <p class="hint">근거: Hugging Face row ${escapeHtml(p.sourceRow)}</p>
    </article>
  `).join("");
  $("personaMeta").textContent = `${personas.length}개 생성`;
}

function makeEvidenceContext(rows) {
  return rows.slice(0, 30).map((row, i) => ({
    evidence_id: `R${i + 1}`,
    row_idx: row._row_idx,
    age: row.age,
    sex: row.sex,
    province: row.province,
    district: row.district,
    occupation: row.occupation,
    education_level: row.education_level,
    marital_status: row.marital_status,
    family_type: row.family_type,
    housing_type: row.housing_type,
    persona: row.persona,
    professional_persona: row.professional_persona,
    family_persona: row.family_persona,
    cultural_background: row.cultural_background,
    skills_and_expertise: row.skills_and_expertise,
    hobbies_and_interests: row.hobbies_and_interests,
    career_goals_and_ambitions: row.career_goals_and_ambitions
  }));
}

function buildGroundedPrompt(settings, rows, personas) {
  const evidence = makeEvidenceContext(rows);
  return `당신은 한국 UX 리서치 분석가입니다.
아래 답변은 반드시 제공된 Nemotron-Personas-Korea 근거 데이터에만 기반해야 합니다.
데이터에 없는 사실은 추측하지 말고 "이 근거 데이터만으로는 단정하기 어렵습니다"라고 말하세요.
이 데이터는 실제 인터뷰가 아니라 한국 통계 기반 합성 페르소나 데이터입니다. 따라서 답변은 조사 결과가 아니라 "가설"로 표현해야 합니다.
각 핵심 주장 뒤에는 가능한 한 [R1], [R2] 같은 근거 ID를 붙이세요.
한국어 존댓말로, 실무 보고서처럼 간결하고 명확하게 작성하세요.

[프로젝트]
${settings.projectTheme}

[제품/서비스 컨셉]
${settings.concept}

[사용자 질문]
${settings.question}

[생성된 UX 페르소나 요약]
${JSON.stringify(personas.map(p => ({
  id: p.id,
  sourceRow: p.sourceRow,
  userType: p.userType,
  context: p.context,
  work: p.work,
  interests: p.interests,
  needsHypothesis: p.needsHypothesis,
  concernsHypothesis: p.concernsHypothesis,
  interviewQuestions: p.interviewQuestions
})), null, 2)}

[근거 데이터]
${JSON.stringify(evidence, null, 2)}

[출력 형식]
1. 한 줄 결론
2. 데이터 근거 요약
3. 기대점 가설
4. 우려점 가설
5. 페르소나 세그먼트별 차이
6. 인터뷰에서 검증해야 할 질문
7. 사용 시 주의사항`;
}

function localGroundedAnswer(settings, rows, personas) {
  const byRegion = groupCount(rows.map(r => r.province).filter(Boolean));
  const byOcc = groupCount(rows.map(r => r.occupation).filter(Boolean));
  const avgAge = rows.length ? Math.round(rows.reduce((s, r) => s + (Number(r.age) || 0), 0) / rows.filter(r => Number(r.age)).length) : "N/A";
  const refs = rows.slice(0, Math.min(6, rows.length)).map((_, i) => `[R${i + 1}]`).join(" ");

  return `1. 한 줄 결론
제공된 근거 데이터 기준으로는, 이 컨셉은 개인화 추천과 가족/생활 맥락 최적화에 대한 기대를 만들 수 있지만, 데이터 수집·자동화 오류·설정 복잡성에 대한 우려를 함께 검증해야 합니다. ${refs}

2. 데이터 근거 요약
- 분석 근거 행 수: ${rows.length}개
- 평균 연령: ${avgAge}세
- 주요 지역: ${formatCount(byRegion)}
- 주요 직업: ${formatCount(byOcc)}
- 주의: 이 데이터는 실제 인터뷰가 아니라 한국 통계 기반 합성 페르소나이므로, 아래 내용은 확정적 결론이 아니라 리서치 가설입니다.

3. 기대점 가설
- 사용자별 취향과 생활 맥락을 반영한 콘텐츠 추천은 초기 관심을 만들 가능성이 있습니다.
- 가족형태와 주거형태가 다양한 사용자에게는 구성원별 권한, 화면, 추천 관리가 중요할 가능성이 있습니다.
- 직업/관심사 맥락이 뚜렷한 사용자는 단순 추천보다 업무·학습·취미와 연결되는 TV 경험을 더 높게 평가할 가능성이 있습니다.

4. 우려점 가설
- 개인 시청 데이터와 가족 구성원 정보 수집에 대한 프라이버시 우려가 핵심 장벽이 될 수 있습니다.
- AI가 취향이나 사용자를 잘못 판단하면 추천 품질보다 신뢰 문제가 먼저 발생할 수 있습니다.
- 초기 설정과 수정 방식이 복잡하면 실제 사용률이 낮아질 수 있습니다.

5. 세그먼트별 차이
${personas.slice(0, 6).map(p => `- ${p.id}: ${p.userType} → ${p.needsHypothesis[0]}`).join("\n")}

6. 인터뷰에서 검증해야 할 질문
- TV가 가족 구성원을 자동 구분하는 기능을 어느 수준까지 허용할 수 있나요?
- 추천을 위해 어떤 데이터 사용은 허용 가능하고, 어떤 데이터 사용은 불편한가요?
- 추천이 틀렸을 때 사용자가 어떻게 수정할 수 있어야 신뢰가 회복될까요?
- 가족 구성원별 화면/알림/음성 인터랙션이 실제로 필요한 상황은 언제인가요?
- 이 기능이 유료라면 어떤 가치가 확인되어야 지불 의향이 생기나요?

7. 사용 시 주의사항
이 답변은 현재 화면에 표시된 Nemotron-Personas-Korea 합성 페르소나 근거 행만 사용해 만든 가설입니다. 실제 제품 의사결정 전에는 실제 사용자 인터뷰, 설문, 사용성 테스트로 반드시 검증해야 합니다.`;
}

function groupCount(values) {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a,b) => b[1] - a[1]).slice(0, 5);
}

function formatCount(counts) {
  if (!counts.length) return "정보 부족";
  return counts.map(([k,v]) => `${k} ${v}개`).join(", ");
}

async function callGemini(settings, prompt) {
  if (!settings.geminiKey) throw new Error("Gemini API Key가 없습니다.");

  const payload = {
    model: settings.geminiModel,
    store: false,
    system_instruction: "You are a rigorous Korean UX research assistant. Use only provided evidence. Never fabricate statistics.",
    input: prompt,
    generation_config: {
      temperature: settings.temperature,
      thinking_level: "low"
    }
  };

  const res = await fetch(GEMINI_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": settings.geminiKey
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini API 오류 ${res.status}: ${text.slice(0, 500)}`);

  const data = JSON.parse(text);
  if (data.output_text) return data.output_text;

  // Fallback parser for step-based responses.
  const chunks = [];
  for (const step of data.steps || []) {
    for (const c of step.content || []) {
      if (c.text) chunks.push(c.text);
      if (c.type === "text" && c.text) chunks.push(c.text);
    }
  }
  return chunks.join("\n").trim() || JSON.stringify(data, null, 2);
}

async function generatePersonas() {
  const settings = getSettings();
  disableRunButtons(true);
  try {
    setStatus("페르소나 생성을 시작합니다. Hugging Face 원본 데이터셋에 연결 중...");
    const rows = await collectEvidence(settings);
    if (!rows.length) throw new Error("조건에 맞는 데이터를 찾지 못했습니다. 필터를 완화해 주세요.");
    const selected = rows.slice(0, settings.personaCount);
    const personas = selected.map((row, i) => makePersona(row, i, settings));

    state.evidenceRows = rows;
    state.personas = personas;
    state.answer = "";
    state.lastPrompt = buildGroundedPrompt(settings, rows, personas);

    renderEvidence(rows);
    renderPersonas(personas);
    $("promptBackup").value = state.lastPrompt;
    $("answer").textContent = "페르소나가 생성되었습니다. '데이터 기반 답변 생성'을 누르면 근거 데이터와 페르소나를 기반으로 답변을 생성합니다.";
    $("answer").classList.add("empty");
    $("answerMeta").textContent = "답변 대기";
    setStatus(`완료: 근거 데이터 ${rows.length}개, 페르소나 ${personas.length}개를 생성했습니다.`);
  } catch (err) {
    console.error(err);
    setStatus(`오류: ${err.message}`);
  } finally {
    disableRunButtons(false);
  }
}

async function askGrounded() {
  const settings = getSettings();
  disableRunButtons(true);
  try {
    if (!state.evidenceRows.length || !state.personas.length) {
      setStatus("먼저 근거 데이터를 수집하고 페르소나를 생성합니다...");
      const rows = await collectEvidence(settings);
      const selected = rows.slice(0, settings.personaCount);
      state.evidenceRows = rows;
      state.personas = selected.map((row, i) => makePersona(row, i, settings));
      renderEvidence(rows);
      renderPersonas(state.personas);
    }

    const prompt = buildGroundedPrompt(settings, state.evidenceRows, state.personas);
    state.lastPrompt = prompt;
    $("promptBackup").value = prompt;

    let answer;
    if (settings.geminiKey) {
      setStatus("Gemini API로 근거 기반 답변을 생성 중입니다...");
      answer = await callGemini(settings, prompt);
      $("answerMeta").textContent = "Gemini 생성 답변";
    } else {
      setStatus("API Key가 없어 로컬 규칙 기반 답변을 생성합니다. 프롬프트 백업을 복사해 LLM에 붙여넣을 수도 있습니다.");
      answer = localGroundedAnswer(settings, state.evidenceRows, state.personas);
      $("answerMeta").textContent = "로컬 규칙 기반 답변";
    }

    state.answer = answer;
    $("answer").textContent = answer;
    $("answer").classList.remove("empty");
    setStatus("데이터 기반 답변 생성 완료");
  } catch (err) {
    console.error(err);
    const fallback = localGroundedAnswer(settings, state.evidenceRows, state.personas);
    state.answer = fallback;
    $("answer").textContent = `${fallback}\n\n[API 호출 실패 안내]\n${err.message}\n\n프롬프트 백업을 복사해 Gemini 또는 ChatGPT에 직접 붙여넣어 사용할 수 있습니다.`;
    $("answer").classList.remove("empty");
    setStatus(`API 호출 실패. 로컬 답변으로 대체했습니다. 원인: ${err.message}`);
  } finally {
    disableRunButtons(false);
  }
}

function disableRunButtons(disabled) {
  ["btnGeneratePersonas", "btnAsk", "btnTest", "btnExportMd", "btnExportCsv"].forEach(id => $(id).disabled = disabled);
}

async function testConnection() {
  disableRunButtons(true);
  try {
    setStatus("Hugging Face Dataset Viewer API 연결 테스트 중...");
    const data = await hfFetch("rows", {
      dataset: DATASET_ID,
      config: CONFIG,
      split: SPLIT,
      offset: 0,
      length: 1
    });
    const row = normalizeRow(data.rows?.[0] || {}, 0);
    state.evidenceRows = [row];
    renderEvidence([row]);
    setStatus(`연결 성공: ${DATASET_ID} / ${CONFIG} / ${SPLIT}`);
  } catch (err) {
    console.error(err);
    setStatus(`연결 실패: ${err.message}`);
  } finally {
    disableRunButtons(false);
  }
}

function buildMarkdown() {
  const settings = getSettings();
  const lines = [];
  lines.push(`# ${settings.projectTheme}`);
  lines.push("");
  lines.push("## 제품 / 서비스 컨셉");
  lines.push(settings.concept);
  lines.push("");
  lines.push("## 질문");
  lines.push(settings.question);
  lines.push("");
  lines.push("## 데이터 기반 답변");
  lines.push(state.answer || "아직 생성된 답변이 없습니다.");
  lines.push("");
  lines.push("## 생성된 페르소나");
  for (const p of state.personas) {
    lines.push(`\n### ${p.id} · ${p.name || "합성 페르소나"}`);
    lines.push(`- 근거 row: ${p.sourceRow}`);
    lines.push(`- 사용자 유형: ${p.userType}`);
    lines.push(`- 기본 정보: ${p.sex} / ${p.education} / ${p.marital} / ${p.familyType} / ${p.housingType}`);
    lines.push(`- 생활 맥락: ${p.context}`);
    lines.push(`- 직업/역량 맥락: ${p.work}`);
    lines.push(`- 관심사: ${p.interests}`);
    lines.push(`- 니즈 가설: ${p.needsHypothesis.join(" / ")}`);
    lines.push(`- 우려 가설: ${p.concernsHypothesis.join(" / ")}`);
    lines.push(`- 인터뷰 질문: ${p.interviewQuestions.join(" / ")}`);
  }
  lines.push("\n## 근거 데이터");
  for (const [i, r] of state.evidenceRows.entries()) {
    lines.push(`\n### R${i + 1} · row ${r._row_idx}`);
    lines.push(`- 나이/성별: ${r.age} / ${r.sex}`);
    lines.push(`- 지역: ${r.province} ${r.district}`);
    lines.push(`- 직업: ${r.occupation}`);
    lines.push(`- persona: ${r.persona}`);
    lines.push(`- professional_persona: ${r.professional_persona}`);
    lines.push(`- family_persona: ${r.family_persona}`);
  }
  lines.push("\n## 주의사항");
  lines.push("Nemotron-Personas-Korea는 실제 사용자 인터뷰가 아니라 실제 분포를 반영해 생성된 합성 페르소나 데이터입니다. 본 결과는 가설 생성용이며, 실제 사용자 리서치로 검증해야 합니다.");
  return lines.join("\n");
}

function buildCsv() {
  const header = ["id", "source_row", "name", "age", "sex", "region", "occupation", "user_type", "context", "work", "interests", "needs_hypothesis", "concerns_hypothesis", "interview_questions"];
  const rows = state.personas.map(p => [
    p.id,
    p.sourceRow,
    p.name,
    p.age,
    p.sex,
    p.region,
    p.occupation,
    p.userType,
    p.context,
    p.work,
    p.interests,
    p.needsHypothesis.join(" | "),
    p.concernsHypothesis.join(" | "),
    p.interviewQuestions.join(" | ")
  ]);
  return [header, ...rows].map(cols => cols.map(csvEscape).join(",")).join("\n");
}

function csvEscape(value) {
  const s = String(value ?? "");
  return `"${s.replaceAll('"', '""')}"`;
}

function downloadText(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function resetAll() {
  state = { evidenceRows: [], personas: [], answer: "", lastPrompt: "" };
  $("answer").textContent = "아직 생성된 답변이 없습니다.";
  $("answer").classList.add("empty");
  $("personaCards").textContent = "아직 생성된 페르소나가 없습니다.";
  $("personaCards").classList.add("empty");
  $("evidenceTable").querySelector("tbody").innerHTML = "";
  $("promptBackup").value = "";
  $("answerMeta").textContent = "";
  $("personaMeta").textContent = "";
  $("evidenceMeta").textContent = "";
  setStatus("초기화 완료");
}

function init() {
  const saved = localStorage.getItem("k_persona_lab_gemini_key") || "";
  if (saved) $("geminiKey").value = saved;

  $("btnTest").addEventListener("click", testConnection);
  $("btnGeneratePersonas").addEventListener("click", generatePersonas);
  $("btnAsk").addEventListener("click", askGrounded);
  $("btnReset").addEventListener("click", resetAll);
  $("btnSaveKey").addEventListener("click", () => {
    localStorage.setItem("k_persona_lab_gemini_key", $("geminiKey").value.trim());
    setStatus("Gemini API Key를 브라우저 localStorage에 저장했습니다. GitHub 저장소에는 저장되지 않습니다.");
  });
  $("btnClearKey").addEventListener("click", () => {
    localStorage.removeItem("k_persona_lab_gemini_key");
    $("geminiKey").value = "";
    setStatus("Gemini API Key를 삭제했습니다.");
  });
  $("btnExportMd").addEventListener("click", () => downloadText("k-persona-lab-report.md", buildMarkdown(), "text/markdown;charset=utf-8"));
  $("btnExportCsv").addEventListener("click", () => downloadText("k-persona-lab-personas.csv", buildCsv(), "text/csv;charset=utf-8"));
  $("btnCopyPrompt").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("promptBackup").value || state.lastPrompt || "");
    setStatus("프롬프트를 클립보드에 복사했습니다.");
  });
}

document.addEventListener("DOMContentLoaded", init);
