import { api, ensureCsrf, formatDate, setCsrf, toast } from "./api.js";

const app = document.querySelector("#app");
const state = {
  gear: [],
  scenes: [],
  compareIds: loadCompareIds(),
};

const icons = {
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10H3V8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="4"/></svg>',
  scene: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 5 6v5c0 4.8 2.9 8.2 7 10 4.1-1.8 7-5.2 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 5 7 7-7 7"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
};

function esc(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadCompareIds() {
  try {
    const ids = JSON.parse(localStorage.getItem("lenslab-compare") || "[]");
    return Array.isArray(ids) ? ids.map(Number).filter(Boolean).slice(0, 3) : [];
  } catch {
    return [];
  }
}

function saveCompareIds() {
  localStorage.setItem("lenslab-compare", JSON.stringify(state.compareIds));
}

function queryParts() {
  return new URLSearchParams(window.location.search);
}

function currentSection(path = window.location.pathname) {
  if (path.startsWith("/gear")) return "catalog";
  if (path.startsWith("/advisor")) return "advisor";
  if (path.startsWith("/compare")) return "compare";
  return "home";
}

function gearVisual(gear, extra = "") {
  const category = gear.category === "lens" ? "lens" : "camera";
  return `
    <div class="gear-visual ${esc(gear.accent || "graphite")} ${esc(extra)}"
         data-label="${category === "camera" ? "CAMERA / SYSTEM" : "LENS / OPTICS"}">
      <div class="gear-art ${category}" aria-hidden="true">
        ${
          category === "camera"
            ? '<span class="top"></span><span class="body"></span><span class="flash"></span><span class="lens"></span><span class="grip"></span>'
            : '<span class="barrel"></span><span class="glass"></span>'
        }
      </div>
    </div>
  `;
}

function siteHeader() {
  const section = currentSection();
  return `
    <header class="site-header">
      <a class="brand" href="/" data-link aria-label="镜研 LensLab 首页">
        <span class="brand-mark"><span></span></span>
        <span>
          <span class="brand-name">镜研</span>
          <span class="brand-en">LENSLAB</span>
        </span>
      </a>
      <nav class="nav" aria-label="主导航">
        <a class="nav-link ${section === "catalog" ? "active" : ""}" href="/gear" data-link>探索器材</a>
        <a class="nav-link ${section === "advisor" ? "active" : ""}" href="/advisor" data-link>场景参数</a>
        <a class="nav-link" href="/#scenes" data-link>拍摄灵感</a>
        <a class="nav-link" href="/#data-method" data-link>数据方法</a>
      </nav>
      <div class="nav-actions">
        <a class="compare-pill" href="/compare" data-link>
          ${icons.grid}
          对比清单
          <span class="compare-count" data-compare-count>${state.compareIds.length}</span>
        </a>
        <button class="menu-button" type="button" data-mobile-menu aria-label="打开导航"><span></span></button>
      </div>
    </header>
  `;
}

function siteFooter() {
  return `
    <footer class="site-footer">
      <div class="container">
        <div class="footer-main">
          <div>
            <a class="brand" href="/" data-link>
              <span class="brand-mark"><span></span></span>
              <span>
                <span class="brand-name">镜研</span>
                <span class="brand-en">LENSLAB</span>
              </span>
            </a>
            <p class="footer-copy">
              用可追溯的数据和清楚的场景解释，帮助每一位摄影新手少走一点弯路。
            </p>
          </div>
          <div class="footer-links">
            <div class="footer-column">
              <strong>探索</strong>
              <a href="/gear" data-link>相机与镜头</a>
              <a href="/advisor" data-link>场景参数助手</a>
              <a href="/compare" data-link>参数对比</a>
            </div>
            <div class="footer-column">
              <strong>数据</strong>
              <a href="/#data-method" data-link>采集合规</a>
              <a href="/#data-method" data-link>来源与置信度</a>
              <a href="/admin/login" data-link>管理后台</a>
            </div>
          </div>
        </div>
        <div class="footer-bottom">
          <span>LENSLAB / PHOTOGRAPHY DECISION SYSTEM</span>
          <span>参数是起点，观察才是答案。</span>
        </div>
      </div>
    </footer>
  `;
}

function publicShell(content) {
  return `${siteHeader()}${content}${siteFooter()}${compareDock()}`;
}

function gearCard(gear) {
  const selected = state.compareIds.includes(gear.id);
  const disabled = !selected && state.compareIds.length >= 3;
  return `
    <article class="gear-card">
      <a href="/gear/${encodeURIComponent(gear.slug)}" data-link aria-label="查看 ${esc(gear.brand)} ${esc(gear.model)}">
        ${gearVisual(gear)}
      </a>
      <div class="gear-body">
        <div class="gear-topline">
          <span class="gear-brand">${esc(gear.brand)} · ${gear.category === "camera" ? "CAMERA" : "LENS"}</span>
          <span class="gear-price">¥${Number(gear.priceCny || 0).toLocaleString("zh-CN")}</span>
        </div>
        <h3 class="gear-name">
          <a href="/gear/${encodeURIComponent(gear.slug)}" data-link>${esc(gear.model)}</a>
        </h3>
        <p class="gear-summary">${esc(gear.summary)}</p>
        <div class="gear-tags">
          ${gear.bestFor.slice(0, 3).map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}
        </div>
        <div class="gear-actions">
          <label class="compare-check">
            <input type="checkbox" data-compare-id="${gear.id}" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""}>
            加入对比
          </label>
          <a class="gear-link" href="/gear/${encodeURIComponent(gear.slug)}" data-link>查看参数 →</a>
        </div>
      </div>
    </article>
  `;
}

function sceneCard(scene, featured = false) {
  return `
    <a class="scene-card ${esc(scene.accent)} ${featured ? "scene-card-large" : ""}"
       ${scene.image?.url ? `style="background-image:url('${esc(scene.image.url)}')"` : ""}
       href="/advisor?scene=${encodeURIComponent(scene.id)}" data-link>
      <span class="scene-eyebrow">${esc(scene.eyebrow)} / ${esc(scene.category)}</span>
      <h3>${esc(scene.title)}</h3>
      <p>${esc(scene.description)}</p>
      <div class="scene-bottom">
        <div class="scene-params">
          <span>${esc(scene.aperture)}</span>
          <span>${esc(scene.shutter)}</span>
          <span>${esc(scene.iso)}</span>
        </div>
        <span class="circle-arrow">${icons.arrow}</span>
      </div>
      ${scene.image?.credit ? `<span class="scene-credit">图片来源：${esc(scene.image.credit)}</span>` : ""}
    </a>
  `;
}

function compareDock() {
  if (window.location.pathname === "/compare") return "";
  if (!state.compareIds.length) return "";
  const selected = state.compareIds
    .map((id) => state.gear.find((gear) => gear.id === id))
    .filter(Boolean);
  return `
    <div class="compare-dock" data-compare-dock>
      <span class="compare-dock-text"><strong>${state.compareIds.length}</strong> 台已选</span>
      <div class="compare-dock-items">
        ${selected.map((gear) => `
          <span class="compare-dock-item">
            ${esc(gear.brand)} ${esc(gear.model)}
            <button type="button" data-remove-compare="${gear.id}" aria-label="从对比清单移除 ${esc(gear.model)}">×</button>
          </span>
        `).join("")}
      </div>
      <button class="compare-dock-clear" type="button" data-clear-compare>清空</button>
      <a class="button button-orange button-small" href="/compare?ids=${state.compareIds.join(",")}" data-link>
        开始对比 ${icons.arrow}
      </a>
    </div>
  `;
}

function renderHome() {
  const cameras = state.gear.filter((gear) => gear.category === "camera").slice(0, 4);
  app.innerHTML = publicShell(`
    <main>
      <div class="container hero">
        <section>
          <span class="eyebrow">PHOTOGRAPHY, MADE CLEAR</span>
          <h1>参数不是答案，<br><em>理解</em>才是。</h1>
          <p class="hero-copy">
            从选购第一台相机，到在不同光线下找到合适的参数。
            镜研把复杂规格翻译成你能看懂的拍摄决策。
          </p>
          <div class="hero-actions">
            <a class="button button-dark" href="/gear" data-link>探索器材 ${icons.arrow}</a>
            <a class="button button-outline" href="/advisor" data-link>获取场景参数</a>
          </div>
          <div class="trust-note">
            <span>${icons.shield} 每条数据可追溯</span>
            <span>${icons.check} 建议附适用条件</span>
            <span>${icons.database} ${state.gear.length} 款器材已收录</span>
          </div>
        </section>
        <section class="hero-visual" aria-label="器材对比示意">
          <div class="visual-orbit"></div>
          <div class="camera-stage">
            <div class="stage-topline"><span>LENSLAB / FIELD NOTE 01</span><span>35.6762° N</span></div>
            <div class="lens-graphic"></div>
            <div class="camera-side-label">
              <strong>See more.</strong>
              <span>CHOOSE WITH CONTEXT</span>
            </div>
          </div>
          <div class="floating-card">
            <div class="floating-card-header">
              <span>QUICK COMPARE</span>
              <span class="live-dot">已校验</span>
            </div>
            <div class="mini-compare">
              <div class="mini-gear"><span>Sony</span><strong>α7C II</strong></div>
              <div class="mini-gear"><span>Fujifilm</span><strong>X-S20</strong></div>
            </div>
            <div class="mini-bars">
              <div class="mini-bar-row"><span>便携</span><span class="mini-bar"><i style="width:92%"></i></span><span>92</span></div>
              <div class="mini-bar-row"><span>弱光</span><span class="mini-bar"><i style="width:86%"></i></span><span>86</span></div>
              <div class="mini-bar-row"><span>直出</span><span class="mini-bar"><i style="width:78%"></i></span><span>78</span></div>
            </div>
          </div>
        </section>
      </div>

      <section class="section container">
        <div class="section-heading">
          <div>
            <span class="eyebrow">START WITH A NEED</span>
            <h2>你准备拍什么？</h2>
          </div>
          <p>参数建议是一段有条件的起点，不是一组必须照抄的数字。</p>
        </div>
        <form class="search-panel" data-home-search>
          <div class="search-box">
            ${icons.search}
            <input name="q" type="search" maxlength="80" placeholder="搜索焦段、预算或拍摄需求，例如：轻量旅行机">
          </div>
          <button class="button button-dark" type="submit">开始寻找</button>
        </form>
        <div class="quick-tags">
          <a class="quick-tag" href="/gear?q=旅行" data-link>轻量旅行</a>
          <a class="quick-tag" href="/gear?q=人像" data-link>人像入门</a>
          <a class="quick-tag" href="/gear?q=视频" data-link>视频创作</a>
          <a class="quick-tag" href="/gear?q=街拍" data-link>街拍随身</a>
          <a class="quick-tag" href="/gear?priceMax=6000" data-link>预算 6000 内</a>
        </div>
      </section>

      <section class="section container" id="popular">
        <div class="section-heading">
          <div>
            <span class="eyebrow">EDITOR'S SHORTLIST</span>
            <h2>值得从这些开始</h2>
          </div>
          <a class="text-link" href="/gear" data-link>查看全部器材 ${icons.arrow}</a>
        </div>
        <div class="gear-grid">
          ${cameras.map(gearCard).join("")}
        </div>
      </section>

      <section class="section container" id="scenes">
        <div class="section-heading">
          <div>
            <span class="eyebrow">SCENE RECIPES</span>
            <h2>从现场出发，而不是从参数表出发</h2>
          </div>
          <a class="text-link" href="/advisor" data-link>打开参数助手 ${icons.arrow}</a>
        </div>
        <div class="scene-grid">
          ${state.scenes.slice(0, 5).map((scene, index) => sceneCard(scene, index === 0)).join("")}
        </div>
      </section>

      <section class="section section-dark" id="data-method">
        <div class="section-heading">
          <div>
            <span class="eyebrow">OUR DATA METHOD</span>
            <h2>比“数据很多”更重要的，<br>是每一条都能解释来源。</h2>
          </div>
          <p>公开规格、采集任务和人工审核共同构成发布数据。价格和参数都会保留更新时间。</p>
        </div>
        <div class="method-grid">
          <article class="method-card">
            <span class="eyebrow">TRACEABLE DATA</span>
            <h3>厂商文档优先，人工审核发布。</h3>
            <p>
              每项数据记录来源 URL、采集时间和置信度。爬虫发现变化后进入待审区，
              由管理员逐字段核对，避免页面改版直接污染前台。
            </p>
            <div class="data-rings"></div>
            <div class="source-list">
              <div class="source-row"><span>Sony 官方产品站</span><span>HEALTHY / DAILY</span></div>
              <div class="source-row"><span>Fujifilm 官方产品站</span><span>HEALTHY / DAILY</span></div>
              <div class="source-row"><span>Canon 官方产品站</span><span>HEALTHY / WEEKLY</span></div>
            </div>
          </article>
          <article class="method-card method-card-light">
            <span class="eyebrow">HUMAN IN THE LOOP</span>
            <h3>保留反例，也保留不确定性。</h3>
            <ul class="method-list">
              <li class="check-line">场景建议以区间表达，并注明光线和运动条件</li>
              <li class="check-line">规格冲突先进入待审区，不自动覆盖已发布数据</li>
              <li class="check-line">人工订正与审核决定写入审计日志</li>
              <li class="check-line">演示数据明确标识，正式发布前补充复核</li>
            </ul>
          </article>
        </div>
      </section>
    </main>
  `);
  bindCommon();
  document.querySelector("[data-home-search]").addEventListener("submit", (event) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get("q");
    navigate(`/gear${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  });
}

function renderCatalog() {
  const params = queryParts();
  const filters = {
    q: params.get("q") || "",
    category: params.get("category") || "",
    sensor: params.get("sensor") || "",
    priceMax: params.get("priceMax") || "",
    sort: params.get("sort") || "recommended",
  };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  const items = state.gear.filter((gear) => {
    const haystack = [gear.brand, gear.model, gear.summary, ...gear.bestFor].join(" ").toLowerCase();
    if (filters.q && !haystack.includes(filters.q.toLowerCase())) return false;
    if (filters.category && gear.category !== filters.category) return false;
    if (filters.sensor && gear.sensorFormat !== filters.sensor) return false;
    if (filters.priceMax && gear.priceCny > Number(filters.priceMax)) return false;
    return true;
  }).sort((a, b) => {
    if (filters.sort === "priceAsc") return a.priceCny - b.priceCny;
    if (filters.sort === "priceDesc") return b.priceCny - a.priceCny;
    if (filters.sort === "newest") return b.releaseYear - a.releaseYear;
    return b.releaseYear - a.releaseYear || a.priceCny - b.priceCny;
  });
  const sensorOptions = [...new Set(state.gear.map((gear) => gear.sensorFormat).filter(Boolean))];

  app.innerHTML = publicShell(`
    <main class="container">
      <section class="page-intro">
        <div>
          <span class="eyebrow">GEAR LIBRARY / ${String(items.length).padStart(2, "0")}</span>
          <h1>找到适合你的那台。</h1>
        </div>
        <p>规格来自可追溯资料。比较时重点关注画幅、重量、镜头生态和你的真实拍摄场景。</p>
      </section>
      <section class="catalog-layout">
        <aside class="filters" aria-label="器材筛选">
          <form data-catalog-filter>
            <div class="search-box">
              ${icons.search}
              <input name="q" type="search" maxlength="80" value="${esc(filters.q)}" placeholder="搜索品牌或需求">
            </div>
            <div class="filter-groups">
              <div class="filter-group">
                <span class="filter-title">器材类型</span>
                <label class="filter-option"><input type="radio" name="category" value="" ${!filters.category ? "checked" : ""}>全部</label>
                <label class="filter-option"><input type="radio" name="category" value="camera" ${filters.category === "camera" ? "checked" : ""}>相机</label>
                <label class="filter-option"><input type="radio" name="category" value="lens" ${filters.category === "lens" ? "checked" : ""}>镜头</label>
              </div>
              <div class="filter-group">
                <span class="filter-title">画幅</span>
                <select class="select-control" name="sensor" aria-label="按画幅筛选">
                  <option value="">全部画幅</option>
                  ${sensorOptions.map((sensor) => `<option value="${esc(sensor)}" ${filters.sensor === sensor ? "selected" : ""}>${esc(sensor)}</option>`).join("")}
                </select>
              </div>
              <div class="filter-group">
                <span class="filter-title">最高预算</span>
                <select class="select-control" name="priceMax" aria-label="按预算筛选">
                  <option value="">不限预算</option>
                  ${[4000, 6000, 8000, 10000, 15000].map((price) => `<option value="${price}" ${filters.priceMax === String(price) ? "selected" : ""}>¥${price.toLocaleString("zh-CN")} 以下</option>`).join("")}
                </select>
              </div>
            </div>
          </form>
        </aside>
        <div class="catalog-main">
          <div class="catalog-toolbar">
            <span class="result-count">找到 <strong>${items.length}</strong> 款器材</span>
            <label>
              <select class="select-control" data-sort aria-label="排序方式">
                <option value="recommended" ${filters.sort === "recommended" ? "selected" : ""}>编辑推荐</option>
                <option value="priceAsc" ${filters.sort === "priceAsc" ? "selected" : ""}>价格从低到高</option>
                <option value="priceDesc" ${filters.sort === "priceDesc" ? "selected" : ""}>价格从高到低</option>
                <option value="newest" ${filters.sort === "newest" ? "selected" : ""}>发布时间最新</option>
              </select>
            </label>
          </div>
          ${
            items.length
              ? `<div class="gear-grid">${items.map(gearCard).join("")}</div>`
              : `<div class="empty-state">
                  <div class="empty-state-icon">${icons.search}</div>
                  <h3>暂时没有匹配结果</h3>
                  <p>试试减少筛选条件，或者搜索更宽泛的拍摄需求。</p>
                  <a class="button button-dark button-small" href="/gear" data-link>清空筛选</a>
                </div>`
          }
        </div>
      </section>
    </main>
  `);
  bindCommon();
  const filterForm = document.querySelector("[data-catalog-filter]");
  const applyFilters = () => {
    const formData = new FormData(filterForm);
    const next = new URLSearchParams();
    for (const key of ["q", "category", "sensor", "priceMax"]) {
      const value = formData.get(key);
      if (value) next.set(key, value);
    }
    const sort = document.querySelector("[data-sort]").value;
    if (sort !== "recommended") next.set("sort", sort);
    navigate(`/gear${next.toString() ? `?${next}` : ""}`);
  };
  filterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    applyFilters();
  });
  filterForm.querySelectorAll("input, select").forEach((control) => {
    control.addEventListener("change", applyFilters);
  });
  document.querySelector("[data-sort]").addEventListener("change", applyFilters);
}

function renderGearDetail(gear) {
  const relatedScenes = state.scenes.filter((scene) => (
    gear.bestFor.some((tag) => scene.category.includes(tag) || scene.title.includes(tag))
  )).slice(0, 3);
  const selected = state.compareIds.includes(gear.id);
  app.innerHTML = publicShell(`
    <main class="container detail-page">
      <nav class="breadcrumbs" aria-label="面包屑">
        <a href="/gear" data-link>器材库</a><span>/</span>
        <span>${esc(gear.brand)}</span><span>/</span>
        <span>${esc(gear.model)}</span>
      </nav>
      <section class="detail-hero">
        <div class="detail-visual">
          ${gearVisual(gear)}
          <span class="visual-badge">${esc(gear.sensorFormat || gear.category.toUpperCase())}</span>
        </div>
        <div class="detail-copy">
          <span class="detail-brand">${esc(gear.brand)} / ${gear.category === "camera" ? "CAMERA" : "LENS"}</span>
          <h1>${esc(gear.model)}</h1>
          <p class="detail-summary">${esc(gear.summary)}</p>
          <div class="detail-meta">
            <div class="meta-block"><span>发布时间</span><strong>${esc(gear.releaseYear)}</strong></div>
            <div class="meta-block"><span>镜头系统</span><strong>${esc(gear.mount || "—")}</strong></div>
            <div class="meta-block"><span>画幅 / 格式</span><strong>${esc(gear.sensorFormat || "—")}</strong></div>
            <div class="meta-block"><span>适合场景</span><strong>${gear.bestFor.slice(0, 2).map(esc).join(" · ")}</strong></div>
          </div>
          <div class="detail-price-row">
            <span class="detail-price">¥${Number(gear.priceCny || 0).toLocaleString("zh-CN")}</span>
            <span class="confidence-badge">${gear.confidence === "verified" ? "官方数据已核验" : "人工复核"}</span>
          </div>
          <div class="detail-actions">
            <button class="button ${selected ? "button-outline" : "button-dark"}" data-detail-compare="${gear.id}">
              ${selected ? "已加入对比" : "加入对比清单"}
            </button>
            <a class="button button-outline" href="/advisor?gear=${gear.id}" data-link>用它获取参数建议</a>
          </div>
        </div>
      </section>
      <section class="details-grid">
        <article class="panel">
          <h2 class="panel-title">关键规格 <span class="confidence-badge">来源可追溯</span></h2>
          <table class="spec-table">
            <tbody>
              <tr><th>参考价格</th><td>¥${Number(gear.priceCny || 0).toLocaleString("zh-CN")}</td></tr>
              ${gear.specs.map((spec) => `
                <tr>
                  <th>${esc(spec.label)}</th>
                  <td>${esc(spec.value)}${spec.unit ? ` ${esc(spec.unit)}` : ""}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </article>
        <aside>
          <article class="panel source-card">
            <span class="eyebrow">DATA SOURCE</span>
            <h2 class="panel-title">这条信息从哪里来？</h2>
            <p>
              主规格来自 ${esc(gear.source.name)}。数据最近核验于
              ${formatDate(gear.verifiedAt)}，发布前仍需结合实际产品批次确认。
            </p>
            <a class="source-link" href="${esc(gear.source.url)}" target="_blank" rel="noopener noreferrer">
              查看原始来源 ${icons.external}
            </a>
          </article>
          <article class="panel" style="margin-top:14px">
            <h2 class="panel-title">适合这些场景</h2>
            <div class="quick-tags">
              ${(relatedScenes.length ? relatedScenes : state.scenes.slice(0, 3)).map((scene) => `
                <a class="quick-tag" href="/advisor?gear=${gear.id}&scene=${scene.id}" data-link>${esc(scene.title)}</a>
              `).join("")}
            </div>
          </article>
        </aside>
      </section>
    </main>
  `);
  bindCommon();
  document.querySelector("[data-detail-compare]").addEventListener("click", () => {
    toggleCompare(gear.id);
    renderRoute();
  });
}

function advisorForm(gearItems, scenes, selectedGearId, selectedSceneId) {
  return `
    <form class="advisor-form" data-advisor-form>
      <h2>设定你的拍摄现场</h2>
      <p>我们会根据器材画幅、光线与主体运动状态调整建议区间。</p>
      <div class="field">
        <label for="advisor-gear">你的器材</label>
        <select class="select-control" id="advisor-gear" name="gearId" required>
          ${gearItems.map((gear) => `
            <option value="${gear.id}" ${Number(selectedGearId) === gear.id ? "selected" : ""}>
              ${esc(gear.brand)} ${esc(gear.model)}
            </option>
          `).join("")}
        </select>
      </div>
      <div class="field">
        <label for="advisor-scene">拍摄场景</label>
        <select class="select-control" id="advisor-scene" name="sceneId" required>
          ${scenes.map((scene) => `
            <option value="${scene.id}" ${Number(selectedSceneId) === scene.id ? "selected" : ""}>
              ${esc(scene.title)}
            </option>
          `).join("")}
        </select>
      </div>
      <div class="field">
        <label>现场光线</label>
        <div class="segmented">
          <label><input type="radio" name="light" value="soft" checked><span>柔和</span></label>
          <label><input type="radio" name="light" value="low"><span>偏暗</span></label>
          <label><input type="radio" name="light" value="bright"><span>明亮</span></label>
        </div>
      </div>
      <div class="field">
        <label>主体状态</label>
        <div class="segmented">
          <label><input type="radio" name="motion" value="still"><span>静止</span></label>
          <label><input type="radio" name="motion" value="medium" checked><span>缓慢</span></label>
          <label><input type="radio" name="motion" value="fast"><span>快速</span></label>
        </div>
      </div>
      <div class="field">
        <label>经验程度</label>
        <div class="segmented">
          <label><input type="radio" name="experience" value="new"><span>新手</span></label>
          <label><input type="radio" name="experience" value="learning" checked><span>进阶中</span></label>
          <label><input type="radio" name="experience" value="confident"><span>熟练</span></label>
        </div>
      </div>
      <button class="button button-orange" type="submit">生成拍摄参数 ${icons.arrow}</button>
      <div class="advisor-note">建议用于建立起点，不是替代现场观察。拍摄后请始终检查清晰度和高光。</div>
    </form>
  `;
}

function advisorPlaceholder() {
  return `
    <div class="result-placeholder">
      <div class="aperture-illustration"></div>
      <h2>先告诉我们现场情况</h2>
      <p>选择器材与场景后，你会得到光圈、快门、ISO 和参考焦段，以及每条建议背后的条件和风险。</p>
    </div>
  `;
}

function renderAdvisor() {
  const params = queryParts();
  const defaultGear = params.get("gear") || state.gear.find((gear) => gear.category === "camera")?.id;
  const defaultScene = params.get("scene") || state.scenes[0]?.id;
  app.innerHTML = publicShell(`
    <main class="container advisor-page">
      <section class="advisor-intro">
        <span class="eyebrow">SCENE ADVISOR / BETA</span>
        <h1>把现场条件，变成可执行的起点。</h1>
        <p>同一组参数不会适合所有人和所有镜头。告诉我们器材与现场，我们会给出区间、原因和下一步检查项。</p>
      </section>
      <section class="advisor-layout">
        ${advisorForm(state.gear, state.scenes, defaultGear, defaultScene)}
        <div class="advisor-result" data-advisor-result>${advisorPlaceholder()}</div>
      </section>
    </main>
  `);
  bindCommon();
  const form = document.querySelector("[data-advisor-form]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = "正在分析现场…";
    try {
      const formData = new FormData(form);
      const data = await api("/api/advisor", {
        method: "POST",
        body: JSON.stringify({
          gearId: Number(formData.get("gearId")),
          sceneId: Number(formData.get("sceneId")),
          light: formData.get("light"),
          motion: formData.get("motion"),
          experience: formData.get("experience"),
        }),
      });
      renderAdvisorResult(data);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      submit.disabled = false;
      submit.innerHTML = `生成拍摄参数 ${icons.arrow}`;
    }
  });
}

function renderAdvisorResult(data) {
  const { gear, scene, recommendation } = data;
  const container = document.querySelector("[data-advisor-result]");
  container.innerHTML = `
    <div class="result-header ${esc(scene.accent)}">
      <span class="scene-eyebrow">${esc(scene.eyebrow)} / YOUR STARTING POINT</span>
      <h2>${esc(scene.title)}</h2>
      <span class="result-gear">${esc(gear.brand)} ${esc(gear.model)} · ${esc(gear.sensorFormat || gear.mount || "")}</span>
      <span class="result-confidence">建议置信度：${esc(recommendation.confidence)}</span>
    </div>
    <div class="parameter-grid">
      ${recommendation.parameters.map((item) => `
        <article class="parameter-card">
          <span>${esc(item.label)}</span>
          <strong>${esc(item.value)}</strong>
          <small>${esc(item.hint)}</small>
        </article>
      `).join("")}
    </div>
    <div class="result-columns">
      <article class="panel">
        <h2 class="panel-title">为什么这样建议</h2>
        <ul class="result-list">
          ${(recommendation.notes.length ? recommendation.notes : [scene.description]).map((note) => `<li>${esc(note)}</li>`).join("")}
        </ul>
      </article>
      <article class="panel">
        <h2 class="panel-title">拍完先检查</h2>
        <ul class="result-list">
          ${recommendation.checklist.map((item) => `<li>${esc(item)}</li>`).join("")}
        </ul>
      </article>
    </div>
    <div class="result-warning">现场提示：${esc(recommendation.caveat)}</div>
  `;
  container.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderCompare() {
  const params = queryParts();
  const ids = params.get("ids")
    ? params.get("ids").split(",").map(Number).filter(Boolean).slice(0, 3)
    : state.compareIds;
  if (params.get("ids")) {
    state.compareIds = [...new Set(ids)];
    saveCompareIds();
  }
  const selected = ids.map((id) => state.gear.find((gear) => gear.id === id)).filter(Boolean);
  if (!selected.length) {
    app.innerHTML = publicShell(`
      <main class="container compare-page">
        <section class="page-intro">
          <div><span class="eyebrow">COMPARE / 00</span><h1>还没有放入对比的器材。</h1></div>
          <p>从器材库选择两到三款，比较画幅、重量、对焦、视频和镜头系统。</p>
        </section>
        <div class="empty-state" style="margin-top:32px">
          <div class="empty-state-icon">${icons.grid}</div>
          <h3>对比从选择开始</h3>
          <p>我们建议优先比较同一预算和拍摄需求下的候选器材。</p>
          <a class="button button-dark button-small" href="/gear" data-link>选择器材</a>
        </div>
      </main>
    `);
    bindCommon();
    return;
  }
  const specRows = [];
  const seen = new Set();
  for (const gear of selected) {
    for (const spec of gear.specs) {
      if (seen.has(spec.spec_key)) continue;
      seen.add(spec.spec_key);
      specRows.push({ key: spec.spec_key, label: spec.label });
    }
  }
  app.innerHTML = publicShell(`
    <main class="container compare-page">
      <section class="compare-header">
        <div>
          <span class="eyebrow">COMPARE / ${String(selected.length).padStart(2, "0")}</span>
          <h1>放在一起，看清差异。</h1>
        </div>
        <div class="compare-header-actions">
          <button class="button button-ghost button-small" type="button" data-clear-compare>清空全部</button>
          <a class="button button-outline button-small" href="/gear" data-link>继续添加</a>
        </div>
      </section>
      <div class="compare-board">
        <table class="compare-table">
          <thead>
            <tr>
              <th class="row-label">器材</th>
              ${selected.map((gear) => `
                <th>
                  <div class="compare-gear-head">
                    <div class="compare-mini-visual">${gearVisual(gear)}</div>
                    <strong>${esc(gear.brand)} ${esc(gear.model)}</strong>
                    <span>${gear.category === "camera" ? "相机" : "镜头"} · ${esc(gear.sensorFormat || "")}</span>
                    <button class="compare-remove" type="button" data-remove-compare="${gear.id}">移除此项</button>
                  </div>
                </th>
              `).join("")}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="row-label">参考价格</td>
              ${selected.map((gear) => `<td class="compare-spec-value">¥${Number(gear.priceCny || 0).toLocaleString("zh-CN")}</td>`).join("")}
            </tr>
            <tr>
              <td class="row-label">发布时间</td>
              ${selected.map((gear) => `<td class="compare-spec-value">${esc(gear.releaseYear || "—")}</td>`).join("")}
            </tr>
            <tr>
              <td class="row-label">镜头系统</td>
              ${selected.map((gear) => `<td class="compare-spec-value">${esc(gear.mount || "—")}</td>`).join("")}
            </tr>
            ${specRows.map((row) => `
              <tr>
                <td class="row-label">${esc(row.label)}</td>
                ${selected.map((gear) => {
                  const spec = gear.specs.find((item) => item.spec_key === row.key);
                  return `<td class="compare-spec-value">${spec ? `${esc(spec.value)}${spec.unit ? ` ${esc(spec.unit)}` : ""}` : "—"}</td>`;
                }).join("")}
              </tr>
            `).join("")}
            <tr>
              <td class="row-label">适合场景</td>
              ${selected.map((gear) => `<td>${gear.bestFor.map((tag) => `<span class="tag">${esc(tag)}</span>`).join(" ")}</td>`).join("")}
            </tr>
          </tbody>
        </table>
      </div>
      <p class="compare-source">数据来源与核验时间请进入各器材详情页查看。跨画幅比较时，焦距和光圈的实际视觉效果并不完全等价。</p>
    </main>
  `);
  bindCommon();
}

function toggleCompare(id) {
  const index = state.compareIds.indexOf(id);
  if (index >= 0) {
    state.compareIds.splice(index, 1);
  } else {
    if (state.compareIds.length >= 3) {
      toast("最多同时对比 3 款器材", "error");
      return false;
    }
    state.compareIds.push(id);
  }
  saveCompareIds();
  refreshCompareUI();
  return true;
}

function removeCompareItem(id) {
  state.compareIds = state.compareIds.filter((item) => item !== id);
  saveCompareIds();
  if (window.location.pathname === "/compare") {
    navigate(state.compareIds.length ? `/compare?ids=${state.compareIds.join(",")}` : "/compare");
    return;
  }
  refreshCompareUI();
}

function clearCompare() {
  state.compareIds = [];
  saveCompareIds();
  if (window.location.pathname === "/compare") {
    navigate("/compare");
    return;
  }
  refreshCompareUI();
}

function refreshCompareUI() {
  document.querySelectorAll("[data-compare-count]").forEach((node) => {
    node.textContent = state.compareIds.length;
  });
  document.querySelectorAll("[data-compare-id]").forEach((checkbox) => {
    const id = Number(checkbox.dataset.compareId);
    checkbox.checked = state.compareIds.includes(id);
    checkbox.disabled = !checkbox.checked && state.compareIds.length >= 3;
  });
  const dock = document.querySelector("[data-compare-dock]");
  if (dock) dock.outerHTML = compareDock();
  else if (state.compareIds.length) {
    document.body.insertAdjacentHTML("beforeend", compareDock());
  }
  const detailButton = document.querySelector("[data-detail-compare]");
  if (detailButton) {
    const selected = state.compareIds.includes(Number(detailButton.dataset.detailCompare));
    detailButton.classList.toggle("button-dark", !selected);
    detailButton.classList.toggle("button-outline", selected);
    detailButton.textContent = selected ? "已加入对比" : "加入对比清单";
  }
}

function bindCommon() {
  document.querySelectorAll("[data-compare-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      toggleCompare(Number(checkbox.dataset.compareId));
    });
  });
  document.querySelector("[data-mobile-menu]")?.addEventListener("click", () => {
    const nav = document.querySelector(".nav");
    if (!nav) return;
    const open = nav.classList.toggle("mobile-open");
    nav.style.cssText = open
      ? "display:flex;position:absolute;top:72px;left:18px;right:18px;padding:22px;background:#fffdf8;border:1px solid rgba(23,24,22,.14);border-radius:16px;box-shadow:0 20px 45px rgba(30,25,18,.15);flex-direction:column;align-items:flex-start;z-index:30"
      : "";
  });
}

async function loadBaseData() {
  const [gearData, sceneData] = await Promise.all([
    api("/api/gear"),
    api("/api/scenes"),
  ]);
  state.gear = gearData.items;
  state.scenes = sceneData.items;
  state.compareIds = state.compareIds.filter((id) => state.gear.some((gear) => gear.id === id));
}

async function renderRoute() {
  const path = window.location.pathname;
  try {
    if (path === "/admin" || path.startsWith("/admin/")) {
      await renderAdmin();
      return;
    }

    app.innerHTML = '<div class="loading-page"><div class="loading-mark"></div></div>';
    if (!state.gear.length || !state.scenes.length) await loadBaseData();
    window.scrollTo(0, 0);

    if (path === "/") {
      renderHome();
    } else if (path === "/gear") {
      renderCatalog();
    } else if (path.startsWith("/gear/")) {
      const slug = decodeURIComponent(path.slice("/gear/".length));
      const gear = state.gear.find((item) => item.slug === slug);
      if (!gear) {
        app.innerHTML = publicShell(`
          <main class="container">
            <div class="empty-state" style="margin:80px 0">
              <div class="empty-state-icon">${icons.search}</div>
              <h3>没有找到这款器材</h3>
              <p>它可能尚未收录，或者链接已经失效。</p>
              <a class="button button-dark button-small" href="/gear" data-link>返回器材库</a>
            </div>
          </main>
        `);
        bindCommon();
        return;
      }
      renderGearDetail(gear);
    } else if (path === "/advisor") {
      renderAdvisor();
    } else if (path === "/compare") {
      renderCompare();
    } else {
      app.innerHTML = publicShell(`
        <main class="container">
          <div class="empty-state" style="margin:80px 0">
            <div class="empty-state-icon">${icons.search}</div>
            <h3>这一幕没有对上焦</h3>
            <p>页面可能已经移动，或者从未存在。</p>
            <a class="button button-dark button-small" href="/" data-link>返回首页</a>
          </div>
        </main>
      `);
      bindCommon();
    }
  } catch (error) {
    console.error(error);
    toast(error.message || "页面加载失败", "error");
    app.innerHTML = publicShell(`
      <main class="container">
        <div class="empty-state" style="margin:80px 0">
          <h3>页面暂时没有加载成功</h3>
          <p>${esc(error.message || "请稍后重试")}</p>
          <button class="button button-dark button-small" data-retry>重新加载</button>
        </div>
      </main>
    `);
    document.querySelector("[data-retry]")?.addEventListener("click", () => renderRoute());
  }
}

async function renderAdmin() {
  const module = await import("./admin.js");
  await module.renderAdminApp(app, renderRoute);
}

function navigate(path) {
  if (window.location.pathname + window.location.search === path) return;
  history.pushState({}, "", path);
  renderRoute();
}

document.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-compare]");
  if (removeButton) {
    event.preventDefault();
    removeCompareItem(Number(removeButton.dataset.removeCompare));
    return;
  }
  const clearButton = event.target.closest("[data-clear-compare]");
  if (clearButton) {
    event.preventDefault();
    clearCompare();
    return;
  }
  const link = event.target.closest("a[href^='/']");
  if (!link || link.target === "_blank" || event.metaKey || event.ctrlKey) return;
  if (link.getAttribute("href").startsWith("/api/")) return;
  event.preventDefault();
  navigate(link.getAttribute("href"));
});

window.addEventListener("popstate", renderRoute);

async function bootstrap() {
  try {
    await ensureCsrf();
    setCsrf();
    await renderRoute();
  } catch (error) {
    console.error(error);
    app.innerHTML = `
      <main class="loading-page">
        <div class="empty-state">
          <h3>应用未能启动</h3>
          <p>${esc(error.message)}</p>
          <button class="button button-dark" type="button" data-bootstrap-retry>重新加载</button>
        </div>
      </main>
    `;
    document.querySelector("[data-bootstrap-retry]")?.addEventListener("click", () => location.reload());
  }
}

bootstrap();
