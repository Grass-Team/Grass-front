// ================================
// 환경설정
// ================================
const HOST = "http://13.124.222.50:8080";
const UPLOAD_PATH = "/images/upload";
const ANALYZE_PATH = "/images/analyze";
const RESULT_PATH = "/images/result";
const FORM_FIELD = "files"; // @RequestParam("files")

// Mock 스위치: 기본값은 전부 false (실서버 사용)
// window.MOCK 이 외부에서 미리 정의돼 있으면 그대로 사용
window.MOCK = window.MOCK ?? { upload: false, analyze: false, result: false };
const MOCK = window.MOCK;
const MOCK_LATENCY = window.MOCK_LATENCY ?? {
  upload: 800,
  analyze: 900,
  resultPoll: 1200,
};

// 업로드 성공 시 서버가 돌려준 imageId들을 보관 + 로컬 미리보기용 파일
let uploadedImageIds = [];
let uploadedFiles = [];

// ================================
// 유틸
// ================================
const USER_ID_KEY = "ti_userId";
function getUserId() {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    id =
      crypto.randomUUID?.() ||
      `anon-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}
const $ = (s) => document.querySelector(s);

async function jsonOrThrow(res) {
  let text = "";
  try {
    text = await res.text();
  } catch {}
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok || data?.success === false) {
    const msg = data?.apiError || data?.message || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// 어떤 모양이 와도 '이미지 오브젝트'로 만들어 주는 파서
function extractParsedLambdaResult(data) {
  if (!data) return { parsed: [], count: 0 };
  const res = data.response;
  if (!res) return { parsed: [], count: 0 };

  // case A: result API가 배열로 주는 경우
  if (Array.isArray(res)) {
    return { parsed: res, count: res.length };
  }

  // case B: analyze/result 둘 다 lambdaResult 문자열로 주는 경우
  if (typeof res.lambdaResult === "string") {
    try {
      const inner = JSON.parse(res.lambdaResult || "{}");
      const arr = Object.values(inner || {});
      return { parsed: arr, count: arr.length };
    } catch (e) {
      console.warn("lambdaResult parse 실패:", e);
      return { parsed: [], count: 0 };
    }
  }

  // case C: lambdaResult가 객체로 오는 경우(백엔드 변경 대비)
  if (res && typeof res.lambdaResult === "object") {
    const arr = Object.values(res.lambdaResult || {});
    return { parsed: arr, count: arr.length };
  }

  return { parsed: [], count: 0 };
}

// 상태 문자열 표준화(백 응답 다양성 대비)
const STATUS_MAP = {
  good: "good",
  양호: "good",
  GOOD: "good",
  warn: "warn",
  주의: "warn",
  WARNING: "warn",
  caution: "warn",
  bad: "bad",
  불량: "bad",
  BAD: "bad",
};

// 원인 팔레트
const CAUSE_PALETTE = [
  "#63DB1F",
  "#FFD15C",
  "#FF6B6B",
  "#7AC6FF",
  "#B48CFF",
  "#FF9EC1",
];

function aggregateResults(items = []) {
  const perImage = [];
  let good = 0,
    bad = 0,
    warn = 0;

  // 원인 누산 테이블 (label -> 누적 값)
  const causeSum = new Map();

  const pick = (o, keys, def = undefined) => {
    for (const k of keys) {
      if (o && o[k] != null) return o[k];
    }
    return def;
  };

  for (const raw of items) {
    // 1) 상태 뽑기
    const statusRaw =
      pick(raw, ["analysisResult", "result", "status", "overallStatus"]) ||
      pick(raw?.result, ["status", "analysisResult"]) ||
      pick(raw?.summary, ["status"]);
    const norm =
      STATUS_MAP[statusRaw] ||
      STATUS_MAP[String(statusRaw || "").toLowerCase()] ||
      "bad";

    if (norm === "good") good += 1;
    else if (norm === "warn") warn += 1;
    else bad += 1;

    // 2) 원인 배열 후보군
    const causeArr =
      pick(raw, ["causes", "causeList", "reasons", "damageCauses"]) ||
      pick(raw?.result, ["causes", "causeList"]) ||
      pick(raw?.summary, ["causes"]) ||
      [];

    // 가능한 키들로 라벨/값 읽기
    const parsedCauses = [];
    for (const c of Array.isArray(causeArr) ? causeArr : []) {
      const label = pick(c, ["label", "type", "name", "causeLabel"], "원인");
      const v = Number(pick(c, ["percent", "pct", "value", "ratio"], 0)) || 0;

      if (!label) continue;
      parsedCauses.push({ label: String(label), pct: Math.max(0, v) });
      causeSum.set(label, (causeSum.get(label) || 0) + Math.max(0, v));
    }

    perImage.push({
      imageId: pick(raw, ["imageId", "id"], ""),
      status: norm,
      causes: parsedCauses,
    });
  }

  // 전체 비율 계산
  const total = good + bad + warn || 1;
  const goodPct = Math.round((good / total) * 100);
  const badPct = Math.round((bad / total) * 100);
  // 경고는 도넛 모델상 ‘불량’과 분리할지 여부 선택: 지금은 불량에 포함 X
  // 필요하면: const badLikePct = Math.round(((bad + warn) / total) * 100);

  // 원인 정규화(퍼센트 합 100 되게)
  const causeEntries = [...causeSum.entries()];
  const causeTotal = causeEntries.reduce((a, [, v]) => a + v, 0) || 0;

  let remain = 100;
  const causes = causeEntries
    .sort((a, b) => b[1] - a[1])
    .map(([label, v], idx, arr) => {
      const basePct = causeTotal
        ? Math.round((v / causeTotal) * 100)
        : idx === 0
        ? 100
        : 0;
      const pct = idx === arr.length - 1 ? remain : Math.min(remain, basePct);
      remain -= pct;
      return {
        label,
        value: pct, // swapToResults에서 value를 퍼센트로 사용
        valueColor: CAUSE_PALETTE[idx % CAUSE_PALETTE.length],
      };
    });

  return {
    overall: { goodPct, badPct },
    causes,
    perImage,
  };
}

/** 집계 결과로 swapToResults 호출용 DTO를 만들어 렌더 */
function renderAggregated(items) {
  const agg = aggregateResults(items);
  swapToResults({
    good: agg.overall.goodPct,
    bad: agg.overall.badPct,
    segments: agg.causes,
  });
  return agg; // 필요 시 per-image 상태에 활용
}

// ================================
// 초기/성공 UI 렌더링
// ================================
let onUploadClick = null;
let onAnalyzeClick = null;

function ensureStatusEl() {
  let statusEl = document.getElementById("uploadStatus");
  if (!statusEl) {
    statusEl = document.createElement("p");
    statusEl.id = "uploadStatus";
    statusEl.className = "ta-status";
    const g3 = document.querySelector(".ta-group-3");
    g3 && g3.appendChild(statusEl);
  }
  return statusEl;
}

function renderInitialUI() {
  const kicker = document.querySelector(".ta-group-1 .ta-kicker");
  const sub = document.querySelector(".ta-group-1 .ta-sub");
  if (kicker) kicker.textContent = "분석할 잔디 이미지를 업로드 해주세요❕";
  if (sub) sub.textContent = "최대 10장 업로드 가능";

  const group2 = document.querySelector(".ta-group-2");
  if (group2) group2.hidden = false;

  const btnReset = document.getElementById("btnReset");
  if (btnReset) btnReset.remove();

  const btnUpload = document.getElementById("btnUpload");
  const input = document.getElementById("fileInput");
  if (btnUpload) {
    btnUpload.textContent = "이미지 업로드";
    btnUpload.classList.remove("btn-analyze");
    btnUpload.disabled = false;

    if (onAnalyzeClick) btnUpload.removeEventListener("click", onAnalyzeClick);
    if (onUploadClick) btnUpload.removeEventListener("click", onUploadClick);

    onUploadClick = () => input && input.click();
    btnUpload.addEventListener("click", onUploadClick);
  }

  const statusEl = ensureStatusEl();
  statusEl.textContent = "";

  if (input) input.value = "";
  uploadedImageIds = [];

  // 인라인 결과(옛날 미리보기) 제거
  const inline = document.getElementById("resultAreaInline");
  if (inline) inline.remove();
}

function renderAfterUploadSuccess(files) {
  const arr = Array.isArray(files) ? files : [];
  const count = arr.length;
  if (count === 0) {
    renderInitialUI();
    return;
  }

  const firstName = arr[0]?.name || `${count}개`;
  const labelText =
    count === 1 ? `${firstName}` : `${firstName} 외 ${count - 1}장`;

  const kicker = document.querySelector(".ta-group-1 .ta-kicker");
  const sub = document.querySelector(".ta-group-1 .ta-sub");
  const group2 = document.querySelector(".ta-group-2");
  const btnUpload = document.getElementById("btnUpload");

  if (kicker) kicker.textContent = "이미지 업로드 완료 ✅";
  if (sub) {
    sub.innerHTML = `<span class="u" style="text-decoration:underline">${labelText}</span>`;
    if (!document.getElementById("btnReset")) {
      const btnReset = document.createElement("button");
      btnReset.id = "btnReset";
      btnReset.type = "button";
      btnReset.className = "btn ghost";
      btnReset.textContent = "초기화";
      btnReset.style.marginLeft = "12px";
      sub.insertAdjacentElement("afterend", btnReset);
      btnReset.addEventListener("click", onReset);
    }
  }

  if (group2) group2.hidden = true;

  if (btnUpload) {
    btnUpload.textContent = "분석하기";
    btnUpload.classList.add("btn-analyze");
    btnUpload.disabled = false;

    if (onUploadClick) btnUpload.removeEventListener("click", onUploadClick);
    if (onAnalyzeClick) btnUpload.removeEventListener("click", onAnalyzeClick);

    onAnalyzeClick = handleAnalyzeClick;
    btnUpload.addEventListener("click", onAnalyzeClick);
  }
}

async function onReset() {
  renderInitialUI();
}

// ================================
// 분석 → 결과 표시
// ================================
async function handleAnalyzeClick() {
  const userId = getUserId();
  if (!uploadedImageIds.length) {
    alert("분석할 이미지 ID가 없습니다. 먼저 이미지를 업로드해 주세요.");
    return;
  }

  const btn = document.getElementById("btnUpload");
  const statusEl = ensureStatusEl();

  try {
    btn.disabled = true;
    statusEl.innerHTML = `<span class="dot"></span> 분석을 시작했어요…`;

    // 🔹 분석 요청 → 서버가 결과를 즉시 내려줌
    const analyzeData = await callAnalyze(userId, uploadedImageIds);

    // 🔹 백엔드 응답에서 바로 결과 꺼내 렌더링
    consumeAnalyzeResponse(analyzeData);

    statusEl.textContent = `분석이 완료됐어요. ✅`;
  } catch (e) {
    alert(`분석 실패: ${e.message}`);
    statusEl.textContent = `오류: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

/**
 * 백엔드 응답(response.lambdaResult 문자열)을 파싱해
 * good/bad 비율과 원인 분포(segments)를 계산한다.
 * @param {string} lambdaResultStr - JSON 문자열
 * @param {object} opts
 *   - useTop1PerImage: true면 각 불량 이미지의 최고 confidence 1개만 원인에 반영(기본)
 *                      false면 해당 이미지의 모든 detection을 원인 집계에 반영
 *   - confThresh: confidence 하한 (기본 0)
 * @returns {{
 *   good: number, bad: number,
 *   segments: Array<{label:string, value:number}>,
 *   perImage: Array<{input:string, output:string, status:'양호'|'불량', topCause?:string}>
 * }}
 */
/**
 * 백에서 내려오는 lambdaResult(JSON 또는 이중-문자열 JSON)를 요약해
 * 전체 '양호/불량' 수와 원인별 집계를 만든다.
 *
 * @param {string|object} lambdaResultStr - 백 응답의 response.lambdaResult (문자열이거나 객체)
 * @param {object} opts
 *   - useTop1PerImage {boolean} : 이미지당 최고 confidence 1개만 원인으로 집계 (기본 true)
 *   - confThresh      {number}  : confidence 임계값 (기본 0.3)
 *   - labelMap        {Object}  : { "충해잔디.기타충해": "충해/기타", ... } 같은 통합 맵
 *
 * @returns {{
 *   good:number, bad:number, goodPct:number, badPct:number, total:number,
 *   segments:Array<{label:string, value:number}>,
 *   perImage:Array<{input:string, output:string, status:"양호"|"불량", topCause?:string}>
 * }}
 */
function summarizeLambdaResult(lambdaResultStr, opts = {}) {
  const {
    useTop1PerImage = false, // 모든 원인을 수집
    confThresh = 0.3, // confidence 임계값
    labelMap = null, // 백엔드 라벨 매핑 필요시
  } = opts;

  // 1️⃣ 입력 파싱 (문자열, 중첩 JSON 모두 허용)
  let parsed = lambdaResultStr;
  try {
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
      if (typeof parsed === "string") parsed = JSON.parse(parsed); // 이중 인코딩 방어
    }
  } catch (e) {
    console.warn("⚠️ lambdaResult JSON 파싱 실패:", e, lambdaResultStr);
    return {
      good: 0,
      bad: 0,
      goodPct: 0,
      badPct: 0,
      total: 0,
      segments: [],
      perImage: [],
    };
  }

  // 2️⃣ 이미지 리스트 추출
  const images =
    parsed && typeof parsed === "object" ? Object.values(parsed) : [];
  if (!images.length) {
    console.warn("⚠️ lambdaResult 내 이미지 데이터 없음:", parsed);
    return {
      good: 0,
      bad: 0,
      goodPct: 0,
      badPct: 0,
      total: 0,
      segments: [],
      perImage: [],
    };
  }

  let good = 0,
    bad = 0;
  const perImage = [];
  const causeCounts = new Map(); // label → count

  const mapLabel = (raw) => {
    const s = String(raw ?? "원인 미상");
    return labelMap && labelMap[s] ? labelMap[s] : s;
  };

  // 3️⃣ 각 이미지 순회
  for (const item of images) {
    const input = item?.input_image || "";
    const output = item?.result_image || "";
    const dets = Array.isArray(item?.detections) ? item.detections : [];

    // confidence 필터
    const valid = dets.filter(
      (d) => (Number(d?.confidence) || 0) >= confThresh
    );

    console.log("[IMG]", {
      input: item?.input_image,
      detCount: Array.isArray(item?.detections) ? item.detections.length : 0,
      labels: (item?.detections || []).map((d) => d?.class_name),
      confs: (item?.detections || []).map((d) => d?.confidence),
    });

    // 🔹 탐지 없음 → 양호
    if (valid.length === 0) {
      good++;
      perImage.push({ input, output, status: "양호", causes: [] });
      continue;
    }

    // 🔹 탐지 있음 → 불량
    bad++;

    if (useTop1PerImage) {
      // 대표 1개만
      const top = valid.reduce((a, b) =>
        a.confidence >= b.confidence ? a : b
      );
      const l = mapLabel(top?.class_name);
      causeCounts.set(l, (causeCounts.get(l) || 0) + 1);
      perImage.push({ input, output, status: "불량", causes: [l] });
    } else {
      // 모든 원인 누적
      const labels = valid.map((d) => mapLabel(d?.class_name));
      labels.forEach((l) => causeCounts.set(l, (causeCounts.get(l) || 0) + 1));
      perImage.push({ input, output, status: "불량", causes: labels });
    }
  }

  // 4️⃣ 전체 손상 원인 정렬
  const segments = Array.from(causeCounts.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  // 5️⃣ 비율 계산
  const total = good + bad;
  const goodPct = total ? Math.round((good / total) * 100) : 0;
  const badPct = total ? 100 - goodPct : 0;

  // 6️⃣ 콘솔 디버깅용 출력
  console.log("📊 [summarizeLambdaResult] 요약 결과:", {
    total,
    good,
    bad,
    goodPct,
    badPct,
    segments,
    perImageCount: perImage.length,
  });

  return { good, bad, goodPct, badPct, total, segments, perImage };
}

// 실제 분석 호출(백 연결용)
async function callAnalyze(userId, ids) {
  // ⛔️ 0개만 반환되던 JSON 본문 방식
  // const url = `${HOST}${ANALYZE_PATH}?userId=${encodeURIComponent(userId)}`;
  // const body = {
  //   userId: userId,
  //   imageIdStrings: ids
  // };

  // ✅ 7, 8개라도 반환했던 원래의 쿼리 파라미터 방식으로 복원
  const query = ids
    .map((id) => `imageIdStrings=${encodeURIComponent(id)}`)
    .join("&");
  const url = `${HOST}${ANALYZE_PATH}?userId=${encodeURIComponent(
    userId
  )}&${query}`;

  console.log("[ANALYZE] 요청 URL (쿼리 파라미터 방식):", url);
  console.log("[ANALYZE] 요청 IDs:", ids);
  console.log("[✅ upload 완료] imageIds:", uploadedImageIds);

  const res = await fetch(url, {
    method: "POST",
    // ⛔️ JSON 본문 제거
    // headers: {
    //   "Content-Type": "application/json",
    // },
    // body: JSON.stringify(body),
    cache: "no-store",
  });

  const data = await jsonOrThrow(res);
  console.log("[🟢 callAnalyze] 서버 응답 데이터:", data);
  return data;
}

function showSkeleton(show) {
  let sk = document.getElementById("resultSkeleton");
  if (!sk) {
    sk = document.createElement("div");
    sk.id = "resultSkeleton";
    sk.className = "skeleton-wrap";
    sk.innerHTML = `
      <div class="skeleton title"></div>
      <div class="skeleton line"></div>
      <div class="skeleton line"></div>
      <div class="skeleton line"></div>
    `;
    const g3 = document.querySelector(".ta-group-3");
    g3 && g3.appendChild(sk);
  }
  sk.hidden = !show;
}

// ================================
// 메인: 버튼 → 파일 선택 → 업로드
// ================================
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnUpload");
  const input = document.getElementById("fileInput");
  if (!btn || !input) return;

  // ✅ 첫 화면은 항상 업로드 화면
  renderInitialUI();

  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    const statusEl = ensureStatusEl();
    if (!files.length) return;

    if (files.length > 10) {
      statusEl.textContent = "최대 10장까지 업로드할 수 있어요.";
      input.value = "";
      return;
    }

    const MAX_SIZE_MB = 5;
    const tooLarge = files.find((f) => f.size > MAX_SIZE_MB * 1024 * 1024);
    if (tooLarge) {
      const mb = (tooLarge.size / (1024 * 1024)).toFixed(1);
      statusEl.textContent = `⚠️ '${tooLarge.name}' 파일이 너무 큽니다 (${mb}MB). ${MAX_SIZE_MB}MB 이하로 줄여주세요.`;
      input.value = ""; // 입력 초기화
      alert(
        `'${tooLarge.name}' 파일이 너무 커서 업로드할 수 없습니다.\n(현재: ${mb}MB / 제한: ${MAX_SIZE_MB}MB)`
      );
      return;
    }

    btn.disabled = true;
    statusEl.innerHTML = `<span class="dot"></span> 업로드 중… (${files.length}개)`;
    uploadedFiles = files; // 썸네일/미리보기용

    try {
      if (MOCK.upload) {
        await mockWait(MOCK_LATENCY.upload);
        uploadedImageIds = mockImageIdsFromFiles(files);
      } else {
        const fd = new FormData();
        files.forEach((f) => fd.append(FORM_FIELD, f));
        const userId = getUserId();
        fd.append("userId", userId);

        // ✅ 새 사양: POST /images/upload (쿼리스트링 없이)
        const url = `${HOST}${UPLOAD_PATH}`;
        console.log("[UPLOAD]", url);
        const res = await fetch(url, { method: "POST", body: fd });
        const data = await jsonOrThrow(res);

        uploadedImageIds = Array.isArray(data?.response)
          ? data.response
          : Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data)
          ? data
          : [];
      }

      statusEl.textContent = "업로드가 완료되었습니다. ✅";
      renderAfterUploadSuccess(files);
    } catch (err) {
      statusEl.textContent = `업로드 실패: ${err.message}`;
      alert(`업로드 중 오류가 발생했습니다.\n\n${err.message}`);
    } finally {
      input.value = "";
      btn.disabled = false;
    }
  });
});

// 업로드 카드 내용을 지우고 '분석 결과' 화면으로 교체
function swapToResults(ratios) {
  // 결과 카드 확보
  const card =
    document.getElementById("resultsCard") ||
    document.querySelector('.ta-card[data-section="upload-analyze"]');
  if (!card) return;
  card.id = "resultsCard";

  // ✅ 전역 요약/사진별 데이터 확보
  const summary = window._lastSummary || {};
  const perImageArr = Array.isArray(ratios?.perImage)
    ? ratios.perImage
    : Array.isArray(summary?.perImage)
    ? summary.perImage
    : Array.isArray(window._lastPerImageArr)
    ? window._lastPerImageArr
    : [];

  console.log("[swapToResults] perImageArr:", perImageArr);

  // 전체 비율 계산
  const g = Math.max(0, Number(ratios?.good ?? summary?.goodPct ?? 0));
  const b = Math.max(0, Number(ratios?.bad ?? summary?.badPct ?? 0));
  const sum = g + b || 1;
  const goodPct = Math.round((g / sum) * 100);
  const badPct = 100 - goodPct;

  // 색상
  const GOOD = ratios?.goodValueColor || "#63DB1F";
  const BAD = ratios?.badValueColor || "#FF6B6B";

  // 손상 원인 세그먼트
  const segments = ratios?.segments?.length
    ? ratios.segments
    : summary?.segments || [];
  const norm = normalizeSegments(segments);
  const bg = buildConicGradient(norm);
  const ranked = [...norm].sort((a, b) => b.pct - a.pct);

  // 왼쪽: 양호/불량 도넛
  const leftBlock = `
    <div class="res-1-b-a left" style="--good-color:${GOOD}; --bad-color:${BAD};">
      <div class="donut-wrap">
        <div class="donut2" style="--good:${goodPct};"></div>
        <div class="donut-center"><div class="donut-title">잔디 상태</div></div>
      </div>
      <div class="donut-legend">
        <div class="legend-item good">
          <span class="legend-label">양호</span>
          <span class="legend-value">${goodPct}%</span>
        </div>
        <div class="legend-item bad">
          <span class="legend-label">불량</span>
          <span class="legend-value">${badPct}%</span>
        </div>
      </div>
    </div>`;

  // 오른쪽: 손상 원인 도넛
  const rightBlock = `
    <div class="res-1-b-a">
      <div class="donut-wrap">
        <div class="donutN" style="background:${bg}"></div>
        <div class="donut-center"><div class="donut-title">손상 원인</div></div>
      </div>
      <div class="donut-legend legend-col">
        ${ranked
          .map(
            (s, i) => `
          <div class="legend-row" style="--val-color:${
            s.valueColor || s.color
          }">
            <span class="legend-rank">#${i + 1}</span>
            <span class="legend-label">${s.label}</span>
            <span class="legend-value">${s.pct}%</span>
          </div>`
          )
          .join("")}
      </div>
    </div>`;

  // 요약 문장
  const topCauseLabel = ranked[0]?.label || "손상 원인 없음";
  const summaryHTML =
    goodPct > badPct
      ? `전반적으로 잔디 상태가 <span class="hl" style="color:${GOOD}">양호</span>합니다.`
      : `전반적으로 잔디 상태가 <span class="hl" style="color:${BAD}">불량</span>하며 <span class="hl">${topCauseLabel}</span>가 가장 심각합니다.`;

  // 메인 결과 카드
  card.classList.add("ta-results");
  card.setAttribute("data-section", "upload-analyze");
  card.innerHTML = `
    <div class="res-1">
      <div class="res-1-a"><span class="res-title">분석 결과</span></div>
      <div class="res-1-b">
        ${leftBlock}
        ${rightBlock}
      </div>
      <div class="res-extra-box" id="resSummaryBox">
        <div class="res-extra-text">${summaryHTML}</div>
      </div>
      <div class="res-extra-box" id="resStaticBox">
        <div class="res-extra-head">📙 손상 원인 사전</div>
        <div class="res-extra-desc">
          예: 각 손상 유형의 정의/예시 문구를 여기에 넣어주세요.
        </div>
      </div>
    </div>
  `;

  // ✅ 사진별 분석 카드
  const perImageCard = document.createElement("section");
  perImageCard.className = "ta-card ta-results";
  perImageCard.setAttribute("data-section", "upload-analyze");
  perImageCard.dataset.subsection = "per-image";
  perImageCard.id = "perImageResultsCard";
  perImageCard.innerHTML = `
    <div class="res-1">
      <div class="res-1-a"><span class="res-title">사진별 분석</span></div>
    </div>`;
  card.insertAdjacentElement("afterend", perImageCard);

  // ✅ 사진별 상세 블록
  const buildDetailBlock = (idx) => {
    const imgInfo = perImageArr[idx] || {};
    const src = imgInfo.input || imgInfo.output || "";

    const statusGood = imgInfo.status === "양호";
    const statusText = statusGood ? "양호" : "불량";

    const causeRows =
      !statusGood && Array.isArray(imgInfo.causes) && imgInfo.causes.length
        ? imgInfo.causes
            .map(
              (c, i) => `
            <div class="legend-row slim">
              <span class="legend-rank">#${i + 1}</span>
              <span class="legend-label">${c}</span>
            </div>`
            )
            .join("")
        : "";

    return `
      <div class="res-2 perimage-hero">
        <div class="perimage-photo">
          ${src ? `<img src="${src}" alt="업로드 이미지 ${idx + 1}" />` : ""}
        </div>
        <div class="perimage-side">
          <div class="status-value ${
            statusGood ? "is-good" : "is-bad"
          }">${statusText}</div>
          ${causeRows ? `<div class="perimage-causes">${causeRows}</div>` : ""}
        </div>
      </div>`;
  };

  // ✅ 썸네일 목록
  const buildThumbs = () => {
    if (!perImageArr.length) return "";
    const items = perImageArr
      .map(
        (img, i) => `
      <button class="perimage-thumb ${
        i === 0 ? "is-active" : ""
      }" data-index="${i}">
        ${img.input ? `<img src="${img.input}" alt="썸네일 ${i + 1}" />` : ""}
      </button>`
      )
      .join("");
    return `<div class="res-3 perimage-thumbs">${items}</div>`;
  };

  // 초기 렌더
  if (perImageArr.length) {
    perImageCard.insertAdjacentHTML("beforeend", buildDetailBlock(0));
    perImageCard.insertAdjacentHTML("beforeend", buildThumbs());
  } else {
    perImageCard.insertAdjacentHTML(
      "beforeend",
      `<p style="color:#ccc;">📁 분석된 이미지가 없습니다.</p>`
    );
  }

  // ✅ 썸네일 클릭 이벤트
  perImageCard.addEventListener("click", (e) => {
    const btn = e.target.closest(".perimage-thumb");
    if (!btn) return;
    const idx = Number(btn.dataset.index);

    // 썸네일 선택 표시 갱신
    perImageCard
      .querySelectorAll(".perimage-thumb")
      .forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");

    // 기존 큰 이미지 영역 제거
    const prev = perImageCard.querySelector(".perimage-hero");
    if (prev) prev.remove();

    // 새 이미지 블록을 썸네일 영역 "앞"에 삽입
    const thumbs = perImageCard.querySelector(".perimage-thumbs");
    if (thumbs) {
      thumbs.insertAdjacentHTML("beforebegin", buildDetailBlock(idx));
    } else {
      perImageCard.insertAdjacentHTML("beforeend", buildDetailBlock(idx));
    }
  });

  // === 🧭 그래프 hover 툴팁 ===
  const tooltip = document.getElementById("chartTooltip");

  // 헬퍼: 툴팁 표시
  function showTooltip(x, y, text) {
    if (!tooltip) return;
    tooltip.textContent = text;
    tooltip.style.left = `${x + 12}px`;
    tooltip.style.top = `${y + 12}px`;
    tooltip.hidden = false;
    tooltip.classList.add("show");
  }

  // 헬퍼: 툴팁 숨기기
  function hideTooltip() {
    if (!tooltip) return;
    tooltip.hidden = true;
    tooltip.classList.remove("show");
  }

  // 왼쪽 도넛 (양호/불량)
  const donutLeft = card.querySelector(".donut2");
  if (donutLeft) {
    donutLeft.addEventListener("mousemove", (e) => {
      const rect = donutLeft.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;

      const text =
        angle < (goodPct / 100) * 360
          ? "양호: " + goodPct + "%"
          : "불량: " + badPct + "%";
      showTooltip(e.clientX, e.clientY, text);
    });
    donutLeft.addEventListener("mouseleave", hideTooltip);
  }

  // 오른쪽 도넛 (손상 원인)
  const donutRight = card.querySelector(".donutN");
  if (donutRight && ranked.length) {
    donutRight.addEventListener("mousemove", (e) => {
      const rect = donutRight.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;

      // 각 손상 원인 비율 범위 계산
      let acc = 0;
      let hovered = ranked.find((s) => {
        const start = acc;
        const end = acc + (s.pct / 100) * 360;
        acc = end;
        return angle >= start && angle < end;
      });

      if (hovered) {
        showTooltip(e.clientX, e.clientY, `${hovered.label}: ${hovered.pct}%`);
      } else {
        hideTooltip();
      }
    });
    donutRight.addEventListener("mouseleave", hideTooltip);
  }
}

function consumeAnalyzeResponse(data) {
  console.log("[RAW]", data);

  // ==============================
  // ① 형식 B: 백에서 직접 overall / causes 제공 시 (즉시 도넛 그릴 수 있는 형식)
  // ==============================
  const overall = data?.overall || data?.response?.overall;
  const causes = data?.causes || data?.response?.causes;

  if (overall && Array.isArray(causes)) {
    console.log("[🟢 형식 B 감지] overall / causes 기반");

    const good = Number(overall.goodPct ?? 0);
    const bad = Number(overall.badPct ?? 0);

    const segments = causes.map((c) => ({
      label: String(c.label ?? "-"),
      value: Number(c.pct ?? 0), // swapToResults 내부에서 정규화
      color: c.color || undefined,
      valueColor: c.color || undefined,
    }));

    // 전체 요약 저장 (사진별 데이터는 없으므로 빈 배열)
    window._lastSummary = { good, bad, segments };
    window._lastPerImageArr = [];

    swapToResults({ good, bad, segments });
    return;
  }

  // ==============================
  // ② 형식 A: lambdaResult(JSON 문자열) → summarizeLambdaResult()로 파싱
  // ==============================
  console.log("[🟣 consumeAnalyzeResponse] 원본 데이터:", data);

  const { parsed } = extractParsedLambdaResult(data);
  if (parsed && (Array.isArray(parsed) || typeof parsed === "object")) {
    const summary = summarizeLambdaResult(parsed, {
      useTop1PerImage: false,
      confThresh: 0.3,
    });

    console.log("[🟢 summary 결과]:", summary);

    // 📦 전역 보관 (사진별 분석에서도 사용)
    window._lastSummary = summary;
    window._lastPerImageArr = Array.isArray(summary.perImage)
      ? summary.perImage
      : [];

    // 도넛 및 손상 원인 반영
    swapToResults({
      good: summary.goodPct,
      bad: summary.badPct,
      segments: summary.segments.map((s) => ({
        label: s.label,
        value: s.value,
      })),
    });
    return;
  }

  // ==============================
  // ③ 인식 불가능한 형식 → 오류 처리
  // ==============================
  console.warn("⚠️ consumeAnalyzeResponse: 알 수 없는 응답 형식", data);
  alert("서버 응답 형식을 해석할 수 없습니다. 콘솔 로그를 확인하세요.");
}

/*
 * 백엔드 결과를 polling하며 모든 이미지 결과가 채워질 때까지 대기
 * @param {string} userId
 * @param {number} expectedCount
 * @param {number} timeoutMs
 * @param {number} intervalMs
 */
async function waitForFullResults(userId, expectedCount, intervalMs = 3000) {
  let lastCount = 0;
  let lastProgressAt = Date.now(); // 진행 시각 초기화
  const MAX_IDLE_MS = 120000; // 필요시 조정(120초)
  let tries = 0;
  const statusEl = ensureStatusEl();

  while (true) {
    tries++;

    const url = `${HOST}${RESULT_PATH}?userId=${encodeURIComponent(
      userId
    )}&_ts=${Date.now()}`;
    console.log("[RES] URL:", url);

    // ---- (A) 네트워크 요청 & 원문 로깅 ----
    const res = await fetch(url, { cache: "no-store" });
    const raw = await res.text();
    console.log("[RES] status:", res.status);
    console.log("[RES] raw:", raw);

    // ---- (B) JSON 파싱 (jsonOrThrow 대체) ----
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn("[RES] json parse error:", e);
      throw new Error(`/images/result 응답 JSON 파싱 실패`);
    }
    if (!res.ok || data?.success === false) {
      const msg =
        data?.apiError || data?.message || raw || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    // ---- (C) 응답 형태 탐색 로그 ----
    const resp = data?.response;
    console.log(
      "[RES] typeof response:",
      Array.isArray(resp) ? "array" : typeof resp
    );
    console.log(
      "[RES] keys(response):",
      resp && !Array.isArray(resp) ? Object.keys(resp) : null
    );
    console.log("[RES] typeof lambdaResult:", typeof resp?.lambdaResult);
    console.log(
      "[RES] lambdaResult sample:",
      (resp?.lambdaResult || "").slice(0, 120)
    );

    console.log(
      "🔎 current /images/result body:",
      JSON.stringify(data, null, 2)
    );

    // ---- (D) 표준화 파싱 + 카운트 ----
    const { parsed, count } = extractParsedLambdaResult(data);
    console.log(
      `[RES] parsedType=${
        Array.isArray(parsed) ? "array" : typeof parsed
      }, count=${count}/${expectedCount}, try=${tries}`
    );

    if (statusEl) {
      statusEl.innerHTML = `<span class="dot"></span> 결과를 수신 중… (${count}/${expectedCount})`;
    }

    // ✅ 모두 도착하면 종료
    if (count >= expectedCount) {
      console.log(`✅ 모든 이미지 결과 수신 완료 (${count}/${expectedCount})`);
      return data;
    }

    // 새 결과가 생기면 진행시각 갱신
    if (count > lastCount) {
      console.log(`📸 새 이미지 ${count - lastCount}개 도착`);
      lastCount = count;
      lastProgressAt = Date.now();
    }

    // 3회 연속 0건이면 재트리거(선택)
    if (lastCount === 0 && tries === 3) {
      console.warn("⚠️ no progress x3 → re-trigger analyze");
      try {
        await callAnalyze(userId, uploadedImageIds);
      } catch (e) {
        console.error("❌ re-trigger failed:", e);
      }
      lastProgressAt = Date.now();
    }

    // 정체 타임아웃
    if (Date.now() - lastProgressAt > MAX_IDLE_MS) {
      throw new Error(
        `결과가 ${Math.round(
          MAX_IDLE_MS / 1000
        )}초 동안 갱신되지 않았어요. 서버 상태를 확인해 주세요.`
      );
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// 1) 팔레트
const SEGMENT_PALETTE = [
  "#63DB1F",
  "#FFD15C",
  "#FF6B6B",
  "#7AC6FF",
  "#B48CFF",
  "#FF9EC1",
];

// 2) 정규화
function normalizeSegments(segments = []) {
  const arr = segments.map((s, idx) => {
    const label = String(s?.label ?? "-");
    const value = Math.max(0, Number(s?.value ?? 0)) || 0;
    const color = s?.color || SEGMENT_PALETTE[idx % SEGMENT_PALETTE.length];
    const valueColor = s?.valueColor || color;
    return { label, value, color, valueColor };
  });
  const sum = arr.reduce((a, b) => a + b.value, 0);
  if (!arr.length || sum === 0) {
    return [
      {
        label: "데이터 없음",
        value: 1,
        color: "#666",
        valueColor: "#666",
        pct: 100,
      },
    ];
  }
  let remain = 100;
  return arr.map((s, i) => {
    const pct =
      i === arr.length - 1 ? remain : Math.round((s.value / sum) * 100);
    remain -= pct;
    return { ...s, pct };
  });
}

// 3) conic-gradient
function buildConicGradient(segmentsWithPct) {
  let acc = 0;
  const stops = segmentsWithPct.map((s) => {
    const start = acc;
    const end = acc + s.pct;
    acc = end;
    return `${s.color} ${start}% ${end}%`;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

// ✅ 강제 프리뷰 제거: DOMContentLoaded에서 결과 미리 렌더하지 않음
document.addEventListener("DOMContentLoaded", () => {
  if (typeof renderInitialUI === "function") renderInitialUI();
});