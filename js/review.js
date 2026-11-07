/**
 * 2048 AI 复盘数据层 —— 纯函数，不碰 DOM、不读写存储。
 *
 * 浏览器里挂到 window.Game2048Review，Node 里通过 module.exports 导出。
 *
 * 一次每日挑战的复盘日志由控制器逐步追加：
 *   { version, date, moves: [{ d, v, g, b, s, t }], summary }
 *   d 玩家方向 / v 走子前的 16 格数值 / g 本次得分
 *   b AI 最佳方向 / s 最佳方向分 / t 玩家实际方向分
 *   b/t 为 null 表示这一步还没算完（异步评分），复盘时按「未评分」跳过。
 *
 * 所有「写」操作都返回新对象，入参永远不被修改 —— 控制器可以放心先算后存。
 * summarize / analyze 全部规则式生成，同一输入必然同一输出，便于测试。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Game2048Review = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 日志结构版本；不兼容时靠它识别 */
  var LOG_VERSION = 1;

  /** 单局最多保留多少步（超出的丢最旧，避免存档无限膨胀） */
  var MAX_MOVES = 240;

  /** 关键失误最多列几步 */
  var WORST_LIMIT = 5;

  /** 方向取值域，顺序与 ai.js 一致 */
  var DIRS = ['up', 'right', 'down', 'left'];

  var DIR_LABEL = { up: '上', right: '右', down: '下', left: '左' };

  /**
   * 迷你盘面的配色（与棋盘一致的经典 2048 色板）。
   * 值直接用于内联 style，所以键名统一用字符串；empty / obstacle / big 是哨兵。
   */
  var TILE_COLORS = {
    empty: { background: 'rgba(94, 76, 58, 0.09)', color: 'transparent' },
    obstacle: { background: '#6d5c4b', color: 'transparent' },
    big: { background: '#3c3a32', color: '#f9f6f2' },
    '2': { background: '#eee4da', color: '#776e65' },
    '4': { background: '#ede0c8', color: '#776e65' },
    '8': { background: '#f2b179', color: '#fdf9f2' },
    '16': { background: '#f59563', color: '#fdf9f2' },
    '32': { background: '#f67c5f', color: '#fdf9f2' },
    '64': { background: '#f65e3b', color: '#fdf9f2' },
    '128': { background: '#edcf72', color: '#fdf9f2' },
    '256': { background: '#edcc61', color: '#fdf9f2' },
    '512': { background: '#edc850', color: '#fdf9f2' },
    '1024': { background: '#edc53f', color: '#fdf9f2' },
    '2048': { background: '#edc22e', color: '#fdf9f2' }
  };

  /** 通用建议：优先级规则凑不满 3 条时按顺序补 */
  var FALLBACK_TIPS = [
    '每走一步先扫一眼空格：空格越少，越要先想好下一步。',
    '大块贴边：128 以上的块尽量沿同一条边排，减少来回挪动。',
    '不确定时点「提示」，对照 AI 的方向再决定。'
  ];

  /** 非负整数，脏数据一律折成 0 */
  function toCount(value) {
    var number = Number(value);
    if (!isFinite(number) || number <= 0) return 0;
    return Math.floor(number);
  }

  function isDirection(value) {
    return DIRS.indexOf(value) >= 0;
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  /** 数值矩阵深拷贝；非数组一律折成 []，避免把调用方的数组带走 */
  function copyValues(values) {
    var out = [];
    if (!Array.isArray(values)) return out;
    for (var r = 0; r < values.length; r++) {
      out.push(Array.isArray(values[r]) ? values[r].slice() : []);
    }
    return out;
  }

  /** 把一条走子记录洗成固定字段，顺便和入参彻底解耦 */
  function copyEntry(entry) {
    var src = entry && typeof entry === 'object' ? entry : {};
    return {
      d: isDirection(src.d) ? src.d : null,
      v: copyValues(src.v),
      g: isFiniteNumber(src.g) ? src.g : 0,
      b: isDirection(src.b) ? src.b : null,
      s: isFiniteNumber(src.s) ? src.s : null,
      t: isFiniteNumber(src.t) ? src.t : null
    };
  }

  /** 千分位自实现：不依赖 toLocaleString 的地区行为 */
  function formatNumber(value) {
    var text = String(toCount(value));
    var out = '';
    for (var i = 0; i < text.length; i++) {
      if (i > 0 && (text.length - i) % 3 === 0) out += ',';
      out += text.charAt(i);
    }
    return out;
  }

  /** 评级只看一致性：A >= .85，B >= .7，C >= .5，其余 D */
  function gradeFor(consistency) {
    if (consistency >= 0.85) return 'A';
    if (consistency >= 0.7) return 'B';
    if (consistency >= 0.5) return 'C';
    return 'D';
  }

  /** 迷你盘面的内联配色；未知数值（超大块）退回 big 色 */
  function colorFor(value) {
    if (value === 0 || value === null || value === undefined) return TILE_COLORS.empty;
    if (value === -1) return TILE_COLORS.obstacle;
    var color = TILE_COLORS[String(value)];
    return color || TILE_COLORS.big;
  }

  /**
   * 一份空日志。
   * @param {string} dateKey 日期键（YYYYMMDD）
   * @returns {{version:number, date:string, moves:Array, summary:null}}
   */
  function emptyLog(dateKey) {
    return {
      version: LOG_VERSION,
      date: typeof dateKey === 'string' ? dateKey : '',
      moves: [],
      summary: null
    };
  }

  /**
   * 追加一步，返回新日志；超过 MAX_MOVES 时丢最旧的那一步。
   * 入参 log / entry 都不会被修改（entry.v 也做了深拷贝）。
   *
   * @param {object} log 现有日志
   * @param {{d:string, v:Array, g:number, b:?string, s:?number, t:?number}} entry 这一步
   * @returns {object} 新日志
   */
  function appendMove(log, entry) {
    var base = log && typeof log === 'object' ? log : null;
    var moves = base && Array.isArray(base.moves) ? base.moves.slice() : [];

    moves.push(copyEntry(entry));
    if (moves.length > MAX_MOVES) moves = moves.slice(moves.length - MAX_MOVES);

    return {
      version: LOG_VERSION,
      date: base && typeof base.date === 'string' ? base.date : '',
      moves: moves,
      summary: base && base.summary && typeof base.summary === 'object' ? base.summary : null
    };
  }

  /**
   * 把从存档里读回来的日志洗成可用结构。
   *
   * 日期一律以局面的每日键为准（不信存档里的自述），步数同样按 240 截断；
   * 每条记录都过一遍 copyEntry，存档被手改 / 截断时也不会把脏数据带进复盘或评分。
   * 非法条目保留成空壳而不是过滤掉 —— 下标必须和真实步数一一对应，撤销裁剪才不会错位。
   *
   * @param {*} raw 存档里的日志
   * @param {string} dateKey 当前局面的日期键
   * @returns {object} 可直接使用的日志（summary 恒为 null）
   */
  function normalizeLog(raw, dateKey) {
    var base = raw && typeof raw === 'object' ? raw : null;
    var moves = base && Array.isArray(base.moves) ? base.moves : [];
    var out = [];

    for (var i = 0; i < moves.length; i++) out.push(copyEntry(moves[i]));
    if (out.length > MAX_MOVES) out = out.slice(out.length - MAX_MOVES);

    var date = typeof dateKey === 'string'
      ? dateKey
      : (base && typeof base.date === 'string' ? base.date : '');

    return {
      version: LOG_VERSION,
      date: date,
      moves: out,
      summary: null
    };
  }

  /**
   * 汇总一局：一致率、平均亏损、最差几步。
   *
   * 只统计「已评分」的步（b/s/t 齐全）；没有任何样本时 scored=0、两项指标记 0、
   * 评级记「—」，调用方据此显示空指标而不是崩掉。
   *
   * @param {object} log 复盘日志
   * @param {{score:number, moves:number, maxTile:number, won:boolean}} meta 本局结果
   * @returns {{grade:string, consistency:number, avgLoss:number, matched:number,
   *            worst:Array<{index:number, dir:string, bestDir:string, delta:number, values:Array}>, scored:number}}
   */
  function summarize(log, meta) {
    var moves = log && Array.isArray(log.moves) ? log.moves : [];
    var total = meta && typeof meta === 'object' ? toCount(meta.moves) : 0;

    // 日志有上限，前面的步会被丢掉；按「本局总步数」把序号补回去，
    // 这样界面上的「第 N 步」始终是真实步数，不随截断漂移。
    var offset = total > moves.length ? total - moves.length : 0;

    var scored = 0;
    var matched = 0;
    var lossSum = 0;
    var worst = [];

    for (var i = 0; i < moves.length; i++) {
      var move = moves[i];
      if (!move || !isDirection(move.b) || !isFiniteNumber(move.s) || !isFiniteNumber(move.t)) {
        continue;
      }

      scored++;
      if (move.d === move.b) matched++;

      var delta = move.s - move.t;
      if (delta < 0) delta = 0;
      lossSum += delta;

      if (delta > 0) {
        worst.push({
          index: offset + i + 1,
          dir: move.d,
          bestDir: move.b,
          delta: delta,
          values: copyValues(move.v)
        });
      }
    }

    // 亏损大的排前面；同分时按步序先后，保证输出稳定
    worst.sort(function (a, b) {
      if (b.delta !== a.delta) return b.delta - a.delta;
      return a.index - b.index;
    });
    if (worst.length > WORST_LIMIT) worst.length = WORST_LIMIT;

    var consistency = scored > 0 ? matched / scored : 0;

    return {
      // 一步都没算完时不编评级：与 UI 的「—」保持一致，别让空数据顶着 D
      grade: scored > 0 ? gradeFor(consistency) : '—',
      consistency: consistency,
      avgLoss: scored > 0 ? lossSum / scored : 0,
      matched: matched,
      worst: worst,
      scored: scored
    };
  }

  /**
   * 把 worst 的步号按 [0,1/3)、[1/3,2/3)、[2/3,1] 分三段，返回每段次数。
   * 总步数为 0 时退化成「按 worst 里的最大步号」分段，保证不会除零。
   */
  function segmentWorst(worst, totalMoves) {
    var counts = [0, 0, 0];
    if (!worst.length) return counts;

    var total = toCount(totalMoves);
    if (total <= 0) {
      for (var m = 0; m < worst.length; m++) {
        if (worst[m].index > total) total = worst[m].index;
      }
    }
    if (total <= 0) total = 1;

    for (var i = 0; i < worst.length; i++) {
      var ratio = worst[i].index / total;
      if (ratio < 1 / 3) counts[0]++;
      else if (ratio < 2 / 3) counts[1]++;
      else counts[2]++;
    }

    return counts;
  }

  /** 次数最多的段下标；并列时取靠前的一段，保证结果稳定 */
  function topSegment(counts) {
    var best = 0;
    for (var i = 1; i < counts.length; i++) {
      if (counts[i] > counts[best]) best = i;
    }
    return best;
  }

  /**
   * 生成复盘文案。全部规则式，同一输入必然同一输出。
   *
   * @param {object} summary summarize 的返回值
   * @param {{dateLabel:string, score:number, maxTile:number, moves:number,
   *          history:Array<{date:string, bestScore:number}>, streak:number, bestToday:number}} ctx
   * @returns {{headline:string, paragraphs:Array<string>, tips:Array<string>}}
   */
  function analyze(summary, ctx) {
    var sum = summary && typeof summary === 'object' ? summary : {};
    var input = ctx && typeof ctx === 'object' ? ctx : {};

    var consistency = isFiniteNumber(sum.consistency) ? sum.consistency : 0;
    var avgLoss = isFiniteNumber(sum.avgLoss) ? sum.avgLoss : 0;
    var scored = toCount(sum.scored);
    var worst = Array.isArray(sum.worst) ? sum.worst : [];

    var score = toCount(input.score);
    var maxTile = toCount(input.maxTile);
    var moves = toCount(input.moves);
    var streak = toCount(input.streak);

    /* ---------- headline ---------- */
    var headline;
    if (scored > 0) {
      headline =
        '今日 ' + formatNumber(score) + ' 分 · 与 AI 一致 ' +
        Math.round(consistency * 100) + '% · 平均每步让出 ' + avgLoss.toFixed(2);
    } else {
      headline = '今日 ' + formatNumber(score) + ' 分 · 本局未完成评分';
    }

    /* ---------- 段落 1：近 7 日均值 ---------- */
    var history = Array.isArray(input.history) ? input.history : [];
    if (history.length > 7) history = history.slice(history.length - 7);

    var historySum = 0;
    var historyCount = 0;
    for (var h = 0; h < history.length; h++) {
      var bestScore = history[h] ? toCount(history[h].bestScore) : 0;
      if (bestScore > 0) {
        historySum += bestScore;
        historyCount++;
      }
    }

    var compareText;
    if (historyCount === 0) {
      compareText = '这是你第一次完成每日挑战。';
    } else {
      var diff = Math.round(score - historySum / historyCount);
      if (diff > 0) compareText = '比近 7 日均值高 ' + formatNumber(diff) + ' 分。';
      else if (diff < 0) compareText = '比近 7 日均值低 ' + formatNumber(-diff) + ' 分。';
      else compareText = '与近 7 日均值持平。';
    }

    /* ---------- 段落 2：失误分布 ---------- */
    var counts = segmentWorst(worst, moves);
    var segmentIndex = topSegment(counts);
    var segmentNames = ['开局', '中盘', '收尾'];

    var distributionText;
    if (scored === 0) {
      distributionText = '本局未完成评分，失误分布暂时为空。';
    } else if (!worst.length) {
      distributionText = '没有明显失误，每一步都咬得很紧。';
    } else if (worst.length === 1) {
      distributionText = '最明显的一步失误出现在' + segmentNames[segmentIndex] + '。';
    } else {
      distributionText =
        worst.length + ' 次明显失误里有 ' + counts[segmentIndex] + ' 次集中在' +
        segmentNames[segmentIndex] + '。';
    }

    /* ---------- 段落 3：最大单步失误 ---------- */
    var biggestText;
    var top = worst.length ? worst[0] : null;
    if (scored === 0) {
      biggestText = '评分补算完成后，这里会指出最大的一步失误。';
    } else if (!top) {
      biggestText = '每一步都没有让出分数，保持得很好。';
    } else {
      biggestText =
        '第 ' + top.index + ' 步向' + (DIR_LABEL[top.dir] || '?') + '，亏了 ' +
        top.delta.toFixed(1) + ' 分（AI 建议向' + (DIR_LABEL[top.bestDir] || '?') + '）。';
    }

    /* ---------- tips：按优先级挑，去重后补通用建议 ---------- */
    var tips = [];
    function addTip(text) {
      if (text && tips.indexOf(text) < 0) tips.push(text);
    }

    if (scored > 0 && consistency < 0.6) {
      addTip(
        '先看一步再走：你的选择有 ' + Math.round((1 - consistency) * 100) +
        '% 与 AI 不同，多数亏在没算下一步。'
      );
    }
    if (worst.length && segmentIndex === 0) {
      addTip('开局别急着把大块往中间挪，最大块尽量留在角上。');
    }
    if (maxTile < 256) {
      addTip('先把最大块固定在一个角，沿两条边排成单调序列。');
    }
    if (scored > 0 && avgLoss > 0.8) {
      addTip('每步平均让出 ' + avgLoss.toFixed(1) + ' 分，建议开「提示」对照几步。');
    }
    if (streak >= 3) {
      addTip('连续打卡 ' + streak + ' 天，保持节奏。');
    }

    for (var f = 0; f < FALLBACK_TIPS.length && tips.length < 3; f++) {
      addTip(FALLBACK_TIPS[f]);
    }
    tips = tips.slice(0, 3);

    return {
      headline: headline,
      paragraphs: [compareText, distributionText, biggestText],
      tips: tips
    };
  }

  return {
    LOG_VERSION: LOG_VERSION,
    MAX_MOVES: MAX_MOVES,
    WORST_LIMIT: WORST_LIMIT,
    DIRS: DIRS,
    DIR_LABEL: DIR_LABEL,
    TILE_COLORS: TILE_COLORS,
    colorFor: colorFor,
    emptyLog: emptyLog,
    appendMove: appendMove,
    normalizeLog: normalizeLog,
    summarize: summarize,
    analyze: analyze
  };
});
