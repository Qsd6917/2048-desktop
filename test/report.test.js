/**
 * 2048 战报模块测试（纯 Node，无依赖）
 * 运行：node test/report.test.js
 *
 * 只测数据层与「不碰 document」的加载约定；真实绘制由 app.e2e.js 在浏览器里验证。
 * 局面用数值矩阵描述：0 空格 / -1 障碍 / 其余为方块值。
 */
const assertDocument = typeof document;

const Report = require('../js/report.js');

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

async function group(name, fn) {
  console.log('\n' + name);
  try {
    await fn();
  } catch (err) {
    fail++;
    console.log('  FAIL  分组执行异常: ' + (err && err.message ? err.message : err));
  }
}

/** 一局普通模式的基础入参 */
function baseData(extra) {
  return Object.assign({
    date: '2026-11-07',
    size: 4,
    score: 12345,
    maxTile: 1024,
    moves: 321,
    mode: 'classic',
    daily: null,
    achievements: { unlocked: 3, total: 25 },
    values: [
      [1024, 512, 64, 8],
      [32, 128, 16, 4],
      [8, 32, 2, 0],
      [4, 16, 0, 0]
    ]
  }, extra || {});
}

(async function main() {
  await group('加载约定：Node 下不碰 document', () => {
    eq('require 前 document 不存在', assertDocument, 'undefined');
    eq('require 后 document 仍然不存在', typeof document, 'undefined');
    eq('导出的接口齐全',
      ['buildModel', 'render', 'toBlob', 'fileName', 'tileColor'].filter(
        (key) => typeof Report[key] !== 'function'
      ),
      []);
    eq('没有 document 时 render 返回 null', Report.render(Report.buildModel(baseData())), null);
    eq('model 为空时 render 也返回 null', Report.render(null), null);
  });

  await group('buildModel：字段与文案', () => {
    const model = Report.buildModel(baseData());

    eq('标题固定', model.title, '2048 · 战报');
    eq('副标题是日期 + 模式', model.subtitle, '2026-11-07 · 经典模式');
    eq('四格统计的标签顺序', model.stats.map((item) => item.label),
      ['分数', '最大块', '步数', '连续天数']);
    eq('分数千分位', model.stats[0].value, '12,345');
    eq('最大块千分位', model.stats[1].value, '1,024');
    eq('步数千分位', model.stats[2].value, '321');
    eq('普通局没有连续天数口径时显示破折号', model.stats[3].value, '—');
    eq('普通局页脚', model.footer, '2048 桌面版 · 经典模式');
    eq('缩略图边长', model.thumb.size, 4);
    eq('缩略图矩阵原样保留', model.thumb.values, baseData().values);
    eq('紧凑日期供文件名使用', model.date, '20261107');
    eq('原始分数供文件名使用', model.score, 12345);
  });

  await group('buildModel：每日挑战口径', () => {
    const model = Report.buildModel(baseData({
      mode: 'timed',
      daily: { streak: 6, attempt: 3 }
    }));

    eq('副标题带模式', model.subtitle, '2026-11-07 · 限时模式');
    eq('连续天数取 daily.streak', model.stats[3].value, '6');
    eq('页脚是第几次挑战', model.footer, '2048 桌面版 · 每日挑战 第 3 次');

    const obstacle = Report.buildModel(baseData({ mode: 'obstacle' }));
    eq('障碍模式页脚跟随模式', obstacle.footer, '2048 桌面版 · 障碍模式');

    const loose = Report.buildModel(baseData({ daily: { streak: 0, attempt: 1 } }));
    eq('刚打第一次也有连续天数', loose.stats[3].value, '0');

    const noAttempt = Report.buildModel(baseData({ daily: { streak: 0, attempt: 0 } }));
    eq('次数缺失时不写「第 0 次」', noAttempt.footer, '2048 桌面版 · 每日挑战');

    const missingAttempt = Report.buildModel(baseData({ daily: { streak: 2 } }));
    eq('daily 没有 attempt 时同样省略次数', missingAttempt.footer, '2048 桌面版 · 每日挑战');
  });

  await group('buildModel：空盘面与脏数据', () => {
    const empty = Report.buildModel(baseData({
      score: 0,
      maxTile: 0,
      moves: 0,
      values: [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0]
      ]
    }));

    eq('全 0 盘面保留 4×4', empty.thumb.values, [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ]);
    eq('空格不画方块', empty.thumb.values[0].map(Report.tileColor), [null, null, null, null]);
    eq('空盘面分数显示 0', empty.stats[0].value, '0');

    const missing = Report.buildModel({});
    eq('缺参数也不崩：标题仍在', missing.title, '2048 · 战报');
    eq('缺参数兜底 4×4 全 0', missing.thumb.values, [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ]);
    eq('缺参数时日期占位', missing.date, '00000000');
    eq('缺参数时页脚是经典模式', missing.footer, '2048 桌面版 · 经典模式');
    eq('未知模式回退经典', Report.buildModel({ mode: 'unknown' }).subtitle, '经典模式');
  });

  await group('buildModel：盘面规整', () => {
    const five = Report.buildModel(baseData({
      size: 4,
      values: [
        [2, 4, 8, 16, 32],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0]
      ]
    }));
    eq('以行数为准', five.thumb.size, 5);
    eq('按 5×5 补齐', five.thumb.values.length, 5);
    eq('行内也补到 5 格', five.thumb.values[1], [0, 0, 0, 0, 0]);
    eq('超出的值保留', five.thumb.values[0][4], 32);

    const ragged = Report.buildModel(baseData({
      values: [[2, 4], [8], []]
    }));
    eq('参差矩阵按行数补 3×3', ragged.thumb.values, [
      [2, 4, 0],
      [8, 0, 0],
      [0, 0, 0]
    ]);

    const dirty = Report.buildModel(baseData({
      values: [['2', null, undefined, NaN], [Infinity, -5, -1, 4], [], []]
    }));
    eq('脏值折成空格，-1 仍是障碍', dirty.thumb.values, [
      [2, 0, 0, 0],
      [0, 0, -1, 4],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ]);

    const source = baseData();
    const model = Report.buildModel(source);
    model.thumb.values[0][0] = 9999;
    eq('模型里的矩阵是副本，不污染入参', source.values[0][0], 1024);
  });

  await group('buildModel：超大分数', () => {
    const model = Report.buildModel(baseData({ score: 9876543210 }));
    eq('十位数也带千分位', model.stats[0].value, '9,876,543,210');
    eq('文件名用原始分数', Report.fileName(model), '2048-20261107-9876543210.png');

    const negative = Report.buildModel(baseData({ score: -100 }));
    eq('负分折成 0', negative.stats[0].value, '0');
    eq('负分文件名也是 0', Report.fileName(negative), '2048-20261107-0.png');
  });

  await group('文件名校验', () => {
    eq('标准格式',
      Report.fileName(Report.buildModel(baseData({ date: '2026-11-07', score: 12345 }))),
      '2048-20261107-12345.png');
    eq('接受紧凑日期',
      Report.fileName(Report.buildModel(baseData({ date: '20261107', score: 1 }))),
      '2048-20261107-1.png');
    eq('非法日期不猜，用 00000000',
      Report.fileName(Report.buildModel(baseData({ date: 'not-a-date', score: 8 }))),
      '2048-00000000-8.png');
    eq('model 缺失也不抛错', Report.fileName(null), '2048-00000000-0.png');
  });

  await group('tileColor：0 不画方块', () => {
    eq('0 返回 null', Report.tileColor(0), null);
    eq('null 返回 null', Report.tileColor(null), null);
    eq('undefined 返回 null', Report.tileColor(undefined), null);
    eq('-1 是障碍色', Report.tileColor(-1), { background: '#6d5c4b', color: 'transparent' });
    eq('2 是浅木色', Report.tileColor(2), { background: '#eee4da', color: '#776e65' });
    eq('2048 是金色', Report.tileColor(2048), { background: '#edc22e', color: '#fdf9f2' });
    eq('超出表的块用深炭色', Report.tileColor(8192), { background: '#3f3b33', color: '#f9f6f2' });
    eq('字色都是可读的十六进制',
      ['2', '4', '8', '16', '32', '64', '128', '256', '512', '1024', '2048', '8192'].every(
        (value) => /^#[0-9a-f]{6}$/i.test(Report.tileColor(Number(value)).background)
      ), true);
  });

  await group('toBlob：没有 canvas 时安全返回 null', async () => {
    eq('null 输入', await Report.toBlob(null), null);
    eq('非 canvas 对象', await Report.toBlob({}), null);
  });

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail === 0 ? 0 : 1);
})();
