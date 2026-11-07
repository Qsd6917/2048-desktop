/**
 * 2048 每日挑战数据层 —— 纯数据，不做 IO。
 *
 * 浏览器里挂到 window.Game2048Daily，Node 里通过 module.exports 导出。
 * 读写 localStorage 由控制器（app.js）负责，这里只负责把任意来源的脏数据
 * 整理成稳定结构、以及按日期累计战绩。所有「写」操作都返回新对象，
 * 入参永远不被修改 —— 控制器可以放心地先算后存。
 *
 * 一天一条记录：
 *   attempts   开过几次（进每日挑战就 +1，中途重开也算一次）
 *   finishes   打完几次（走不动 / 超时 / 通关才 +1）
 *   bestScore  当天最好分数      bestMoves 当天最少步数
 *   bestTile   当天最大方块      won       当天是否达成过目标
 *   totalMoves 当天累计步数      lastAt    最后一次动作的时间戳
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./rng.js'));
  } else {
    root.Game2048Daily = factory(root.Game2048Rng);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Rng) {
  'use strict';

  /** 存档版本；结构不兼容时靠它识别 */
  var VERSION = 1;

  /** 最多保留多少天的记录（旧的先丢，避免 localStorage 无限膨胀） */
  var MAX_DAYS = 60;

  /** 非负整数，脏数据一律折成 0（与 storage.js 的统计口径一致） */
  function toCount(value) {
    var number = Number(value);
    if (!isFinite(number) || number <= 0) return 0;
    return Math.floor(number);
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatKey(date) {
    return String(date.getFullYear()) + pad2(date.getMonth() + 1) + pad2(date.getDate());
  }

  /** 日期键 -> 本地时区 Date；非法键返回 null */
  function keyToDate(key) {
    if (!Rng.isDateKey(key)) return null;
    return new Date(
      Number(key.slice(0, 4)),
      Number(key.slice(4, 6)) - 1,
      Number(key.slice(6, 8))
    );
  }

  /** 日期键平移 delta 天（可为负），跨月跨年由 Date 自己处理；非法键返回 '' */
  function shiftKey(key, delta) {
    var date = keyToDate(key);
    if (!date) return '';
    date.setDate(date.getDate() + delta);
    return formatKey(date);
  }

  function emptyRecord(date) {
    return {
      date: date,
      attempts: 0,
      finishes: 0,
      bestScore: 0,
      bestMoves: 0,
      bestTile: 0,
      won: false,
      totalMoves: 0,
      lastAt: 0
    };
  }

  /** 把一条记录逐字段洗成合法值，date 一律以键为准（不信存档里的自述） */
  function normalizeRecord(date, raw) {
    var record = emptyRecord(date);
    if (!raw || typeof raw !== 'object') return record;

    record.attempts = toCount(raw.attempts);
    record.finishes = toCount(raw.finishes);
    record.bestScore = toCount(raw.bestScore);
    record.bestMoves = toCount(raw.bestMoves);
    record.bestTile = toCount(raw.bestTile);
    record.won = raw.won === true;
    record.totalMoves = toCount(raw.totalMoves);
    record.lastAt = toCount(raw.lastAt);

    return record;
  }

  function emptyStore() {
    return { version: VERSION, days: {}, bestStreak: 0 };
  }

  /** 按键名排序（YYYYMMDD 字典序即时间序），只留最近的 MAX_DAYS 天 */
  function trimDays(store) {
    var keys = Object.keys(store.days).sort();
    var extra = keys.length - MAX_DAYS;
    for (var i = 0; i < extra; i++) delete store.days[keys[i]];
  }

  /**
   * 把任意来源的 store 整理成完整结构：
   *   版本固定 1、天数上限 60（保留最近）、非法日期键丢弃、每条记录逐字段回退。
   * 返回值一定是新对象，days 里也全是新记录。
   *
   * @param {*} raw 待整理的存档
   * @returns {{version: number, days: object, bestStreak: number}}
   */
  function normalizeStore(raw) {
    var store = emptyStore();
    if (!raw || typeof raw !== 'object') return store;

    store.bestStreak = toCount(raw.bestStreak);

    var days = raw.days;
    if (!days || typeof days !== 'object') return store;

    var keys = Object.keys(days).filter(function (key) {
      return Rng.isDateKey(key);
    });
    keys.sort();

    for (var i = 0; i < keys.length; i++) {
      var item = days[keys[i]];
      if (!item || typeof item !== 'object') continue;
      store.days[keys[i]] = normalizeRecord(keys[i], item);
    }

    trimDays(store);
    return store;
  }

  function hasPlayed(store, key) {
    var record = store.days[key];
    return !!record && record.attempts > 0;
  }

  /**
   * 开始一次尝试：attempts + 1、lastAt 更新，返回新 store。
   * 非法日期键原样返回（整理后的）store，不写脏键。
   *
   * @param {object} store 现有数据
   * @param {string} key 日期键
   * @param {number} now 时间戳
   * @returns {object} 新 store
   */
  function startAttempt(store, key, now) {
    var next = normalizeStore(store);
    if (!Rng.isDateKey(key)) return next;

    var record = next.days[key];
    if (!record) {
      record = emptyRecord(key);
      next.days[key] = record;
    }

    record.attempts += 1;
    record.lastAt = toCount(now === undefined ? Date.now() : now);

    trimDays(next);
    return next;
  }

  /**
   * 记录一次完整结果：
   *   finishes +1、totalMoves += moves，bestScore/bestMoves/bestTile 取 max，
   *   won 取或，lastAt 更新。返回新 store，入参不变。
   *
   * @param {object} store 现有数据
   * @param {string} key 日期键
   * @param {{score:number, moves:number, maxTile:number, won:boolean}} result 本局结果
   * @param {number} now 时间戳
   * @returns {object} 新 store
   */
  function recordResult(store, key, result, now) {
    var next = normalizeStore(store);
    if (!Rng.isDateKey(key)) return next;

    var data = result && typeof result === 'object' ? result : {};
    var score = toCount(data.score);
    var moves = toCount(data.moves);
    var maxTile = toCount(data.maxTile);

    var record = next.days[key];
    if (!record) {
      record = emptyRecord(key);
      next.days[key] = record;
    }

    record.finishes += 1;
    record.totalMoves += moves;
    if (score > record.bestScore) record.bestScore = score;
    if (moves > record.bestMoves) record.bestMoves = moves;
    if (maxTile > record.bestTile) record.bestTile = maxTile;
    if (data.won === true) record.won = true;
    record.lastAt = toCount(now === undefined ? Date.now() : now);

    trimDays(next);
    return next;
  }

  /**
   * 连续挑战天数。
   *
   * 今天打过就从今天往回数；今天还没打则从昨天开始数（不能因为「今天还没开始」
   * 就把昨天攒的连续记录清零）。atRisk 表示「今天还没打、但昨天打了」——
   * 界面据此提示断签风险。
   *
   * @param {object} store 现有数据
   * @param {string} todayKey 今天的日期键
   * @returns {{current: number, atRisk: boolean}}
   */
  function streakOf(store, todayKey) {
    var data = normalizeStore(store);
    if (!Rng.isDateKey(todayKey)) return { current: 0, atRisk: false };

    var todayPlayed = hasPlayed(data, todayKey);
    var cursor = todayPlayed ? todayKey : shiftKey(todayKey, -1);
    var atRisk = !todayPlayed && hasPlayed(data, cursor);
    var current = 0;

    while (cursor && hasPlayed(data, cursor)) {
      current += 1;
      cursor = shiftKey(cursor, -1);
    }

    return { current: current, atRisk: atRisk };
  }

  /**
   * 最近 n 天（含今天）的战绩，旧 -> 新，长度恒为 n。
   * 没打过的日子也占一格（played=false），界面画连续日历不需要自己补空。
   *
   * @param {object} store 现有数据
   * @param {string} todayKey 今天的日期键
   * @param {number} n 天数
   * @returns {Array<{date:string, played:boolean, bestScore:number, won:boolean, isToday:boolean}>}
   */
  function recent(store, todayKey, n) {
    var data = normalizeStore(store);
    var count = Math.max(0, Math.floor(Number(n) || 0));
    var items = [];

    for (var i = count - 1; i >= 0; i--) {
      var key = shiftKey(todayKey, -i);
      var record = key ? data.days[key] : null;
      items.push({
        date: key,
        played: !!record && record.attempts > 0,
        bestScore: record ? record.bestScore : 0,
        won: !!record && record.won,
        isToday: i === 0
      });
    }

    return items;
  }

  /**
   * 取某天的记录；没有记录返回 null。
   * 返回的是整理后的副本，调用方改了也不会污染 store。
   */
  function bestOf(store, key) {
    var data = normalizeStore(store);
    if (!Rng.isDateKey(key)) return null;
    return data.days[key] || null;
  }

  return {
    VERSION: VERSION,
    MAX_DAYS: MAX_DAYS,
    emptyStore: emptyStore,
    normalizeStore: normalizeStore,
    startAttempt: startAttempt,
    recordResult: recordResult,
    streakOf: streakOf,
    recent: recent,
    bestOf: bestOf
  };
});
