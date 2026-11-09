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

  /**
   * 降级前的真实后端：**只在首次降级那一刻记录一次**，之后不再改动。
   *
   * 降级后本会话不再切回真实 localStorage，读写都落在内存；可旧后端里那份数据
   * 还留在磁盘上，必须由内存后端替它「代言」，否则配额恢复后刷新会读到降级前的
   * 旧档。具体有两处补偿，都依赖这个引用：
   *   - `set` 写成功时同时回灌一份到旧后端（见 mirrorToPrevious）：否则降级会话里
   *     玩出来的新进度只存在内存，刷新后 localStorage 里仍是旧值 —— 这一局白玩；
   *   - `remove` 同时删掉旧后端那份（见 remove）：否则已删掉的存档会「复活」。
   *
   * 为什么只记一次：若因为异常再进一次降级（当前代码路径不可达，见
   * degradeToMemory 里的守卫），那一刻的 `backend` 已经是内存后端，覆盖赋值会把
   * 真实 localStorage 的引用换成内存替身；`previousBackend === backend` 之后，
   * 上面两处补偿就全部退化成空操作，而且再也无法恢复。
   */
  var previousBackend = null;

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

  /** 把一个已知的全前缀键从旧后端读进内存；读不到 / 读失败就跳过 */
  function copyKey(previous, fullKey) {
    try {
      var raw = previous.getItem(fullKey);
      if (raw !== null && raw !== undefined) memory[fullKey] = String(raw);
    } catch (e) {
      /* 旧后端已经连读都读不了，那就只能放弃这部分数据 */
    }
  }

  /**
   * 整体搬迁：遍历旧后端的全部键，凡是本应用前缀的整条搬进内存。
   *
   * 只按 KEYS 搬是不够的：复盘键是 review.<YYYYMMDD> 这种动态键，
   * 不在 KEYS 里。配额降级后当天的复盘会从会话里消失，
   * 复盘抽屉直接退回空状态。
   *
   * @returns {boolean} 旧后端支持遍历则返回 true（即使中途跳过某些键）
   */
  function migrateAllKeys(previous) {
    if (typeof previous.length !== 'number' || typeof previous.key !== 'function') return false;

    var total = previous.length;
    for (var i = 0; i < total; i++) {
      var fullKey = previous.key(i);
      if (typeof fullKey !== 'string' || fullKey.indexOf(PREFIX) !== 0) continue;
      copyKey(previous, fullKey);
    }
    return true;
  }

  /**
   * 切换到内存后备。
   *
   * 切换前先把旧后端里还能读到的键（含全前缀）搬进内存：
   * 典型场景是「探测时写得进去、玩到一半配额满」——若直接换空内存，
   * 界面上的历史统计会当场归零，比存不进去更吓人。
   *
   * 优先整体搬迁（连 review.<date> 这类动态键一起带走）；
   * 旧后端不支持 length/key 或中途抛异常时，退回按 KEYS 逐个搬。
   *
   * 同时记下旧后端引用（只在首次降级时记，见 previousBackend 注释）：
   * 降级会话里的 `set` / `remove` 要拿它做补偿，把新值回灌、把删掉的键删干净。
   */
  function degradeToMemory() {
    var previous = backend;
    var next = createMemoryBackend();

    if (previous) {
      // 只记录一次：已有真实旧后端时不再覆盖。若这里被改成无条件赋值，
      // 重复降级会把 previousBackend 覆盖成内存后端自身，补偿逻辑随即全部失效。
      if (!previousBackend) previousBackend = previous;

      var migrated = false;
      try {
        migrated = migrateAllKeys(previous);
      } catch (e) {
        migrated = false;   // 遍历到一半失败：已经搬进去的留着，剩下的按 KEYS 补
      }

      if (!migrated) {
        Object.keys(KEYS).forEach(function (name) {
          copyKey(previous, PREFIX + KEYS[name]);
        });
      }
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
   * 把一次写入回灌到降级前的旧后端（补偿，配合 previousBackend 注释看）。
   *
   * 只在「本会话已经降级过」时才有意义：previousBackend 存在，且它不是当前
   * 后端（降级后再降级会把两者指向同一个内存对象，那时回灌纯属自欺）。
   *
   * 旧后端写失败一律吞掉，理由有两条：
   *   1. 当初就是因为它写不进去（配额满 / 隐私策略收紧）才降级的，此刻再失败
   *      属于同一类环境问题，调用方既补救不了、也不该被迫处理；
   *   2. 内存那份已经写成功了，本次会话读得到正确数据，把异常冒到控制器只会
   *      让游戏卡在报错上，比静默降级更糟。
   */
  function mirrorToPrevious(fullKey, payload) {
    if (!previousBackend || previousBackend === backend) return;
    try {
      previousBackend.setItem(fullKey, payload);
    } catch (e) {
      /* 旧后端仍不可写：放弃补偿，内存那份已生效 */
    }
  }

  /**
   * 写一个 JSON 值。
   *
   * 探测阶段能写、真写时却失败（配额满 / 隐私策略收紧 / 无痕配额为 0）时，
   * 必须降级到内存并立刻重写一次 —— 否则界面显示「已保存」，刷新后却什么都没了。
   * 降级后的写入算成功（本次会话内读得到），真正的持久化失败调用方无法补救。
   *
   * 降级会话里每次写成功还要回灌一份到旧后端（mirrorToPrevious）：
   * 否则新值只活在内存里，配额一恢复、页面一刷新，读到的还是降级前的旧值，
   * 这一局等于白玩。回灌失败不影响返回值，见该函数的注释。
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
    var written = false;

    // 第一步只管「内存/真实后端写进去了没有」。回灌放在 try 外面，
    // 免得补偿逻辑日后出问题时被误判成后端写失败、把成功谎报成失败。
    try {
      getBackend().setItem(fullKey, payload);
      written = true;
    } catch (e) {
      degradeToMemory();
    }

    if (!written) {
      try {
        getBackend().setItem(fullKey, payload);
        written = true;
      } catch (e2) {
        return false;
      }
    }

    // 第二步：已经降级过的会话，把新值同步一份回真实 localStorage。
    // 无论本次是「早就降级了」还是「刚刚才降级」，都要回灌。
    mirrorToPrevious(fullKey, payload);
    return true;
  }

  /**
   * 删一个键。
   *
   * 降级到内存后删的是内存那份；真实 localStorage 里的同一份必须一起删，
   * 否则配额恢复后刷新会把旧档读回来。旧后端可能连 removeItem 都抛异常，
   * 这里一律吞掉：删不掉是环境问题，不该冒到控制器。
   */
  function remove(key) {
    var fullKey = PREFIX + key;
    try {
      getBackend().removeItem(fullKey);
    } catch (e) {
      /* 忽略 */
    }

    if (previousBackend && previousBackend !== backend) {
      try {
        previousBackend.removeItem(fullKey);
      } catch (e2) {
        /* 旧后端已经不可写，放弃补偿 */
      }
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
