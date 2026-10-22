/* =============================================================================
 *  tools/smoke-ui.js
 *  用最小 DOM 桩在 Node 里真跑一遍 06-ui.js：init → 采集 → 分析窗口 →
 *  校准 → 训练 → 渲染，验证整页没有异常、且状态真的在推进。
 *  运行： node tools/smoke-ui.js
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'src', 'index.html');
const jsDir = path.join(root, 'src', 'js');

/* ------------------------------------------------- 从 index.html 抽默认值 */
const html = fs.readFileSync(htmlPath, 'utf8');
const defaults = {};
const tagRe = /<(input|select|textarea)\b([^>]*)>/g;
let m;
while ((m = tagRe.exec(html))) {
  const attrs = m[2];
  const id = /\bid="([^"]+)"/.exec(attrs);
  if (!id) continue;
  const conf = {};
  if (/\bchecked\b/.test(attrs) && !/\bchecked="false"/.test(attrs)) conf.checked = true;
  const val = /\bvalue="([^"]*)"/.exec(attrs);
  conf.value = val ? val[1] : '';
  if (m[1] === 'select') {
    // 取 selected 的 option，否则第一个
    const block = html.slice(m.index, html.indexOf('</select>', m.index));
    const sel = /<option([^>]*\bselected\b[^>]*)>([^<]*)<\/option>/.exec(block);
    const first = /<option([^>]*)>([^<]*)<\/option>/.exec(block);
    const pick = sel || first;
    if (pick) {
      const v = /\bvalue="([^"]*)"/.exec(pick[1]);
      conf.value = v ? v[1] : pick[2].trim();
    }
  }
  defaults[id[1]] = conf;
}

/* ------------------------------------------------------------- DOM 桩实现 */
let nowMs = 1000;
const rafQueue = [];
let rafSeq = 0;

const CTX = new Proxy({
  measureText: () => ({ width: 24 }),
  createLinearGradient: () => ({ addColorStop() {} }),
  canvas: null
}, {
  get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return function () {}; },
  set(t, k, v) { t[k] = v; return true; }
});

function makeClassList() {
  const set = new Set();
  return {
    add: c => set.add(c),
    remove: c => set.delete(c),
    contains: c => set.has(c),
    toggle(c, on) {
      if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); }
      else if (on) set.add(c); else set.delete(c);
    },
    _set: set
  };
}

function El(id, tag) {
  const el = {
    id: id || '', tagName: (tag || 'div').toUpperCase(),
    value: '', checked: false, disabled: false, className: '',
    textContent: '', innerHTML: '',
    style: {}, dataset: {}, children: [], _listeners: {},
    width: 900, height: 250, clientWidth: 900, clientHeight: 250,
    scrollTop: 0, scrollHeight: 400, files: [],
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener() {},
    getAttribute(n) { return n === 'height' ? String(el.height) : null; },
    setAttribute(n, v) { if (n === 'height') el.height = Number(v); },
    appendChild(c) { el.children.push(c); return c; },
    getContext() { return CTX; },
    getBoundingClientRect() { return { width: 900, height: el.height, top: 0, left: 0 }; },
    focus() {}, blur() {},
    dispatch(type, extra) {
      const ev = Object.assign({ type, target: el, preventDefault() {}, stopPropagation() {} }, extra || {});
      (el._listeners[type] || []).forEach(fn => fn.call(el, ev));
    }
  };
  el.classList = makeClassList();
  return el;
}

const els = {};
function getEl(id) {
  if (!els[id]) {
    const e = El(id);
    const d = defaults[id];
    if (d) { e.value = d.value; e.checked = !!d.checked; }
    els[id] = e;
  }
  return els[id];
}

const doc = {
  readyState: 'complete',
  body: El('body', 'body'),
  getElementById: getEl,
  querySelector(sel) {
    const m2 = /data-k="([^"]+)"/.exec(sel);
    return getEl('__sel_' + (m2 ? m2[1] : sel));
  },
  querySelectorAll() { return []; },
  createElement(t) { return El('', t); },
  addEventListener() {},
  removeEventListener() {}
};

const errors = [];
const sandbox = {
  document: doc,
  console: {
    log: (...a) => console.log('  [page]', ...a),
    warn: (...a) => errors.push('warn: ' + a.join(' ')),
    error: (...a) => errors.push('error: ' + a.join(' '))
  },
  performance: { now: () => nowMs },
  requestAnimationFrame(fn) { rafQueue.push(fn); return ++rafSeq; },
  cancelAnimationFrame() {},
  setTimeout: (fn) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  devicePixelRatio: 1,
  fetch: (url) => { sandbox.__fetches.push(url); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); },
  __fetches: []
};
sandbox.window = sandbox;

vm.createContext(sandbox);
const warnings = [];
sandbox.console.warn = (...a) => warnings.push(a.join(' '));
sandbox.console.error = (...a) => errors.push(a.join(' '));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  [PASS] ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  ' + detail : '')); }
}
function hr(t) { console.log('\n' + t + '\n' + '-'.repeat(t.length)); }

function loadModule(f) {
  vm.runInContext(fs.readFileSync(path.join(jsDir, f), 'utf8'), sandbox, { filename: f });
}

/* ============================================================== 1) 装配页面 */
hr('1) 加载 6 个模块并执行 init()');
['01-signal.js', '02-dsp.js', '03-artifact.js', '04-features.js',
  '05-classifier.js', '06-ui.js'].forEach(function (f, i) {
    try {
      loadModule(f);
      check('加载 ' + f, true);
    } catch (e) {
      check('加载 ' + f, false, e.message);
      throw e;
    }
    void i;
  });
check('init() 无异常', errors.length === 0, errors.join(' | '));
frames(1);   // 日志在首帧渲染时 flush 到 DOM
const logEl = getEl('log');
check('初始化日志已写入', /就绪/.test(logEl.innerHTML), '日志长度 ' + logEl.innerHTML.length);
check('滤波器链已描述', /Butterworth|带通|陷波/.test(logEl.innerHTML));

/* ============================================================== 2) 驱动帧 */
function frame(dtMs) {
  nowMs += dtMs;
  const q = rafQueue.slice();
  rafQueue.length = 0;
  q.forEach(function (fn) {
    try { fn(nowMs); } catch (e) { errors.push('rAF: ' + e.message + '\n' + e.stack); }
  });
}
function frames(n, dt) { for (let i = 0; i < n; i++) frame(dt || 16.7); }

hr('2) 静止渲染（未开始采集）');
frames(5);
check('静止渲染无异常', errors.length === 0, errors.join(' | '));
check('顶层统计已渲染', getEl('stSamp').textContent === '0' || getEl('stSamp').textContent === 0,
  'stSamp=' + getEl('stSamp').textContent);

hr('3) 开始采集 + 实时分析窗口');
getEl('btnRun').dispatch('click');
frames(6);
check('开始按钮切换为暂停文案', /暂停/.test(getEl('btnRun').textContent), getEl('btnRun').textContent);
frames(400);
const winCount = parseInt(getEl('stWin').textContent, 10);
const sampCount = parseInt(String(getEl('stSamp').textContent).replace(/,/g, ''), 10);
console.log('     已处理样本 ' + sampCount + '，分析窗口 ' + winCount + ' 个，链路耗时 ' +
  getEl('stMs').textContent + ' ms，速率 ' + getEl('stRate').textContent + ' win/s');
check('采集推进了样本', sampCount > 5000, sampCount + ' samples');
check('产生了分析窗口', winCount > 10, winCount + ' 窗口');
check('链路耗时在合理范围(<200ms)', parseFloat(getEl('stMs').textContent) < 200, getEl('stMs').textContent + ' ms');
check('ICA 表格被填充', /IC|成分/.test(getEl('icaBody').innerHTML) && !/等待窗口/.test(getEl('icaBody').innerHTML));
check('运行日志记录了窗口', /窗口|α|置信/.test(logEl.innerHTML));
check('分类卡有输出或提示', getEl('verdict').textContent !== '');
check('实时渲染无异常', errors.length === 0, errors.join(' | '));

/* ============================================================== 4) 注入伪迹 */
hr('4) 注入眨眼 / 工频');
getEl('btnBlink').dispatch('click');
frames(30);
getEl('btnHum').dispatch('click');
frames(30);
check('注入伪迹后仍无异常', errors.length === 0, errors.join(' | '));
check('眨眼注入已记录', /眨眼/.test(logEl.innerHTML));
check('工频注入已记录', /工频/.test(logEl.innerHTML));

/* ============================================================== 5) 校准训练 */
hr('5) 校准（自动采集闭眼/睁眼并训练）');
getEl('btnCalib').dispatch('click');
console.log('     校准进行中…（模拟 20 秒）');
frames(1400);
const kvModel = getEl('kvModel').textContent;
const kvTrain = getEl('kvTrain').textContent;
const kvN = getEl('kvN').textContent;
console.log('     模型 ' + kvModel + ' | 准确率 ' + kvTrain + ' | ' + kvN);
check('校准已开始', /校准|闭眼/.test(logEl.innerHTML));
check('分类器已训练', /LDA|SVM|MLP/.test(kvModel), kvModel);
check('报告了训练准确率', /\d+%/.test(kvTrain), kvTrain);
check('校准标签统计已更新', /睁眼\s*\d+\s*\/\s*闭眼\s*\d+/.test(getEl('calibCount').textContent), getEl('calibCount').textContent);
check('校准后无异常', errors.length === 0, errors.join(' | '));

hr('6) 模型切换后自动重训');
getEl('clfType').value = 'svm';
getEl('clfType').dispatch('change');
frames(5);
check('切到 SVM 后模型名更新', /SVM/.test(getEl('kvModel').textContent), getEl('kvModel').textContent);
getEl('clfType').value = 'mlp';
getEl('clfType').dispatch('change');
frames(5);
check('切到 MLP 后模型名更新', /MLP/.test(getEl('kvModel').textContent), getEl('kvModel').textContent);

hr('7) 关闭滤波 / 去伪迹的开关联动');
getEl('notchOn').checked = false;
getEl('notchOn').dispatch('change');
frames(40);
check('关闭陷波后仍稳定', errors.length === 0, errors.join(' | '));
getEl('icaOn').checked = false;
getEl('regOn').checked = false;
getEl('icaOn').dispatch('change');
frames(40);
check('关闭去伪迹后仍稳定', errors.length === 0, errors.join(' | '));
getEl('notchOn').checked = true; getEl('notchOn').dispatch('change');
getEl('icaOn').checked = true; getEl('icaOn').dispatch('change');
getEl('regOn').checked = true; getEl('regOn').dispatch('change');
frames(40);

hr('8) 特征集 / 窗口长度切换');
['ab', 'bands', 'all'].forEach(function (fs_) {
  getEl('featSet').value = fs_;
  getEl('featSet').dispatch('change');
  frames(30);
});
check('切换特征集无异常', errors.length === 0, errors.join(' | '));
getEl('winSec').value = '2';
getEl('winSec').dispatch('change');
frames(60);
check('切换窗口长度无异常', errors.length === 0, errors.join(' | '));

hr('9) HTTP 反馈回传');
getEl('fbHttp').checked = true;
frames(120);
console.log('     fetch 调用次数 ' + sandbox.__fetches.length + '，首个 URL ' + (sandbox.__fetches[0] || '—'));
check('开启后确实发出了 HTTP 反馈', sandbox.__fetches.length > 0, sandbox.__fetches.length + ' 次');
check('回传地址正确', String(sandbox.__fetches[0] || '').indexOf('/eeg') >= 0, sandbox.__fetches[0]);

hr('10) JSON 回放模式');
getEl('btnPause').dispatch('click');
const packets = [];
for (let i = 0; i < 800; i++) {
  for (let c = 0; c < 4; c++) {
    packets.push({ index: i * 4 + c, eegChannel: c, samples: [1 + c, 2 + c, 3 + c], timestamp: 1712345678901 + i * 12 });
  }
}
getEl('jsonBox').value = JSON.stringify(packets);
getEl('srcMode').value = 'json';
getEl('srcMode').dispatch('change');
getEl('btnRun').dispatch('click');
frames(5);
check('JSON 回放已解析', /解析到\s*3200/.test(logEl.innerHTML) || /离线处理完成/.test(logEl.innerHTML));
check('JSON 回放无异常', errors.length === 0, errors.join(' | '));

hr('11) 真实设备接入 NS.feedPacket（逐电极攒齐）');
getEl('srcMode').value = 'mixed';
getEl('srcMode').dispatch('change');
getEl('btnReset').dispatch('click');
frames(3);
const EEGRef = sandbox.window.EEG;
check('对外暴露 feedPacket / feedPackets', typeof EEGRef.feedPacket === 'function' && typeof EEGRef.feedPackets === 'function');
check('未攒齐 4 电极时返回 0', EEGRef.feedPacket({ electrode: 0, samples: [1, 2, 3] }) === 0);
let pushed = 0;
for (let i = 0; i < 600; i++) {
  for (let c = 0; c < 4; c++) {
    pushed += EEGRef.feedPacket({
      electrode: c,
      samples: [10 * Math.sin(i / 6) + c, 8 * Math.cos(i / 9), 3, 12],
      timestamp: 1712345678901 + i * 12
    });
  }
}
frames(10);
const fedSamp = parseInt(String(getEl('stSamp').textContent).replace(/,/g, ''), 10);
console.log('     feedPacket 推入 ' + pushed + ' 样本，页面统计 ' + fedSamp + '，分析窗口 ' + getEl('stWin').textContent);
check('逐电极喂入推进了样本', pushed === 2400, pushed + ' 样本');
check('页面统计同步', fedSamp === pushed, 'stSamp=' + fedSamp);
check('外部数据也触发了分析窗口', parseInt(getEl('stWin').textContent, 10) > 0, getEl('stWin').textContent + ' 窗口');
const batch = [];
for (let i = 0; i < 4; i++) batch.push({ eegChannel: i, samples: [1, 2, 3] });
check('feedPackets 批量喂入', EEGRef.feedPackets(batch) === 3, '返回样本数');
// 兼容 eegChannel 与 channel 别名
(function () {
  EEGRef.feedPacket({ channel: 0, values: [1, 2] });
  EEGRef.feedPacket({ channel: 1, values: [1, 2] });
  EEGRef.feedPacket({ channel: 2, values: [1, 2] });
  const r = EEGRef.feedPacket({ channel: 3, values: [1, 2] });
  check('兼容 channel/values 字段别名', r === 2, '返回 ' + r);
})();
check('外部接入无异常', errors.length === 0, errors.join(' | '));

hr('12) 重置');
getEl('btnReset').dispatch('click');
frames(10);
check('重置后样本归零', String(getEl('stSamp').textContent) === '0', 'stSamp=' + getEl('stSamp').textContent);
check('重置日志已写入', /已重置/.test(logEl.innerHTML));
check('重置后无异常', errors.length === 0, errors.join(' | '));

hr('结果');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (warnings.length) console.log('  页面警告 ' + warnings.length + ' 条');
if (errors.length) { console.log('  错误：'); errors.slice(0, 6).forEach(e => console.log('    ' + e)); }
process.exit(fail === 0 ? 0 : 1);
