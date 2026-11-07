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
