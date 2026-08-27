import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3457);
const publicDir = new URL('./public/', import.meta.url);
const CHANNELS_AGENT_ORIGIN = normalizeChannelsAgentOrigin(process.env.WX_CHANNELS_AGENT_ORIGIN || '');
const AGENT_REQUEST_TIMEOUT_MS = boundedNumber(process.env.WX_CHANNELS_AGENT_TIMEOUT_MS, 3000, 500, 15000);
const AGENT_JOB_TIMEOUT_MS = boundedNumber(process.env.WX_CHANNELS_AGENT_JOB_TIMEOUT_MS, 120000, 5000, 600000);

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

function platformFor(url) {
  const host = url.hostname.toLowerCase();
  if (host.includes('douyin') || host.includes('iesdouyin')) return 'douyin';
  if (host.includes('weixin.qq.com') || host.includes('channels.weixin')) return 'channels';
  return 'unknown';
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

async function handleAgentDownload(req, res) {
  if (!CHANNELS_AGENT_ORIGIN) {
    json(res, 503, { ok: false, error: '微信视频号桌面代理未配置，请先启动参考项目并设置 WX_CHANNELS_AGENT_ORIGIN' });
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const request = JSON.parse(body || '{}');
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
  const title = isChannels ? '微信视频号内容 · 待授权解析' : isDouyin ? '抖音内容 · 待解析' : '待解析的视频';
  const message = isDirectMedia(url)
    ? '检测到直链，可直接下载。'
    : (isChannels && url.hostname === 'weixin.qq.com'
      ? '该微信短链接会跳转到视频号预览页，当前内容需要登录或扫码后才能获取媒体直链。'
      : '平台分享页需要在已登录的浏览器会话中解析，请先在对应平台打开并复制可访问的媒体直链。');
  return {
    title,
    author: isChannels ? '视频号创作者' : isDouyin ? '抖音创作者' : '未知创作者',
    duration: '--:--',
    thumbnail: null,
    platform,
    direct: isDirectMedia(url),
    requiresSession: !isDirectMedia(url),
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
  if (req.method === 'POST' && requestUrl.pathname === '/api/agent/download') return handleAgentDownload(req, res);
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
