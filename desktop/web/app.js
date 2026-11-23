// 芹查：瀏覽器介面
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  state: null,
  config: null,
  phone: { connected: false },
  session: null,
  pendingJumpMarker: null,
  latestBitmap: null,
  view: 'live',
  noteFilter: 'todo',
  noteProject: localStorage.getItem('cc.noteProject') || '',
  tool: localStorage.getItem('cc.tool') || 'rect',
  color: localStorage.getItem('cc.color') || '#ff3b30',
  keyListen: null, // 設定頁正在等使用者按鍵
  review: null,
  notePage: null,
};

const STATUS_LABEL = { open: '待修', reopened: '退回重修', fixed: '已修好，待驗收', closed: '已結案' };
const KEY_NAMES = { ' ': '空白鍵', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', PageUp: 'PageUp', PageDown: 'PageDown', Enter: 'Enter' };

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || `${r.status}`);
  return data;
}

let toastTimer;
function toast(msg, err = false, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', err);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return `${sameDay ? '今天' : `${d.getMonth() + 1}/${d.getDate()}`} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function keyName(k) {
  return KEY_NAMES[k] || (k.length === 1 ? k.toUpperCase() : k);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`讀不到圖片 ${src}`));
    img.src = src;
  });
}

function isTyping(e) {
  const t = e.target;
  if (!t || !t.tagName) return false;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.tagName === 'INPUT') return !['range', 'checkbox', 'button'].includes(t.type);
  return t.isContentEditable;
}

function projectOptions(selected, withAll = false) {
  const projects = S.config?.projects || [];
  let html = withAll ? `<option value="">全部專案</option>` : `<option value="">未分類</option>`;
  for (const p of projects) html += `<option value="${esc(p.name)}" ${p.name === selected ? 'selected' : ''}>${esc(p.name)}</option>`;
  return html;
}

function projectByName(name) {
  return (S.config?.projects || []).find((p) => p.name === name) || null;
}


// ---------------------------------------------------------------------------
// 狀態與即時連線
// ---------------------------------------------------------------------------

async function refreshState() {
  S.state = await api('GET', '/api/state');
  S.config = S.state.config;
  S.phone = S.state.phone;
  S.session = S.state.session;
  updateStatusUi();
  updateKeyHints();
}

let liveWs = null;
function connectLive() {
  liveWs = new WebSocket(`ws://${location.host}/live`);
  liveWs.binaryType = 'blob';
  liveWs.onmessage = async (ev) => {
    if (typeof ev.data === 'string') return onLiveMessage(JSON.parse(ev.data));
    try {
      const bmp = await createImageBitmap(ev.data);
      const old = S.latestBitmap;
      S.latestBitmap = bmp;
      drawLive();
      drawVerifyLive();
      if (old) old.close();
    } catch {
      /* 壞掉的格就跳過 */
    }
  };
  liveWs.onclose = () => {
    S.phone = { connected: false };
    updateStatusUi();
    $('#phoneText').textContent = '芹查伺服器沒有回應';
    setTimeout(connectLive, 1500);
  };
}

function onLiveMessage(msg) {
  if (msg.type === 'status' || msg.type === 'hello' || msg.type === 'phone') {
    const was = S.phone.connected;
    S.phone = msg.phone;
    if ('session' in msg) S.session = msg.session;
    updateStatusUi();
    if (was !== S.phone.connected && S.view === 'live') renderLive();
    if (msg.type === 'phone' && msg.event === 'connected') toast('手機已連上');
    if (msg.type === 'phone' && msg.event === 'disconnected') toast('手機已停止投影');
  } else if (msg.type === 'clip' || msg.type === 'marker') {
    if (S.view === 'live') renderRecentClips();
    if (S.view === 'clips') renderClips();
    if (S.view === 'review' && S.review?.clip?.id === msg.clip?.id) reloadReviewClip();
  } else if (msg.type === 'projects') {
    refreshState().then(() => {
      if (S.view === 'live') $('#liveProject').innerHTML = projectOptions(S.session ? S.session.project : S.config?.lastProject || '');
      if (S.view === 'review' && S.review) renderReviewHead();
    });
  } else if (msg.type === 'notes-changed') {
    refreshBadge();
    if (S.view === 'notes') renderNotes();
    if (S.view === 'note' && S.notePage && !isTypingInNotePage()) renderNotePage(S.notePage.id);
  }
}

function updateStatusUi() {
  const pill = $('#phonePill');
  const p = S.phone || {};
  pill.classList.toggle('on', !!p.connected);
  $('#phoneText').textContent = p.connected ? `${p.device || 'iPhone'} 投影中 · ${p.fps || 0} 格/秒` : '手機未連線';

  const ses = S.session;
  const rec = $('#recPill');
  rec.hidden = !ses;
  if (ses) {
    rec.href = `#review/${ses.id}`;
    rec.innerHTML = `● 第 ${ses.number} 場測試中 ${fmtDur(Date.now() - ses.startedAt)} · ${ses.markers} 個書籤`;
  }
  const btn = $('#btnSession');
  btn.classList.toggle('on', !!ses);
  $('#sessionLabel').textContent = ses ? `結束測試（${fmtDur(Date.now() - ses.startedAt)}）` : '開始測試';
  $('#markLabel').textContent = ses && ses.markers ? `插書籤（已插 ${ses.markers} 個）` : '插書籤';
  $('#btnReviewNow').hidden = !ses;
  if (S.view === 'live') {
    $('#liveMeta').innerHTML = p.connected
      ? `畫面 ${p.width}×${p.height}<br>手機：${esc(p.device || '')}${p.model ? `（${esc(p.model)}）` : ''}<br>畫面沒變動時手機不會送新格，格數變少是正常的。`
      : '';
  }
}

function updateKeyHints() {
  const mk = (S.config?.markKeys || []).map(keyName).join(' / ');
  const rk = (S.config?.recordKeys || []).map(keyName).join(' / ');
  $('#markHint').textContent = mk ? `${mk}（或踩踏板）` : '未設定按鍵';
  $('#sessionHint').textContent = rk || '未設定按鍵';
  $('#preSecText').textContent = S.config?.preSeconds ?? 20;
}

async function refreshBadge() {
  try {
    const todo = await api('GET', '/api/notes?status=open,reopened');
    const b = $('#todoBadge');
    b.hidden = !todo.length;
    b.textContent = todo.length;
  } catch {}
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

function route() {
  const h = location.hash.replace(/^#/, '') || 'live';
  const [view, arg] = h.split('/');
  if (S.view === 'review' && view !== 'review') leaveReview();
  S.view = view;
  for (const sec of $$('.view')) sec.hidden = sec.id !== `view-${view}`;
  const tab = view === 'review' ? 'clips' : view === 'note' ? 'notes' : view;
  for (const a of $$('.tabs a')) a.classList.toggle('on', a.dataset.tab === tab);
  if (view === 'live') renderLive();
  else if (view === 'clips') renderClips();
  else if (view === 'review') openReview(arg);
  else if (view === 'notes') renderNotes();
  else if (view === 'note') renderNotePage(arg);
  else if (view === 'settings') renderSettings();
  if (view !== 'note') S.notePage = null;
}

// ---------------------------------------------------------------------------
// 即時畫面
// ---------------------------------------------------------------------------

function renderLive() {
  const connected = !!S.phone?.connected;
  $('#pairCard').hidden = connected;
  $('#liveCanvas').hidden = !connected;
  if (!connected) loadPair();
  $('#liveProject').innerHTML = projectOptions(S.session ? S.session.project : S.config?.lastProject || '');
  drawLive();
  renderRecentClips();
  updateStatusUi();
}

function drawLive() {
  if (S.view !== 'live' || !S.latestBitmap || !S.phone?.connected) return;
  const c = $('#liveCanvas');
  const b = S.latestBitmap;
  if (c.width !== b.width || c.height !== b.height) {
    c.width = b.width;
    c.height = b.height;
  }
  c.getContext('2d').drawImage(b, 0, 0);
}

let pairIp = localStorage.getItem('cc.pairIp') || '';
async function loadPair() {
  try {
    const d = await api('GET', `/api/pair${pairIp ? `?ip=${encodeURIComponent(pairIp)}` : ''}`);
    $('#qrBox').innerHTML = d.svg;
    const sel = $('#ipSelect');
    sel.innerHTML = d.addresses
      .map((a) => `<option value="${a.address}" ${a.address === d.chosen ? 'selected' : ''}>${a.address}（${esc(a.name)}${a.virtual ? '，虛擬網卡' : ''}）</option>`)
      .join('');
    if (!d.addresses.length) sel.innerHTML = '<option>找不到網路，請先連上 Wi-Fi</option>';
  } catch (e) {
    $('#qrBox').textContent = `產生 QR code 失敗：${e.message}`;
  }
}

function sessionName(c) {
  return `第 ${c.number ?? '?'} 場測試`;
}

async function renderRecentClips() {
  try {
    const clips = (await api('GET', '/api/clips')).slice(0, 5);
    $('#recentClips').innerHTML = clips.length
      ? clips
          .map(
            (c) => `<li data-id="${c.id}">
              ${c.thumb ? `<img src="/clips/${c.id}/frames/${c.thumb}" alt="">` : '<img alt="">'}
              <div><div class="t">${sessionName(c)}${c.project ? ` · ${esc(c.project)}` : ''}</div>
              <div class="s">${c.status === 'capturing' ? '錄影中…' : `${fmtTime(c.createdAt)}，${fmtDur(c.end - c.start)}`}，${(c.markers || []).length} 個書籤</div></div></li>`,
          )
          .join('')
      : '<li class="s" style="cursor:default">還沒有測試</li>';
  } catch {}
}

async function doMarker() {
  await saveQuickNote(); // 上一個書籤的字還沒按 Enter，先存起來
  try {
    const r = await api('POST', '/api/session/marker');
    S.session = r.session;
    updateStatusUi();
    if (r.started) toast(`已開始第 ${r.session.number} 場測試`);
    const reviewingThis = S.view === 'review' && S.review?.clip?.id === r.session.id;
    if (S.config.openReviewAfterMark && !reviewingThis) {
      S.pendingJumpMarker = r.markerIndex;
      location.hash = `#review/${r.session.id}`;
      return;
    }
    openQuickNote({ clipId: r.session.id, markerT: r.markerT, index: r.markerIndex, rel: r.rel });
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 插書籤當下順手寫字 ----------

function openQuickNote(q) {
  S.quick = q;
  $('#qnTitle').textContent = `書籤 ${q.index + 1}・${fmtRel(q.rel || 0)}`;
  const input = $('#qnInput');
  input.value = '';
  $('#quickNote').hidden = false;
  setTimeout(() => input.focus(), 0);
}

function closeQuickNote() {
  S.quick = null;
  $('#quickNote').hidden = true;
  $('#qnInput').blur();
}

async function saveQuickNote() {
  const q = S.quick;
  if (!q) return;
  const text = $('#qnInput').value.trim();
  closeQuickNote();
  if (!text) return;
  const R = S.review;
  try {
    if (R && R.clip.id === q.clipId) {
      // 排查畫面正開著這場：直接寫進畫面上的草稿，免得被覆蓋
      await reloadReviewClip();
      const i = frameIndexAt(q.markerT);
      let d = liveDrafts().find((x) => x.markerT === q.markerT && !x.noteId) || draftAtIndex(i);
      if (!d || d.noteId) d = createDraftAt(i);
      d.description = d.description ? `${d.description}\n${text}` : text;
      scheduleSave();
      renderEditor();
    } else {
      await api('POST', `/api/clips/${q.clipId}/quicknote`, { markerT: q.markerT, text });
    }
    toast(`書籤 ${q.index + 1} 已記下`, false, 1200);
  } catch (e) {
    toast(`沒存到：${e.message}`, true);
  }
}

$('#qnInput').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.isComposing) return; // 注音選字中的 Enter 不算
  if (e.key === 'Enter') {
    e.preventDefault();
    saveQuickNote();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeQuickNote();
  } else if ((S.config?.markKeys || []).includes(e.key) && e.key.length > 1) {
    // 正在打字時又踩了踏板：先存這個，再插下一個書籤
    e.preventDefault();
    if (!e.repeat) doMarker();
  } else if ((S.config?.recordKeys || []).includes(e.key) && e.key.length > 1) {
    e.preventDefault();
    saveQuickNote().then(toggleSession);
  }
});

async function toggleSession() {
  try {
    if (S.session) {
      await saveQuickNote();
      const id = S.session.id;
      await api('POST', '/api/session/stop');
      S.session = null;
      updateStatusUi();
      toast('測試結束，開始一個一個框選吧');
      if (S.view === 'review' && S.review?.clip?.id === id) reloadReviewClip();
      else location.hash = `#review/${id}`;
    } else {
      const r = await api('POST', '/api/session/start', { project: $('#liveProject').value });
      S.session = r.session;
      updateStatusUi();
      toast(`第 ${r.session.number} 場測試開始，遇到問題就插書籤`);
    }
  } catch (e) {
    toast(e.message, true);
  }
}

$('#liveProject').addEventListener('change', async (e) => {
  const project = e.target.value;
  try {
    if (S.session) await api('PATCH', `/api/clips/${S.session.id}`, { project });
    else await api('PUT', '/api/config', { lastProject: project });
    S.config.lastProject = project;
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------------------------------------------------------------------
// 測試場次清單
// ---------------------------------------------------------------------------

async function renderClips() {
  const grid = $('#clipGrid');
  const clips = await api('GET', '/api/clips');
  if (!clips.length) {
    grid.innerHTML = '<div class="empty">還沒有測試。手機連上後，在「即時畫面」按「開始測試」或「插書籤」。</div>';
    return;
  }
  grid.innerHTML = clips
    .map((c) => {
      const markers = (c.markers || []).length;
      const stats = [`${markers} 個書籤`];
      if (c.draftCount) stats.push(`${c.draftCount} 筆草稿`);
      if (c.sentCount) stats.push(`已送出 ${c.sentCount} 筆`);
      return `<div class="clip-card" data-id="${c.id}">
        <div class="clip-thumb" data-open="${c.id}">${c.thumb ? `<img src="/clips/${c.id}/frames/${c.thumb}" alt="">` : ''}</div>
        <div class="clip-body">
          <div class="t">${sessionName(c)}${c.project ? ` · ${esc(c.project)}` : ''}</div>
          <div class="s">${c.status === 'capturing' ? '<span style="color:var(--red)">● 錄影中</span>' : fmtTime(c.createdAt)}，長度 ${fmtDur(c.end - c.start)}<br>${stats.join('，')}${c.keep ? '，已保留' : ''}</div>
          <div class="clip-actions">
            <button data-open="${c.id}" class="primary">排查</button>
            ${c.hasVideo ? `<a class="btn-link" href="/clips/${c.id}/session.mp4" target="_blank">看影片</a>` : c.exporting ? '<span class="muted small">轉成影片中…</span>' : S.state?.ffmpeg && c.status !== 'capturing' ? `<button data-export="${c.id}">轉成影片</button>` : ''}
            <button data-keep="${c.id}" data-v="${c.keep ? 0 : 1}">${c.keep ? '取消保留' : '保留'}</button>
            ${c.status !== 'capturing' ? `<button data-del="${c.id}" class="danger">刪除</button>` : ''}
          </div>
        </div>
      </div>`;
    })
    .join('');
}

$('#clipGrid').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-open],[data-export],[data-keep],[data-del]');
  if (!t) return;
  try {
    if (t.dataset.open) location.hash = `#review/${t.dataset.open}`;
    else if (t.dataset.export) {
      t.disabled = true;
      t.textContent = '轉檔中…';
      const r = await api('POST', `/api/clips/${t.dataset.export}/export`);
      window.open(r.url, '_blank');
      renderClips();
    } else if (t.dataset.keep) {
      await api('PATCH', `/api/clips/${t.dataset.keep}`, { keep: t.dataset.v === '1' });
      renderClips();
    } else if (t.dataset.del) {
      if (!confirm('刪除這場測試的錄影和草稿？已送出的回報不受影響。')) return;
      await api('DELETE', `/api/clips/${t.dataset.del}`);
      renderClips();
    }
  } catch (err) {
    toast(err.message, true);
    renderClips();
  }
});

$('#recentClips').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) location.hash = `#review/${li.dataset.id}`;
});

// ---------------------------------------------------------------------------
// 排查：時間軸、書籤、每格一筆草稿
// ---------------------------------------------------------------------------

const canvas = $('#reviewCanvas');
const ctx = canvas.getContext('2d');

// R.drafts：[{ id, f, t, markerT, annotations, description, range:{startT,endT}|null, noteId, number }]
function newReviewState(clip, drafts) {
  return {
    clip,
    frames: clip.frames,
    markers: clip.markers || [],
    drafts,
    index: 0,
    images: new Map(),
    activeId: null,
    undo: [],
    drawing: null,
    selected: -1,
    dragFrom: null,
    playing: false,
    playTimer: null,
    saveTimer: null,
    pollTimer: null,
    userMoved: false,
  };
}

function leaveReview() {
  const R = S.review;
  if (!R) return;
  stopPlayback();
  flushSave();
  clearInterval(R.pollTimer);
  R.pollTimer = null;
}

// 時間 t 對應的格（t 之前最後一格）
function frameIndexAt(t) {
  const fr = S.review.frames;
  let lo = 0, hi = fr.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fr[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function indexOfFile(f) {
  const i = S.review.frames.findIndex((x) => x.f === f);
  return i < 0 ? 0 : i;
}

function relSec(i) {
  const R = S.review;
  return (R.frames[i].t - R.frames[0].t) / 1000;
}

function fmtRel(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function liveDrafts() {
  return S.review.drafts.filter((d) => !d.removed);
}

function draftAtIndex(i) {
  const f = S.review.frames[i]?.f;
  return liveDrafts().find((d) => d.f === f) || null;
}

function activeDraft() {
  const R = S.review;
  return liveDrafts().find((d) => d.id === R.activeId) || null;
}

function markerAtIndex(i) {
  const R = S.review;
  return R.markers.find((m) => frameIndexAt(m.t) === i) || null;
}

function draftHasContent(d) {
  return !!(d.annotations.length || d.description.trim() || d.range);
}

function createDraftAt(i) {
  const R = S.review;
  const m = markerAtIndex(i);
  const d = {
    id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    f: R.frames[i].f,
    t: R.frames[i].t,
    markerT: m ? m.t : null,
    annotations: [],
    description: '',
    range: null,
    noteId: null,
  };
  R.drafts.push(d);
  return d;
}

async function openReview(id) {
  if (!id) return (location.hash = '#clips');
  if (S.review?.clip?.id === id && S.review.frames.length) {
    S.review.pollTimer = S.review.pollTimer || (S.review.clip.status === 'capturing' ? setInterval(reloadReviewClip, 2000) : null);
    await reloadReviewClip();
    jumpPendingMarker();
    return;
  }
  let clip, drafts;
  try {
    [clip, drafts] = await Promise.all([api('GET', `/api/clips/${id}`), api('GET', `/api/clips/${id}/drafts`)]);
  } catch {
    toast('找不到這場測試', true);
    return (location.hash = '#clips');
  }
  if (S.review) leaveReview();
  S.review = newReviewState(clip, drafts.map((d) => ({ annotations: [], description: '', range: null, ...d })));
  const R = S.review;
  showForm();
  renderReviewHead();
  setupTimeline();
  // 一進來先跳到第一個還沒處理的書籤；沒有書籤就從頭（錄影中就看最新）
  const firstOpen = R.markers.find((m) => !draftAtIndex(frameIndexAt(m.t)));
  let start = firstOpen ? frameIndexAt(firstOpen.t) : clip.status === 'capturing' ? R.frames.length - 1 : 0;
  if (S.pendingJumpMarker != null && R.markers[S.pendingJumpMarker]) start = frameIndexAt(R.markers[S.pendingJumpMarker].t);
  S.pendingJumpMarker = null;
  await showFrame(start);
  if (clip.status === 'capturing') R.pollTimer = setInterval(reloadReviewClip, 2000);
}

function jumpPendingMarker() {
  const R = S.review;
  if (S.pendingJumpMarker == null || !R) return;
  const m = R.markers[S.pendingJumpMarker];
  S.pendingJumpMarker = null;
  if (m) showFrame(frameIndexAt(m.t));
}

async function reloadReviewClip() {
  const R = S.review;
  if (!R) return;
  let clip;
  try {
    clip = await api('GET', `/api/clips/${R.clip.id}`);
  } catch {
    return;
  }
  if (S.review !== R) return;
  R.clip = clip;
  R.frames = clip.frames;
  R.markers = clip.markers || [];
  if (clip.status !== 'capturing') {
    clearInterval(R.pollTimer);
    R.pollTimer = null;
  }
  renderReviewHead();
  setupTimeline();
  renderItems();
  updateTimeLabel();
}

function renderReviewHead() {
  const R = S.review;
  const c = R.clip;
  const live = c.status === 'capturing';
  $('#sessTitle').textContent = sessionName(c);
  $('#sessLive').hidden = !live;
  $('#capturingHint').hidden = !live;
  $('#btnStopFromReview').hidden = !live;
  const dur = R.frames.length ? R.frames[R.frames.length - 1].t - R.frames[0].t : 0;
  $('#sessSub').textContent = `${fmtTime(c.createdAt)} 開始，長度 ${fmtDur(dur)}`;
  const sel = $('#sessProject');
  if (document.activeElement !== sel) sel.innerHTML = projectOptions(c.project || '');
}

async function showFrame(i) {
  const R = S.review;
  if (!R || !R.frames.length) return;
  i = Math.max(0, Math.min(R.frames.length - 1, i));
  R.index = i;
  $('#tlSlider').value = i;
  // 換格時：這格有草稿就編輯它，沒有就準備在這格新增一筆。
  // 選區間（起點／終點）會套用到最後編輯的那一筆，所以另外記著。
  if (R.activeId) R.rangeTargetId = R.activeId;
  const d = draftAtIndex(i);
  R.activeId = d ? d.id : null;
  // 停在某個書籤上，就把它當成「選中的書籤」，之後可以用 M 把它移到別格
  const mk = markerAtIndex(i);
  if (mk) R.selMarkerT = mk.t;
  R.selected = -1;
  updateTimeLabel();
  if (!R.playing && !R.draggingMarker) {
    renderEditor();
    renderItems();
    setupTimeline();
  }
  const img = await getFrameImage(i);
  if (S.review !== R || R.index !== i) return;
  R.currentImage = img;
  if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
  }
  drawReview();
  for (const dd of [1, 2, 3, -1, -2]) if (R.frames[i + dd]) getFrameImage(i + dd);
}

function frameUrl(i) {
  return `/clips/${S.review.clip.id}/frames/${S.review.frames[i].f}`;
}

function getFrameImage(i) {
  const R = S.review;
  if (!R.images.has(i)) {
    const p = loadImage(frameUrl(i));
    p.catch(() => R.images.delete(i));
    R.images.set(i, p);
    // 長時間的測試有幾千格，只留最近用到的
    if (R.images.size > 400) R.images.delete(R.images.keys().next().value);
  }
  return R.images.get(i);
}

function updateTimeLabel() {
  const R = S.review;
  if (!R.frames.length) return;
  const total = relSec(R.frames.length - 1);
  $('#tlTime').textContent = `${fmtRel(relSec(R.index))} / ${fmtRel(total)}　第 ${R.index + 1}/${R.frames.length} 格`;
}

function setupTimeline() {
  const R = S.review;
  const n = R.frames.length;
  const slider = $('#tlSlider');
  slider.max = Math.max(0, n - 1);
  slider.value = R.index;
  const pct = (i) => (n > 1 ? (i / (n - 1)) * 100 : 0);
  let ticks = R.markers
    .map((m, k) => `<span class="tick marker ${m.t === R.selMarkerT ? 'sel' : ''}" data-t="${m.t}" style="left:${pct(frameIndexAt(m.t))}%" title="書籤 ${k + 1}：拖曳可以移動"></span>`)
    .join('');
  ticks += liveDrafts()
    .filter(draftHasContent)
    .map((d) => `<span class="tick draft ${d.noteId ? 'sent' : ''}" style="left:${pct(indexOfFile(d.f))}%"></span>`)
    .join('');
  $('#tlTicks').innerHTML = ticks;
  const a = activeDraft() || liveDrafts().find((x) => x.id === R.rangeTargetId);
  const range = $('#tlRange');
  const r = a?.range;
  range.hidden = !(r && r.startT != null && r.endT != null);
  $('#btnRangeClear').hidden = !r;
  if (!range.hidden) {
    const si = frameIndexAt(r.startT), ei = frameIndexAt(r.endT);
    range.style.left = `${pct(si)}%`;
    range.style.width = `${pct(ei) - pct(si)}%`;
  }
  let info = '';
  if (r && r.startT != null && r.endT == null) info = `區間起點：${fmtRel(relSec(frameIndexAt(r.startT)))}（再按「終點」）`;
  if (r && r.startT != null && r.endT != null) info = `已選區間 ${fmtRel(relSec(frameIndexAt(r.startT)))}–${fmtRel(relSec(frameIndexAt(r.endT)))}，連續畫面會從這段取`;
  if (info && a && a.f !== R.frames[R.index]?.f) info += `（套用在 ${fmtRel(relSec(indexOfFile(a.f)))} 那一筆）`;
  $('#rangeInfo').textContent = info;
}

// ---------- 右側：書籤與草稿清單 ----------

function buildItems() {
  const R = S.review;
  const items = [];
  const used = new Set();
  R.markers.forEach((m, k) => {
    const idx = frameIndexAt(m.t);
    const d = liveDrafts().find((x) => x.markerT === m.t) || draftAtIndex(idx);
    if (d) used.add(d.id);
    items.push({ t: R.frames[idx]?.t ?? m.t, idx, marker: k + 1, markerT: m.t, draft: d });
  });
  for (const d of liveDrafts()) {
    if (used.has(d.id) || !draftHasContent(d)) continue;
    items.push({ t: d.t, idx: indexOfFile(d.f), marker: null, draft: d });
  }
  items.sort((a, b) => a.t - b.t);
  return items;
}

function renderItems() {
  const R = S.review;
  if (!R) return;
  const items = buildItems();
  const pending = liveDrafts().filter((d) => !d.noteId && draftHasContent(d)).length;
  const sent = liveDrafts().filter((d) => d.noteId).length;
  $('#itemsCount').textContent = `${R.markers.length} 個書籤${pending ? `，${pending} 筆待送出` : ''}${sent ? `，${sent} 筆已送出` : ''}`;
  const btn = $('#btnSubmitAll');
  btn.disabled = !pending;
  btn.textContent = pending ? `全部送出（${pending} 筆）` : '全部送出';
  if (!items.length) {
    $('#items').innerHTML = '<li class="empty-item">這場還沒有書籤。拖時間軸找到有問題的畫面，直接在上面畫或在下面寫說明，就會變成一筆。</li>';
    return;
  }
  $('#items').innerHTML = items
    .map((it) => {
      const d = it.draft;
      let state = 'none', text = '還沒寫';
      if (d?.noteId) {
        state = 'sent';
        text = `已送出 #${d.number}　${esc(d.description.split('\n')[0] || '')}`;
      } else if (d && draftHasContent(d)) {
        state = 'draft';
        text = d.description.trim() ? esc(d.description.split('\n')[0]) : '已框選，還沒寫說明';
      }
      const current = it.idx === R.index || (d && d.id === R.activeId);
      return `<li class="item ${current ? 'on' : ''}" data-idx="${it.idx}" ${it.marker ? `data-marker="${it.markerT}"` : ''}>
        <img src="/clips/${R.clip.id}/frames/${R.frames[it.idx].f}" alt="" loading="lazy">
        <div class="item-body">
          <div class="item-top"><span class="dot ${state}"></span>${fmtRel(relSec(it.idx))}${it.marker ? `<span class="item-tag">書籤 ${it.marker}</span>` : ''}</div>
          <div class="item-text">${text}</div>
        </div>
        ${it.marker && !d ? `<button class="ghost item-x" data-delmarker="${it.markerT}" title="刪掉這個書籤">✕</button>` : ''}
      </li>`;
    })
    .join('');
  const on = $('#items .item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

$('#items').addEventListener('click', async (e) => {
  const x = e.target.closest('[data-delmarker]');
  const R = S.review;
  if (x) {
    e.stopPropagation();
    const t = Number(x.dataset.delmarker);
    R.markers = R.markers.filter((m) => m.t !== t);
    try {
      await api('PATCH', `/api/clips/${R.clip.id}`, { markers: R.markers });
    } catch (err) {
      toast(err.message, true);
    }
    renderItems();
    setupTimeline();
    return;
  }
  const li = e.target.closest('.item[data-idx]');
  if (!li) return;
  stopPlayback();
  R.userMoved = true;
  if (li.dataset.marker) R.selMarkerT = Number(li.dataset.marker);
  showFrame(Number(li.dataset.idx));
});

function renderEditor() {
  const R = S.review;
  const d = activeDraft();
  const ta = $('#fDesc');
  const title = $('#editorTitle');
  const del = $('#btnDelDraft');
  if (d) {
    const idx = indexOfFile(d.f);
    const m = R.markers.findIndex((x) => x.t === d.markerT);
    if (d.noteId) {
      title.innerHTML = `${fmtRel(relSec(idx))} 這一筆已送出成 <a href="#note/${d.noteId}">回報 #${d.number}</a>`;
    } else {
      title.textContent = `${fmtRel(relSec(idx))} 這一筆${m >= 0 ? `（書籤 ${m + 1}）` : ''}`;
    }
    if (document.activeElement !== ta) ta.value = d.description;
    ta.disabled = !!d.noteId;
    del.hidden = !!d.noteId;
  } else {
    const m = markerAtIndex(R.index);
    const k = m ? R.markers.indexOf(m) + 1 : 0;
    title.textContent = `${fmtRel(relSec(R.index))}${k ? `（書籤 ${k}）` : ''}：在畫面上畫標註，或在這裡寫說明`;
    if (document.activeElement !== ta) ta.value = '';
    ta.disabled = false;
    del.hidden = true;
  }
  $('#anchorHint').hidden = true;
  const selK = R.markers.findIndex((m) => m.t === R.selMarkerT);
  const mm = $('#markerMove');
  mm.hidden = selK < 0;
  if (selK >= 0) {
    const mi = frameIndexAt(R.markers[selK].t);
    const here = mi === R.index;
    $('#markerMoveText').textContent = here ? `書籤 ${selK + 1} 在這一格` : `書籤 ${selK + 1} 在 ${fmtRel(relSec(mi))}`;
    $('#btnMoveMarker').disabled = here;
    $('#btnMoveMarker').textContent = here ? '← → 找到正確那格再按 M' : '書籤移到這一格（M）';
  }
}

// 把書籤移到另一格（看到問題到按下去常常慢 1、2 秒）
async function moveMarker(oldT, newIdx) {
  const R = S.review;
  const k = R.markers.findIndex((m) => m.t === oldT);
  if (k < 0) return;
  const fr = R.frames[newIdx];
  if (!fr || frameIndexAt(oldT) === newIdx) return;
  const newT = fr.t;
  if (R.markers.some((m, j) => j !== k && frameIndexAt(m.t) === newIdx)) return toast('那一格已經有別的書籤了', true);
  // 跟著書籤走的草稿（還沒送出的）一起搬過去
  const linked = liveDrafts().find((d) => d.markerT === oldT || (!d.markerT && d.f === R.frames[frameIndexAt(oldT)].f));
  if (linked?.noteId) return toast(`這個書籤已經送出成回報 #${linked.number}，不能再移`, true);
  const occupant = draftAtIndex(newIdx);
  if (linked) {
    if (occupant && occupant !== linked && !occupant.noteId) {
      // 新位置已經有一筆：合併
      occupant.description = [occupant.description, linked.description].filter(Boolean).join('\n');
      occupant.annotations = [...occupant.annotations, ...linked.annotations];
      occupant.markerT = newT;
      linked.removed = true;
    } else {
      linked.f = fr.f;
      linked.t = fr.t;
      linked.markerT = newT;
    }
  }
  R.markers[k] = { ...R.markers[k], t: newT };
  R.markers.sort((a, b) => a.t - b.t);
  R.selMarkerT = newT;
  try {
    await api('PATCH', `/api/clips/${R.clip.id}`, { markers: R.markers });
  } catch (e) {
    toast(e.message, true);
  }
  scheduleSave();
  await showFrame(newIdx);
  toast(`書籤 ${R.markers.findIndex((m) => m.t === newT) + 1} 移到 ${fmtRel(relSec(newIdx))}`, false, 1400);
}

$('#btnMoveMarker').onclick = () => {
  const R = S.review;
  if (R?.selMarkerT != null) moveMarker(R.selMarkerT, R.index);
};

// 直接拖時間軸上的紅色書籤
$('#tlTicks').addEventListener('pointerdown', (e) => {
  const tick = e.target.closest('.tick.marker');
  const R = S.review;
  if (!tick || !R) return;
  e.preventDefault();
  stopPlayback();
  const oldT = Number(tick.dataset.t);
  R.selMarkerT = oldT;
  const track = $('#tlTrack').getBoundingClientRect();
  const n = R.frames.length;
  let idx = frameIndexAt(oldT);
  R.draggingMarker = true; // 拖曳中不要重畫時間軸，不然手上的書籤會被換掉
  tick.classList.add('dragging');
  tick.setPointerCapture(e.pointerId);
  const onMove = (ev) => {
    const x = Math.min(1, Math.max(0, (ev.clientX - track.left) / track.width));
    idx = Math.round(x * (n - 1));
    tick.style.left = `${n > 1 ? (idx / (n - 1)) * 100 : 0}%`;
    R.userMoved = true;
    showFrame(idx);
  };
  const onUp = () => {
    tick.removeEventListener('pointermove', onMove);
    tick.removeEventListener('pointerup', onUp);
    tick.removeEventListener('pointercancel', onUp);
    tick.classList.remove('dragging');
    R.draggingMarker = false;
    if (idx !== frameIndexAt(oldT)) moveMarker(oldT, idx);
    else showFrame(idx);
  };
  tick.addEventListener('pointermove', onMove);
  tick.addEventListener('pointerup', onUp);
  tick.addEventListener('pointercancel', onUp);
});

function nextItem(dir = 1) {
  const R = S.review;
  const items = buildItems();
  if (!items.length) return;
  const cur = R.frames[R.index].t;
  const target = dir > 0 ? items.find((it) => it.t > cur) : [...items].reverse().find((it) => it.t < cur);
  if (!target) return toast(dir > 0 ? '已經是最後一個了' : '已經是第一個了', false, 1200);
  stopPlayback();
  R.userMoved = true;
  showFrame(target.idx);
}

// ---------- 草稿存檔 ----------

function scheduleSave() {
  const R = S.review;
  if (!R) return;
  clearTimeout(R.saveTimer);
  R.saveTimer = setTimeout(() => saveDrafts(R), 500);
  renderItems();
  setupTimeline();
}

function serializeDrafts(R) {
  return R.drafts.filter((d) => !d.removed && (d.noteId || draftHasContent(d)));
}

async function saveDrafts(R) {
  clearTimeout(R.saveTimer);
  R.saveTimer = null;
  try {
    await api('PUT', `/api/clips/${R.clip.id}/drafts`, serializeDrafts(R));
  } catch (e) {
    toast(`草稿沒存到：${e.message}`, true);
  }
}

function flushSave() {
  const R = S.review;
  if (R && R.saveTimer) saveDrafts(R);
}

window.addEventListener('beforeunload', () => {
  const R = S.review;
  if (R && R.saveTimer) {
    fetch(`/api/clips/${R.clip.id}/drafts`, {
      method: 'PUT',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeDrafts(R)),
    });
  }
});

// ---------- 播放 ----------

function stopPlayback() {
  const R = S.review;
  if (!R) return;
  const was = R.playing;
  R.playing = false;
  clearTimeout(R.playTimer);
  $('#btnPlay').textContent = '▶';
  if (was) {
    renderEditor();
    renderItems();
    setupTimeline();
  }
}

function togglePlay() {
  const R = S.review;
  if (!R) return;
  if (R.playing) return stopPlayback();
  if (R.index >= R.frames.length - 1) showFrame(0);
  R.playing = true;
  R.userMoved = true;
  $('#btnPlay').textContent = '⏸';
  const step = () => {
    if (!R.playing) return;
    const i = R.index;
    if (i >= R.frames.length - 1) return stopPlayback();
    const wait = Math.min(600, Math.max(16, R.frames[i + 1].t - R.frames[i].t));
    R.playTimer = setTimeout(async () => {
      await showFrame(i + 1);
      step();
    }, wait);
  };
  step();
}
// ---------- 標註繪製 ----------

function lineW() {
  return Math.max(3, Math.round(canvas.width / 110));
}

function fontPx(W) {
  return Math.max(16, Math.round(W / 20));
}

function drawArrow(c, x1, y1, x2, y2, w) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = w * 4.5;
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2 - Math.cos(ang) * head * 0.6, y2 - Math.sin(ang) * head * 0.6);
  c.stroke();
  c.beginPath();
  c.moveTo(x2, y2);
  c.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
  c.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
  c.closePath();
  c.fill();
}

function drawAnnotation(c, a, W, H, w) {
  c.save();
  c.strokeStyle = a.color;
  c.fillStyle = a.color;
  c.lineWidth = w;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.shadowColor = 'rgba(0,0,0,0.35)';
  c.shadowBlur = w;
  if (a.type === 'rect') {
    c.strokeRect(a.x * W, a.y * H, a.w * W, a.h * H);
  } else if (a.type === 'ellipse') {
    c.beginPath();
    c.ellipse((a.x + a.w / 2) * W, (a.y + a.h / 2) * H, Math.abs(a.w * W) / 2, Math.abs(a.h * H) / 2, 0, 0, Math.PI * 2);
    c.stroke();
  } else if (a.type === 'arrow') {
    drawArrow(c, a.x1 * W, a.y1 * H, a.x2 * W, a.y2 * H, w);
  } else if (a.type === 'pen') {
    c.beginPath();
    a.pts.forEach(([x, y], i) => (i ? c.lineTo(x * W, y * H) : c.moveTo(x * W, y * H)));
    c.stroke();
  } else if (a.type === 'text') {
    const fs = fontPx(W);
    c.font = `bold ${fs}px "Microsoft JhengHei UI","PingFang TC","Noto Sans TC",sans-serif`;
    c.textBaseline = 'top';
    c.shadowBlur = 0;
    c.lineWidth = Math.max(3, fs / 5);
    c.strokeStyle = '#fff';
    c.strokeText(a.text, a.x * W, a.y * H);
    c.fillText(a.text, a.x * W, a.y * H);
  }
  c.restore();
}

// 標註的外框（原始像素）
function annBox(a, W, H, c = ctx) {
  if (a.type === 'rect' || a.type === 'ellipse') return { x: a.x * W, y: a.y * H, w: a.w * W, h: a.h * H };
  if (a.type === 'arrow') {
    const x = Math.min(a.x1, a.x2) * W, y = Math.min(a.y1, a.y2) * H;
    return { x, y, w: Math.abs(a.x2 - a.x1) * W, h: Math.abs(a.y2 - a.y1) * H };
  }
  if (a.type === 'pen') {
    const xs = a.pts.map((p) => p[0] * W), ys = a.pts.map((p) => p[1] * H);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (a.type === 'text') {
    const fs = fontPx(W);
    c.save();
    c.font = `bold ${fs}px "Microsoft JhengHei UI","PingFang TC","Noto Sans TC",sans-serif`;
    const w = c.measureText(a.text).width;
    c.restore();
    return { x: a.x * W, y: a.y * H, w, h: fs * 1.2 };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}


function drawReview() {
  const R = S.review;
  if (!R || !R.currentImage) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(R.currentImage, 0, 0, W, H);
  const d = draftAtIndex(R.index);
  if (d) {
    ctx.save();
    if (d.noteId) ctx.globalAlpha = 0.6;
    d.annotations.forEach((a) => drawAnnotation(ctx, a, W, H, lineW()));
    ctx.restore();
  }
  if (R.drawing) drawAnnotation(ctx, R.drawing, W, H, lineW());
  if (d && R.selected >= 0 && d.annotations[R.selected]) {
    const b = annBox(d.annotations[R.selected], W, H);
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = '#0a84ff';
    ctx.lineWidth = 2;
    const pad = lineW() + 6;
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.restore();
  }
}

function pointerPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function pushUndo(d) {
  const R = S.review;
  R.undo.push({ id: d.id, a: JSON.stringify(d.annotations) });
  if (R.undo.length > 150) R.undo.shift();
}

function doUndo() {
  const R = S.review;
  if (!R || !R.undo.length) return;
  const u = R.undo.pop();
  const d = R.drafts.find((x) => x.id === u.id);
  if (!d || d.noteId) return;
  d.annotations = JSON.parse(u.a);
  d.removed = false;
  R.selected = -1;
  showFrame(indexOfFile(d.f));
  scheduleSave();
}

// 這一格要畫的那筆草稿（沒有就建一筆）
function targetDraft() {
  const R = S.review;
  let d = draftAtIndex(R.index);
  if (d?.noteId) {
    toast(`這一格已經送出成回報 #${d.number}，要改請到回報頁`, true);
    return null;
  }
  if (!d) d = createDraftAt(R.index);
  R.activeId = d.id;
  return d;
}

function hitTest(p) {
  const R = S.review;
  const d = draftAtIndex(R.index);
  if (!d || d.noteId) return -1;
  const W = canvas.width, H = canvas.height;
  const tol = Math.max(14, lineW() * 3);
  for (let i = d.annotations.length - 1; i >= 0; i--) {
    const b = annBox(d.annotations[i], W, H);
    const px = p.x * W, py = p.y * H;
    if (px >= b.x - tol && px <= b.x + b.w + tol && py >= b.y - tol && py <= b.y + b.h + tol) return i;
  }
  return -1;
}

function moveAnnotation(a, dx, dy) {
  if ('x' in a) {
    a.x += dx;
    a.y += dy;
  }
  if (a.type === 'arrow') {
    a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy;
  }
  if (a.type === 'pen') a.pts = a.pts.map(([x, y]) => [x + dx, y + dy]);
}

canvas.addEventListener('pointerdown', (e) => {
  const R = S.review;
  if (!R || !R.currentImage || e.button !== 0) return;
  stopPlayback();
  hideTextInput(true);
  const p = pointerPos(e);
  if (S.tool === 'select') {
    R.selected = hitTest(p);
    const d = draftAtIndex(R.index);
    if (R.selected >= 0 && d) {
      R.activeId = d.id;
      pushUndo(d);
      R.dragFrom = p;
      canvas.setPointerCapture(e.pointerId);
    }
    drawReview();
    renderEditor();
    return;
  }
  if (S.tool === 'text') {
    e.preventDefault();
    showTextInput(e, p);
    return;
  }
  const d = targetDraft();
  if (!d) return;
  canvas.setPointerCapture(e.pointerId);
  R.selected = -1;
  const c = S.color;
  if (S.tool === 'rect' || S.tool === 'ellipse') R.drawing = { type: S.tool, color: c, x: p.x, y: p.y, w: 0, h: 0, _x0: p.x, _y0: p.y };
  else if (S.tool === 'arrow') R.drawing = { type: 'arrow', color: c, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  else if (S.tool === 'pen') R.drawing = { type: 'pen', color: c, pts: [[p.x, p.y]] };
  renderEditor();
  drawReview();
});

canvas.addEventListener('pointermove', (e) => {
  const R = S.review;
  if (!R) return;
  const p = pointerPos(e);
  if (S.tool === 'select' && R.dragFrom && R.selected >= 0) {
    const d = draftAtIndex(R.index);
    if (d) moveAnnotation(d.annotations[R.selected], p.x - R.dragFrom.x, p.y - R.dragFrom.y);
    R.dragFrom = p;
    drawReview();
    return;
  }
  const d = R.drawing;
  if (!d) return;
  if (d.type === 'rect' || d.type === 'ellipse') {
    d.x = Math.min(d._x0, p.x);
    d.y = Math.min(d._y0, p.y);
    d.w = Math.abs(p.x - d._x0);
    d.h = Math.abs(p.y - d._y0);
    if (e.shiftKey) {
      // 按住 Shift 畫正方形／正圓
      const s = Math.max(d.w * canvas.width, d.h * canvas.height);
      d.w = s / canvas.width;
      d.h = s / canvas.height;
      if (p.x < d._x0) d.x = d._x0 - d.w;
      if (p.y < d._y0) d.y = d._y0 - d.h;
    }
  } else if (d.type === 'arrow') {
    d.x2 = p.x;
    d.y2 = p.y;
  } else if (d.type === 'pen') d.pts.push([p.x, p.y]);
  drawReview();
});

function endPointer() {
  const R = S.review;
  if (!R) return;
  if (R.dragFrom) {
    R.dragFrom = null;
    scheduleSave();
    return;
  }
  const a = R.drawing;
  if (!a) return;
  R.drawing = null;
  const W = canvas.width, H = canvas.height;
  let ok = true;
  if (a.type === 'rect' || a.type === 'ellipse') ok = a.w * W > 6 && a.h * H > 6;
  if (a.type === 'arrow') ok = Math.hypot((a.x2 - a.x1) * W, (a.y2 - a.y1) * H) > 12;
  if (a.type === 'pen') {
    ok = a.pts.length > 2;
    const b = annBox(a, W, H);
    a.bx = b.x / W;
    a.by = b.y / H;
  }
  delete a._x0;
  delete a._y0;
  const d = draftAtIndex(R.index);
  if (ok && d) {
    pushUndo(d);
    d.annotations.push(a);
    scheduleSave();
  }
  drawReview();
  renderEditor();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

let textPos = null;
function showTextInput(e, p) {
  const d = targetDraft();
  if (!d) return;
  const input = $('#textInput');
  const stage = $('#reviewStage').getBoundingClientRect();
  input.style.left = `${e.clientX - stage.left}px`;
  input.style.top = `${e.clientY - stage.top - 14}px`;
  input.value = '';
  input.hidden = false;
  textPos = { ...p, draftId: d.id };
  setTimeout(() => input.focus(), 0);
  renderEditor();
}

function hideTextInput(commit = false) {
  const input = $('#textInput');
  if (input.hidden) return;
  const R = S.review;
  const text = input.value.trim();
  input.hidden = true;
  const d = textPos && R.drafts.find((x) => x.id === textPos.draftId);
  if (commit && text && d) {
    pushUndo(d);
    d.annotations.push({ type: 'text', color: S.color, x: textPos.x, y: textPos.y, text });
    scheduleSave();
  }
  textPos = null;
  drawReview();
}

$('#textInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    hideTextInput(true);
  } else if (e.key === 'Escape') hideTextInput(false);
  e.stopPropagation();
});
$('#textInput').addEventListener('blur', () => hideTextInput(true));

// 說明欄：打字就存進目前這筆（沒有就在這一格建一筆）
$('#fDesc').addEventListener('input', (e) => {
  const R = S.review;
  if (!R) return;
  let d = activeDraft();
  if (!d) {
    d = draftAtIndex(R.index) || createDraftAt(R.index);
    R.activeId = d.id;
  }
  if (d.noteId) return;
  d.description = e.target.value;
  scheduleSave();
  renderEditor();
});
$('#fDesc').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.target.blur();
    nextItem(1);
  }
});

$('#btnDelDraft').onclick = () => {
  const R = S.review;
  const d = activeDraft();
  if (!d || d.noteId) return;
  if (draftHasContent(d) && !confirm('刪掉這一筆的標註和說明？')) return;
  pushUndo(d);
  d.removed = true;
  R.activeId = null;
  $('#fDesc').value = '';
  scheduleSave();
  renderEditor();
  drawReview();
};
$('#btnNextItem').onclick = () => nextItem(1);

function setTool(t) {
  S.tool = t;
  localStorage.setItem('cc.tool', t);
  for (const b of $$('#tools [data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  canvas.classList.toggle('select-mode', t === 'select');
  if (S.review) {
    S.review.selected = -1;
    drawReview();
  }
}

function setColor(c) {
  S.color = c;
  localStorage.setItem('cc.color', c);
  for (const b of $$('#colors [data-color]')) b.classList.toggle('on', b.dataset.color === c);
  const R = S.review;
  const d = R && draftAtIndex(R.index);
  if (d && !d.noteId && R.selected >= 0 && d.annotations[R.selected]) {
    pushUndo(d);
    d.annotations[R.selected].color = c;
    scheduleSave();
    drawReview();
  }
}

$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tool) setTool(b.dataset.tool);
  if (b.dataset.color) setColor(b.dataset.color);
});
$('#btnUndo').onclick = doUndo;
$('#btnClear').onclick = () => {
  const R = S.review;
  const d = R && draftAtIndex(R.index);
  if (!d || d.noteId || !d.annotations.length) return;
  pushUndo(d);
  d.annotations = [];
  R.selected = -1;
  scheduleSave();
  drawReview();
};

function moveTo(i) {
  stopPlayback();
  S.review.userMoved = true;
  showFrame(i);
}
$('#tlSlider').addEventListener('input', (e) => moveTo(Number(e.target.value)));
$('#btnFirst').onclick = () => moveTo(0);
$('#btnLast').onclick = () => moveTo(S.review.frames.length - 1);
$('#btnPrev').onclick = () => moveTo(S.review.index - 1);
$('#btnNext').onclick = () => moveTo(S.review.index + 1);
$('#btnPlay').onclick = togglePlay;
$('#btnGoAnchor').onclick = () => {
  const d = activeDraft();
  if (d) moveTo(indexOfFile(d.f));
};

// 區間：屬於目前這格的那一筆；這格沒有的話，套用到最後編輯的那一筆
function rangeDraft() {
  const R = S.review;
  let d = activeDraft() || liveDrafts().find((x) => x.id === R.rangeTargetId && !x.noteId);
  if (!d) {
    d = draftAtIndex(R.index) || createDraftAt(R.index);
    R.activeId = d.id;
  }
  return d.noteId ? null : d;
}
function setRangeIn() {
  const d = rangeDraft();
  if (!d) return;
  const t = S.review.frames[S.review.index].t;
  d.range = { startT: t, endT: d.range?.endT != null && d.range.endT > t ? d.range.endT : null };
  scheduleSave();
  renderEditor();
}
function setRangeOut() {
  const d = rangeDraft();
  if (!d) return;
  const t = S.review.frames[S.review.index].t;
  const start = d.range?.startT ?? S.review.frames[0].t;
  if (t <= start) return toast('終點要在起點後面', true);
  d.range = { startT: start, endT: t };
  scheduleSave();
  renderEditor();
}
$('#btnRangeIn').onclick = setRangeIn;
$('#btnRangeOut').onclick = setRangeOut;
$('#btnRangeClear').onclick = () => {
  const d = activeDraft() || liveDrafts().find((x) => x.id === S.review.rangeTargetId);
  if (!d || d.noteId) return;
  d.range = null;
  scheduleSave();
};

$('#sessProject').addEventListener('change', async (e) => {
  const R = S.review;
  try {
    R.clip = { ...R.clip, ...(await api('PATCH', `/api/clips/${R.clip.id}`, { project: e.target.value })), frames: R.frames };
    S.config.lastProject = e.target.value;
    toast(`這場測試算「${e.target.value || '未分類'}」的`);
  } catch (err) {
    toast(err.message, true);
  }
});
$('#btnStopFromReview').onclick = toggleSession;
$('#btnReviewNow').onclick = () => S.session && (location.hash = `#review/${S.session.id}`);
// ---------- 產生回報圖片 ----------

function renderAnnotated(img, annotations) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const w = Math.max(3, Math.round(W / 110));
  annotations.forEach((a) => drawAnnotation(g, a, W, H, w));
  return c;
}

function cropAround(full, annotations) {
  if (!annotations.length) return null;
  const W = full.width, H = full.height;
  const g = full.getContext('2d');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const a of annotations) {
    const b = annBox(a, W, H, g);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  const pad = Math.max(40, 0.3 * Math.max(x1 - x0, y1 - y0));
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const minSize = Math.min(W, H) * 0.45;
  if (x1 - x0 < minSize) { const cx = (x0 + x1) / 2; x0 = cx - minSize / 2; x1 = cx + minSize / 2; }
  if (y1 - y0 < minSize) { const cy = (y0 + y1) / 2; y0 = cy - minSize / 2; y1 = cy + minSize / 2; }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
  const cw = x1 - x0, ch = y1 - y0;
  // 框選範圍幾乎是整張就不用另外裁
  if (cw * ch > W * H * 0.8) return null;
  const scale = Math.min(3, Math.max(1, 800 / Math.max(cw, ch)));
  const c = document.createElement('canvas');
  c.width = Math.round(cw * scale);
  c.height = Math.round(ch * scale);
  const cg = c.getContext('2d');
  cg.imageSmoothingQuality = 'high';
  cg.drawImage(full, x0, y0, cw, ch, 0, 0, c.width, c.height);
  return c;
}


async function buildSequence(R, anchorIdx, range) {
  let idxs = [];
  if (range && range.startT != null && range.endT != null) {
    for (let i = frameIndexAt(range.startT); i <= frameIndexAt(range.endT); i++) idxs.push(i);
  } else {
    const t = R.frames[anchorIdx].t;
    // 問題前 3 秒到後 1 秒：讓 Claude 看到你是怎麼操作到這一步的
    for (let i = anchorIdx; i >= 0 && t - R.frames[i].t <= 3000; i--) idxs.unshift(i);
    for (let i = anchorIdx + 1; i < R.frames.length && R.frames[i].t - t <= 1000; i++) idxs.push(i);
  }
  if (idxs.length < 2) return null;
  const MAX = 10;
  let pick = idxs;
  if (idxs.length > MAX) {
    pick = [];
    for (let k = 0; k < MAX; k++) pick.push(idxs[Math.round((k * (idxs.length - 1)) / (MAX - 1))]);
    if (idxs.includes(anchorIdx) && !pick.includes(anchorIdx)) {
      let near = 0;
      pick.forEach((p, k) => (Math.abs(p - anchorIdx) < Math.abs(pick[near] - anchorIdx) ? (near = k) : 0));
      pick[near] = anchorIdx;
    }
    pick = [...new Set(pick)].sort((a, b) => a - b);
  }
  const imgs = await Promise.all(pick.map((i) => getFrameImage(i)));
  const tw = 200, th = Math.round((tw * imgs[0].naturalHeight) / imgs[0].naturalWidth);
  const cols = Math.min(5, pick.length), rows = Math.ceil(pick.length / cols);
  const gap = 10, label = 26;
  const c = document.createElement('canvas');
  c.width = cols * tw + (cols + 1) * gap;
  c.height = rows * (th + label) + (rows + 1) * gap;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  const t0 = R.frames[anchorIdx].t;
  pick.forEach((fi, k) => {
    const col = k % cols, row = Math.floor(k / cols);
    const x = gap + col * (tw + gap), y = gap + row * (th + label + gap);
    g.drawImage(imgs[k], x, y, tw, th);
    if (fi === anchorIdx) {
      g.strokeStyle = '#ff3b30';
      g.lineWidth = 5;
      g.strokeRect(x + 2.5, y + 2.5, tw - 5, th - 5);
    }
    const dt = (R.frames[fi].t - t0) / 1000;
    g.fillStyle = fi === anchorIdx ? '#ff3b30' : '#333333';
    g.font = 'bold 15px "Microsoft JhengHei UI","PingFang TC",sans-serif';
    g.textBaseline = 'top';
    g.fillText(fi === anchorIdx ? `標註這格（${fmtRel(relSec(fi))}）` : `${dt >= 0 ? '+' : ''}${dt.toFixed(2)} 秒`, x, y + th + 5);
  });
  return c;
}

async function submitAll() {
  const R = S.review;
  if (!R) return;
  hideTextInput(true);
  const pending = liveDrafts()
    .filter((d) => !d.noteId && draftHasContent(d))
    .sort((a, b) => a.t - b.t);
  if (!pending.length) return toast('還沒有要送出的回報', true);
  if (!R.clip.project) {
    $('#sessProject').focus();
    return toast('先在右上方「測哪個 app」選好是哪個 app，Claude Code 才對得到專案', true, 4000);
  }
  const empty = buildItems().filter((it) => it.marker && !(it.draft && draftHasContent(it.draft))).length;
  if (empty && !confirm(`還有 ${empty} 個書籤沒寫。先把寫好的 ${pending.length} 筆送出？（沒寫的書籤會留著，之後可以再補）`)) return;
  const noDesc = pending.filter((d) => !d.description.trim()).length;
  if (noDesc && !confirm(`有 ${noDesc} 筆只有框選、沒寫說明。Claude 只能看圖猜，確定要送出嗎？`)) return;

  const btn = $('#btnSubmitAll');
  btn.disabled = true;
  const sent = [];
  try {
    for (const [k, d] of pending.entries()) {
      btn.textContent = `送出中 ${k + 1}/${pending.length}…`;
      const idx = indexOfFile(d.f);
      const img = await getFrameImage(idx);
      const full = renderAnnotated(img, d.annotations);
      const crop = cropAround(full, d.annotations);
      const seq = await buildSequence(R, idx, d.range);
      const hasRange = d.range && d.range.startT != null && d.range.endT != null;
      const res = await api('POST', '/api/notes', {
        clipId: R.clip.id,
        frameFile: d.f,
        frameTime: relSec(idx),
        range: hasRange ? { start: relSec(frameIndexAt(d.range.startT)), end: relSec(frameIndexAt(d.range.endT)) } : null,
        frameSize: { w: img.naturalWidth, h: img.naturalHeight },
        annotations: d.annotations,
        description: d.description.trim(),
        project: R.clip.project || '',
        markerNumber: d.markerT != null ? R.markers.findIndex((m) => m.t === d.markerT) + 1 || null : null,
        sessionDuration: relSec(R.frames.length - 1),
        quiet: true,
        images: {
          full: full.toDataURL('image/png'),
          crop: crop ? crop.toDataURL('image/png') : null,
          sequence: seq ? seq.toDataURL('image/jpeg', 0.86) : null,
        },
      });
      d.noteId = res.note.id;
      d.number = res.note.number;
      sent.push(res.note);
      await saveDrafts(R);
    }
  } catch (e) {
    toast(`送到第 ${sent.length + 1} 筆時失敗：${e.message}。已送出的不會重複送，再按一次會接著送。`, true, 6000);
  } finally {
    btn.disabled = false;
    api('POST', '/api/notify').catch(() => {});
    refreshBadge();
    renderItems();
    renderEditor();
    setupTimeline();
    drawReview();
  }
  if (sent.length) showDone(sent);
}

$('#btnSubmitAll').onclick = submitAll;

function showForm() {
  for (const id of ['#editor', '#items', '.items-head', '.submit-bar', '.sess-head']) $(id).hidden = false;
  $('#formDone').hidden = true;
}

async function showDone(sent) {
  const R = S.review;
  for (const id of ['#editor', '#items', '.items-head', '.submit-bar']) $(id).hidden = true;
  $('#formDone').hidden = false;
  const nums = sent.map((n) => n.number);
  $('#doneTitle').textContent = `已送出 ${sent.length} 筆回報`;
  $('#doneSub').textContent = `${R.clip.project || '未分類'}・#${Math.min(...nums)}${nums.length > 1 ? `–#${Math.max(...nums)}` : ''}`;
  const proj = projectByName(R.clip.project);
  $('#btnLaunch').hidden = !(proj && proj.localPath && S.state?.platform === 'win32');
  R.sentIds = nums.join(',');
  try {
    R.prompt = (await api('GET', `/api/notes/prompt-ids?ids=${R.sentIds}`)).prompt;
  } catch {
    R.prompt = `請用芹查的 MCP 工具處理回報 ${nums.map((n) => `#${n}`).join('、')}。`;
  }
}

$('#btnCopyPrompt').onclick = async () => {
  await copyText(S.review.prompt);
  toast('已複製，貼到 Claude Code 就會逐筆處理');
};
$('#btnLaunch').onclick = async () => {
  try {
    await api('POST', '/api/notes/launch-ids', { project: S.review.clip.project, ids: S.review.sentIds });
    toast('已開啟 Claude Code 視窗');
  } catch (e) {
    toast(e.message, true);
  }
};
$('#btnKeepEditing').onclick = showForm;
$('#btnBackLive').onclick = () => (location.hash = '#live');
// ---------------------------------------------------------------------------
// 回報清單
// ---------------------------------------------------------------------------

async function renderNotes() {
  const sel = $('#noteProject');
  sel.innerHTML = projectOptions(S.noteProject, true);
  for (const b of $$('#noteFilter button')) b.classList.toggle('on', b.dataset.f === S.noteFilter);
  const statusQ = { todo: 'open,reopened', fixed: 'fixed', closed: 'closed', all: 'all' }[S.noteFilter];
  const q = new URLSearchParams({ status: statusQ });
  if (S.noteProject) q.set('project', S.noteProject);
  const notes = await api('GET', `/api/notes?${q}`);
  const proj = projectByName(S.noteProject);
  $('#btnLaunchAll').hidden = !(proj?.localPath && S.state?.platform === 'win32');
  $('#btnLaunchAll').title = proj ? '' : '先在上面選一個有設定資料夾的專案';
  const grid = $('#noteGrid');
  if (!notes.length) {
    const msg = { todo: '沒有待修的回報。', fixed: '沒有等你驗收的回報。', closed: '還沒有結案的回報。', all: '還沒有回報。' }[S.noteFilter];
    grid.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  grid.innerHTML = notes
    .map((n) => {
      const thumb = n.files?.crop || n.files?.full;
      return `<div class="note-card" data-id="${n.id}">
        <div class="note-thumb">${thumb ? `<img src="/notes/${n.id}/${thumb}" alt="">` : ''}</div>
        <div class="note-body">
          <div class="note-num">#${n.number} · ${fmtTime(n.createdAt)}</div>
          <div class="note-title">${esc(n.title)}</div>
          <div class="note-tags">
            <span class="tag st-${n.status}">${STATUS_LABEL[n.status]}</span>
            <span class="tag">${esc(n.project || '未分類')}</span>
            ${n.sessionNumber ? `<span class="tag">第 ${n.sessionNumber} 場</span>` : ''}
          </div>
        </div>
      </div>`;
    })
    .join('');
}

$('#noteGrid').addEventListener('click', (e) => {
  const c = e.target.closest('.note-card');
  if (c) location.hash = `#note/${c.dataset.id}`;
});
$('#noteFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.noteFilter = b.dataset.f;
  renderNotes();
});
$('#noteProject').addEventListener('change', (e) => {
  S.noteProject = e.target.value;
  localStorage.setItem('cc.noteProject', S.noteProject);
  renderNotes();
});
$('#btnCopyAll').onclick = async () => {
  const r = await api('GET', `/api/notes/prompt-all?project=${encodeURIComponent(S.noteProject)}`);
  await copyText(r.prompt);
  toast('已複製，貼到 Claude Code 就會逐筆處理');
};
$('#btnLaunchAll').onclick = async () => {
  try {
    await api('POST', '/api/notes/launch-all', { project: S.noteProject });
    toast('已開啟 Claude Code 視窗');
  } catch (e) {
    toast(e.message, true);
  }
};

// ---------------------------------------------------------------------------
// 單筆回報＋驗收
// ---------------------------------------------------------------------------

function isTypingInNotePage() {
  const a = document.activeElement;
  if (a && $('#notePage').contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return true;
  return !!(S.notePage?.captured || $('#verifyComment')?.value);
}

async function renderNotePage(id) {
  let note;
  try {
    note = await api('GET', `/api/notes/${id}`);
  } catch {
    $('#notePage').innerHTML = '<p class="empty">找不到這筆回報。</p>';
    return;
  }
  S.notePage = { id, note, captured: S.notePage?.id === id ? S.notePage.captured : null };
  const f = note.files || {};
  const img = (file, cap) => (file ? `<figure><img src="/notes/${note.id}/${file}" data-zoom alt=""><figcaption>${cap}</figcaption></figure>` : '');
  const proj = projectByName(note.project);
  const canLaunch = proj?.localPath && S.state?.platform === 'win32';
  const history = (note.history || [])
    .map((h) => {
      const what = h.action === 'created' ? '建立回報' : h.action === 'comment' ? '留言' : STATUS_LABEL[h.action] || h.action;
      return `<li><span class="who ${h.by === 'Claude' ? 'claude' : ''}">${esc(h.by)}</span><span class="when">${fmtTime(h.at)}</span>
        <span class="what">${esc(what)}${h.text && h.action !== 'created' ? `：${esc(h.text)}` : ''}</span>
        ${h.image ? `<img src="/notes/${note.id}/${h.image}" data-zoom style="max-height:120px;margin-top:6px;border-radius:6px" alt="">` : ''}</li>`;
    })
    .join('');

  let actions = '';
  if (note.status === 'open' || note.status === 'reopened') {
    actions = `<button class="primary" data-act="copy">複製給 Claude</button>
      ${canLaunch ? '<button data-act="launch">用 Claude Code 開啟</button>' : ''}
      <button data-act="close">不用修了，結案</button>`;
  } else if (note.status === 'closed') {
    actions = '<button data-act="reopen">重新打開</button>';
  } else if (note.status === 'fixed') {
    actions = '<button data-act="copy">複製給 Claude</button>';
  }
  actions += '<button class="danger" data-act="delete">刪除</button>';

  const verify =
    note.status === 'fixed'
      ? `<div class="card">
          <h2>驗收</h2>
          <div class="fix-box"><strong>Claude 說：</strong>${esc(note.fixSummary || '（沒有寫）')}</div>
          <p class="muted small">手機裝上新版、切到同一個畫面，右邊會即時顯示手機現在的樣子。對照左邊，沒問題就結案。</p>
          <div class="verify">
            <div class="pane"><div class="pane-title">修改前（你標的）</div>${f.full ? `<img src="/notes/${note.id}/${f.full}" data-zoom alt="">` : ''}</div>
            <div class="pane"><div class="pane-title" id="afterTitle">修改後（手機現在的畫面）</div>
              <canvas id="verifyCanvas"></canvas>
              <div id="verifyEmpty" class="muted small" hidden>手機沒有在投影。連上後這裡會顯示現在的畫面。</div>
              <div style="margin-top:8px"><button id="btnCapture">拍下現在的畫面</button></div>
            </div>
          </div>
          <div class="verify-actions">
            <textarea id="verifyComment" rows="3" placeholder="還沒好的話，寫哪裡還不對（退回時會一起給 Claude）"></textarea>
            <div class="row">
              <button id="btnReject">還沒好，退回重修</button>
              <button class="primary" id="btnPass">通過，結案</button>
            </div>
          </div>
        </div>`
      : '';

  $('#notePage').innerHTML = `
    <button class="ghost back" onclick="location.hash='#notes'">← 回報清單</button>
    <div class="note-head">
      <div>
        <div class="note-tags">
          <span class="tag">#${note.number}</span>
          <span class="tag st-${note.status}">${STATUS_LABEL[note.status]}</span>
          <span class="tag">${esc(note.project || '未分類')}</span>
          ${note.sessionNumber ? `<a class="tag" href="#review/${note.clipId}">第 ${note.sessionNumber} 場測試</a>` : ''}
          <span class="tag">${fmtTime(note.createdAt)}</span>
        </div>
        <h1>${esc(note.title)}</h1>
      </div>
      <div class="actions">${actions}</div>
    </div>
    <div class="note-cols">
      <div>
        ${verify}
        <div class="card">
          <h2>畫面</h2>
          <div class="imgs">
            ${img(f.crop, '框選處放大')}
            ${img(f.full, '整張畫面＋標註')}
          </div>
          ${f.sequence ? `<div class="imgs" style="margin-top:12px">${img(f.sequence, '前後連續畫面（紅框是標註那格）')}</div>` : ''}
        </div>
      </div>
      <div>
        <div class="card">
          <h2>說明 <button class="ghost small" id="btnEditDesc" style="float:right">編輯</button></h2>
          <div class="desc" id="descView">${esc(note.description || '（沒有寫說明）')}</div>
          <div id="descEdit" hidden>
            <textarea id="descInput" rows="6">${esc(note.description)}</textarea>
            <label style="margin-top:8px">專案<select id="projInput">${projectOptions(note.project)}</select></label>
            <div style="text-align:right"><button class="primary" id="btnSaveDesc">儲存</button></div>
          </div>
        </div>
        <div class="card">
          <h2>處理紀錄</h2>
          <ul class="history">${history}</ul>
        </div>
        ${note.clipId ? `<p class="muted small">來自<a href="#review/${note.clipId}">${note.sessionNumber ? `第 ${note.sessionNumber} 場測試` : '這場測試'}</a>（錄影可能已被自動清掉，回報本身不受影響）</p>` : ''}
      </div>
    </div>`;
  if (note.status === 'fixed') {
    if (S.notePage.captured) showCaptured();
    else drawVerifyLive();
  }
}

function drawVerifyLive() {
  const c = $('#verifyCanvas');
  if (!c || S.view !== 'note' || S.notePage?.captured) return;
  const connected = S.phone?.connected && S.latestBitmap;
  $('#verifyEmpty').hidden = !!connected;
  c.hidden = !connected;
  if (!connected) return;
  const b = S.latestBitmap;
  if (c.width !== b.width || c.height !== b.height) {
    c.width = b.width;
    c.height = b.height;
  }
  c.getContext('2d').drawImage(b, 0, 0);
}

function showCaptured() {
  const c = $('#verifyCanvas');
  if (!c || !S.notePage?.captured) return;
  const img = new Image();
  img.onload = () => {
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
  };
  img.src = S.notePage.captured;
  c.hidden = false;
  $('#verifyEmpty').hidden = true;
  $('#afterTitle').textContent = '修改後（已拍下）';
  $('#btnCapture').textContent = '重拍（回到即時畫面）';
}

$('#notePage').addEventListener('click', async (e) => {
  const z = e.target.closest('[data-zoom]');
  if (z) {
    $('#lightboxImg').src = z.src;
    $('#lightbox').hidden = false;
    return;
  }
  const P = S.notePage;
  if (!P) return;
  const id = P.id;
  const act = e.target.closest('[data-act]')?.dataset.act;
  try {
    if (act === 'copy') {
      await copyText(P.note.prompt);
      toast('已複製，貼到 Claude Code 就會開始處理');
    } else if (act === 'launch') {
      await api('POST', `/api/notes/${id}/launch`);
      toast('已開啟 Claude Code 視窗');
    } else if (act === 'close') {
      await api('PATCH', `/api/notes/${id}`, { status: 'closed', comment: '不用修了' });
      renderNotePage(id);
    } else if (act === 'reopen') {
      await api('PATCH', `/api/notes/${id}`, { status: 'open', comment: '重新打開' });
      renderNotePage(id);
    } else if (act === 'delete') {
      if (!confirm(`刪除回報 #${P.note.number}？`)) return;
      await api('DELETE', `/api/notes/${id}`);
      location.hash = '#notes';
    }
  } catch (err) {
    toast(err.message, true);
  }
  if (e.target.id === 'btnCapture') {
    if (P.captured) {
      P.captured = null;
      $('#afterTitle').textContent = '修改後（手機現在的畫面）';
      e.target.textContent = '拍下現在的畫面';
      drawVerifyLive();
    } else {
      if (!S.latestBitmap || !S.phone?.connected) return toast('手機沒有在投影', true);
      const c = document.createElement('canvas');
      c.width = S.latestBitmap.width;
      c.height = S.latestBitmap.height;
      c.getContext('2d').drawImage(S.latestBitmap, 0, 0);
      P.captured = c.toDataURL('image/jpeg', 0.9);
      showCaptured();
    }
  }
  if (e.target.id === 'btnPass' || e.target.id === 'btnReject') {
    const pass = e.target.id === 'btnPass';
    const comment = $('#verifyComment').value.trim();
    if (!pass && !comment) return toast('請寫一下哪裡還不對，Claude 才知道要改什麼', true);
    let afterImage = P.captured;
    if (!afterImage && S.latestBitmap && S.phone?.connected) {
      const c = document.createElement('canvas');
      c.width = S.latestBitmap.width;
      c.height = S.latestBitmap.height;
      c.getContext('2d').drawImage(S.latestBitmap, 0, 0);
      afterImage = c.toDataURL('image/jpeg', 0.9);
    }
    try {
      await api('PATCH', `/api/notes/${id}`, {
        status: pass ? 'closed' : 'reopened',
        comment: comment || (pass ? '驗收通過' : ''),
        afterImage,
      });
      P.captured = null;
      toast(pass ? `#${P.note.number} 已結案` : `#${P.note.number} 已退回重修`);
      refreshBadge();
      renderNotePage(id);
    } catch (err) {
      toast(err.message, true);
    }
  }
  if (e.target.id === 'btnEditDesc') {
    $('#descView').hidden = true;
    $('#descEdit').hidden = false;
    $('#descInput').focus();
  }
  if (e.target.id === 'btnSaveDesc') {
    await api('PATCH', `/api/notes/${id}`, { description: $('#descInput').value, project: $('#projInput').value });
    toast('已儲存');
    renderNotePage(id);
  }
});

$('#lightbox').onclick = () => ($('#lightbox').hidden = true);

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

let draftKeys = null;
function renderSettings() {
  const c = S.config;
  $('#sPre').value = c.preSeconds;
  $('#sOffset').value = c.markerOffset ?? 1;
  $('#sScanRoots').value = (c.scanRoots || []).join('\n');
  $('#sOpenReview').checked = !!c.openReviewAfterMark;
  $('#sPcName').value = c.pcName || '';
  $('#mcpCmd').textContent = S.state.mcpCommand;
  $('#dataDir').textContent = S.state.dataDir;
  draftKeys = { markKeys: [...c.markKeys], recordKeys: [...c.recordKeys] };
  renderKeys();
  const rows = (c.projects.length ? c.projects : [{ name: '', repo: '', localPath: '' }]).map(projRow).join('');
  $('#projRows').innerHTML = rows;
}

function projRow(p) {
  return `<tr data-found="${esc(p.found || '')}">
    <td><input type="text" data-k="name" value="${esc(p.name)}" placeholder="茄記">${p.found ? `<span class="proj-kind">自動找到（${esc(p.found)}）</span>` : ''}</td>
    <td><input type="text" data-k="repo" value="${esc(p.repo)}" placeholder="domyweb666/qieji-app"></td>
    <td><input type="text" data-k="localPath" value="${esc(p.localPath)}" placeholder="C:\\Users\\你\\Projects\\qieji-app"></td>
    <td><button class="ghost" data-delrow title="刪除">✕</button></td>
  </tr>`;
}

function renderKeys() {
  for (const [field, el] of [['markKeys', '#sMarkKeys'], ['recordKeys', '#sRecKeys']]) {
    const listening = S.keyListen === field;
    $(el).innerHTML =
      draftKeys[field].map((k, i) => `<span class="key">${esc(keyName(k))}<button data-field="${field}" data-rm="${i}">✕</button></span>`).join('') +
      `<button class="add-key ${listening ? 'listening' : ''}" data-listen="${field}">${listening ? '請按下按鍵或踩踏板…' : '＋ 新增按鍵'}</button>`;
  }
}

for (const el of ['#sMarkKeys', '#sRecKeys']) {
  $(el).addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      draftKeys[rm.dataset.field].splice(Number(rm.dataset.rm), 1);
      renderKeys();
    }
    const ls = e.target.closest('[data-listen]');
    if (ls) {
      S.keyListen = S.keyListen === ls.dataset.listen ? null : ls.dataset.listen;
      renderKeys();
    }
  });
}

$('#btnScan').onclick = async () => {
  const btn = $('#btnScan');
  btn.disabled = true;
  $('#scanResult').textContent = '掃描中，可能要幾十秒…';
  try {
    const r = await api('POST', '/api/projects/scan');
    await refreshState();
    renderSettings();
    const parts = [`看過 ${r.scannedRepos} 個 git 專案`];
    parts.push(r.added.length ? `新增 ${r.added.map((x) => x.name).join('、')}` : '沒有新的 app');
    if (r.filled.length) parts.push(`補上資料夾：${r.filled.join('、')}`);
    $('#scanResult').textContent = parts.join('，');
  } catch (e) {
    $('#scanResult').textContent = `掃描失敗：${e.message}`;
  } finally {
    btn.disabled = false;
  }
};

$('#btnAddProj').onclick = () => $('#projRows').insertAdjacentHTML('beforeend', projRow({ name: '', repo: '', localPath: '' }));
$('#projRows').addEventListener('click', (e) => {
  if (e.target.closest('[data-delrow]')) e.target.closest('tr').remove();
});

$('#btnSaveSettings').onclick = async () => {
  const projects = $$('#projRows tr').map((tr) => {
    const o = {};
    for (const inp of $$('input', tr)) o[inp.dataset.k] = inp.value.trim();
    if (tr.dataset.found) o.found = tr.dataset.found;
    return o;
  });
  try {
    const r = await api('PUT', '/api/config', {
      preSeconds: Number($('#sPre').value),
      markerOffset: Number($('#sOffset').value),
      scanRoots: $('#sScanRoots').value.split(/\r?\n/),
      openReviewAfterMark: $('#sOpenReview').checked,
      pcName: $('#sPcName').value.trim(),
      markKeys: draftKeys.markKeys,
      recordKeys: draftKeys.recordKeys,
      projects,
    });
    S.config = r.config;
    await refreshState();
    renderSettings();
    toast('設定已儲存');
  } catch (e) {
    toast(e.message, true);
  }
};

$('#btnNewToken').onclick = async () => {
  if (!confirm('更換配對碼後，手機要重新掃描 QR code 才能連上。確定嗎？')) return;
  await api('POST', '/api/config/new-token');
  await refreshState();
  toast('已更換配對碼，請手機重新掃描');
};

$('#btnCopyMcp').onclick = async () => {
  await copyText(S.state.mcpCommand);
  toast('已複製');
};




// ---------------------------------------------------------------------------
// 鍵盤
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  // 設定頁：錄下按鍵
  if (S.keyListen) {
    e.preventDefault();
    if (e.key !== 'Escape' && !draftKeys[S.keyListen].includes(e.key)) draftKeys[S.keyListen].push(e.key);
    S.keyListen = null;
    renderKeys();
    return;
  }
  if (e.key === 'Escape') {
    $('#lightbox').hidden = true;
    if (S.review) {
      S.review.selected = -1;
      drawReview();
    }
  }
  if (isTyping(e)) return;
  if (S.view !== 'settings' && !e.repeat) {
    if ((S.config?.markKeys || []).includes(e.key)) {
      e.preventDefault();
      return doMarker();
    }
    if ((S.config?.recordKeys || []).includes(e.key)) {
      e.preventDefault();
      return toggleSession();
    }
  }
  if (S.view !== 'review' || !S.review) return;
  const R = S.review;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
    e.preventDefault();
    return doUndo();
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    return moveTo(R.index + (k === 'ArrowLeft' ? -step : step));
  }
  if (k === ' ') {
    e.preventDefault();
    // 焦點停在按鈕上時，放開空白鍵會再按一次那個按鈕；先移開焦點
    if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
    return togglePlay();
  }
  if (k === 'Delete' || k === 'Backspace') {
    const d = draftAtIndex(R.index);
    if (d && !d.noteId && R.selected >= 0) {
      e.preventDefault();
      pushUndo(d);
      d.annotations.splice(R.selected, 1);
      R.selected = -1;
      scheduleSave();
      drawReview();
    }
    return;
  }
  const lk = k.toLowerCase();
  if (lk === 'n') return nextItem(e.shiftKey ? -1 : 1);
  if (lk === 'm' && R.selMarkerT != null) return moveMarker(R.selMarkerT, R.index);
  const tools = { v: 'select', r: 'rect', c: 'ellipse', a: 'arrow', p: 'pen', t: 'text' };
  if (tools[lk]) return setTool(tools[lk]);
  if (lk === 'i' || k === '[') return setRangeIn();
  if (lk === 'o' || k === ']') return setRangeOut();
  if (k === 'Enter') {
    e.preventDefault();
    return $('#fDesc').focus();
  }
});

setInterval(() => {
  if (S.session) updateStatusUi();
}, 1000);

$('#btnMark').onclick = doMarker;
$('#btnSession').onclick = toggleSession;
$('#ipSelect').addEventListener('change', (e) => {
  pairIp = e.target.value;
  localStorage.setItem('cc.pairIp', pairIp);
  loadPair();
});

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------

(async function init() {
  setTool(S.tool);
  setColor(S.color);
  try {
    await refreshState();
  } catch (e) {
    toast(`連不上芹查伺服器：${e.message}`, true, 8000);
  }
  connectLive();
  refreshBadge();
  window.addEventListener('hashchange', route);
  route();
})();
