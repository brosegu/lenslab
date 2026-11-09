# LensLab 项目协作说明

本文件适用于 `/root/lenslab` 下的全部代码。开始任务前先检查当前实现、数据库状态和服务状态，在已有成果上增量修改，不要重做已经完成的功能。

## 项目定位

LensLab 是面向摄影新手的器材对比与场景参数建议网站，包含：

- 前台器材浏览、搜索、筛选、对比和拍摄参数建议。
- 后台登录、首次改密、器材与场景维护、采集来源管理、采集任务查看、候选审核和审计日志。
- 官方来源采集、产品详情解析、页面快照、候选去重、人工审核后写入 `gear` 与 `specs`。

## 目录结构

```text
/root/lenslab
├── AGENTS.md                 本协作说明
├── README.md                 项目功能与使用说明
├── package.json              npm 脚本和依赖
├── package-lock.json         锁定的依赖版本
├── .env.example              环境变量示例，不存放真实密钥
├── .gitignore                忽略数据库、依赖、日志等运行产物
├── server/
│   ├── index.js              Express 服务入口、API、后台鉴权和审核发布
│   ├── crawler.js            官方来源采集、目录发现、详情/规格页解析和去重
│   ├── candidate-quality.js  候选完整度、型号归一化和重复判断
│   ├── db.js                 SQLite 初始化、迁移、种子数据和审计辅助
│   └── run-crawl.js          手动采集脚本入口
├── public/                   前台与后台静态资源和浏览器脚本
├── tests/                    Node.js 内置测试
├── data/                     SQLite 数据库（WAL 模式）
├── node_modules/             已安装依赖
└── lenslab.log               systemd 追加日志
```

## 运行与部署

正式服务由 `/etc/systemd/system/lenslab.service` 管理：

- 工作目录：`/root/lenslab`
- 入口：`/root/lenslab/server/index.js`
- 端口：`3000`
- 日志：`/root/lenslab/lenslab.log`

常用命令必须在 `/root/lenslab` 下执行：

```bash
npm test
npm start
npm run crawl:now
systemctl restart lenslab.service
systemctl status lenslab.service --no-pager -l
curl -sS http://127.0.0.1:3000/api/health
```

修改服务端或正式静态资源后重启 `lenslab.service`，并验证首页、健康接口和公开器材接口。数据库默认位于 `data/lenslab.db`。

## 数据安全规则

- 测试和回归必须使用临时数据库，不得直接改写 `data/lenslab.db`。
- 数据库使用 WAL 模式。复制生产库时不能只复制 `lenslab.db`，应使用：

```bash
sqlite3 -readonly /root/lenslab/data/lenslab.db \
  ".backup '/tmp/lenslab-test.db'"
```

- 审核通过、候选驳回、字段订正和真实采集都属于正式数据写入。先在临时库验证，再对正式库执行。
- 不要为了测试自动批准正式候选；正式审核应由人工逐条核对原始页面。
- 修改数据库结构时使用 `db.js` 中的 `CREATE TABLE IF NOT EXISTS` 和 `ensureColumn` 风格做兼容迁移，保留已有数据。

## 采集实现约束

- 只采集 HTTPS 公网地址，阻止内网、回环、非 HTTPS 和带登录凭据的 URL。
- 遵守每个来源配置的 `robots.txt`，保留超时、重定向次数、响应类型和响应大小限制。
- 产品链接只能来自来源本站或明确的厂商官方域名白名单，例如 Fujifilm 中国列表可进入 `fujifilm-x.com`。
- 每个来源最多提取 12 个产品链接；需要时从官方卡口/系列目录继续下钻，最多 2 个目录页。
- 详情页规格不足时，可跟进同站或白名单官方域名中的规格子页，但每个产品最多跟进一个规格页。
- 解析应兼容 JSON-LD、表格、`dl/dt/dd`、Sigma `c-specList`、Panasonic `camera-params-item`、Fujifilm 规格表等结构。
- 过滤导航、首页、图库、比较页、系列页和非具体产品页；型号至少要包含数字。
- 新候选先写入 `review_queue`，审核通过后才写入 `gear/specs`。
- 同品牌同型号比较使用 `candidate-quality.js`；Panasonic 的 `K/C/L/GK` 等套装、颜色或区域 SKU 后缀不能制造重复器材。

## 置信度与审核规则

- 至少 3 项可识别的关键规格为 `high`；有少量规格或关键参考字段为 `medium`；没有可用规格为 `low`。
- 后台待审列表按低、中、高置信度优先排列，并支持置信度筛选。
- 低置信候选必须显示缺失字段、规格数量和同型号重复提示。
- 候选卡片允许补充缺失的常用规格；空值不得写入 `specs`。
- 批准前必须检查品牌和型号，并阻止器材库中已存在同品牌同型号的数据。
- 保留产品原始页和规格页来源，审核记录与审计日志必须可追溯。

## 测试要求

`npm test` 使用独立临时数据库，不应修改生产库。当前测试覆盖：

- 公开器材、场景与建议接口。
- 后台登录、首次改密、CSRF、字段订正、候选批准和审计日志。
- 官方域名与目录下钻、跨官方域名产品链接、产品页过滤。
- JSON-LD、Sigma、Panasonic、Fujifilm 规格解析。
- Panasonic 套装型号归一化、重复候选提示和批准防重。

修改采集器时同时补充解析或去重测试；修改审核 API/UI 时补充对应回归断言。测试后至少验证：

```bash
node --check server/index.js
node --check server/crawler.js
node --check server/candidate-quality.js
node --check public/js/admin.js
npm test
```

## 当前状态与已知限制

- 正式库基线（2026-11-09）：8 个器材、36 个来源、22 个采集产品、22 条待审、60 条规格；运行前重新查询确认，不要把该快照当成永久不变量。
- 现有待审数据可能由旧解析器生成，后台会标记问题，但不会自动清洗或重新发布。
- 已知重复候选包括 Panasonic `#16/#22` 与 `#20/#21`，应人工核对后合并或驳回。
- Canon 中国 EOS R 专题页大量使用图片承载规格，通常只能以低置信候选进入人工补录。
- Hasselblad 商店部分产品页规格较少，Ricoh/Pentax 当前入口可能没有可识别的具体产品链接，后续应优先增加厂商专用解析或更新来源配置。
- 当前环境可能没有 `git` 命令；不要依赖 `git status` 判断改动。修改前先阅读相关文件，修改后用文件差异、测试和数据库只读查询验证。

## 修改原则

- 优先解决采集覆盖、字段准确度、去重和低置信审核体验。
- 保持 API 字段兼容，后台静态资源修改后检查浏览器实际渲染。
- 不引入与现有依赖重复的新框架；优先使用 Node.js、Express、SQLite、Cheerio 和 Playwright。
- 不删除或重写用户已有的数据、审核记录和审计日志。
- 最终汇报应包含改动文件、测试结果、正式数据变化、剩余问题和访问方式。
