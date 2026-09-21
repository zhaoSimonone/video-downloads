import { ComparePlayback } from './compare-playback.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { platform: 'douyin', result: null, history: [], compareItems: [] };

function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(window.__toast); window.__toast = setTimeout(() => el.classList.remove('show'), 3200); }
function platformName(platform) { return platform === 'channels' ? '微信视频号' : platform === 'douyin' ? '抖音' : platform === 'instagram' ? 'Instagram' : platform === 'tiktok' ? 'TikTok' : '未知平台'; }
function formatRecordTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function formatFileSize(bytes) { if (!Number.isFinite(bytes) || bytes < 0) return '--'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
async function loadHistory() {
  try {
    const response = await fetch('/api/download-records?status=completed');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取下载记录失败');
    state.history = Array.isArray(data.records) ? data.records : [];
    renderHistory(); renderRecentHistory();
  } catch (error) {
    console.warn('Unable to load ClipDock download records:', error);
    state.history = [];
    renderHistory(); renderRecentHistory();
  }
}
function setPlatform(platform) { state.platform = platform; $$('.platform-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.platform === platform)); $('#urlInput').placeholder = platform === 'channels' ? '粘贴微信视频号链接…' : platform === 'instagram' ? '粘贴 Instagram Reel 链接…' : platform === 'tiktok' ? '粘贴 TikTok 视频链接…' : '粘贴抖音链接…'; $('#inputHint').textContent = platform === 'channels' ? '例如：https://channels.weixin.qq.com/…' : platform === 'instagram' ? '例如：https://www.instagram.com/reel/…' : platform === 'tiktok' ? '例如：https://www.tiktok.com/@…/video/…' : '例如：https://v.douyin.com/…'; }
function renderResult(result) {
  state.result = result; if (result.platform) setPlatform(result.platform); $('#emptyState').classList.add('hidden'); $('#resultContent').classList.remove('hidden');
  $('#resultTitle').textContent = result.title; $('#resultAuthor').textContent = result.author; $('#resultDuration').textContent = result.duration; $('#resultPlatform').textContent = platformName(result.platform); $('#resultSource').textContent = result.source;
  $('#previewLabel').textContent = platformName(result.platform).toUpperCase(); $('#resultNotice').classList.toggle('hidden', result.direct && !result.captureRequired); $('#downloadButton').disabled = !result.direct && !result.agentJobId && !result.capturedId; $('#openSource').href = result.pageSource || result.source; $('#resultNotice p').textContent = result.message || '分享页受登录态保护。请打开原页面完成扫码，再复制媒体直链。';
  $('#captureButton').classList.toggle('hidden', !(result.captureRequired && !result.capturedId)); $('#captureButton').disabled = Boolean(result.captureId); $('#captureButton').textContent = result.captureId ? '等待视频播放…' : '打开并捕获';
  $('#downloadButton span:last-child').textContent = result.agentJobId ? '下载到本地' : '下载视频';
  $('#queueStatus').textContent = result.direct || result.capturedId ? '可下载' : result.agentJobId ? '代理已就绪' : result.captureId ? '等待捕获' : '需捕获';
}
function renderHistory() {
  $('#historyCount').textContent = state.history.length;
  $('#historyEmpty').classList.toggle('hidden', state.history.length > 0);
  $('#historyList').innerHTML = state.history.map(item => `<a class="history-entry" href="${historyFileHref(item)}" title="${escapeHtml(item.filePath || '')}"><span class="history-platform ${historyPlatformClass(item.platform)}">${historyPlatformIcon(item.platform)}</span><div class="history-meta"><strong>${escapeHtml(item.title)}</strong><small class="history-source">${escapeHtml(item.sourceUrl)}</small><small>${escapeHtml(historyDetails(item))}</small></div><span class="history-state">定位文件 ↗</span></a>`).join('');
}
function historyFileHref(item) { return item.filePath ? `clipdock://reveal-download?path=${encodeURIComponent(item.filePath)}` : 'clipdock://open-downloads'; }
function historyPlatformClass(platform) { return platform === 'channels' ? 'channels-logo' : platform === 'instagram' ? 'instagram-logo' : platform === 'tiktok' ? 'tiktok-logo' : 'douyin-logo'; }
function historyPlatformIcon(platform) { return platform === 'channels' ? '◉' : platform === 'instagram' ? '◎' : platform === 'tiktok' ? '♪' : '♪'; }
function renderRecentHistory() {
  const list = $('#recentHistoryList'); const empty = $('#recentHistoryEmpty'); if (!list || !empty) return;
  const entries = state.history.slice(0, 3); empty.classList.toggle('hidden', entries.length > 0);
  list.innerHTML = entries.map(item => `<a class="recent-entry" href="${historyFileHref(item)}"><span class="history-platform ${historyPlatformClass(item.platform)}">${historyPlatformIcon(item.platform)}</span><span><strong>${escapeHtml(item.title)}</strong><small>${formatRecordTime(item.completedAt)} · ${formatFileSize(item.fileSizeBytes)} · 定位文件 ↗</small></span></a>`).join('');
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function historyDetails(item) { return `${formatRecordTime(item.completedAt)} · ${formatFileSize(item.fileSizeBytes)} · ${item.filePath || '--'}`; }

const compareStage = $('#compareStage');
const compareFileInput = $('#compareFileInput');
const compareEmpty = $('#compareEmpty');
const comparePlayButton = $('#comparePlayButton');
const compareMuteButton = $('#compareMuteButton');
const compareSpeed = $('#compareSpeed');
const compareClearButton = $('#compareClearButton');
const compareSeek = $('#compareSeek');
const compareTimeline = $('#compareTimeline');
let compareScrubbing = false;
let compareResumeAfterSeek = false;
let compareControlsKey = '';
const comparePlayback = new ComparePlayback({
  onChange: () => { compareUpdateControls(); compareUpdateTimeline(); },
  onError: error => toast(error?.name === 'NotAllowedError' ? '播放被系统阻止，请重新点击播放' : '视频无法播放或加载超时，请检查文件是否支持在本机播放'),
});

function compareVideos() { return state.compareItems.map(item => item.video).filter(Boolean); }
function formatCompareTime(seconds) { if (!Number.isFinite(seconds) || seconds < 0) seconds = 0; const mins = Math.floor(seconds / 60); const secs = Math.floor(seconds % 60); return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`; }
function compareUpdateControls() {
  const count = state.compareItems.length; const hasItems = count > 0;
  const controlsKey = `${count}:${comparePlayback.status}:${comparePlayback.wantsPlayback}:${comparePlayback.muted}:${comparePlayback.duration}`;
  if (controlsKey === compareControlsKey) return;
  compareControlsKey = controlsKey;
  $('#compareCount').textContent = `${count} / 3 个视频`;
  $('#compareHint').textContent = count >= 3 ? '已达到并排比较上限。' : '视频只在当前设备中播放，不会上传。';
  comparePlayButton.disabled = !hasItems; compareMuteButton.disabled = !hasItems; compareSpeed.disabled = !hasItems; compareClearButton.disabled = !hasItems;
  compareTimeline.classList.toggle('hidden', !hasItems);
  const playLabel = comparePlayback.wantsPlayback ? (comparePlayback.status === 'loading' ? '准备中…' : '暂停播放') : '同时播放';
  const playIcon = comparePlayback.wantsPlayback ? 'Ⅱ' : '▶';
  if (comparePlayButton.lastElementChild.textContent !== playLabel) comparePlayButton.lastElementChild.textContent = playLabel;
  if (comparePlayButton.firstElementChild.textContent !== playIcon) comparePlayButton.firstElementChild.textContent = playIcon;
  compareMuteButton.querySelector('span:last-child').textContent = comparePlayback.muted ? '取消静音' : '静音';
  compareMuteButton.querySelector('span:first-child').textContent = comparePlayback.muted ? '◉' : '⌕';
  compareStage.setAttribute('aria-busy', String(comparePlayback.status === 'loading'));
  compareSeek.disabled = !comparePlayback.duration;
}
function compareUpdateTimeline() {
  if (compareScrubbing) return;
  compareSeek.max = String(comparePlayback.duration);
  compareSeek.value = String(comparePlayback.currentTime);
  $('#compareCurrentTime').textContent = formatCompareTime(comparePlayback.currentTime);
  $('#compareDuration').textContent = formatCompareTime(comparePlayback.duration);
}
function compareSetPlayback(shouldPlay) {
  if (shouldPlay) comparePlayback.play(); else comparePlayback.pause();
}
function compareRender() {
  compareScrubbing = false;
  compareEmpty.classList.toggle('hidden', state.compareItems.length > 0);
  state.compareItems.forEach((item, index) => {
    if (item.card) {
      item.card.querySelector('.compare-video-badge').textContent = String(index + 1).padStart(2, '0');
      return;
    }
    const card = document.createElement('article'); card.className = 'compare-card'; card.dataset.index = String(index);
    card.innerHTML = `<div class="compare-card-head"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><button type="button" class="compare-remove" aria-label="移除 ${escapeHtml(item.name)}" title="移除视频">×</button></div><div class="compare-video-wrap"><video preload="auto" playsinline></video><span class="compare-video-badge">${String(index + 1).padStart(2, '0')}</span></div>`;
    const video = card.querySelector('video'); video.src = item.url; item.video = video; item.card = card;
    video.addEventListener('click', () => compareSetPlayback(!comparePlayback.wantsPlayback));
    card.querySelector('.compare-remove').addEventListener('click', () => compareRemove(item));
    compareStage.append(card);
  });
  comparePlayback.setVideos(compareVideos());
  compareUpdateControls(); compareUpdateTimeline();
}
function compareDispose(item) {
  item.video?.pause();
  item.video?.removeAttribute('src');
  item.video?.load();
  item.card?.remove();
  URL.revokeObjectURL(item.url);
}
function compareRemove(item) {
  state.compareItems = state.compareItems.filter(candidate => candidate !== item);
  compareRender();
  compareDispose(item);
}
function compareAddFiles(files) {
  const incoming = [...files].filter(file => file.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(file.name));
  const available = 3 - state.compareItems.length;
  incoming.slice(0, Math.max(0, available)).forEach(file => state.compareItems.push({ file, name: file.name, url: URL.createObjectURL(file), video: null }));
  if (incoming.length > available) toast('最多同时比较 3 个视频');
  if (!incoming.length) toast('请选择 MP4、MOV 或 WebM 视频');
  compareFileInput.value = ''; compareRender();
}

$('#compareAddButton').addEventListener('click', () => compareFileInput.click());
$('#compareEmptyButton').addEventListener('click', () => compareFileInput.click());
compareFileInput.addEventListener('change', event => compareAddFiles(event.target.files));
comparePlayButton.addEventListener('click', () => compareSetPlayback(!comparePlayback.wantsPlayback));
compareMuteButton.addEventListener('click', () => comparePlayback.setMuted(!comparePlayback.muted));
compareSpeed.addEventListener('change', () => comparePlayback.setRate(Number(compareSpeed.value)));
compareClearButton.addEventListener('click', () => {
  const removed = state.compareItems;
  state.compareItems = [];
  compareRender();
  removed.forEach(compareDispose);
});
compareSeek.addEventListener('input', () => {
  if (!compareScrubbing) {
    compareScrubbing = true;
    compareResumeAfterSeek = comparePlayback.wantsPlayback;
    comparePlayback.pause();
  }
  $('#compareCurrentTime').textContent = formatCompareTime(Number(compareSeek.value));
});
compareSeek.addEventListener('change', () => {
  const time = Number(compareSeek.value);
  const resume = compareScrubbing ? compareResumeAfterSeek : comparePlayback.wantsPlayback;
  compareScrubbing = false;
  comparePlayback.seek(time, resume);
});
compareStage.addEventListener('dragover', event => { event.preventDefault(); compareStage.classList.add('is-dragging'); });
compareStage.addEventListener('dragleave', () => compareStage.classList.remove('is-dragging'));
compareStage.addEventListener('drop', event => { event.preventDefault(); compareStage.classList.remove('is-dragging'); compareAddFiles(event.dataTransfer.files); });

$('#urlInput').addEventListener('input', (event) => { $('#charCount').textContent = `${event.target.value.length} / 2000`; });
$('#clearUrl').addEventListener('click', () => { $('#urlInput').value = ''; $('#charCount').textContent = '0 / 2000'; $('#urlInput').focus(); });
$$('.platform-tab').forEach(tab => tab.addEventListener('click', () => setPlatform(tab.dataset.platform)));
$$('.example-link').forEach(button => button.addEventListener('click', () => { $('#urlInput').value = button.dataset.example; $('#charCount').textContent = `${button.dataset.example.length} / 2000`; setPlatform('channels'); $('#parseForm').requestSubmit(); }));

$('#parseForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const input = $('#urlInput'); const button = $('#parseButton'); if (!input.value.trim()) return toast('请先粘贴视频链接');
  button.disabled = true; button.querySelector('span:last-child').textContent = '识别中…'; $('#queueStatus').textContent = '处理中';
  try { const response = await fetch('/api/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: input.value }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); renderResult(data); toast(data.direct ? '已识别媒体直链，可以下载' : '已识别平台链接，请查看处理提示'); } catch (error) { toast(error.message || '解析失败'); $('#queueStatus').textContent = '空闲'; } finally { button.disabled = false; button.querySelector('span:last-child').textContent = '提取信息'; }
});

async function pollCapture(platform, captureId) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const response = await fetch(`/api/${platform}/capture?id=${encodeURIComponent(captureId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `${platformName(platform)} 捕获任务失败`);
    if (data.message) $('#resultNotice p').textContent = data.message;
    if (data.status === 'captured') {
      state.result = { ...state.result, capturedId: captureId, direct: true, message: data.message };
      renderResult(state.result);
      toast(`已捕获 ${platformName(platform)} 视频，可以下载`);
      return;
    }
    if (data.status === 'failed') throw new Error(data.message || '未捕获到 Instagram 视频');
    $('#queueStatus').textContent = data.status === 'starting' ? '启动浏览器' : '等待捕获';
  }
  throw new Error(`${platformName(platform)} 捕获超时，请重新打开并播放视频`);
}

$('#captureButton').addEventListener('click', async () => {
  if (!state.result?.captureRequired || state.result?.captureId) return;
  const button = $('#captureButton'); button.disabled = true; button.textContent = '启动浏览器…'; $('#queueStatus').textContent = '启动浏览器';
  try {
    const platform = state.result.platform;
    const response = await fetch(`/api/${platform}/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: state.result.pageSource || state.result.source }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || `${platformName(platform)} 捕获启动失败`);
    state.result = { ...state.result, captureId: data.id, message: data.message };
    renderResult(state.result);
    await pollCapture(platform, data.id);
  } catch (error) {
    toast(error.message || 'Instagram 捕获失败');
    state.result = { ...state.result, captureId: null };
    renderResult(state.result);
    $('#queueStatus').textContent = '需捕获';
  }
});

async function prepareDownloadRecord(result) {
  const response = await fetch('/api/download-records/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: result.platform,
      title: result.title,
      sourceUrl: result.pageSource || result.source,
      resolvedUrl: result.source,
      quality: $('#qualitySelect').value,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.record?.id) throw new Error(data.error || '无法创建下载记录');
  return data.record;
}

async function pollDownloadRecord(recordId) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch('/api/download-records?status=all&limit=10000');
      const data = await response.json();
      const record = data.records?.find(item => item.id === recordId);
      if (!record || record.status === 'pending') continue;
      if (record.status === 'completed') {
        await loadHistory();
        $('#queueStatus').textContent = '已完成';
        toast(`下载完成：${record.fileName}`);
      } else {
        $('#queueStatus').textContent = '下载失败';
        toast(record.error || '下载未能完成');
      }
      return;
    } catch {
      // The server may be temporarily busy while the native download finishes.
    }
  }
  $('#queueStatus').textContent = '等待确认';
}

$('#downloadButton').addEventListener('click', async () => {
  if (!state.result?.direct && !state.result?.agentJobId && !state.result?.capturedId) return toast('分享页无法直接下载，请先捕获视频或提供媒体直链'); const button = $('#downloadButton'); button.disabled = true; button.querySelector('span:last-child').textContent = '准备文件…'; $('#queueStatus').textContent = '下载中';
  try {
    const filename = state.result.capturedId ? `${state.result.platform === 'tiktok' ? 'tiktok-video' : 'instagram-reel'}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}.mp4` : '';
    const record = await prepareDownloadRecord(state.result);
    const downloadUrl = state.result.capturedId
      ? `/api/${state.result.platform}/download?id=${encodeURIComponent(state.result.capturedId)}&filename=${encodeURIComponent(filename)}&recordId=${encodeURIComponent(record.id)}`
      : state.result.agentJobId
      ? `/api/agent/download?jobId=${encodeURIComponent(state.result.agentJobId)}&filename=${encodeURIComponent(state.result.title)}&recordId=${encodeURIComponent(record.id)}`
      : `/api/download?url=${encodeURIComponent(state.result.source)}&recordId=${encodeURIComponent(record.id)}`;
    // Let the browser/WKWebView handle Content-Disposition so macOS writes a
    // real file instead of keeping the response inside a Blob URL.
    window.location.assign(downloadUrl);
    void pollDownloadRecord(record.id);
    toast(state.result.capturedId ? '正在生成 QuickTime 兼容文件，完成后会记录实际文件路径' : '下载已开始，文件写入后会自动记录');
    $('#queueStatus').textContent = state.result.capturedId ? '转换中' : '等待写入';
  } catch (error) { toast(error.message || '下载失败'); $('#queueStatus').textContent = state.result.agentJobId ? '代理已就绪' : state.result.capturedId ? '已捕获' : '可下载'; } finally { button.disabled = false; button.querySelector('span:last-child').textContent = state.result.agentJobId ? '下载到本地' : '下载视频'; }
});

function downloadFilename(contentDisposition) {
  const value = String(contentDisposition || '');
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1]);
  const plain = value.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : '';
}

$$('.nav-item').forEach(item => item.addEventListener('click', () => { const view = item.dataset.view; $$('.nav-item').forEach(nav => nav.classList.toggle('active', nav === item)); $('#downloaderView').classList.toggle('hidden', view !== 'downloader'); $('#historyView').classList.toggle('hidden', view !== 'history'); $('#compareView').classList.toggle('hidden', view !== 'compare'); $('#pageTitle').textContent = view === 'history' ? '下载记录' : view === 'compare' ? '视频对比' : '下载器'; }));
$('#openHistory').addEventListener('click', () => { document.querySelector('.nav-item[data-view="history"]').click(); });
$('#clearHistory').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/download-records', { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '清空下载记录失败');
    state.history = [];
    renderHistory(); renderRecentHistory();
    toast('已清空下载记录');
  } catch (error) {
    toast(error.message || '清空下载记录失败');
  }
});
document.addEventListener('keydown', async event => {
  const input = $('#urlInput');
  const modifier = event.metaKey || event.ctrlKey;
  if (!modifier) return;
  const key = event.key.toLowerCase();
  if (key === 'v') {
    event.preventDefault();
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, start) + text + input.value.slice(end);
        input.selectionStart = input.selectionEnd = start + text.length;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch {
      input.focus();
    }
  } else if (key === 'c' && document.activeElement === input && input.selectionStart !== input.selectionEnd) {
    event.preventDefault();
    try { await navigator.clipboard.writeText(input.value.slice(input.selectionStart, input.selectionEnd)); } catch { document.execCommand('copy'); }
  }
});
renderHistory(); renderRecentHistory(); void loadHistory(); setPlatform('douyin');
