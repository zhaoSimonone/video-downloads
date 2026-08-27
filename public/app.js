const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { platform: 'douyin', result: null, history: JSON.parse(localStorage.getItem('clipdock-history') || '[]') };

function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(window.__toast); window.__toast = setTimeout(() => el.classList.remove('show'), 3200); }
function saveHistory() { localStorage.setItem('clipdock-history', JSON.stringify(state.history.slice(0, 20))); $('#historyCount').textContent = state.history.length; renderHistory(); }
function platformName(platform) { return platform === 'channels' ? '微信视频号' : platform === 'douyin' ? '抖音' : '未知平台'; }
function setPlatform(platform) { state.platform = platform; $$('.platform-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.platform === platform)); $('#urlInput').placeholder = platform === 'channels' ? '粘贴微信视频号链接…' : '粘贴抖音链接…'; $('#inputHint').textContent = platform === 'channels' ? '例如：https://channels.weixin.qq.com/…' : '例如：https://v.douyin.com/…'; }
function renderResult(result) {
  state.result = result; $('#emptyState').classList.add('hidden'); $('#resultContent').classList.remove('hidden');
  $('#resultTitle').textContent = result.title; $('#resultAuthor').textContent = result.author; $('#resultDuration').textContent = result.duration; $('#resultPlatform').textContent = platformName(result.platform); $('#resultSource').textContent = result.source;
  $('#previewLabel').textContent = platformName(result.platform).toUpperCase(); $('#resultNotice').classList.toggle('hidden', result.direct); $('#downloadButton').disabled = !result.direct && !result.agentJobId; $('#openSource').href = result.pageSource || result.source; $('#resultNotice p').textContent = result.message || '分享页受登录态保护。请打开原页面完成扫码，再复制媒体直链。';
  $('#downloadButton span:last-child').textContent = result.agentJobId ? '下载到本地' : '下载视频';
  $('#queueStatus').textContent = result.direct ? '可下载' : result.agentJobId ? '代理已就绪' : '需直链';
}
function renderHistory() {
  $('#historyCount').textContent = state.history.length; $('#historyEmpty').classList.toggle('hidden', state.history.length > 0); $('#historyList').innerHTML = state.history.map(item => `<div class="history-entry"><span class="history-platform ${item.platform === 'channels' ? 'channels-logo' : 'douyin-logo'}">${item.platform === 'channels' ? '◉' : '♪'}</span><div class="history-meta"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source)} · ${item.time}</small></div><span class="history-state">已完成</span></div>`).join('');
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function addHistory(result) { state.history.unshift({ title: result.title, source: result.source, platform: result.platform, time: new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }); saveHistory(); }

$('#urlInput').addEventListener('input', (event) => { $('#charCount').textContent = `${event.target.value.length} / 2000`; });
$('#clearUrl').addEventListener('click', () => { $('#urlInput').value = ''; $('#charCount').textContent = '0 / 2000'; $('#urlInput').focus(); });
$$('.platform-tab').forEach(tab => tab.addEventListener('click', () => setPlatform(tab.dataset.platform)));
$$('.example-link').forEach(button => button.addEventListener('click', () => { $('#urlInput').value = button.dataset.example; $('#charCount').textContent = `${button.dataset.example.length} / 2000`; setPlatform('channels'); $('#parseForm').requestSubmit(); }));

$('#parseForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const input = $('#urlInput'); const button = $('#parseButton'); if (!input.value.trim()) return toast('请先粘贴视频链接');
  button.disabled = true; button.querySelector('span:last-child').textContent = '识别中…'; $('#queueStatus').textContent = '处理中';
  try { const response = await fetch('/api/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: input.value }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); renderResult(data); toast(data.direct ? '已识别媒体直链，可以下载' : '已识别平台链接，请查看处理提示'); } catch (error) { toast(error.message || '解析失败'); $('#queueStatus').textContent = '空闲'; } finally { button.disabled = false; button.querySelector('span:last-child').textContent = '提取信息'; }
});

$('#downloadButton').addEventListener('click', async () => {
  if (!state.result?.direct && !state.result?.agentJobId) return toast('分享页无法直接下载，请先启动桌面代理或提供媒体直链'); const button = $('#downloadButton'); button.disabled = true; button.querySelector('span:last-child').textContent = '准备文件…'; $('#queueStatus').textContent = '下载中';
  try {
    const response = state.result.agentJobId
      ? await fetch('/api/agent/download', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: state.result.agentJobId, filename: state.result.title }) })
      : await fetch(`/api/download?url=${encodeURIComponent(state.result.source)}`);
    if (!response.ok) { const data = await response.json(); throw new Error(data.error); }
    const blob = await response.blob(); const objectUrl = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = objectUrl; link.download = downloadFilename(response.headers.get('content-disposition')) || 'clipdock-video.mp4'; link.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); addHistory(state.result); toast('下载已开始'); $('#queueStatus').textContent = '已完成';
  } catch (error) { toast(error.message || '下载失败'); $('#queueStatus').textContent = state.result.agentJobId ? '代理已就绪' : '可下载'; } finally { button.disabled = false; button.querySelector('span:last-child').textContent = state.result.agentJobId ? '下载到本地' : '下载视频'; }
});

function downloadFilename(contentDisposition) {
  const value = String(contentDisposition || '');
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1]);
  const plain = value.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : '';
}

$$('.nav-item').forEach(item => item.addEventListener('click', () => { const view = item.dataset.view; $$('.nav-item').forEach(nav => nav.classList.toggle('active', nav === item)); $('#downloaderView').classList.toggle('hidden', view !== 'downloader'); $('#historyView').classList.toggle('hidden', view !== 'history'); $('#pageTitle').textContent = view === 'history' ? '下载记录' : '下载器'; }));
$('#clearHistory').addEventListener('click', () => { state.history = []; saveHistory(); toast('已清空下载记录'); });
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v' && document.activeElement !== $('#urlInput')) setTimeout(() => $('#urlInput').focus(), 0); });
renderHistory(); setPlatform('douyin');
