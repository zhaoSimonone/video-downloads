import assert from 'node:assert/strict';
import test from 'node:test';
import { ComparePlayback } from '../public/compare-playback.js';

class Video extends EventTarget {
  duration = 12;
  readyState = 4;
  paused = true;
  seeking = false;
  ended = false;
  error = null;
  playbackRate = 1;
  muted = false;
  preservesPitch = true;
  time = 0;
  seeks = [];
  plays = 0;

  get currentTime() { return this.time; }
  set currentTime(value) {
    this.time = value;
    this.seeks.push(value);
    this.ended = false;
    this.seeking = true;
    queueMicrotask(() => {
      this.seeking = false;
      this.dispatchEvent(new Event('seeked'));
    });
  }

  play() {
    this.plays += 1;
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }

  pause() {
    const wasPlaying = !this.paused;
    this.paused = true;
    if (wasPlaying) queueMicrotask(() => this.dispatchEvent(new Event('pause')));
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, count = 2) {
  const errors = [];
  const player = new ComparePlayback({ onError: error => errors.push(error) });
  const videos = Array.from({ length: count }, () => new Video());
  player.setVideos(videos);
  t.after(() => player.destroy());
  return { player, videos, errors };
}

test('all videos must be ready before any starts', async t => {
  const { player, videos: [a, b] } = fixture(t);
  b.readyState = 0;
  const starting = player.play();
  await flush();
  assert.equal(player.status, 'loading');
  assert.equal(a.plays, 0);
  assert.equal(b.plays, 0);
  b.readyState = 4;
  b.dispatchEvent(new Event('canplay'));
  await starting;
  assert.equal(player.status, 'playing');
  assert.equal(a.plays, 1);
  assert.equal(b.plays, 1);
});

test('pause cancels pending readiness without a delayed restart', async t => {
  const { player, videos: [a, b] } = fixture(t);
  b.readyState = 0;
  const starting = player.play();
  await flush();
  player.pause();
  b.readyState = 4;
  b.dispatchEvent(new Event('canplay'));
  await starting;
  assert.equal(player.status, 'paused');
  assert.equal(a.plays + b.plays, 0);
});

test('late pause/play events do not cascade into other players', async t => {
  const { player, videos: [a, b] } = fixture(t);
  await player.play();
  a.dispatchEvent(new Event('pause'));
  b.dispatchEvent(new Event('play'));
  await flush();
  assert.equal(player.status, 'playing');
  assert.equal(a.paused || b.paused, false);
  assert.equal(a.plays + b.plays, 2);
});

test('frame-level drift never changes speed or triggers a seek', async t => {
  const { player, videos: [a, b] } = fixture(t);
  await player.play();
  a.time = 2;
  b.time = 1.96;
  player.tick();
  assert.equal(b.playbackRate, 1);
  assert.equal(a.playbackRate, 1);
  assert.deepEqual(b.seeks, []);
  b.time = 2.04;
  player.tick();
  assert.equal(b.playbackRate, 1);
  b.time = 2.01;
  player.tick();
  assert.equal(b.playbackRate, 1);
});

test('large drift pauses and aligns the group once without rate changes', async t => {
  const { player, videos: [a, b] } = fixture(t);
  await player.play();
  a.time = 5;
  b.time = 3;
  player.lastResync = 0;
  player.tick();
  assert.equal(a.paused && b.paused, true);
  await flush();
  assert.equal(player.status, 'playing');
  assert.equal(b.currentTime, 5);
  assert.equal(b.seeks.length, 1);
  b.time = 3;
  player.tick();
  assert.equal(b.seeks.length, 1);
});

test('one buffering video pauses the group until it is ready', async t => {
  const { player, videos: [a, b] } = fixture(t);
  await player.play();
  a.time = 3;
  b.time = 2.9;
  b.readyState = 2;
  b.dispatchEvent(new Event('waiting'));
  await flush();
  assert.equal(player.status, 'playing');
  assert.equal(a.paused || b.paused, false);
  b.readyState = 4;
  b.dispatchEvent(new Event('canplay'));
  await flush();
  assert.equal(player.status, 'playing');
});

test('corrective seeks ignore queued waiting events and can be cancelled', async t => {
  const { player, videos: [a, b] } = fixture(t);
  await player.play();
  a.time = 2;
  b.time = 1;
  player.lastResync = 0;
  player.tick();
  b.dispatchEvent(new Event('waiting'));
  player.tick();
  assert.equal(player.status, 'loading');
  player.pause();
  await flush();
  assert.equal(player.status, 'paused');
  assert.equal(a.paused && b.paused, true);
});

test('a decoder with only current data does not leave the group preparing', async t => {
  const { player, videos: [a, b] } = fixture(t);
  await player.play();
  b.readyState = 2;
  player.tick();
  await flush();
  assert.equal(player.status, 'playing');
  assert.equal(a.paused || b.paused, false);
  b.readyState = 4;
  b.dispatchEvent(new Event('canplay'));
  await flush();
  assert.equal(player.status, 'playing');
});

test('initial playback starts at HAVE_CURRENT_DATA without waiting for a full queue', async t => {
  const { player, videos: [a, b] } = fixture(t);
  a.readyState = 2;
  b.readyState = 2;
  await player.play();
  assert.equal(player.status, 'playing');
  assert.equal(a.plays, 1);
  assert.equal(b.plays, 1);
});

test('cancelled corrections cannot restart a new selection', async t => {
  const { player, videos: [a, b] } = fixture(t);
  await player.play();
  a.time = 2;
  b.time = 1;
  player.lastResync = 0;
  player.tick();
  await player.setVideos([a]);
  await flush();
  assert.equal(player.status, 'paused');
  assert.deepEqual(player.videos, [a]);
});

test('the reference alone owns the timeline, using the shared duration', t => {
  const { player, videos: [a, b] } = fixture(t);
  a.duration = 12;
  b.duration = 8;
  a.time = 3;
  b.time = 4;
  assert.equal(player.duration, 8);
  assert.equal(player.currentTime, 3);
  b.time = 6;
  assert.equal(player.currentTime, 3);
});

test('shortest video ends the group and replay restarts everyone at zero', async t => {
  const { player, videos: [a, b] } = fixture(t);
  b.duration = 8;
  await player.play();
  a.time = 8.02;
  b.time = 8;
  b.ended = true;
  b.dispatchEvent(new Event('ended'));
  await flush();
  assert.equal(player.status, 'paused');
  assert.equal(a.paused && b.paused, true);
  assert.equal(a.currentTime, 8);
  await player.play();
  assert.equal(a.currentTime, 0);
  assert.equal(b.currentTime, 0);
  assert.equal(player.status, 'playing');
});

test('seek aligns everyone and preserves requested paused or playing state', async t => {
  const { player, videos: [a, b] } = fixture(t);
  await player.seek(4);
  assert.equal(a.currentTime, 4);
  assert.equal(b.currentTime, 4);
  assert.equal(a.paused && b.paused, true);
  await player.seek(6, true);
  assert.equal(a.currentTime, 6);
  assert.equal(b.currentTime, 6);
  assert.equal(player.status, 'playing');
});

test('only the latest seek can restart playback', async t => {
  const { player, videos: [a, b] } = fixture(t);
  const first = player.seek(3, true);
  const second = player.seek(7, false);
  await Promise.all([first, second]);
  assert.equal(a.currentTime, 7);
  assert.equal(b.currentTime, 7);
  assert.equal(a.plays + b.plays, 0);
});

test('play failures stop every video and surface the error', async t => {
  const { player, videos: [a, b], errors } = fixture(t);
  b.play = () => Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
  await player.play();
  assert.equal(player.status, 'paused');
  assert.equal(a.paused && b.paused, true);
  assert.equal(errors[0].name, 'NotAllowedError');
});

test('media errors cancel readiness and do not silently leave a video playing', async t => {
  const { player, videos: [a, b], errors } = fixture(t);
  b.readyState = 0;
  const starting = player.play();
  b.error = new Error('Decode error');
  b.dispatchEvent(new Event('error'));
  await starting;
  assert.equal(player.status, 'paused');
  assert.equal(a.paused && b.paused, true);
  assert.equal(errors.length, 1);
});

test('only reference audio is audible, including after removing it', async t => {
  const { player, videos: [a, b, c] } = fixture(t, 3);
  assert.deepEqual([a.muted, b.muted, c.muted], [false, true, true]);
  assert.deepEqual([a.preservesPitch, b.preservesPitch, c.preservesPitch], [true, false, false]);
  player.setMuted(true);
  assert.deepEqual([a.muted, b.muted, c.muted], [true, true, true]);
  player.setMuted(false);
  a.time = 4;
  await player.setVideos([b, c]);
  assert.deepEqual([b.muted, c.muted], [false, true]);
  assert.deepEqual([b.preservesPitch, c.preservesPitch], [true, false]);
  assert.equal(b.currentTime, 4);
  assert.equal(c.currentTime, 4);
});

test('rate changes apply to all players and survive pause/resume', async t => {
  const { player, videos: [a, b] } = fixture(t);
  player.setRate(0.5);
  await player.play();
  a.time = 2;
  b.time = 1.9;
  player.tick();
  assert.equal(b.playbackRate, 0.5);
  player.pause();
  assert.equal(a.playbackRate, 0.5);
  assert.equal(b.playbackRate, 0.5);
});

test('removing videos cancels old work and detaches media listeners', async t => {
  const { player, videos: [a, b], errors } = fixture(t);
  b.readyState = 0;
  const starting = player.play();
  await player.setVideos([a]);
  b.error = new Error('Detached error');
  b.dispatchEvent(new Event('error'));
  await starting;
  assert.deepEqual(player.videos, [a]);
  assert.equal(errors.length, 0);
  assert.equal(a.paused, true);
});
