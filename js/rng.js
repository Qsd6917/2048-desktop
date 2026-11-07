/**
 * 2048 可复现随机数 —— 每日挑战的种子基础设施，纯函数，不碰 DOM。
 *
 * 浏览器里挂到 window.Game2048Rng，Node 里通过 module.exports 导出。
 *
 * 为什么自己写而不是直接用 Math.random：
 *   每日挑战要求「同一天的开始局面永远一样」，所以随机序列必须由日期字符串
 *   唯一决定。先用 FNV-1a 把种子串折成 32 位整数，再喂给 mulberry32
 *   （32 位状态、够快、序列质量足够铺方块），同种子必然同序列。
 *
 * 序列位置也要能恢复：存档只记「已经取了多少个数」，读档时 skip 同样多次
 * 就回到原来的位置，接下来长出来的方块和没关页面时完全一致。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Game2048Rng = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** FNV-1a 32 位偏移基准：空串的哈希就是它 */
  var FNV_OFFSET = 2166136261;

  /** FNV-1a 32 位质数 */
  var FNV_PRIME = 16777619;

  /** 2^32，把 uint32 折算回 [0, 1) */
  var TWO_POW_32 = 4294967296;

  /**
   * 把字符串折成 uint32（FNV-1a）。
   * 逐字符异或再乘质数，乘法走 Math.imul 保证 32 位不丢精度。
   *
   * @param {string} str 种子串；null/undefined 按空串处理
   * @returns {number} 0..4294967295 的整数
   */
  function hashString(str) {
    var text = str === null || str === undefined ? '' : String(str);
    var hash = FNV_OFFSET;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, FNV_PRIME);
    }
    return hash >>> 0;
  }

  /**
   * mulberry32：返回一个取 [0,1) 的函数，函数对象带 .count 记录被调用次数。
   *
   * @param {number} seed 32 位种子（低位有效，高位会被截断）
   * @returns {function(): number} 随机函数；每次调用 .count 自增
   */
  function mulberry32(seed) {
    var state = seed >>> 0;

    var next = function () {
      state = (state + 0x6d2b79f5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      next.count += 1;
      return ((t ^ (t >>> 14)) >>> 0) / TWO_POW_32;
    };

    next.count = 0;
    return next;
  }

  /**
   * 用字符串种子建一个随机源。
   *
   * 返回的 next 是真正的取数入口，count 与内部序列保持同步；
   * 控制器只需要保存 count，读档时按它快进。
   *
   * @param {string} seedStr 种子串
   * @returns {{ next: function(): number, count: number }}
   */
  function create(seedStr) {
    var source = mulberry32(hashString(seedStr));

    var api = {
      count: 0,
      next: function () {
        var value = source();
        api.count = source.count;
        return value;
      }
    };

    return api;
  }

  /**
   * skip 允许的最大步数。
   *
   * 一局 240 步、每步最多取 4 个数，正常存档远小于这个量级；
   * 挡住的是手改/损坏存档写进来的 1e12 这类值 —— 线性空转会卡住首帧。
   */
  var MAX_SKIP = 100000;

  /**
   * 快进 n 步，用于从存档恢复序列位置。
   * 接受 create() 返回的对象，也接受裸的 mulberry32 函数。
   *
   * 非有限（Infinity / NaN）或超过 MAX_SKIP 的步数一律按 0 处理：
   * 宁可丢掉种子位置（这一局接下来长出的方块不再和原局面一致），
   * 也不能为了复现而把页面冻死在启动阶段。
   *
   * @param {object|function} rng 随机源
   * @param {number} n 跳过的步数；负数/非数字/超大值按 0 处理
   */
  function skip(rng, n) {
    var raw = Number(n);
    var steps = isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    if (steps > MAX_SKIP) steps = 0;

    if (!rng || steps === 0) return;

    if (typeof rng === 'function') {
      for (var i = 0; i < steps; i++) rng();
      return;
    }

    if (typeof rng.next === 'function') {
      for (var j = 0; j < steps; j++) rng.next();
    }
  }

  /** 两位补零 */
  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  /**
   * 本地时区的日期键：YYYYMMDD，月/日补零。
   * 刻意不用 toISOString：它是 UTC，晚上八点之后会算成第二天。
   *
   * @param {Date} date 日期对象；不传则用当前时间
   * @returns {string} 形如 '20261107'；非法日期返回 ''
   */
  function dateKey(date) {
    var d = date instanceof Date ? date : new Date();
    if (isNaN(d.getTime())) return '';
    return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  /**
   * 日期键转展示文案：'20261107' -> '11月7日'（不补零）。
   *
   * @param {string} key 8 位日期键
   * @returns {string} 非法键返回 ''
   */
  function dateLabel(key) {
    if (!isDateKey(key)) return '';
    return Number(key.slice(4, 6)) + '月' + Number(key.slice(6, 8)) + '日';
  }

  /**
   * 是否是合法的日期键：8 位纯数字，且落在 20000101..29991231 之间。
   * 只认字符串 —— 存档里写成数字属于脏数据，交给调用方回退。
   *
   * @param {*} value 待校验的值
   * @returns {boolean}
   */
  function isDateKey(value) {
    if (typeof value !== 'string' || value.length !== 8) return false;

    for (var i = 0; i < 8; i++) {
      var code = value.charCodeAt(i);
      if (code < 48 || code > 57) return false;
    }

    var number = Number(value);
    return number >= 20000101 && number <= 29991231;
  }

  return {
    hashString: hashString,
    mulberry32: mulberry32,
    create: create,
    skip: skip,
    dateKey: dateKey,
    dateLabel: dateLabel,
    isDateKey: isDateKey
  };
});
