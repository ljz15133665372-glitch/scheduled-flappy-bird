/* =============================================================================
 *  04-features.js  —  ③ 特征提取
 *  Welch 功率谱 → 频带积分 → 可判别特征：
 *    · 绝对/相对频带功率  δ(1-4) θ(4-8) α(8-13) β(13-30) γ(30-45)
 *    · α/β 比值（经典的「专注/放松」指标）
 *    · 谱熵（功率谱的香农熵，越低越"节律化"）
 *    · Hjorth 参数 activity / mobility / complexity（时域复杂度）
 *    · 峰值频率
 *  产出的特征向量可直接喂给 05-classifier.js。
 * ========================================================================== */
(function (NS) {
  'use strict';
  const F = NS.Features = {};

  F.BANDS = [
    { key: 'delta', symbol: 'δ', lo: 1, hi: 4 },
    { key: 'theta', symbol: 'θ', lo: 4, hi: 8 },
    { key: 'alpha', symbol: 'α', lo: 8, hi: 13 },
    { key: 'beta', symbol: 'β', lo: 13, hi: 30 },
    { key: 'gamma', symbol: 'γ', lo: 30, hi: 45 }
  ];

  function variance(x) {
    const n = x.length || 1;
    let m = 0;
    for (let i = 0; i < n; i++) m += x[i];
    m /= n;
    let s = 0;
    for (let i = 0; i < n; i++) { const d = x[i] - m; s += d * d; }
    return s / n;
  }

  function bandPower(psd, freq, df, lo, hi) {
    let e = 0;
    for (let i = 0; i < freq.length; i++) {
      const f = freq[i];
      if (f >= lo && f < hi) e += psd[i] * df;
    }
    return e;
  }

  function spectralEntropy(psd, freq, lo, hi) {
    let tot = 0;
    const idxs = [];
    for (let i = 0; i < freq.length; i++) {
      const f = freq[i];
      if (f >= lo && f < hi) { idxs.push(i); tot += psd[i]; }
    }
    if (tot <= 1e-15 || idxs.length < 2) return 0;
    let h = 0;
    for (let k = 0; k < idxs.length; k++) {
      const q = Math.max(psd[idxs[k]], 1e-15) / tot;
      h -= q * Math.log(q);
    }
    return h / Math.log(idxs.length);            // 归一化到 [0,1]
  }

  function hjorth(x) {
    const n = x.length;
    if (n < 4) return { activity: 0, mobility: 0, complexity: 0 };
    const v0 = variance(x);
    const d1 = new Array(n - 1), d2 = new Array(n - 2);
    for (let i = 0; i < n - 1; i++) d1[i] = x[i + 1] - x[i];
    for (let i = 0; i < n - 2; i++) d2[i] = d1[i + 1] - d1[i];
    const v1 = variance(d1), v2 = variance(d2);
    const mob = v0 > 1e-15 ? Math.sqrt(v1 / v0) : 0;
    const mob1 = v1 > 1e-15 ? Math.sqrt(v2 / v1) : 0;
    return {
      activity: v0,
      mobility: mob,
      complexity: mob > 1e-15 ? mob1 / mob : 0
    };
  }

  function peakFrequency(psd, freq, lo, hi) {
    let best = -1, bestF = 0;
    for (let i = 0; i < freq.length; i++) {
      const f = freq[i];
      if (f < lo || f > hi) continue;
      if (psd[i] > best) { best = psd[i]; bestF = f; }
    }
    return bestF;
  }

  /**
   * 计算一个时间窗的全部特征。
   * @param chans 4×N（应当是去伪迹之后的信号）
   * @param fs 采样率
   * @param opts {nfft, overlap, featSet}
   */
  F.compute = function (chans, fs, opts) {
    opts = opts || {};
    const nCh = chans.length;
    const perChannel = [];
    let sumFreq = null, sumPsd = null, nSeg = 0;

    for (let c = 0; c < nCh; c++) {
      const sig = chans[c];
      const r = NS.DSP.psd(sig, fs, { nfft: opts.nfft || 0, overlap: opts.overlap == null ? 0.5 : opts.overlap });
      const bp = {}, rel = {};
      let total = 0;
      for (let b = 0; b < F.BANDS.length; b++) {
        const bd = F.BANDS[b];
        const e = bandPower(r.psd, r.freq, r.df, bd.lo, bd.hi);
        bp[bd.key] = e;
        total += e;
      }
      for (let b = 0; b < F.BANDS.length; b++) {
        const k = F.BANDS[b].key;
        rel[k] = total > 1e-12 ? bp[k] / total : 0;
      }
      const ab = bp.beta > 1e-12 ? bp.alpha / bp.beta : 0;
      const ent = spectralEntropy(r.psd, r.freq, 1, 45);
      const hj = hjorth(sig);
      const pf = peakFrequency(r.psd, r.freq, 1, 45);

      perChannel.push({
        band: bp, relative: rel, total: total, alphaBeta: ab,
        entropy: ent, hjorth: hj, peakFreq: pf,
        psd: r.psd, freq: r.freq
      });

      if (!sumFreq) { sumFreq = r.freq; sumPsd = new Float64Array(r.psd.length); }
      for (let i = 0; i < r.psd.length && i < sumPsd.length; i++) sumPsd[i] += r.psd[i];
      nSeg++;
    }
    if (nSeg > 0) for (let i = 0; i < sumPsd.length; i++) sumPsd[i] /= nSeg;

    const meanRelative = {};
    for (let b = 0; b < F.BANDS.length; b++) {
      const k = F.BANDS[b].key;
      let s = 0;
      for (let c = 0; c < nCh; c++) s += perChannel[c].relative[k];
      meanRelative[k] = s / nCh;
    }
    let mAB = 0, mEnt = 0;
    for (let c = 0; c < nCh; c++) { mAB += perChannel[c].alphaBeta; mEnt += perChannel[c].entropy; }
    mAB /= nCh; mEnt /= nCh;

    const packed = F.buildVector(perChannel, mAB, mEnt, opts.featSet || 'all');

    return {
      fs: fs,
      perChannel: perChannel,
      meanRelative: meanRelative,
      meanAlphaBeta: mAB,
      meanEntropy: mEnt,
      psd: { freq: sumFreq, psd: sumPsd },
      vector: packed.vector,
      names: packed.names,
      dim: packed.vector.length
    };
  };

  /**
   * 组装分类器输入的特征向量。
   *  all   : 4 通道×5 相对功率 + 4 通道 α/β + 4 通道谱熵 = 28 维
   *  bands : 4 通道×5 相对功率 = 20 维
   *  ab    : 4 通道 α/β = 4 维（最稳，样本少时推荐）
   */
  F.buildVector = function (perChannel, meanAB, meanEnt, featSet) {
    const v = [], names = [];
    const ch = NS.CHANNELS;
    if (featSet === 'ab') {
      for (let c = 0; c < perChannel.length; c++) {
        v.push(perChannel[c].alphaBeta);
        names.push(ch[c] + ' α/β');
      }
      v.push(meanAB); names.push('平均 α/β');
      return { vector: v, names: names };
    }
    for (let c = 0; c < perChannel.length; c++) {
      for (let b = 0; b < F.BANDS.length; b++) {
        const k = F.BANDS[b].key;
        v.push(perChannel[c].relative[k]);
        names.push(ch[c] + ' ' + F.BANDS[b].symbol + ' rel');
      }
    }
    if (featSet === 'bands') return { vector: v, names: names };

    for (let c = 0; c < perChannel.length; c++) {
      v.push(perChannel[c].alphaBeta);
      names.push(ch[c] + ' α/β');
    }
    for (let c = 0; c < perChannel.length; c++) {
      v.push(perChannel[c].entropy);
      names.push(ch[c] + ' 谱熵');
    }
    v.push(meanEnt); names.push('平均谱熵');
    return { vector: v, names: names };
  };

  /** 供 UI 生成摘要文本 */
  F.summarize = function (feat) {
    const mr = feat.meanRelative;
    return 'δ' + (mr.delta * 100).toFixed(0) + '% θ' + (mr.theta * 100).toFixed(0) +
      '% α' + (mr.alpha * 100).toFixed(0) + '% β' + (mr.beta * 100).toFixed(0) +
      '% γ' + (mr.gamma * 100).toFixed(0) + '% | α/β=' + feat.meanAlphaBeta.toFixed(2) +
      ' | 熵=' + feat.meanEntropy.toFixed(2);
  };

})(window.EEG = window.EEG || {});
