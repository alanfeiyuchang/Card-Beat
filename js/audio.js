// Decodes the clip's audio track into a downsampled waveform for the timeline.
// Gracefully no-ops when the container has no decodable audio.
export async function loadWaveform(file, buckets = 1600) {
  try {
    const buf = await file.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const audio = await ctx.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(ch.length / buckets));
    const peaks = new Float32Array(buckets);
    for (let i = 0; i < buckets; i++) {
      let max = 0;
      const start = i * step;
      for (let j = 0; j < step; j++) {
        const v = Math.abs(ch[start + j] || 0);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    ctx.close();
    return { peaks, duration: audio.duration };
  } catch (e) {
    console.warn('No decodable audio track:', e.message);
    return { peaks: null, duration: 0 };
  }
}

// Simple tap-tempo accumulator. Returns a BPM once >=2 taps within a sane window.
export class TapTempo {
  constructor() { this.times = []; }
  tap(now) {
    if (this.times.length && now - this.times[this.times.length - 1] > 2000) this.times = [];
    this.times.push(now);
    if (this.times.length > 8) this.times.shift();
    if (this.times.length < 2) return null;
    let sum = 0;
    for (let i = 1; i < this.times.length; i++) sum += this.times[i] - this.times[i - 1];
    const avg = sum / (this.times.length - 1);
    return Math.round((60000 / avg) * 10) / 10;
  }
}
