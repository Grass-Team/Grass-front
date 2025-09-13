// ================================
// 환경설정
// ================================
const API_BASE = "http://13.125.81.117:8080"; // 백엔드 CORS 설정으로 직접 연결

// ================================
// 유틸
// ================================
const $  = (sel) => document.querySelector(sel);
const now = () => new Date().toLocaleTimeString();
const log = (m) => {
  const area = document.querySelector('#log');
  if (!area) return;

  const cls = (() => {
    if (/^📊 결과\s*\d+건 조회/.test(m)) return 'is-result';
    if (/^❌ 업로드 실패:/.test(m) || /^❌ 결과 조회 실패:/.test(m)) return 'is-error';
    if (/^✅ 이미지 업로드 완료:/.test(m) || /^🧪 분석 요청 전송:/.test(m)) return 'is-success';
    if (/^⏱️ 빠른 업데이트 (시작\(5초\)|종료)/.test(m)) return 'is-muted';
    return '';
  })();

  // 안전 이스케이프
  const safe = String(`${now()}  ${m}`).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));

  // 최신이 위로
  const html = `<span class="ln ${cls}">${safe}</span>`;
  area.innerHTML = html + area.innerHTML;

  // 결과 라인 살짝 반짝
  if (cls.includes('is-result')) {
    const first = area.querySelector('.ln');
    first && first.classList.add('flash');
    setTimeout(() => first && first.classList.remove('flash'), 900);
  }
};

// ================================
// 익명 사용자 ID
// ================================
const USER_ID_KEY = "ti_userId";
function getUserId() {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID?.() || ("anon-" + Date.now() + "-" + Math.floor(Math.random()*1e6)));
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

// ================================
// 상태
// ================================
let selectedFiles = []; // 선택된 파일들 (로컬 상태)

// ================================
// DOM
// ================================
const elFiles        = $("#files");
const elResultBody   = $("#resultBody");
const elResultSec    = $("#resultSection");
const elResultStatus = $("#resultStatus");
const elUploadStatus = $("#uploadStatus");

const btnAnalyze     = $("#btnAnalyze");
const btnResult      = $("#btnResult");
const btnPoll        = $("#btnPoll");
const elUploadProgress = $("#uploadProgress");
const elUploadText     = elUploadProgress?.querySelector(".status-text");

// 디버깅: DOM 요소들이 제대로 선택되었는지 확인
console.log("DOM 요소 확인:", {
  elFiles: !!elFiles,
  btnAnalyze: !!btnAnalyze,
  elUploadProgress: !!elUploadProgress,
  elUploadText: !!elUploadText
});

// ================================
// 결과 영역 표시/숨김
// ================================
function showResultSection(show) {
  if (!elResultSec) return;
  elResultSec.style.display = show ? "block" : "none";
  if (show) {
    elResultStatus && (elResultStatus.textContent = "분석을 시작했어요. 잠시 후 결과를 가져올게요… ⏳");
  } else {
    elResultStatus && (elResultStatus.textContent = "");
    elResultBody && (elResultBody.innerHTML = "");
  }
}

// ================================
// 파일 선택 → 로컬 상태 관리
// ================================
elFiles?.addEventListener("change", () => {
  const files = elFiles.files || [];
  
  if (!files.length) {
    selectedFiles = [];
    btnAnalyze && (btnAnalyze.disabled = true);
    if (elUploadProgress){
      elUploadProgress.classList.remove("is-loading","is-done","is-error");
      elUploadProgress.classList.add("is-idle");
    }
    elUploadText && (elUploadText.textContent = "파일을 선택해주세요.");
    return;
  }

  // 선택된 파일들을 로컬 상태에 저장
  selectedFiles = Array.from(files);
  
  // ✅ 완료 표시 + 분석 버튼 활성화
  if (elUploadProgress){
    elUploadProgress.classList.remove("is-loading","is-error","is-idle");
    elUploadProgress.classList.add("is-done");
  }
  elUploadText && (elUploadText.textContent = `파일 선택 완료: ${selectedFiles.length}개 (분석 준비됨)`);

  btnAnalyze && (btnAnalyze.disabled = false);
  console.log("파일 선택 완료, 총 선택된 파일 수:", selectedFiles.length);
  
  // 각 파일별로 개별 로그 기록
  selectedFiles.forEach((file) => {
    log(`📁 파일 선택 완료: ${file.name}`);
  });
});

// ================================
// 분석 요청 (선택된 파일들을 업로드하고 분석 요청)
// ================================
btnAnalyze?.addEventListener("click", async () => {
  if (selectedFiles.length === 0) return alert("먼저 이미지를 선택해 주세요 ✅");

  try {
    btnAnalyze.disabled = true;
    btnAnalyze.textContent = "업로드 및 분석 중...";
    
    // 1단계: 파일 업로드
    log("📤 파일 업로드 시작...");
    const userId = getUserId();
    const fd = new FormData();
    for (const f of selectedFiles) fd.append("files", f);
    const uploadUrl = `${API_BASE}/images/upload?userId=${encodeURIComponent(userId)}`;

    const uploadRes = await fetch(uploadUrl, { method: "POST", body: fd });
    const uploadData = await safeJson(uploadRes);

    if (!uploadRes.ok) {
      throw new Error(uploadData?.message || `업로드 실패: ${uploadRes.status}`);
    }

    const uploadedIds = uploadData?.response || uploadData?.data || uploadData;
    if (!Array.isArray(uploadedIds) || !uploadedIds.length) {
      throw new Error("서버가 imageId를 반환하지 않았습니다.");
    }

    log(`✅ 파일 업로드 완료: ${uploadedIds.length}개`);

    // 2단계: 분석 요청
    log("🧪 분석 요청 전송...");
    const analyzePayload = {
      userId: userId,
      s3Urls: uploadedIds, // 백엔드 명세: s3Urls
    };

    const analyzeRes = await fetch(`${API_BASE}/images/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(analyzePayload),
    });
    const analyzeData = await safeJson(analyzeRes);

    if (!analyzeRes.ok) {
      throw new Error(analyzeData?.message || `분석 요청 실패: ${analyzeRes.status}`);
    }

    log("✅ 분석 요청 완료");
    alert("분석을 시작했습니다! 🔍 잠시 후 결과를 보여드릴게요.");

    // 성공 시 결과 섹션 표시
    showResultSection(true);

    // 초기 조회 + 짧은 폴링
    await fetchResults();
    await quickPoll();
  } catch (e) {
    alert("처리에 실패했어요. 잠시 후 다시 시도해 주세요 🙏\n\n사유: " + e.message);
    log("❌ 처리 실패: " + e.message);
  } finally {
    btnAnalyze.disabled = false;
    btnAnalyze.textContent = "분석 시작";
  }
});

// ================================
// 결과 조회
// ================================
btnResult?.addEventListener("click", fetchResults);

async function fetchResults() {
  const userId = getUserId();

  try {
    btnResult && (btnResult.disabled = true);
    elResultStatus && (elResultStatus.textContent = "결과를 불러오는 중입니다… ⏳");

    const res  = await fetch(`${API_BASE}/images/result?userId=${encodeURIComponent(userId)}`);
    const data = await safeJson(res);

    if (!res.ok) {
      throw new Error(data?.message || String(res.status));
    }

    // ApiResult.ok(List<ViewImageResult>) 형태의 응답에서 실제 데이터 추출
    const items = data?.response || data?.data || data || [];
    renderResults(items);

    const count = items.length;
    if (elResultStatus) {
      elResultStatus.textContent = count
        ? `총 ${count}개의 결과를 불러왔어요. ✅`
        : "아직 결과가 준비되지 않았어요. 잠시 후 다시 시도해 주세요 ⌛";
    }
    log(`📊 결과 ${count}건 조회`);
  } catch (e) {
    alert("결과를 불러오지 못했어요. 잠시 후 다시 시도해 주세요 🙏\n\n사유: " + e.message);
    log("❌ 결과 조회 실패: " + e.message);
    elResultStatus && (elResultStatus.textContent = "결과를 불러오지 못했어요. 다시 시도해 주세요 🙏");
  } finally {
    btnResult && (btnResult.disabled = false);
  }
}

// 결과 테이블 렌더링 (상태 배지 포함)
function renderResults(arr) {
  if (!elResultBody) return;

  const klassByText = (txt) => {
    const t = (txt || "").toString().trim();
    if (/^양호$/i.test(t) || /^LOW$/i.test(t)) return { cls: "good", label: "양호", emoji: "✅" };
    if (/^주의$/i.test(t) || /^(MID|MEDIUM)$/i.test(t)) return { cls: "warn", label: "주의", emoji: "⚠️" };
    if (/^불량$|^손상$|^나쁨$/i.test(t) || /^HIGH$/i.test(t)) return { cls: "bad", label: "불량", emoji: "🚫" };
    return { cls: "", label: t || "—", emoji: "ℹ️" };
  };

  elResultBody.innerHTML = "";
  arr.forEach((r) => {
    const tr = document.createElement("tr");
    // ViewImageResult에서 가능한 필드명들 고려
    const imageId = r.imageId ?? r.id ?? r.image_id ?? r.s3Url ?? r.url ?? "-";
    const damageRaw = r.analysisResult ?? r.damage ?? r.status ?? r.result ?? 
                     r.condition ?? r.grassCondition ?? r.damageLevel ?? "";
    const status = klassByText(damageRaw);
    const statusHtml = status.cls
      ? `<span class="badge ${status.cls}">${status.emoji} ${status.label}</span>`
      : `<span class="badge">${status.emoji} ${status.label}</span>`;

    tr.innerHTML = `<td>${imageId}</td><td>${statusHtml}</td>`;
    elResultBody.appendChild(tr);
  });
}

// ================================
// 빠른 폴링(5초 동안 1초 주기)
// ================================
btnPoll?.addEventListener("click", quickPoll);

async function quickPoll() {
  const start = Date.now();
  log("⏱️ 빠른 업데이트 시작(5초)");
  while (Date.now() - start < 5000) {
    await fetchResults();
    await sleep(1000);
  }
  log("⏱️ 빠른 업데이트 종료");
}

// ================================
// 헬퍼: 응답 안전 파싱 & 데이터 정규화
// ================================
async function safeJson(res) {
  try { return await res.json(); }
  catch { return {}; }
}

// extractIds, extractResults 함수들은 더 이상 사용하지 않음
// ApiResult.ok(data) 형태의 응답을 직접 처리

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/* === 버튼 클릭 위치 기반 ripple 좌표 설정 === */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn');
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  btn.style.setProperty('--rx', `${e.clientX - r.left}px`);
  btn.style.setProperty('--ry', `${e.clientY - r.top}px`);
});

/* === Hero 패럴랙스(마우스 따라 살짝 이동) === */
(() => {
  const hero = document.querySelector('.ta-hero');
  const img = hero?.querySelector('.ta-hero-media img');
  if (!hero || !img) return;

  const strength = 12; // px
  let raf = 0;

  hero.addEventListener('mousemove', (e) => {
    const r = hero.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * 2;
    const y = ((e.clientY - r.top) / r.height - 0.5) * 2;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      img.style.transform = `translate3d(${x*strength}px, ${y*strength}px, 0) scale(1.03)`;
    });
  });
  hero.addEventListener('mouseleave', () => {
    cancelAnimationFrame(raf);
    img.style.transform = "";
  });
})();

/* === 업로드 카드 드래그&드롭 편의 + 하이라이트 === */
(() => {
  const card = document.querySelector('.ta-card[data-section="upload-analyze"]');
  const input = document.querySelector('#files');
  if (!card || !input) return;

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter','dragover'].forEach(ev => {
    card.addEventListener(ev, (e) => { stop(e); card.classList.add('is-dragover'); });
  });
  ['dragleave','drop'].forEach(ev => {
    card.addEventListener(ev, (e) => { stop(e); card.classList.remove('is-dragover'); });
  });
  card.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    input.files = e.dataTransfer.files;                 // 드롭 → 파일 입력 채움
    input.dispatchEvent(new Event('change', { bubbles: true })); // 기존 업로드 플로우 트리거
  });
})();

/* === 로그 줄 등장 애니메이션: prepend 직후 enter 클래스 부여 === */
(() => {
  const _log = window.log;
  if (typeof _log !== 'function') return;              // 안전장치
  window.log = (m) => {
    _log(m);
    const area = document.querySelector('#log');
    const first = area?.querySelector('.ln');
    if (first) {
      first.classList.add('enter');
      setTimeout(() => first.classList.remove('enter'), 260);
    }
  };
})();
