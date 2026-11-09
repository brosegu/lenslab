import { api, formatDate, formatDateTime, setCsrf, toast } from "./api.js";

let sessionUser = null;
let crawlPollTimer = null;
let reviewConfidenceFilter = "all";

const icons = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10H3V8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="4"/></svg>',
  review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 3h9l4 4v14H6V3Z"/><path d="M15 3v5h4M9 13h7M9 17h5"/></svg>',
  scene: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>',
  source: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3 5 6v5c0 4.8 2.9 8.2 7 10 4.1-1.8 7-5.2 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

function esc(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function go(path) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function adminIcon(label) {
  const map = {
    "admin.login": "登录后台",
    "admin.logout": "退出后台",
    "admin.password_changed": "修改管理员密码",
    "gear.updated": "订正器材数据",
    "source.updated": "修改采集来源",
    "review.approved": "通过采集审核",
    "review.rejected": "驳回采集数据",
    "scene.updated": "修改场景参数",
  };
  return map[label] || label;
}

function confirmLabel(confidence = "") {
  const map = { high: "高置信", medium: "中置信", low: "低置信" };
  return map[confidence] || confidence;
}

function layout(content, active, pendingCount = 0) {
  const navItems = [
    ["dashboard", "/admin", "工作概览", icons.dashboard],
    ["gear", "/admin/gear", "器材管理", icons.camera],
    ["sources", "/admin/sources", "采集来源", icons.source],
    ["reviews", "/admin/reviews", "采集审核", icons.review],
    ["scenes", "/admin/scenes", "场景参数", icons.scene],
    ["audit", "/admin/audit", "审计日志", icons.audit],
  ];
  return `
    <div class="admin-root">
      <aside class="admin-sidebar">
        <a class="brand" href="/" aria-label="返回镜研前台">
          <span class="brand-mark"><span></span></span>
          <span>
            <span class="brand-name">镜研</span>
            <span class="brand-en">CONTROL ROOM</span>
          </span>
        </a>
        <nav class="admin-nav" aria-label="后台导航">
          <span class="admin-nav-label">WORKSPACE</span>
          ${navItems.map(([key, href, label, icon]) => `
            <a class="admin-nav-link ${active === key ? "active" : ""}" href="${href}" data-link>
              ${icon}<span>${label}</span>
              ${key === "reviews" && pendingCount ? `<span class="admin-nav-badge">${pendingCount}</span>` : ""}
            </a>
          `).join("")}
          <span class="admin-nav-label">PUBLIC SITE</span>
          <a class="admin-nav-link" href="/" data-link>${icons.external}<span>查看前台</span></a>
        </nav>
        <div class="admin-sidebar-footer">
          <div class="admin-user">
            <span class="admin-avatar">${esc((sessionUser?.username || "A").slice(0, 1).toUpperCase())}</span>
            <div>
              <strong>${esc(sessionUser?.username || "管理员")}</strong>
              <span>CONTENT ADMIN</span>
            </div>
            <button class="icon-button logout-text" type="button" data-logout aria-label="退出登录" style="margin-left:auto;color:rgba(255,255,255,.5);border-color:rgba(255,255,255,.12)">
              ${icons.logout}
            </button>
          </div>
        </div>
      </aside>
      <div class="admin-content">
        <header class="admin-topbar">
          <span class="admin-breadcrumb">LENSLAB / <strong>${active === "dashboard" ? "工作概览" : navItems.find(([key]) => key === active)?.[2] || "后台"}</strong></span>
          <div class="admin-topbar-actions">
            <a class="icon-button" href="/" target="_blank" rel="noopener" aria-label="在新窗口打开前台">${icons.external}</a>
            <button class="icon-button" type="button" data-logout aria-label="退出登录">${icons.logout}</button>
          </div>
        </header>
        <main class="admin-main">${content}</main>
      </div>
    </div>
  `;
}

function renderLogin(app) {
  app.innerHTML = `
    <div class="login-page">
      <section class="login-visual">
        <a class="brand" href="/" aria-label="返回镜研前台">
          <span class="brand-mark"><span></span></span>
          <span>
            <span class="brand-name">镜研</span>
            <span class="brand-en">CONTROL ROOM</span>
          </span>
        </a>
        <div class="login-quote">
          <span>DATA WITH INTEGRITY</span>
          <h1>每一次订正，<br>都值得被记录。</h1>
          <p>管理采集数据、核对字段差异，并以可追溯的方式发布。后台操作会进入审计日志。</p>
        </div>
      </section>
      <section class="login-form-side">
        <div class="login-box">
          <span class="eyebrow">ADMIN ACCESS</span>
          <h2>进入管理后台</h2>
          <p>使用管理员账号登录。首次登录需要设置新密码。</p>
          <form data-login-form novalidate>
            <div class="login-field">
              <label for="login-username">用户名</label>
              <input class="input-control" id="login-username" name="username" autocomplete="username" maxlength="64" value="brose" required>
            </div>
            <div class="login-field">
              <label for="login-password">密码</label>
              <input class="input-control" id="login-password" name="password" type="password" autocomplete="current-password" required>
            </div>
            <div data-login-error></div>
            <button class="button button-dark" type="submit">安全登录 ${icons.arrow}</button>
          </form>
          <div class="security-note">
            ${icons.shield}
            <span>会话 Cookie 仅限 HTTP 访问，并启用 CSRF 校验、登录限流与失败锁定。初始密码不会发送到前端。</span>
          </div>
        </div>
      </section>
    </div>
  `;
  bindLogout();
  const form = document.querySelector("[data-login-form]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button");
    const errorBox = document.querySelector("[data-login-error]");
    submit.disabled = true;
    errorBox.innerHTML = "";
    try {
      const formData = new FormData(form);
      const data = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: formData.get("username"),
          password: formData.get("password"),
        }),
      });
      setCsrf(data.csrfToken);
      sessionUser = data.user;
      if (data.user.mustChangePassword) {
        go("/admin/password");
      } else {
        go("/admin");
      }
    } catch (error) {
      errorBox.innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
      form.querySelector('input[name="password"]').focus();
    } finally {
      submit.disabled = false;
    }
  });
}

function renderPasswordChange(app) {
  app.innerHTML = `
    <div class="password-page">
      <section class="password-card">
        <span class="eyebrow">FIRST SIGN-IN / SECURITY</span>
        <h1>先换掉初始密码。</h1>
        <p>管理员账号已建立。为了避免弱初始密码长期暴露，完成修改后才能进入数据管理功能。</p>
        <form data-password-form novalidate>
          <div class="login-field">
            <label for="current-password">当前密码</label>
            <input class="input-control" id="current-password" name="currentPassword" type="password" autocomplete="current-password" required>
          </div>
          <div class="login-field">
            <label for="new-password">新密码</label>
            <input class="input-control" id="new-password" name="newPassword" type="password" autocomplete="new-password" minlength="10" required>
          </div>
          <div class="login-field">
            <label for="confirm-password">再次输入新密码</label>
            <input class="input-control" id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="10" required>
          </div>
          <div data-password-error></div>
          <button class="button button-dark" type="submit">更新密码并进入后台 ${icons.arrow}</button>
        </form>
        <div class="security-note">
          ${icons.shield}
          <span>新密码至少 10 个字符，并同时包含字母与数字。修改后所有旧会话会立即失效。</span>
        </div>
        <button class="button button-ghost button-small" type="button" data-logout style="margin-top:14px">退出当前账号</button>
      </section>
    </div>
  `;
  bindLogout();
  const form = document.querySelector("[data-password-form]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = document.querySelector("[data-password-error]");
    const submit = form.querySelector('button[type="submit"]');
    const formData = new FormData(form);
    errorBox.innerHTML = "";
    if (formData.get("newPassword") !== formData.get("confirmPassword")) {
      errorBox.innerHTML = '<p class="form-error">两次输入的新密码不一致</p>';
      return;
    }
    submit.disabled = true;
    try {
      const data = await api("/api/admin/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: formData.get("currentPassword"),
          newPassword: formData.get("newPassword"),
        }),
      });
      setCsrf(data.csrfToken);
      sessionUser = data.user;
      toast("密码已更新");
      go("/admin");
    } catch (error) {
      errorBox.innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
    } finally {
      submit.disabled = false;
    }
  });
}

function bindLogout() {
  document.querySelectorAll("[data-logout]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api("/api/auth/logout", { method: "POST" });
      } catch {
        // A stale session should still return the user to the login page.
      } finally {
        sessionUser = null;
        go("/admin/login");
      }
    });
  });
}

async function renderDashboard(app) {
  const data = await api("/api/admin/stats");
  const pending = data.counts.pendingReviews;
  const recent = data.recentAudit;
  app.innerHTML = layout(`
    <div class="admin-page-heading">
      <div>
        <span class="eyebrow">OVERVIEW / ${new Date().getFullYear()}</span>
        <h1>工作概览</h1>
        <p>检查采集变化，维护器材和场景数据，让每一次发布都有据可查。</p>
      </div>
      <a class="button button-dark button-small" href="/admin/reviews" data-link>处理待审数据 ${pending ? `(${pending})` : ""}</a>
    </div>
    <section class="stat-grid">
      <article class="stat-card dark">
        <span class="stat-label">PENDING REVIEW</span>
        <div class="stat-value">${pending}<small>条待审核</small></div>
        <div class="stat-note">高优先级：官方来源字段变化</div>
      </article>
      <article class="stat-card">
        <span class="stat-label">GEAR LIBRARY</span>
        <div class="stat-value">${data.counts.gear}<small>款器材</small></div>
        <div class="stat-note">${data.counts.cameras} 台相机 · ${data.counts.lenses} 支镜头</div>
      </article>
      <article class="stat-card">
        <span class="stat-label">SCENE PROFILES</span>
        <div class="stat-value">${data.counts.scenes}<small>个场景</small></div>
        <div class="stat-note">全部带适用条件与风险提示</div>
      </article>
      <article class="stat-card">
        <span class="stat-label">VERIFIED DATA</span>
        <div class="stat-value">${data.counts.verified}<small>条核验器材</small></div>
        <div class="stat-note">以厂商官方资料为主来源</div>
      </article>
    </section>
    <section class="admin-grid">
      <article class="admin-panel">
        <div class="admin-panel-head">
          <h2>最近操作</h2>
          <a class="mini-link" href="/admin/audit" data-link>查看审计日志 →</a>
        </div>
        <div class="activity-list">
          ${recent.length ? recent.map((item) => `
            <div class="activity-item">
              <div>
                <strong>${esc(adminIcon(item.action))}</strong>
                <span>${esc(item.actor)} · ${formatDateTime(item.created_at)} · ${esc(item.entity_type)} #${esc(item.entity_id)}</span>
              </div>
              <span class="audit-action">${esc(item.action)}</span>
            </div>
          `).join("") : '<div class="activity-item"><span>暂无审核或订正记录</span></div>'}
        </div>
      </article>
      <article class="admin-panel">
        <div class="admin-panel-head">
          <h2>采集源状态</h2>
          <span class="confidence-chip high">运行正常</span>
        </div>
        <div class="source-status-list">
          ${data.sources.map((source) => `
            <div class="source-status-item">
              <span class="source-dot"></span>
              <div><strong>${esc(source.name)}</strong></div>
              <span>${esc(source.cadence)}</span>
            </div>
          `).join("")}
        </div>
        <p class="stat-note" style="margin-top:16px;line-height:1.6">
          当前支持手动采集。任务会记录每个来源的 HTTP 状态、页面指纹和错误原因；首次运行建立基线，页面变化后进入待审核区。
        </p>
      </article>
    </section>
  `, "dashboard", pending);
  bindLogout();
}

async function renderGearManager(app) {
  const [gearData, stats] = await Promise.all([
    api("/api/admin/gear"),
    api("/api/admin/stats"),
  ]);
  app.innerHTML = layout(`
    <div class="admin-page-heading">
      <div>
        <span class="eyebrow">DATA CATALOG</span>
        <h1>器材管理</h1>
        <p>对已发布或待发布器材逐项订正。所有修改写进审计日志。</p>
      </div>
      <button class="button button-dark button-small" type="button" data-export>导出当前数据</button>
    </div>
    <div class="toolbar">
      <input class="input-control" type="search" placeholder="搜索品牌、型号或场景" data-gear-search>
      <select class="select-control" data-gear-category>
        <option value="">全部类型</option>
        <option value="camera">相机</option>
        <option value="lens">镜头</option>
      </select>
      <span class="result-count" style="margin-left:auto">共 ${gearData.items.length} 款</span>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr><th>器材</th><th>类型</th><th>画幅 / 格式</th><th>卡口</th><th>价格</th><th>数据状态</th><th>操作</th></tr>
        </thead>
        <tbody data-gear-rows>
          ${gearData.items.map(gearRow).join("")}
        </tbody>
      </table>
    </div>
  `, "gear", stats.counts.pendingReviews);
  bindLogout();

  const search = document.querySelector("[data-gear-search]");
  const category = document.querySelector("[data-gear-category]");
  const filterRows = () => {
    const query = search.value.trim().toLowerCase();
    document.querySelectorAll("[data-gear-row]").forEach((row) => {
      const matchesQuery = row.dataset.search.includes(query);
      const matchesCategory = !category.value || row.dataset.category === category.value;
      row.style.display = matchesQuery && matchesCategory ? "" : "none";
    });
  };
  search.addEventListener("input", filterRows);
  category.addEventListener("change", filterRows);
  document.querySelectorAll("[data-edit-gear]").forEach((button) => {
    button.addEventListener("click", () => openGearEditor(button.dataset.editGear, app));
  });
  document.querySelector("[data-export]").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(gearData.items, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `lenslab-gear-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

function gearRow(gear) {
  return `
    <tr data-gear-row data-category="${esc(gear.category)}"
        data-search="${esc(`${gear.brand} ${gear.model} ${gear.bestFor.join(" ")}`.toLowerCase())}">
      <td>
        <div class="gear-cell">
          <span class="gear-swatch ${esc(gear.accent)}"></span>
          <div><strong>${esc(gear.brand)} ${esc(gear.model)}</strong><span>更新于 ${formatDate(gear.updatedAt)}</span></div>
        </div>
      </td>
      <td>${gear.category === "camera" ? "相机" : "镜头"}</td>
      <td>${esc(gear.sensorFormat || "—")}</td>
      <td>${esc(gear.mount || "—")}</td>
      <td>¥${Number(gear.priceCny || 0).toLocaleString("zh-CN")}</td>
      <td><span class="confidence-chip ${gear.confidence === "verified" ? "high" : "medium"}">${gear.confidence === "verified" ? "已核验" : "人工复核"}</span></td>
      <td><button class="button button-outline small-button" type="button" data-edit-gear="${gear.id}">逐字段订正</button></td>
    </tr>
  `;
}

async function openGearEditor(id, app) {
  const { item } = await api(`/api/admin/gear/${id}`);
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <form class="modal" data-gear-form>
      <div class="modal-header">
        <h2>订正 ${esc(item.brand)} ${esc(item.model)}</h2>
        <button class="modal-close" type="button" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="form-field">
            <label>品牌</label>
            <input class="input-control" name="brand" maxlength="80" value="${esc(item.brand)}" required>
          </div>
          <div class="form-field">
            <label>型号</label>
            <input class="input-control" name="model" maxlength="80" value="${esc(item.model)}" required>
          </div>
          <div class="form-field">
            <label>发布时间</label>
            <input class="input-control" name="release_year" type="number" min="1900" max="2100" value="${esc(item.releaseYear)}">
          </div>
          <div class="form-field">
            <label>参考价格（人民币）</label>
            <input class="input-control" name="price_cny" type="number" min="1" value="${esc(item.priceCny)}">
          </div>
          <div class="form-field">
            <label>镜头系统</label>
            <input class="input-control" name="mount" maxlength="80" value="${esc(item.mount || "")}">
          </div>
          <div class="form-field">
            <label>画幅 / 格式</label>
            <input class="input-control" name="sensor_format" maxlength="40" value="${esc(item.sensorFormat || "")}">
          </div>
          <div class="form-field full">
            <label>适合场景（用逗号分隔）</label>
            <input class="input-control" name="best_for" value="${esc(item.bestFor.join("，"))}">
          </div>
          <div class="form-field full">
            <label>简介</label>
            <textarea class="textarea-control" name="summary" maxlength="500">${esc(item.summary)}</textarea>
          </div>
          <div class="form-field">
            <label>发布状态</label>
            <select class="select-control" name="status">
              <option value="published" ${item.status === "published" ? "selected" : ""}>已发布</option>
              <option value="draft" ${item.status === "draft" ? "selected" : ""}>草稿</option>
            </select>
          </div>
          <div class="form-field">
            <label>数据置信度</label>
            <select class="select-control" name="confidence">
              <option value="verified" ${item.confidence === "verified" ? "selected" : ""}>已核验</option>
              <option value="reviewed" ${item.confidence === "reviewed" ? "selected" : ""}>人工复核</option>
              <option value="unverified" ${item.confidence === "unverified" ? "selected" : ""}>未核验</option>
            </select>
          </div>
          <div class="form-field full">
            <label>规格字段订正</label>
            <div class="spec-edit-list">
              ${item.specs.map((spec) => `
                <div class="spec-edit-row">
                  <span title="${esc(spec.label)}">${esc(spec.label)}</span>
                  <input data-spec-key="${esc(spec.spec_key)}" data-spec-label="${esc(spec.label)}" value="${esc(spec.value)}" maxlength="300">
                  <input data-spec-unit="${esc(spec.spec_key)}" value="${esc(spec.unit || "")}" maxlength="20" placeholder="单位">
                </div>
              `).join("")}
            </div>
          </div>
        </div>
        <div data-gear-form-error></div>
      </div>
      <div class="modal-footer">
        <button class="button button-outline button-small" type="button" data-close>取消</button>
        <button class="button button-dark button-small" type="submit">保存订正</button>
      </div>
    </form>
  `;
  document.body.append(modal);
  const close = () => modal.remove();
  modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const specs = {};
    form.querySelectorAll("[data-spec-key]").forEach((input) => {
      const key = input.dataset.specKey;
      specs[key] = {
        label: input.dataset.specLabel,
        value: input.value,
        unit: form.querySelector(`[data-spec-unit="${CSS.escape(key)}"]`)?.value || "",
      };
    });
    const changes = {
      brand: formData.get("brand"),
      model: formData.get("model"),
      release_year: Number(formData.get("release_year")) || null,
      price_cny: Number(formData.get("price_cny")) || null,
      mount: formData.get("mount"),
      sensor_format: formData.get("sensor_format"),
      best_for: String(formData.get("best_for")).split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      summary: formData.get("summary"),
      status: formData.get("status"),
      confidence: formData.get("confidence"),
    };
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/api/admin/gear/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ changes, specs }),
      });
      toast("器材数据已订正并记录审计日志");
      close();
      await renderGearManager(app);
    } catch (error) {
      modal.querySelector("[data-gear-form-error]").innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
    } finally {
      submit.disabled = false;
    }
  });
}

function sourceStatus(status) {
  return {
    configured: "待验证",
    healthy: "运行正常",
    paused: "已暂停",
    error: "采集中断",
  }[status] || status;
}

function crawlRunStatus(status) {
  return {
    queued: "排队中",
    running: "采集进行中",
    completed: "采集完成",
    partial: "部分成功",
    failed: "采集失败",
  }[status] || status;
}

function crawlItemStatus(status) {
  return {
    baseline: "已建立基线",
    unchanged: "内容未变化",
    changed: "发现变化",
    failed: "失败",
    skipped: "已跳过",
  }[status] || status;
}

function crawlRunPanel(runs) {
  const latest = runs[0];
  if (!latest) {
    return `
      <article class="admin-panel crawl-panel">
        <div class="admin-panel-head">
          <h2>采集任务</h2>
          <span class="result-count">暂无运行记录</span>
        </div>
        <div class="crawl-empty">点击“立即采集全部”，系统会依次检查当前启用的官方来源。</div>
      </article>
    `;
  }
  const active = ["queued", "running"].includes(latest.status);
  const duration = latest.finishedAt && latest.startedAt
    ? Math.max(0, Date.parse(latest.finishedAt) - Date.parse(latest.startedAt))
    : Date.now() - Date.parse(latest.startedAt || latest.createdAt);
  return `
    <article class="admin-panel crawl-panel">
      <div class="admin-panel-head">
        <div>
          <h2>最近一次采集 · #${latest.id}</h2>
          <span class="result-count">
            ${formatDateTime(latest.createdAt)} 发起 · ${(duration / 1000).toFixed(1)} 秒
          </span>
        </div>
        <span class="confidence-chip ${latest.status === "completed" ? "high" : latest.status === "failed" ? "low" : "medium"}">
          ${esc(crawlRunStatus(latest.status))}
        </span>
      </div>
      <div class="crawl-run-metrics">
        <span><strong>${latest.sourceCount}</strong> 来源</span>
        <span><strong>${latest.successCount}</strong> 成功</span>
        <span><strong>${latest.baselineCount}</strong> 基线</span>
        <span><strong>${latest.changedCount}</strong> 变化</span>
        <span><strong>${latest.unchangedCount}</strong> 未变化</span>
        <span><strong>${latest.failureCount}</strong> 失败</span>
        <span><strong>${latest.reviewCount}</strong> 新待审</span>
      </div>
      ${active ? `<div class="crawl-progress"><span></span></div>` : ""}
      ${latest.items?.length ? `
        <div class="crawl-result-list">
          ${latest.items.map((item) => `
            <div class="crawl-result-row">
              <div>
                <strong>${esc(item.sourceName)}</strong>
                <span>${esc(crawlItemStatus(item.status))}${item.httpStatus ? ` · HTTP ${item.httpStatus}` : ""}${item.durationMs ? ` · ${item.durationMs}ms` : ""}</span>
              </div>
              <div class="crawl-result-detail">
                ${item.errorMessage
                  ? `<span class="crawl-error">${esc(item.errorMessage)}</span>`
                  : `<span>${item.bytes ? `${Math.round(item.bytes / 1024)}KB · ` : ""}${item.linksFound || 0} 个链接 · ${item.productCandidates || 0} 个产品候选${item.productResults?.length ? ` · ${item.productResults.filter((result) => result.parsed).length} 个详情页已解析` : ""}</span>`}
                ${item.finalUrl ? `<a href="${esc(item.finalUrl)}" target="_blank" rel="noopener noreferrer">页面 ↗</a>` : ""}
              </div>
            </div>
            ${item.productResults?.filter((result) => result.error).length ? `
              <div class="crawl-product-errors">
                ${[...new Set(item.productResults.filter((result) => result.error).map((result) => result.error))].slice(0, 2).map((error) => `<span>${esc(error)}</span>`).join("")}
              </div>
            ` : ""}
          `).join("")}
        </div>
      ` : ""}
      ${runs.length > 1 ? `
        <details class="crawl-history">
          <summary>查看最近 ${runs.length} 次任务</summary>
          ${runs.slice(1).map((run) => `
            <div class="crawl-history-row">
              <span>#${run.id} · ${formatDateTime(run.createdAt)}</span>
              <span>${esc(crawlRunStatus(run.status))} · ${run.successCount}/${run.sourceCount} 成功</span>
            </div>
          `).join("")}
        </details>
      ` : ""}
    </article>
  `;
}

async function renderSources(app) {
  const [sourceData, stats, runData] = await Promise.all([
    api("/api/admin/sources"),
    api("/api/admin/stats"),
    api("/api/admin/crawl-runs?limit=8"),
  ]);
  const latestRun = runData.items[0];
  app.innerHTML = layout(`
    <div class="admin-page-heading">
      <div>
        <span class="eyebrow">SOURCE REGISTRY</span>
        <h1>采集来源</h1>
        <p>手动触发采集并查看每个官方来源的 HTTP 状态、页面变化和错误原因。</p>
      </div>
      <button class="button button-dark button-small" type="button" data-start-crawl ${latestRun && ["queued", "running"].includes(latestRun.status) ? "disabled" : ""}>
        ${latestRun && ["queued", "running"].includes(latestRun.status) ? "采集进行中…" : "立即采集全部"}
      </button>
    </div>
    <section class="stat-grid">
      <article class="stat-card dark">
        <span class="stat-label">REGISTERED SOURCES</span>
        <div class="stat-value">${sourceData.summary.total}<small>个来源</small></div>
        <div class="stat-note">已内置官方入口</div>
      </article>
      <article class="stat-card">
        <span class="stat-label">ENABLED</span>
        <div class="stat-value">${sourceData.summary.enabled}<small>个已启用</small></div>
        <div class="stat-note">可随时暂停单个来源</div>
      </article>
      <article class="stat-card">
        <span class="stat-label">HIGH PRIORITY</span>
        <div class="stat-value">${sourceData.summary.highPriority}<small>个高优先级</small></div>
        <div class="stat-note">机身与主流镜头厂商优先</div>
      </article>
      <article class="stat-card">
        <span class="stat-label">VERIFIED HEALTH</span>
        <div class="stat-value">${sourceData.summary.verified}<small>个已验证</small></div>
        <div class="stat-note">其余来源等待真实采集测试</div>
      </article>
    </section>
    <div class="result-warning" style="margin:18px 0">
      当前支持手动采集，不会自动绕过 robots.txt、登录或反爬限制。首次采集用于建立页面基线，之后页面内容指纹变化时会生成待审核记录。
    </div>
    ${crawlRunPanel(runData.items)}
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr><th>官方来源</th><th>优先级</th><th>采集字段</th><th>频率</th><th>状态</th><th>启用</th><th>操作</th></tr>
        </thead>
        <tbody>
          ${sourceData.items.map((source) => `
            <tr>
              <td>
                <div class="gear-cell">
                  <span class="gear-swatch ${source.enabled ? "forest" : "graphite"}"></span>
                  <div>
                    <strong>${esc(source.name)}</strong>
                    <span>${esc(new URL(source.url).hostname)} · ${source.official ? "官方" : "非官方"}</span>
                  </div>
                </div>
              </td>
              <td>${source.priority === "high" ? "高" : source.priority === "medium" ? "中" : "低"}</td>
              <td title="${esc(source.fieldScope.join("、"))}">${esc(source.fieldScope.slice(0, 2).join(" · "))}${source.fieldScope.length > 2 ? ` +${source.fieldScope.length - 2}` : ""}</td>
              <td>${esc(source.cadence)}</td>
              <td><span class="confidence-chip ${source.status === "healthy" ? "high" : "medium"}">${esc(sourceStatus(source.status))}</span></td>
              <td>${source.enabled ? "已启用" : "已暂停"}</td>
              <td>
                <button class="button button-outline small-button" type="button" data-edit-source="${source.id}">配置</button>
                <button class="button button-outline small-button" type="button" data-crawl-source="${source.id}" ${!source.enabled || (latestRun && ["queued", "running"].includes(latestRun.status)) ? "disabled" : ""}>采集</button>
                <button class="button button-ghost small-button" type="button" data-toggle-source="${source.id}">${source.enabled ? "暂停" : "启用"}</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `, "sources", stats.counts.pendingReviews);
  bindLogout();

  if (crawlPollTimer) {
    clearTimeout(crawlPollTimer);
    crawlPollTimer = null;
  }
  if (latestRun && ["queued", "running"].includes(latestRun.status)) {
    crawlPollTimer = window.setTimeout(async () => {
      try {
        const { item } = await api(`/api/admin/crawl-runs/${latestRun.id}`);
        if (["queued", "running"].includes(item.status)) {
          await renderSources(app);
        } else {
          toast(`采集任务 #${item.id} 已完成：${item.successCount} 成功，${item.failureCount} 失败`);
          await renderSources(app);
        }
      } catch (error) {
        toast(error.message, "error");
      }
    }, 1500);
  }

  const startCrawl = async (sourceIds, button) => {
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "正在创建任务…";
    try {
      const { item } = await api("/api/admin/crawl-runs", {
        method: "POST",
        body: JSON.stringify({ sourceIds }),
      });
      toast(`采集任务 #${item.id} 已创建`);
      await renderSources(app);
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = originalText;
    }
  };
  document.querySelector("[data-start-crawl]")?.addEventListener("click", (event) => {
    startCrawl([], event.currentTarget);
  });
  document.querySelectorAll("[data-crawl-source]").forEach((button) => {
    button.addEventListener("click", () => {
      startCrawl([Number(button.dataset.crawlSource)], button);
    });
  });

  document.querySelectorAll("[data-edit-source]").forEach((button) => {
    const source = sourceData.items.find((item) => item.id === Number(button.dataset.editSource));
    button.addEventListener("click", () => openSourceEditor(source, app));
  });
  document.querySelectorAll("[data-toggle-source]").forEach((button) => {
    const source = sourceData.items.find((item) => item.id === Number(button.dataset.toggleSource));
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/api/admin/sources/${source.id}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: !source.enabled }),
        });
        toast(source.enabled ? "来源已暂停" : "来源已启用");
        await renderSources(app);
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
      }
    });
  });
}

function openSourceEditor(source, app) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <form class="modal" data-source-form>
      <div class="modal-header">
        <h2>配置 ${esc(source.name)}</h2>
        <button class="modal-close" type="button" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="form-field">
            <label>来源名称</label>
            <input class="input-control" name="name" value="${esc(source.name)}" maxlength="100" required>
          </div>
          <div class="form-field">
            <label>品牌</label>
            <input class="input-control" name="brand" value="${esc(source.brand)}" maxlength="80">
          </div>
          <div class="form-field full">
            <label>官方入口 URL</label>
            <input class="input-control" name="url" type="url" value="${esc(source.url)}" required>
          </div>
          <div class="form-field">
            <label>采集频率</label>
            <select class="select-control" name="cadence">
              ${["每日", "每周", "每月", "手动"].map((cadence) => `<option ${source.cadence === cadence ? "selected" : ""}>${cadence}</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label>优先级</label>
            <select class="select-control" name="priority">
              <option value="high" ${source.priority === "high" ? "selected" : ""}>高</option>
              <option value="medium" ${source.priority === "medium" ? "selected" : ""}>中</option>
              <option value="low" ${source.priority === "low" ? "selected" : ""}>低</option>
            </select>
          </div>
          <div class="form-field full">
            <label>采集字段范围（每行一项）</label>
            <textarea class="textarea-control" name="fieldScope">${esc(source.fieldScope.join("\n"))}</textarea>
          </div>
          <div class="form-field full">
            <label>robots.txt 地址</label>
            <input class="input-control" name="robotsUrl" type="url" value="${esc(source.robotsUrl)}">
          </div>
          <div class="form-field full">
            <label>使用条款地址</label>
            <input class="input-control" name="termsUrl" type="url" value="${esc(source.termsUrl)}">
          </div>
          <div class="form-field full">
            <label>采集备注</label>
            <textarea class="textarea-control" name="notes" maxlength="1000">${esc(source.notes)}</textarea>
          </div>
          <div class="form-field full">
            <label class="filter-option" style="margin:0">
              <input type="checkbox" name="enabled" ${source.enabled ? "checked" : ""}>
              启用这个来源（暂停后不会进入采集计划）
            </label>
          </div>
        </div>
        <div data-source-error></div>
      </div>
      <div class="modal-footer">
        <button class="button button-outline button-small" type="button" data-close>取消</button>
        <button class="button button-dark button-small" type="submit">保存来源配置</button>
      </div>
    </form>
  `;
  document.body.append(modal);
  const close = () => modal.remove();
  modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/api/admin/sources/${source.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: formData.get("name"),
          brand: formData.get("brand"),
          url: formData.get("url"),
          cadence: formData.get("cadence"),
          priority: formData.get("priority"),
          fieldScope: String(formData.get("fieldScope")).split("\n").map((item) => item.trim()).filter(Boolean),
          robotsUrl: formData.get("robotsUrl"),
          termsUrl: formData.get("termsUrl"),
          notes: formData.get("notes"),
          enabled: formData.get("enabled") === "on",
        }),
      });
      toast("采集来源配置已保存");
      close();
      await renderSources(app);
    } catch (error) {
      modal.querySelector("[data-source-error]").innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
    } finally {
      submit.disabled = false;
    }
  });
}

async function renderReviews(app, status = "pending") {
  const [reviewData, stats] = await Promise.all([
    api(`/api/admin/reviews?status=${encodeURIComponent(status)}`),
    api("/api/admin/stats"),
  ]);
  const confidenceCounts = {
    high: reviewData.items.filter((review) => review.confidence === "high").length,
    medium: reviewData.items.filter((review) => review.confidence === "medium").length,
    low: reviewData.items.filter((review) => review.confidence === "low").length,
  };
  const visibleReviews = reviewConfidenceFilter === "all"
    ? reviewData.items
    : reviewData.items.filter((review) => review.confidence === reviewConfidenceFilter);
  app.innerHTML = layout(`
    <div class="admin-page-heading">
      <div>
        <span class="eyebrow">INGESTION REVIEW</span>
        <h1>采集审核</h1>
        <p>低置信候选已优先排列。请先核对原始页面、缺失字段和同型号重复提示，再发布。</p>
      </div>
      <div class="mode-tabs">
        <button class="mode-tab ${status === "pending" ? "active" : ""}" type="button" data-review-status="pending">待审核</button>
        <button class="mode-tab ${status === "approved" ? "active" : ""}" type="button" data-review-status="approved">已通过</button>
        <button class="mode-tab ${status === "rejected" ? "active" : ""}" type="button" data-review-status="rejected">已驳回</button>
      </div>
    </div>
    <div class="review-overview">
      <div class="review-overview-copy">
        <strong>${reviewData.items.length} 条${status === "pending" ? "待审" : "记录"}</strong>
        <span>${status === "pending" ? `高 ${confidenceCounts.high} · 中 ${confidenceCounts.medium} · 低 ${confidenceCounts.low}` : "按置信度优先排列"}</span>
      </div>
      <div class="review-filter-tabs" aria-label="按置信度筛选">
        ${[
          ["all", "全部", reviewData.items.length],
          ["low", "低置信", confidenceCounts.low],
          ["medium", "中置信", confidenceCounts.medium],
          ["high", "高置信", confidenceCounts.high],
        ].map(([value, label, count]) => `
          <button class="review-filter ${reviewConfidenceFilter === value ? "active" : ""}" type="button" data-review-confidence="${value}">
            ${label}<span>${count}</span>
          </button>
        `).join("")}
      </div>
    </div>
    <div class="admin-panel" style="margin-bottom:14px">
      <div class="source-status-list" style="grid-template-columns:repeat(3,1fr)">
        ${stats.sources.map((source) => `
          <div class="source-status-item">
            <span class="source-dot"></span>
            <div><strong>${esc(source.name)}</strong></div>
            <span>${esc(source.cadence)}</span>
          </div>
        `).join("")}
      </div>
    </div>
    ${
      visibleReviews.length
        ? `<div class="review-list">${visibleReviews.map((review) => reviewCard(review, status)).join("")}</div>`
        : `<div class="empty-state">
            <div class="empty-state-icon">${icons.review}</div>
            <h3>${reviewConfidenceFilter !== "all" ? "当前筛选下没有记录" : status === "pending" ? "当前没有待审数据" : "这个状态下暂无记录"}</h3>
            <p>${reviewConfidenceFilter !== "all" ? "切换到“全部”可查看其他置信度的记录。" : status === "pending" ? "采集任务发现新变化时，会先进入这里等待人工确认。" : "后续处理记录会保留在这里供追溯。"}</p>
          </div>`
    }
  `, "reviews", stats.counts.pendingReviews);
  bindLogout();
  document.querySelectorAll("[data-review-status]").forEach((button) => {
    button.addEventListener("click", () => renderReviews(app, button.dataset.reviewStatus));
  });
  document.querySelectorAll("[data-review-confidence]").forEach((button) => {
    button.addEventListener("click", () => {
      reviewConfidenceFilter = button.dataset.reviewConfidence;
      renderReviews(app, status);
    });
  });
  document.querySelectorAll("[data-approve-review]").forEach((button) => {
    button.addEventListener("click", async () => {
      const card = button.closest("[data-review-card]");
      const changes = {};
      card.querySelectorAll("[data-review-field]").forEach((input) => {
        changes[input.dataset.reviewField] = input.value;
      });
      let proposed = { changes };
      if (card.dataset.reviewType === "gear_candidate") {
        if (
          card.dataset.confidence === "low"
          && !window.confirm("这是低置信候选，可能缺少规格或与现有型号重复。确认已在原始页面逐项核对？")
        ) {
          return;
        }
        const valueOf = (name) => card.querySelector(`[data-candidate="${name}"]`)?.value || "";
        proposed = {
          gear: {
            brand: valueOf("brand"),
            model: valueOf("model"),
            category: valueOf("category"),
            summary: valueOf("summary"),
            priceCny: Number(valueOf("priceCny")) || null,
            mount: valueOf("mount"),
            sensorFormat: valueOf("sensorFormat"),
            bestFor: ["新品采集", "参数待核验"],
            accent: card.dataset.accent || "graphite",
            sourceName: card.dataset.sourceName || "",
            sourceUrl: card.dataset.sourceUrl || "",
            confidence: "unverified",
          },
          specs: [...card.querySelectorAll("[data-candidate-spec]")].map((input) => ({
            key: input.dataset.candidateSpec,
            label: input.dataset.specLabel,
            unit: input.dataset.specUnit || "",
            value: input.value,
          })),
        };
      }
      button.disabled = true;
      try {
        await api(`/api/admin/reviews/${button.dataset.approveReview}/approve`, {
          method: "POST",
          body: JSON.stringify({ proposed }),
        });
        toast("审核通过，订正后的数据已发布");
        await renderReviews(app, "pending");
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
      }
    });
  });
  document.querySelectorAll("[data-reject-review]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("确认驳回这条采集结果？原始记录会保留在审计日志中。")) return;
      button.disabled = true;
      try {
        await api(`/api/admin/reviews/${button.dataset.rejectReview}/reject`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        toast("已驳回采集结果");
        await renderReviews(app, "pending");
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
      }
    });
  });
}

const candidateSpecTemplates = {
  camera: [
    ["sensor", "传感器"],
    ["resolution", "有效像素"],
    ["autofocus", "对焦系统"],
    ["stabilization", "防抖"],
    ["video", "视频"],
    ["burst", "连拍"],
    ["weight", "重量"],
    ["weather", "防护"],
  ],
  lens: [
    ["focal_length", "焦距"],
    ["aperture", "最大光圈"],
    ["filter_size", "滤镜口径"],
    ["minimum_focus", "最近对焦"],
    ["stabilization", "防抖"],
    ["weight", "重量"],
  ],
};

function candidateSpecRows(gear, specs, status) {
  const rows = specs.map((spec) => ({ ...spec }));
  const existingKeys = new Set(rows.map((spec) => spec.key));
  for (const [key, label] of candidateSpecTemplates[gear.category] || []) {
    if (existingKeys.has(key)) continue;
    rows.push({ key, label, value: "", unit: "" });
  }
  return rows.map((spec) => `
    <div class="spec-edit-row ${spec.value ? "" : "spec-edit-row-empty"}">
      <span title="${esc(spec.label)}">${esc(spec.label)}</span>
      <input data-candidate-spec="${esc(spec.key)}" data-spec-label="${esc(spec.label)}" data-spec-unit="${esc(spec.unit || "")}" value="${esc(spec.value || "")}" placeholder="${spec.value ? "" : "未提取，可补充"}" ${status !== "pending" ? "disabled" : ""}>
      <span>${esc(spec.unit || "")}</span>
    </div>
  `).join("");
}

function reviewCard(review, status) {
  if (review.recordType === "gear_candidate") {
    const gear = review.proposed.gear || {};
    const specs = Array.isArray(review.proposed.specs) ? review.proposed.specs : [];
    const quality = review.quality || {};
    const warnings = Array.isArray(quality.warnings) ? quality.warnings : [];
    const specSourceUrl = review.proposed.product?.specSourceUrl || "";
    return `
      <article class="review-card" data-review-card data-review-type="gear_candidate"
               data-accent="${esc(gear.accent || "graphite")}"
               data-confidence="${esc(review.confidence || "")}"
               data-source-name="${esc(gear.sourceName || review.sourceName || "")}"
               data-source-url="${esc(gear.sourceUrl || review.sourceUrl || "")}">
        <div class="review-card-head">
          <div>
            <h3>${esc(review.title)}</h3>
            <div class="review-meta">
              <span>${esc(review.sourceName || "采集来源")}</span>
              <span>${formatDateTime(review.fetchedAt)}</span>
              <a href="${esc(review.sourceUrl)}" target="_blank" rel="noopener noreferrer">产品原始页面 ↗</a>
              ${specSourceUrl ? `<a href="${esc(specSourceUrl)}" target="_blank" rel="noopener noreferrer">规格页 ↗</a>` : ""}
            </div>
          </div>
          <span class="confidence-chip ${esc(review.confidence)}">${esc(confirmLabel(review.confidence))}</span>
        </div>
        <div class="candidate-quality ${esc(review.confidence || "low")}">
          <div class="candidate-quality-head">
            <strong>字段完整度</strong>
            <span>${Number(quality.knownSpecCount) || 0} 项关键规格 · 共 ${Number(quality.specCount) || specs.length} 项</span>
          </div>
          ${warnings.length
            ? `<ul>${warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>`
            : `<p>已提取基础字段和关键规格，仍请与原始页面核对。</p>`}
        </div>
        <div class="candidate-review form-grid">
          <div class="form-field">
            <label>品牌</label>
            <input class="input-control" data-candidate="brand" value="${esc(gear.brand || "")}" ${status !== "pending" ? "disabled" : ""}>
          </div>
          <div class="form-field">
            <label>型号</label>
            <input class="input-control" data-candidate="model" value="${esc(gear.model || "")}" ${status !== "pending" ? "disabled" : ""}>
          </div>
          <div class="form-field">
            <label>类型</label>
            <select class="select-control" data-candidate="category" ${status !== "pending" ? "disabled" : ""}>
              <option value="camera" ${gear.category === "camera" ? "selected" : ""}>相机</option>
              <option value="lens" ${gear.category === "lens" ? "selected" : ""}>镜头</option>
            </select>
          </div>
          <div class="form-field">
            <label>参考价格（人民币）</label>
            <input class="input-control" data-candidate="priceCny" type="number" value="${esc(gear.priceCny || "")}" ${status !== "pending" ? "disabled" : ""}>
          </div>
          <div class="form-field">
            <label>卡口</label>
            <input class="input-control" data-candidate="mount" value="${esc(gear.mount || "")}" ${status !== "pending" ? "disabled" : ""}>
          </div>
          <div class="form-field">
            <label>画幅 / 格式</label>
            <input class="input-control" data-candidate="sensorFormat" value="${esc(gear.sensorFormat || "")}" ${status !== "pending" ? "disabled" : ""}>
          </div>
          <div class="form-field full">
            <label>简介</label>
            <textarea class="textarea-control" data-candidate="summary" ${status !== "pending" ? "disabled" : ""}>${esc(gear.summary || "")}</textarea>
          </div>
        </div>
        <div class="spec-edit-list candidate-specs">
          ${candidateSpecRows(gear, specs, status)}
        </div>
        ${status === "pending" ? `
          <div class="review-actions">
            <button class="button button-ghost button-small" type="button" data-reject-review="${review.id}">忽略</button>
            <button class="button button-dark button-small" type="button" data-approve-review="${review.id}">
              ${review.confidence === "low" ? "已核对原始页面，通过" : "审校通过，加入器材库"}
            </button>
          </div>
        ` : '<div class="review-meta" style="margin-top:16px">已处理并写入器材库</div>'}
      </article>
    `;
  }
  if (review.recordType === "source_snapshot") {
    const snapshot = review.proposed.snapshot || {};
    const products = Array.isArray(snapshot.products) ? snapshot.products : [];
    return `
      <article class="review-card" data-review-card>
        <div class="review-card-head">
          <div>
            <h3>${esc(review.title)}</h3>
            <div class="review-meta">
              <span>${esc(review.sourceName || "采集来源")}</span>
              <span>${formatDateTime(review.fetchedAt)}</span>
              <a href="${esc(review.sourceUrl)}" target="_blank" rel="noopener noreferrer">原始页面 ↗</a>
            </div>
          </div>
          <span class="confidence-chip medium">页面变化</span>
        </div>
        <div class="snapshot-review">
          <div>
            <span>采集页面标题</span>
            <strong>${esc(snapshot.pageTitle || "未提取到标题")}</strong>
          </div>
          <div>
            <span>页面说明</span>
            <p>${esc(snapshot.description || "未提取到页面说明")}</p>
          </div>
          <div>
            <span>内容指纹</span>
            <code>${esc(String(snapshot.contentHash || "").slice(0, 20))}</code>
          </div>
          ${products.length ? `
            <div>
              <span>产品候选（${products.length}）</span>
              <div class="snapshot-products">
                ${products.slice(0, 8).map((product) => `<span class="tag">${esc(product.name)}</span>`).join("")}
              </div>
            </div>
          ` : ""}
        </div>
        ${status === "pending" ? `
          <div class="review-actions">
            <button class="button button-ghost button-small" type="button" data-reject-review="${review.id}">忽略</button>
            <button class="button button-dark button-small" type="button" data-approve-review="${review.id}">已核对，归档</button>
          </div>
        ` : '<div class="review-meta" style="margin-top:16px">已处理</div>'}
      </article>
    `;
  }
  const changes = review.proposed.changes || {};
  return `
    <article class="review-card" data-review-card>
      <div class="review-card-head">
        <div>
          <h3>${esc(review.title)}</h3>
          <div class="review-meta">
            <span>${esc(review.gearLabel || "未关联器材")}</span>
            <span>${esc(review.sourceName || "采集来源")}</span>
            <span>${formatDateTime(review.fetchedAt)}</span>
            <a href="${esc(review.sourceUrl)}" target="_blank" rel="noopener noreferrer">原始页面 ↗</a>
          </div>
        </div>
        <span class="confidence-chip ${esc(review.confidence)}">${esc(confirmLabel(review.confidence))}</span>
      </div>
      <div class="diff-grid">
        ${Object.entries(changes).map(([key, value]) => {
          const oldValue = review.current.changes?.[key] ?? "—";
          return `
            <div class="diff-field">
              <label>${esc(key)}</label>
              ${status === "pending" ? `
                <div class="diff-pair">
                  <span class="diff-old" title="${esc(oldValue)}">${esc(oldValue)}</span>
                  <span class="diff-arrow">→</span>
                  <input class="diff-input" data-review-field="${esc(key)}" value="${esc(value)}">
                </div>
              ` : `
                <div class="diff-pair">
                  <span class="diff-old">${esc(oldValue)}</span>
                  <span class="diff-arrow">→</span>
                  <span>${esc(value)}</span>
                </div>
              `}
            </div>
          `;
        }).join("")}
      </div>
      ${status === "pending" ? `
        <div class="review-actions">
          <button class="button button-ghost button-small" type="button" data-reject-review="${review.id}">驳回</button>
          <button class="button button-dark button-small" type="button" data-approve-review="${review.id}">核对无误，通过并发布</button>
        </div>
      ` : `
        <div class="review-meta" style="margin-top:16px">已处理</div>
      `}
    </article>
  `;
}

async function renderScenes(app) {
  const [sceneData, stats] = await Promise.all([
    api("/api/admin/scenes"),
    api("/api/admin/stats"),
  ]);
  app.innerHTML = layout(`
    <div class="admin-page-heading">
      <div>
        <span class="eyebrow">KNOWLEDGE BASE</span>
        <h1>场景参数</h1>
        <p>维护参数区间、现场条件和风险提示。前台建议引擎直接读取这些规则。</p>
      </div>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>场景</th><th>光线</th><th>光圈</th><th>快门</th><th>ISO</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>
          ${sceneData.items.map((scene) => `
            <tr>
              <td>
                <div class="gear-cell">
                  ${scene.image?.url
                    ? `<img class="admin-scene-thumb" src="${esc(scene.image.url)}" alt="${esc(scene.image.alt)}">`
                    : '<span class="admin-scene-thumb empty"></span>'}
                  <div><strong>${esc(scene.title)}</strong><span>${esc(scene.category)}</span></div>
                </div>
              </td>
              <td>${esc(scene.light)}</td>
              <td>${esc(scene.aperture)}</td>
              <td>${esc(scene.shutter)}</td>
              <td>${esc(scene.iso)}</td>
              <td>${formatDate(scene.updatedAt)}</td>
              <td><button class="button button-outline small-button" type="button" data-edit-scene="${scene.id}">编辑</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `, "scenes", stats.counts.pendingReviews);
  bindLogout();
  document.querySelectorAll("[data-edit-scene]").forEach((button) => {
    const scene = sceneData.items.find((item) => item.id === Number(button.dataset.editScene));
    button.addEventListener("click", () => openSceneEditor(scene, app));
  });
}

function openSceneEditor(scene, app) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <form class="modal" data-scene-form>
      <div class="modal-header">
        <h2>编辑 ${esc(scene.title)}</h2>
        <button class="modal-close" type="button" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="form-field full">
            <label>场景标题</label>
            <input class="input-control" name="title" value="${esc(scene.title)}" maxlength="80" required>
          </div>
          <div class="form-field full">
            <label>场景说明</label>
            <textarea class="textarea-control" name="description" maxlength="500">${esc(scene.description)}</textarea>
          </div>
          <div class="form-field full">
            <label>场景展示图片</label>
            <div class="admin-scene-image-preview ${scene.image?.url ? "has-image" : ""}">
              ${scene.image?.url ? `<img src="${esc(scene.image.url)}" alt="${esc(scene.image.alt)}">` : "<span>尚未设置图片</span>"}
            </div>
          </div>
          <div class="form-field full">
            <label>图片地址</label>
            <input class="input-control" name="imageUrl" value="${esc(scene.image?.url || "")}" placeholder="/images/scenes/example.jpg">
          </div>
          <div class="form-field">
            <label>图片替代文本</label>
            <input class="input-control" name="imageAlt" value="${esc(scene.image?.alt || "")}" maxlength="200">
          </div>
          <div class="form-field">
            <label>图片来源</label>
            <input class="input-control" name="imageCredit" value="${esc(scene.image?.credit || "")}" maxlength="100">
          </div>
          <div class="form-field"><label>光线条件</label><input class="input-control" name="light" value="${esc(scene.light)}"></div>
          <div class="form-field"><label>运动条件</label><input class="input-control" name="motion" value="${esc(scene.motion)}"></div>
          <div class="form-field"><label>推荐光圈</label><input class="input-control" name="aperture" value="${esc(scene.aperture)}"></div>
          <div class="form-field"><label>推荐快门</label><input class="input-control" name="shutter" value="${esc(scene.shutter)}"></div>
          <div class="form-field"><label>推荐 ISO</label><input class="input-control" name="iso" value="${esc(scene.iso)}"></div>
          <div class="form-field"><label>参考焦段</label><input class="input-control" name="focal" value="${esc(scene.focal)}"></div>
          <div class="form-field full">
            <label>建议清单（每行一条）</label>
            <textarea class="textarea-control" name="tips" style="min-height:130px">${esc(scene.tips.join("\n"))}</textarea>
          </div>
          <div class="form-field full">
            <label>风险提示</label>
            <textarea class="textarea-control" name="caveat">${esc(scene.caveat)}</textarea>
          </div>
        </div>
        <div data-scene-error></div>
      </div>
      <div class="modal-footer">
        <button class="button button-outline button-small" type="button" data-close>取消</button>
        <button class="button button-dark button-small" type="submit">保存场景参数</button>
      </div>
    </form>
  `;
  document.body.append(modal);
  const close = () => modal.remove();
  modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const body = Object.fromEntries(formData);
    body.tips = String(body.tips).split("\n").map((tip) => tip.trim()).filter(Boolean);
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/api/admin/scenes/${scene.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      toast("场景参数已更新");
      close();
      await renderScenes(app);
    } catch (error) {
      modal.querySelector("[data-scene-error]").innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
    } finally {
      submit.disabled = false;
    }
  });
}

async function renderAudit(app) {
  const [auditData, stats] = await Promise.all([
    api("/api/admin/audit"),
    api("/api/admin/stats"),
  ]);
  app.innerHTML = layout(`
    <div class="admin-page-heading">
      <div>
        <span class="eyebrow">AUDIT TRAIL / IMMUTABLE</span>
        <h1>审计日志</h1>
        <p>记录管理员登录、密码变更、字段订正与采集审核。日志仅可追加，不提供前端删除入口。</p>
      </div>
      <span class="confidence-badge">最近 100 条</span>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>IP 地址</th></tr></thead>
        <tbody>
          ${auditData.items.map((item) => `
            <tr>
              <td>${formatDateTime(item.createdAt)}</td>
              <td>${esc(item.actor)}</td>
              <td><span class="audit-action">${esc(item.action)}</span></td>
              <td>${esc(item.entityType)} #${esc(item.entityId)}</td>
              <td>${esc(item.ipAddress || "—")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <p class="stat-note" style="margin-top:14px">
      安全说明：生产环境建议将审计日志同步到独立的只写日志服务，并设置保留周期与访问告警。
    </p>
  `, "audit", stats.counts.pendingReviews);
  bindLogout();
}

export async function renderAdminApp(app, renderRoute) {
  const path = window.location.pathname;
  try {
    let session = null;
    try {
      session = await api("/api/auth/session");
      setCsrf(session.csrfToken);
      sessionUser = session.user;
    } catch (error) {
      if (error.status !== 401) throw error;
    }

    if (!session) {
      if (path !== "/admin/login") history.replaceState({}, "", "/admin/login");
      renderLogin(app);
      return;
    }
    if (session.user.mustChangePassword) {
      if (path !== "/admin/password") history.replaceState({}, "", "/admin/password");
      renderPasswordChange(app);
      return;
    }
    if (path === "/admin/login" || path === "/admin/password") {
      history.replaceState({}, "", "/admin");
    }

    const adminPath = window.location.pathname;
    if (adminPath === "/admin" || adminPath === "/admin/") {
      await renderDashboard(app);
    } else if (adminPath === "/admin/gear") {
      await renderGearManager(app);
    } else if (adminPath === "/admin/sources") {
      await renderSources(app);
    } else if (adminPath === "/admin/reviews") {
      await renderReviews(app);
    } else if (adminPath === "/admin/scenes") {
      await renderScenes(app);
    } else if (adminPath === "/admin/audit") {
      await renderAudit(app);
    } else {
      history.replaceState({}, "", "/admin");
      await renderDashboard(app);
    }
  } catch (error) {
    if (error.status === 401 || error.code === "PASSWORD_CHANGE_REQUIRED") {
      sessionUser = null;
      history.replaceState({}, "", "/admin/login");
      renderLogin(app);
      return;
    }
    console.error(error);
    toast(error.message || "后台加载失败", "error");
    app.innerHTML = layout(`
      <div class="empty-state">
        <h3>后台暂时无法加载</h3>
        <p>${esc(error.message || "请稍后重试")}</p>
        <button class="button button-dark button-small" type="button" data-retry>重新加载</button>
      </div>
    `, "dashboard");
    bindLogout();
    document.querySelector("[data-retry]")?.addEventListener("click", renderRoute);
  }
}
