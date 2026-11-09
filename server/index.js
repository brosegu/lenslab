import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import {
  db,
  passwordDigest,
  recordAudit,
} from "./db.js";
import {
  createCrawlRun,
  getCrawlRun,
  listCrawlRuns,
} from "./crawler.js";
import {
  assessCandidate,
  candidateComparisonKey,
  modelComparisonKey,
  brandComparisonKey,
} from "./candidate-quality.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const sessionTtlHours = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 12));
const sessionTtlMs = sessionTtlHours * 60 * 60 * 1000;
const sessionCookie = "ll_session";
const csrfCookie = "ll_csrf";
const loginBuckets = new Map();

if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

app.disable("x-powered-by");
app.use(helmet({
  strictTransportSecurity: isProduction
    ? { maxAge: 31536000, includeSubDomains: true }
    : false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));
app.use(express.json({ limit: "64kb", strict: true }));
app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: true,
  maxAge: isProduction ? "1h" : 0,
}));

const now = () => new Date().toISOString();
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");
const clientIp = (req) => req.ip || req.socket.remoteAddress || "unknown";
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function setCookie(req, res, name, value, options = {}) {
  const secure = isProduction || req.secure;
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict",
    options.httpOnly === false ? "" : "HttpOnly",
    secure ? "Secure" : "",
    options.maxAge ? `Max-Age=${Math.floor(options.maxAge / 1000)}` : "",
  ].filter(Boolean);
  res.append("Set-Cookie", parts.join("; "));
}

function clearCookie(req, res, name) {
  setCookie(req, res, name, "", { maxAge: 1 });
}

function ensureCsrfCookie(req, res) {
  const cookies = parseCookies(req);
  let token = cookies[csrfCookie];
  if (!token || token.length < 32) {
    token = randomToken();
    setCookie(req, res, csrfCookie, token, { maxAge: sessionTtlMs });
  }
  return token;
}

function validateOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    const originUrl = new URL(origin);
    const expectedHost = req.get("host");
    if (originUrl.host !== expectedHost) {
      return res.status(403).json({ error: "请求来源校验失败" });
    }
  } catch {
    return res.status(403).json({ error: "请求来源无效" });
  }
  next();
}

function requireCsrf(req, res, next) {
  const cookies = parseCookies(req);
  const header = req.get("x-csrf-token");
  if (!header || !cookies[csrfCookie] || !safeEqual(header, cookies[csrfCookie])) {
    return res.status(403).json({ error: "安全令牌无效，请刷新页面后重试" });
  }
  next();
}

function getAdminSession(req) {
  const token = parseCookies(req)[sessionCookie];
  if (!token) return null;
  const session = db.prepare(`
    SELECT
      s.token_hash, s.csrf_token, s.expires_at, s.session_version,
      u.id, u.username, u.must_change_password, u.session_version AS user_version
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(hashToken(token));
  if (!session) return null;
  if (Date.parse(session.expires_at) <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.token_hash);
    return null;
  }
  if (session.session_version !== session.user_version) return null;
  return session;
}

function requireAdmin(req, res, next) {
  const session = getAdminSession(req);
  if (!session) return res.status(401).json({ error: "登录已失效，请重新登录" });
  req.admin = session;
  next();
}

function requirePasswordChanged(req, res, next) {
  if (req.admin.must_change_password) {
    return res.status(403).json({
      error: "首次登录必须先修改密码",
      code: "PASSWORD_CHANGE_REQUIRED",
    });
  }
  next();
}

function issueSession(req, res, user, csrfToken = null) {
  const token = randomToken();
  const csrf = csrfToken || randomToken();
  const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, csrf_token, session_version, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hashToken(token), user.id, csrf, user.session_version, expiresAt, now());
  setCookie(req, res, sessionCookie, token, { maxAge: sessionTtlMs });
  setCookie(req, res, csrfCookie, csrf, { maxAge: sessionTtlMs });
  return csrf;
}

function clearSession(req, res) {
  const token = parseCookies(req)[sessionCookie];
  if (token) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }
  clearCookie(req, res, sessionCookie);
  clearCookie(req, res, csrfCookie);
}

function tooManyLoginAttempts(ip) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  const bucket = (loginBuckets.get(ip) || []).filter((time) => time > cutoff);
  loginBuckets.set(ip, bucket);
  return bucket.length >= 8;
}

function noteLoginAttempt(ip) {
  const bucket = (loginBuckets.get(ip) || []).filter(
    (time) => time > Date.now() - 15 * 60 * 1000,
  );
  bucket.push(Date.now());
  loginBuckets.set(ip, bucket);
}

function verifyPassword(password, user) {
  const candidate = passwordDigest(password, user.password_salt).hash;
  return safeEqual(candidate, user.password_hash);
}

function gearSpecs(gearId) {
  return db.prepare(`
    SELECT spec_key, label, value, unit, source_url, confidence, updated_at
    FROM specs
    WHERE gear_id = ?
    ORDER BY sort_order, id
  `).all(gearId);
}

function serializeGear(row, includeSpecs = true) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    category: row.category,
    brand: row.brand,
    model: row.model,
    releaseYear: row.release_year,
    priceCny: row.price_cny,
    mount: row.mount,
    sensorFormat: row.sensor_format,
    summary: row.summary,
    bestFor: JSON.parse(row.best_for || "[]"),
    accent: row.accent,
    status: row.status,
    confidence: row.confidence,
    source: { name: row.source_name, url: row.source_url },
    verifiedAt: row.verified_at,
    updatedAt: row.updated_at,
    ...(includeSpecs ? { specs: gearSpecs(row.id) } : {}),
  };
}

function serializeScene(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    eyebrow: row.eyebrow,
    description: row.description,
    light: row.light,
    motion: row.motion,
    aperture: row.aperture,
    shutter: row.shutter,
    iso: row.iso,
    focal: row.focal,
    tips: JSON.parse(row.tips_json || "[]"),
    caveat: row.caveat,
    accent: row.accent,
    image: {
      url: row.image_url || "",
      alt: row.image_alt || "",
      credit: row.image_credit || "",
    },
    updatedAt: row.updated_at,
  };
}

function serializeSource(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    brand: row.brand || "",
    url: row.url,
    sourceType: row.source_type,
    cadence: row.cadence,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    region: row.region || "Global",
    official: Boolean(row.official),
    enabled: Boolean(row.enabled),
    priority: row.priority || "medium",
    fieldScope: JSON.parse(row.field_scope || "[]"),
    parserKey: row.parser_key || "",
    robotsUrl: row.robots_url || "",
    termsUrl: row.terms_url || "",
    notes: row.notes || "",
    pendingReviews: row.pending_reviews || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeString(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parsePositiveInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "lenslab", time: now() });
});

app.get("/api/auth/csrf", (req, res) => {
  const csrfToken = ensureCsrfCookie(req, res);
  res.json({ csrfToken });
});

app.get("/api/auth/session", (req, res) => {
  const session = getAdminSession(req);
  if (!session) return res.status(401).json({ error: "未登录" });
  res.json({
    user: {
      username: session.username,
      mustChangePassword: Boolean(session.must_change_password),
    },
    csrfToken: session.csrf_token,
  });
});

app.post("/api/auth/login", validateOrigin, requireCsrf, (req, res) => {
  const ip = clientIp(req);
  if (tooManyLoginAttempts(ip)) {
    return res.status(429).json({ error: "尝试次数过多，请 15 分钟后重试" });
  }
  noteLoginAttempt(ip);

  const username = sanitizeString(req.body?.username, 64);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password) {
    return res.status(400).json({ error: "请输入用户名和密码" });
  }
  if (password.length > 256) {
    return res.status(400).json({ error: "用户名或密码错误" });
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user) {
    return res.status(401).json({ error: "用户名或密码错误" });
  }
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    return res.status(429).json({ error: "账号暂时锁定，请稍后再试" });
  }
  if (!verifyPassword(password, user)) {
    const failedAttempts = user.failed_attempts + 1;
    if (failedAttempts >= 5) {
      db.prepare(`
        UPDATE users
        SET failed_attempts = 0, locked_until = ?, updated_at = ?
        WHERE id = ?
      `).run(new Date(Date.now() + 15 * 60 * 1000).toISOString(), now(), user.id);
      return res.status(429).json({ error: "登录失败次数过多，账号已锁定 15 分钟" });
    }
    db.prepare("UPDATE users SET failed_attempts = ?, updated_at = ? WHERE id = ?")
      .run(failedAttempts, now(), user.id);
    return res.status(401).json({ error: "用户名或密码错误" });
  }

  db.prepare(`
    UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?
  `).run(now(), user.id);
  loginBuckets.delete(ip);
  const csrf = issueSession(req, res, user, parseCookies(req)[csrfCookie]);
  recordAudit({
    actor: user.username,
    action: "admin.login",
    entityType: "session",
    entityId: user.id,
    after: { username: user.username },
    ipAddress: ip,
  });
  res.json({
    user: {
      username: user.username,
      mustChangePassword: Boolean(user.must_change_password),
    },
    csrfToken: csrf,
  });
});

app.post("/api/auth/logout", validateOrigin, requireCsrf, (req, res) => {
  const session = getAdminSession(req);
  if (session) {
    recordAudit({
      actor: session.username,
      action: "admin.logout",
      entityType: "session",
      entityId: session.id,
      ipAddress: clientIp(req),
    });
  }
  clearSession(req, res);
  res.status(204).end();
});

app.post(
  "/api/admin/password",
  validateOrigin,
  requireCsrf,
  requireAdmin,
  (req, res) => {
    const currentPassword = typeof req.body?.currentPassword === "string"
      ? req.body.currentPassword
      : "";
    const newPassword = typeof req.body?.newPassword === "string"
      ? req.body.newPassword
      : "";
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "请填写当前密码和新密码" });
    }
    if (newPassword.length < 10) {
      return res.status(400).json({ error: "新密码至少需要 10 个字符" });
    }
    if (newPassword.length > 128 || currentPassword.length > 256) {
      return res.status(400).json({ error: "密码长度超出允许范围" });
    }
    if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return res.status(400).json({ error: "新密码需要同时包含字母和数字" });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: "新密码不能与当前密码相同" });
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.admin.id);
    if (!user || !verifyPassword(currentPassword, user)) {
      return res.status(401).json({ error: "当前密码不正确" });
    }
    const { salt, hash } = passwordDigest(newPassword, crypto.randomBytes(16).toString("hex"));
    db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET password_hash = ?, password_salt = ?, must_change_password = 0,
            session_version = session_version + 1, updated_at = ?
        WHERE id = ?
      `).run(hash, salt, now(), user.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    })();

    const updatedUser = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    const csrf = issueSession(req, res, updatedUser);
    recordAudit({
      actor: user.username,
      action: "admin.password_changed",
      entityType: "user",
      entityId: user.id,
      before: { mustChangePassword: Boolean(user.must_change_password) },
      after: { mustChangePassword: false },
      ipAddress: clientIp(req),
    });
    res.json({
      user: { username: updatedUser.username, mustChangePassword: false },
      csrfToken: csrf,
    });
  },
);

app.get("/api/gear", (req, res) => {
  const q = sanitizeString(req.query.q, 80);
  const category = ["camera", "lens"].includes(req.query.category)
    ? req.query.category
    : null;
  const sensor = sanitizeString(req.query.sensor, 30);
  const priceMax = parsePositiveInt(req.query.priceMax);
  const sort = ["recommended", "priceAsc", "priceDesc", "newest"].includes(req.query.sort)
    ? req.query.sort
    : "recommended";

  const where = ["status = 'published'"];
  const params = [];
  if (q) {
    where.push("(brand LIKE ? OR model LIKE ? OR summary LIKE ? OR best_for LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (category) {
    where.push("category = ?");
    params.push(category);
  }
  if (sensor) {
    where.push("sensor_format = ?");
    params.push(sensor);
  }
  if (priceMax) {
    where.push("price_cny <= ?");
    params.push(priceMax);
  }
  const orderBy = {
    recommended: "release_year DESC, price_cny ASC",
    priceAsc: "price_cny ASC",
    priceDesc: "price_cny DESC",
    newest: "release_year DESC",
  }[sort];
  const rows = db.prepare(`
    SELECT * FROM gear WHERE ${where.join(" AND ")} ORDER BY ${orderBy}
  `).all(...params);
  const facets = db.prepare(`
    SELECT sensor_format AS sensor, COUNT(*) AS count
    FROM gear WHERE status = 'published' AND sensor_format IS NOT NULL
    GROUP BY sensor_format ORDER BY count DESC
  `).all();
  res.json({
    items: rows.map((row) => serializeGear(row)),
    facets,
    total: rows.length,
  });
});

app.get("/api/gear/:slug", (req, res) => {
  const row = db.prepare("SELECT * FROM gear WHERE slug = ? AND status = 'published'")
    .get(req.params.slug);
  if (!row) return res.status(404).json({ error: "未找到该器材" });
  res.json({ item: serializeGear(row) });
});

app.get("/api/compare", (req, res) => {
  const rawIds = String(req.query.ids || "")
    .split(",")
    .map((id) => Number.parseInt(id, 10))
    .filter((id) => Number.isFinite(id) && id > 0)
    .slice(0, 3);
  const uniqueIds = [...new Set(rawIds)];
  if (!uniqueIds.length) return res.json({ items: [] });
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT * FROM gear WHERE id IN (${placeholders}) AND status = 'published'
  `).all(...uniqueIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  res.json({
    items: uniqueIds.map((id) => serializeGear(byId.get(id))).filter(Boolean),
  });
});

app.get("/api/scenes", (req, res) => {
  const rows = db.prepare("SELECT * FROM scenes ORDER BY id").all();
  res.json({ items: rows.map(serializeScene) });
});

app.get("/api/scenes/:slug", (req, res) => {
  const row = db.prepare("SELECT * FROM scenes WHERE slug = ?").get(req.params.slug);
  if (!row) return res.status(404).json({ error: "未找到该场景" });
  res.json({ item: serializeScene(row) });
});

app.post("/api/advisor", validateOrigin, (req, res) => {
  const gearId = parsePositiveInt(req.body?.gearId);
  const sceneId = parsePositiveInt(req.body?.sceneId);
  const light = ["low", "soft", "bright"].includes(req.body?.light)
    ? req.body.light
    : "soft";
  const motion = ["still", "medium", "fast"].includes(req.body?.motion)
    ? req.body.motion
    : "medium";
  const experience = ["new", "learning", "confident"].includes(req.body?.experience)
    ? req.body.experience
    : "learning";
  const gearRow = db.prepare("SELECT * FROM gear WHERE id = ? AND status = 'published'")
    .get(gearId);
  const sceneRow = db.prepare("SELECT * FROM scenes WHERE id = ?").get(sceneId);
  if (!gearRow || !sceneRow) {
    return res.status(400).json({ error: "请选择有效的器材和拍摄场景" });
  }

  const gear = serializeGear(gearRow);
  const scene = serializeScene(sceneRow);
  let shutter = scene.shutter;
  let iso = scene.iso;
  let aperture = scene.aperture;
  const notes = [];

  if (motion === "fast") {
    shutter = scene.slug === "starry-sky" ? scene.shutter : "1/500–1/2000s";
    notes.push("主体运动较快，已优先提高快门速度，宁可适当增加 ISO。");
  } else if (motion === "still" && scene.slug !== "pet-action") {
    shutter = scene.slug === "starry-sky" ? scene.shutter : "1/60–1/250s";
    notes.push("主体相对静止，可以使用更稳妥的快门；优先用防抖换取更低的 ISO，但不要低于安全快门。");
  }
  if (light === "low") {
    iso = scene.slug === "starry-sky" ? scene.iso : "ISO 800–6400";
    notes.push("现场光线偏弱，建议开启自动 ISO；画质与清晰度冲突时先保清晰度。");
  } else if (light === "bright" && scene.slug !== "starry-sky") {
    iso = "ISO 100–400";
    notes.push("光线充足，可降低 ISO 并适当收小光圈控制高光。");
  }
  if (scene.slug === "indoor-portrait" && experience === "new") {
    aperture = "f/2.8–f/4";
    notes.push("新手拍多人时可从 f/2.8–f/4 开始，降低失焦概率。");
  }
  if (gearRow.sensor_format === "M4/3") {
    notes.push("M4/3 机身景深更深，弱光下建议优先利用机内防抖，并接受适度高感。");
  } else if (gearRow.sensor_format === "全画幅") {
    notes.push("全画幅景深更浅，人像眼部合焦后建议检查边缘清晰度。");
  }
  if (gearRow.category === "lens" && gearRow.mount === "固定镜头") {
    notes.push("当前为固定镜头设备，焦段建议作为构图参考。");
  }

  const confidence = light === "low" && motion === "fast" ? "中等" : "较高";
  const checklist = [
    "先确认对焦点落在主体关键部位",
    "照片放大检查是否有运动模糊或高光溢出",
    experience === "new"
      ? "先使用光圈优先并开启自动 ISO，熟悉后再尝试手动"
      : "建议同时保存 RAW，给后期保留调整空间",
  ];

  res.json({
    gear,
    scene,
    recommendation: {
      parameters: [
        { key: "aperture", label: "光圈", value: aperture, hint: "控制景深与进光量" },
        { key: "shutter", label: "快门", value: shutter, hint: "决定运动物体的清晰度" },
        { key: "iso", label: "感光度", value: iso, hint: "弱光时提高，但会增加噪点" },
        { key: "focal", label: "参考焦段", value: scene.focal, hint: "按构图需要灵活调整" },
      ],
      notes,
      checklist,
      caveat: scene.caveat,
      confidence,
      assessedAt: now(),
    },
  });
});

app.use(
  "/api/admin",
  validateOrigin,
  requireAdmin,
  (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    requireCsrf(req, res, next);
  },
);

app.get("/api/admin/stats", requirePasswordChanged, (req, res) => {
  const counts = {
    gear: db.prepare("SELECT COUNT(*) AS value FROM gear").get().value,
    cameras: db.prepare("SELECT COUNT(*) AS value FROM gear WHERE category = 'camera'").get().value,
    lenses: db.prepare("SELECT COUNT(*) AS value FROM gear WHERE category = 'lens'").get().value,
    scenes: db.prepare("SELECT COUNT(*) AS value FROM scenes").get().value,
    pendingReviews: db.prepare(
      "SELECT COUNT(*) AS value FROM review_queue WHERE status = 'pending'",
    ).get().value,
    verified: db.prepare(
      "SELECT COUNT(*) AS value FROM gear WHERE confidence = 'verified'",
    ).get().value,
  };
  const recentAudit = db.prepare(`
    SELECT id, actor, action, entity_type, entity_id, created_at
    FROM audit_logs ORDER BY created_at DESC LIMIT 6
  `).all();
  const sources = db.prepare("SELECT * FROM crawl_sources ORDER BY id").all();
  res.json({ counts, recentAudit, sources, user: { username: req.admin.username } });
});

app.get("/api/admin/gear", requirePasswordChanged, (req, res) => {
  const rows = db.prepare("SELECT * FROM gear ORDER BY category, brand, model").all();
  res.json({ items: rows.map((row) => serializeGear(row)) });
});

app.get("/api/admin/gear/:id", requirePasswordChanged, (req, res) => {
  const row = db.prepare("SELECT * FROM gear WHERE id = ?").get(parsePositiveInt(req.params.id));
  if (!row) return res.status(404).json({ error: "未找到该器材" });
  res.json({ item: serializeGear(row) });
});

app.patch("/api/admin/gear/:id", requirePasswordChanged, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const before = db.prepare("SELECT * FROM gear WHERE id = ?").get(id);
  if (!before) return res.status(404).json({ error: "未找到该器材" });
  const changes = req.body?.changes && typeof req.body.changes === "object"
    ? req.body.changes
    : {};
  const specChanges = req.body?.specs && typeof req.body.specs === "object"
    ? req.body.specs
    : {};
  const allowedGearFields = {
    brand: (value) => sanitizeString(value, 80),
    model: (value) => sanitizeString(value, 80),
    release_year: (value) => parsePositiveInt(value),
    price_cny: (value) => parsePositiveInt(value),
    mount: (value) => sanitizeString(value, 80),
    sensor_format: (value) => sanitizeString(value, 40),
    summary: (value) => sanitizeString(value, 500),
    best_for: (value) => JSON.stringify(
      Array.isArray(value)
        ? value.map((item) => sanitizeString(item, 30)).filter(Boolean).slice(0, 8)
        : [],
    ),
    status: (value) => ["published", "draft"].includes(value) ? value : null,
    confidence: (value) => ["verified", "reviewed", "unverified"].includes(value)
      ? value
      : null,
  };
  const assignments = [];
  const values = [];
  for (const [key, sanitize] of Object.entries(allowedGearFields)) {
    if (!(key in changes)) continue;
    const value = sanitize(changes[key]);
    if (value === null) continue;
    assignments.push(`${key} = ?`);
    values.push(value);
  }

  const validSpecs = Object.entries(specChanges).filter(([key, spec]) => (
    /^[a-z0-9_]{1,40}$/.test(key)
    && spec
    && typeof spec === "object"
    && sanitizeString(spec.value, 300)
  ));
  if (!assignments.length && !validSpecs.length) {
    return res.status(400).json({ error: "没有可更新的字段" });
  }

  const updatedAt = now();
  db.transaction(() => {
    if (assignments.length) {
      db.prepare(`
        UPDATE gear SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?
      `).run(...values, updatedAt, id);
    }
    for (const [key, spec] of validSpecs) {
      const existing = db.prepare("SELECT * FROM specs WHERE gear_id = ? AND spec_key = ?")
        .get(id, key);
      if (existing) {
        db.prepare(`
          UPDATE specs SET value = ?, unit = ?, updated_at = ?, confidence = 'reviewed'
          WHERE gear_id = ? AND spec_key = ?
        `).run(
          sanitizeString(spec.value, 300),
          sanitizeString(spec.unit, 20),
          updatedAt,
          id,
          key,
        );
      } else {
        db.prepare(`
          INSERT INTO specs (
            gear_id, spec_key, label, value, unit, sort_order, source_url,
            confidence, updated_at
          ) VALUES (?, ?, ?, ?, ?, 99, ?, 'reviewed', ?)
        `).run(
          id,
          key,
          sanitizeString(spec.label, 80) || key,
          sanitizeString(spec.value, 300),
          sanitizeString(spec.unit, 20),
          before.source_url,
          updatedAt,
        );
      }
    }
  })();
  const after = db.prepare("SELECT * FROM gear WHERE id = ?").get(id);
  recordAudit({
    actor: req.admin.username,
    action: "gear.updated",
    entityType: "gear",
    entityId: id,
    before: serializeGear(before),
    after: serializeGear(after),
    ipAddress: clientIp(req),
  });
  res.json({ item: serializeGear(after) });
});

app.get("/api/admin/sources", requirePasswordChanged, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*,
      (
        SELECT COUNT(*) FROM review_queue r
        WHERE r.source_id = s.id AND r.status = 'pending'
      ) AS pending_reviews
    FROM crawl_sources s
    ORDER BY
      CASE s.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      s.name
  `).all();
  res.json({
    items: rows.map(serializeSource),
    summary: {
      total: rows.length,
      enabled: rows.filter((row) => row.enabled).length,
      highPriority: rows.filter((row) => row.priority === "high").length,
      verified: rows.filter((row) => row.status === "healthy").length,
    },
  });
});

app.get("/api/admin/crawl-runs", requirePasswordChanged, (req, res) => {
  res.json({ items: listCrawlRuns(req.query.limit) });
});

app.get("/api/admin/crawl-runs/:id", requirePasswordChanged, (req, res) => {
  const run = getCrawlRun(parsePositiveInt(req.params.id));
  if (!run) return res.status(404).json({ error: "采集任务不存在" });
  res.json({ item: run });
});

app.post("/api/admin/crawl-runs", requirePasswordChanged, (req, res, next) => {
  try {
    const sourceIds = Array.isArray(req.body?.sourceIds) ? req.body.sourceIds : [];
    const run = createCrawlRun({
      sourceIds,
      requestedBy: req.admin.username,
    });
    res.status(202).json({ item: run });
  } catch (error) {
    if (error.status === 400 || error.status === 409) {
      return res.status(error.status).json({ error: error.message });
    }
    next(error);
  }
});

app.patch("/api/admin/sources/:id", requirePasswordChanged, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const before = db.prepare("SELECT * FROM crawl_sources WHERE id = ?").get(id);
  if (!before) return res.status(404).json({ error: "未找到该采集来源" });

  const changes = req.body && typeof req.body === "object" ? req.body : {};
  const assignments = [];
  const values = [];
  const add = (column, value) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };

  if ("name" in changes) {
    const name = sanitizeString(changes.name, 100);
    if (!name) return res.status(400).json({ error: "来源名称不能为空" });
    add("name", name);
  }
  if ("brand" in changes) add("brand", sanitizeString(changes.brand, 80));
  if ("url" in changes) {
    try {
      const sourceUrl = new URL(sanitizeString(changes.url, 500));
      if (
        sourceUrl.protocol !== "https:"
        || sourceUrl.username
        || sourceUrl.password
        || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/i.test(sourceUrl.hostname)
      ) {
        throw new Error("unsafe URL");
      }
      add("url", sourceUrl.toString());
    } catch {
      return res.status(400).json({ error: "来源地址必须是有效的公网 HTTPS 地址" });
    }
  }
  if ("cadence" in changes) {
    if (!["每日", "每周", "每月", "手动"].includes(changes.cadence)) {
      return res.status(400).json({ error: "采集频率无效" });
    }
    add("cadence", changes.cadence);
  }
  if ("priority" in changes) {
    if (!["high", "medium", "low"].includes(changes.priority)) {
      return res.status(400).json({ error: "优先级无效" });
    }
    add("priority", changes.priority);
  }
  if ("enabled" in changes) {
    const enabled = Boolean(changes.enabled);
    add("enabled", enabled ? 1 : 0);
    add("status", enabled ? "configured" : "paused");
  }
  if ("fieldScope" in changes) {
    const fields = Array.isArray(changes.fieldScope)
      ? changes.fieldScope
        .map((field) => sanitizeString(field, 40))
        .filter(Boolean)
        .slice(0, 30)
      : [];
    if (!fields.length) return res.status(400).json({ error: "至少选择一个字段范围" });
    add("field_scope", JSON.stringify(fields));
  }
  if ("notes" in changes) add("notes", sanitizeString(changes.notes, 1000));
  if ("robotsUrl" in changes) {
    const robotsUrl = sanitizeString(changes.robotsUrl, 500);
    if (robotsUrl) {
      try {
        if (new URL(robotsUrl).protocol !== "https:") throw new Error("unsafe URL");
      } catch {
        return res.status(400).json({ error: "robots.txt 地址必须是 HTTPS" });
      }
    }
    add("robots_url", robotsUrl || null);
  }
  if ("termsUrl" in changes) {
    const termsUrl = sanitizeString(changes.termsUrl, 500);
    if (termsUrl) {
      try {
        if (new URL(termsUrl).protocol !== "https:") throw new Error("unsafe URL");
      } catch {
        return res.status(400).json({ error: "许可条款地址必须是 HTTPS" });
      }
    }
    add("terms_url", termsUrl || null);
  }
  if (!assignments.length) return res.status(400).json({ error: "没有可更新的字段" });

  assignments.push("updated_at = ?");
  values.push(now(), id);
  try {
    db.prepare(`
      UPDATE crawl_sources SET ${assignments.join(", ")} WHERE id = ?
    `).run(...values);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "该来源地址已经存在" });
    }
    throw error;
  }
  const after = db.prepare(`
    SELECT s.*,
      (
        SELECT COUNT(*) FROM review_queue r
        WHERE r.source_id = s.id AND r.status = 'pending'
      ) AS pending_reviews
    FROM crawl_sources s WHERE s.id = ?
  `).get(id);
  recordAudit({
    actor: req.admin.username,
    action: "source.updated",
    entityType: "crawl_source",
    entityId: id,
    before: serializeSource(before),
    after: serializeSource(after),
    ipAddress: clientIp(req),
  });
  res.json({ item: serializeSource(after) });
});

app.get("/api/admin/reviews", requirePasswordChanged, (req, res) => {
  const status = ["pending", "approved", "rejected"].includes(req.query.status)
    ? req.query.status
    : "pending";
  const rows = db.prepare(`
    SELECT r.*, s.name AS source_name, g.brand, g.model
    FROM review_queue r
    LEFT JOIN crawl_sources s ON s.id = r.source_id
    LEFT JOIN gear g ON g.id = r.gear_id
    WHERE r.status = ?
    ORDER BY
      CASE r.confidence WHEN 'low' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      r.fetched_at DESC
  `).all(status);
  const parsedRows = rows.map((row) => ({
    row,
    proposed: JSON.parse(row.proposed_json),
  }));
  const pendingCandidatesByKey = new Map();
  if (status === "pending") {
    for (const entry of parsedRows) {
      if (entry.row.record_type !== "gear_candidate") continue;
      const key = candidateComparisonKey(entry.proposed.gear || {});
      if (!key.endsWith(":")) {
        const ids = pendingCandidatesByKey.get(key) || [];
        ids.push(entry.row.id);
        pendingCandidatesByKey.set(key, ids);
      }
    }
  }
  res.json({
    items: parsedRows.map(({ row, proposed }) => {
      const key = candidateComparisonKey(proposed.gear || {});
      const duplicateReviewIds = row.record_type === "gear_candidate"
        ? (pendingCandidatesByKey.get(key) || []).filter((id) => id !== row.id)
        : [];
      return {
        id: row.id,
        gearId: row.gear_id,
        recordType: row.record_type,
        title: row.title,
        sourceName: row.source_name,
        sourceUrl: row.source_url,
        proposed,
        current: JSON.parse(row.current_json),
        confidence: row.confidence,
        status: row.status,
        fetchedAt: row.fetched_at,
        gearLabel: row.brand && row.model ? `${row.brand} ${row.model}` : null,
        quality: row.record_type === "gear_candidate"
          ? assessCandidate(proposed, { duplicateReviewIds })
          : null,
      };
    }),
  });
});

app.post("/api/admin/reviews/:id/approve", requirePasswordChanged, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const review = db.prepare("SELECT * FROM review_queue WHERE id = ?").get(id);
  if (!review || review.status !== "pending") {
    return res.status(404).json({ error: "待审记录不存在或已处理" });
  }
  if (review.record_type === "source_snapshot") {
    db.prepare(`
      UPDATE review_queue
      SET status = 'approved', reviewed_at = ?, reviewed_by = ?
      WHERE id = ?
    `).run(now(), req.admin.username, id);
    recordAudit({
      actor: req.admin.username,
      action: "review.approved",
      entityType: "review_queue",
      entityId: id,
      before: { status: "pending", recordType: "source_snapshot" },
      after: { status: "approved", recordType: "source_snapshot" },
      ipAddress: clientIp(req),
    });
    return res.json({ ok: true });
  }
  if (review.record_type === "gear_candidate") {
    const storedProposed = JSON.parse(review.proposed_json);
    const submittedProposed = req.body?.proposed && typeof req.body.proposed === "object"
      ? req.body.proposed
      : {};
    const proposed = { ...storedProposed, ...submittedProposed };
    const candidate = proposed.gear && typeof proposed.gear === "object"
      ? proposed.gear
      : {};
    const brand = sanitizeString(candidate.brand, 80);
    const model = sanitizeString(candidate.model, 120);
    const category = candidate.category === "lens" ? "lens" : "camera";
    if (!brand || !model) return res.status(400).json({ error: "器材品牌和型号不能为空" });
    const candidateModelKey = modelComparisonKey(model, brand);
    const duplicateGear = db.prepare("SELECT id, brand, model FROM gear").all()
      .find((item) => (
        brandComparisonKey(item.brand) === brandComparisonKey(brand)
        && modelComparisonKey(item.model, item.brand) === candidateModelKey
      ));
    if (duplicateGear) {
      return res.status(409).json({
        error: `器材库已有同型号：${duplicateGear.brand} ${duplicateGear.model}，请驳回本条候选`,
      });
    }
    const baseSlug = `${brand}-${model}`
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || `gear-${review.id}`;
    let slug = baseSlug;
    let suffix = 2;
    while (db.prepare("SELECT id FROM gear WHERE slug = ?").get(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    const specs = Array.isArray(proposed.specs)
      ? proposed.specs
        .filter((spec) => spec && /^[a-z0-9_]{1,50}$/.test(spec.key || ""))
        .map((spec) => ({
          key: spec.key,
          label: sanitizeString(spec.label, 80) || spec.key,
          value: sanitizeString(spec.value, 500),
          unit: sanitizeString(spec.unit, 20),
        }))
        .filter((spec) => spec.value)
        .slice(0, 30)
      : [];
    const bestFor = Array.isArray(candidate.bestFor)
      ? candidate.bestFor.map((item) => sanitizeString(item, 30)).filter(Boolean).slice(0, 8)
      : ["新品采集"];
    const timestamp = now();
    let gearId;
    db.transaction(() => {
      gearId = Number(db.prepare(`
        INSERT INTO gear (
          slug, category, brand, model, release_year, price_cny, mount,
          sensor_format, summary, best_for, accent, status, source_name,
          source_url, confidence, verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'published', ?, ?, 'reviewed', ?, ?, ?)
      `).run(
        slug,
        category,
        brand,
        model,
        parsePositiveInt(candidate.priceCny),
        sanitizeString(candidate.mount, 80),
        sanitizeString(candidate.sensorFormat, 40),
        sanitizeString(candidate.summary, 500) || `${brand} ${model}，由官方页面采集并经人工审核入库。`,
        JSON.stringify(bestFor),
        sanitizeString(candidate.accent, 30) || "graphite",
        sanitizeString(candidate.sourceName, 120) || "官方产品页",
        sanitizeString(candidate.sourceUrl, 500) || review.source_url,
        timestamp,
        timestamp,
        timestamp,
      ).lastInsertRowid);
      const insertSpec = db.prepare(`
        INSERT INTO specs (
          gear_id, spec_key, label, value, unit, sort_order,
          source_url, confidence, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewed', ?)
      `);
      specs.forEach((spec, index) => {
        insertSpec.run(
          gearId,
          spec.key,
          spec.label,
          spec.value,
          spec.unit,
          index,
          review.source_url,
          timestamp,
        );
      });
      db.prepare(`
        UPDATE review_queue
        SET proposed_json = ?, status = 'approved', reviewed_at = ?, reviewed_by = ?
        WHERE id = ?
      `).run(JSON.stringify({ ...proposed, gear: { ...candidate, brand, model } }), timestamp, req.admin.username, id);
      db.prepare(`
        UPDATE crawl_products
        SET gear_id = ?, status = 'approved', model = ?, category = ?, last_seen_at = ?
        WHERE review_id = ?
      `).run(gearId, model, category, timestamp, id);
    })();
    recordAudit({
      actor: req.admin.username,
      action: "review.approved",
      entityType: "review_queue",
      entityId: id,
      before: { status: "pending", recordType: "gear_candidate" },
      after: { status: "approved", gearId, brand, model },
      ipAddress: clientIp(req),
    });
    return res.json({ ok: true, item: serializeGear(db.prepare("SELECT * FROM gear WHERE id = ?").get(gearId)) });
  }
  const proposed = req.body?.proposed && typeof req.body.proposed === "object"
    ? req.body.proposed
    : JSON.parse(review.proposed_json);
  const changes = proposed.changes && typeof proposed.changes === "object"
    ? proposed.changes
    : {};
  const gear = review.gear_id
    ? db.prepare("SELECT * FROM gear WHERE id = ?").get(review.gear_id)
    : null;
  if (!gear) return res.status(400).json({ error: "关联器材不存在" });

  const gearFields = new Set([
    "brand", "model", "release_year", "price_cny", "mount", "sensor_format",
    "summary", "best_for", "status", "confidence",
  ]);
  const gearChanges = {};
  const specChanges = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!/^[a-z0-9_]{1,40}$/.test(key)) continue;
    if (gearFields.has(key)) gearChanges[key] = value;
    else specChanges[key] = {
      label: db.prepare("SELECT label, unit FROM specs WHERE gear_id = ? AND spec_key = ?")
        .get(gear.id, key)?.label || key,
      value: sanitizeString(value, 300),
      unit: db.prepare("SELECT unit FROM specs WHERE gear_id = ? AND spec_key = ?")
        .get(gear.id, key)?.unit || "",
    };
  }
  if (!Object.keys(gearChanges).length && !Object.keys(specChanges).length) {
    return res.status(400).json({ error: "审核内容为空" });
  }

  const before = serializeGear(gear);
  const updatedAt = now();
  db.transaction(() => {
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(gearChanges)) {
      if (key === "release_year" || key === "price_cny") {
        const number = parsePositiveInt(value);
        if (!number) continue;
        assignments.push(`${key} = ?`);
        values.push(number);
      } else if (key === "best_for") {
        assignments.push("best_for = ?");
        values.push(JSON.stringify(Array.isArray(value) ? value.map(String) : []));
      } else if (["published", "draft"].includes(value)) {
        assignments.push("status = ?");
        values.push(value);
      } else if (["verified", "reviewed", "unverified"].includes(value)) {
        assignments.push("confidence = ?");
        values.push(value);
      } else {
        assignments.push(`${key} = ?`);
        values.push(sanitizeString(value, 500));
      }
    }
    if (assignments.length) {
      db.prepare(`
        UPDATE gear SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?
      `).run(...values, updatedAt, gear.id);
    }
    for (const [key, spec] of Object.entries(specChanges)) {
      const existing = db.prepare("SELECT id FROM specs WHERE gear_id = ? AND spec_key = ?")
        .get(gear.id, key);
      if (existing) {
        db.prepare(`
          UPDATE specs SET value = ?, confidence = 'reviewed', updated_at = ?
          WHERE gear_id = ? AND spec_key = ?
        `).run(spec.value, updatedAt, gear.id, key);
      } else {
        db.prepare(`
          INSERT INTO specs (
            gear_id, spec_key, label, value, unit, sort_order, source_url,
            confidence, updated_at
          ) VALUES (?, ?, ?, ?, ?, 99, ?, 'reviewed', ?)
        `).run(
          gear.id,
          key,
          spec.label,
          spec.value,
          spec.unit,
          review.source_url,
          updatedAt,
        );
      }
    }
    db.prepare(`
      UPDATE review_queue
      SET status = 'approved', proposed_json = ?, reviewed_at = ?, reviewed_by = ?
      WHERE id = ?
    `).run(JSON.stringify(proposed), now(), req.admin.username, id);
  })();
  const after = serializeGear(db.prepare("SELECT * FROM gear WHERE id = ?").get(gear.id));
  recordAudit({
    actor: req.admin.username,
    action: "review.approved",
    entityType: "review_queue",
    entityId: id,
    before,
    after,
    ipAddress: clientIp(req),
  });
  res.json({ ok: true, item: after });
});

app.post("/api/admin/reviews/:id/reject", requirePasswordChanged, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const review = db.prepare("SELECT * FROM review_queue WHERE id = ?").get(id);
  if (!review || review.status !== "pending") {
    return res.status(404).json({ error: "待审记录不存在或已处理" });
  }
  db.prepare(`
    UPDATE review_queue SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ?
  `).run(now(), req.admin.username, id);
  db.prepare(`
    UPDATE crawl_products SET status = 'rejected', last_seen_at = ? WHERE review_id = ?
  `).run(now(), id);
  recordAudit({
    actor: req.admin.username,
    action: "review.rejected",
    entityType: "review_queue",
    entityId: id,
    before: { status: "pending", record: review.title },
    after: { status: "rejected" },
    ipAddress: clientIp(req),
  });
  res.status(204).end();
});

app.get("/api/admin/scenes", requirePasswordChanged, (req, res) => {
  const rows = db.prepare("SELECT * FROM scenes ORDER BY id").all();
  res.json({ items: rows.map(serializeScene) });
});

app.patch("/api/admin/scenes/:id", requirePasswordChanged, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const before = db.prepare("SELECT * FROM scenes WHERE id = ?").get(id);
  if (!before) return res.status(404).json({ error: "未找到该场景" });
  const allowed = {
    title: (v) => sanitizeString(v, 80),
    description: (v) => sanitizeString(v, 500),
    light: (v) => sanitizeString(v, 80),
    motion: (v) => sanitizeString(v, 80),
    aperture: (v) => sanitizeString(v, 80),
    shutter: (v) => sanitizeString(v, 80),
    iso: (v) => sanitizeString(v, 80),
    focal: (v) => sanitizeString(v, 80),
    tips: (v) => JSON.stringify(
      Array.isArray(v) ? v.map((tip) => sanitizeString(tip, 200)).filter(Boolean) : [],
    ),
    caveat: (v) => sanitizeString(v, 500),
    imageUrl: (v) => sanitizeString(v, 300),
    imageAlt: (v) => sanitizeString(v, 200),
    imageCredit: (v) => sanitizeString(v, 100),
  };
  if (
    req.body?.imageUrl
    && !/^\/images\/[a-zA-Z0-9/_-]+\.(?:jpe?g|png|webp)$/i.test(req.body.imageUrl)
  ) {
    return res.status(400).json({ error: "场景图片必须是本站 /images/ 下的图片地址" });
  }
  const assignments = [];
  const values = [];
  for (const [key, sanitize] of Object.entries(allowed)) {
    if (!(key in (req.body || {}))) continue;
    const value = sanitize(req.body[key]);
    if (!value && !["imageUrl", "imageAlt", "imageCredit"].includes(key)) continue;
    const column = {
      tips: "tips_json",
      imageUrl: "image_url",
      imageAlt: "image_alt",
      imageCredit: "image_credit",
    }[key] || key;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (!assignments.length) return res.status(400).json({ error: "没有可更新的字段" });
  db.prepare(`
    UPDATE scenes SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?
  `).run(...values, now(), id);
  const after = db.prepare("SELECT * FROM scenes WHERE id = ?").get(id);
  recordAudit({
    actor: req.admin.username,
    action: "scene.updated",
    entityType: "scene",
    entityId: id,
    before: serializeScene(before),
    after: serializeScene(after),
    ipAddress: clientIp(req),
  });
  res.json({ item: serializeScene(after) });
});

app.get("/api/admin/audit", requirePasswordChanged, (req, res) => {
  const rows = db.prepare(`
    SELECT id, actor, action, entity_type, entity_id, before_json, after_json,
           ip_address, created_at
    FROM audit_logs ORDER BY created_at DESC LIMIT 100
  `).all();
  res.json({
    items: rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before: row.before_json ? JSON.parse(row.before_json) : null,
      after: row.after_json ? JSON.parse(row.after_json) : null,
      ipAddress: row.ip_address,
      createdAt: row.created_at,
    })),
  });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "接口不存在" });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "请求内容不是有效 JSON" });
  }
  console.error(error);
  res.status(500).json({ error: "服务暂时不可用" });
});

app.get(["/", "/gear", "/gear/*path", "/advisor", "/compare", "/admin", "/admin/*path"], (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "..", "public", "404.html"));
});

const staleSessionCleanup = setInterval(() => {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
}, 60 * 60 * 1000);
staleSessionCleanup.unref();

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`LensLab running at http://localhost:${port}`);
    console.log("Admin bootstrap user is initialized from ADMIN_USERNAME.");
  });
}

export default app;
