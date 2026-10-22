/* =============================================================================
 *  02-dsp.js  —  ② 滤波 + ④ 频域基础
 *  全是手写实现，无第三方库：
 *    - Biquad（RBJ Cookbook 系数，Transposed Direct Form II 结构）
 *    - Butterworth 带通 = 高通(1Hz) + 低通(50Hz) 级联，Q 值按巴特沃斯极点分布
 *    - 陷波（工频 50/60Hz 及其谐波）
 *    - radix-2 FFT + Hann 窗 + Welch 平均功率谱 (µV²/Hz)
 * ========================================================================== */
(function (NS) {
  'use strict';
  const DSP = NS.DSP = NS.DSP || {};

  /* ------------------------------------------------------------------ Biquad */
  function Biquad(b0, b1, b2, a1, a2) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2;
    this.a1 = a1; this.a2 = a2;   // 已按 a0 归一化
    this.z1 = 0; this.z2 = 0;
  }
  Biquad.prototype.process = function (x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  };
  Biquad.prototype.reset = function () { this.z1 = 0; this.z2 = 0; };

  Biquad.lowPass = function (fc, fs, q) {
    const w0 = 2 * Math.PI * fc / fs, cs = Math.cos(w0), sn = Math.sin(w0);
    const alpha = sn / (2 * q);
    const b0 = (1 - cs) / 2, b1 = 1 - cs, b2 = (1 - cs) / 2;
    const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  };
  Biquad.highPass = function (fc, fs, q) {
    const w0 = 2 * Math.PI * fc / fs, cs = Math.cos(w0), sn = Math.sin(w0);
    const alpha = sn / (2 * q);
    const b0 = (1 + cs) / 2, b1 = -(1 + cs), b2 = (1 + cs) / 2;
    const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  };
  Biquad.notch = function (f0, fs, q) {
    const w0 = 2 * Math.PI * f0 / fs, cs = Math.cos(w0), sn = Math.sin(w0);
    const alpha = sn / (2 * q);
    const b0 = 1, b1 = -2 * cs, b2 = 1;
    const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  };
  Biquad.bandPass = function (f0, fs, q) {
    const w0 = 2 * Math.PI * f0 / fs, cs = Math.cos(w0), sn = Math.sin(w0);
    const alpha = sn / (2 * q);
    const b0 = alpha, b1 = 0, b2 = -alpha;
    const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  };
  DSP.Biquad = Biquad;

  /**
   * 巴特沃斯极点对应的 Q 值：Q_k = 1 / (2·cos((2k+1)π / (2N)))
   * N 阶滤波器由 N/2 个二阶节级联而成，这样通带才真正平坦（无纹波）。
   */
  DSP.butterQ = function (order) {
    const n = Math.max(2, order - (order % 2));   // 取偶数阶
    const qs = [];
    for (let k = 0; k < n / 2; k++) {
      qs.push(1 / (2 * Math.cos((2 * k + 1) * Math.PI / (2 * n))));
    }
    return qs;
  };

  /* ------------------------------------------------- 滤波设计（按配置生成系数） */
  /**
   * @param cfg {fs, bandpass:{enabled,low,high,order}, notch:{enabled,f0,harmonics,q}}
   * @returns {Array<{name:string, sections:Array<{b0,b1,b2,a1,a2}>}>}
   */
  DSP.design = function (cfg) {
    const fs = cfg.fs;
    const stages = [];
    const bp = cfg.bandpass || {};
    if (bp.enabled) {
      const qs = DSP.butterQ(bp.order || 4);
      const hp = [], lp = [];
      qs.forEach(function (q) {
        hp.push(DSP._coeff(Biquad.highPass(bp.low, fs, q)));
        lp.push(DSP._coeff(Biquad.lowPass(bp.high, fs, q)));
      });
      stages.push({ name: '高通 ' + bp.low + 'Hz (' + (bp.order || 4) + '阶)', sections: hp });
      stages.push({ name: '低通 ' + bp.high + 'Hz (' + (bp.order || 4) + '阶)', sections: lp });
    }
    const nt = cfg.notch || {};
    if (nt.enabled) {
      const f0 = nt.f0 || 50;
      const q = nt.q || 30;
      const secs = [];
      const maxH = nt.harmonics ? Math.floor((fs / 2 - 5) / f0) : 1;
      for (let h = 1; h <= Math.max(1, maxH); h++) {
        const f = f0 * h;
        if (f >= fs / 2 - 2) break;
        secs.push(DSP._coeff(Biquad.notch(f, fs, q)));
      }
      stages.push({ name: '陷波 ' + f0 + 'Hz ×' + secs.length, sections: secs });
    }
    return stages;
  };

  DSP._coeff = function (bq) {
    return { b0: bq.b0, b1: bq.b1, b2: bq.b2, a1: bq.a1, a2: bq.a2 };
  };

  /** 生成滤波器的幅频响应（用于展示） */
  DSP.responseDb = function (stages, fs, nPoints) {
    nPoints = nPoints || 256;
    const out = new Array(nPoints);
    for (let i = 0; i < nPoints; i++) {
      const f = (i / (nPoints - 1)) * (fs / 2);
      const w = 2 * Math.PI * f / fs;
      // 复数频率响应 H(e^{jw}) = Π H_stage(e^{jw})
      let gain = 1;
      for (let s = 0; s < stages.length; s++) {
        const secs = stages[s].sections;
        for (let k = 0; k < secs.length; k++) {
          const c = secs[k];
          // 分子 b0 + b1 z^-1 + b2 z^-2 ; 分母 1 + a1 z^-1 + a2 z^-2
          const cw = Math.cos(w), sw = Math.sin(w);
          const c2w = Math.cos(2 * w), s2w = Math.sin(2 * w);
          const nr = c.b0 + c.b1 * cw + c.b2 * c2w, ni = -(c.b1 * sw + c.b2 * s2w);
          const dr = 1 + c.a1 * cw + c.a2 * c2w, di = -(c.a1 * sw + c.a2 * s2w);
          const dm = dr * dr + di * di;
          const hr = (nr * dr + ni * di) / (dm || 1e-12);
          const hi = (ni * dr - nr * di) / (dm || 1e-12);
          gain *= Math.sqrt(hr * hr + hi * hi);
        }
      }
      out[i] = { freq: f, db: 20 * Math.log10(Math.max(gain, 1e-6)) };
    }
    return out;
  };

  /* ------------------------------------------------------------ 在线滤波链路 */
  /** 每通道独立状态的级联滤波器组，样本级流式处理。 */
  function FilterChain(cfg, nCh) {
    this.cfg = cfg;
    this.nCh = nCh || 4;
    this.stages = [];
    this.units = [];
    this.rebuild();
  }
  FilterChain.prototype.rebuild = function () {
    this.stages = DSP.design(this.cfg);
    const units = [];
    for (let c = 0; c < this.nCh; c++) {
      const perCh = [];
      for (let s = 0; s < this.stages.length; s++) {
        const secs = this.stages[s].sections.map(function (co) {
          return new Biquad(co.b0, co.b1, co.b2, co.a1, co.a2);
        });
        perCh.push(secs);
      }
      units.push(perCh);
    }
    this.units = units;
    this.groupDelay = this._estimateGroupDelay();
  };
  FilterChain.prototype.reset = function () {
    for (let c = 0; c < this.units.length; c++)
      for (let s = 0; s < this.units[c].length; s++)
        for (let k = 0; k < this.units[c][s].length; k++) this.units[c][s][k].reset();
  };
  /** 逐样点滤波：x -> y */
  FilterChain.prototype.process = function (ch, x) {
    const perCh = this.units[ch];
    if (!perCh) return x;
    let y = x;
    for (let s = 0; s < perCh.length; s++) {
      const secs = perCh[s];
      for (let k = 0; k < secs.length; k++) y = secs[k].process(y);
    }
    return y;
  };
  FilterChain.prototype.describe = function () {
    return this.stages.map(function (s) { return s.name; });
  };
  /** 粗略估计群延迟（样点数），用于波形对齐显示 */
  FilterChain.prototype._estimateGroupDelay = function () {
    const fs = this.cfg.fs;
    const resp = DSP.responseDb(this.stages, fs, 512);
    // 找到 -3dB 通带中心附近的相位延迟近似：这里用相位斜率更准，但为简洁取经验值
    let s = 0;
    for (let i = 0; i < resp.length; i++) s += Math.max(0, resp[i].db + 3);
    void s;
    return 0;   // 显示时用互相关对齐更实用，见 UI
  };
  DSP.FilterChain = FilterChain;

  /* --------------------------------------------------------------------- FFT */
  /** 原地 radix-2 复数 FFT（长度必须是 2 的幂）。 */
  DSP.fft = function (re, im) {
    const n = re.length;
    if (n <= 1) return;
    // 位反转置换
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < half; j++) {
          const p = i + j, q = p + half;
          const vr = re[q] * cr - im[q] * ci;
          const vi = re[q] * ci + im[q] * cr;
          re[q] = re[p] - vr; im[q] = im[p] - vi;
          re[p] += vr; im[p] += vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  };

  DSP.nextPow2 = function (n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  };

  DSP.hann = function (n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    return w;
  };

  /** 去均值 */
  DSP.detrend = function (x) {
    let m = 0;
    for (let i = 0; i < x.length; i++) m += x[i];
    m /= (x.length || 1);
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] - m;
    return out;
  };

  /**
   * Welch 平均功率谱密度，单位 µV²/Hz。
   * @param signal 时域序列（µV）
   * @param fs 采样率
   * @param opts {nfft, overlap}
   */
  DSP.psd = function (signal, fs, opts) {
    opts = opts || {};
    const n = signal.length;
    let nfft = opts.nfft || 0;
    if (!nfft) nfft = Math.min(512, DSP.nextPow2(Math.max(64, n)));
    if (nfft > DSP.nextPow2(n)) nfft = DSP.nextPow2(Math.max(64, n));
    if (nfft < 4) nfft = 4;
    nfft = DSP.nextPow2(nfft);

    const w = DSP.hann(nfft);
    let u = 0;
    for (let i = 0; i < nfft; i++) u += w[i] * w[i];

    const step = Math.max(1, Math.floor(nfft * (1 - (opts.overlap == null ? 0.5 : opts.overlap))));
    const half = nfft / 2;
    const acc = new Float64Array(half + 1);
    let segs = 0;

    for (let start = 0; start + nfft <= n; start += step) {
      const re = new Float64Array(nfft), im = new Float64Array(nfft);
      // 段内去均值，再去直流对低频段的影响
      let m = 0;
      for (let i = 0; i < nfft; i++) m += signal[start + i];
      m /= nfft;
      for (let i = 0; i < nfft; i++) re[i] = (signal[start + i] - m) * w[i];
      DSP.fft(re, im);
      for (let k = 0; k <= half; k++) {
        let p = (re[k] * re[k] + im[k] * im[k]) / (fs * u);
        if (k !== 0 && k !== half) p *= 2;      // 单边谱
        acc[k] += p;
      }
      segs++;
    }
    if (segs === 0) {                                 // 数据比窗还短：补零后单段
      const re = new Float64Array(nfft), im = new Float64Array(nfft);
      for (let i = 0; i < n && i < nfft; i++) re[i] = (signal[i] - (signal[0] || 0)) * w[i];
      DSP.fft(re, im);
      for (let k = 0; k <= half; k++) {
        let p = (re[k] * re[k] + im[k] * im[k]) / (fs * u);
        if (k !== 0 && k !== half) p *= 2;
        acc[k] = p;
      }
      segs = 1;
    }
    const psd = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) psd[k] = acc[k] / segs;

    const freq = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) freq[k] = k * fs / nfft;
    return { freq: freq, psd: psd, nfft: nfft, segments: segs, df: fs / nfft };
  };

  /** 单点 DFT（用于精确检验某个频率的能量，如工频残留） */
  DSP.goertzel = function (signal, fs, f) {
    let sr = 0, si = 0;
    const n = signal.length, w = 2 * Math.PI * f / fs;
    for (let i = 0; i < n; i++) {
      sr += signal[i] * Math.cos(w * i);
      si -= signal[i] * Math.sin(w * i);
    }
    return Math.sqrt(sr * sr + si * si) * 2 / n;   // 幅值（µV）
  };

})(window.EEG = window.EEG || {});
