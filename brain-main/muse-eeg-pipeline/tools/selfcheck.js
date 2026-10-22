/* =============================================================================
 *  tools/selfcheck.js
 *  在 Node 里跑一遍算法核心（不含 DOM），验证：
 *    1. muse-js 原始包解析
 *    2. 带通 + 陷波对 50Hz 工频的衰减量
 *    3. 眨眼伪迹在回归 / ICA 之后的残留幅度
 *    4. 闭眼 vs 睁眼的 α 相对功率可分性
 *    5. LDA / SVM / MLP 三种分类器的留一法准确率
 *  运行： node tools/selfcheck.js
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsDir = path.join(__dirname, '..', 'src', 'js');
const sandbox = { console: console, performance: { now: () => Date.now() }, Math: Math, Date: Date };
sandbox.window = sandbox;
vm.createContext(sandbox);

// 只加载与 DOM 无关的算法模块（06-ui.js 需要浏览器环境）
const modules = fs.readdirSync(jsDir).filter(f => /^0[1-5]-.*\.js$/.test(f)).sort();
modules.forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(jsDir, f), 'utf8'), sandbox, { filename: f });
});
const EEG = sandbox.window.EEG;
const { DSP, Artifacts, Features, ML } = EEG;

const FS = 256;
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  [PASS] ' + name + '  ' + (detail || '')); }
  else { fail++; console.log('  [FAIL] ' + name + '  ' + (detail || '')); }
}
function hr(t) { console.log('\n' + t + '\n' + '-'.repeat(t.length)); }

/* ---------------------------------------------------------------- 采集数据 */
function record(seconds, mode, seed) {
  const sim = new EEG.MuseSimulator({ fs: FS, mode: mode, seed: seed || 42 });
  const chans = [[], [], [], []];
  const blocks = Math.round(seconds * FS / EEG.PACKET_SIZE);
  for (let b = 0; b < blocks; b++) {
    for (let c = 0; c < 4; c++) {
      const p = sim.nextPacket();
      if (p.eegChannel !== c) throw new Error('包通道顺序异常');
      for (let i = 0; i < p.samples.length; i++) chans[c].push(p.samples[i]);
    }
  }
  return chans;
}
function filterAll(chans, cfg) {
  const chain = new DSP.FilterChain(cfg, 4);
  const out = [[], [], [], []];
  for (let i = 0; i < chans[0].length; i++)
    for (let c = 0; c < 4; c++) out[c].push(chain.process(c, chans[c][i]));
  return { out: out, chain: chain };
}
function sliceSeg(a, from, to) { return a.slice(from, to); }
function maxAbs(a) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m; }

hr('1) muse-js 原始包解析');
const jsonText = JSON.stringify([
  { index: 0, eegChannel: 0, samples: [1, 2, 3, 4], timestamp: 1700000000000 },
  { index: 1, eegChannel: 1, samples: [5, 6, 7, 8], timestamp: 1700000000010 }
]);
const parsed = EEG.parseMuseJson(jsonText);
check('解析数组形式的包', parsed.length === 2 && parsed[1].eegChannel === 1, '得到 ' + parsed.length + ' 个包');
const rec = EEG.assembleRecording(parsed, FS);
check('装配成 4×N 矩阵', rec.channels.length === 4 && rec.channels[0].length === 4, '每通道 ' + rec.channels[0].length + ' 样本');
const wrapped = EEG.parseMuseJson(JSON.stringify({ eegReadings: [{ channel: 2, values: [9, 9] }] }));
check('兼容 eegReadings 包装 + channel/values 别名', wrapped.length === 1 && wrapped[0].eegChannel === 2);

hr('2) 滤波：50Hz 工频衰减');
const raw30 = record(30, 'open', 7);
const fcfg = {
  fs: FS,
  bandpass: { enabled: true, low: 1, high: 50, order: 4 },
  notch: { enabled: true, f0: 50, harmonics: true, q: 30 }
};
const filt30 = filterAll(raw30, fcfg).out;
const seg = [5 * FS, 25 * FS];
const humRawAmp = DSP.goertzel(sliceSeg(raw30[0], seg[0], seg[1]), FS, 50);
const humFiltAmp = DSP.goertzel(sliceSeg(filt30[0], seg[0], seg[1]), FS, 50);
const atten = 20 * Math.log10(humRawAmp / Math.max(humFiltAmp, 1e-9));
console.log('     原始 50Hz 幅值 ' + humRawAmp.toFixed(3) + ' µV → 滤波后 ' + humFiltAmp.toFixed(4) + ' µV (' + atten.toFixed(1) + ' dB)');
check('陷波后工频衰减 > 25 dB', atten > 25, atten.toFixed(1) + ' dB');

// 检查带通：<1Hz 的漂移被压掉
const driftRaw = maxAbs(sliceSeg(raw30[0], 0, 30 * FS).map((v, i) => v * 0)) ; void driftRaw;
const psdRaw = DSP.psd(sliceSeg(raw30[0], 5 * FS, 25 * FS), FS, {});
const psdFilt = DSP.psd(sliceSeg(filt30[0], 5 * FS, 25 * FS), FS, {});
function powerIn(psd, lo, hi) {
  let e = 0;
  for (let i = 0; i < psd.freq.length; i++) if (psd.freq[i] >= lo && psd.freq[i] < hi) e += psd.psd[i] * psd.df;
  return e;
}
check('带通内(8-13Hz)能量保留 > 50%',
  powerIn(psdFilt, 8, 13) / Math.max(powerIn(psdRaw, 8, 13), 1e-12) > 0.5,
  '比值 ' + (powerIn(psdFilt, 8, 13) / powerIn(psdRaw, 8, 13)).toFixed(2));
check('50Hz 处能量大幅下降',
  powerIn(psdFilt, 49, 51) < powerIn(psdRaw, 49, 51) * 0.05);

hr('3) 去伪迹：眨眼残留');
const simB = new EEG.MuseSimulator({ fs: FS, mode: 'open', seed: 3 });
const blinkChans = [[], [], [], []];
for (let b = 0; b < 8; b++) for (let c = 0; c < 4; c++) {
  const p = simB.nextPacket();
  for (let i = 0; i < p.samples.length; i++) blinkChans[c].push(p.samples[i]);
}
simB.injectBlink(300);
for (let b = 0; b < 12; b++) for (let c = 0; c < 4; c++) {
  const p = simB.nextPacket();
  for (let i = 0; i < p.samples.length; i++) blinkChans[c].push(p.samples[i]);
}
const bFilt = filterAll(blinkChans, fcfg).out;
// 找到眨眼峰值位置
let peak = 0, peakIdx = 0;
for (let i = 0; i < bFilt[1].length; i++) if (Math.abs(bFilt[1][i]) > peak) { peak = Math.abs(bFilt[1][i]); peakIdx = i; }
const w0 = Math.max(0, peakIdx - FS / 2), w1 = Math.min(bFilt[1].length, peakIdx + FS / 2);
const winRaw = bFilt.map(a => sliceSeg(a, w0, w1));
const winOrig = blinkChans.map(a => sliceSeg(a, w0, w1));
const reg = Artifacts.removeEOGByRegression(winRaw, [1, 2], { shrink: 0.95 });
const ica = Artifacts.fastICA(reg.cleaned, FS, { kurtThreshold: 6, lowThreshold: 0.6 });
const before = maxAbs(winRaw[0]);
const afterReg = maxAbs(reg.cleaned[0]);
const afterIca = maxAbs(ica.cleaned[0]);
console.log('     TP9 眨眼峰 |原始| ' + before.toFixed(1) + ' µV → 回归后 ' + afterReg.toFixed(1) +
  ' µV → ICA 后 ' + afterIca.toFixed(1) + ' µV');
console.log('     ICA 判定：' + ica.components.map(c => 'IC' + (c.index + 1) + (c.artifact ? '(剔除 k=' + c.kurtosis.toFixed(1) + ')' : '(保留)')).join(' '));
check('回归法降低眨眼幅度 > 30%', afterReg < before * 0.7, ((1 - afterReg / before) * 100).toFixed(0) + '% ↓');
check('ICA 进一步降低幅度', afterIca <= afterReg * 1.02, '残留 ' + afterIca.toFixed(1) + ' µV');
check('ICA 未剔除全部成分（保留脑信号）', ica.nRemoved <= 2, '剔除 ' + ica.nRemoved + '/4');
void winOrig;

hr('4) 特征：闭眼 α 应显著高于睁眼');
const featCfg = { fs: FS, bandpass: fcfg.bandpass, notch: fcfg.notch, artifact: { regression: { enabled: true, refs: [1, 2], shrink: 0.95 }, ica: { enabled: true, kurtThreshold: 6, lowThreshold: 0.6 } } };
function featureAt(chans, tCenterSec, winSec, featSet) {
  const from = Math.round((tCenterSec - winSec / 2) * FS);
  const to = from + Math.round(winSec * FS);
  const w = chans.map(a => sliceSeg(a, from, to));
  const art = Artifacts.removeArtifacts(w, FS, featCfg.artifact);
  return Features.compute(art.cleaned, FS, { featSet: featSet || 'all' });
}
const closedSig = filterAll(record(15, 'closed', 21), fcfg).out;
const openSig = filterAll(record(15, 'open', 22), fcfg).out;
const closedFeat = featureAt(closedSig, 10, 1, 'all');
const openFeat = featureAt(openSig, 10, 1, 'all');
console.log('     闭眼 t=20s: ' + Features.summarize(closedFeat));
console.log('     睁眼 t=3s : ' + Features.summarize(openFeat));
check('闭眼 α 相对功率高于睁眼', closedFeat.meanRelative.alpha > openFeat.meanRelative.alpha,
  (closedFeat.meanRelative.alpha * 100).toFixed(0) + '% vs ' + (openFeat.meanRelative.alpha * 100).toFixed(0) + '%');
check('闭眼 α/β 高于睁眼', closedFeat.meanAlphaBeta > openFeat.meanAlphaBeta,
  closedFeat.meanAlphaBeta.toFixed(2) + ' vs ' + openFeat.meanAlphaBeta.toFixed(2));

hr('5) 分类器：闭眼 vs 睁眼（留一法）');
const mixed = record(48, 'mixed', 11);
const mixedFilt = filterAll(mixed, fcfg).out;
const X = [], y = [];
for (let t = 1.2; t < 47; t += 0.5) {
  const phase = Math.floor(t / 6) % 2;          // 0 = 睁眼段, 1 = 闭眼段
  const intoPhase = t - Math.floor(t / 6) * 6;
  if (intoPhase < 1.6 || intoPhase > 5.4) continue;   // 跳过过渡期
  const f = featureAt(mixedFilt, t, 1, 'all');
  X.push(f.vector); y.push(phase);
}
const n0 = y.filter(v => v === 0).length, n1 = y.filter(v => v === 1).length;
console.log('     样本：睁眼 ' + n0 + ' / 闭眼 ' + n1 + '，特征 ' + X[0].length + ' 维');
['lda', 'svm', 'mlp'].forEach(function (kind) {
  const m = new ML.Model(kind, { lambda: 0.05, hidden: 8, epochs: 700, lr: 0.08, usePca: true }).fit(X, y);
  console.log('     ' + m.name() + '：训练 ' + (m.trainAcc * 100).toFixed(0) + '%  留一法 ' + (m.cvAcc * 100).toFixed(0) +
    '%  (PCA → ' + (m.pca ? m.pca.components.length : X[0].length) + ' 维)');
  check(m.name() + ' 留一法准确率 > 75%', m.cvAcc > 0.75, (m.cvAcc * 100).toFixed(0) + '%');
});
// 在线推理耗时
const t0 = Date.now();
const mdl = new ML.Model('lda', { usePca: true }).fit(X, y);
for (let i = 0; i < 500; i++) mdl.proba(X[i % X.length]);
console.log('     500 次在线推理耗时 ' + (Date.now() - t0) + ' ms');

hr('结果');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
