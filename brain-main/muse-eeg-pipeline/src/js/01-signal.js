/* =============================================================================
 *  01-signal.js  —  ④ 数据入口层
 *  muse-js 的 eegReadings 是**未经滤波的原始信号**（含工频干扰 + 眼电伪迹），
 *  本文件负责两件事：
 *    (1) 真实数据：解析 muse-js 吐出的原始包（JSON 文本 / 对象）
 *    (2) 演示数据：合成一路"物理上说得过去"的 4 通道 EEG，便于离线验证整条链路
 *  所有信号单位统一使用 µV。
 * ========================================================================== */
(function (NS) {
  'use strict';

  NS.CHANNELS = ['TP9', 'AF7', 'AF8', 'TP10'];   // 与 muse-js 的 eegChannel 索引一致
  NS.SAMPLE_RATE = 256;                          // Muse 标称 256 Hz
  NS.PACKET_SIZE = 12;                           // muse-js 每个包每通道 12 个样本
  NS.UNIT = 'µV';

  /** 可复现伪随机（mulberry32），保证演示可重放。 */
  NS.makeRng = function (seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* ---------------------------------------------------------------------------
   * 合成 Muse 信号源
   * 组成：1/f 背景噪声 + α 节律(10Hz，闭眼增强) + θ + 慢漂移
   *      + 工频(50/100Hz，可注入) + 眨眼 (EOG，额区强、颞区弱泄漏)
   * ------------------------------------------------------------------------ */
  function MuseSimulator(opts) {
    opts = opts || {};
    this.fs = opts.fs || NS.SAMPLE_RATE;
    this.rng = NS.makeRng(opts.seed || 20261020);
    this.mode = opts.mode || 'mixed';     // mixed | closed | open
    this.sampleIndex = 0;                 // 已生成样本数（每通道）
    this.packetIndex = 0;
    this.channelCursor = 0;
    this.alphaAmp = 9;
    this.humScale = 1;                    // 1 = 常态工频干扰
    this.humBoost = 0;                    // 手动注入的额外工频能量
    this.extraBlinks = [];
    this.blinkSchedule = [];
    this.blinkGenUntil = 0;

    const self = this;
    this.state = NS.CHANNELS.map(function () {
      return {
        n1: 0, n2: 0,
        alphaPhase: self.rng() * 6.2832,
        thetaPhase: self.rng() * 6.2832,
        driftPhase: self.rng() * 6.2832,
        alphaGain: 0.7 + self.rng() * 0.5
      };
    });
    // 各通道对眨眼(EOG)的灵敏度：额区最强，颞区弱且反相
    this.eogGain = [0.20, 1.00, 1.12, 0.16];
  }

  MuseSimulator.prototype._ensureBlinks = function (t) {
    const r = this.rng;
    while (this.blinkGenUntil < t + 60) {
      const gap = 2.2 + r() * 5.0;                     // 每 2.2~7.2 秒一次眨眼
      this.blinkGenUntil += gap;
      this.blinkSchedule.push({ t0: this.blinkGenUntil, dur: 0.55, amp: 130 + r() * 90 });
      if (this.blinkSchedule.length > 4000) this.blinkSchedule.splice(0, 2000);
    }
  };

  /** 归一化双指数眨眼波形：快升(20ms)慢降(120ms)，更像真实 EOG。 */
  MuseSimulator._blinkShape = function (tt) {
    if (tt < 0 || tt > 0.55) return 0;
    const tR = 0.020, tD = 0.120;
    const w = Math.exp(-tt / tD) - Math.exp(-tt / tR);
    return w / 0.5825;   // 峰值归一化到 1
  };

  MuseSimulator.prototype._eogAt = function (t, ch) {
    let eog = 0;
    const list = this.blinkSchedule;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (t < b.t0) break;
      const tt = t - b.t0;
      if (tt <= 0.55) eog += b.amp * MuseSimulator._blinkShape(tt);
    }
    for (let i = 0; i < this.extraBlinks.length; i++) {
      const b = this.extraBlinks[i];
      const tt = t - b.t0;
      if (tt >= 0 && tt <= 0.55) eog += b.amp * MuseSimulator._blinkShape(tt);
    }
    return eog * this.eogGain[ch] * (this.state[ch].alphaGain > 0.9 ? 0.9 : 1.0);
  };

  MuseSimulator.prototype._updateState = function (t) {
    // 模式决定 α 强度：闭眼 α 增强，睁眼 α 受抑（α 阻断）
    let target = 9;
    if (this.mode === 'closed') target = 16;
    else if (this.mode === 'open') target = 2.5;
    else if (this.mode === 'mixed') target = (Math.floor(t / 6) % 2 === 0) ? 3.0 : 15.0;
    this.alphaAmp += (target - this.alphaAmp) * 0.004;   // 缓慢过渡，避免阶跃
    this.humBoost *= 0.99997;                            // 手动注入的工频缓慢衰减
    this.humScale = 1 + this.humBoost;
  };

  MuseSimulator.prototype._sample = function (ch, t) {
    const st = this.state[ch];
    const r = this.rng;
    const w = r() * 2 - 1;

    // --- 1/f 背景：白噪声经两个一阶低通 -> 近似粉噪声 ---
    st.n1 += (w - st.n1) * (2 * Math.PI * 3 / this.fs);    // 慢成分
    st.n2 += (w - st.n2) * (2 * Math.PI * 30 / this.fs);   // 快成分
    const noise = st.n1 * 13 + st.n2 * 3.5 + w * 1.2;

    // --- α 节律 10Hz（含轻微频率抖动）---
    const aAmp = this.alphaAmp * st.alphaGain;
    const alpha = aAmp * Math.sin(2 * Math.PI * 10 * t + st.alphaPhase)
      + 0.35 * aAmp * Math.sin(2 * Math.PI * 10.7 * t + st.alphaPhase * 1.7);

    // --- θ 与慢漂移 ---
    const theta = 2.2 * Math.sin(2 * Math.PI * 5.2 * t + st.thetaPhase);
    const drift = 7.5 * Math.sin(2 * Math.PI * 0.18 * t + st.driftPhase);

    // --- 工频干扰（50Hz + 二次谐波）---
    const hum = this.humScale * (6.6 * Math.sin(2 * Math.PI * 50 * t)
      + 2.3 * Math.sin(2 * Math.PI * 100 * t + 0.7));

    // --- 眼电伪迹 ---
    const eog = this._eogAt(t, ch);

    return noise + alpha + theta + drift + hum + eog;
  };

  /** 取一个 muse-js 风格的原始包：{index, eegChannel, samples[12], timestamp} */
  MuseSimulator.prototype.nextPacket = function () {
    const ch = this.channelCursor;
    const n = NS.PACKET_SIZE;
    const samples = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = (this.sampleIndex + i) / this.fs;
      this._ensureBlinks(t);
      this._updateState(t);
      samples[i] = this._sample(ch, t);
    }
    const pkt = {
      index: this.packetIndex++,
      eegChannel: ch,
      samples: samples,
      timestamp: Date.now()
    };
    this.channelCursor = (this.channelCursor + 1) % NS.CHANNELS.length;
    if (this.channelCursor === 0) this.sampleIndex += n;
    return pkt;
  };

  MuseSimulator.prototype.setMode = function (m) { this.mode = m; };

  /** 手动注入一次眨眼伪迹（用于直观观察去伪迹效果）。 */
  MuseSimulator.prototype.injectBlink = function (amp) {
    this.extraBlinks.push({
      t0: this.sampleIndex / this.fs + 0.02,
      dur: 0.55,
      amp: amp || 240
    });
    if (this.extraBlinks.length > 40) this.extraBlinks.shift();
  };

  /** 手动注入一波工频干扰。 */
  MuseSimulator.prototype.injectHum = function (scale) {
    this.humBoost += (scale == null ? 3.0 : scale);
    if (this.humBoost > 12) this.humBoost = 12;
  };

  NS.MuseSimulator = MuseSimulator;

  /* ---------------------------------------------------------------------------
   * 真实 muse-js 数据解析
   * 兼容字段名：eegChannel | channel | electrode；samples | values | data
   * 兼容外层包装：eegReadings / readings / 纯数组 / 每行一个 JSON 对象
   * ------------------------------------------------------------------------ */
  NS.parseMuseJson = function (text) {
    const out = [];
    const pushOne = function (obj) {
      if (!obj || typeof obj !== 'object') return;
      let ch = obj.eegChannel;
      if (ch == null) ch = obj.channel;
      if (ch == null) ch = obj.electrode;
      const raw = obj.samples || obj.values || obj.data;
      if (ch == null || !raw || !raw.length) return;
      const arr = new Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = Number(raw[i]);
      out.push({
        index: Number(obj.index) || out.length,
        eegChannel: Number(ch),
        samples: arr,
        timestamp: Number(obj.timestamp) || 0
      });
    };
    const walk = function (d) {
      if (Array.isArray(d)) { d.forEach(walk); return; }
      if (d && typeof d === 'object') {
        if (Array.isArray(d.eegReadings)) { d.eegReadings.forEach(walk); return; }
        if (Array.isArray(d.readings)) { d.readings.forEach(walk); return; }
        pushOne(d);
      }
    };

    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = [];
      const lines = String(text).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim().replace(/,\s*$/, '');
        if (!line) continue;
        try { data.push(JSON.parse(line)); } catch (_) { /* 跳过坏行 */ }
      }
    }
    walk(data);

    // 按时间戳排序，保证拼装顺序正确
    out.sort(function (a, b) {
      if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.index - b.index;
    });
    return out;
  };

  /**
   * 把原始包拼装成 4×N 通道矩阵。
   * @returns {{fs:number, channels:number[][], packets:number, seconds:number}}
   */
  NS.assembleRecording = function (packets, fs) {
    fs = fs || NS.SAMPLE_RATE;
    const chans = [[], [], [], []];
    for (let i = 0; i < packets.length; i++) {
      const p = packets[i];
      const c = p.eegChannel;
      if (c == null || !chans[c]) continue;
      for (let j = 0; j < p.samples.length; j++) chans[c].push(p.samples[j]);
    }
    // 只按"有数据的通道"对齐；完全缺失的通道补零，保证后续 DSP 仍能跑
    let minLen = Infinity, any = false;
    for (let c = 0; c < 4; c++) {
      if (chans[c].length > 0) { any = true; minLen = Math.min(minLen, chans[c].length); }
    }
    if (!any) minLen = 0;
    for (let c = 0; c < 4; c++) {
      chans[c] = chans[c].length === 0 ? new Array(minLen).fill(0) : chans[c].slice(0, minLen);
    }
    return { fs: fs, channels: chans, packets: packets.length, seconds: minLen / fs };
  };

})(window.EEG = window.EEG || {});
