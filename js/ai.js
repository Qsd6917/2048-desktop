/**
 * 2048 AI 走子建议 —— expectimax 搜索 + 启发式评估，纯计算、不碰 DOM。
 *
 * 浏览器里挂到 window.Game2048AI，Node 里通过 module.exports 导出。
 * 依赖同目录的 logic.js（浏览器里要求先加载 Game2048）。
 *
 * 两处容易踩的坑，这里都规避了：
 *   1. computeMove 会就地改写存活方块的 row/col，所以搜索里每一步模拟前
 *      都用 boardFromValues(toValues(...)) 造一份全新棋盘，真实棋盘一个方块对象都不碰。
 *   2. 障碍已经是 computeMove 的「墙」，这里只管照常调用，不再自己判断一次。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./logic.js'));
  } else {
    root.Game2048AI = factory(root.Game2048);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Game2048) {
  'use strict';

  /** 搜索时遍历的方向顺序，也是 suggest 返回值 dir 的取值域 */
  var DIRECTIONS = ['up', 'right', 'down', 'left'];

  /** 默认时间预算（毫秒）。托管每步只等 220ms，这里必须留出余量。 */
  var DEFAULT_TIME_BUDGET_MS = 120;

  /** 最多 3 个 max 层；预算不够就提前收手 */
  var MAX_DEPTH = 3;

  /** chance 节点最多抽样几个空格（不足则全取） */
  var CHANCE_SAMPLES = 6;

  /** 新块是 2 的概率，其余 0.1 是 4 */
  var P_TWO = 0.9;

  /** 归一化用的参考值 log2(2048)，把「绝对 log 差」压到 0~1 附近 */
  var LOG_REF = 11;

  /* ---------- 评估函数权重（brief 固定值） ---------- */
  var W_EMPTY = 2.7;   // 空格数 / size²
  var W_MONO = 1.0;    // 单调性（已归一化到 0~1，越大越好）
  var W_SMOOTH = -0.1; // 平滑度（相邻 log 差均值，越大越差，所以取负）
  var W_MAX = 1.0;     // log2(最大块)
  /** 最大块在四角的奖励 */
  var W_CORNER = 1.0;

  /**
   * 走死局面的固定惩罚。
   * 正常局面的评估值大致落在 0~20 之间，这里给一个远低于它的常数，
   * 保证「把局面走死」在期望里永远是明显的坏选择；同时保持数值有限，
   * 绝不能返回 -Infinity —— 那会把期望值污染成非有限数。
   */
  var DEAD_PENALTY = 1000;

  /** 对数用 Math.log2，方块值都是 2 的幂，结果一定是整数 */
  function log2(value) {
    return Math.log2(value);
  }

  /**
   * 一条线（已按障碍切成若干段）的单调性得分，返回 0~1。
   *
   * 递增惩罚 = 所有「下降」步的 log 差之和；
   * 递减惩罚 = 所有「上升」步的 log 差之和；
   * 取两者较小者为该线惩罚（说明这条线整体上是单向的），
   * 除以 (段长-1)*LOG_REF 归一化后取补，得到 1 表示完全单调。
   *
   * logs 里空格记作 0（即 log2(1)），这样「贴着边」的排布不会凭空扣分。
   */
  function segmentMonotonicity(logs) {
    var length = logs.length;
    if (length < 2) return -1; // -1 表示这段没有相邻对，不计入平均

    var incBad = 0;
    var decBad = 0;
    for (var i = 0; i + 1 < length; i++) {
      var delta = logs[i + 1] - logs[i];
      if (delta > 0) decBad += delta;      // 上升 —— 违反「递减」
      else incBad -= delta;                // 下降 —— 违反「递增」
    }

    var worst = Math.min(incBad, decBad);
    var normalized = worst / ((length - 1) * LOG_REF);
    if (normalized > 1) normalized = 1;
    return 1 - normalized;
  }

  /**
   * 对数值矩阵做评估，返回有限数（空棋盘也有值）。
   * 只用 toValues 之后的矩阵，不看方块对象，避免被坐标影响。
   */
  function evaluateValues(values) {
    var size = values.length;
    var total = size * size;
    var emptyCount = 0;
    var maxValue = 0;
    var maxRow = -1;
    var maxCol = -1;
    var smoothSum = 0;
    var smoothPairs = 0;
    var r;
    var c;

    for (r = 0; r < size; r++) {
      var row = values[r];
      for (c = 0; c < size; c++) {
        var value = row[c];
        if (value === 0) {
          emptyCount++;
          continue;
        }
        if (value < 0) continue; // 障碍

        if (value > maxValue) {
          maxValue = value;
          maxRow = r;
          maxCol = c;
        }
        // 平滑度只看右邻与下邻，保证每对相邻格只算一次
        if (c + 1 < size && row[c + 1] > 0) {
          smoothSum += Math.abs(log2(value) - log2(row[c + 1]));
          smoothPairs++;
        }
        if (r + 1 < size && values[r + 1][c] > 0) {
          smoothSum += Math.abs(log2(value) - log2(values[r + 1][c]));
          smoothPairs++;
        }
      }
    }

    /* 单调性：每一行、每一列分别算，障碍处切段。
     * logs 复用同一个数组，遇到障碍 / 行尾就结算当前段并清空，省掉重复分配。 */
    var logs = [];
    var monoSum = 0;
    var monoLines = 0;
    var score;

    for (r = 0; r < size; r++) {
      logs.length = 0;
      for (c = 0; c <= size; c++) {
        var cell = c < size ? values[r][c] : -1; // 行尾用 -1 当收段哨兵
        if (cell < 0) {
          score = segmentMonotonicity(logs);
          if (score >= 0) {
            monoSum += score;
            monoLines++;
          }
          logs.length = 0;
        } else {
          logs.push(cell === 0 ? 0 : log2(cell));
        }
      }
    }

    for (c = 0; c < size; c++) {
      logs.length = 0;
      for (r = 0; r <= size; r++) {
        var cellCol = r < size ? values[r][c] : -1;
        if (cellCol < 0) {
          score = segmentMonotonicity(logs);
          if (score >= 0) {
            monoSum += score;
            monoLines++;
          }
          logs.length = 0;
        } else {
          logs.push(cellCol === 0 ? 0 : log2(cellCol));
        }
      }
    }

    var emptyTerm = W_EMPTY * (total > 0 ? emptyCount / total : 0);
    var monoTerm = W_MONO * (monoLines > 0 ? monoSum / monoLines : 1);
    var smoothTerm = W_SMOOTH * (smoothPairs > 0 ? smoothSum / (smoothPairs * LOG_REF) : 0);
    var maxTerm = W_MAX * (maxValue > 0 ? log2(maxValue) : 0);
    var atCorner =
      maxValue > 0 &&
      (maxRow === 0 || maxRow === size - 1) &&
      (maxCol === 0 || maxCol === size - 1);
    var cornerTerm = atCorner ? W_CORNER : 0;

    return emptyTerm + monoTerm + smoothTerm + maxTerm + cornerTerm;
  }

  /** 对外接口：直接吃真实棋盘（三种单元格状态） */
  function evaluate(board) {
    return evaluateValues(Game2048.toValues(board));
  }

  /** 数值矩阵浅拷贝（行数组要新建，chance 节点会往里写） */
  function cloneValues(values) {
    var out = [];
    for (var r = 0; r < values.length; r++) out.push(values[r].slice());
    return out;
  }

  /**
   * 在数值矩阵上模拟一次移动，返回移动后的数值矩阵；走不动返回 null。
   *
   * 关键：每次都从 values 重新造一副棋盘再算，computeMove 对 row/col 的
   * 就地改写只会落在临时对象上，调用方传进来的 values 与真实棋盘都干净。
   */
  function moveValues(values, dir) {
    var board = Game2048.boardFromValues(values);
    var result = Game2048.computeMove(board, dir);
    if (!result.changed) return null;
    return Game2048.toValues(result.board);
  }

  /** 收集数值矩阵里的空格坐标（只认 0，障碍是 -1，不算） */
  function emptyValueCells(values) {
    var cells = [];
    for (var r = 0; r < values.length; r++) {
      var row = values[r];
      for (var c = 0; c < row.length; c++) {
        if (row[c] === 0) cells.push([r, c]);
      }
    }
    return cells;
  }

  /**
   * 从空格里均匀抽样至多 CHANCE_SAMPLES 个。
   * 用等距取样而不是随机取样：结果可复现，且覆盖面比「取前 6 个」均匀得多。
   */
  function sampleCells(cells, limit) {
    if (cells.length <= limit) return cells;
    var out = [];
    for (var i = 0; i < limit; i++) {
      out.push(cells[Math.floor((i * cells.length) / limit)]);
    }
    return out;
  }

  /** 搜索上下文：截止时间 + 中断标记 */
  function createContext(budgetMs) {
    return { deadline: Date.now() + budgetMs, aborted: false };
  }

  /** 到点了就把整体标记为中断，所有上层节点看到标记就尽快退出 */
  function timeUp(ctx) {
    if (ctx.aborted) return true;
    if (Date.now() >= ctx.deadline) ctx.aborted = true;
    return ctx.aborted;
  }

  /** 在当前矩阵的 (r, c) 放一个新块，返回新矩阵 */
  function withSpawn(values, r, c, value) {
    var next = cloneValues(values);
    next[r][c] = value;
    return next;
  }

  /**
   * max 节点：遍历 4 个方向，返回其中的最高分。
   * 中断时返回已有最好值，但调用方会看 ctx.aborted 丢掉这轮结果。
   * 四个方向都走不动 = 死局，返回静态评估再扣掉固定惩罚。
   */
  function maxNode(values, depth, ctx) {
    if (timeUp(ctx)) return 0;

    var best = -Infinity;
    for (var i = 0; i < DIRECTIONS.length; i++) {
      var child = moveValues(values, DIRECTIONS[i]);
      if (!child) continue;
      var score = chanceNode(child, depth - 1, ctx);
      if (score > best) best = score;
      if (timeUp(ctx)) return best === -Infinity ? 0 : best;
    }
    if (best === -Infinity) return evaluateValues(values) - DEAD_PENALTY;
    return best;
  }

  /**
   * chance 节点：对抽样出的空格 × {2, 4} 按 0.9 / 0.1 加权求期望。
   *
   * depth 表示「这次落子之后还剩几层 max」，所以 depth > 0 时要把每个
   * 落子结果交给 maxNode(depth) 继续往下，depth 归零才做静态评估。
   */
  function chanceNode(values, depth, ctx) {
    if (timeUp(ctx)) return 0;
    if (depth <= 0) return evaluateValues(values);

    var cells = emptyValueCells(values);
    if (!cells.length) return evaluateValues(values); // 满盘，没有随机性

    var picks = sampleCells(cells, CHANCE_SAMPLES);
    var sum = 0;
    for (var i = 0; i < picks.length; i++) {
      var r = picks[i][0];
      var c = picks[i][1];

      sum += P_TWO * maxNode(withSpawn(values, r, c, 2), depth, ctx);
      if (ctx.aborted) break;

      sum += (1 - P_TWO) * maxNode(withSpawn(values, r, c, 4), depth, ctx);
      if (ctx.aborted) break;
    }

    // 每个被抽中的格子概率和是 1（0.9 + 0.1），所以按抽样个数平均即可
    return sum / picks.length;
  }

  /**
   * 根节点的一轮搜索：按贪心分数排好序的方向依次求期望值。
   * 先搜高分的分支能更早拿到一个不错的解，中断时也不至于太差。
   *
   * 每个方向的分数同时收进 scores（key 为方向），下游（复盘）靠它判断
   * 玩家实际选择与最佳选择差了多少；中断的那一轮整体作废，scores 因此
   * 不会以半成品的形式流出去。
   */
  function rootSearch(legal, depth, ctx) {
    var best = null;
    var scores = {};

    for (var i = 0; i < legal.length; i++) {
      var score = chanceNode(legal[i].values, depth - 1, ctx);
      if (ctx.aborted) break;

      scores[legal[i].dir] = score;
      if (!best || score > best.score) {
        best = { dir: legal[i].dir, score: score, depth: depth };
      }
    }

    if (best) best.scores = scores;
    return best;
  }

  /**
   * 给出一步建议。
   *
   * 流程：
   *   1. 先把 4 个方向都试一遍，走不动的丢掉；一个都没有（死局 / 空盘）就返回 null。
   *   2. 用静态评估给这 4 个候选排个序，得到一个「深度 0 的兜底答案」。
   *   3. 逐层加深（1 → 3 层 max），每层结束时若还没超时就继续。
   *      某一层中途超时，整层作废，返回上一层已经完整的答案 —— 绝不留半成品。
   */
  function suggest(board, opts) {
    var options = opts || {};
    var budget =
      typeof options.timeBudgetMs === 'number' && Number.isFinite(options.timeBudgetMs)
        ? options.timeBudgetMs
        : DEFAULT_TIME_BUDGET_MS;
    if (budget < 0) budget = 0;

    var values = Game2048.toValues(board);
    var ctx = createContext(budget);

    var legal = [];
    for (var i = 0; i < DIRECTIONS.length; i++) {
      var child = moveValues(values, DIRECTIONS[i]);
      if (!child) continue;
      legal.push({ dir: DIRECTIONS[i], values: child, greedy: evaluateValues(child) });
    }
    if (!legal.length) return null;

    legal.sort(function (a, b) {
      return b.greedy - a.greedy;
    });

    // 深度 0 的答案：纯静态评估挑一步，保证无论如何都有合法方向可返回。
    // 此时没有搜索分数，scores 就用这四个方向的静态评估值顶上。
    var staticScores = {};
    for (i = 0; i < legal.length; i++) staticScores[legal[i].dir] = legal[i].greedy;
    var best = { dir: legal[0].dir, score: legal[0].greedy, depth: 0, scores: staticScores };

    for (var depth = 1; depth <= MAX_DEPTH; depth++) {
      // 除第一层外，超时就别再开新的一层
      if (depth > 1 && Date.now() >= ctx.deadline) break;
      var round = rootSearch(legal, depth, ctx);
      if (ctx.aborted) break;
      if (round) best = round;
      if (Date.now() >= ctx.deadline) break;
    }

    return { dir: best.dir, score: best.score, depth: best.depth, scores: best.scores };
  }

  return {
    DIRECTIONS: DIRECTIONS,
    evaluate: evaluate,
    suggest: suggest
  };
});
