import http from 'node:http';
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath, URL } from 'node:url';

const PORT = Number(process.env.PORT || 3457);
const publicDir = new URL('./public/', import.meta.url);
const CHANNELS_AGENT_ORIGIN = normalizeChannelsAgentOrigin(process.env.WX_CHANNELS_AGENT_ORIGIN || '');
const AGENT_REQUEST_TIMEOUT_MS = boundedNumber(process.env.WX_CHANNELS_AGENT_TIMEOUT_MS, 3000, 500, 15000);
const AGENT_JOB_TIMEOUT_MS = boundedNumber(process.env.WX_CHANNELS_AGENT_JOB_TIMEOUT_MS, 120000, 5000, 600000);
const INSTAGRAM_CAPTURE_TIMEOUT_MS = boundedNumber(process.env.INSTAGRAM_CAPTURE_TIMEOUT_MS, 120000, 15000, 600000);
const INSTAGRAM_CDP_PORT = boundedNumber(process.env.INSTAGRAM_CDP_PORT, 9222, 1024, 65535);
const INSTAGRAM_TRANSCODE_TIMEOUT_MS = boundedNumber(process.env.INSTAGRAM_TRANSCODE_TIMEOUT_MS, 600000, 30000, 1800000);
const INSTAGRAM_PROXY_URL = String(process.env.CLIPDOCK_PROXY_URL || 'http://127.0.0.1:2023').trim();
const instagramCaptures = new Map();
let instagramChromeProcess = null;
let shuttingDown = false;

function boundedNumber(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

function normalizeChannelsAgentOrigin(raw) {
  if (!String(raw).trim()) return '';
  try {
    const url = new URL(String(raw).trim());
    if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHost(url.hostname)) {
      console.warn('WX_CHANNELS_AGENT_ORIGIN must be a loopback HTTP(S) origin; agent integration disabled.');
      return '';
    }
    return url.origin;
  } catch {
    console.warn('Invalid WX_CHANNELS_AGENT_ORIGIN; agent integration disabled.');
    return '';
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function safeDownloadFilename(raw, fallback = 'clipdock-video.mp4') {
  const value = String(raw || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  if (!value) return fallback;
  return /\.[a-z0-9]{2,5}$/i.test(value) ? value : `${value}.mp4`;
}

function platformFor(url) {
  const host = url.hostname.toLowerCase();
  if (host.includes('douyin') || host.includes('iesdouyin')) return 'douyin';
  if (host.includes('weixin.qq.com') || host.includes('channels.weixin')) return 'channels';
  if (isInstagramHost(host)) return 'instagram';
  if (isTikTokHost(host)) return 'tiktok';
  return 'unknown';
}

function isInstagramHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'instagram.com' || host.endsWith('.instagram.com');
}

function isInstagramShareUrl(url) {
  if (!isInstagramHost(url.hostname)) return false;
  return /^\/(?:reel|reels|p)\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname);
}

function isTikTokHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'tiktok.com' || host.endsWith('.tiktok.com');
}

function isTikTokShareUrl(url) {
  if (!isTikTokHost(url.hostname)) return false;
  return /^\/@[A-Za-z0-9._-]+\/video\/\d+\/?$/i.test(url.pathname) || /^\/t\/[A-Za-z0-9]+\/?$/i.test(url.pathname);
}

function isInstagramMediaUrl(raw) {
  try {
    const url = raw instanceof URL ? raw : new URL(String(raw));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (
      host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com') ||
      host === 'fbcdn.net' || host.endsWith('.fbcdn.net')
    );
  } catch {
    return false;
  }
}

function isTikTokMediaUrl(raw) {
  try {
    const url = raw instanceof URL ? raw : new URL(String(raw));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (
      host === 'tiktokcdn.com' || host.endsWith('.tiktokcdn.com') || host.endsWith('.tiktok.com') ||
      host === 'tiktokcdn-us.com' || host.endsWith('.tiktokcdn-us.com') ||
      host.endsWith('.tiktokcdn-in.com') || host.endsWith('.tiktokcdn-eu.com') ||
      host.endsWith('.ibytedtos.com') || host.endsWith('.muscdn.com') ||
      host.endsWith('.akamaized.net') || host.endsWith('.byteoversea.com')
    );
  } catch {
    return false;
  }
}

function isDirectMedia(url) {
  // Keep the proxy intentionally narrow: only recognizable video file paths are fetched.
  return /\.(mp4|mov|webm|m4v)$/i.test(url.pathname);
}

function isChannelsShareUrl(url) {
  const host = url.hostname.toLowerCase();
  if (host === 'weixin.qq.com') return /^\/sph\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  return host === 'channels.weixin.qq.com' && url.pathname === '/finder-preview/pages/sph';
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '::1' || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function parseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('请粘贴视频链接');
  const url = new URL(raw.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 http 或 https 链接');
  if (isBlockedHost(url.hostname)) throw new Error('出于安全原因，不支持本地地址');
  return url;
}

function agentTarget(pathname) {
  if (!CHANNELS_AGENT_ORIGIN) throw new Error('微信视频号桌面代理未配置');
  const target = new URL(pathname, CHANNELS_AGENT_ORIGIN);
  if (target.origin !== CHANNELS_AGENT_ORIGIN) throw new Error('桌面代理地址无效');
  return target;
}

async function requestChannelsAgent(pathname, options = {}) {
  const target = agentTarget(pathname);
  const { timeout = AGENT_REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  const response = await fetch(target, {
    ...fetchOptions,
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
    headers: { accept: 'application/json', ...(options.headers || {}) },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`桌面代理返回了无效响应（${response.status}）`);
  }
  if (!response.ok) throw new Error(payload?.msg || payload?.error || `桌面代理返回 ${response.status}`);
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'code') && Number(payload.code) !== 0) {
    throw new Error(payload.msg || payload.error || `桌面代理错误（${payload.code}）`);
  }
  return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findFfmpeg() {
  const bundled = fileURLToPath(new URL('./bin/ffmpeg', import.meta.url));
  const candidates = [
    process.env.FFMPEG_PATH,
    bundled,
    '/opt/homebrew/opt/ffmpeg/bin/ffmpeg',
    '/usr/local/opt/ffmpeg/bin/ffmpeg',
    'ffmpeg',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') return candidate;
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* try the next known installation */ }
  }
  return null;
}

async function transcodeInstagramMedia(inputPath, outputPath, audioPath = null) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    throw new Error('当前下载是 VP9 视频，QuickTime 不兼容；请先安装 ffmpeg（brew install ffmpeg）后重试');
  }
  await new Promise((resolve, reject) => {
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      ...(audioPath ? ['-i', audioPath] : []),
      '-map', '0:v:0',
      '-map', audioPath ? '1:a:0?' : '0:a?',
      ...(audioPath ? ['-shortest'] : []),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-movflags', '+faststart',
      outputPath,
    ];
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), INSTAGRAM_TRANSCODE_TIMEOUT_MS);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Instagram 视频兼容性转换失败${stderr ? `：${stderr.trim()}` : ''}`));
    });
  });
  const outputStat = await stat(outputPath);
  if (!outputStat.size) throw new Error('Instagram 视频兼容性转换生成了空文件');
}

function safeInstagramHeaders(headers = {}) {
  const allowed = new Set(['accept', 'accept-language', 'origin', 'referer', 'user-agent']);
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = String(key).toLowerCase();
    if (allowed.has(normalized) && typeof value === 'string' && value.length <= 1000) {
      result[normalized] = value;
    }
  }
  return result;
}

function safeTikTokHeaders(headers = {}) {
  const allowed = new Set(['accept', 'accept-language', 'cookie', 'origin', 'referer', 'user-agent']);
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = String(key).toLowerCase();
    if (allowed.has(normalized) && typeof value === 'string' && value.length <= 16000) {
      result[normalized] = value;
    }
  }
  return result;
}

function instagramTrackMetadata(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const encoded = url.searchParams.get('efg');
    if (!encoded) return '';
    return Buffer.from(encoded, 'base64').toString('utf8').toLowerCase();
  } catch {
    return '';
  }
}

function instagramMediaCandidate(url, response, requestHeaders = {}) {
  const mimeType = String(response?.mimeType || '').toLowerCase();
  const resourceType = String(response?.resourceType || '').toLowerCase();
  const trackMetadata = instagramTrackMetadata(url);
  const looksLikeAudio = mimeType.startsWith('audio/') || /\.(?:m4a|aac|mp3|opus)(?:$|[?&])/i.test(url) || /(?:audio|heaac|aac)/i.test(trackMetadata);
  const looksLikeVideo = mimeType.startsWith('video/') || /\.(?:mp4|m4v|webm)(?:$|[?&])/i.test(url);
  if (!isInstagramMediaUrl(url) || (!looksLikeVideo && !looksLikeAudio && resourceType !== 'media')) return null;
  return {
    url,
    mimeType: mimeType || 'video/mp4',
    kind: looksLikeAudio ? 'audio' : 'video',
    resourceType,
    status: Number(response?.status || 0),
    size: Number(response?.headers?.['content-length'] || response?.headers?.['Content-Length'] || 0),
    seenAt: Date.now(),
    headers: safeInstagramHeaders(requestHeaders),
  };
}

function tiktokMediaCandidate(url, response, requestHeaders = {}) {
  const mimeType = String(response?.mimeType || '').toLowerCase();
  const resourceType = String(response?.resourceType || '').toLowerCase();
  const looksLikeVideo = mimeType.startsWith('video/') || /\.(?:mp4|m4v|webm)(?:$|[?&])/i.test(url);
  if (!isTikTokMediaUrl(url) || (!looksLikeVideo && resourceType !== 'media')) return null;
  return {
    url,
    mimeType: mimeType || 'video/mp4',
    kind: 'video',
    resourceType,
    status: Number(response?.status || 0),
    size: Number(response?.headers?.['content-length'] || response?.headers?.['Content-Length'] || 0),
    seenAt: Date.now(),
    headers: safeTikTokHeaders(requestHeaders),
    body: null,
    bodyPromise: null,
  };
}

function instagramMediaKey(raw) {
  try {
    const url = raw instanceof URL ? raw : new URL(String(raw));
    return `${url.hostname.toLowerCase()}${url.pathname}`;
  } catch {
    return '';
  }
}

function choosePlayedInstagramMedia(candidates, playedVideos) {
  const playable = playedVideos
    .map(item => ({ ...item, key: instagramMediaKey(item.src) }))
    .filter(item => item.src);
  if (!playable.length) return null;
  const scoreByKey = new Map();
  for (const item of playable.filter(item => item.key)) {
    const score = (item.userGesture ? 4 : 0) + (item.visible ? 2 : 0) + (Number(item.at) || 0) / 1e13;
    scoreByKey.set(item.key, Math.max(scoreByKey.get(item.key) || 0, score));
  }
  const exact = [...candidates.values()]
    .filter(item => item.status >= 200 && item.status < 300 && item.size >= 100 * 1024 && scoreByKey.has(instagramMediaKey(item.url)))
    .sort((a, b) => (scoreByKey.get(instagramMediaKey(b.url)) - scoreByKey.get(instagramMediaKey(a.url))) || (b.size - a.size))[0] || null;
  if (exact) return exact;

  // Instagram frequently exposes a blob: MediaSource URL to the page while
  // the actual CDN fragments are visible only in Network events. Associate
  // those fragments with the most recent visible playback event.
  const latestPlay = [...playedVideos]
    .filter(item => item.visible || item.userGesture)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))[0];
  if (!latestPlay?.at) return null;
  const nearby = [...candidates.values()]
    .filter(item => item.kind === 'video' && item.status >= 200 && item.status < 300 && item.size >= 100 * 1024)
    .map(item => ({ item, distance: Math.abs((item.seenAt || item.finishedAt || 0) - latestPlay.at) }))
    .filter(entry => entry.item.seenAt && entry.distance <= 15000)
    .sort((a, b) => a.distance - b.distance || b.item.size - a.item.size);
  return nearby[0]?.item || null;
}

function chooseInstagramAudio(candidates, videoCandidate) {
  return [...candidates.values()]
    .filter(item => item !== videoCandidate && item.kind === 'audio' && item.status >= 200 && item.status < 300 && item.size >= 8 * 1024)
    .sort((a, b) => Math.abs((a.seenAt || 0) - (videoCandidate.seenAt || 0)) - Math.abs((b.seenAt || 0) - (videoCandidate.seenAt || 0)) || b.size - a.size)[0] || null;
}

function choosePlayedTikTokMedia(candidates, playedVideos) {
  const playable = playedVideos.filter(item => item.src);
  if (!playable.length) return null;
  const latestPlay = playable
    .filter(item => item.visible || item.userGesture)
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))[0] || playable[playable.length - 1];
  const nearby = [...candidates.values()]
    .filter(item => item.kind === 'video' && item.status === 200 && item.finishedAt && item.size >= 100 * 1024)
    .map(item => ({ item, distance: Math.abs((item.seenAt || item.finishedAt || 0) - (latestPlay.at || 0)) }))
    .filter(entry => entry.item.seenAt && entry.distance <= 20000)
    .sort((a, b) => a.distance - b.distance || b.item.size - a.item.size);
  return nearby[0]?.item || null;
}

async function readCdpResponseBody(cdp, candidate, requestId) {
  if (candidate.bodyPromise) return candidate.bodyPromise;
  candidate.bodyPromise = cdp.send('Network.getResponseBody', { requestId }).then(async result => {
    const encoded = Boolean(result?.base64Encoded);
    const raw = String(result?.body || '');
    if (!raw) return null;
    const body = encoded ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
    // Do not retain unexpectedly large responses in the server process.
    if (body.length > 150 * 1024 * 1024) return null;
    candidate.body = body;
    candidate.bodySize = body.length;
    return body;
  }).catch(() => null);
  return candidate.bodyPromise;
}

async function cdpJson(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${INSTAGRAM_CDP_PORT}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Chrome 调试接口返回 ${response.status}`);
  return response.json();
}

async function waitForChromeDebugger(attempt = 0) {
  try {
    await cdpJson('/json/version');
    return true;
  } catch {
    if (attempt >= 40) return false;
    await delay(250);
    return waitForChromeDebugger(attempt + 1);
  }
}

async function ensureInstagramChrome() {
  if (await waitForChromeDebugger()) return;
  const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const profileDir = process.env.INSTAGRAM_CHROME_PROFILE || `${process.env.HOME || '/tmp'}/Library/Application Support/ClipDock/InstagramChromeProfile`;
  const args = [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${INSTAGRAM_CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
  ];
  instagramChromeProcess = spawn(chromePath, args, { stdio: 'ignore' });
  instagramChromeProcess.once('exit', () => { instagramChromeProcess = null; });
  if (!await waitForChromeDebugger()) {
    throw new Error('无法启动 Chrome 调试会话，请确认已安装 Google Chrome');
  }
}

function connectCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 0;
    const send = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCommand(new Error(`Chrome 调试命令超时：${method}`));
      }, 10000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolveCommand(value); }, reject: error => { clearTimeout(timer); rejectCommand(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener('open', () => resolve({ socket, send, pending }));
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id && pending.has(message.id)) {
        const command = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) command.reject(new Error(message.error.message || 'Chrome 调试命令失败'));
        else command.resolve(message.result);
      }
    });
    socket.addEventListener('error', () => reject(new Error('Chrome 调试连接失败')));
    socket.addEventListener('close', () => {
      for (const command of pending.values()) command.reject(new Error('Chrome 调试连接已关闭'));
      pending.clear();
    });
  });
}

async function newInstagramPage(url) {
  await ensureInstagramChrome();
  let page;
  try {
    page = await cdpJson(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  } catch {
    const pages = await cdpJson('/json/list');
    page = Array.isArray(pages) ? pages.find(item => item.type === 'page') : null;
    if (!page) throw new Error('Chrome 没有返回可控制的页面');
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('Chrome 页面缺少调试地址');
  return page;
}

const instagramPlaybackProbe = `
(() => {
  const state = window.__clipdockVideoState = { plays: [], lastGestureAt: 0 };
  const gesture = () => { state.lastGestureAt = Date.now(); };
  ['pointerdown', 'touchstart', 'keydown'].forEach(type => document.addEventListener(type, gesture, true));
  document.addEventListener('play', event => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    state.plays.push({
      src: video.currentSrc || video.src || '',
      at: Date.now(),
      userGesture: Date.now() - state.lastGestureAt < 5000,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
      visible: (() => {
        const rect = video.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      })()
    });
    if (state.plays.length > 20) state.plays.shift();
  }, true);
})();
`;

async function readInstagramPlayback(cdp) {
  try {
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__clipdockVideoState || { plays: [] })',
      returnByValue: true,
    });
    const value = result?.result?.value;
    return value ? JSON.parse(value) : { plays: [] };
  } catch {
    return { plays: [] };
  }
}

async function startInstagramCapture(session) {
  let cdp;
  try {
    const page = await newInstagramPage(session.source);
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    session.socket = cdp.socket;
    const requests = new Map();
    cdp.socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const params = message.params || {};
      if (message.method === 'Network.requestWillBeSent') {
        requests.set(params.requestId, params.request?.headers || {});
      }
      if (message.method === 'Network.requestWillBeSentExtraInfo') {
        const mergedHeaders = { ...(requests.get(params.requestId) || {}), ...(params.headers || {}) };
        requests.set(params.requestId, mergedHeaders);
        const candidate = session.candidates.get(params.requestId);
        if (candidate) candidate.headers = safeInstagramHeaders(mergedHeaders);
      }
      if (message.method === 'Network.responseReceived') {
        const response = params.response || {};
        const candidate = instagramMediaCandidate(response.url, {
          mimeType: response.mimeType,
          resourceType: params.type,
          status: response.status,
          headers: response.headers,
        }, requests.get(params.requestId));
        if (candidate) session.candidates.set(params.requestId, candidate);
      }
      if (message.method === 'Network.loadingFinished') {
        const candidate = session.candidates.get(params.requestId);
        if (!candidate) return;
        candidate.size = Math.max(candidate.size, Number(params.encodedDataLength || 0));
        candidate.finishedAt = Date.now();
      }
    });
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: instagramPlaybackProbe });
    await cdp.send('Page.bringToFront');
    await cdp.send('Page.navigate', { url: session.source });
    session.status = 'waiting';
    session.message = '请在打开的 Chrome 页面中登录 Instagram，并点击目标 Reel 播放一次';
    const deadline = Date.now() + INSTAGRAM_CAPTURE_TIMEOUT_MS;
    while (!session.media && Date.now() < deadline && !shuttingDown) {
      const playback = await readInstagramPlayback(cdp);
      const playedVideos = playback.plays.filter(item => item.src);
      const selected = choosePlayedInstagramMedia(session.candidates, playedVideos);
      if (selected) {
        session.media = selected;
        // The audio track is often requested just after the video manifest.
        // Give the player a short window to finish that request before we
        // finalize the capture session.
        await delay(1200);
        session.mediaAudio = chooseInstagramAudio(session.candidates, selected);
        session.status = 'captured';
        session.message = session.mediaAudio ? '已捕获目标 Instagram Reel（含音频），可以下载' : '已捕获目标 Instagram Reel，未发现独立音频轨；如原视频有声音，请重新播放后重试';
        break;
      }
      await delay(500);
    }
    if (!session.media && !shuttingDown) {
      session.status = 'failed';
      session.message = '未捕获到目标 Reel，请确认已登录，并点击目标视频播放后重试';
    }
  } catch (error) {
    session.status = 'failed';
    session.message = error.message || 'Instagram 捕获失败';
  } finally {
    try { cdp?.socket.close(); } catch {}
    session.socket = null;
  }
}

async function startTikTokCapture(session) {
  let cdp;
  try {
    const page = await newInstagramPage(session.source);
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    session.socket = cdp.socket;
    const requests = new Map();
    cdp.socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const params = message.params || {};
      if (message.method === 'Network.requestWillBeSent') {
        requests.set(params.requestId, params.request?.headers || {});
      }
      if (message.method === 'Network.requestWillBeSentExtraInfo') {
        const mergedHeaders = { ...(requests.get(params.requestId) || {}), ...(params.headers || {}) };
        requests.set(params.requestId, mergedHeaders);
        const candidate = session.candidates.get(params.requestId);
        if (candidate) candidate.headers = safeTikTokHeaders(mergedHeaders);
      }
      if (message.method === 'Network.responseReceived') {
        const response = params.response || {};
        const candidate = tiktokMediaCandidate(response.url, {
          mimeType: response.mimeType,
          resourceType: params.type,
          status: response.status,
          headers: response.headers,
        }, requests.get(params.requestId));
        if (candidate) session.candidates.set(params.requestId, candidate);
      }
      if (message.method === 'Network.loadingFinished') {
        const candidate = session.candidates.get(params.requestId);
        if (!candidate) return;
        candidate.size = Math.max(candidate.size, Number(params.encodedDataLength || 0));
        candidate.finishedAt = Date.now();
        if (candidate.status === 200 && candidate.kind === 'video') {
          void readCdpResponseBody(cdp, candidate, params.requestId);
        }
      }
    });
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: instagramPlaybackProbe });
    await cdp.send('Page.bringToFront');
    await cdp.send('Page.navigate', { url: session.source });
    session.status = 'waiting';
    session.message = '请在打开的 Chrome 页面中登录 TikTok，并点击目标视频播放一次';
    const deadline = Date.now() + INSTAGRAM_CAPTURE_TIMEOUT_MS;
    while (!session.media && Date.now() < deadline && !shuttingDown) {
      const playback = await readInstagramPlayback(cdp);
      const selected = choosePlayedTikTokMedia(session.candidates, playback.plays || []);
      if (selected) {
        // TikTok signs CDN URLs and may reject a later server-side request.
        // Give Chrome a moment to expose the already-loaded response body so
        // the download can be served without leaving the authenticated session.
        if (selected.bodyPromise) await selected.bodyPromise;
        session.media = selected;
        session.status = 'captured';
        session.message = '已捕获目标 TikTok 视频，可以下载';
        break;
      }
      await delay(500);
    }
    if (!session.media && !shuttingDown) {
      session.status = 'failed';
      session.message = '未捕获到目标 TikTok 视频，请确认已登录，并点击目标视频播放后重试';
    }
  } catch (error) {
    session.status = 'failed';
    session.message = error.message || 'TikTok 捕获失败';
  } finally {
    try { cdp?.socket.close(); } catch {}
    session.socket = null;
  }
}

function captureResponse(session) {
  let media = null;
  if (session.media) {
    try {
      const mediaUrl = new URL(session.media.url);
      media = {
        host: mediaUrl.hostname,
        path: mediaUrl.pathname,
        queryKeys: [...mediaUrl.searchParams.keys()],
        size: session.media.size,
        mimeType: session.media.mimeType,
        status: session.media.status,
        hasAudio: Boolean(session.mediaAudio),
      };
    } catch {}
  }
  return {
    ok: true,
    id: session.id,
    source: session.source,
    status: session.status,
    ready: Boolean(session.media),
    media,
    message: session.message,
    createdAt: session.createdAt,
  };
}

function instagramTargetUrl(candidate) {
  const target = new URL(candidate.url);
  if (!isInstagramMediaUrl(target)) throw new Error('捕获到的媒体地址不受支持');
  target.searchParams.delete('bytestart');
  target.searchParams.delete('byteend');
  return target;
}

function tiktokTargetUrl(candidate) {
  const target = new URL(candidate.url);
  if (!isTikTokMediaUrl(target)) throw new Error('捕获到的 TikTok 媒体地址不受支持');
  return target;
}

function instagramCurlHeaders(headers = {}) {
  return Object.entries(headers).flatMap(([key, value]) => ['--header', `${key}: ${value}`]);
}

async function fetchInstagramCandidate(candidate, outputPath) {
  return fetchMediaCandidate(candidate, outputPath, 'instagram');
}

async function fetchTikTokCandidate(candidate, outputPath) {
  return fetchMediaCandidate(candidate, outputPath, 'tiktok');
}

async function fetchMediaCandidate(candidate, outputPath, platform) {
  const target = platform === 'tiktok' ? tiktokTargetUrl(candidate) : instagramTargetUrl(candidate);
  const label = platform === 'tiktok' ? 'TikTok' : 'Instagram';

  if (platform === 'tiktok' && candidate.body?.length) {
    await writeFile(outputPath, candidate.body);
    if (!candidate.body.length) throw new Error(`${label} 媒体返回了空文件`);
    return candidate.mimeType || 'video/mp4';
  }

  let directError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const upstream = await fetch(target, {
        redirect: 'follow',
        signal: AbortSignal.timeout(60000),
        headers: candidate.headers,
      });
      if (!upstream.ok || !upstream.body) throw new Error(`${label} 媒体返回 ${upstream.status}`);
      const validUpstream = platform === 'tiktok' ? isTikTokMediaUrl(upstream.url) : isInstagramMediaUrl(upstream.url);
      if (!validUpstream) throw new Error(`${label} 媒体重定向到了不受支持的地址`);
      if (upstream.status === 206) throw new Error('该视频需要分段下载，当前版本暂不支持');
      await pipeline(Readable.fromWeb(upstream.body), createWriteStream(outputPath));
      const outputStat = await stat(outputPath);
      if (!outputStat.size) throw new Error(`${label} 媒体返回了空文件`);
      return upstream.headers.get('content-type') || candidate.mimeType || 'video/mp4';
    } catch (error) {
      directError = error;
      await rm(outputPath, { force: true }).catch(() => {});
      if (attempt === 0) await delay(500);
    }
  }

  // Node fetch does not honor macOS system proxy settings. The bundled
  // wx_channels_download agent exposes a local proxy on port 2023, so use
  // curl as a last-mile fallback when direct CDN access fails.
  if (INSTAGRAM_PROXY_URL) {
    await new Promise((resolve, reject) => {
      const args = [
        '--fail', '--silent', '--show-error', '--location',
        '--connect-timeout', '15', '--max-time', '120',
        '--retry', '1', '--retry-all-errors',
        '--proxy', INSTAGRAM_PROXY_URL,
        ...instagramCurlHeaders(candidate.headers),
        '--output', outputPath,
        target.href,
      ];
      const child = spawn('/usr/bin/curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk).slice(-4000); });
      child.once('error', reject);
      child.once('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`${label} 代理读取失败（curl ${code}${stderr ? `：${stderr.trim()}` : ''}）`));
      });
    }).then(async () => {
      const outputStat = await stat(outputPath);
      if (!outputStat.size) throw new Error(`${label} 代理返回了空文件`);
    }).catch(async error => {
      await rm(outputPath, { force: true }).catch(() => {});
      throw new Error(`${directError?.message || `${label} 媒体读取失败`}；代理回退也失败：${error.message || error}`);
    });
    return candidate.mimeType || 'video/mp4';
  }
  throw directError || new Error(`${label} 媒体读取失败`);
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
}

async function handleInstagramOpen(req, res) {
  try {
    const request = await readJsonBody(req);
    const source = parseUrl(request.url).href;
    if (!isInstagramShareUrl(new URL(source))) throw new Error('请输入 Instagram Reel、帖子或视频链接');
    const session = {
      id: randomUUID(), source, status: 'starting', message: '正在启动 Chrome 捕获会话',
      createdAt: Date.now(), candidates: new Map(), media: null, mediaAudio: null, socket: null,
    };
    instagramCaptures.set(session.id, session);
    startInstagramCapture(session);
    json(res, 200, captureResponse(session));
  } catch (error) {
    json(res, 400, { ok: false, error: error.message || 'Instagram 捕获启动失败' });
  }
}

async function handleInstagramCapture(req, res, requestUrl) {
  const id = String(requestUrl.searchParams.get('id') || '').trim();
  const session = instagramCaptures.get(id);
  if (!session) return json(res, 404, { ok: false, error: 'Instagram 捕获任务不存在或已过期' });
  json(res, 200, captureResponse(session));
}

async function handleInstagramDownload(req, res, requestUrl) {
  let tempDir = null;
  try {
    const id = String(requestUrl.searchParams.get('id') || '').trim();
    const session = instagramCaptures.get(id);
    if (!session?.media || session.status !== 'captured') throw new Error('尚未捕获到视频，请先在 Chrome 中播放 Reel');
    const filename = safeDownloadFilename(requestUrl.searchParams.get('filename'), 'instagram-reel-compatible.mp4');
    // Instagram commonly serves VP9 fragmented MP4. It is valid media, but
    // QuickTime will not open it reliably, so normalize captured videos to a
    // conventional H.264/AAC MP4 before handing the response to WKDownload.
    tempDir = await mkdtemp(`${tmpdir()}/clipdock-instagram-`);
    const inputPath = `${tempDir}/source.mp4`;
    let audioPath = null;
    const outputPath = `${tempDir}/instagram-reel-compatible.mp4`;
    const contentType = await fetchInstagramCandidate(session.media, inputPath);
    if (!contentType.startsWith('video/')) throw new Error('捕获到的地址不是视频文件');
    if (session.mediaAudio) {
      audioPath = `${tempDir}/source-audio.mp4`;
      await fetchInstagramCandidate(session.mediaAudio, audioPath);
    }
    await transcodeInstagramMedia(inputPath, outputPath, audioPath);
    const outputStat = await stat(outputPath);
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(outputStat.size),
    });
    await pipeline(createReadStream(outputPath), res);
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else json(res, 502, { ok: false, error: error.message || 'Instagram 下载失败' });
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleTikTokOpen(req, res) {
  try {
    const request = await readJsonBody(req);
    const source = parseUrl(request.url).href;
    if (!isTikTokShareUrl(new URL(source))) throw new Error('请输入 TikTok 视频链接');
    const session = {
      id: randomUUID(), source, platform: 'tiktok', status: 'starting', message: '正在启动 Chrome 捕获会话',
      createdAt: Date.now(), candidates: new Map(), media: null, mediaAudio: null, socket: null,
    };
    instagramCaptures.set(session.id, session);
    startTikTokCapture(session);
    json(res, 200, captureResponse(session));
  } catch (error) {
    json(res, 400, { ok: false, error: error.message || 'TikTok 捕获启动失败' });
  }
}

async function handleTikTokCapture(req, res, requestUrl) {
  const id = String(requestUrl.searchParams.get('id') || '').trim();
  const session = instagramCaptures.get(id);
  if (!session || session.platform !== 'tiktok') return json(res, 404, { ok: false, error: 'TikTok 捕获任务不存在或已过期' });
  json(res, 200, captureResponse(session));
}

async function handleTikTokDownload(req, res, requestUrl) {
  let tempDir = null;
  try {
    const id = String(requestUrl.searchParams.get('id') || '').trim();
    const session = instagramCaptures.get(id);
    if (!session?.media || session.platform !== 'tiktok' || session.status !== 'captured') {
      throw new Error('尚未捕获到 TikTok 视频，请先在 Chrome 中播放视频');
    }
    const filename = safeDownloadFilename(requestUrl.searchParams.get('filename'), 'tiktok-video.mp4');
    tempDir = await mkdtemp(`${tmpdir()}/clipdock-tiktok-`);
    const inputPath = `${tempDir}/source.mp4`;
    const contentType = await fetchTikTokCandidate(session.media, inputPath);
    if (!contentType.startsWith('video/') && contentType !== 'application/octet-stream') {
      throw new Error('捕获到的地址不是 TikTok 视频文件');
    }
    const outputStat = await stat(inputPath);
    res.writeHead(200, {
      'content-type': contentType.startsWith('video/') ? contentType : 'video/mp4',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(outputStat.size),
    });
    await pipeline(createReadStream(inputPath), res);
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else json(res, 502, { ok: false, error: error.message || 'TikTok 下载失败' });
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForChannelsAgentJob(jobId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < AGENT_JOB_TIMEOUT_MS) {
    const job = await requestChannelsAgent(`/api/scraper/job?id=${encodeURIComponent(jobId)}`, { timeout: 8000 });
    const status = String(job?.status || '').toLowerCase();
    if (status === 'completed') return job;
    if (['failed', 'interrupted', 'cancelled'].includes(status)) {
      throw new Error(job?.error || `桌面代理解析${status === 'failed' ? '失败' : '已停止'}`);
    }
    await delay(700);
  }
  throw new Error('桌面代理解析超时，请确认微信 PC 页面已登录并保持视频页打开');
}

function jsonValue(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function agentOutput(job) {
  const output = job?.output || {};
  return {
    raw: jsonValue(output.result ?? job?.raw_result ?? job?.rawResult ?? {}),
    content: output.content || job?.content || {},
    account: output.account || job?.account || {},
    downloadInfo: output.download_info || output.downloadInfo || {},
  };
}

function firstPositiveId(value) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstPositiveId(item);
      if (found) return found;
    }
    return 0;
  }
  for (const key of ['id', 'task_id', 'taskId']) {
    const id = Number(value[key]);
    if (Number.isInteger(id) && id > 0) return id;
  }
  for (const key of ['task', 'data', 'tasks', 'results']) {
    const found = firstPositiveId(value[key]);
    if (found) return found;
  }
  return 0;
}

async function resolveChannelsWithAgent(shareUrl) {
  if (!CHANNELS_AGENT_ORIGIN) return null;
  const platformStatus = await requestChannelsAgent('/api/scraper/platform/status', { timeout: 8000 });
  const channelsPage = Array.isArray(platformStatus?.statuses)
    ? platformStatus.statuses.find(item => item?.key === 'wxchannels:page')
    : null;
  if (!channelsPage?.available) {
    throw new Error('请先在微信 PC 端打开视频号页面，等待页面连接下载代理后再提取链接');
  }
  const created = await requestChannelsAgent('/api/scraper/fetch', {
    method: 'POST',
    timeout: 10000,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: shareUrl, force_refresh: false }),
  });
  const jobId = String(created?.id || created?.job_id || '').trim();
  if (!jobId || jobId.length > 128) throw new Error('桌面代理没有返回有效的解析任务');
  const job = await waitForChannelsAgentJob(jobId);
  const output = agentOutput(job);
  const content = output.content || {};
  const account = output.account || {};
  return {
    title: content.title || content.description || '微信视频号视频',
    author: account.nickname || account.name || content.author || '微信视频号创作者',
    duration: content.duration || content.duration_text || '--:--',
    thumbnail: content.cover_url || content.coverURL || '',
    platform: 'channels',
    source: shareUrl,
    pageSource: shareUrl,
    direct: false,
    agentJobId: jobId,
    agentContent: output.raw,
    message: '桌面代理已完成解析。点击“下载视频”后，由本机代理创建任务、下载并处理文件。',
  };
}

async function waitForChannelsDownload(taskId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < AGENT_JOB_TIMEOUT_MS * 5) {
    const detail = await requestChannelsAgent(`/api/v1/download_task/detail?id=${encodeURIComponent(taskId)}`, { timeout: 8000 });
    const status = Number(detail?.status);
    if (status === 5) return detail;
    if ([6, 7].includes(status)) throw new Error(detail?.error || '桌面代理下载失败');
    await delay(900);
  }
  throw new Error('桌面代理下载超时，请查看代理程序中的任务记录');
}

function safeAgentFileUrl(file) {
  const raw = String(file?.file_url || file?.fileUrl || '').trim();
  if (!raw) return null;
  const target = new URL(raw, CHANNELS_AGENT_ORIGIN);
  if (target.origin !== CHANNELS_AGENT_ORIGIN || target.pathname !== '/api/file') return null;
  return target;
}

async function handleAgentDownload(req, res, requestUrl = null) {
  if (!CHANNELS_AGENT_ORIGIN) {
    json(res, 503, { ok: false, error: '微信视频号桌面代理未配置，请先启动参考项目并设置 WX_CHANNELS_AGENT_ORIGIN' });
    return;
  }
  try {
    const request = req.method === 'GET'
      ? { jobId: requestUrl?.searchParams.get('jobId'), filename: requestUrl?.searchParams.get('filename') }
      : await readJsonBody(req);
    const jobId = String(request.jobId || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(jobId)) throw new Error('解析任务无效');
    const job = await requestChannelsAgent(`/api/scraper/job?id=${encodeURIComponent(jobId)}`, { timeout: 8000 });
    if (String(job?.status || '').toLowerCase() !== 'completed') throw new Error('解析任务尚未完成，请重新提取信息');
    const output = agentOutput(job);
    if (!output.raw || typeof output.raw !== 'object') throw new Error('解析结果缺少视频数据');
    let filename = String(request.filename || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'clipdock-video';
    if (!/\.[a-z0-9]{2,5}$/i.test(filename)) filename += '.mp4';
    const created = await requestChannelsAgent('/api/v1/download_task/create', {
      method: 'POST',
      timeout: 15000,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objects: [{
        platform: 'wxchannels',
        content: output.raw,
        build_from_fetch: true,
        filename,
        config: {},
        auto_start: true,
      }] }),
    });
    const taskId = firstPositiveId(created);
    if (!taskId) throw new Error('桌面代理没有返回下载任务编号');
    const detail = await waitForChannelsDownload(taskId);
    const file = Array.isArray(detail?.files) ? detail.files.find(item => safeAgentFileUrl(item)) : null;
    const fileUrl = safeAgentFileUrl(file);
    if (!fileUrl) throw new Error('桌面代理下载完成，但没有找到可读取的文件');
    const upstream = await fetch(fileUrl, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!upstream.ok || !upstream.body) throw new Error(`读取桌面代理文件失败（${upstream.status}）`);
    const contentType = upstream.headers.get('content-type') || 'video/mp4';
    const contentLength = upstream.headers.get('content-length');
    res.writeHead(200, {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${filename}"`,
      ...(contentLength ? { 'content-length': contentLength } : {}),
    });
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    json(res, 502, { ok: false, error: error.message || '桌面代理下载失败' });
  }
}

function metadataFor(url, platform) {
  const isChannels = platform === 'channels';
  const isDouyin = platform === 'douyin';
  const isInstagram = platform === 'instagram';
  const isTikTok = platform === 'tiktok';
  const title = isChannels ? '微信视频号内容 · 待授权解析' : isDouyin ? '抖音内容 · 待解析' : isInstagram ? 'Instagram Reel · 待捕获' : isTikTok ? 'TikTok 视频 · 待捕获' : '待解析的视频';
  const message = isDirectMedia(url)
    ? '检测到直链，可直接下载。'
    : (isInstagram
    ? '请点击“打开并捕获”，在已登录的 Chrome 页面中点击目标 Reel 播放一次。ClipDock 只接收当前可见视频的媒体请求，不保存 Cookie。'
    : (isTikTok
    ? '请点击“打开并捕获”，在已登录的 Chrome 页面中点击目标 TikTok 视频播放一次。ClipDock 只接收当前可见视频的媒体请求，不保存 Cookie。'
    : (isChannels && url.hostname === 'weixin.qq.com'
      ? '该微信短链接会跳转到视频号预览页，当前内容需要登录或扫码后才能获取媒体直链。'
      : '平台分享页需要在已登录的浏览器会话中解析，请先在对应平台打开并复制可访问的媒体直链。')));
  return {
    title,
    author: isChannels ? '视频号创作者' : isDouyin ? '抖音创作者' : isInstagram ? 'Instagram 创作者' : isTikTok ? 'TikTok 创作者' : '未知创作者',
    duration: '--:--',
    thumbnail: null,
    platform,
    direct: isDirectMedia(url),
    requiresSession: !isDirectMedia(url),
    captureRequired: (isInstagram || isTikTok) && !isDirectMedia(url),
    message
  };
}

async function findPublicVideo(pageUrl) {
  try {
    const response = await fetch(pageUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: { 'user-agent': 'Mozilla/5.0 ClipDock/1.0' }
    });
    if (!response.ok) return null;
    const html = await response.text();
    const candidates = [];
    const metaPattern = /<meta[^>]+(?:property|name)=["'](?:og:video(?::url)?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi;
    for (const match of html.matchAll(metaPattern)) candidates.push(match[1]);
    for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'\\s<>]+\\.(?:mp4)(?:\\?[^"'\\s<>]*)?/gi)) candidates.push(match[0]);
    for (const candidate of candidates) {
      try {
        const clean = candidate.replaceAll('\\/', '/').replaceAll('\\\\u0026', '&');
        const parsed = new URL(clean);
        if (!isBlockedHost(parsed.hostname) && /\\.mp4$/i.test(parsed.pathname)) return parsed;
      } catch { /* ignore malformed embedded URLs */ }
    }
  } catch { /* protected or unavailable pages are expected */ }
  return null;
}

async function handleParse(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const raw = JSON.parse(body).url;
    const url = parseUrl(raw);
    const platform = platformFor(url);
    if (platform === 'channels' && isChannelsShareUrl(url) && CHANNELS_AGENT_ORIGIN) {
      const agentResult = await resolveChannelsWithAgent(url.href);
      json(res, 200, { ok: true, ...agentResult });
      return;
    }
    if (platform === 'instagram' && isInstagramShareUrl(url)) {
      const metadata = metadataFor(url, platform);
      json(res, 200, { ok: true, source: url.href, pageSource: url.href, ...metadata });
      return;
    }
    if (platform === 'tiktok' && isTikTokShareUrl(url)) {
      const metadata = metadataFor(url, platform);
      json(res, 200, { ok: true, source: url.href, pageSource: url.href, ...metadata });
      return;
    }
    const publicVideo = isDirectMedia(url) ? url : await findPublicVideo(url.href);
    const metadata = metadataFor(publicVideo || url, platform);
    json(res, 200, { ok: true, source: publicVideo?.href || url.href, pageSource: url.href, ...metadata });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message || '链接解析失败' });
  }
}

async function handleDownload(req, res, requestUrl) {
  try {
    const raw = requestUrl.searchParams.get('url');
    const url = parseUrl(raw);
    if (!isDirectMedia(url)) {
      json(res, 422, { ok: false, error: '此链接是平台分享页，无法直接下载。请提供媒体直链。' });
      return;
    }
    const upstream = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!upstream.ok || !upstream.body) throw new Error(`远程服务器返回 ${upstream.status}`);
    const upstreamType = upstream.headers.get('content-type') || '';
    if (upstreamType && !upstreamType.startsWith('video/') && !upstreamType.includes('octet-stream')) {
      throw new Error('远程地址不是可下载的视频文件');
    }
    const type = upstreamType || 'video/mp4';
    const name = (url.pathname.split('/').pop() || 'clipdock-video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.writeHead(200, {
      'content-type': type,
      'content-disposition': `attachment; filename="${name}"`,
      ...(upstream.headers.get('content-length') ? { 'content-length': upstream.headers.get('content-length') } : {})
    });
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    json(res, 502, { ok: false, error: error.message || '下载失败' });
  }
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'POST' && requestUrl.pathname === '/api/parse') return handleParse(req, res);
  if ((req.method === 'POST' || req.method === 'GET') && requestUrl.pathname === '/api/agent/download') return handleAgentDownload(req, res, requestUrl);
  if (req.method === 'POST' && requestUrl.pathname === '/api/instagram/open') return handleInstagramOpen(req, res);
  if (req.method === 'GET' && requestUrl.pathname === '/api/instagram/capture') return handleInstagramCapture(req, res, requestUrl);
  if (req.method === 'GET' && requestUrl.pathname === '/api/instagram/download') return handleInstagramDownload(req, res, requestUrl);
  if (req.method === 'POST' && requestUrl.pathname === '/api/tiktok/open') return handleTikTokOpen(req, res);
  if (req.method === 'GET' && requestUrl.pathname === '/api/tiktok/capture') return handleTikTokCapture(req, res, requestUrl);
  if (req.method === 'GET' && requestUrl.pathname === '/api/tiktok/download') return handleTikTokDownload(req, res, requestUrl);
  if (req.method === 'GET' && requestUrl.pathname === '/api/download') return handleDownload(req, res, requestUrl);
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const path = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  if (path.includes('..')) return json(res, 403, { error: 'Forbidden' });
  try {
    const file = await readFile(new URL(`.${path}`, publicDir));
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': mime[ext] || 'application/octet-stream' });
    res.end(file);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`ClipDock running at http://localhost:${PORT}`));

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const session of instagramCaptures.values()) {
    try { session.socket?.close(); } catch {}
  }
  instagramCaptures.clear();
  if (instagramChromeProcess && !instagramChromeProcess.killed) {
    instagramChromeProcess.kill('SIGTERM');
    instagramChromeProcess = null;
  }
  await new Promise(resolve => server.close(resolve));
}

process.once('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
