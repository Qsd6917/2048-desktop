/**
 * 2048 双人对战 —— 分数归属与比分判定的纯函数。
 *
 * 浏览器里挂到 window.Game2048Duel，Node 里通过 module.exports 导出。
 * 刻意不碰 document、不读写 state：谁走子、走完换谁、死局谁赢都只是几个数字的运算，
 * 放在这里就能脱离浏览器单测（见 test/duel.test.js），控制器只负责「什么时候调」。
 *
 * 两个约定：
 *   - 分数永远是 0..MAX_SCORE 的整数。存档手改、负数、NaN / Infinity 一律归 0，
 *     超过 MAX_SCORE 的钳到上界（与 app.js 的 SAVE_MAX_SCORE 同口径），
 *     不让坏数据污染比分、也不让累加翻成 Infinity；
 *   - 两个玩家固定两人，数组缺位按 0 补齐。回合号只有 0 / 1，越界按 1 处理（与
 *     app.js 读档的 safeCount 口径一致，避免读档与内存里各算一套）。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Game2048Duel = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 双人对战固定两人 */
  var PLAYER_COUNT = 2;

  /**
   * 单个玩家比分的上界。
   *
   * 与 js/app.js 的 SAVE_MAX_SCORE 同口径（当前同为 1e9）：读档时 app.js 用
   * safeCount(playersIn[i], SAVE_MAX_SCORE) 把比分钳到 1e9，这边若没有上界，
   * 内存里的比分就会比读档侧宽松，同一份坏数据走两条路径得到两个数。
   * 改一处必须改两处，否则「内存 / 存档」口径再次分叉。
   *
   * 选 1e9 而不是更大：一局真打完的分数离它还有几个数量级，撞到上界只可能是
   * 手改存档或坏数据，钳住既不影响正常对局，也避免累加成 Infinity 后污染判胜。
   */
  var MAX_SCORE = 1e9;

  /**
   * 把任意来源的分数整理成非负整数，并钳到 MAX_SCORE。
   * 与 app.js 的 safeCount 同口径：非有限数 / 负数归 0，超过上界取上界。
   * 上界同时兜住「连续累加」——attribute 每次都先过这里，单步再大也翻不出去。
   *
   * @param {*} value 原始分数
   * @returns {number} 0..MAX_SCORE 的整数
   */
  function safeScore(value) {
    var number = Number(value);
    if (!isFinite(number) || number <= 0) return 0;
    number = Math.floor(number);
    // 钳制放在取整之后：1e9 + 0.5 这类值先落地成整数再比较，结果与 safeCount 一致
    return number > MAX_SCORE ? MAX_SCORE : number;
  }

  /**
   * 把回合号收敛到 0 / 1。
   * 缺省、非数字、负数按 0（先手）；大于 1 的按 1，与读档的 safeCount(v, 1) 一致。
   *
   * @param {*} turn 原始回合号
   * @returns {number} 0 或 1
   */
  function normalizeTurn(turn) {
    var number = Number(turn);
    if (!isFinite(number) || number <= 0) return 0;
    return number >= 1 ? 1 : 0;
  }

  /**
   * 把玩家分数整理成固定 PLAYER_COUNT 人的数组。
   * 传入的数组不会被就地修改：调用方可以放心把它当成不可变值。
   *
   * 长度由 PLAYER_COUNT 驱动而不是写死两个字面量：人数要变时只改上面那个常量，
   * 这里生成的数组长度就跟着变，读档、HUD、结算拿到的比分位数不会和常量对不上。
   * （winnerOf 仍按两人写死判胜——它本身就是「双人对战」的语义，不是漏改。）
   *
   * @param {*} players 原始比分，形如 [p1, p2]
   * @returns {number[]} 长度为 PLAYER_COUNT 的非负整数数组
   */
  function normalize(players) {
    var list = Array.isArray(players) ? players : [];
    var scores = [];
    for (var i = 0; i < PLAYER_COUNT; i++) {
      // list[i] 越界时是 undefined，safeScore 会归 0，等于「缺位按 0 补齐」
      scores.push(safeScore(list[i]));
    }
    return scores;
  }

  /**
   * 读某一位玩家的比分，供 HUD 与结算文案取数。
   *
   * @param {*} players 比分数组
   * @param {*} index 玩家序号（0 / 1）
   * @returns {number} 该玩家的非负整数比分
   */
  function scoreOf(players, index) {
    var scores = normalize(players);
    return scores[normalizeTurn(index)];
  }

  /**
   * 把这一步的得分记到当前走子的人头上。
   *
   * 一次移动可能合并多组，调用方传进来的 gained 已经是这一整步的合计
   * （logic.js 的 computeMove 口径），所以这里只做「归谁」这一件事。
   * 返回新数组而不是就地改：撤销栈、存档快照都不会被后续走子悄悄改写。
   *
   * 累加结果再过一次 safeScore：normalize 已经保证旧分与 gained 都 <= MAX_SCORE，
   * 两者相加最多 2 * MAX_SCORE，仍远小于 Number.MAX_SAFE_INTEGER、不会变 Infinity；
   * 但钳一次才能让「玩家总分」和读档侧的上界真正对齐，否则连打几局就能越过读档允许的范围。
   *
   * @param {*} players 走这一步之前的比分
   * @param {*} turn 走这一步的人（0 / 1）
   * @param {*} gained 这一步的合并得分
   * @returns {number[]} 新的比分数组
   */
  function attribute(players, turn, gained) {
    var scores = normalize(players);
    var seat = normalizeTurn(turn);
    scores[seat] = safeScore(scores[seat] + safeScore(gained));
    return scores;
  }

  /**
   * 下一步轮到谁。
   *
   * @param {*} turn 当前回合号
   * @returns {number} 另一位玩家（0 / 1）
   */
  function nextTurn(turn) {
    return normalizeTurn(turn) === 0 ? 1 : 0;
  }

  /**
   * 死局时按比分判胜负。
   *
   * 返回 null 表示平局 —— 调用方只需要判 `=== null` 就能出「平局」文案，
   * 不必再比较一次两边分数（比较口径只在这里有一份）。
   *
   * @param {*} players 比分数组
   * @returns {?number} 0 / 1 为胜者序号，平局为 null
   */
  function winnerOf(players) {
    var scores = normalize(players);
    if (scores[0] > scores[1]) return 0;
    if (scores[1] > scores[0]) return 1;
    return null;
  }

  return {
    PLAYER_COUNT: PLAYER_COUNT,
    MAX_SCORE: MAX_SCORE,
    attribute: attribute,
    nextTurn: nextTurn,
    winnerOf: winnerOf,
    scoreOf: scoreOf
  };
});
