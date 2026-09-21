import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = dirname(fileURLToPath(new URL('../server.js', import.meta.url)));

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForServer(baseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/download-records`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('test server did not start');
}

async function request(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('completed downloads are durably recorded with source URL and actual file path', async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'clipdock-records-test-'));
  const downloadsDirectory = join(temporaryDirectory, 'Downloads');
  const recordsPath = join(temporaryDirectory, 'Application Support', 'ClipDock', 'download-records.json');
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      PORT: String(port),
      CLIPDOCK_DOWNLOADS_DIRECTORY: downloadsDirectory,
      CLIPDOCK_DOWNLOAD_RECORDS_PATH: recordsPath,
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await waitForServer(baseUrl);
  const prepared = await request(`${baseUrl}/api/download-records/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'instagram',
      title: '授权测试视频',
      sourceUrl: 'https://www.instagram.com/reel/Example123/',
      resolvedUrl: 'https://video.cdninstagram.com/example.mp4',
      quality: 'original',
    }),
  });
  assert.equal(prepared.response.status, 201);
  assert.equal(prepared.body.record.status, 'pending');

  await mkdir(downloadsDirectory, { recursive: true });
  const downloadedFile = join(downloadsDirectory, 'instagram-reel.mp4');
  await writeFile(downloadedFile, 'video-data');
  const completed = await request(`${baseUrl}/api/download-records/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: prepared.body.record.id, filePath: downloadedFile }),
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.record.status, 'completed');
  assert.equal(completed.body.record.filePath, downloadedFile);
  assert.equal(completed.body.record.fileSizeBytes, 10);

  const listed = await request(`${baseUrl}/api/download-records`);
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.records.length, 1);
  assert.deepEqual(listed.body.records[0], completed.body.record);

  const persisted = JSON.parse(await readFile(recordsPath, 'utf8'));
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.records[0].sourceUrl, 'https://www.instagram.com/reel/Example123/');
  assert.equal(persisted.records[0].filePath, downloadedFile);

  const cleared = await request(`${baseUrl}/api/download-records`, { method: 'DELETE' });
  assert.equal(cleared.response.status, 200);
  const afterClear = await request(`${baseUrl}/api/download-records?status=all`);
  assert.deepEqual(afterClear.body.records, []);
});
