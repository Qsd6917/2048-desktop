# 2048（桌面版）

纯 HTML / CSS / JavaScript，零依赖、零构建：双击 `index.html` 就能玩，断网也能玩。

## 怎么玩

方向键或 WASD 移动方块，相同数字相撞合并，目标是做出 2048 方块。
`Ctrl+Z` 撤销，`R` 重开；触屏可以直接在棋盘上滑动。

手机上把整个目录挂到静态服务后用浏览器打开：同一 WiFi 下跑 `python -m http.server 8000 --bind 0.0.0.0`，手机访问 `http://<电脑IP>:8000`；也可发布成在线链接。
棋盘边长按实测可用高度自适应，拖动时方块实时跟手、抬手即落子；「添加到主屏幕」可全屏启动，建议竖屏。进度存在各自浏览器，不与电脑互通。

- **模式**：经典 / 限时（3 分钟）/ 障碍（每 10 步长一个障碍，上限等于边长）/ 双人。
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
  report.js       战报卡片：模型、绘制与文件名
  duel.js         双人：比分归属、换人与判胜
  app.js          控制器：状态机、输入、存档、模块接线
test/             零依赖测试
```

## 功能模块

- **每日挑战 / AI 复盘**（`rng.js` + `daily.js` + `review.js`）：日期做种子，同日开局固定、刷新续玩；每日局逐步记录盘面，空闲补算 AI 分数，结算给出评级与失误。
- **音阶音效 / 整屏粒子 / 成就**（`tuning.js` + `fx.js` + `achievements.js`）：合并按五声音阶发声、大块加高八度，配合爆点与震屏；25 条成就按累计指标结算，解锁有提示条与面板。

## 战报卡片

结算浮层点「保存战报」，或复盘抽屉里点「导出今日战报」，把这一局画成 1440×1920 的 PNG（2 倍图）：
分数、最大块、步数、连续天数、盘面缩略图与日期。每日局的页脚写「第 N 次」，N 与每日条同源；
普通局只写模式。双人局不计个人纪录，结算不给战报入口。

## 双人对战

设置里选「双人」：两人在同一块棋盘上轮流走子，合并得分归当前玩家，走完一步换人。
顶部换成两块比分（当前一方高亮），回合条只写「轮到玩家 N」。撤销与托管在双人下禁用，
动画期间的按键不缓冲（否则会以对手身份走掉）。死局按比分判胜，同分平局；一方先合出目标值即获胜，
结算后回合条写「本局结束」。双人局不计个人纪录，也不写每日口径。

## 测试

全部零依赖，直接 `node` 跑；端到端套件用真实 Chrome + CDP，找不到浏览器以退出码 3 结束（可加 `--allow-skip` 跳过）。

```bash
node test/logic.test.js
node test/ai.test.js
node test/storage.test.js
node test/rng.test.js
node test/daily.test.js
node test/review.test.js
node test/tuning.test.js
node test/fx.test.js
node test/achievements.test.js
node test/duel.test.js
node test/report.test.js
node test/app.e2e.js          # 需要本机 Chrome 或 Edge
node test/features.e2e.js     # 四模块联动
node test/integration.e2e.js  # 跨模块组合
```
