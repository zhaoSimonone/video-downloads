import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = dirname(fileURLToPath(new URL('../server.js', import.meta.url)));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/download-records`);
      if (response.ok) return;
    } catch { /* retry while the child process starts */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('test server did not start');
}

test('completed wxchannels agent tasks are synchronized into download records', async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'clipdock-agent-records-test-'));
  const downloadsDirectory = join(temporaryDirectory, 'Downloads');
  const recordsPath = join(temporaryDirectory, 'Application Support', 'ClipDock', 'download-records.json');
  await mkdir(downloadsDirectory, { recursive: true });
  const downloadedFile = join(downloadsDirectory, '视频号测试_xWT102.mp4');
  await writeFile(downloadedFile, 'video-data-from-agent');

  const task = {
    id: 901,
    platform_id: 'wxchannels',
    status: 5,
    name: '视频号测试视频',
    source_url: 'https://channels.weixin.qq.com/web/pages/feed?oid=test&nid=demo',
    url: 'https://finder.video.qq.com/251/20302/stodownload?token=test-token',
    config_json: JSON.stringify({ spec: 'xWT102' }),
    created_at: 1792000000000,
    updated_at: 1792000005000,
    files: [{ id: 901, file_path: downloadedFile, status: 'finished', size: 21 }],
  };
  const agent = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/v1/download_task/list')) {
      const body = JSON.stringify({ code: 0, msg: '成功', data: { list: [task] } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 404, msg: 'not found' }));
  });
  const agentPort = await listen(agent);
  const baseAgentUrl = `http://127.0.0.1:${agentPort}`;
  const clipdockPort = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
  const baseUrl = `http://127.0.0.1:${clipdockPort}`;
  const clipdock = spawn(process.execPath, ['server.js'], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      PORT: String(clipdockPort),
      WX_CHANNELS_AGENT_ORIGIN: baseAgentUrl,
      CLIPDOCK_DOWNLOADS_DIRECTORY: downloadsDirectory,
      CLIPDOCK_DOWNLOAD_RECORDS_PATH: recordsPath,
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    clipdock.kill('SIGTERM');
    await new Promise(resolve => clipdock.once('exit', resolve));
    agent.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);
  const first = await fetch(`${baseUrl}/api/download-records`);
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.records.length, 1);
  assert.equal(firstBody.records[0].origin, 'wxchannels-agent');
  assert.equal(firstBody.records[0].sourceUrl, task.source_url);
  assert.equal(firstBody.records[0].downloadUrl, task.url);
  assert.equal(firstBody.records[0].filePath, downloadedFile);
  assert.equal(firstBody.records[0].quality, 'xWT102');

  const second = await fetch(`${baseUrl}/api/download-records`);
  const secondBody = await second.json();
  assert.equal(secondBody.records.length, 1);
  assert.equal(secondBody.records[0].id, firstBody.records[0].id);
});
