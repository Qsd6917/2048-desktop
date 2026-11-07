# 2048（桌面版）

纯 HTML / CSS / JavaScript，零依赖、零构建：双击 `index.html` 就能玩，断网也能玩。

## 怎么玩

方向键或 WASD 移动方块，相同数字相撞合并，目标是做出 2048 方块。
`Ctrl+Z` 撤销，`R` 重开；触屏可以直接在棋盘上滑动。

- **模式**：经典 / 限时（3 分钟）/ 障碍（每 10 步长一个障碍，上限等于边长）。
- **尺寸**：4×4 / 5×5 / 6×6，目标值分别是 2048 / 4096 / 8192。
- **每日挑战**：同一天开局固定，刷新可续，记录当日次数、最佳与连续天数。
- **复盘**：打完每日挑战后查看关键失误、评级与建议。
- **成就**：25 条铜 / 银 / 金成就，跨局累计，解锁时右下角弹提示条。
- 进度存在 localStorage；浏览器禁止存储时自动降级为内存，本次会话内照常玩。

## 目录

```
index.html        页面结构
styles.css        纸感 + 木色的全部样式
js/
  logic.js        规则：合并、障碍、胜负
  renderer.js     棋盘 DOM 与动画
  ai.js           走子评估与建议
  storage.js      localStorage 封装与统计
  audio.js        音效
  rng.js          日期种子与确定性随机
  daily.js        每日挑战数据（次数 / 最佳 / 连续天数）
  review.js       复盘日志、评分汇总与文案
  tuning.js       五声音阶映射、连击与大块加花
  fx.js           全屏粒子、扫光、震屏画布
  achievements.js 成就定义、进度与解锁结算
  app.js          控制器：状态机、输入、存档、模块接线
test/             零依赖测试
```

## 四个模块

- **每日挑战**（`rng.js` + `daily.js`）：日期做种子，同一天开局固定，刷新按存档位置续玩。
- **AI 复盘**（`review.js`）：每日局逐步记录盘面，空闲时补算 AI 分数，结算后给出评级、失误与建议。
- **音阶音效 + 整屏粒子**（`tuning.js` + `fx.js`）：合并按五声音阶发声，大块加高八度，配合爆点、目标环、连击扫光与震屏。
- **成就系统**（`achievements.js`）：25 条成就按累计指标结算，首次带历史战绩播种，解锁有提示条与独立面板。

## 测试

单元测试：`node test/<name>.test.js`，`name` 取 `logic` / `ai` / `storage` / `rng` /
`daily` / `review` / `tuning` / `fx` / `achievements`。

```bash
node test/app.e2e.js        # 需要本机 Chrome 或 Edge
node test/features.e2e.js   # 四模块联动，同样需要浏览器
```

端到端套件用真实 Chrome + CDP，找不到浏览器时以退出码 3 结束；
确需在无浏览器机器上跳过请加 `--allow-skip`。
