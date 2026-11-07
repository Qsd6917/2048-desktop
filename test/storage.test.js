/**
 * js/storage.js 单元测试（纯 Node，无依赖）
 * 运行：node test/storage.test.js
 *
 * 为什么单独测：storage.js 是 IIFE + `window` 宿主，整份逻辑跑在浏览器里，
 * 但它的核心承诺（写不进去时不能骗人）在浏览器里极难复现——配额满、隐私模式
 * 收紧都是环境态。这里用假的 localStorage 把「探测能写、正式写失败」精确造出来。
 *
 * 覆盖：
 *   1. localStorage 整体不可用（连读属性都抛）→ 全部走内存，不冒异常；
 *   2. 探测通过、正式写入抛 QuotaExceededError → 降级到内存并重写，
 *      不抛异常、返回值不撒谎、刚写的值立刻读得回来；
 *   3. 降级前的历史统计不能在界面上凭空消失；
 *   4. 旧存档 / 坏 JSON / 负数 / 非数字 → loadStats 补默认值，绝不抛。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'storage.js'), 'utf8');

let pass = 0;
let fail = 0;

function ok(name, condition, detail) {
  if (condition) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail === undefined ? '' : '\n        ' + detail));
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, '实际 ' + a + '\n        期望 ' + e);
}

/**
 * 可控的假 localStorage。
 *
 * @param {{limitWrites?: number, throwOnAccess?: boolean, noIteration?: boolean}} options
 *        limitWrites：前 N 次 setItem 成功，之后抛 QuotaExceededError
 *        （探测正好用掉 1 次写入，所以 limitWrites=1 就是「探测通过、正式写失败」）
 *        noIteration：不提供 length / key(i)，模拟不支持遍历的旧后端
 */
function fakeLocalStorage(options) {
  const opts = options || {};
  const data = Object.create(null);
  let writes = 0;

  const ls = {
    data: data,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      writes++;
      if (typeof opts.limitWrites === 'number' && writes > opts.limitWrites) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
    /** 测试中途收紧配额（模拟玩到一半写满） */
    limitAfter(n) {
      opts.limitWrites = n;
    },
    writes() {
      return writes;
    }
  };

  // 真 localStorage 支持按序号遍历；降级时的「整体搬迁」就靠这两个
  if (!opts.noIteration) {
    Object.defineProperty(ls, 'length', {
      get() {
        return Object.keys(data).length;
      }
    });
    ls.key = function (i) {
      const keys = Object.keys(data);
      return i >= 0 && i < keys.length ? keys[i] : null;
    };
  }

  if (opts.throwOnAccess) {
    // 隐私模式下连访问方法属性本身都抛异常
    ['getItem', 'setItem', 'removeItem'].forEach(function (name) {
      Object.defineProperty(ls, name, {
        get() {
          throw new Error('SecurityError');
        }
      });
    });
  }

  return ls;
}

/** 在沙箱里加载 storage.js，返回挂在假 window 上的 API */
function loadStorage(localStorage) {
  const win = { localStorage: localStorage };
  const sandbox = { window: win };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'js/storage.js' });
  if (!win.Game2048Storage) throw new Error('storage.js 没有挂载 Game2048Storage');
  return win.Game2048Storage;
}

/* ---------- 1. localStorage 整体不可用 ---------- */

console.log('\nlocalStorage 不可用时的内存降级');

{
  const S = loadStorage(fakeLocalStorage({ throwOnAccess: true }));
  let threw = false;
  try {
    S.set(S.KEYS.state, { a: 1 });
  } catch (e) {
    threw = true;
  }
  ok('set 不抛异常', threw === false);
  eq('刚写的值能读回来', S.get(S.KEYS.state, null), { a: 1 });
  eq('没写过的键返回 fallback', S.get('nope', 'fb'), 'fb');
}

/* ---------- 2. 探测通过、正式写入失败 ---------- */

console.log('\n探测通过但写入抛 QuotaExceededError');

{
  const ls = fakeLocalStorage({ limitWrites: 1 });   // 只允许探测那一次写
  const S = loadStorage(ls);

  let threw = false;
  let result = null;
  try {
    result = S.set(S.KEYS.state, { board: [1, 2, 3], score: 42 });
  } catch (e) {
    threw = true;
  }

  ok('set 不抛异常', threw === false);
  ok('set 返回 true（内存降级算写成功）', result === true, '实际 ' + result);
  eq('降级后 get 立刻读得到刚写的值', S.get(S.KEYS.state, null), { board: [1, 2, 3], score: 42 });

  // 关键对比：真实 localStorage 里确实没有（写失败了），
  // 但接口层面必须自洽 —— 否则界面显示「已保存」而刷新后全丢。
  ok('真实存储里确实没有这份数据（前提成立）',
    ls.getItem('game2048.v2.state') === null, String(ls.getItem('game2048.v2.state')));
}

/* ---------- 3. 降级不丢历史统计 ---------- */

console.log('\n降级时把旧数据搬进内存');

{
  const ls = fakeLocalStorage();
  const S = loadStorage(ls);

  S.saveStats({ games: 3, bestScore: 4096, bestTile: 512, totalMoves: 120, bySize: { 4: { games: 3, bestScore: 4096 } } });
  eq('统计先正常落盘', S.loadStats().games, 3);

  ls.limitAfter(ls.writes());   // 从下一次写入开始配额满

  ok('后续写入降级成功', S.set(S.KEYS.state, { score: 7 }) === true);
  eq('降级后历史统计还在', S.loadStats().games, 3);
  eq('降级后新写的数据也在', S.get(S.KEYS.state, null), { score: 7 });
  eq('saveStats 也能在降级后写成功', S.saveStats({ games: 4 }), true);
  eq('降级后统计读得到最新值', S.loadStats().games, 4);
}

/* ---------- 4. 坏存档一律补默认值 ---------- */

console.log('\n旧存档与坏数据');

{
  const ls = fakeLocalStorage();
  ls.data['game2048.v2.stats'] = JSON.stringify({ games: '3', bestScore: -5 });
  const S = loadStorage(ls);

  const stats = S.loadStats();
  eq('缺字段补 0', stats, { games: 3, bestScore: 0, bestTile: 0, totalMoves: 0, bySize: {} });
}

{
  const ls = fakeLocalStorage();
  ls.data['game2048.v2.stats'] = '{ 这不是 JSON';
  const S = loadStorage(ls);
  eq('坏 JSON 退回默认统计', S.loadStats(), { games: 0, bestScore: 0, bestTile: 0, totalMoves: 0, bySize: {} });
}

{
  const ls = fakeLocalStorage();
  ls.data['game2048.v2.stats'] = JSON.stringify({
    games: 2.9,
    bestScore: 'abc',
    bestTile: null,
    totalMoves: Infinity,
    bySize: { 5: { games: '1', bestScore: -3 }, bad: 'x' }
  });
  const S = loadStorage(ls);
  eq('非数字/负数/小数都被折成非负整数', S.loadStats(), {
    games: 2,
    bestScore: 0,
    bestTile: 0,
    totalMoves: 0,
    bySize: { 5: { games: 1, bestScore: 0 } }
  });
}

/* ---------- 5. 序列化失败 ---------- */

console.log('\n无法序列化的值');

{
  const S = loadStorage(fakeLocalStorage());
  const cyclic = {};
  cyclic.self = cyclic;
  eq('循环引用返回 false 而不是抛异常', S.set('state', cyclic), false);
  eq('写失败后读回 fallback', S.get('state', 'none'), 'none');
  eq('undefined 也不写入', S.set('state', undefined), false);
}

/* ---------- 6. 存档盘面校验（isValidCell / validateValues） ---------- */

console.log('\n存档盘面校验');

{
  const S = loadStorage(fakeLocalStorage());

  // 单格白名单：该收的收
  ok('空格 null 合法', S.isValidCell(null) === true);
  ok('空格 0 合法', S.isValidCell(0) === true);
  ok('障碍 -1 合法', S.isValidCell(-1) === true);
  ok('方块 2 合法', S.isValidCell(2) === true);
  ok('方块 1024 合法', S.isValidCell(1024) === true);
  ok('上限 2^30 合法', S.isValidCell(Math.pow(2, 30)) === true);

  // 单格白名单：该拒的拒（脏存档曾让合并算出 NaN，这里逐条钉死）
  ok('字符串 "2" 拒', S.isValidCell('2') === false);
  ok('负数 -3 拒', S.isValidCell(-3) === false);
  ok('1 拒', S.isValidCell(1) === false);
  ok('非 2 的幂 6 拒', S.isValidCell(6) === false);
  ok('小数 2.5 拒', S.isValidCell(2.5) === false);
  ok('超上限 2^31 拒', S.isValidCell(Math.pow(2, 31)) === false);
  ok('NaN 拒', S.isValidCell(NaN) === false);
  ok('Infinity 拒', S.isValidCell(Infinity) === false);
  ok('undefined 拒', S.isValidCell(undefined) === false);
  ok('数组拒', S.isValidCell([]) === false);
  ok('对象拒', S.isValidCell({}) === false);

  // 整盘形状 + 取值：该收的收
  const good4 = [
    [2, 0, 0, -1],
    [0, 4, 0, 0],
    [0, 0, 1024, 0],
    [0, 0, 0, 2]
  ];
  const good5 = [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 2, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, -1]
  ];
  ok('4×4 合法盘面通过', S.validateValues(good4, 4) === true);
  ok('5×5 合法盘面通过', S.validateValues(good5, 5) === true);

  // 整盘形状 + 取值：该拒的拒
  ok('非数组拒绝', S.validateValues('x', 4) === false);
  ok('行数不足拒绝', S.validateValues([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4) === false);
  ok('行长度不足拒绝', S.validateValues([[0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4) === false);
  ok('行不是数组拒绝', S.validateValues([0, 0, 0, 0], 4) === false);
  ok('含字符串脏值拒绝', S.validateValues([[2, '2', 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4) === false);
  ok('含非 2 幂脏值拒绝', S.validateValues([[6, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4) === false);
  ok('含超上限脏值拒绝', S.validateValues([[Math.pow(2, 31), 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4) === false);
  ok('含非法负数拒绝', S.validateValues([[-3, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4) === false);
  ok('尺寸与盘面不符拒绝', S.validateValues(good5, 4) === false);
}

/* ---------- 7. 降级时把动态键整条搬进内存 ---------- */

console.log('\n配额降级时整条搬迁（含 review.<日期> 动态键）');

{
  const ls = fakeLocalStorage();
  const S = loadStorage(ls);

  // 复盘键是 review.<YYYYMMDD>，不在 KEYS 里：只按 KEYS 搬会把它丢在旧后端
  const review = { date: '20261107', moves: [{ d: 'left', v: [[2, 0], [0, 0]], g: 4 }], summary: { scored: 1 } };
  ok('复盘先正常落盘', S.set('review.20261107', review) === true);
  eq('前置：真实存储里确实有这条复盘', ls.getItem('game2048.v2.review.20261107') !== null, true);
  S.saveStats({ games: 2, bestScore: 64 });

  ls.limitAfter(ls.writes());   // 从下一次写入开始配额满 → 触发降级

  ok('触发降级的写入仍算成功', S.set(S.KEYS.state, { score: 1 }) === true);
  eq('降级后 review.<今日-键> 能取回原值', S.get('review.20261107', null), review);
  eq('降级后统计也还在（整体搬迁没漏掉固定键）', S.loadStats().games, 2);
  eq('降级后新写的数据也在', S.get(S.KEYS.state, null), { score: 1 });
}

{
  // 旧后端不支持 length / key(i)：退回按 KEYS 逐个搬，至少保住固定键
  const ls = fakeLocalStorage({ noIteration: true });
  const S = loadStorage(ls);

  S.saveStats({ games: 5 });
  ls.limitAfter(ls.writes());

  ok('不支持遍历时降级写入仍成功', S.set(S.KEYS.state, { score: 2 }) === true);
  eq('退回逐个搬也能保住统计', S.loadStats().games, 5);
  eq('新写的数据读得到', S.get(S.KEYS.state, null), { score: 2 });
}

/* ---------- 8. 降级后 remove 同时删旧后端 ---------- */

console.log('\n降级后 remove 不能让旧档复活');

{
  const ls = fakeLocalStorage();
  const S = loadStorage(ls);

  S.set(S.KEYS.state, { score: 10, values: [[2]] });
  eq('前置：旧后端里有这份存档', ls.getItem('game2048.v2.state') !== null, true);

  ls.limitAfter(ls.writes());      // 下一次写入开始配额满 → 触发降级
  ok('触发降级的写入仍算成功', S.set(S.KEYS.stats, { games: 1 }) === true);
  eq('降级后仍读得到旧存档（已搬进内存）', S.get(S.KEYS.state, null), { score: 10, values: [[2]] });

  S.remove(S.KEYS.state);
  eq('内存里的存档删掉了', S.get(S.KEYS.state, null), null);
  eq('旧 localStorage 里的同一份也删掉了', ls.getItem('game2048.v2.state'), null);
}

{
  // 旧后端连 removeItem 都抛异常：remove 不能把异常冒出来
  const ls = fakeLocalStorage();
  const S = loadStorage(ls);
  S.set(S.KEYS.state, { score: 1 });
  ls.limitAfter(ls.writes());
  S.set(S.KEYS.stats, { games: 1 });

  ls.removeItem = function () {
    throw new Error('SecurityError');
  };

  let threw = false;
  try {
    S.remove(S.KEYS.state);
  } catch (e) {
    threw = true;
  }
  ok('旧后端删除抛异常时 remove 也不冒泡', threw === false);
  eq('内存里的那份仍然删掉了', S.get(S.KEYS.state, null), null);
}

/* ---------- 汇总 ---------- */

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
