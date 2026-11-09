# 镜研 LensLab

面向摄影新手的器材参数对比与场景拍摄参数建议 MVP。当前版本包含可用的前台、管理后台、SQLite 持久化、审核链路和安全会话。

项目统一目录：`/root/lenslab`。后续命令均应在该目录执行。

## 已实现

- 器材搜索、类型/画幅/预算筛选和最多三款对比
- 相机与镜头详情、规格来源、核验时间和置信度展示
- 8 个拍摄场景的参数区间、建议原因、检查项和风险提示
- SCENE RECIPES 使用本地化真实摄影图片，图片来源标注为 Unsplash
- 根据器材画幅、现场光线、主体运动和用户经验动态调整建议
- 后台工作概览、器材逐字段订正、场景参数编辑
- 爬虫待审数据逐字段订正、通过发布、驳回
- 内置 Sony、Canon、Fujifilm、Nikon、OM System、Ricoh、Panasonic、Leica、Sigma、Tamron 官方来源配置
- 后台可调整采集频率、优先级、字段范围、robots.txt、使用条款和启用状态
- 后台可手动触发全部或单个来源采集，显示实时状态、HTTP 状态、耗时、页面大小和失败原因
- 首次采集建立页面基线，后续内容指纹变化会进入待审核区
- 采集器会继续进入产品详情页，提取品牌、型号、价格、卡口、画幅和结构化规格
- 新品进入“采集审核”，人工订正并批准后写入 `gear/specs`
- 内置 Canon、Nikon、Sony、Fujifilm、Panasonic、Leica、Hasselblad、OM System、Ricoh/PENTAX 的中国官网产品入口
- 操作审计日志
- 服务端会话、`scrypt` 密码哈希、CSRF 双提交校验、登录限流和失败锁定
- 首次登录强制修改初始密码，修改后旧会话全部失效
- 页面使用浏览器默认字体，所有可见文字不小于 12px

## 启动

```bash
cd /root/lenslab
npm install
npm start
```

打开：

- 前台：`http://localhost:3000`
- 后台：`http://localhost:3000/admin`

首次初始化管理员：

- 用户名：`brose`
- 初始密码必须通过 `ADMIN_INITIAL_PASSWORD` 环境变量提供，项目不内置默认密码。

首次登录后系统会要求设置至少 10 位、同时包含字母和数字的新密码。

生产部署必须通过环境变量覆盖初始账号和密码，并启用 HTTPS：

```bash
ADMIN_USERNAME=your_admin \
ADMIN_INITIAL_PASSWORD='replace-with-a-strong-password' \
NODE_ENV=production \
TRUST_PROXY=1 \
npm start
```

## 测试

```bash
cd /root/lenslab
npm test
```

测试会在独立临时数据库上启动服务，覆盖公开接口、登录、首次改密、CSRF 拒绝、爬虫数据订正发布和审计日志。

## 数据说明

当前内置的是功能验证数据，页面中已经明确标识。正式上线前需要：

1. 为每个采集来源确认访问许可、版权和发布边界。
2. 为厂商官网配置独立解析器，不使用无审核的自动覆盖。
3. 将原始页面快照、字段来源和审核记录纳入数据治理。
4. 增加镜头卡口兼容、跨画幅等效计算和价格历史。

代码中的待审队列是完整流程的入口。生产爬虫应通过独立 Worker 写入 `review_queue`，由人工确认后才更新 `gear` 与 `specs`。

## 手动采集

进入后台“采集来源”页面：

1. 点击“立即采集全部”检查所有已启用来源。
2. 或点击单个来源右侧的“采集”进行快速测试。
3. 页面会自动刷新任务进度，并保留最近 8 次运行记录。

采集器只允许 HTTPS 公网地址，并检查 `robots.txt`、超时、响应类型和响应大小。首次运行会建立来源基线并继续解析产品详情；发现的新品会进入待审核区。静态 HTML 无法提供产品链接时，会回退到 Playwright 渲染动态页面。

也可以在服务器上直接执行一次全量采集：

```bash
npm run crawl:now
```
