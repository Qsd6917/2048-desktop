/**
 * 2048 成就档案 —— 纯数据层，不碰 DOM、不读写存储。
 *
 * 浏览器里挂到 window.Game2048Achievements，Node 里通过 module.exports 导出。
 *
 * 档案形状：
 *   { version, stats: {...累计指标}, unlocked: { id: 时间戳 } }
 * stats 与 Storage 的 stats（最高分 / 总局数）刻意分开：那边是「历史战绩」，
 * 这边是「成就口径」，字段只增不改，互相当对方的脏数据源。
 *
 * 所有「写」操作都返回新对象、入参不被修改，控制器可以先算后存。
 * evaluate 的时间戳一律由调用方注入 —— 模块内不读系统时钟，测试才能固定结果。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Game2048Achievements = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 档案结构版本；不兼容时靠它识别 */
  var VERSION = 1;

  /** 档位的界面文案；模块只提供文案，不负责渲染 */
  var TIERS = { bronze: '铜', silver: '银', gold: '金' };

  /**
   * 25 条成就。id / 名称 / metric / target / tier 都是规定值，逐条写死。
   * metric 用点路径表达映射字段（sizes.6 -> stats.sizes['6']）。
   */
  var DEFINITIONS = [
    { id: 'first_game', name: '第一局', desc: '完成第一局游戏', tier: 'bronze', metric: 'games', target: 1 },
    { id: 'score_1k', name: '四位数', desc: '单局得分达到 1,000', tier: 'bronze', metric: 'bestScore', target: 1000 },
    { id: 'score_5k', name: '渐入佳境', desc: '单局得分达到 5,000', tier: 'silver', metric: 'bestScore', target: 5000 },
    { id: 'score_20k', name: '两万分', desc: '单局得分达到 20,000', tier: 'gold', metric: 'bestScore', target: 20000 },
    { id: 'tile_128', name: '一二八', desc: '合成 128 方块', tier: 'bronze', metric: 'bestTile', target: 128 },
    { id: 'tile_256', name: '二五六', desc: '合成 256 方块', tier: 'bronze', metric: 'bestTile', target: 256 },
    { id: 'tile_512', name: '五一二', desc: '合成 512 方块', tier: 'silver', metric: 'bestTile', target: 512 },
    { id: 'tile_1024', name: '一零二四', desc: '合成 1024 方块', tier: 'silver', metric: 'bestTile', target: 1024 },
    { id: 'tile_2048', name: '二〇四八', desc: '合成 2048 方块', tier: 'gold', metric: 'bestTile', target: 2048 },
    { id: 'tile_4096', name: '超额一倍', desc: '合成 4096 方块', tier: 'gold', metric: 'bestTile', target: 4096 },
    { id: 'games_10', name: '十局', desc: '累计完成 10 局', tier: 'bronze', metric: 'games', target: 10 },
    { id: 'games_50', name: '五十局', desc: '累计完成 50 局', tier: 'silver', metric: 'games', target: 50 },
    { id: 'games_100', name: '百局', desc: '累计完成 100 局', tier: 'gold', metric: 'games', target: 100 },
    { id: 'moves_1k', name: '千步', desc: '累计走满 1,000 步', tier: 'bronze', metric: 'totalMoves', target: 1000 },
    { id: 'moves_5k', name: '五千步', desc: '累计走满 5,000 步', tier: 'silver', metric: 'totalMoves', target: 5000 },
    { id: 'merge_4', name: '一步四并', desc: '一步里同时合并 4 组方块', tier: 'silver', metric: 'maxMergesInMove', target: 4 },
    { id: 'combo_3', name: '三连击', desc: '连续 3 步都有合并', tier: 'bronze', metric: 'maxCombo', target: 3 },
    { id: 'combo_5', name: '五连击', desc: '连续 5 步都有合并', tier: 'silver', metric: 'maxCombo', target: 5 },
    { id: 'daily_1', name: '今日挑战', desc: '完成第一次每日挑战', tier: 'bronze', metric: 'dailyPlays', target: 1 },
    { id: 'daily_7', name: '七日不辍', desc: '每日挑战连续 7 天', tier: 'silver', metric: 'dailyStreak', target: 7 },
    { id: 'daily_30', name: '三十日', desc: '每日挑战连续 30 天', tier: 'gold', metric: 'dailyStreak', target: 30 },
    { id: 'daily_win', name: '每日达标', desc: '在每日挑战中达成目标', tier: 'silver', metric: 'dailyWins', target: 1 },
    { id: 'perfect_10', name: '与 AI 同频', desc: '单日复盘里 10 步与 AI 一致', tier: 'silver', metric: 'perfectMoves', target: 10 },
    { id: 'size_6', name: '六乘六', desc: '在 6×6 棋盘完成一局', tier: 'bronze', metric: 'sizes.6', target: 1 },
    { id: 'obstacle_win', name: '障碍通关', desc: '在障碍模式达成目标', tier: 'silver', metric: 'modeWins.obstacle', target: 1 }
  ];

  /** 相加字段：每发生一次就累加 */
  var SUM_FIELDS = [
    'games', 'totalMoves', 'wins', 'merges', 'dailyPlays', 'dailyWins',
    'perfectMoves', 'undoWins'
  ];

  /** 取大字段：只记录历史最好的一次 */
  var MAX_FIELDS = ['bestScore', 'bestTile', 'maxCombo', 'maxMergesInMove', 'dailyStreak'];

  /** id -> 定义；只用于校验与查询，保持 DEFINITIONS 的书写顺序 */
  var BY_ID = {};
  for (var d = 0; d < DEFINITIONS.length; d++) BY_ID[DEFINITIONS[d].id] = DEFINITIONS[d];

  /** 非负整数，脏数据一律折成 0（与 storage.js / daily.js 的口径一致） */
  function toCount(value) {
    var number = Number(value);
    if (!isFinite(number) || number <= 0) return 0;
    return Math.floor(number);
  }

  /** 合法解锁时间戳：正整数的毫秒时间戳 */
  function isStamp(value) {
    return typeof value === 'number' && isFinite(value) && value > 0 &&
      Math.floor(value) === value;
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function emptyStats() {
    return {
      games: 0,
      totalMoves: 0,
      bestScore: 0,
      bestTile: 0,
      wins: 0,
      merges: 0,
      maxCombo: 0,
      maxMergesInMove: 0,
      dailyPlays: 0,
      dailyStreak: 0,
      dailyWins: 0,
      perfectMoves: 0,
      undoWins: 0,
      sizes: {},
      modeWins: {}
    };
  }

  /**
   * 一份空档案。
   * @returns {{version: number, stats: object, unlocked: object}}
   */
  function emptyProfile() {
    return { version: VERSION, stats: emptyStats(), unlocked: {} };
  }

  /**
   * 把任意来源的档案整理成完整结构：
   *   数值逐字段回退到 0、映射字段只保留正整数项、
   *   unlocked 只留合法 id 且值为正整数时间戳。
   *
   * @param {*} raw 待整理的存档
   * @returns {object} 新档案（入参不被修改）
   */
  function normalizeProfile(raw) {
    var profile = emptyProfile();
    if (!raw || typeof raw !== 'object') return profile;

    var stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
    var i;

    for (i = 0; i < SUM_FIELDS.length; i++) {
      profile.stats[SUM_FIELDS[i]] = toCount(stats[SUM_FIELDS[i]]);
    }
    for (i = 0; i < MAX_FIELDS.length; i++) {
      profile.stats[MAX_FIELDS[i]] = toCount(stats[MAX_FIELDS[i]]);
    }

    copyMap(stats.sizes, profile.stats.sizes);
    copyMap(stats.modeWins, profile.stats.modeWins);

    var unlocked = raw.unlocked;
    if (unlocked && typeof unlocked === 'object') {
      var ids = Object.keys(unlocked);
      for (i = 0; i < ids.length; i++) {
        if (!hasOwn(BY_ID, ids[i])) continue;         // 未知 id 直接丢弃
        if (!isStamp(unlocked[ids[i]])) continue;     // 非法时间戳当作没解锁
        profile.unlocked[ids[i]] = unlocked[ids[i]];
      }
    }

    return profile;
  }

  /** 映射字段拷贝：键保留，值只收正整数 */
  function copyMap(raw, target) {
    if (!raw || typeof raw !== 'object') return;
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
      var value = toCount(raw[keys[i]]);
      if (value > 0) target[keys[i]] = value;
    }
  }

  /** 按字符串键取指标；点路径时第二段是映射里的键（sizes.6 -> stats.sizes['6']） */
  function metricOf(stats, metric) {
    var data = stats && typeof stats === 'object' ? stats : {};
    var path = String(metric);
    var dot = path.indexOf('.');

    if (dot < 0) return toCount(data[path]);

    var map = data[path.slice(0, dot)];
    if (!map || typeof map !== 'object') return 0;
    return toCount(map[path.slice(dot + 1)]);
  }

  /**
   * 单条成就的进度。
   * ratio 钳制在 [0,1]，界面画进度条可以直接乘 100；done 才是解锁判据。
   *
   * @param {object} def 成就定义
   * @param {object} stats 档案里的 stats
   * @returns {{current: number, target: number, ratio: number, done: boolean}}
   */
  function progressOf(def, stats) {
    var target = toCount(def && def.target);
    if (target <= 0) target = 1;

    var current = metricOf(stats, def ? def.metric : '');
    var ratio = current / target;
    if (ratio > 1) ratio = 1;

    return { current: current, target: target, ratio: ratio, done: current >= target };
  }

  /**
   * 结算所有已达标的未解锁项。
   *
   * 时间戳由调用方注入（evaluate(profile, now)）；没有合法注入时退回 1 ——
   * 模块内不读 Date.now()，否则测试无法固定结果。已解锁的条目不会重复触发，
   * unlockedNow 按 DEFINITIONS 的书写顺序排列。
   *
   * @param {object} profile 当前档案
   * @param {number} [now] 解锁时间戳（毫秒）
   * @returns {{profile: object, unlockedNow: Array<string>}}
   */
  function evaluate(profile, now) {
    var next = normalizeProfile(profile);
    var stamp = isStamp(now) ? now : 1;
    var unlockedNow = [];

    for (var i = 0; i < DEFINITIONS.length; i++) {
      var def = DEFINITIONS[i];
      if (hasOwn(next.unlocked, def.id)) continue;
      if (!progressOf(def, next.stats).done) continue;

      next.unlocked[def.id] = stamp;
      unlockedNow.push(def.id);
    }

    return { profile: next, unlockedNow: unlockedNow };
  }

  /**
   * 合并一批统计。返回新档案，入参不变。
   *
   *   - 相加字段（games / totalMoves / merges / dailyPlays / dailyWins / perfectMoves ...）
   *     累加；
   *   - 取大字段（bestScore / bestTile / maxCombo / maxMergesInMove / dailyStreak）取较大值；
   *   - sizes 是「打过这个尺寸」的存在性标记，取大；
   *   - modeWins 是各模式的通关次数，累加。
   *
   * @param {object} profile 当前档案
   * @param {object} patch 增量
   * @returns {object} 新档案
   */
  function addStats(profile, patch) {
    var next = normalizeProfile(profile);
    if (!patch || typeof patch !== 'object') return next;

    var i;
    for (i = 0; i < SUM_FIELDS.length; i++) {
      var sumKey = SUM_FIELDS[i];
      if (!hasOwn(patch, sumKey)) continue;
      next.stats[sumKey] = toCount(next.stats[sumKey]) + toCount(patch[sumKey]);
    }

    for (i = 0; i < MAX_FIELDS.length; i++) {
      var maxKey = MAX_FIELDS[i];
      if (!hasOwn(patch, maxKey)) continue;
      var value = toCount(patch[maxKey]);
      if (value > next.stats[maxKey]) next.stats[maxKey] = value;
    }

    mergeMap(patch.sizes, next.stats.sizes, true);
    mergeMap(patch.modeWins, next.stats.modeWins, false);

    return next;
  }

  /**
   * 并入映射字段。
   * @param {*} raw 增量映射
   * @param {object} target 目标映射
   * @param {boolean} keepMax true 取大（存在性标记），false 累加（次数）
   */
  function mergeMap(raw, target, keepMax) {
    if (!raw || typeof raw !== 'object') return;

    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
      var value = toCount(raw[keys[i]]);
      if (value <= 0) continue;

      var existing = toCount(target[keys[i]]);
      target[keys[i]] = keepMax ? Math.max(existing, value) : existing + value;
    }
  }

  /**
   * 复盘一致步数的增量口径：只算「本局还没入账的部分」。
   *
   * recorded 是同一局已经写进 perfectMoves 的数量（由控制器随存档落盘），
   * matched 是本次汇总出来的一致步数。刷新恢复同一局后 recorded 原样读回，
   * 所以再结算一次得到 0 —— 与 recordGame 的 recordedMoves 增量口径同构，
   * 继续挑战时也只补新增的那几步。
   *
   * @param {number} recorded 本局已入账的一致步数
   * @param {number} matched 本次汇总的一致步数
   * @returns {number} 需要补记的数量（不会为负）
   */
  function matchedDelta(recorded, matched) {
    var done = toCount(recorded);
    var total = toCount(matched);
    return total > done ? total - done : 0;
  }

  /** 已解锁条数 */
  function countUnlocked(profile) {
    var data = profile && typeof profile === 'object' ? profile : {};
    var unlocked = data.unlocked && typeof data.unlocked === 'object' ? data.unlocked : {};
    var total = 0;

    for (var i = 0; i < DEFINITIONS.length; i++) {
      if (hasOwn(unlocked, DEFINITIONS[i].id)) total++;
    }
    return total;
  }

  /** 按 id 取定义；未知 id 返回 null */
  function findById(id) {
    return hasOwn(BY_ID, id) ? BY_ID[id] : null;
  }

  return {
    VERSION: VERSION,
    TIERS: TIERS,
    DEFINITIONS: DEFINITIONS,
    emptyStats: emptyStats,
    emptyProfile: emptyProfile,
    normalizeProfile: normalizeProfile,
    progressOf: progressOf,
    evaluate: evaluate,
    addStats: addStats,
    matchedDelta: matchedDelta,
    countUnlocked: countUnlocked,
    findById: findById
  };
});
