// ================================
// 환경설정
// ================================
const API_BASE = "http://localhost:8080";

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
let uploadedIds = new Set(); // 업로드되어 서버가 돌려준 이미지ID (전체 = 분석 대상)

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
// 파일 선택 → 자동 업로드
// ================================
elFiles?.addEventListener("change", async () => {
  const files = elFiles.files || [];
  btnAnalyze && (btnAnalyze.disabled = true);
  
  if (!files.length) {
    if (elUploadProgress){
      elUploadProgress.classList.remove("is-loading","is-done","is-error");
      elUploadProgress.classList.add("is-idle");
    }
    elUploadText && (elUploadText.textContent = "파일을 선택하면 자동으로 업로드됩니다.");
    return;
  }

  // 🔄 로딩 상태로 전환
  if (elUploadProgress){
    elUploadProgress.classList.remove("is-idle","is-done","is-error");
    elUploadProgress.classList.add("is-loading");
  }
  elUploadText && (elUploadText.textContent = `업로드 중… (${files.length}개)`);

  const userId = getUserId();
  const fd = new FormData();
  for (const f of files) fd.append("files", f); // 백엔드 명세: files (List<MultipartFile>)
  fd.append("userId", userId);                  // 구현 호환용 (form-field)
  const url = `${API_BASE}/images/upload?userId=${encodeURIComponent(userId)}`;

  try {
    const res  = await fetch(url, { method: "POST", body: fd });
    const data = await safeJson(res);

    if (!res.ok || data?.success === false) {
      throw new Error((data && (data.apiError || data.message)) || String(res.status));
    }

    const ids = extractIds(data);
    if (!ids.length) throw new Error("서버가 imageId를 반환하지 않았습니다.");

    uploadedIds = new Set(ids);

    // ✅ 완료 표시 + 분석 버튼 활성화
    if (elUploadProgress){
      elUploadProgress.classList.remove("is-loading","is-error","is-idle");
      elUploadProgress.classList.add("is-done");
    }
    elUploadText && (elUploadText.textContent = `업로드 완료: ${ids.length}개 (분석 준비됨)`);

    btnAnalyze && (btnAnalyze.disabled = false);
    log("✅ 이미지 업로드 완료: " + ids.join(", "));
  } catch (e) {
    alert("업로드에 실패했어요. 잠시 후 다시 시도해 주세요 🙏\n\n사유: " + e.message);
    log("❌ 업로드 실패: " + e.message);
    if (elUploadProgress){
      elUploadProgress.classList.remove("is-loading","is-done","is-idle");
      elUploadProgress.classList.add("is-error");
    }
    elUploadStatus && (elUploadStatus.textContent = "업로드 실패. 다시 시도해 주세요.");
    btnAnalyze && (btnAnalyze.disabled = true);
  }
});

// ================================
// 분석 요청 (업로드된 모든 ID 사용)
// ================================
btnAnalyze?.addEventListener("click", async () => {
  const ids = [...uploadedIds];
  if (ids.length === 0) return alert("먼저 이미지를 업로드해 주세요 ✅");

  const payload = {
    userId: getUserId(),
    imageIdStrings: ids, // 백엔드 명세: imageIdStrings
  };

  try {
    btnAnalyze.disabled = true;
    const res  = await fetch(`${API_BASE}/images/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await safeJson(res);

    if (!res.ok || data?.success === false) {
      throw new Error((data && (data.apiError || data.message)) || String(res.status));
    }

    log("🧪 분석 요청 전송: " + payload.imageIdStrings.join(", "));
    elUploadStatus && (elUploadStatus.textContent = "분석 중… 🔍");
    alert("분석을 시작했습니다! 🔍 잠시 후 결과를 보여드릴게요.");

    // 성공 시 결과 섹션 표시
    showResultSection(true);

    // 초기 조회 + 짧은 폴링
    await fetchResults();
    await quickPoll();
  } catch (e) {
    alert("분석 요청에 실패했어요. 잠시 후 다시 시도해 주세요 🙏\n\n사유: " + e.message);
    log("❌ 분석 요청 실패: " + e.message);
  } finally {
    btnAnalyze.disabled = false;
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

    if (!res.ok || data?.success === false) {
      throw new Error((data && (data.apiError || data.message)) || String(res.status));
    }

    const items = extractResults(data);
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
    const imageId = r.imageId ?? r.id ?? r.image_id ?? "-";
    const damageRaw = r.analysisResult ?? r.damage ?? r.status ?? r.result ?? "";
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

function extractIds(data) {
  if (Array.isArray(data?.response) && typeof data.response[0] === "string") return data.response;
  if (Array.isArray(data?.response) && data.response[0] && typeof data.response[0].id === "string") {
    return data.response.map(x => x.id);
  }
  if (Array.isArray(data?.imageIds)) return data.imageIds;
  if (Array.isArray(data) && typeof data[0] === "string") return data;
  if (Array.isArray(data) && data[0] && typeof data[0].id === "string") return data.map(x => x.id);
  if (typeof data?.imageId === "string") return [data.imageId];
  return [];
}

function extractResults(data) {
  if (Array.isArray(data?.response)) return data.response;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data)) return data;
  return [];
}

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
