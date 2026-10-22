/* =============================================================================
 *  05-classifier.js  —  ④ 分类
 *  三种从零实现的小模型（二分类：0 = 睁眼/基线，1 = 闭眼/目标状态）：
 *    · LDA        线性判别分析（闭式解 + 协方差正则，小样本首选）
 *    · LinearSVM  Pegasos 随机次梯度 + hinge loss + L2
 *    · MLP        1 隐藏层 tanh + sigmoid，全批量反向传播
 *  统一封装：z-score 标准化 → PCA 降维（防小样本过拟合）→ 分类器
 *  评估：训练准确率 + 留一法(LOO)交叉验证准确率
 * ========================================================================== */
(function (NS) {
  'use strict';
  const ML = NS.ML = {};

  /* ------------------------------------------------------------------ 标准化 */
  function Scaler() { this.mean = null; this.std = null; }
  Scaler.prototype.fit = function (X) {
    const n = X.length, d = X[0].length;
    this.mean = new Array(d).fill(0);
    this.std = new Array(d).fill(1);
    for (let j = 0; j < d; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X[i][j];
      s /= n;
      let v = 0;
      for (let i = 0; i < n; i++) { const dd = X[i][j] - s; v += dd * dd; }
      v /= Math.max(1, n - 1);
      this.mean[j] = s;
      this.std[j] = Math.sqrt(v) || 1;
    }
    return this;
  };
  Scaler.prototype.transform = function (x) {
    const out = new Array(x.length);
    for (let j = 0; j < x.length; j++) out[j] = (x[j] - this.mean[j]) / this.std[j];
    return out;
  };
  Scaler.prototype.transformAll = function (X) { return X.map(this.transform, this); };
  ML.Scaler = Scaler;

  /* ------------------------------------------------------------ PCA 降维 */
  /** 防止特征维度 >> 样本数时分类器直接退化。 */
  function PCA(maxComp, varRatio) {
    this.maxComp = maxComp || 8;
    this.varRatio = varRatio == null ? 0.95 : varRatio;
    this.components = null;
    this.explained = null;
  }
  PCA.prototype.fit = function (X) {
    const n = X.length, d = X[0].length;
    const C = [];
    for (let i = 0; i < d; i++) C.push(new Array(d).fill(0));
    for (let k = 0; k < n; k++) {
      const x = X[k];
      for (let i = 0; i < d; i++) for (let j = i; j < d; j++) C[i][j] += x[i] * x[j];
    }
    for (let i = 0; i < d; i++) for (let j = i; j < d; j++) { C[i][j] /= Math.max(1, n - 1); C[j][i] = C[i][j]; }

    const eig = NS.Artifacts.jacobiEigen(C, d);
    const order = eig.values.map(function (v, i) { return i; })
      .sort(function (a, b) { return eig.values[b] - eig.values[a]; });
    const totalVar = eig.values.reduce(function (a, b) { return a + Math.max(b, 0); }, 0) || 1;
    let acc = 0, k = 0;
    const kept = [];
    for (let i = 0; i < order.length; i++) {
      const oi = order[i];
      if (eig.values[oi] <= 1e-12) continue;
      acc += eig.values[oi];
      kept.push(oi);
      k++;
      if ((acc / totalVar >= this.varRatio && k >= 1) || k >= Math.min(this.maxComp, n - 1)) break;
    }
    if (kept.length === 0) kept.push(order[0]);
    this.components = kept.map(function (oi) {
      return eig.vectors.map(function (rowk) { return rowk[oi]; });   // 第 oi 个特征向量
    });
    this.explained = acc / totalVar;
    return this;
  };
  PCA.prototype.transform = function (x) {
    const comps = this.components;
    const out = new Array(comps.length);
    for (let i = 0; i < comps.length; i++) {
      let s = 0;
      const c = comps[i];
      for (let j = 0; j < x.length; j++) s += c[j] * x[j];
      out[i] = s;
    }
    return out;
  };
  PCA.prototype.transformAll = function (X) { return X.map(this.transform, this); };
  ML.PCA = PCA;

  /* ------------------------------------------------------------------ 工具 */
  function meanVec(X) {
    const d = X[0].length, m = new Array(d).fill(0);
    for (let i = 0; i < X.length; i++) for (let j = 0; j < d; j++) m[j] += X[i][j];
    for (let j = 0; j < d; j++) m[j] /= X.length;
    return m;
  }
  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }

  /* -------------------------------------------------------------------- LDA */
  function LDA(lambda) { this.lambda = lambda == null ? 0.05 : lambda; this.w = null; this.b = 0; this.scale = 1; }
  LDA.prototype.fit = function (X, y) {
    const n = X.length, d = X[0].length;
    const c0 = X.filter(function (_, i) { return y[i] === 0; });
    const c1 = X.filter(function (_, i) { return y[i] === 1; });
    if (!c0.length || !c1.length) throw new Error('LDA 需要两个类别都有样本');
    const m0 = meanVec(c0), m1 = meanVec(c1);

    // 池化协方差 Σ
    const S = [];
    for (let i = 0; i < d; i++) S.push(new Array(d).fill(0));
    const acc = function (set, m) {
      for (let k = 0; k < set.length; k++) {
        const x = set[k];
        for (let i = 0; i < d; i++) {
          const di = x[i] - m[i];
          for (let j = i; j < d; j++) {
            const v = di * (x[j] - m[j]);
            S[i][j] += v; S[j][i] += v;
          }
        }
      }
    };
    acc(c0, m0); acc(c1, m1);
    let tr = 0;
    for (let i = 0; i < d; i++) tr += S[i][i];
    const scale = tr / d || 1;
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) S[i][j] /= Math.max(1, n - 2);
    const Si = NS.Artifacts.inverse(S, d, this.lambda * scale + 1e-9);

    const diff = new Array(d);
    for (let i = 0; i < d; i++) diff[i] = m1[i] - m0[i];
    this.w = new Array(d).fill(0);
    for (let i = 0; i < d; i++) {
      let s = 0;
      for (let j = 0; j < d; j++) s += Si[i][j] * diff[j];
      this.w[i] = s;
    }
    const mid = new Array(d);
    for (let i = 0; i < d; i++) mid[i] = 0.5 * (m0[i] + m1[i]);
    this.b = -dot(this.w, mid) + Math.log((c1.length + 1) / (c0.length + 1));

    // 用于把决策函数值映射成可信概率
    const scores = X.map(function (x) { return dot(this.w, x) + this.b; }, this);
    const ms = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
    let vs = 0;
    scores.forEach(function (s) { const t = s - ms; vs += t * t; });
    this.scale = Math.sqrt(vs / scores.length) || 1;
    return this;
  };
  LDA.prototype.score = function (x) { return dot(this.w, x) + this.b; };
  LDA.prototype.predict = function (x) { return this.score(x) >= 0 ? 1 : 0; };
  LDA.prototype.proba = function (x) { return sigmoid(this.score(x) / this.scale); };
  ML.LDA = LDA;

  /* --------------------------------------------------------------- 线性 SVM */
  function LinearSVM(opts) {
    opts = opts || {};
    this.lambda = opts.lambda == null ? 0.01 : opts.lambda;
    this.epochs = opts.epochs || 120;
    this.w = null; this.b = 0; this.scale = 1;
  }
  LinearSVM.prototype.fit = function (X, y) {
    const n = X.length, d = X[0].length;
    const rng = NS.makeRng(99);
    const yn = y.map(function (v) { return v === 1 ? 1 : -1; });
    this.w = new Array(d).fill(0);
    this.b = 0;
    const idx = X.map(function (_, i) { return i; });
    for (let t = 1; t <= this.epochs; t++) {
      // 洗牌
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
      }
      for (let k = 0; k < n; k++) {
        const i = idx[k];
        const eta = 1 / (this.lambda * (t * n + k + 1));
        const margin = yn[i] * (dot(this.w, X[i]) + this.b);
        if (margin < 1) {
          for (let j = 0; j < d; j++) this.w[j] = (1 - eta * this.lambda) * this.w[j] + eta * yn[i] * X[i][j];
          this.b += eta * yn[i] * 1.0;
        } else {
          for (let j = 0; j < d; j++) this.w[j] = (1 - eta * this.lambda) * this.w[j];
        }
      }
    }
    const scores = X.map(function (x) { return dot(this.w, x) + this.b; }, this);
    const ms = scores.reduce(function (a, b2) { return a + b2; }, 0) / scores.length;
    let vs = 0;
    scores.forEach(function (s) { const q = s - ms; vs += q * q; });
    this.scale = Math.sqrt(vs / scores.length) || 1;
    return this;
  };
  LinearSVM.prototype.score = function (x) { return dot(this.w, x) + this.b; };
  LinearSVM.prototype.predict = function (x) { return this.score(x) >= 0 ? 1 : 0; };
  LinearSVM.prototype.proba = function (x) { return sigmoid(this.score(x) / this.scale); };
  ML.LinearSVM = LinearSVM;

  /* -------------------------------------------------------------------- MLP */
  function MLP(opts) {
    opts = opts || {};
    this.hidden = opts.hidden || 8;
    this.epochs = opts.epochs || 600;
    this.lr = opts.lr || 0.08;
    this.l2 = opts.l2 == null ? 1e-4 : opts.l2;
    this.seed = opts.seed || 7;
    this.W1 = null; this.b1 = null; this.W2 = null; this.b2 = 0;
  }
  MLP.prototype.fit = function (X, y) {
    const n = X.length, d = X[0].length, h = this.hidden;
    const rng = NS.makeRng(this.seed);
    const init = function (fanIn) { return (rng() * 2 - 1) * Math.sqrt(2 / fanIn); };

    this.W1 = [];
    for (let i = 0; i < h; i++) {
      const row = new Array(d);
      for (let j = 0; j < d; j++) row[j] = init(d);
      this.W1.push(row);
    }
    this.b1 = new Array(h).fill(0);
    this.W2 = new Array(h);
    for (let i = 0; i < h; i++) this.W2[i] = init(h);
    this.b2 = 0;

    for (let ep = 0; ep < this.epochs; ep++) {
      const gW1 = [], gb1 = new Array(h).fill(0), gW2 = new Array(h).fill(0);
      for (let i = 0; i < h; i++) gW1.push(new Array(d).fill(0));
      let gb2 = 0;

      for (let k = 0; k < n; k++) {
        const x = X[k], target = y[k];
        // 前向
        const a = new Array(h);
        for (let i = 0; i < h; i++) {
          let s = this.b1[i];
          const row = this.W1[i];
          for (let j = 0; j < d; j++) s += row[j] * x[j];
          a[i] = Math.tanh(s);
        }
        let z = this.b2;
        for (let i = 0; i < h; i++) z += this.W2[i] * a[i];
        const p = sigmoid(z);
        const dz = (p - target);                       // BCE + sigmoid 的梯度
        // 反向
        gb2 += dz;
        for (let i = 0; i < h; i++) {
          gW2[i] += dz * a[i];
          const da = dz * this.W2[i] * (1 - a[i] * a[i]);   // tanh'
          gb1[i] += da;
          const grow = gW1[i], row = this.W1[i];
          for (let j = 0; j < d; j++) grow[j] += da * x[j];
          void row;
        }
      }
      // 更新
      const lr = this.lr / (1 + ep * 0.002);
      for (let i = 0; i < h; i++) {
        for (let j = 0; j < d; j++) gW1[i][j] = gW1[i][j] / n + this.l2 * this.W1[i][j];
        gW2[i] = gW2[i] / n + this.l2 * this.W2[i];
      }
      gb2 /= n;
      for (let i = 0; i < h; i++) gb1[i] /= n;
      for (let i = 0; i < h; i++) {
        for (let j = 0; j < d; j++) this.W1[i][j] -= lr * gW1[i][j];
        this.W2[i] -= lr * gW2[i];
        this.b1[i] -= lr * gb1[i];
      }
      this.b2 -= lr * gb2;
    }
    return this;
  };
  MLP.prototype.proba = function (x) {
    const h = this.hidden, d = x.length;
    let z = this.b2;
    for (let i = 0; i < h; i++) {
      let s = this.b1[i];
      const row = this.W1[i];
      for (let j = 0; j < d; j++) s += row[j] * x[j];
      z += this.W2[i] * Math.tanh(s);
    }
    return sigmoid(z);
  };
  MLP.prototype.predict = function (x) { return this.proba(x) >= 0.5 ? 1 : 0; };
  MLP.prototype.score = function (x) { return Math.log(Math.max(this.proba(x), 1e-9) / Math.max(1 - this.proba(x), 1e-9)); };
  ML.MLP = MLP;

  /* -------------------------------------------------- 完整模型（含预处理链） */
  function makeBase(kind, opts) {
    opts = opts || {};
    if (kind === 'svm') return new LinearSVM(opts);
    if (kind === 'mlp') return new MLP(opts);
    return new LDA(opts.lambda);
  }

  function Model(kind, opts) {
    this.kind = kind;
    this.opts = opts || {};
    this.scaler = new Scaler();
    this.pca = null;
    this.model = null;
    this.trainAcc = 0;
    this.cvAcc = 0;
    this.n = 0;
  }
  Model.prototype.name = function () {
    return this.kind === 'svm' ? '线性 SVM' : (this.kind === 'mlp' ? 'MLP 神经网络' : 'LDA');
  };
  Model.prototype.fit = function (X, y) {
    const n = X.length;
    if (n < 4) throw new Error('样本太少（至少 4 个窗口）');
    this.n = n;
    this.scaler.fit(X);
    let Z = this.scaler.transformAll(X);

    // 维度高于样本量时必然过拟合，先降维
    const dim = Z[0].length;
    if (this.opts.usePca !== false && dim > Math.max(2, Math.floor(n / 3))) {
      this.pca = new PCA(Math.min(8, Math.max(2, Math.floor(n / 3))), 0.95).fit(Z);
      Z = this.pca.transformAll(Z);
    } else {
      this.pca = null;
    }
    this.model = makeBase(this.kind, this.opts).fit(Z, y);

    let ok = 0;
    for (let i = 0; i < n; i++) if (this.predictRawUsing(Z[i]) === y[i]) ok++;
    this.trainAcc = ok / n;
    this.cvAcc = this.crossValidate(Z, y);
    return this;
  };
  Model.prototype.predictRawUsing = function (z) { return this.model.predict(z); };
  Model.prototype.transform = function (x) {
    let z = this.scaler.transform(x);
    if (this.pca) z = this.pca.transform(z);
    return z;
  };
  Model.prototype.predict = function (x) { return this.model.predict(this.transform(x)); };
  Model.prototype.proba = function (x) { return this.model.proba(this.transform(x)); };
  /** 留一法交叉验证：样本少时最诚实的评估 */
  Model.prototype.crossValidate = function (Z, y) {
    const n = Z.length;
    const classes = [];
    y.forEach(function (v) { if (classes.indexOf(v) < 0) classes.push(v); });
    if (classes.length < 2) return 0;
    let ok = 0;
    for (let hold = 0; hold < n; hold++) {
      const Xtr = [], ytr = [];
      for (let i = 0; i < n; i++) if (i !== hold) { Xtr.push(Z[i]); ytr.push(y[i]); }
      try {
        const m = makeBase(this.kind, this.opts).fit(Xtr, ytr);
        if (m.predict(Z[hold]) === y[hold]) ok++;
      } catch (e) { /* 极少数情况下某类只剩一个点 */ }
    }
    return ok / n;
  };
  ML.Model = Model;

  /** 特征重要度（LDA/SVM 的权重大小排序，用于解释模型学到了什么） */
  ML.explain = function (model, names) {
    if (!model || !model.model || !model.model.w) return [];
    const w = model.model.w;
    const rows = w.map(function (v, i) {
      return { i: i, w: v, name: names && names[i] ? names[i] : ('f' + i) };
    });
    rows.sort(function (a, b) { return Math.abs(b.w) - Math.abs(a.w); });
    return rows.slice(0, 8);
  };

})(window.EEG = window.EEG || {});
