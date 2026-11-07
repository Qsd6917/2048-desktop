/**
 * 2048 战报卡片 —— 结算时把这一局画成一张可保存的 PNG。
 *
 * 浏览器里挂到 window.Game2048Report，Node 里通过 module.exports 导出。
 * 加载时绝不碰 document：buildModel 是纯函数（可单测），只有 render 才创建 canvas，
 * 所以 `require('./report.js')` 在 Node 下永远安全。
 *
 * 配色表是 review.js 的只读副本：那边 require 会把 daily / rng 一起拖进来，
 * 为一张色表欠下耦合不值得；这里抄一份同值表，big 用 #3f3b33。
 *
 * 画布固定 720×960，按 2 倍图输出 1440×1920 位图 —— 不跟随 devicePixelRatio，
 * 保证同一局在任何设备上导出的图片尺寸一致，方便分享。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Game2048Report = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- 版式常量 ---------- */

  /** 逻辑画布尺寸（CSS 像素）；实际位图是它的 SCALE 倍 */
  var WIDTH = 720;
  var HEIGHT = 960;
  /** 固定 2 倍图 */
  var SCALE = 2;
  /** 四周留白 */
  var PAD = 48;

  /** 棋盘缩略图：边长 480，格子间隙 12，圆角 8 */
  var BOARD_SIDE = 480;
  var BOARD_TOP = 152;
  var BOARD_RADIUS = 12;
  var CELL_GAP = 12;
  var CELL_RADIUS = 8;

  /** 四格统计 */
  var STATS_TOP = 668;
  var STATS_HEIGHT = 96;
  var STATS_RADIUS = 10;
  var STATS_GAP = 12;

  /** 页脚的分隔线与基线 */
  var DIVIDER_Y = 828;
  var FOOTER_BASELINE = 886;

  /** 只用系统字体栈：不引入任何字体文件 */
  var FONT = '"PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';

  var COLORS = {
    paper: '#faf8f2',
    ink: '#3f3b33',
    muted: '#8b7d70',
    faint: '#a29787',
    board: 'rgba(94, 76, 58, 0.12)',
    card: 'rgba(94, 76, 58, 0.045)',
    line: 'rgba(94, 76, 58, 0.14)'
  };

  /**
   * 方块配色（与 js/review.js 的 TILE_COLORS 同值）。
   * 键名统一用字符串：数值要转成键查表；empty / obstacle / big 是哨兵。
   */
  var TILE_COLORS = {
    obstacle: { background: '#6d5c4b', color: 'transparent' },
    big: { background: '#3f3b33', color: '#f9f6f2' },
    '2': { background: '#eee4da', color: '#776e65' },
    '4': { background: '#ede0c8', color: '#776e65' },
    '8': { background: '#f2b179', color: '#fdf9f2' },
    '16': { background: '#f59563', color: '#fdf9f2' },
    '32': { background: '#f67c5f', color: '#fdf9f2' },
    '64': { background: '#f65e3b', color: '#fdf9f2' },
    '128': { background: '#edcf72', color: '#fdf9f2' },
    '256': { background: '#edcc61', color: '#fdf9f2' },
    '512': { background: '#edc850', color: '#fdf9f2' },
    '1024': { background: '#edc53f', color: '#fdf9f2' },
    '2048': { background: '#edc22e', color: '#fdf9f2' }
  };

  /** 模式 -> 中文名；顺序与 app.js 的 MODES 一致 */
  var MODE_LABELS = { classic: '经典', timed: '限时', obstacle: '障碍' };

  /* ---------- 小工具（纯函数） ---------- */

  /** 非负整数，脏数据一律折成 0 */
  function toCount(value) {
    var number = Number(value);
    if (!isFinite(number) || number <= 0) return 0;
    return Math.floor(number);
  }

  /** 千分位自实现：不依赖 toLocaleString 的地区行为 */
  function formatNumber(value) {
    var text = String(toCount(value));
    var out = '';
    for (var i = 0; i < text.length; i++) {
      if (i > 0 && (text.length - i) % 3 === 0) out += ',';
      out += text.charAt(i);
    }
    return out;
  }

  /**
   * 单元格取值：0 空格，-1 障碍，其余为方块值。
   * 其他负数与非法值按空格处理，免得在图上画出「-5 方块」。
   */
  function cellValue(value) {
    var number = Number(value);
    if (!isFinite(number) || number === 0) return 0;
    var rounded = Math.floor(number);
    if (rounded === -1) return -1;
    return rounded > 0 ? rounded : 0;
  }

  /**
   * 该格该画什么颜色。
   * 返回 null 表示「不画方块」—— 空格只留棋盘底色，不铺一层假方块。
   * @param {number} value 单元格值
   * @returns {?{background:string, color:string}} 填色与字色
   */
  function tileColor(value) {
    var number = Number(value);
    if (!isFinite(number) || number === 0) return null;
    if (number === -1) return TILE_COLORS.obstacle;
    return TILE_COLORS[String(number)] || TILE_COLORS.big;
  }

  /** 盘面边长：以 values 的行数为准，缺省回退 data.size，最后兜底 4 */
  function pickSize(value, values) {
    var rows = Array.isArray(values) ? values.length : 0;
    var size = rows >= 2 && rows <= 8 ? rows : Math.floor(Number(value));
    if (!(size >= 2 && size <= 8)) size = 4;
    return size;
  }

  /** 把任意来源的 values 洗成 size×size 的数字矩阵（新数组，入参不被带走） */
  function normalizeValues(values, size) {
    var out = [];
    for (var r = 0; r < size; r++) {
      var row = Array.isArray(values) && Array.isArray(values[r]) ? values[r] : [];
      var cells = [];
      for (var c = 0; c < size; c++) cells.push(cellValue(row[c]));
      out.push(cells);
    }
    return out;
  }

  /** 日期串里的 8 位数字；非法时给 00000000，绝不猜日期 */
  function compactDate(date) {
    var digits = String(date === undefined || date === null ? '' : date).replace(/[^0-9]/g, '');
    if (digits.length > 8) digits = digits.slice(0, 8);
    return digits.length === 8 ? digits : '00000000';
  }

  /* ---------- 数据层 ---------- */

  /**
   * 组装战报模型（纯函数，不碰 canvas / document）。
   *
   * @param {object} data
   *        { date: '2026-11-07', size: 4, score, maxTile, moves, mode: 'classic',
   *          daily: { streak, attempt } | null, achievements: { unlocked, total },
   *          values: number[][] }   values 里 0 表示空格
   * @returns {{title:string, subtitle:string, stats:Array<{label:string, value:string}>,
   *            footer:string, thumb:{size:number, values:number[][]},
   *            date:string, score:number}}
   *          date 是 8 位紧凑日期，score 是原始分，两者供 fileName 使用
   */
  function buildModel(data) {
    var input = data && typeof data === 'object' ? data : {};

    var size = pickSize(input.size, input.values);
    var values = normalizeValues(input.values, size);
    var score = toCount(input.score);

    var mode = Object.prototype.hasOwnProperty.call(MODE_LABELS, input.mode) ? input.mode : 'classic';
    var modeLabel = MODE_LABELS[mode];

    var daily = input.daily && typeof input.daily === 'object' ? input.daily : null;
    var streak = daily ? toCount(daily.streak) : 0;
    var attempt = daily ? toCount(daily.attempt) : 0;

    var dateText = typeof input.date === 'string' ? input.date : '';
    var dateKey = compactDate(dateText);

    return {
      title: '2048 · 战报',
      subtitle: (dateText ? dateText + ' · ' : '') + modeLabel + '模式',
      stats: [
        { label: '分数', value: formatNumber(score) },
        { label: '最大块', value: formatNumber(input.maxTile) },
        { label: '步数', value: formatNumber(input.moves) },
        // 普通局没有每日挑战口径，用「—」而不是「0 天」，避免读成「断签」
        { label: '连续天数', value: daily ? formatNumber(streak) : '—' }
      ],
      footer: daily
        ? '2048 桌面版 · 每日挑战 第 ' + attempt + ' 次'
        : '2048 桌面版 · ' + modeLabel + '模式',
      thumb: { size: size, values: values },
      date: dateKey,
      score: score
    };
  }

  /**
   * 下载用的文件名：2048-YYYYMMDD-<score>.png
   * @param {object} model buildModel 的返回值
   * @returns {string}
   */
  function fileName(model) {
    var source = model && typeof model === 'object' ? model : {};
    return '2048-' + compactDate(source.date) + '-' + toCount(source.score) + '.png';
  }

  /* ---------- 画布 ---------- */

  /** 自己写圆角矩形：不依赖 ctx.roundRect（老浏览器没有） */
  function roundRect(ctx, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.arcTo(x + width, y, x + width, y + r, r);
    ctx.lineTo(x + width, y + height - r);
    ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
    ctx.lineTo(x + r, y + height);
    ctx.arcTo(x, y + height, x, y + height - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /** 字号收到 maxWidth 以内：大分数 / 四位数方块都不会溢出格子 */
  function fitFontSize(ctx, text, maxWidth, startSize) {
    var size = startSize;
    while (size > 10) {
      ctx.font = '800 ' + size + 'px ' + FONT;
      if (ctx.measureText(text).width <= maxWidth) return size;
      size -= 1;
    }
    return size;
  }

  function drawThumb(ctx, thumb) {
    var size = thumb && thumb.size >= 2 ? thumb.size : 4;
    var values = thumb && Array.isArray(thumb.values) ? thumb.values : [];
    var left = (WIDTH - BOARD_SIDE) / 2;

    ctx.fillStyle = COLORS.board;
    roundRect(ctx, left, BOARD_TOP, BOARD_SIDE, BOARD_SIDE, BOARD_RADIUS);
    ctx.fill();

    // 格子边长按尺寸摊：4×4 得 105，6×6 得 66，间隙恒为 12
    var cell = (BOARD_SIDE - CELL_GAP * (size + 1)) / size;

    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        var row = Array.isArray(values[r]) ? values[r] : [];
        var value = cellValue(row[c]);
        var color = tileColor(value);
        // 空格没有填色：不画方块，只留棋盘底色
        if (!color) continue;

        var x = left + CELL_GAP + c * (cell + CELL_GAP);
        var y = BOARD_TOP + CELL_GAP + r * (cell + CELL_GAP);

        ctx.fillStyle = color.background;
        roundRect(ctx, x, y, cell, cell, CELL_RADIUS);
        ctx.fill();

        if (value > 0) {
          var text = String(value);
          var fontSize = fitFontSize(ctx, text, cell * 0.78, Math.floor(cell * 0.4));
          ctx.font = '800 ' + fontSize + 'px ' + FONT;
          ctx.fillStyle = color.color;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          // 数字视觉重心略高，向下补半像素更像居中
          ctx.fillText(text, x + cell / 2, y + cell / 2 + 1);
        }
      }
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  function drawStats(ctx, stats) {
    var list = Array.isArray(stats) ? stats : [];
    var width = (WIDTH - PAD * 2 - STATS_GAP * 3) / 4;

    for (var i = 0; i < 4; i++) {
      var item = list[i] && typeof list[i] === 'object' ? list[i] : { label: '', value: '' };
      var x = PAD + i * (width + STATS_GAP);

      ctx.fillStyle = COLORS.card;
      roundRect(ctx, x, STATS_TOP, width, STATS_HEIGHT, STATS_RADIUS);
      ctx.fill();
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      ctx.font = '700 14px ' + FONT;
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(String(item.label || ''), x + 14, STATS_TOP + 18);

      var value = String(item.value === undefined || item.value === null ? '—' : item.value);
      var size = fitFontSize(ctx, value, width - 24, 28);
      ctx.font = '800 ' + size + 'px ' + FONT;
      ctx.fillStyle = COLORS.ink;
      ctx.fillText(value, x + 14, STATS_TOP + 46);
    }
  }

  function drawTexts(ctx, model) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    ctx.font = '700 24px ' + FONT;
    ctx.fillStyle = COLORS.ink;
    ctx.fillText(model.title || '', PAD, PAD - 4);

    ctx.font = '400 15px ' + FONT;
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(model.subtitle || '', PAD, PAD + 32);

    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, DIVIDER_Y);
    ctx.lineTo(WIDTH - PAD, DIVIDER_Y);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '400 14px ' + FONT;
    ctx.fillStyle = COLORS.faint;
    ctx.fillText(model.footer || '', WIDTH / 2, FOOTER_BASELINE);
  }

  /**
   * 把模型画成 canvas。
   * Node（没有 document）下返回 null，调用方不必自己判环境。
   *
   * @param {object} model buildModel 的返回值
   * @returns {?HTMLCanvasElement} 1440×1920 位图 canvas
   */
  function render(model) {
    if (!model || typeof model !== 'object') return null;
    if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') {
      return null;
    }

    var canvas = document.createElement('canvas');
    canvas.width = WIDTH * SCALE;
    canvas.height = HEIGHT * SCALE;
    if (canvas.style) {
      canvas.style.width = WIDTH + 'px';
      canvas.style.height = HEIGHT + 'px';
    }

    var ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) return null;

    ctx.scale(SCALE, SCALE);

    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    drawTexts(ctx, model);
    drawThumb(ctx, model.thumb);
    drawStats(ctx, model.stats);

    return canvas;
  }

  /**
   * canvas -> PNG Blob；任何失败都折成 null，绝不抛错。
   * @param {?HTMLCanvasElement} canvas
   * @returns {Promise<?Blob>}
   */
  function toBlob(canvas) {
    return new Promise(function (resolve) {
      if (!canvas || typeof canvas.toBlob !== 'function') {
        resolve(null);
        return;
      }
      try {
        canvas.toBlob(function (blob) {
          resolve(blob || null);
        }, 'image/png');
      } catch (err) {
        resolve(null);
      }
    });
  }

  return {
    WIDTH: WIDTH,
    HEIGHT: HEIGHT,
    SCALE: SCALE,
    buildModel: buildModel,
    render: render,
    toBlob: toBlob,
    fileName: fileName,
    tileColor: tileColor,
    formatNumber: formatNumber
  };
});
