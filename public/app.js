const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { platform: 'douyin', result: null, history: JSON.parse(localStorage.getItem('clipdock-history') || '[]'), compareItems: [], compareSyncing: false, compareMuted: false };

function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(window.__toast); window.__toast = setTimeout(() => el.classList.remove('show'), 3200); }
function saveHistory() { localStorage.setItem('clipdock-history', JSON.stringify(state.history.slice(0, 20))); $('#historyCount').textContent = state.history.length; renderHistory(); renderRecentHistory(); }
function platformName(platform) { return platform === 'channels' ? '微信视频号' : platform === 'douyin' ? '抖音' : platform === 'instagram' ? 'Instagram' : platform === 'tiktok' ? 'TikTok' : '未知平台'; }
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
  $('#historyCount').textContent = state.history.length; $('#historyEmpty').classList.toggle('hidden', state.history.length > 0); $('#historyList').innerHTML = state.history.map(item => `<a class="history-entry" href="${historyFileHref(item)}"><span class="history-platform ${historyPlatformClass(item.platform)}">${historyPlatformIcon(item.platform)}</span><div class="history-meta"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source)} · ${item.time}</small></div><span class="history-state">${item.filename ? '定位文件' : '打开目录'} ↗</span></a>`).join('');
}
function historyFileHref(item) { return item.filename ? `clipdock://reveal-download?name=${encodeURIComponent(item.filename)}` : 'clipdock://open-downloads'; }
function historyPlatformClass(platform) { return platform === 'channels' ? 'channels-logo' : platform === 'instagram' ? 'instagram-logo' : platform === 'tiktok' ? 'tiktok-logo' : 'douyin-logo'; }
function historyPlatformIcon(platform) { return platform === 'channels' ? '◉' : platform === 'instagram' ? '◎' : platform === 'tiktok' ? '♪' : '♪'; }
function renderRecentHistory() {
  const list = $('#recentHistoryList'); const empty = $('#recentHistoryEmpty'); if (!list || !empty) return;
  const entries = state.history.slice(0, 3); empty.classList.toggle('hidden', entries.length > 0);
  list.innerHTML = entries.map(item => `<a class="recent-entry" href="${historyFileHref(item)}"><span class="history-platform ${historyPlatformClass(item.platform)}">${historyPlatformIcon(item.platform)}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.time)} · ${item.filename ? '定位下载文件' : '打开下载目录'} ↗</small></span></a>`).join('');
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function addHistory(result, filename = '') { state.history.unshift({ title: result.title, source: result.source, platform: result.platform, filename, time: new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }); saveHistory(); }

const compareStage = $('#compareStage');
const compareFileInput = $('#compareFileInput');
const compareEmpty = $('#compareEmpty');
const comparePlayButton = $('#comparePlayButton');
const compareMuteButton = $('#compareMuteButton');
const compareSpeed = $('#compareSpeed');
const compareClearButton = $('#compareClearButton');
const compareSeek = $('#compareSeek');
const compareTimeline = $('#compareTimeline');

function compareVideos() { return state.compareItems.map(item => item.video).filter(Boolean); }
function formatCompareTime(seconds) { if (!Number.isFinite(seconds) || seconds < 0) seconds = 0; const mins = Math.floor(seconds / 60); const secs = Math.floor(seconds % 60); return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`; }
function compareUpdateControls() {
  const count = state.compareItems.length; const videos = compareVideos(); const hasItems = count > 0;
  $('#compareCount').textContent = `${count} / 3 个视频`;
  $('#compareHint').textContent = count >= 3 ? '已达到并排比较上限。' : '视频只在当前设备中播放，不会上传。';
  comparePlayButton.disabled = !hasItems; compareMuteButton.disabled = !hasItems; compareSpeed.disabled = !hasItems; compareClearButton.disabled = !hasItems;
  compareTimeline.classList.toggle('hidden', !hasItems);
  comparePlayButton.querySelector('span:last-child').textContent = videos.some(video => !video.paused) ? '暂停播放' : '同时播放';
  comparePlayButton.querySelector('span:first-child').textContent = videos.some(video => !video.paused) ? 'Ⅱ' : '▶';
  compareMuteButton.querySelector('span:last-child').textContent = state.compareMuted ? '取消静音' : '静音';
  compareMuteButton.querySelector('span:first-child').textContent = state.compareMuted ? '◉' : '⌕';
}
function compareUpdateTimeline(sourceVideo = compareVideos()[0]) {
  if (!sourceVideo) return;
  const durations = compareVideos().map(video => video.duration).filter(Number.isFinite);
  const duration = durations.length ? Math.max(...durations) : 0;
  compareSeek.max = String(duration); compareSeek.value = String(Math.min(sourceVideo.currentTime || 0, duration));
  $('#compareCurrentTime').textContent = formatCompareTime(sourceVideo.currentTime);
  $('#compareDuration').textContent = formatCompareTime(duration);
}
function compareSetPlayback(shouldPlay) {
  const videos = compareVideos(); if (!videos.length) return;
  state.compareSyncing = true;
  if (shouldPlay) videos.forEach(video => { video.play().catch(() => {}); }); else videos.forEach(video => video.pause());
  window.setTimeout(() => { state.compareSyncing = false; compareUpdateControls(); }, 80);
}
function compareRender() {
  compareStage.querySelectorAll('.compare-card').forEach(card => card.remove());
  compareEmpty.classList.toggle('hidden', state.compareItems.length > 0);
  state.compareItems.forEach((item, index) => {
    const card = document.createElement('article'); card.className = 'compare-card'; card.dataset.index = String(index);
    card.innerHTML = `<div class="compare-card-head"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><button type="button" class="compare-remove" aria-label="移除 ${escapeHtml(item.name)}" title="移除视频">×</button></div><div class="compare-video-wrap"><video preload="metadata" playsinline></video><span class="compare-video-badge">${String(index + 1).padStart(2, '0')}</span></div>`;
    const video = card.querySelector('video'); video.src = item.url; video.muted = state.compareMuted; video.playbackRate = Number(compareSpeed.value || 1); item.video = video;
    video.addEventListener('loadedmetadata', () => compareUpdateTimeline(video));
    video.addEventListener('timeupdate', () => { if (!state.compareSyncing) compareUpdateTimeline(video); });
    video.addEventListener('play', () => { if (!state.compareSyncing) compareSetPlayback(true); compareUpdateControls(); });
    video.addEventListener('pause', () => { if (!state.compareSyncing) compareSetPlayback(false); compareUpdateControls(); });
    video.addEventListener('ended', () => { if (!state.compareSyncing) compareSetPlayback(false); compareUpdateControls(); });
    video.addEventListener('click', () => compareSetPlayback(videosArePlaying() ? false : true));
    card.querySelector('.compare-remove').addEventListener('click', () => compareRemove(index));
    compareStage.append(card);
  });
  compareUpdateControls(); compareUpdateTimeline();
}
function videosArePlaying() { return compareVideos().some(video => !video.paused); }
function compareRemove(index) { const item = state.compareItems[index]; if (!item) return; URL.revokeObjectURL(item.url); state.compareItems.splice(index, 1); compareRender(); }
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
comparePlayButton.addEventListener('click', () => compareSetPlayback(!videosArePlaying()));
compareMuteButton.addEventListener('click', () => { state.compareMuted = !state.compareMuted; compareVideos().forEach(video => { video.muted = state.compareMuted; }); compareUpdateControls(); });
compareSpeed.addEventListener('change', () => compareVideos().forEach(video => { video.playbackRate = Number(compareSpeed.value); }));
compareClearButton.addEventListener('click', () => { state.compareItems.forEach(item => URL.revokeObjectURL(item.url)); state.compareItems = []; compareRender(); });
compareSeek.addEventListener('input', () => { const time = Number(compareSeek.value); state.compareSyncing = true; compareVideos().forEach(video => { video.currentTime = Math.min(time, Number.isFinite(video.duration) ? video.duration : time); }); compareUpdateTimeline(compareVideos()[0]); window.setTimeout(() => { state.compareSyncing = false; }, 80); });
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

$('#downloadButton').addEventListener('click', async () => {
  if (!state.result?.direct && !state.result?.agentJobId && !state.result?.capturedId) return toast('分享页无法直接下载，请先捕获视频或提供媒体直链'); const button = $('#downloadButton'); button.disabled = true; button.querySelector('span:last-child').textContent = '准备文件…'; $('#queueStatus').textContent = '下载中';
  try {
    const filename = state.result.capturedId ? `${state.result.platform === 'tiktok' ? 'tiktok-video' : 'instagram-reel'}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}.mp4` : '';
    const downloadUrl = state.result.capturedId
      ? `/api/${state.result.platform}/download?id=${encodeURIComponent(state.result.capturedId)}&filename=${encodeURIComponent(filename)}`
      : state.result.agentJobId
      ? `/api/agent/download?jobId=${encodeURIComponent(state.result.agentJobId)}&filename=${encodeURIComponent(state.result.title)}`
      : `/api/download?url=${encodeURIComponent(state.result.source)}`;
    // Let the browser/WKWebView handle Content-Disposition so macOS writes a
    // real file instead of keeping the response inside a Blob URL.
    window.location.assign(downloadUrl);
    addHistory(state.result, filename);
    toast(state.result.capturedId ? '正在生成 QuickTime 兼容文件，随后保存到“下载”文件夹' : '下载已开始，请在“下载”文件夹查看');
    $('#queueStatus').textContent = state.result.capturedId ? '转换中' : '已完成';
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
$('#clearHistory').addEventListener('click', () => { state.history = []; saveHistory(); toast('已清空下载记录'); });
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
renderHistory(); renderRecentHistory(); setPlatform('douyin');
