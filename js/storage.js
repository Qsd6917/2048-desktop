/**
 * 2048 本地存储 —— localStorage 的安全封装 + 统计读写。
 *
 * 设计要点：
 *   - file:// 或隐私模式下 localStorage 可能整体不可用（连访问属性都抛异常），
 *     这里探测一次后降级成内存对象，游戏照常能玩，只是刷新后不保留；
 *   - 探测通过不代表一直写得进去（配额满、策略收紧）：set 失败时同样降级到内存
 *     并重写一次，绝不出现「界面说存了、刷新后没了」；
 *   - 键名统一加 `game2048.v2.` 前缀，和旧版 `game2048.state` / `game2048.best` 彻底隔离；
 *   - 值一律走 JSON，读到坏数据（手改、旧格式、截断）时返回调用方给的 fallback，
 *     绝不让异常冒到控制器里。
 */
(function (global) {
  'use strict';

  /** 存档命名空间：旧版键不再读取 */
  var PREFIX = 'game2048.v2.';

  /** 控制器使用的固定键（不含前缀，写盘后是 game2048.v2.state 等） */
  var KEYS = {
    state: 'state',
    stats: 'stats',
    settings: 'settings',
    daily: 'daily',
    // 复盘按天存：实际键名是 review.<YYYYMMDD>，拼在 review 后面
    review: 'review',
    // 成就 / 档案（Task 4 用）
    profile: 'profile'
  };

  /** 统计的默认形状；每次返回都是新对象，调用方随便改 */
  var DEFAULT_STATS = {
    games: 0,
    bestScore: 0,
    bestTile: 0,
    totalMoves: 0,
    bySize: {}
  };

  var PROBE_KEY = PREFIX + '__probe__';

  /** 内存后备，键不带前缀（前缀在 get/set 里统一加） */
  var memory = Object.create(null);

  /** 探测结果：真实 localStorage 或内存替身；null 表示还没探测 */
  var backend = null;

  function createMemoryBackend() {
    return {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
      },
      setItem: function (key, value) {
        memory[key] = String(value);
      },
      removeItem: function (key) {
        delete memory[key];
      }
    };
  }

  /**
   * 切换到内存后备。
   *
   * 切换前先把旧后端里还能读到的已知键（含全前缀）搬进内存：
   * 典型场景是「探测时写得进去、玩到一半配额满」——若直接换空内存，
   * 界面上的历史统计会当场归零，比存不进去更吓人。
   */
  function degradeToMemory() {
    var previous = backend;
    var next = createMemoryBackend();
    if (previous) {
      Object.keys(KEYS).forEach(function (name) {
        var fullKey = PREFIX + KEYS[name];
        try {
          var raw = previous.getItem(fullKey);
          if (raw !== null && raw !== undefined) memory[fullKey] = String(raw);
        } catch (e) {
          /* 旧后端已经连读都读不了，那就只能放弃这部分数据 */
        }
      });
    }
    backend = next;
  }

  /** 探测一次就缓存结果，避免每次读写都踩异常 */
  function getBackend() {
    if (backend) return backend;

    try {
      var ls = global.localStorage;
      if (!ls) throw new Error('no localStorage');
      ls.setItem(PROBE_KEY, '1');
      ls.removeItem(PROBE_KEY);
      backend = ls;
    } catch (e) {
      backend = createMemoryBackend();
    }
    return backend;
  }

  /**
   * 读一个 JSON 值。
   * @param {string} key 不含前缀的键名
   * @param {*} fallback 读不到 / 解析失败时返回的值
   */
  function get(key, fallback) {
    var raw;
    try {
      raw = getBackend().getItem(PREFIX + key);
    } catch (e) {
      return fallback;
    }
    if (raw === null || raw === undefined || raw === '') return fallback;

    try {
      var value = JSON.parse(raw);
      return value === null || value === undefined ? fallback : value;
    } catch (e) {
      return fallback;   // 坏数据直接当没存过
    }
  }

  /**
   * 写一个 JSON 值。
   *
   * 探测阶段能写、真写时却失败（配额满 / 隐私策略收紧 / 无痕配额为 0）时，
   * 必须降级到内存并立刻重写一次 —— 否则界面显示「已保存」，刷新后却什么都没了。
   * 降级后的写入算成功（本次会话内读得到），真正的持久化失败调用方无法补救。
   *
   * @returns {boolean} 是否写成功（内存降级也算成功）
   */
  function set(key, value) {
    var payload;
    try {
      payload = JSON.stringify(value);
    } catch (e) {
      return false;   // 循环引用之类，无解
    }
    if (payload === undefined) return false;

    var fullKey = PREFIX + key;
    try {
      getBackend().setItem(fullKey, payload);
      return true;
    } catch (e) {
      degradeToMemory();
    }

    try {
      getBackend().setItem(fullKey, payload);
      return true;
    } catch (e2) {
      return false;
    }
  }

  function remove(key) {
    try {
      getBackend().removeItem(PREFIX + key);
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 非负整数，脏数据一律折成 0 */
  function toCount(value) {
    var number = Number(value);
    if (!isFinite(number) || number <= 0) return 0;
    return Math.floor(number);
  }

  /**
   * 存档里的一格只能是：null/0 空格、-1 障碍、2 的正整数次幂方块（上限 2^30）。
   *
   * 合法 JSON 也可能装着脏数据（手改 / 别的脚本写坏），逐格校验，
   * 否则 boardFromValues 会造出 value 为字符串的方块，之后合并全变 NaN。
   */
  function isValidCell(value) {
    if (value === null || value === 0 || value === -1) return true;
    if (typeof value !== 'number' || !isFinite(value) || value < 2) return false;
    var exponent = Math.log2(value);
    return exponent === Math.floor(exponent) && exponent <= 30;
  }

  /**
   * 校验存档盘面：必须是 size×size 方阵，且每格取值合法。
   *
   * @param {*} values 待校验的二维数组
   * @param {number} size 期望的棋盘边长（4/5/6）
   * @returns {boolean} 全部合法才返回 true
   */
  function validateValues(values, size) {
    if (!Array.isArray(values) || values.length !== size) return false;
    for (var r = 0; r < size; r++) {
      if (!Array.isArray(values[r]) || values[r].length !== size) return false;
      for (var c = 0; c < size; c++) {
        if (!isValidCell(values[r][c])) return false;
      }
    }
    return true;
  }

  /**
   * 把任意来源的统计对象整理成完整结构：
   * 缺字段补 0、多余字段丢弃、bySize 里每一项也补齐。
   */
  function normalizeStats(raw) {
    var stats = {
      games: 0,
      bestScore: 0,
      bestTile: 0,
      totalMoves: 0,
      bySize: {}
    };
    if (!raw || typeof raw !== 'object') return stats;

    stats.games = toCount(raw.games);
    stats.bestScore = toCount(raw.bestScore);
    stats.bestTile = toCount(raw.bestTile);
    stats.totalMoves = toCount(raw.totalMoves);

    var bySize = raw.bySize;
    if (bySize && typeof bySize === 'object') {
      Object.keys(bySize).forEach(function (size) {
        var item = bySize[size];
        if (!item || typeof item !== 'object') return;
        stats.bySize[size] = {
          games: toCount(item.games),
          bestScore: toCount(item.bestScore)
        };
      });
    }

    return stats;
  }

  /** 读统计；没有存档或存档损坏时返回 DEFAULT_STATS 的深拷贝 */
  function loadStats() {
    return normalizeStats(get(KEYS.stats, null));
  }

  function saveStats(stats) {
    return set(KEYS.stats, normalizeStats(stats));
  }

  global.Game2048Storage = {
    KEYS: KEYS,
    DEFAULT_STATS: DEFAULT_STATS,
    get: get,
    set: set,
    remove: remove,
    normalizeStats: normalizeStats,
    loadStats: loadStats,
    saveStats: saveStats,
    isValidCell: isValidCell,
    validateValues: validateValues
  };
})(window);
