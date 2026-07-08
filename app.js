const DATASET_ID = "nvidia/Nemotron-Personas-Korea";
const API_BASE = "https://datasets-server.huggingface.co";
const MAX_COLLECT = 1000;
const PROVINCES = [
  "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시", "울산광역시", "세종특별자치시",
  "경기도", "강원특별자치도", "충청북도", "충청남도", "전북특별자치도", "전라남도", "경상북도", "경상남도", "제주특별자치도"
];

const state = {
  config: "default",
  split: "train",
  totalRows: null,
  matched: [],
  scanned: 0,
  apiCalls: 0,
  startedAt: null,
  isSearching: false,
  stopRequested: false,
  lastCriteria: null
};

const $ = (id) => document.getElementById(id);

function init() {
  renderProvinceList();
  bindEvents();
  resolveDataset().catch(err => {
    setStatus("데이터셋 연결 확인 실패", true);
    log(`데이터셋 메타데이터 확인 실패: ${err.message}`);
  });
}

function bindEvents() {
  $("selectAllRegions").addEventListener("click", () => setAllRegions(true));
  $("clearRegions").addEventListener("click", () => setAllRegions(false));
  $("runSearch").addEventListener("click", runSearch);
  $("stopSearch").addEventListener("click", () => {
    state.stopRequested = true;
    log("중지 요청됨. 현재 API 호출이 끝나면 멈춥니다.");
  });
  $("clearResults").addEventListener("click", clearResults);
  $("exportExcel").addEventListener("click", exportExcel);
  $("exportCsv").addEventListener("click", exportCsv);
  $("answerQuestion").addEventListener("click", answerQuestion);
}

function renderProvinceList() {
  const wrap = $("provinceList");
  wrap.innerHTML = PROVINCES.map((p, index) => `
    <label class="check-item">
      <input type="checkbox" value="${escapeHtml(p)}" ${index === 0 || p === "경기도" ? "checked" : ""} />
      <span>${escapeHtml(p)}</span>
    </label>
  `).join("");
}

function setAllRegions(checked) {
  document.querySelectorAll("#provinceList input[type='checkbox']").forEach(input => input.checked = checked);
}

async function resolveDataset() {
  setStatus("데이터셋 메타데이터 확인 중");
  const url = `${API_BASE}/splits?dataset=${encodeURIComponent(DATASET_ID)}`;
  const data = await fetchJson(url);
  const splits = data.splits || [];
  const train = splits.find(item => item.split === "train") || splits[0];
  if (train) {
    state.config = train.config || "default";
    state.split = train.split || "train";
  }
  setStatus(`연결됨 · config=${state.config}, split=${state.split}`);
  log(`데이터셋 연결 완료: ${DATASET_ID}\nconfig=${state.config}, split=${state.split}`);
}

async function fetchJson(url, retry = 2) {
  for (let attempt = 0; attempt <= retry; attempt++) {
    const res = await fetch(url, { headers: { "Accept": "application/json" }});
    if (res.ok) return await res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retry) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
}

function getCriteria() {
  const targetCount = clampInt($("targetCount").value, 1, MAX_COLLECT, 300);
  const scanLimit = clampInt($("scanLimit").value, 100, 1000000, 30000);
  const startOffset = clampInt($("startOffset").value, 0, 1000000, 0);
  const batchSize = clampInt($("batchSize").value, 10, 100, 100);
  const provinces = Array.from(document.querySelectorAll("#provinceList input:checked")).map(el => el.value);
  const ageMin = parseOptionalNumber($("ageMin").value);
  const ageMax = parseOptionalNumber($("ageMax").value);
  const sex = $("sex").value;
  const occupationKeywords = splitKeywords($("occupationKeywords").value);
  const familyType = normalize($("familyType").value);
  const housingType = normalize($("housingType").value);
  const educationLevel = normalize($("educationLevel").value);
  const interestKeywords = splitKeywords($("interestKeywords").value);
  const productTopic = normalize($("productTopic").value);

  return {
    targetCount,
    scanLimit,
    startOffset,
    batchSize,
    provinces,
    ageMin,
    ageMax,
    sex,
    occupationKeywords,
    familyType,
    housingType,
    educationLevel,
    interestKeywords,
    productTopic
  };
}

async function runSearch() {
  if (state.isSearching) return;

  const criteria = getCriteria();
  state.lastCriteria = criteria;
  state.matched = [];
  state.scanned = 0;
  state.apiCalls = 0;
  state.startedAt = Date.now();
  state.isSearching = true;
  state.stopRequested = false;

  updateButtons();
  updateProgress();
  renderTable();
  renderCards();
  $("answerBox").textContent = "검색이 완료되면 질문 답변을 만들 수 있습니다.";
  log("검색 시작");
  log(`목표 수집 인원: ${criteria.targetCount}명 / 최대 검색 행 수: ${criteria.scanLimit.toLocaleString()}행`);

  try {
    let offset = criteria.startOffset;
    const endOffset = criteria.startOffset + criteria.scanLimit;

    while (!state.stopRequested && state.matched.length < criteria.targetCount && offset < endOffset) {
      const length = Math.min(criteria.batchSize, endOffset - offset);
      const url = buildRowsUrl(offset, length);
      const data = await fetchJson(url);
      state.apiCalls += 1;

      const rows = data.rows || [];
      if (!rows.length) {
        log("더 이상 가져올 행이 없습니다.");
        break;
      }

      for (const item of rows) {
        state.scanned += 1;
        const row = item.row || item;
        const rowIdx = item.row_idx ?? offset + state.scanned;
        if (matchesCriteria(row, criteria)) {
          state.matched.push({ row_idx: rowIdx, ...row });
          if (state.matched.length >= criteria.targetCount) break;
        }
      }

      offset += rows.length;
      updateProgress();
      if (state.apiCalls % 5 === 0 || state.matched.length >= criteria.targetCount) {
        log(`진행: 검색 ${state.scanned.toLocaleString()}행, 수집 ${state.matched.length.toLocaleString()}명`);
        renderTable();
        renderCards();
      }
      await sleep(80);
    }

    if (state.stopRequested) log("사용자 요청으로 검색을 중지했습니다.");
    else if (state.matched.length >= criteria.targetCount) log("목표 인원 수집 완료.");
    else log("검색 한도까지 확인했지만 목표 인원에 도달하지 못했습니다. 조건을 완화하거나 검색 행 수/시작 위치를 조정하세요.");
  } catch (err) {
    log(`오류 발생: ${err.message}`);
  } finally {
    state.isSearching = false;
    updateButtons();
    updateProgress();
    renderTable();
    renderCards();
    if (state.matched.length > 0) {
      $("answerQuestion").disabled = false;
    }
  }
}

function buildRowsUrl(offset, length) {
  const params = new URLSearchParams({
    dataset: DATASET_ID,
    config: state.config,
    split: state.split,
    offset: String(offset),
    length: String(length)
  });
  return `${API_BASE}/rows?${params.toString()}`;
}

function matchesCriteria(row, c) {
  const province = normalize(row.province);
  const district = normalize(row.district);
  const age = parseAge(row.age);
  const sex = normalize(row.sex);
  const occupation = normalize(row.occupation);
  const familyType = normalize(row.family_type);
  const housingType = normalize(row.housing_type);
  const educationLevel = normalize(row.education_level);

  if (c.provinces.length && !c.provinces.includes(province)) return false;
  if (c.ageMin !== null && age !== null && age < c.ageMin) return false;
  if (c.ageMax !== null && age !== null && age > c.ageMax) return false;
  if (c.sex && !matchesSex(sex, c.sex)) return false;

  const occupationText = `${occupation} ${normalize(row.professional_persona)} ${normalize(row.persona)}`;
  if (c.occupationKeywords.length && !containsAny(occupationText, c.occupationKeywords)) return false;

  if (c.familyType && !containsAny(familyType, splitKeywords(c.familyType))) return false;
  if (c.housingType && !containsAny(housingType, splitKeywords(c.housingType))) return false;
  if (c.educationLevel && !containsAny(educationLevel, splitKeywords(c.educationLevel))) return false;

  if (c.interestKeywords.length) {
    const interestText = combinedText(row, [
      "persona", "hobbies_and_interests", "sports_persona", "arts_persona", "travel_persona", "culinary_persona",
      "cultural_background", "skills_and_expertise", "career_goals_and_ambitions", "family_persona"
    ]);
    if (!containsAny(interestText, c.interestKeywords)) return false;
  }

  return true;
}

function makePersonaRow(row, index, topic) {
  const id = `P-${String(index + 1).padStart(3, "0")}`;
  const location = [row.province, row.district].filter(Boolean).join(" ");
  const base = `${location} 거주 ${row.age ?? ""}세 ${row.sex ?? ""} ${row.occupation ?? ""}`.replace(/\s+/g, " ").trim();
  const needs = inferNeeds(row, topic);
  const concerns = inferConcerns(row, topic);
  const reaction = inferReaction(row, topic, needs, concerns);
  const questions = makeInterviewQuestions(row, topic, needs, concerns);

  return {
    "페르소나 ID": id,
    "원본 row_idx": row.row_idx ?? "",
    "이름": row.name ?? "",
    "기본 유형": base,
    "지역": location,
    "나이": row.age ?? "",
    "성별": row.sex ?? "",
    "직업": row.occupation ?? "",
    "가족 형태": row.family_type ?? "",
    "주거 형태": row.housing_type ?? "",
    "교육 수준": row.education_level ?? "",
    "요약 페르소나": row.persona ?? "",
    "생활 맥락": row.family_persona ?? "",
    "직업 맥락": row.professional_persona ?? "",
    "관심사": row.hobbies_and_interests ?? "",
    "기술/전문성": row.skills_and_expertise ?? "",
    "목표/포부": row.career_goals_and_ambitions ?? "",
    "제품/서비스 주제": topic,
    "예상 니즈 가설": needs.join(" / "),
    "예상 우려 가설": concerns.join(" / "),
    "컨셉 반응 가설": reaction,
    "가상 인터뷰 질문": questions.join("\n"),
    "근거 필드": "province, district, age, sex, occupation, family_type, housing_type, education_level, persona, family_persona, professional_persona, hobbies_and_interests, skills_and_expertise, career_goals_and_ambitions"
  };
}

function makeUxRow(persona) {
  return {
    "UX 페르소나 ID": persona["페르소나 ID"],
    "사용자 유형": persona["기본 유형"],
    "제품/서비스 주제": persona["제품/서비스 주제"],
    "생활 맥락": persona["생활 맥락"],
    "직업/역량 맥락": persona["직업 맥락"],
    "관심사": persona["관심사"],
    "예상 니즈 가설": persona["예상 니즈 가설"],
    "예상 불편/우려 가설": persona["예상 우려 가설"],
    "컨셉 반응 가설": persona["컨셉 반응 가설"],
    "인터뷰 질문": persona["가상 인터뷰 질문"]
  };
}

function inferNeeds(row, topic) {
  const needs = [];
  const text = combinedText(row, ["persona", "family_persona", "professional_persona", "hobbies_and_interests", "skills_and_expertise", "career_goals_and_ambitions"]);
  const age = parseAge(row.age);
  const family = normalize(row.family_type);
  const job = normalize(row.occupation);

  if (age !== null && age >= 50) needs.push("복잡한 설정 없이 이해하기 쉬운 사용 흐름");
  if (age !== null && age < 35) needs.push("빠른 개인화와 즉각적인 추천 경험");
  if (containsAny(family, ["자녀", "가족", "부부", "다세대"])) needs.push("가족 구성원별 취향과 권한을 분리하는 기능");
  if (containsAny(job, ["디자인", "기획", "연구", "개발", "전문", "마케팅"])) needs.push("자신의 취향과 맥락을 세밀하게 조정할 수 있는 제어권");
  if (containsAny(text, ["여행", "음식", "예술", "스포츠", "콘텐츠", "기술", "AI"])) needs.push("관심사 기반 추천의 정확도와 다양성");
  if (!needs.length) needs.push("일상 맥락에 맞는 편리하고 신뢰 가능한 사용 경험");
  return unique(needs).slice(0, 4);
}

function inferConcerns(row, topic) {
  const concerns = [];
  const text = combinedText(row, ["persona", "family_persona", "professional_persona", "hobbies_and_interests", "skills_and_expertise", "career_goals_and_ambitions"]);
  const age = parseAge(row.age);
  const family = normalize(row.family_type);

  if (age !== null && age >= 45) concerns.push("개인정보와 시청 데이터가 어떻게 활용되는지에 대한 우려");
  if (containsAny(family, ["자녀", "가족", "다세대"])) concerns.push("가족 구성원 간 추천이 섞이거나 사생활이 노출될 가능성");
  if (containsAny(text, ["기술", "개발", "연구", "전문", "데이터", "AI"])) concerns.push("AI 추천의 근거와 통제 가능성 부족");
  if (containsAny(text, ["바쁜", "업무", "직장", "커리어", "목표"])) concerns.push("초기 설정과 관리에 드는 시간 부담");
  if (!concerns.length) concerns.push("새로운 기능의 실제 효용이 충분히 체감되지 않을 가능성");
  return unique(concerns).slice(0, 4);
}

function inferReaction(row, topic, needs, concerns) {
  const location = [row.province, row.district].filter(Boolean).join(" ");
  const base = `${location} ${row.age ?? ""}세 ${row.occupation ?? ""}`.replace(/\s+/g, " ").trim();
  return `${base} 페르소나는 ${topic || "해당 서비스"}에 대해 ${needs[0]}을 기대할 가능성이 있습니다. 다만 ${concerns[0]}이 해소되어야 긍정적 반응으로 이어질 가능성이 큽니다. 이 해석은 원본 합성 페르소나의 지역, 연령, 직업, 가족/주거 맥락, 관심사 필드를 근거로 만든 가설입니다.`;
}

function makeInterviewQuestions(row, topic, needs, concerns) {
  return [
    `${topic || "이 서비스"}가 현재 생활에서 어떤 상황에 가장 도움이 될 것 같으신가요?`,
    `${needs[0]}이 실제로 필요하다고 느끼는 구체적 장면은 언제인가요?`,
    `${concerns[0]}에 대해 어느 정도까지 설명되면 안심하고 사용할 수 있으신가요?`,
    `가족, 직장, 취미 맥락 중 어떤 기준으로 개인화되기를 원하시나요?`,
    `이 기능을 계속 사용하게 만들기 위해 반드시 필요한 조건은 무엇인가요?`
  ];
}

function renderTable() {
  const wrap = $("tableWrap");
  if (!state.matched.length) {
    wrap.className = "table-wrap empty";
    wrap.textContent = "아직 수집된 데이터가 없습니다.";
    return;
  }
  wrap.className = "table-wrap";
  const cols = ["row_idx", "name", "age", "sex", "province", "district", "occupation", "family_type", "housing_type", "education_level", "persona"];
  const rows = state.matched.slice(0, 120);
  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.map(row => `<tr>${cols.map(c => `<td>${escapeHtml(shorten(row[c], 180))}</td>`).join("")}</tr>`).join("")}
      </tbody>
    </table>
  `;
}

function renderCards() {
  const wrap = $("cardsWrap");
  if (!state.matched.length) {
    wrap.className = "cards-grid empty";
    wrap.textContent = "검색 후 페르소나 카드가 생성됩니다.";
    return;
  }
  wrap.className = "cards-grid";
  const topic = state.lastCriteria?.productTopic || normalize($("productTopic").value);
  const personaRows = state.matched.slice(0, 24).map((row, idx) => makePersonaRow(row, idx, topic));
  wrap.innerHTML = personaRows.map(p => `
    <article class="card">
      <h3>${escapeHtml(p["페르소나 ID"])} · ${escapeHtml(p["이름"])}</h3>
      <div class="meta">${escapeHtml(p["기본 유형"])} · row ${escapeHtml(p["원본 row_idx"])}</div>
      <div class="block"><strong>요약</strong><p>${escapeHtml(shorten(p["요약 페르소나"], 260))}</p></div>
      <div class="block"><strong>예상 니즈 가설</strong><p>${escapeHtml(p["예상 니즈 가설"])}</p></div>
      <div class="block"><strong>예상 우려 가설</strong><p>${escapeHtml(p["예상 우려 가설"])}</p></div>
      <div class="block"><strong>컨셉 반응 가설</strong><p>${escapeHtml(shorten(p["컨셉 반응 가설"], 360))}</p></div>
    </article>
  `).join("");
}

function exportExcel() {
  if (!state.matched.length) return;
  const topic = state.lastCriteria?.productTopic || normalize($("productTopic").value);
  const rawRows = state.matched.map(flattenRow);
  const personaRows = state.matched.map((row, idx) => makePersonaRow(row, idx, topic));
  const uxRows = personaRows.map(makeUxRow);
  const conditionRows = criteriaToRows(state.lastCriteria || getCriteria());
  const summaryRows = makeSummaryRows(state.matched);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rawRows), "1_Raw_Data");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(personaRows), "2_Persona_Cards");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(uxRows), "3_UX_Research");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "4_Evidence_Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(conditionRows), "5_Search_Conditions");

  const filename = `nemotron_personas_${formatDateForFile(new Date())}_${state.matched.length}rows.xlsx`;
  XLSX.writeFile(wb, filename);
}

function exportCsv() {
  if (!state.matched.length) return;
  const rawRows = state.matched.map(flattenRow);
  const ws = XLSX.utils.json_to_sheet(rawRows);
  const csv = XLSX.utils.sheet_to_csv(ws);
  downloadText(csv, `nemotron_raw_${formatDateForFile(new Date())}_${state.matched.length}rows.csv`, "text/csv;charset=utf-8");
}

function answerQuestion() {
  const q = normalize($("questionInput").value);
  if (!q) {
    $("answerBox").textContent = "질문을 입력해 주세요.";
    return;
  }
  if (!state.matched.length) {
    $("answerBox").textContent = "먼저 데이터를 수집해 주세요.";
    return;
  }

  const topic = state.lastCriteria?.productTopic || normalize($("productTopic").value);
  const rows = state.matched;
  const keywords = splitKeywords(q).filter(k => k.length >= 2);
  const hitRows = keywords.length ? rows.filter(row => containsAny(rowToSearchText(row), keywords)) : rows;
  const basis = hitRows.length ? hitRows : rows;
  const distProvince = topDistribution(basis, "province", 5);
  const distOccupation = topDistribution(basis, "occupation", 5);
  const distFamily = topDistribution(basis, "family_type", 5);
  const samplePersonas = basis.slice(0, 5).map((row, idx) => {
    const p = makePersonaRow(row, idx, topic);
    return `- row ${p["원본 row_idx"]}: ${p["기본 유형"]} / 니즈: ${p["예상 니즈 가설"]} / 우려: ${p["예상 우려 가설"]}`;
  }).join("\n");

  const answer = [
    `질문: ${q}`,
    "",
    `근거 범위: 수집된 ${rows.length.toLocaleString()}명 중 질문 키워드와 직접 연결된 행 ${basis.length.toLocaleString()}명을 우선 참고했습니다.`,
    "",
    "데이터 기반 요약 가설:",
    makeQuestionHypothesis(q, basis, topic),
    "",
    "주요 근거 분포:",
    `- 지역: ${distProvince}`,
    `- 직업: ${distOccupation}`,
    `- 가족 형태: ${distFamily}`,
    "",
    "대표 근거 샘플:",
    samplePersonas,
    "",
    "주의: 이 답변은 Nemotron-Personas-Korea의 합성 페르소나 데이터에서 추출한 근거 기반 가설이며, 실제 사용자 조사 결과로 단정하면 안 됩니다."
  ].join("\n");

  $("answerBox").textContent = answer;
}

function makeQuestionHypothesis(question, rows, topic) {
  const personaRows = rows.slice(0, 80).map((row, idx) => makePersonaRow(row, idx, topic));
  const needCounts = countTokens(personaRows.flatMap(p => p["예상 니즈 가설"].split(" / ")));
  const concernCounts = countTokens(personaRows.flatMap(p => p["예상 우려 가설"].split(" / ")));
  const topNeeds = Object.entries(needCounts).sort((a,b) => b[1] - a[1]).slice(0,3).map(([k]) => k);
  const topConcerns = Object.entries(concernCounts).sort((a,b) => b[1] - a[1]).slice(0,3).map(([k]) => k);
  return `이 집단은 ${topic || "해당 주제"}에 대해 ${topNeeds.join(", ")}을 기대할 가능성이 있습니다. 반면 ${topConcerns.join(", ")}이 주요 장벽으로 나타날 가능성이 있습니다. 따라서 컨셉 제안 시 개인화의 편익뿐 아니라 데이터 사용 방식, 가족 구성원 분리, 사용자가 직접 조정할 수 있는 통제권을 함께 제시하는 방향이 적합합니다.`;
}

function makeSummaryRows(rows) {
  const fields = ["province", "sex", "occupation", "family_type", "housing_type", "education_level"];
  const out = [];
  fields.forEach(field => {
    const counts = topDistributionPairs(rows, field, 20);
    counts.forEach(([value, count]) => {
      out.push({ "필드": field, "값": value, "건수": count, "비율": `${((count / rows.length) * 100).toFixed(1)}%` });
    });
  });
  return out;
}

function criteriaToRows(c) {
  return Object.entries(c || {}).map(([key, value]) => ({
    "조건": key,
    "값": Array.isArray(value) ? value.join(", ") : String(value ?? "")
  }));
}

function updateButtons() {
  $("runSearch").disabled = state.isSearching;
  $("stopSearch").disabled = !state.isSearching;
  $("exportExcel").disabled = state.isSearching || !state.matched.length;
  $("exportCsv").disabled = state.isSearching || !state.matched.length;
  $("answerQuestion").disabled = state.isSearching || !state.matched.length;
}

function updateProgress() {
  const c = state.lastCriteria || getCriteria();
  const pct = Math.min(100, (state.scanned / Math.max(1, c.scanLimit)) * 100);
  $("progressBar").style.width = `${pct}%`;
  $("matchedCount").textContent = state.matched.length.toLocaleString();
  $("scannedCount").textContent = state.scanned.toLocaleString();
  $("apiCount").textContent = state.apiCalls.toLocaleString();
  $("elapsedTime").textContent = state.startedAt ? `${Math.round((Date.now() - state.startedAt) / 1000)}s` : "0s";
}

function clearResults() {
  state.matched = [];
  state.scanned = 0;
  state.apiCalls = 0;
  state.startedAt = null;
  state.stopRequested = false;
  state.lastCriteria = null;
  $("logBox").textContent = "대기 중입니다.";
  $("answerBox").textContent = "검색 결과가 생성되면 질문 답변을 만들 수 있습니다.";
  updateProgress();
  updateButtons();
  renderTable();
  renderCards();
}

function setStatus(text, isError = false) {
  const el = $("datasetStatus");
  el.textContent = text;
  el.style.color = isError ? "#b42318" : "#6e6e73";
}

function log(text) {
  const box = $("logBox");
  const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  box.textContent = box.textContent === "대기 중입니다." ? `[${time}] ${text}` : `${box.textContent}\n[${time}] ${text}`;
  box.scrollTop = box.scrollHeight;
}

function splitKeywords(value) {
  return normalize(value)
    .split(/[,.，、\n]/)
    .map(v => v.trim())
    .filter(Boolean);
}

function containsAny(text, keywords) {
  const t = normalize(text).toLowerCase();
  return keywords.some(k => t.includes(normalize(k).toLowerCase()));
}

function matchesSex(value, target) {
  const v = normalize(value).toLowerCase();
  if (!target) return true;
  if (target === "male") return ["male", "m", "man", "남성", "남자"].some(x => v.includes(x));
  if (target === "female") return ["female", "f", "woman", "여성", "여자"].some(x => v.includes(x));
  return true;
}

function combinedText(row, fields) {
  return fields.map(f => normalize(row[f])).join(" ");
}

function rowToSearchText(row) {
  return combinedText(row, Object.keys(row));
}

function parseAge(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const match = String(value).match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalize(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 0);
  return String(value).trim();
}

function flattenRow(row) {
  const out = {};
  Object.entries(row).forEach(([k, v]) => {
    out[k] = typeof v === "object" && v !== null ? JSON.stringify(v, null, 0) : v;
  });
  return out;
}

function topDistribution(rows, field, limit = 5) {
  const pairs = topDistributionPairs(rows, field, limit);
  if (!pairs.length) return "값 없음";
  return pairs.map(([value, count]) => `${value} ${count}명`).join(", ");
}

function topDistributionPairs(rows, field, limit = 5) {
  const counts = {};
  rows.forEach(row => {
    const value = normalize(row[field]) || "미기재";
    counts[value] = (counts[value] || 0) + 1;
  });
  return Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, limit);
}

function countTokens(items) {
  const out = {};
  items.forEach(item => {
    const key = normalize(item);
    if (key) out[key] = (out[key] || 0) + 1;
  });
  return out;
}

function unique(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function shorten(value, max = 140) {
  const text = normalize(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeHtml(value) {
  return normalize(value).replace(/[&<>'"]/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[ch]));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDateForFile(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

init();
