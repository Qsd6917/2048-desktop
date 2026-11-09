/**
 * 双人对战纯函数测试（纯 Node，无依赖）
 * 运行：node test/duel.test.js
 *
 * 只测比分归属与胜负判定这一层；DOM、存档、回合文案由 app.e2e.js 在浏览器里验证。
 * 局面外的所有数字都刻意用「坏输入」试一遍：双人比分是玩家看得见的数，不能被
 * NaN / 负数 / 越界回合悄悄带进界面。
 */
const assertDocument = typeof document;

const Duel = require('../js/duel.js');

let pass = 0;
let fail = 0;

function str(value) {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function eq(name, actual, expected) {
  if (str(actual) === str(expected)) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + '\n        实际 ' + str(actual) + '\n        期望 ' + str(expected));
  }
}

function ok(name, condition, detail) {
  if (condition) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail === undefined ? '' : '\n        ' + detail));
  }
}

function group(name, fn) {
  console.log('\n' + name);
  try {
    fn();
  } catch (err) {
    fail++;
    console.log('  FAIL  分组执行异常: ' + (err && err.message ? err.message : err));
  }
}

group('加载约定：Node 下不碰 document', () => {
  eq('require 前 document 不存在', assertDocument, 'undefined');
  eq('require 后 document 仍然不存在', typeof document, 'undefined');
  eq('导出的接口齐全',
    ['attribute', 'nextTurn', 'winnerOf', 'scoreOf'].filter(
      (key) => typeof Duel[key] !== 'function'
    ),
    []);
  eq('固定两人', Duel.PLAYER_COUNT, 2);
});

group('分数归属', () => {
  eq('先手合并得分记在玩家 1 头上', Duel.attribute([0, 0], 0, 4), [4, 0]);
  eq('后手合并得分记在玩家 2 头上', Duel.attribute([4, 0], 1, 8), [4, 8]);

  // 一次移动合并两组（2+2 与 2+2），gained 是 8：整步合计都归同一个人
  eq('一步多次合并的合计归属同一个人', Duel.attribute([0, 0], 0, 8), [8, 0]);
  eq('合计不是逐组合并后的翻倍值', Duel.attribute([0, 0], 1, 12), [0, 12]);

  const before = [4, 8];
  const after = Duel.attribute(before, 0, 6);
  eq('返回新数组，不改动入参', before, [4, 8]);
  ok('返回的数组与入参不是同一个引用', after !== before);

  eq('没有得分时比分不变', Duel.attribute([4, 8], 1, 0), [4, 8]);

  // 连续两步换人：归属必须跟着回合走
  let players = [0, 0];
  players = Duel.attribute(players, 0, 4);
  players = Duel.attribute(players, Duel.nextTurn(0), 16);
  players = Duel.attribute(players, 0, 32);
  eq('换人后归属切换（0→1→0）', players, [36, 16]);
  eq('nextTurn(0) 是 1', Duel.nextTurn(0), 1);
  eq('nextTurn(1) 是 0', Duel.nextTurn(1), 0);
});

group('比分读取', () => {
  eq('读玩家 1 的分数', Duel.scoreOf([12, 34], 0), 12);
  eq('读玩家 2 的分数', Duel.scoreOf([12, 34], 1), 34);
  eq('缺位按 0 补齐', Duel.scoreOf([12], 1), 0);
  eq('非数组按两人 0 分处理', Duel.scoreOf(null, 0), 0);
});

group('死局比分比较', () => {
  eq('玩家 1 分高时玩家 1 获胜', Duel.winnerOf([16, 8]), 0);
  eq('玩家 2 分高时玩家 2 获胜', Duel.winnerOf([8, 16]), 1);
  eq('0:0 是平局', Duel.winnerOf([0, 0]), null);
  eq('分数相同是平局', Duel.winnerOf([1024, 1024]), null);
  eq('空数组按 0:0 平局', Duel.winnerOf([]), null);
});

// safeScore 没有单独导出（对外只暴露比分语义的几个函数），所以行为统一从
// attribute / winnerOf 的返回值反推：测的就是调用方真实拿到的东西，
// 不会出现「私有函数对、公开路径错」。
//
// 上界值在这里钉死 1e9、刻意不去读 app.js：本文件是 duel.js 的单测，不该依赖另一个
// 模块（app.js 正被并行修改）。跨文件口径的一致性写在 duel.js 的常量注释里。
group('分数上界与人数（与 app.js 的 SAVE_MAX_SCORE 同口径）', () => {
  const MAX = Duel.MAX_SCORE;

  // 1e9 必须与 app.js 的 SAVE_MAX_SCORE 一致：改一处必须改两处
  eq('上界常量是 1e9（与 app.js 的 SAVE_MAX_SCORE 同值）', MAX, 1e9);

  eq('attribute 返回的数组长度等于 PLAYER_COUNT',
    Duel.attribute([], 0, 0).length, Duel.PLAYER_COUNT);
  eq('入参不是数组时长度仍是 PLAYER_COUNT',
    Duel.attribute(null, 1, 0).length, Duel.PLAYER_COUNT);
  eq('缺位补齐后长度不变',
    Duel.attribute([7], 0, 0).length, Duel.PLAYER_COUNT);

  eq('超上界的单步得分被钳到上界', Duel.attribute([0, 0], 0, 1e12), [MAX, 0]);
  // 两边都越过上界时必须钳成同一个数，否则「谁分高」会取决于原始脏值的大小
  eq('两个超上界比分钳成平局', Duel.winnerOf([1e12, MAX + 5]), null);
  eq('上界外侧的小数取整后仍被钳住', Duel.attribute([0, 0], 0, MAX + 1.5), [MAX, 0]);
  // 这两条与「坏输入防护」里的 Infinity / 负分重复，但任务要求 safeScore 的三种坏输入
  // 在本组内自成一组可读的规格，重复两行比让人跨组拼凑口径更值
  eq('Infinity 得分归 0', Duel.attribute([0, 0], 0, Infinity), [0, 0]);
  eq('负数得分归 0', Duel.attribute([0, 0], 0, -1), [0, 0]);
  eq('正常得分不受钳制影响', Duel.attribute([0, 0], 0, 2048), [2048, 0]);

  // 上界附近再入账：必须停在 MAX，不能靠 JS 浮点自然溢出
  const nearMax = Duel.attribute([MAX - 10, 0], 0, 100);
  eq('上界附近累加被钳在上界', nearMax, [MAX, 0]);
  ok('上界附近累加的结果不是 Infinity', isFinite(nearMax[0]), '实际 ' + nearMax[0]);

  // 连续累加：真溢出会变成 Infinity，之后判胜/显示全被污染
  let tally = [0, 0];
  for (let i = 0; i < 100; i++) {
    tally = Duel.attribute(tally, 0, MAX);
  }
  eq('连续 100 次满上界入账仍停在上界', tally, [MAX, 0]);
  ok('连续累加后仍是有限数', isFinite(tally[0]) && isFinite(tally[1]),
    '实际 ' + str(tally));

  // 既有契约：normalize / attribute 都不就地修改入参
  const dirty = [1e12, -1];
  Duel.attribute(dirty, 0, 4);
  eq('normalize 不修改入参数组', dirty, [1e12, -1]);
  const clean = [4, 8];
  Duel.attribute(clean, 1, 16);
  eq('合法入参数组也不会被就地改写', clean, [4, 8]);
});

group('坏输入防护', () => {
  eq('负分不进账', Duel.attribute([0, 0], 0, -8), [0, 0]);
  eq('NaN 不进账', Duel.attribute([0, 0], 0, NaN), [0, 0]);
  eq('Infinity 不进账', Duel.attribute([0, 0], 1, Infinity), [0, 0]);
  eq('小数向下取整', Duel.attribute([0, 0], 0, 7.9), [7, 0]);
  eq('字符串数字照常接受', Duel.attribute([0, 0], 0, '4'), [4, 0]);

  eq('脏比分在入账时归零', Duel.attribute([NaN, -3], 0, 4), [4, 0]);
  eq('脏比分在判胜时归零', Duel.winnerOf([NaN, 2]), 1);
  eq('两个脏比分是平局', Duel.winnerOf([Infinity, -1]), null);

  eq('越界回合按玩家 2 处理（与读档钳制一致）', Duel.attribute([0, 0], 5, 4), [0, 4]);
  eq('负回合按先手处理', Duel.attribute([0, 0], -2, 4), [4, 0]);
  eq('回合缺省按先手处理', Duel.attribute([0, 0], undefined, 4), [4, 0]);
});

console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
