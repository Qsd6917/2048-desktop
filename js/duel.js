/**
 * 2048 双人对战 —— 分数归属与比分判定的纯函数。
 *
 * 浏览器里挂到 window.Game2048Duel，Node 里通过 module.exports 导出。
 * 刻意不碰 document、不读写 state：谁走子、走完换谁、死局谁赢都只是几个数字的运算，
 * 放在这里就能脱离浏览器单测（见 test/duel.test.js），控制器只负责「什么时候调」。
 *
 * 两个约定：
 *   - 分数永远是非负整数。存档手改、负数、NaN / Infinity 一律归 0，不让坏数据污染比分；
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
   * 把任意来源的分数整理成非负整数。
   * 与 app.js 的 safeCount 同口径（非有限数 / 负数归 0），只是这里没有上界：
   * 一局双人的分数由每个玩家的真实合并累加而来，不需要借读档的钳制值。
   *
   * @param {*} value 原始分数
   * @returns {number} 非负整数
   */
  function safeScore(value) {
    var number = Number(value);
    if (!isFinite(number) || number <= 0) return 0;
    return Math.floor(number);
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
   * 把玩家分数整理成固定两人的数组。
   * 传入的数组不会被就地修改：调用方可以放心把它当成不可变值。
   *
   * @param {*} players 原始比分，形如 [p1, p2]
   * @returns {number[]} 长度为 2 的非负整数数组
   */
  function normalize(players) {
    var list = Array.isArray(players) ? players : [];
    return [
      safeScore(list[0]),
      safeScore(list[1])
    ];
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
   * @param {*} players 走这一步之前的比分
   * @param {*} turn 走这一步的人（0 / 1）
   * @param {*} gained 这一步的合并得分
   * @returns {number[]} 新的比分数组
   */
  function attribute(players, turn, gained) {
    var scores = normalize(players);
    scores[normalizeTurn(turn)] += safeScore(gained);
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
    attribute: attribute,
    nextTurn: nextTurn,
    winnerOf: winnerOf,
    scoreOf: scoreOf
  };
});
