/* =============================================================================
 *  03-artifact.js  —  ③ 去伪迹
 *  两条互补的路线，都只依赖纯 JS：
 *    A. 回归法：眨眼/眼动会以近似线性方式泄漏到各通道，用额区 AF7/AF8 作为
 *       EOG 代理，对每个目标通道做最小二乘回归 y = β·ref，再从 y 中减去 β·ref。
 *       优点：快、可解释（能看到 β 系数）；缺点：无法分离与脑信号相关的成分。
 *    B. ICA（FastICA 不动点算法）：把 4 通道观测分解成统计独立的成分，
 *       再按「峰度高 / 低频占比高 / 与眼电强相关 / 高频占比高(肌电)」判为伪迹并置零，
 *       最后用最小二乘混合矩阵重构回通道空间。
 * ========================================================================== */
(function (NS) {
  'use strict';
  const A = NS.Artifacts = {};

  /* ------------------------------------------------------------------ 小工具 */
  A.mean = function (v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i];
    return s / (v.length || 1);
  };
  A.std = function (v) {
    const m = A.mean(v);
    let s = 0;
    for (let i = 0; i < v.length; i++) { const d = v[i] - m; s += d * d; }
    return Math.sqrt(s / (v.length || 1));
  };
  A.corr = function (x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;
    const mx = A.mean(x.slice(0, n)), my = A.mean(y.slice(0, n));
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      const a = x[i] - mx, b = y[i] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    const d = Math.sqrt(dx * dy);
    return d > 1e-12 ? num / d : 0;
  };
  /** Pearson 峰度（正态分布 ≈ 3，眨眼尖峰成分通常远大于 3） */
  A.kurtosis = function (v) {
    const n = v.length || 1;
    const m = A.mean(v);
    let m2 = 0, m4 = 0;
    for (let i = 0; i < n; i++) {
      const d = v[i] - m;
      m2 += d * d; m4 += d * d * d * d;
    }
    m2 /= n; m4 /= n;
    return m2 > 1e-12 ? m4 / (m2 * m2) : 3;
  };

  /** 对称矩阵 Jacobi 特征分解（通道数很少，足够快且数值稳定） */
  A.jacobiEigen = function (Ain, n) {
    const a = Ain.map(function (r) { return r.slice(); });
    const v = [];
    for (let i = 0; i < n; i++) {
      v.push(new Array(n).fill(0));
      v[i][i] = 1;
    }
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
      if (off < 1e-16) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          if (Math.abs(a[p][q]) < 1e-18) continue;
          const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
          const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p][k], aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = v[k][p], vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    return { values: a.map(function (r, i) { return r[i]; }), vectors: v };
  };

  /** 高斯-约当求逆（带对角正则，避免奇异） */
  A.inverse = function (M, n, lambda) {
    lambda = lambda || 0;
    const a = [];
    for (let i = 0; i < n; i++) {
      a.push(new Array(2 * n).fill(0));
      for (let j = 0; j < n; j++) a[i][j] = M[i][j] + (i === j ? lambda : 0);
      a[i][n + i] = 1;
    }
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
      if (Math.abs(a[piv][col]) < 1e-14) { a[col][col] += 1e-9; piv = col; }
      const tmp = a[col]; a[col] = a[piv]; a[piv] = tmp;
      const d = a[col][col];
      for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = a[r][col];
        if (f === 0) continue;
        for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) out.push(a[i].slice(n));
    return out;
  };

  /* ------------------------------------------------------- A. 回归法去眼电 */
  /**
   * @param chans 4×N 通道数据
   * @param refIdx 眼电代理通道（默认 AF7=1, AF8=2）
   * @returns {{cleaned:number[][], betas:number[], r2:number[]}}
   */
  A.removeEOGByRegression = function (chans, refIdx, opts) {
    opts = opts || {};
    const shrink = opts.shrink == null ? 0.95 : opts.shrink;
    refIdx = refIdx || [1, 2];
    const nCh = chans.length, n = chans[0].length;
    const cleaned = chans.map(function (c) { return c.slice(); });
    const betas = new Array(nCh).fill(0);
    const r2s = new Array(nCh).fill(0);

    // 以参考通道为中心构造设计矩阵 X = [ref1, ref2]
    const X = refIdx.map(function (r, k) {
      const m = A.mean(chans[r]);
      const col = new Array(n);
      for (let i = 0; i < n; i++) col[i] = chans[r][i] - m;
      void k;
      return col;
    });
    const p = X.length;
    const G = [];
    for (let i = 0; i < p; i++) {
      G.push(new Array(p).fill(0));
      for (let j = 0; j < p; j++) {
        let s = 0;
        for (let t = 0; t < n; t++) s += X[i][t] * X[j][t];
        G[i][j] = s / (n - 1);
      }
    }
    let tr = 0;
    for (let i = 0; i < p; i++) tr += G[i][i];
    const Gi = A.inverse(G, p, 1e-6 * Math.max(tr, 1e-9));

    for (let c = 0; c < nCh; c++) {
      if (refIdx.indexOf(c) >= 0) continue;         // 参考通道自身不动
      const my = A.mean(chans[c]);
      const y = new Array(n);
      for (let i = 0; i < n; i++) y[i] = chans[c][i] - my;
      // β = (XᵀX)⁻¹ Xᵀy
      const rhs = new Array(p).fill(0);
      for (let i = 0; i < p; i++) {
        let s = 0;
        for (let t = 0; t < n; t++) s += X[i][t] * y[t];
        rhs[i] = s / (n - 1);
      }
      const beta = new Array(p).fill(0);
      for (let i = 0; i < p; i++) {
        let s = 0;
        for (let j = 0; j < p; j++) s += Gi[i][j] * rhs[j];
        beta[i] = s;
      }
      // 预测并减除
      let ssRes = 0, ssTot = 0;
      for (let t = 0; t < n; t++) {
        let pred = 0;
        for (let i = 0; i < p; i++) pred += beta[i] * X[i][t];
        cleaned[c][t] = chans[c][t] - shrink * pred;
        ssRes += (y[t] - pred) * (y[t] - pred);
        ssTot += y[t] * y[t];
      }
      let bn = 0;
      for (let i = 0; i < p; i++) bn += beta[i] * beta[i];
      betas[c] = Math.sqrt(bn);                       // 泄漏系数的模长，便于展示
      r2s[c] = ssTot > 1e-12 ? 1 - ssRes / ssTot : 0; // 解释率
    }
    return { cleaned: cleaned, betas: betas, r2: r2s };
  };

  /* ------------------------------------------------ B. FastICA + 伪迹成分剔除 */
  /**
   * @param chans 4×N（建议先做带通/陷波）
   * @param fs 采样率
   * @param opts {kurtThreshold, lowThreshold, highThreshold, eogRef, maxIter}
   */
  A.fastICA = function (chans, fs, opts) {
    opts = opts || {};
    const kurtThreshold = opts.kurtThreshold == null ? 6 : opts.kurtThreshold;
    const lowThreshold = opts.lowThreshold == null ? 0.60 : opts.lowThreshold;
    const highThreshold = opts.highThreshold == null ? 0.55 : opts.highThreshold;
    const maxIter = opts.maxIter || 200;
    const nCh = chans.length, n = chans[0].length;

    // ---- 1. 中心化 ----
    const means = chans.map(A.mean);
    const X = chans.map(function (c, i) {
      const out = new Array(n);
      for (let t = 0; t < n; t++) out[t] = c[t] - means[i];
      return out;
    });

    // ---- 2. 白化：特征分解协方差，Z = D^(-1/2)Eᵀ·X，使 cov(Z)=I ----
    const C = [];
    for (let i = 0; i < nCh; i++) {
      C.push(new Array(nCh).fill(0));
      for (let j = 0; j < nCh; j++) {
        let s = 0;
        for (let t = 0; t < n; t++) s += X[i][t] * X[j][t];
        C[i][j] = s / Math.max(1, n - 1) + (i === j ? 1e-9 : 0);
      }
    }
    const eig = A.jacobiEigen(C, nCh);
    const vals = eig.values.slice(), vecs = eig.vectors;
    // 单调排列，方便展示"主成分能量占比"
    const order = vals.map(function (v, i) { return i; }).sort(function (a, b) { return vals[b] - vals[a]; });
    const K = [];
    for (let i = 0; i < nCh; i++) K.push(new Array(nCh).fill(0));
    order.forEach(function (oi, rank) {
      const lam = Math.max(vals[oi], 1e-12);
      const scale = 1 / Math.sqrt(lam);
      for (let k = 0; k < nCh; k++) K[rank][k] = vecs[k][oi] * scale;
    });
    const Z = [];
    for (let i = 0; i < nCh; i++) {
      const row = new Array(n).fill(0);
      for (let k = 0; k < nCh; k++) {
        const kk = K[i][k];
        if (kk === 0) continue;
        const xk = X[k];
        for (let t = 0; t < n; t++) row[t] += kk * xk[t];
      }
      Z.push(row);
    }

    // ---- 3. FastICA 不动点迭代（deflation，g = tanh）----
    const rng = NS.makeRng(12345);
    const W = [];
    for (let comp = 0; comp < nCh; comp++) {
      let w = new Array(nCh);
      for (let i = 0; i < nCh; i++) w[i] = rng() * 2 - 1;
      deflate(w, W);
      norm(w);
      for (let iter = 0; iter < maxIter; iter++) {
        const u = new Array(n);
        for (let t = 0; t < n; t++) {
          let s = 0;
          for (let c = 0; c < nCh; c++) s += w[c] * Z[c][t];
          u[t] = s;
        }
        let gPrimeMean = 0;
        const g = new Array(n);
        for (let t = 0; t < n; t++) {
          const th = Math.tanh(u[t]);
          g[t] = th;
          gPrimeMean += 1 - th * th;
        }
        gPrimeMean /= n;
        const wNew = new Array(nCh).fill(0);
        for (let c = 0; c < nCh; c++) {
          let s = 0;
          const zc = Z[c];
          for (let t = 0; t < n; t++) s += zc[t] * g[t];
          wNew[c] = s / n - gPrimeMean * w[c];
        }
        deflate(wNew, W);
        norm(wNew);
        let dot = 0;
        for (let c = 0; c < nCh; c++) dot += wNew[c] * w[c];
        w = wNew;
        if (Math.abs(Math.abs(dot) - 1) < 1e-7) break;
      }
      W.push(w);
    }

    // ---- 4. 成分与指标 ----
    const S = [];
    for (let i = 0; i < nCh; i++) {
      const row = new Array(n).fill(0);
      for (let c = 0; c < nCh; c++) {
        const wc = W[i][c];
        if (wc === 0) continue;
        const zc = Z[c];
        for (let t = 0; t < n; t++) row[t] += wc * zc[t];
      }
      S.push(row);
    }

    // 眼电代理：原始 AF7/AF8 之差与和
    const eog = new Array(n);
    const refA = chans[1], refB = chans[2];
    for (let t = 0; t < n; t++) eog[t] = 0.5 * (refA[t] + refB[t]);

    const info = [];
    for (let i = 0; i < nCh; i++) {
      const s = S[i];
      const kurt = A.kurtosis(s);
      const psd = NS.DSP.psd(s, fs, { nfft: Math.min(256, NS.DSP.nextPow2(n)), overlap: 0.5 });
      let lowE = 0, highE = 0, totE = 0;
      for (let k = 0; k < psd.freq.length; k++) {
        const f = psd.freq[k], p = psd.psd[k];
        if (f < 0.5 || f > 45) continue;
        totE += p;
        if (f < 5) lowE += p;
        if (f > 20) highE += p;
      }
      const lowRatio = totE > 1e-12 ? lowE / totE : 0;
      const highRatio = totE > 1e-12 ? highE / totE : 0;
      const eogCorr = A.corr(s, eog);
      let artifact = false, reason = '';
      if (kurt > kurtThreshold) { artifact = true; reason = '峰度 ' + kurt.toFixed(1) + '（眨眼尖峰）'; }
      else if (lowRatio > lowThreshold && Math.abs(eogCorr) > 0.35) { artifact = true; reason = '低频为主 + 眼电相关 r=' + eogCorr.toFixed(2); }
      else if (highRatio > highThreshold && kurt > 4) { artifact = true; reason = '高频占比 ' + (highRatio * 100).toFixed(0) + '%（肌电）'; }
      info.push({
        index: i, kurtosis: kurt, lowRatio: lowRatio, highRatio: highRatio,
        eogCorr: eogCorr, artifact: artifact, reason: reason
      });
    }

    // 安全阀：至少保留 2 个成分，避免把脑信号也一并抹掉
    const flagged = info.filter(function (d) { return d.artifact; });
    if (flagged.length > nCh - 2) {
      flagged.sort(function (a, b) { return b.kurtosis - a.kurtosis; });
      for (let i = nCh - 2; i < flagged.length; i++) {
        flagged[i].artifact = false;
        flagged[i].reason = '保留（安全阀：伪迹成分过多）';
      }
    }

    // ---- 5. 重构：A = X·Sᵀ(SSᵀ)⁻¹（最小二乘混合矩阵），X̂ = A·S_masked ----
    const Ahat = [];
    for (let i = 0; i < nCh; i++) Ahat.push(new Array(nCh).fill(0));
    const XST = [];
    for (let i = 0; i < nCh; i++) {
      XST.push(new Array(nCh).fill(0));
      for (let j = 0; j < nCh; j++) {
        let s = 0;
        const xi = X[i], sj = S[j];
        for (let t = 0; t < n; t++) s += xi[t] * sj[t];
        XST[i][j] = s / n;
      }
    }
    const SST = [];
    for (let i = 0; i < nCh; i++) {
      SST.push(new Array(nCh).fill(0));
      for (let j = 0; j < nCh; j++) {
        let s = 0;
        const si = S[i], sj = S[j];
        for (let t = 0; t < n; t++) s += si[t] * sj[t];
        SST[i][j] = s / n;
      }
    }
    const SSTi = A.inverse(SST, nCh, 1e-9);
    for (let i = 0; i < nCh; i++) {
      for (let j = 0; j < nCh; j++) {
        let s = 0;
        for (let k = 0; k < nCh; k++) s += XST[i][k] * SSTi[k][j];
        Ahat[i][j] = s;
      }
    }
    const cleaned = [];
    for (let c = 0; c < nCh; c++) {
      const out = new Array(n);
      for (let t = 0; t < n; t++) out[t] = means[c];
      for (let j = 0; j < nCh; j++) {
        if (info[j].artifact) continue;                 // 伪迹成分不参与重建
        const ac = Ahat[c][j];
        if (ac === 0) continue;
        const sj = S[j];
        for (let t = 0; t < n; t++) out[t] += ac * sj[t];
      }
      cleaned.push(out);
    }

    return { cleaned: cleaned, components: info, nRemoved: info.filter(function (d) { return d.artifact; }).length };
  };

  function deflate(w, W) {
    for (let i = 0; i < W.length; i++) {
      let dot = 0;
      for (let c = 0; c < w.length; c++) dot += w[c] * W[i][c];
      for (let c = 0; c < w.length; c++) w[c] -= dot * W[i][c];
    }
  }
  function norm(w) {
    let s = 0;
    for (let i = 0; i < w.length; i++) s += w[i] * w[i];
    s = Math.sqrt(s) || 1;
    for (let i = 0; i < w.length; i++) w[i] /= s;
  }

  /* --------------------------------------------------- 组合：完整去伪迹一步 */
  /**
   * @returns {{cleaned:number[][], report:{regression:Object|null, ica:Object|null}}}
   */
  A.removeArtifacts = function (chans, fs, opts) {
    opts = opts || {};
    let cur = chans;
    let reg = null, ica = null;
    if (opts.regression && opts.regression.enabled) {
      reg = A.removeEOGByRegression(cur, opts.regression.refs, opts.regression);
      cur = reg.cleaned;
    }
    if (opts.ica && opts.ica.enabled) {
      ica = A.fastICA(cur, fs, opts.ica);
      cur = ica.cleaned;
    }
    return { cleaned: cur, report: { regression: reg, ica: ica } };
  };

})(window.EEG = window.EEG || {});
