/* =============================================================================
 *  06-ui.js  —  流水线编排 + 可视化 + 交互
 *  数据流：
 *     MuseSimulator / 粘贴的汝 muse-js 包
 *        └─(逐样点)─> FilterChain 带通+陷波 ─> 显示缓冲
 *        └─(每滑一个 step)─> 去伪迹(回归→ICA) ─> 特征 ─> 分类 ─> 反馈(+HTTP)
 * ========================================================================== */
(function (NS) {
  'use strict';
  const $ = function (id) { return document.getElementById(id); };
  const DSP = NS.DSP, Art = NS.Artifacts, Feat = NS.Features, ML = NS.ML;
  const CH = NS.CHANNELS;
  const C = {
    raw: '#54637f', filt: '#4cc9f0', clean: '#22d3a6', blink: 'rgba(255,93,115,.55)',
    grid: '#182339', axis: '#4d6188', text: '#8ba0c2', accent: '#7b61ff'
  };
  const DISPLAY_SECONDS = 4;          // 时域波形显示窗口
  const CALIB_SEC = 4;                // 每个校准类别的采集时长（秒）
  const BAND_COLORS = ['#3a6ea5', '#4a8fc7', '#22d3a6', '#ffb020', '#ff6bd6'];

  /* ================================================================= 全局状态 */
  const S = {
    fs: NS.SAMPLE_RATE,
    running: false,
    speed: 4,
    sim: null,
    chain: null,
    sampleCount: 0,
    lastAnalyzed: -1,
    windows: 0,
    winTimes: [],
    costMs: 0,
    buf: { raw: [[], [], [], []], filt: [[], [], [], []], clean: [[], [], [], []] },
    rawWin: [[], [], [], []],
    filtWin: [[], [], [], []],
    last: null,
    model: null,
    calibMode: null,            // null | 'open' | 'closed'
    calibEndSample: 0,
    calibOpen: [],              // 睁眼(基类 0)的特征向量
    calibClosed: [],            // 闭眼(类 1)的特征向量
    feedback: { sent: 0, lastAt: 0, warned: false },
    logs: [],
    logDirty: true
  };

  NS.App = { state: S };

  /* ==================================================================== 工具 */
  function num(id, dflt) {
    const el = $(id);
    if (!el) return dflt;
    const v = parseFloat(el.value);
    return isFinite(v) ? v : dflt;
  }
  function fmt(v, d) { return (v == null || !isFinite(v)) ? '—' : v.toFixed(d == null ? 2 : d); }
  function nowStamp() {
    const d = new Date();
    return d.toTimeString().slice(3, 8);
  }

  function readConfig() {
    return {
      fs: S.fs,
      bandpass: {
        enabled: $('bpOn').checked,
        low: Math.max(0.1, num('bpLow', 1)),
        high: Math.max(1, num('bpHigh', 50)),
        order: parseInt($('bpOrder').value, 10) || 4
      },
      notch: {
        enabled: $('notchOn').checked,
        f0: parseFloat($('notchF').value) || 50,
        harmonics: $('notchH').checked,
        q: num('notchQ', 30)
      },
      artifact: {
        regression: {
          enabled: $('regOn').checked,
          refs: [1, 2],
          shrink: 0.95
        },
        ica: {
          enabled: $('icaOn').checked,
          kurtThreshold: num('kurtT', 6),
          lowThreshold: num('lowT', 0.6)
        }
      },
      window: {
        sec: parseFloat($('winSec').value) || 1,
        overlap: num('overlap', 50) / 100,
        nfft: parseInt($('fftN').value, 10) || 0,
        featSet: $('featSet').value
      },
      clf: {
        kind: $('clfType').value,
        usePca: true
      }
    };
  }
  S.cfg = null;

  function applyConfig(rebuildFilter) {
    S.cfg = readConfig();
    if (rebuildFilter) {
      const wasRunning = S.running;
      S.chain = new DSP.FilterChain(S.cfg, 4);
      if (wasRunning) S.chain.reset();
      log('已重建滤波器：' + (S.chain.describe().join(' → ') || '（直通）'), 'hl');
    }
    updateFlowHighlight();
  }

  function updateFlowHighlight() {
    const cfg = S.cfg;
    const set = function (k, on) {
      const el = document.querySelector('.flow .step[data-k="' + k + '"]');
      if (el) el.classList.toggle('on', !!on);
    };
    set('filt', cfg.bandpass.enabled || cfg.notch.enabled);
    set('art', cfg.artifact.regression.enabled || cfg.artifact.ica.enabled);
    set('feat', true);
    set('cls', !!S.model);
    set('fb', true);
  }

  function log(text, cls) {
    S.logs.push({ t: nowStamp(), text: text, cls: cls || '' });
    if (S.logs.length > 500) S.logs.splice(0, 200);
    S.logDirty = true;
  }

  function flushLog() {
    if (!S.logDirty) return;
    S.logDirty = false;
    const box = $('log');
    const shown = S.logs.slice(-160);
    const html = shown.map(function (l) {
      return '<div><span class="t">' + l.t + '</span> <span class="' + l.cls + '">' + l.text + '</span></div>';
    }).join('');
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }

  /* ============================================================== 数据推入 */
  function winSamples() { return Math.max(32, Math.round(S.cfg.window.sec * S.fs)); }
  function stepSamples() {
    const w = winSamples();
    return Math.max(1, Math.round(w * (1 - S.cfg.window.overlap)));
  }
  function displayLen() { return Math.round(DISPLAY_SECONDS * S.fs); }

  function pushToBuffers(c, x, y) {
    const len = displayLen();
    const br = S.buf.raw[c], bf = S.buf.filt[c], bc = S.buf.clean[c];
    br.push(x); bf.push(y); bc.push(y);          // 去伪迹结果稍后覆盖写入
    if (br.length > len) br.splice(0, br.length - len);
    if (bf.length > len) bf.splice(0, bf.length - len);
    if (bc.length > len) bc.splice(0, bc.length - len);

    const rw = S.rawWin[c], fw = S.filtWin[c];
    rw.push(x); fw.push(y);
    const cap = winSamples() * 2 + 64;
    if (rw.length > cap) rw.splice(0, rw.length - cap);
    if (fw.length > cap) fw.splice(0, fw.length - cap);
  }

  function writeBackClean(clean) {
    const win = clean[0].length;
    for (let c = 0; c < 4; c++) {
      const buf = S.buf.clean[c];
      const start = Math.max(0, buf.length - win);
      const n = Math.min(win, buf.length);
      for (let i = 0; i < n; i++) buf[start + i] = clean[c][i];
    }
  }

  /** 推入一个 muse-js 风格的块（4 通道 × 12 样本，时间对齐） */
  function pushBlock() {
    const packets = [];
    for (let c = 0; c < 4; c++) packets.push(S.sim.nextPacket());
    const n = NS.PACKET_SIZE;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        const x = packets[c].samples[i];
        const y = S.chain ? S.chain.process(c, x) : x;
        pushToBuffers(c, x, y);
      }
      S.sampleCount++;
      maybeAnalyze();
    }
  }

  /* ============================================ 外部数据接入（真实 Muse 设备） */
  // muse-js 的 eegReadings 是逐电极下发的，这里攒齐 4 个电极后按样本对齐推入流水线。
  let pendingPkt = {};
  /**
   * 喂入一个 muse-js 风格的包：{ eegChannel|electrode, samples }。
   * 攒齐 TP9/AF7/AF8/TP10 后自动推进流水线；渲染由动画帧接管，无需手动刷新。
   * @returns {number} 本次实际推入的样本数（尚未攒齐时为 0）
   */
  function feedPacket(pkt) {
    if (!pkt) return 0;
    const c = (pkt.eegChannel != null) ? pkt.eegChannel
      : (pkt.channel != null) ? pkt.channel : pkt.electrode;
    if (c == null || c < 0 || c > 3) return 0;
    const s = pkt.samples || pkt.values || pkt.data;
    if (!s || !s.length) return 0;
    pendingPkt[c] = s;
    for (let k = 0; k < 4; k++) if (!pendingPkt[k]) return 0;

    let n = Infinity;
    for (let k = 0; k < 4; k++) n = Math.min(n, pendingPkt[k].length);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) {
        const x = pendingPkt[k][i];
        const y = S.chain ? S.chain.process(k, x) : x;
        pushToBuffers(k, x, y);
      }
      S.sampleCount++;
      maybeAnalyze();
    }
    pendingPkt = {};
    return n;
  }
  function feedPackets(list) {
    let total = 0;
    for (let i = 0; i < (list || []).length; i++) total += feedPacket(list[i]);
    return total;
  }

  function maybeAnalyze() {
    const w = winSamples();
    if (S.sampleCount < w) return;
    if (S.sampleCount - S.lastAnalyzed < stepSamples()) return;
    S.lastAnalyzed = S.sampleCount;

    const raw = S.rawWin.map(function (a) { return a.slice(-w); });
    const filt = S.filtWin.map(function (a) { return a.slice(-w); });
    const t0 = performance.now();
    const res = analyzeWindow(raw, filt);
    S.costMs = performance.now() - t0;

    writeBackClean(res.art.cleaned);
    S.last = res;
    S.windows++;
    S.winTimes.push(performance.now());
    if (S.winTimes.length > 30) S.winTimes.shift();
    handleCalibration(res);
    reportWindow(res);
  }

  /* ======================================================== 单窗口完整链路 */
  /**
   * ② 滤波已在流式阶段完成 → ③ 去伪迹 → ④ 特征 → ⑤ 分类
   * @param rawWin  原始窗口（仅用于对比展示与频带对照）
   * @param filtWin 带通+陷波后的窗口
   */
  function analyzeWindow(rawWin, filtWin) {
    const cfg = S.cfg;

    // ---- ③ 去伪迹 ----
    const art = Art.removeArtifacts(filtWin, S.fs, cfg.artifact);

    // ---- ④ 特征 ----
    const feat = Feat.compute(art.cleaned, S.fs, {
      nfft: cfg.window.nfft,
      overlap: 0.5,
      featSet: cfg.window.featSet
    });

    // 原始（未滤波）通道 0 的谱，用于对比展示工频与伪迹
    const rawPsd = DSP.psd(rawWin[0], S.fs, { nfft: cfg.window.nfft || 0, overlap: 0.5 });
    // 工频残留量（用 Goertzel 单点测幅）
    const humRaw = DSP.goertzel(rawWin[0], S.fs, cfg.notch.f0);
    const humFilt = DSP.goertzel(filtWin[0], S.fs, cfg.notch.f0);

    // ---- ⑤ 分类 ----
    let pred = null;
    if (S.model) {
      try {
        const p1 = S.model.proba(feat.vector);
        const label = S.model.predict(feat.vector);
        pred = { label: label, p1: p1, conf: label === 1 ? p1 : 1 - p1 };
      } catch (e) {
        pred = null;
      }
    }

    return {
      raw: rawWin, filt: filtWin, art: art, feat: feat, pred: pred,
      rawPsd: rawPsd, humRaw: humRaw, humFilt: humFilt,
      costMs: S.costMs, sampleIndex: S.sampleCount, timeSec: S.sampleCount / S.fs
    };
  }

  function reportWindow(res) {
    const t = res.timeSec.toFixed(2);
    const parts = [];
    parts.push('#' + S.windows + ' t=' + t + 's');
    parts.push('工频 ' + fmt(res.humRaw, 2) + '→' + fmt(res.humFilt, 2) + 'µV');
    if (res.art.report.regression) {
      const b = res.art.report.regression.betas;
      parts.push('眼电回归 β[' + b.map(function (v) { return v.toFixed(2); }).join(',') + ']');
    }
    if (res.art.report.ica) {
      parts.push('ICA 剔除 ' + res.art.report.ica.nRemoved + '/4');
    }
    parts.push(Feat.summarize(res.feat));
    if (res.pred) {
      parts.push('→ ' + (res.pred.label === 1 ? '闭眼/α强' : '睁眼/基线') +
        ' (' + (res.pred.conf * 100).toFixed(0) + '%)');
    }
    parts.push('[' + res.costMs.toFixed(1) + 'ms]');
    log(parts.join(' | '), S.calibMode ? 'warn' : '');
    sendFeedback(res);
  }

  /* ================================================================ 波形绘制 */
  function fitCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(240, cv.clientWidth || 600);
    if (!cv.dataset.h) cv.dataset.h = cv.getAttribute('height') || 240;
    const cssH = parseInt(cv.dataset.h, 10);
    cv.style.height = cssH + 'px';
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx: ctx, w: cssW, h: cssH };
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const a = arr.slice().sort(function (x, y) { return x - y; });
    const i = Math.max(0, Math.min(a.length - 1, Math.round(p * (a.length - 1))));
    return a[i];
  }

  function drawWave() {
    const cv = $('cvWave');
    const g = fitCanvas(cv), ctx = g.ctx, W = g.w, H = g.h;
    const rows = 4, padTop = 6, rowH = (H - padTop * 2) / rows;
    const n = S.buf.filt[0].length || 1;

    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'middle';

    for (let c = 0; c < 4; c++) {
      const top = padTop + c * rowH;
      const cy = top + rowH / 2;
      // 行背景
      ctx.fillStyle = c % 2 ? 'rgba(255,255,255,.012)' : 'rgba(255,255,255,.028)';
      ctx.fillRect(0, top, W, rowH);
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();

      const raw = S.buf.raw[c], filt = S.buf.filt[c], clean = S.buf.clean[c];
      if (!filt.length) continue;
      // 幅度自适应：以原始信号的 p99 为准（保证眨眼这类大伪迹也框得住）
      const amp = Math.max(percentile(raw.map(Math.abs), 0.99), 12);
      const scale = (rowH / 2 - 6) / amp;

      const drawSeries = function (data, color, width, alpha) {
        if (!data.length) return;
        const start = W - (data.length / n) * W;
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
          const x = start + (i / n) * W;
          let v = data[i] * scale;
          if (v > rowH / 2 - 3) v = rowH / 2 - 3;
          if (v < -(rowH / 2 - 3)) v = -(rowH / 2 - 3);
          const y = cy - v;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.globalAlpha = alpha == null ? 1 : alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
        ctx.globalAlpha = 1;
      };

      drawSeries(raw, C.raw, 1.1, 0.95);
      drawSeries(clean, C.clean, 1.0, 0.9);
      drawSeries(filt, C.filt, 1.2, 0.95);

      // 眨眼标注：原始信号超阈值处画红条
      const thr = amp * 0.55;
      ctx.fillStyle = C.blink;
      const start = W - (raw.length / n) * W;
      for (let i = 0; i < raw.length; i++) {
        if (Math.abs(raw[i]) > thr) ctx.fillRect(start + (i / n) * W, top + 1, 1.5, rowH - 2);
      }

      // 通道名 + 量程
      ctx.fillStyle = '#c8d6ee';
      ctx.fillText(CH[c], 6, top + 11);
      ctx.fillStyle = C.text;
      ctx.fillText('±' + amp.toFixed(0) + 'µV', W - 62, top + 11);
    }
    // 时间轴
    ctx.fillStyle = C.text;
    ctx.fillText('最近 ' + DISPLAY_SECONDS + 's', 6, H - 6);
  }

  function toDb(x) { return 10 * Math.log10(Math.max(x, 1e-12)); }

  function drawPsd() {
    const cv = $('cvPsd');
    const g = fitCanvas(cv), ctx = g.ctx, W = g.w, H = g.h;
    const padL = 38, padB = 22, padT = 10, padR = 10;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const fMax = 60;

    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (let f = 0; f <= fMax; f += 10) {
      const x = padL + (f / fMax) * plotW;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.font = '10px Consolas, monospace';
      ctx.fillText(f + '', x - 5, H - 8);
    }
    for (let i = 0; i <= 4; i++) {
      const y = padT + (i / 4) * plotH;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    }

    if (!S.last) {
      ctx.fillStyle = C.text;
      ctx.fillText('等待数据…', padL + 8, padT + 14);
      return;
    }
    const raw = S.last.rawPsd, clean = S.last.feat.psd;
    const fmaxBin = function (psd) {
      let m = -Infinity;
      for (let i = 0; i < psd.freq.length; i++) {
        if (psd.freq[i] > fMax) break;
        m = Math.max(m, toDb(psd.psd[i]));
      }
      return m;
    };
    const hi = Math.max(fmaxBin(raw), fmaxBin(clean)) + 6;
    const lo = hi - 62;
    const yOf = function (db) { return padT + plotH * (1 - (db - lo) / (hi - lo)); };

    // 频带底色
    const bands = Feat.BANDS;
    for (let b = 0; b < bands.length; b++) {
      const x0 = padL + (bands[b].lo / fMax) * plotW;
      const x1 = padL + (Math.min(bands[b].hi, fMax) / fMax) * plotW;
      ctx.fillStyle = BAND_COLORS[b] + '18';
      ctx.fillRect(x0, padT, x1 - x0, plotH);
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.font = '10px sans-serif';
      ctx.fillText(bands[b].symbol, (x0 + x1) / 2 - 3, padT + 10);
    }
    // 工频标线
    const f0 = S.cfg.notch.f0;
    [f0, f0 * 2].forEach(function (f) {
      if (f > fMax) return;
      const x = padL + (f / fMax) * plotW;
      ctx.strokeStyle = 'rgba(255,93,115,.45)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
    });

    const plot = function (psd, color, width, alpha) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < psd.freq.length; i++) {
        const f = psd.freq[i];
        if (f > fMax) break;
        const x = padL + (f / fMax) * plotW;
        const y = yOf(toDb(psd.psd[i]));
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
      ctx.globalAlpha = 1;
    };
    plot(raw, C.raw, 1.2, 0.9);
    plot(clean, C.filt, 1.6, 0.95);

    ctx.fillStyle = C.text;
    ctx.font = '10px Consolas, monospace';
    ctx.fillText(hi.toFixed(0) + ' dB', 4, padT + 8);
    ctx.fillText(lo.toFixed(0) + ' dB', 4, padT + plotH);
  }

  function drawBands() {
    const cv = $('cvBands');
    const g = fitCanvas(cv), ctx = g.ctx, W = g.w, H = g.h;
    const padL = 30, padB = 26, padT = 12, padR = 8;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const bands = Feat.BANDS;

    ctx.strokeStyle = C.grid;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (i / 4) * plotH;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    }
    ctx.font = '10px Consolas, monospace';
    ctx.fillStyle = C.text;

    const feat = S.last ? S.last.feat : null;
    // 用绝对功率（µV²）画柱，跨通道统一量程
    let maxV = 1e-6;
    if (feat) {
      for (let c = 0; c < 4; c++)
        for (let b = 0; b < bands.length; b++)
          maxV = Math.max(maxV, feat.perChannel[c].band[bands[b].key]);
    }
    maxV *= 1.15;

    const groupW = plotW / 4;
    for (let c = 0; c < 4; c++) {
      const gx = padL + c * groupW;
      const bw = Math.min(13, (groupW - 12) / bands.length);
      for (let b = 0; b < bands.length; b++) {
        const v = feat ? feat.perChannel[c].band[bands[b].key] : 0;
        const h = (v / maxV) * plotH;
        const x = gx + 6 + b * (bw + 2);
        ctx.fillStyle = BAND_COLORS[b];
        ctx.globalAlpha = 0.9;
        ctx.fillRect(x, padT + plotH - h, bw, Math.max(h, 0.5));
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = '#c8d6ee';
      ctx.font = '10px Consolas, monospace';
      ctx.fillText(CH[c], gx + groupW / 2 - 10, H - 12);
    }
    ctx.fillStyle = C.text;
    ctx.fillText(maxV.toFixed(1) + ' µV²', 2, padT + 8);
    // 图例
    let lx = padL + plotW - 150;
    for (let b = 0; b < bands.length; b++) {
      ctx.fillStyle = BAND_COLORS[b];
      ctx.fillRect(lx, padT - 8, 8, 8);
      ctx.fillStyle = C.text;
      ctx.font = '10px sans-serif';
      ctx.fillText(bands[b].symbol, lx + 11, padT - 1);
      lx += 28;
    }
  }

  /* ============================================================ DOM 状态更新 */
  function updateVerdict() {
    const el = $('verdict'), sub = $('verdictSub');
    if (!S.model) {
      el.textContent = '—'; el.className = 'big neutral';
      sub.textContent = '先点左侧「校准」按钮训练模型';
      $('confBar').style.width = '0%';
      $('confV').textContent = '0%';
      $('clfTag').textContent = '未训练';
    } else {
      $('clfTag').textContent = S.model.name() + ' 已就绪';
    }
    const res = S.last;
    if (res && res.pred && S.model) {
      const isClosed = res.pred.label === 1;
      el.textContent = isClosed ? '闭眼 / α 增强' : '睁眼 / 基线';
      el.className = 'big' + (isClosed ? '' : ' neutral');
      sub.textContent = '窗口 ' + res.timeSec.toFixed(1) + 's · ' +
        (isClosed ? '检测到 α 节律占优' : 'α 波受抑制') +
        ' · 模型 ' + S.model.name();
      const pc = Math.round(res.pred.conf * 100);
      $('confBar').style.width = pc + '%';
      $('confV').textContent = pc + '%';
    }
    const ab = S.last ? S.last.feat.meanAlphaBeta : 0;
    $('abV').textContent = fmt(ab, 2);
    $('abBar').style.width = Math.max(0, Math.min(100, ab * 25)) + '%';

    if (S.model) {
      $('kvModel').textContent = S.model.name() + (S.model.pca ? ' (PCA→' + S.model.pca.components.length + '维)' : '');
      $('kvTrain').textContent = (S.model.trainAcc * 100).toFixed(0) + '% / LOO ' + (S.model.cvAcc * 100).toFixed(0) + '%';
      $('kvN').textContent = S.model.n + ' 个窗口';
    }
    $('kvFb').textContent = S.feedback.sent + ' 帧';
    $('calibCount').textContent = '睁眼 ' + S.calibOpen.length + ' / 闭眼 ' + S.calibClosed.length;
  }

  function updateIcaTable() {
    const body = $('icaBody');
    const res = S.last;
    if (!res || !S.cfg.artifact.ica.enabled || !res.art.report.ica) {
      body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#5d7098">' +
        (S.cfg.artifact.ica.enabled ? '等待窗口…' : 'ICA 已关闭') + '</td></tr>';
      return;
    }
    const comps = res.art.report.ica.components;
    body.innerHTML = comps.map(function (c) {
      return '<tr class="' + (c.artifact ? 'rej' : '') + '">' +
        '<td>IC' + (c.index + 1) + '</td>' +
        '<td>' + c.kurtosis.toFixed(2) + '</td>' +
        '<td>' + (c.lowRatio * 100).toFixed(0) + '%</td>' +
        '<td>' + c.eogCorr.toFixed(2) + '</td>' +
        '<td>' + (c.artifact ? '剔除' : '保留') + '</td>' +
        '</tr>';
    }).join('') + '<tr><td colspan="5" style="color:#8ba0c2;border:0;padding-top:6px">' +
      (res.art.report.ica.nRemoved ? '本窗口剔除 ' + res.art.report.ica.nRemoved + ' 个伪迹成分：' +
        comps.filter(function (c) { return c.artifact; }).map(function (c) { return c.reason; }).join('；')
        : '本窗口未检出伪迹成分') + '</td></tr>';
  }

  function updateTopStats() {
    $('stWin').textContent = S.windows;
    $('stSamp').textContent = S.sampleCount.toLocaleString();
    $('stMs').textContent = S.costMs.toFixed(1);
    let rate = 0;
    if (S.winTimes.length >= 2) {
      const span = (S.winTimes[S.winTimes.length - 1] - S.winTimes[0]) / 1000;
      if (span > 0.2) rate = (S.winTimes.length - 1) / span;
    }
    $('stRate').textContent = rate.toFixed(1);
  }

  function render() {
    drawWave();
    drawPsd();
    drawBands();
    updateVerdict();
    updateIcaTable();
    updateTopStats();
    flushLog();
  }

  /* ============================================================== 反馈输出 */
  function buildFeedback(res) {
    const mr = res.feat.meanRelative;
    return {
      ts: Date.now(),
      windowIndex: S.windows,
      t: Number(res.timeSec.toFixed(3)),
      label: res.pred ? res.pred.label : null,
      labelName: res.pred ? (res.pred.label === 1 ? 'closed-eyes' : 'open-eyes') : 'unlabeled',
      confidence: res.pred ? Number(res.pred.conf.toFixed(3)) : null,
      alphaBeta: Number(res.feat.meanAlphaBeta.toFixed(3)),
      bandPowerRelative: {
        delta: Number(mr.delta.toFixed(4)), theta: Number(mr.theta.toFixed(4)),
        alpha: Number(mr.alpha.toFixed(4)), beta: Number(mr.beta.toFixed(4)),
        gamma: Number(mr.gamma.toFixed(4))
      },
      spectralEntropy: Number(res.feat.meanEntropy.toFixed(3)),
      hum50: { raw: Number(res.humRaw.toFixed(3)), filtered: Number(res.humFilt.toFixed(3)) },
      artifactsRemoved: res.art.report.ica ? res.art.report.ica.nRemoved : 0,
      latencyMs: Number(res.costMs.toFixed(1))
    };
  }

  function sendFeedback(res) {
    if (!$('fbHttp').checked) return;
    const now = performance.now();
    if (now - S.feedback.lastAt < 400) return;       // 节流
    S.feedback.lastAt = now;
    const url = $('fbUrl').value;
    const event = buildFeedback(res);
    NS.App.lastFeedback = event;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    }).then(function () {
      S.feedback.sent++;
    }).catch(function () {
      // 端点不可达时只记一次日志，避免刷屏
      if (!S.feedback.warned) {
        S.feedback.warned = true;
        log('HTTP 反馈端点不可达（' + url + '），可继续本地演示', 'err');
      }
    });
  }

  /* ================================================================== 校准 */
  function startCalib(kind) {
    if (!S.running) startRun();
    S.calibMode = kind;
    S.calibEndSample = S.sampleCount + Math.round(CALIB_SEC * S.fs);   // 采集 CALIB_SEC 秒
    if (kind === 'auto') {
      // 一键校准：先睁眼 3s 再闭眼 3s
      S.sim.setMode('open');
      $('srcMode').value = 'open';
      S.calibMode = 'open';
      S.calibEndSample = S.sampleCount + Math.round(CALIB_SEC * S.fs);
      log('校准开始：请保持「睁眼放松」' + CALIB_SEC + ' 秒…', 'warn');
    } else {
      S.sim.setMode(kind);
      $('srcMode').value = kind;
      log('开始采集「' + (kind === 'closed' ? '闭眼' : '睁眼') + '」' + CALIB_SEC + ' 秒…', 'warn');
    }
  }

  function handleCalibration(res) {
    if (!S.calibMode) return;
    if (S.calibMode === 'open') S.calibOpen.push(res.feat.vector.slice());
    else if (S.calibMode === 'closed') S.calibClosed.push(res.feat.vector.slice());

    if (S.sampleCount >= S.calibEndSample) {
      const finished = S.calibMode;
      if (finished === 'open' && $('btnCalib').dataset.chain === '1') {
        // 一键校准的第二步
        S.calibMode = 'closed';
        S.sim.setMode('closed');
        $('srcMode').value = 'closed';
        S.calibEndSample = S.sampleCount + Math.round(CALIB_SEC * S.fs);
        log('睁眼采样完成（' + S.calibOpen.length + ' 个窗口）。现在请「闭眼放松」' + CALIB_SEC + ' 秒…', 'warn');
        return;
      }
      S.calibMode = null;
      $('btnCalib').dataset.chain = '';
      log((finished === 'closed' ? '闭眼' : '睁眼') + '采样完成：' + (finished === 'closed' ? S.calibClosed.length : S.calibOpen.length) + ' 个窗口', 'ok');
      tryTrain();
    }
  }

  function tryTrain() {
    const X = [], y = [];
    S.calibOpen.forEach(function (v) { X.push(v); y.push(0); });
    S.calibClosed.forEach(function (v) { X.push(v); y.push(1); });
    if (S.calibOpen.length < 2 || S.calibClosed.length < 2) {
      log('样本不足（每类至少 2 个窗口），请再采一次', 'err');
      return;
    }
    try {
      const model = new ML.Model(S.cfg.clf.kind, {
        lambda: 0.05, hidden: 8, epochs: 700, lr: 0.08, usePca: S.cfg.clf.usePca
      });
      model.fit(X, y);
      S.model = model;
      log('训练完成：' + model.name() +
        ' | 特征 ' + X[0].length + ' 维' + (model.pca ? ' → PCA ' + model.pca.components.length + ' 维' : '') +
        ' | 训练准确率 ' + (model.trainAcc * 100).toFixed(0) + '%' +
        ' | 留一法 ' + (model.cvAcc * 100).toFixed(0) + '%', 'ok');
      const ex = ML.explain(model, S.last ? S.last.feat.names : null);
      if (ex.length && !model.pca) {
        log('主要判别特征：' + ex.slice(0, 4).map(function (r) {
          return r.name + '(' + r.w.toFixed(2) + ')';
        }).join('、'), 'hl');
      }
      updateFlowHighlight();
    } catch (e) {
      log('训练失败：' + e.message, 'err');
    }
  }

  /* ================================================================ 运行控制 */
  let rafId = null;
  let lastFrame = 0;
  let sampleAcc = 0;

  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    if (!lastFrame) lastFrame = ts;
    const dt = Math.min(0.25, (ts - lastFrame) / 1000);
    lastFrame = ts;

    if (S.running) {
      sampleAcc += dt * S.fs * S.speed;
      let blocks = Math.floor(sampleAcc / NS.PACKET_SIZE);
      if (blocks > 24) {                       // 帧率兜底：单帧最多处理 24 个包
        blocks = 24;
        sampleAcc = 0;
      } else {
        sampleAcc -= blocks * NS.PACKET_SIZE;
      }
      for (let i = 0; i < blocks; i++) pushBlock();
    }
    render();
  }

  function startRun() {
    if (S.running) return;
    S.running = true;
    S.sim.setMode($('srcMode').value === 'json' ? 'mixed' : $('srcMode').value);
    $('btnRun').textContent = '⏸ 暂停';
    $('btnPause').disabled = true;
    log('开始采集（' + $('srcMode').value + '，' + S.speed + '× 加速）', 'ok');
  }
  function pauseRun() {
    S.running = false;
    $('btnRun').textContent = '▶ 开始采集';
    $('btnPause').disabled = true;
    $('btnStep').disabled = false;
    log('已暂停', 'warn');
  }

  function resetAll() {
    S.running = false;
    S.buf = { raw: [[], [], [], []], filt: [[], [], [], []] };
    S.buf.clean = [[], [], [], []];
    S.rawWin = [[], [], [], []];
    S.filtWin = [[], [], [], []];
    S.sampleCount = 0; S.lastAnalyzed = -1; S.windows = 0;
    S.winTimes = []; S.last = null; S.logs = []; S.costMs = 0;
    S.calibOpen = []; S.calibClosed = []; S.calibMode = null;
    S.sim = new NS.MuseSimulator({ fs: S.fs, mode: 'mixed', seed: 20261020 });
    S.chain = new DSP.FilterChain(S.cfg, 4);
    S.logDirty = true;
    $('btnRun').textContent = '▶ 开始采集';
    $('btnStep').disabled = true;
    log('状态已重置（滤波器状态、缓冲、校准样本全部清空）', 'hl');
  }

  /* ============================================================== JSON 回放 */
  function loadJsonMode() {
    const text = $('jsonBox').value.trim();
    if (!text) { log('请先粘贴 muse-js 的 eegReadings JSON', 'err'); return; }
    const packets = NS.parseMuseJson(text);
    if (!packets.length) { log('解析失败：没找到带 eegChannel/samples 的记录', 'err'); return; }
    const rec = NS.assembleRecording(packets, S.fs);
    log('解析到 ' + packets.length + ' 个包 → ' + rec.seconds.toFixed(2) + ' 秒 / 4 通道，开始离线处理', 'ok');
    if (rec.seconds < 0.3) { log('数据太短（<0.3s），无法形成分析窗口', 'err'); return; }

    // 离线批处理：滤波 → 分窗 → 去伪迹 → 特征 → 分类
    S.running = false;
    const chain = new DSP.FilterChain(S.cfg, 4);
    const n = rec.channels[0].length;
    S.buf = { raw: [[], [], [], []], filt: [[], [], [], []] };
    S.buf.clean = [[], [], [], []];
    S.rawWin = [[], [], [], []];
    S.filtWin = [[], [], [], []];
    S.sampleCount = 0; S.lastAnalyzed = -1; S.windows = 0; S.winTimes = [];

    const w = winSamples(), step = stepSamples();
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        const x = rec.channels[c][i];
        const y = chain.process(c, x);
        pushToBuffers(c, x, y);
      }
      S.sampleCount++;
      if (S.sampleCount >= w && S.sampleCount - S.lastAnalyzed >= step) {
        S.lastAnalyzed = S.sampleCount;
        const t0 = performance.now();
        const res = analyzeWindow(
          S.rawWin.map(function (a) { return a.slice(-w); }),
          S.filtWin.map(function (a) { return a.slice(-w); })
        );
        S.costMs = performance.now() - t0;
        writeBackClean(res.art.cleaned);
        S.last = res; S.windows++;
        reportWindow(res);
      }
    }
    log('离线处理完成，共 ' + S.windows + ' 个窗口', 'ok');
  }

  /* ================================================================ 事件绑定 */
  function bind() {
    $('speed').addEventListener('input', function () {
      S.speed = parseInt(this.value, 10);
      $('speedV').textContent = S.speed + '×';
    });
    ['notchQ'].forEach(function (id) {
      $(id).addEventListener('input', function () { $('notchQV').textContent = this.value; });
    });
    ['kurtT'].forEach(function (id) {
      $(id).addEventListener('input', function () { $('kurtTV').textContent = parseFloat(this.value).toFixed(1); });
    });
    ['lowT'].forEach(function (id) {
      $(id).addEventListener('input', function () { $('lowTV').textContent = parseFloat(this.value).toFixed(2); });
    });
    $('overlap').addEventListener('input', function () { $('overlapV').textContent = this.value + '%'; });

    // 会影响滤波器/窗口的控件：改动即重建
    ['bpOn', 'bpLow', 'bpHigh', 'bpOrder', 'notchOn', 'notchF', 'notchH', 'notchQ'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        applyConfig(true);
        S.rawWin = [[], [], [], []]; S.filtWin = [[], [], [], []];
      });
    });
    ['regOn', 'icaOn', 'kurtT', 'lowT', 'winSec', 'overlap', 'fftN', 'featSet', 'clfType', 'scaleOn'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        applyConfig(false);
        if (id === 'winSec' || id === 'overlap') { S.rawWin = [[], [], [], []]; S.filtWin = [[], [], [], []]; }
        if (id === 'clfType' && S.calibOpen.length >= 2 && S.calibClosed.length >= 2) tryTrain();
      });
    });

    $('srcMode').addEventListener('change', function () {
      const v = this.value;
      $('jsonBox').style.display = v === 'json' ? 'block' : 'none';
      if (v !== 'json' && S.sim) {
        S.sim.setMode(v);
        log('数据源切换为：' + v, 'hl');
      }
    });

    $('btnRun').addEventListener('click', function () {
      if (S.running) pauseRun();
      else if ($('srcMode').value === 'json') { loadJsonMode(); }
      else startRun();
    });
    $('btnPause').addEventListener('click', pauseRun);
    $('btnStep').addEventListener('click', function () {
      if ($('srcMode').value === 'json') { loadJsonMode(); return; }
      for (let i = 0; i < stepSamples() / NS.PACKET_SIZE + 1; i++) pushBlock();
      log('单步推进 ' + stepSamples() + ' 个样本', 'hl');
    });
    $('btnReset').addEventListener('click', resetAll);
    $('btnBlink').addEventListener('click', function () {
      if (!S.running) startRun();
      S.sim.injectBlink(260);
      log('注入一次眨眼伪迹（≈260µV，主要出现在 AF7/AF8）', 'warn');
    });
    $('btnHum').addEventListener('click', function () {
      if (!S.running) startRun();
      S.sim.injectHum(4);
      log('注入一波 50Hz 工频干扰（幅值 ×5）', 'warn');
    });
    $('btnCalib').addEventListener('click', function () {
      S.calibOpen = []; S.calibClosed = [];
      this.dataset.chain = '1';
      startCalib('auto');
    });
    $('btnCalibClosed').addEventListener('click', function () {
      S.calibClosed = [];
      $('btnCalib').dataset.chain = '';
      startCalib('closed');
    });
    $('btnCalibOpen').addEventListener('click', function () {
      S.calibOpen = [];
      $('btnCalib').dataset.chain = '';
      startCalib('open');
    });
  }

  /* ==================================================================== 启动 */
  // 对外接口：真实设备可直接调用（见 outputs/muse-eeg-pipeline.md 第 6 节）
  NS.feedPacket = feedPacket;
  NS.feedPackets = feedPackets;
  NS.isRunning = function () { return S.running; };

  function init() {
    S.cfg = readConfig();
    S.sim = new NS.MuseSimulator({ fs: S.fs, mode: 'mixed', seed: 20261020 });
    S.chain = new DSP.FilterChain(S.cfg, 4);
    $('speedV').textContent = S.speed + '×';
    bind();
    applyConfig(false);
    log('就绪。滤波器：' + S.chain.describe().join(' → '), 'hl');
    log('提示：点「开始采集」看实时波形；点「校准」训练分类器；点「注入眨眼 / 注入工频」观察去伪迹与滤波效果。', '');
    rafId = requestAnimationFrame(loop);
    NS.App.lastFeedback = null;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window.EEG = window.EEG || {});
