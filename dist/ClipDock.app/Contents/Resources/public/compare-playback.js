// One transport owns every player. Media events never trigger each other's play/pause.
export class ComparePlayback {
  constructor({ onChange = () => {}, onError = () => {} } = {}) {
    this.videos = [];
    this.status = 'paused';
    this.wantsPlayback = false;
    this.rate = 1;
    this.muted = false;
    this.onChange = onChange;
    this.onError = onError;
    this.listeners = [];
    this.operation = null;
    this.timer = null;
    this.lastResync = 0;
  }

  get duration() {
    const durations = this.videos.map(video => video.duration);
    return durations.length && durations.every(value => Number.isFinite(value) && value > 0)
      ? Math.min(...durations) : 0;
  }

  get currentTime() {
    return Math.min(this.videos[0]?.currentTime || 0, this.duration);
  }

  setVideos(videos) {
    const time = this.currentTime;
    this.pause();
    this.listeners.forEach(remove => remove());
    this.listeners = [];
    this.videos = [...videos];
    this.videos.forEach((video, index) => {
      const listen = (event, callback) => {
        video.addEventListener(event, callback);
        this.listeners.push(() => video.removeEventListener(event, callback));
      };
      listen('loadedmetadata', () => this.onChange());
      listen('durationchange', () => this.onChange());
      listen('timeupdate', () => {
        if (index === 0 && this.status === 'paused') this.onChange();
      });
      listen('ended', () => {
        if (this.status === 'playing' && video.ended) this.finish();
      });
      listen('error', () => {
        if (this.status !== 'loading') this.fail(video.error);
      });
    });
    this.applyAudio();
    this.setRate(this.rate);
    if (time > 0 && this.videos.length) return this.seek(time);
    this.onChange();
    return Promise.resolve();
  }

  applyAudio() {
    // Only the reference video's audio is audible; parallel soundtracks cause echo.
    this.videos.forEach((video, index) => {
      video.muted = this.muted || index > 0;
      // WebKit's time-stretch audio pipeline stalls on rate changes, even when muted.
      video.preservesPitch = index === 0;
      if ('webkitPreservesPitch' in video) video.webkitPreservesPitch = index === 0;
    });
  }

  setMuted(muted) {
    this.muted = muted;
    this.applyAudio();
    this.onChange();
  }

  setRate(rate) {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.rate = rate;
    this.videos.forEach(video => { video.playbackRate = rate; });
  }

  cancelOperation() {
    this.operation?.abort();
    this.operation = null;
    clearInterval(this.timer);
    this.timer = null;
  }

  pauseMedia() {
    this.videos.forEach(video => {
      video.pause();
      if (video.playbackRate !== this.rate) video.playbackRate = this.rate;
    });
  }

  pause() {
    this.wantsPlayback = false;
    this.cancelOperation();
    this.status = 'paused';
    this.pauseMedia();
    this.onChange();
  }

  play() {
    if (!this.videos.length || this.wantsPlayback) return Promise.resolve();
    const time = this.duration && this.currentTime >= this.duration - 0.025 ? 0 : this.currentTime;
    return this.run(time, true);
  }

  seek(time, resume = false) {
    return this.run(Number.isFinite(time) ? time : 0, resume);
  }

  waitFor(video, predicate, signal) {
    return new Promise((resolve, reject) => {
      const events = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked', 'progress', 'error'];
      const cleanup = () => {
        clearTimeout(timeout);
        events.forEach(event => video.removeEventListener(event, check));
        signal.removeEventListener('abort', abort);
      };
      const done = error => { cleanup(); error ? reject(error) : resolve(); };
      const abort = () => done(new DOMException('Playback cancelled', 'AbortError'));
      const check = () => {
        if (signal.aborted) abort();
        else if (video.error) done(video.error);
        else if (predicate()) done();
      };
      const timeout = setTimeout(() => done(new Error('Video readiness timed out')), 15000);
      events.forEach(event => video.addEventListener(event, check));
      signal.addEventListener('abort', abort, { once: true });
      check();
    });
  }

  async run(time, shouldPlay) {
    this.cancelOperation();
    if (!this.videos.length) return;
    const operation = new AbortController();
    this.operation = operation;
    const { signal } = operation;
    const videos = [...this.videos];
    this.wantsPlayback = shouldPlay;
    this.status = 'loading';
    this.pauseMedia();
    this.onChange();
    try {
      await Promise.all(videos.map(video => this.waitFor(video, () => video.readyState >= 1, signal)));
      if (signal.aborted) return;
      if (!this.duration) throw new Error('Invalid video duration');
      const target = Math.max(0, Math.min(time, this.duration));
      videos.forEach(video => {
        if (Math.abs(video.currentTime - target) > 0.015) video.currentTime = target;
      });
      // Do not wait for a future-data queue here. WebKit can legitimately keep
      // HAVE_METADATA while play() fills a high-bitrate local decoder.
      await Promise.all(videos.map(video => this.waitFor(video,
        () => !video.seeking, signal)));
      if (signal.aborted) return;
      if (shouldPlay) {
        await Promise.all(videos.map(video => video.play()));
        if (signal.aborted) return;
        this.status = 'playing';
        this.lastResync = Date.now();
        this.timer = setInterval(() => this.tick(), 100);
      } else {
        this.status = 'paused';
      }
      this.onChange();
    } catch (error) {
      if (!signal.aborted) this.fail(error);
    }
  }

  tick() {
    if (this.status !== 'playing') return;
    if (this.currentTime >= this.duration - 0.025 || this.videos.some(video => video.ended)) {
      this.finish();
      return;
    }
    const now = Date.now();
    if (this.videos.some(video => video.paused)) {
      this.run(this.currentTime, true);
      return;
    }
    const referenceTime = this.currentTime;
    for (const video of this.videos.slice(1)) {
      const drift = referenceTime - video.currentTime;
      // Keep rates fixed: changing them during playback stalls macOS HEVC decoding.
      // Tolerate frame-level jitter and never seek on every timer tick.
      if (Math.abs(drift) > 0.4 && now - this.lastResync > 1000) {
        this.run(referenceTime, true);
        return;
      }
    }
    this.onChange();
  }

  finish() {
    const end = this.duration;
    this.pause();
    this.videos.forEach(video => {
      if (Math.abs(video.currentTime - end) > 0.015) video.currentTime = end;
    });
    this.onChange();
  }

  fail(error) {
    this.pause();
    this.onError(error);
  }

  destroy() {
    this.pause();
    this.listeners.forEach(remove => remove());
    this.listeners = [];
    this.videos = [];
  }
}
