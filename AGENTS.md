# Repository Guidelines

本项目是零依赖、零构建的 2048 网页游戏。以下命令均在仓库根目录执行。

## 项目结构

- `index.html` 定义页面结构和脚本加载顺序，`styles.css` 管理棋盘、面板和响应式布局。
- `js/logic.js` 负责合并、障碍和胜负判定，`js/app.js` 接线输入、状态与存档，`js/renderer.js` 负责棋盘 DOM 和动画。每日挑战、双人、复盘、音效和战报各有独立模块。
- `test/` 保存单元与浏览器测试。界面样式和音效由 CSS、Canvas 和 Web Audio 实现，项目没有独立的素材目录。

## 本地开发与测试

- 用浏览器打开 `index.html` 即可离线运行。需要通过 HTTP 调试时，运行 `python -m http.server 8000`，访问 `http://localhost:8000`。
- 运行 `node test/logic.test.js` 检查棋盘规则。其他单元测试同样直接用 Node.js 执行，按对应模块命名为 `<module>.test.js`。
- 分别运行 `node test/app.e2e.js`、`node test/features.e2e.js` 和 `node test/integration.e2e.js`，覆盖页面交互、功能联动和跨模块组合。套件通过 CDP 驱动本机 Chrome 或 Edge，缺少浏览器时退出码为 3。使用 `--allow-skip` 时，在验证记录中注明跳过。
- 修改规则时，用单元测试覆盖边界。修改输入、布局或存档时，运行相关端到端套件，并注明移动端验证所用的浏览器和设备。项目未配置覆盖率门槛。

## 编码风格

JavaScript 使用两个空格缩进、单引号和语句末尾分号。函数与变量用 `camelCase`，常量沿用 `UPPER_SNAKE_CASE`。可在 Node.js 中测试的模块保留浏览器全局与 CommonJS 导出，新增浏览器脚本时检查 `index.html` 的加载顺序。格式沿用所改文件，项目没有独立的格式化或 lint 命令。

## 提交与拉取请求

沿用历史中的 `fix:`、`test:`、`docs:`、`chore:` 等前缀，使用简短的中文摘要，例如 `fix: 修复小屏棋盘溢出`。拉取请求说明改动及验证结果，有关联议题时附上链接。界面改动附截图并标注视口尺寸。
