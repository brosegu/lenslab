import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const dataDir = path.resolve(process.env.DATA_DIR || "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(process.env.DB_PATH || path.join(dataDir, "lenslab.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    csrf_token TEXT NOT NULL,
    session_version INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS gear (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL CHECK(category IN ('camera', 'lens')),
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    release_year INTEGER,
    price_cny INTEGER,
    mount TEXT,
    sensor_format TEXT,
    summary TEXT NOT NULL,
    best_for TEXT NOT NULL,
    accent TEXT NOT NULL DEFAULT 'graphite',
    status TEXT NOT NULL DEFAULT 'published',
    source_name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'verified',
    verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS specs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gear_id INTEGER NOT NULL,
    spec_key TEXT NOT NULL,
    label TEXT NOT NULL,
    value TEXT NOT NULL,
    unit TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    source_url TEXT,
    confidence TEXT NOT NULL DEFAULT 'verified',
    updated_at TEXT NOT NULL,
    UNIQUE(gear_id, spec_key),
    FOREIGN KEY (gear_id) REFERENCES gear(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    eyebrow TEXT NOT NULL,
    description TEXT NOT NULL,
    light TEXT NOT NULL,
    motion TEXT NOT NULL,
    aperture TEXT NOT NULL,
    shutter TEXT NOT NULL,
    iso TEXT NOT NULL,
    focal TEXT NOT NULL,
    tips_json TEXT NOT NULL,
    caveat TEXT NOT NULL,
    accent TEXT NOT NULL,
    image_url TEXT,
    image_alt TEXT,
    image_credit TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS crawl_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    source_type TEXT NOT NULL,
    cadence TEXT NOT NULL,
    status TEXT NOT NULL,
    last_synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS review_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gear_id INTEGER,
    source_id INTEGER,
    record_type TEXT NOT NULL,
    title TEXT NOT NULL,
    source_url TEXT NOT NULL,
    proposed_json TEXT NOT NULL,
    current_json TEXT NOT NULL,
    confidence TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    fetched_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT,
    FOREIGN KEY (gear_id) REFERENCES gear(id) ON DELETE SET NULL,
    FOREIGN KEY (source_id) REFERENCES crawl_sources(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS crawl_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    source_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    baseline_count INTEGER NOT NULL DEFAULT 0,
    unchanged_count INTEGER NOT NULL DEFAULT 0,
    changed_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS crawl_run_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    http_status INTEGER,
    final_url TEXT,
    page_title TEXT,
    content_hash TEXT,
    previous_hash TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    links_found INTEGER NOT NULL DEFAULT 0,
    product_candidates INTEGER NOT NULL DEFAULT 0,
    review_id INTEGER,
    error_message TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES crawl_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (source_id) REFERENCES crawl_sources(id) ON DELETE CASCADE,
    FOREIGN KEY (review_id) REFERENCES review_queue(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS source_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    final_url TEXT NOT NULL,
    page_title TEXT NOT NULL,
    page_description TEXT,
    product_candidates_json TEXT NOT NULL DEFAULT '[]',
    fetched_at TEXT NOT NULL,
    UNIQUE(source_id, content_hash),
    FOREIGN KEY (source_id) REFERENCES crawl_sources(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS crawl_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    product_url TEXT NOT NULL UNIQUE,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    category TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    review_id INTEGER,
    gear_id INTEGER,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES crawl_sources(id) ON DELETE CASCADE,
    FOREIGN KEY (review_id) REFERENCES review_queue(id) ON DELETE SET NULL,
    FOREIGN KEY (gear_id) REFERENCES gear(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_specs_gear ON specs(gear_id);
  CREATE INDEX IF NOT EXISTS idx_review_status ON review_queue(status, fetched_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_crawl_runs_created ON crawl_runs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_crawl_run_items_run ON crawl_run_items(run_id, id);
  CREATE INDEX IF NOT EXISTS idx_source_snapshots_source ON source_snapshots(source_id, fetched_at DESC);
  CREATE INDEX IF NOT EXISTS idx_crawl_products_status ON crawl_products(status, last_seen_at DESC);
`);

const now = () => new Date().toISOString();

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Source management evolved after the first prototype. These additive migrations
// preserve any review data and administrator edits already stored in SQLite.
ensureColumn("crawl_sources", "brand", "TEXT");
ensureColumn("crawl_sources", "region", "TEXT NOT NULL DEFAULT 'Global'");
ensureColumn("crawl_sources", "official", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("crawl_sources", "enabled", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("crawl_sources", "priority", "TEXT NOT NULL DEFAULT 'medium'");
ensureColumn("crawl_sources", "field_scope", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("crawl_sources", "parser_key", "TEXT");
ensureColumn("crawl_sources", "robots_url", "TEXT");
ensureColumn("crawl_sources", "terms_url", "TEXT");
ensureColumn("crawl_sources", "notes", "TEXT NOT NULL DEFAULT ''");
ensureColumn("crawl_sources", "created_at", "TEXT");
ensureColumn("crawl_sources", "updated_at", "TEXT");
ensureColumn("scenes", "image_url", "TEXT");
ensureColumn("scenes", "image_alt", "TEXT");
ensureColumn("scenes", "image_credit", "TEXT");
ensureColumn("crawl_run_items", "product_results_json", "TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_crawl_sources_url ON crawl_sources(url)");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return { salt, hash: hash.toString("hex") };
}

function seedAdmin() {
  const existing = db.prepare("SELECT id FROM users LIMIT 1").get();
  if (existing) return;

  const username = process.env.ADMIN_USERNAME || "brose";
  const password = process.env.ADMIN_INITIAL_PASSWORD || "";
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error(
      "首次启动必须设置 ADMIN_INITIAL_PASSWORD，至少 12 位并同时包含字母和数字",
    );
  }
  const { salt, hash } = hashPassword(password);
  const timestamp = now();
  db.prepare(`
    INSERT INTO users (
      username, password_hash, password_salt, must_change_password, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?)
  `).run(username, hash, salt, timestamp, timestamp);
}

const gearSeed = [
  {
    slug: "sony-a7c-ii",
    category: "camera",
    brand: "Sony",
    model: "α7C II",
    releaseYear: 2023,
    priceCny: 13999,
    mount: "Sony E",
    sensorFormat: "全画幅",
    summary: "轻巧的全画幅全能机，适合旅行、人像与日常视频。",
    bestFor: ["旅行", "人像", "对焦"],
    accent: "amber",
    sourceName: "Sony 官方规格页",
    sourceUrl: "https://electronics.sony.com/imaging/interchangeable-lens-cameras/full-frame/p/ilce7cm2-b",
    confidence: "verified",
    specs: [
      ["sensor", "传感器", "3300 万像素 Exmor R CMOS", ""],
      ["mount", "镜头卡口", "Sony E", ""],
      ["autofocus", "对焦系统", "759 点相位检测", ""],
      ["stabilization", "防抖", "5 轴机身防抖", ""],
      ["video", "视频", "4K 60p 10-bit", ""],
      ["burst", "连拍", "10 fps", ""],
      ["weight", "机身重量", "514", "g"],
      ["weather", "防护", "防尘防滴", ""],
    ],
  },
  {
    slug: "fujifilm-xs20",
    category: "camera",
    brand: "Fujifilm",
    model: "X-S20",
    releaseYear: 2023,
    priceCny: 8999,
    mount: "Fujifilm X",
    sensorFormat: "APS-C",
    summary: "直出色彩与防抖兼顾的轻量旅行机，视频与照片表现均衡。",
    bestFor: ["直出", "旅行", "视频"],
    accent: "forest",
    sourceName: "Fujifilm 官方规格页",
    sourceUrl: "https://fujifilm-x.com/global/products/cameras/x-s20/",
    confidence: "verified",
    specs: [
      ["sensor", "传感器", "2610 万像素 X-Trans CMOS 4", ""],
      ["mount", "镜头卡口", "Fujifilm X", ""],
      ["autofocus", "对焦系统", "425 点智能混合对焦", ""],
      ["stabilization", "防抖", "5 轴机身防抖", ""],
      ["video", "视频", "6K 30p / 4K 60p", ""],
      ["burst", "连拍", "8 fps", ""],
      ["weight", "机身重量", "491", "g"],
      ["weather", "防护", "无官方防尘防滴", ""],
    ],
  },
  {
    slug: "canon-eos-r50",
    category: "camera",
    brand: "Canon",
    model: "EOS R50",
    releaseYear: 2023,
    priceCny: 5399,
    mount: "Canon RF",
    sensorFormat: "APS-C",
    summary: "易上手的入门无反，主体识别和直出观感对新手友好。",
    bestFor: ["入门", "Vlog", "轻量"],
    accent: "coral",
    sourceName: "Canon 官方规格页",
    sourceUrl: "https://www.usa.canon.com/shop/p/eos-r50",
    confidence: "verified",
    specs: [
      ["sensor", "传感器", "2420 万像素 CMOS", ""],
      ["mount", "镜头卡口", "Canon RF", ""],
      ["autofocus", "对焦系统", "双像素 CMOS AF II", ""],
      ["stabilization", "防抖", "镜头光学防抖", ""],
      ["video", "视频", "4K 30p", ""],
      ["burst", "连拍", "15 fps", ""],
      ["weight", "机身重量", "375", "g"],
      ["weather", "防护", "无官方防尘防滴", ""],
    ],
  },
  {
    slug: "nikon-zf",
    category: "camera",
    brand: "Nikon",
    model: "Z f",
    releaseYear: 2023,
    priceCny: 13799,
    mount: "Nikon Z",
    sensorFormat: "全画幅",
    summary: "复古机身与强悍暗光对焦结合，适合人像、街头与慢拍。",
    bestFor: ["街头", "暗光", "设计"],
    accent: "violet",
    sourceName: "Nikon 官方规格页",
    sourceUrl: "https://www.nikonusa.com/p/z-f/1782",
    confidence: "verified",
    specs: [
      ["sensor", "传感器", "2450 万像素背照式 CMOS", ""],
      ["mount", "镜头卡口", "Nikon Z", ""],
      ["autofocus", "对焦系统", "273 点混合对焦", ""],
      ["stabilization", "防抖", "8 档机身防抖", ""],
      ["video", "视频", "4K 60p", ""],
      ["burst", "连拍", "14 fps", ""],
      ["weight", "机身重量", "710", "g"],
      ["weather", "防护", "防尘防滴", ""],
    ],
  },
  {
    slug: "om-system-om5",
    category: "camera",
    brand: "OM System",
    model: "OM-5",
    releaseYear: 2022,
    priceCny: 5999,
    mount: "Micro Four Thirds",
    sensorFormat: "M4/3",
    summary: "紧凑、防抖强，搭配轻量镜头适合户外徒步和长途旅行。",
    bestFor: ["户外", "防抖", "便携"],
    accent: "ocean",
    sourceName: "OM System 官方规格页",
    sourceUrl: "https://explore.omsystem.com/us/en/om-5",
    confidence: "verified",
    specs: [
      ["sensor", "传感器", "2040 万像素 Live MOS", ""],
      ["mount", "镜头卡口", "Micro Four Thirds", ""],
      ["autofocus", "对焦系统", "121 点相位检测", ""],
      ["stabilization", "防抖", "7.5 档机身防抖", ""],
      ["video", "视频", "4K 30p", ""],
      ["burst", "连拍", "10 fps", ""],
      ["weight", "机身重量", "414", "g"],
      ["weather", "防护", "防尘防滴", ""],
    ],
  },
  {
    slug: "ricoh-gr-iiix",
    category: "camera",
    brand: "Ricoh",
    model: "GR IIIx",
    releaseYear: 2021,
    priceCny: 7199,
    mount: "固定镜头",
    sensorFormat: "APS-C",
    summary: "真正随身的口袋机，40mm 视角适合街拍、美食与日常记录。",
    bestFor: ["街拍", "随身", "日常"],
    accent: "rose",
    sourceName: "Ricoh 官方产品页",
    sourceUrl: "https://www.ricoh-imaging.co.jp/english/products/gr-3/",
    confidence: "verified",
    specs: [
      ["sensor", "传感器", "2420 万像素 CMOS", ""],
      ["mount", "镜头卡口", "固定 26.1mm F2.8", ""],
      ["autofocus", "对焦系统", "混合自动对焦", ""],
      ["stabilization", "防抖", "3 轴机身防抖", ""],
      ["video", "视频", "1080p 60p", ""],
      ["burst", "连拍", "4 fps", ""],
      ["weight", "机身重量", "262", "g"],
      ["weather", "防护", "不支持", ""],
    ],
  },
  {
    slug: "sony-fe-50-f18",
    category: "lens",
    brand: "Sony",
    model: "FE 50mm F1.8",
    releaseYear: 2016,
    priceCny: 1799,
    mount: "Sony E",
    sensorFormat: "全画幅",
    summary: "轻便的大光圈定焦，是体验虚化和弱光人像的低成本入口。",
    bestFor: ["人像", "暗光", "入门定焦"],
    accent: "amber",
    sourceName: "Sony 官方镜头页",
    sourceUrl: "https://electronics.sony.com/imaging/lenses/full-frame-e-mount/p/sel50f18f-2",
    confidence: "verified",
    specs: [
      ["focal", "焦距", "50", "mm"],
      ["aperture", "最大光圈", "F1.8", ""],
      ["mount", "镜头卡口", "Sony E", ""],
      ["filter", "滤镜口径", "49", "mm"],
      ["weight", "镜头重量", "186", "g"],
      ["focus", "对焦马达", "直流马达", ""],
    ],
  },
  {
    slug: "fujinon-xf-18-55",
    category: "lens",
    brand: "Fujinon",
    model: "XF 18-55mm F2.8-4",
    releaseYear: 2012,
    priceCny: 3299,
    mount: "Fujifilm X",
    sensorFormat: "APS-C",
    summary: "体积、光圈和画质平衡的套机升级镜头，覆盖常用旅行焦段。",
    bestFor: ["旅行", "日常", "视频"],
    accent: "forest",
    sourceName: "Fujifilm 官方镜头页",
    sourceUrl: "https://fujifilm-x.com/global/products/lenses/xf18-55mmf28-4-r-lm-ois/",
    confidence: "verified",
    specs: [
      ["focal", "焦距", "18–55", "mm"],
      ["aperture", "最大光圈", "F2.8–F4", ""],
      ["mount", "镜头卡口", "Fujifilm X", ""],
      ["filter", "滤镜口径", "58", "mm"],
      ["weight", "镜头重量", "310", "g"],
      ["focus", "对焦马达", "线性马达", ""],
    ],
  },
];

const sceneSeed = [
  {
    slug: "indoor-portrait",
    title: "室内自然光人像",
    category: "人像",
    eyebrow: "PORTRAIT",
    description: "靠窗柔光下，优先控制景深与眼神合焦，再平衡 ISO。",
    light: "柔和自然光",
    motion: "轻微",
    aperture: "f/1.8–f/4",
    shutter: "1/125–1/250s",
    iso: "ISO 200–1600",
    focal: "35–85mm",
    tips: ["让眼睛靠近画面三分线并确保眼部合焦", "先用最大光圈获得虚化，再缩小 1 档改善边缘画质", "背景杂乱时换角度比继续开大光圈更有效"],
    caveat: "大光圈下景深很浅，拍多人时建议至少收到 f/4。",
    accent: "coral",
  },
  {
    slug: "city-night",
    title: "城市夜景与灯光",
    category: "夜景",
    eyebrow: "CITY NIGHT",
    description: "在暗光中保留高光细节，用稳定快门换取纯净画面。",
    light: "弱光、人造光",
    motion: "静止",
    aperture: "f/4–f/8",
    shutter: "1/30–1/125s",
    iso: "ISO 800–3200",
    focal: "24–50mm",
    tips: ["先测天空和灯牌高光，避免大面积死白", "有防抖时可降低快门，但注意行人拖影", "RAW 拍摄给高光恢复保留更多空间"],
    caveat: "没有三脚架时不要盲目追求低 ISO，先保证画面清晰。",
    accent: "violet",
  },
  {
    slug: "sunrise-landscape",
    title: "日出与风光",
    category: "风光",
    eyebrow: "LANDSCAPE",
    description: "从中小光圈开始，使用低 ISO 与稳定的构图节奏。",
    light: "晨昏低照度",
    motion: "静止",
    aperture: "f/5.6–f/11",
    shutter: "1/15–1/250s",
    iso: "ISO 100–400",
    focal: "16–70mm",
    tips: ["用三分法安排地平线，并检查边缘是否垂直", "加入前景可以显著增强空间层次", "包曝光 3 张比单张硬拉阴影更可靠"],
    caveat: "光圈过小可能带来衍射，M4/3 与高像素机型尤其明显。",
    accent: "amber",
  },
  {
    slug: "street-snap",
    title: "街头可遇瞬间",
    category: "街拍",
    eyebrow: "STREET",
    description: "预设好快门与对焦距离，把注意力留给人物和光线。",
    light: "混合自然光",
    motion: "中等",
    aperture: "f/4–f/8",
    shutter: "1/250–1/500s",
    iso: "ISO 200–1600",
    focal: "28–50mm",
    tips: ["使用区域对焦减少半按等待", "优先寻找明暗反差与色彩呼应", "走近比拉长焦段更容易获得真实的空间感"],
    caveat: "拍摄陌生人时请尊重当地法律和个人隐私，避免侵扰。",
    accent: "ocean",
  },
  {
    slug: "pet-action",
    title: "宠物与快速动作",
    category: "动态",
    eyebrow: "ACTION",
    description: "先保证高速快门，再让连续对焦和连拍接管。",
    light: "室内外均有",
    motion: "快速",
    aperture: "f/2.8–f/5.6",
    shutter: "1/500–1/2000s",
    iso: "ISO 400–6400",
    focal: "35–135mm",
    tips: ["开启动物或主体识别对焦", "预留运动方向的空间", "室内光线不足时优先提高 ISO，而不是降低快门"],
    caveat: "运动越接近镜头，所需快门通常越快。",
    accent: "forest",
  },
  {
    slug: "food-still",
    title: "静物与美食记录",
    category: "静物",
    eyebrow: "STILL LIFE",
    description: "用侧光和较浅景深制造质感，保持关键部位清晰。",
    light: "窗边侧光",
    motion: "静止",
    aperture: "f/2.8–f/5.6",
    shutter: "1/60–1/160s",
    iso: "ISO 200–800",
    focal: "35–90mm",
    tips: ["让光源从侧后方勾勒食物轮廓", "对焦点放在最想强调的一口或细节", "稍微降低机位可以让食物更有体积感"],
    caveat: "俯拍时检查餐具边缘和画面四角，避免意外裁切。",
    accent: "rose",
  },
  {
    slug: "travel-journal",
    title: "旅行随拍",
    category: "旅行",
    eyebrow: "TRAVEL",
    description: "用可靠的安全快门覆盖行走、抓拍和环境场景。",
    light: "户外日光",
    motion: "混合",
    aperture: "f/4–f/8",
    shutter: "1/125–1/500s",
    iso: "自动 ISO 100–3200",
    focal: "24–70mm",
    tips: ["设置自动 ISO 与最低快门，减少错过瞬间", "每到一个地点先拍一张环境全景", "保留人物、细节和动作三个层次"],
    caveat: "长焦端需要更高快门，变焦后记得重新检查防抖。",
    accent: "coral",
  },
  {
    slug: "starry-sky",
    title: "星空与银河",
    category: "星空",
    eyebrow: "ASTRO",
    description: "用固定机位和手动对焦换取更多星光，并控制星点拖线。",
    light: "极弱光",
    motion: "静止",
    aperture: "f/1.8–f/2.8",
    shutter: "8–20s",
    iso: "ISO 1600–6400",
    focal: "14–24mm",
    tips: ["手动对焦到亮星或无穷远后微调", "使用两秒延时避免按快门震动", "先拍一张高 ISO 试片确认星点和构图"],
    caveat: "广角端与高像素机型的可接受曝光时间不同，需根据实际星点检查。",
    accent: "violet",
  },
];

const sceneImageSeed = {
  "indoor-portrait": {
    url: "/images/scenes/portrait.jpg",
    alt: "黑色背景前的室内男性人像",
    credit: "Unsplash",
  },
  "city-night": {
    url: "/images/scenes/city-night.jpg",
    alt: "蓝紫色灯光照亮的城市夜景街道",
    credit: "Unsplash",
  },
  "sunrise-landscape": {
    url: "/images/scenes/landscape.jpg",
    alt: "道路穿过红色岩壁通向远方山峰",
    credit: "Unsplash",
  },
  "street-snap": {
    url: "/images/scenes/street.jpg",
    alt: "高楼之间的城市街道与行人",
    credit: "Unsplash",
  },
  "pet-action": {
    url: "/images/scenes/pet.jpg",
    alt: "叼着花朵的金毛犬",
    credit: "Unsplash",
  },
  "food-still": {
    url: "/images/scenes/food.jpg",
    alt: "木桌上摆放的餐盘与食物",
    credit: "Unsplash",
  },
  "travel-journal": {
    url: "/images/scenes/travel.jpg",
    alt: "地图、相机、背包和旅行笔记",
    credit: "Unsplash",
  },
  "starry-sky": {
    url: "/images/scenes/starry.jpg",
    alt: "银河下的山脊与人物剪影",
    credit: "Unsplash",
  },
};

function seedGearAndScenes() {
  const gearCount = db.prepare("SELECT COUNT(*) AS count FROM gear").get().count;
  if (gearCount === 0) {
    const timestamp = now();
    const insertGear = db.prepare(`
      INSERT INTO gear (
        slug, category, brand, model, release_year, price_cny, mount, sensor_format,
        summary, best_for, accent, source_name, source_url, confidence, verified_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSpec = db.prepare(`
      INSERT INTO specs (
        gear_id, spec_key, label, value, unit, sort_order, source_url, confidence, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const seed = db.transaction(() => {
      for (const item of gearSeed) {
        const result = insertGear.run(
          item.slug,
          item.category,
          item.brand,
          item.model,
          item.releaseYear,
          item.priceCny,
          item.mount,
          item.sensorFormat,
          item.summary,
          JSON.stringify(item.bestFor),
          item.accent,
          item.sourceName,
          item.sourceUrl,
          item.confidence,
          timestamp,
          timestamp,
          timestamp,
        );
        item.specs.forEach(([key, label, value, unit], index) => {
          insertSpec.run(
            result.lastInsertRowid,
            key,
            label,
            value,
            unit,
            index,
            item.sourceUrl,
            item.confidence,
            timestamp,
          );
        });
      }
    });
    seed();
  }

  const sceneCount = db.prepare("SELECT COUNT(*) AS count FROM scenes").get().count;
  if (sceneCount === 0) {
    const insertScene = db.prepare(`
      INSERT INTO scenes (
        slug, title, category, eyebrow, description, light, motion, aperture,
        shutter, iso, focal, tips_json, caveat, accent, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const seedScenes = db.transaction(() => {
      for (const item of sceneSeed) {
        insertScene.run(
          item.slug,
          item.title,
          item.category,
          item.eyebrow,
          item.description,
          item.light,
          item.motion,
          item.aperture,
          item.shutter,
          item.iso,
          item.focal,
          JSON.stringify(item.tips),
          item.caveat,
          item.accent,
          now(),
        );
      }
    });
    seedScenes();
  }
}

function seedReviewQueue() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM review_queue").get().count;
  if (count > 0) return;

  const timestamp = now();
  const source = db.prepare(`
    SELECT id FROM crawl_sources WHERE parser_key = ? ORDER BY id LIMIT 1
  `);
  const sony = source.get("sony-cn-store");
  const fuji = source.get("fujifilm-cn-x");
  const canon = source.get("canon-cn-eosr");

  const a7c = db.prepare("SELECT * FROM gear WHERE slug = ?").get("sony-a7c-ii");
  const xs20 = db.prepare("SELECT * FROM gear WHERE slug = ?").get("fujifilm-xs20");
  const r50 = db.prepare("SELECT * FROM gear WHERE slug = ?").get("canon-eos-r50");

  const insertReview = db.prepare(`
    INSERT INTO review_queue (
      gear_id, source_id, record_type, title, source_url, proposed_json,
      current_json, confidence, status, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  insertReview.run(
    a7c.id,
    sony.id,
    "gear_update",
    "α7C II 规格页出现 3 处字段变化",
    "https://electronics.sony.com/imaging/interchangeable-lens-cameras/full-frame/p/ilce7cm2-b",
    JSON.stringify({
      changes: {
        weight: "515",
        video: "4K 60p 10-bit 4:2:2",
        stabilization: "5 轴机身防抖，最高 7 档",
      },
    }),
    JSON.stringify({
      changes: {
        weight: "514",
        video: "4K 60p 10-bit",
        stabilization: "5 轴机身防抖",
      },
    }),
    "medium",
    timestamp,
  );

  insertReview.run(
    xs20.id,
    fuji.id,
    "gear_update",
    "X-S20 视频规格解析结果待确认",
    "https://fujifilm-x.com/global/products/cameras/x-s20/specifications/",
    JSON.stringify({
      changes: {
        video: "6K 30p / 4K 60p / 1080p 240p",
      },
    }),
    JSON.stringify({
      changes: {
        video: "6K 30p / 4K 60p",
      },
    }),
    "high",
    timestamp,
  );

  insertReview.run(
    r50.id,
    canon.id,
    "gear_update",
    "EOS R50 新品页面字段抽取",
    "https://www.usa.canon.com/shop/p/eos-r50",
    JSON.stringify({
      changes: {
        burst: "15 fps（电子快门）/ 12 fps（机械快门）",
        weight: "375",
      },
    }),
    JSON.stringify({
      changes: {
        burst: "15 fps",
        weight: "375",
      },
    }),
    "medium",
    timestamp,
  );
}

function seedSceneImages() {
  const update = db.prepare(`
    UPDATE scenes
    SET image_url = ?, image_alt = ?, image_credit = ?
    WHERE slug = ? AND (image_url IS NULL OR image_url = '' OR image_url = ?)
  `);
  db.transaction(() => {
    for (const [slug, image] of Object.entries(sceneImageSeed)) {
      update.run(image.url, image.alt, image.credit, slug, image.url);
    }
  })();
}

const sourcePresets = [
  {
    name: "Canon 中国官方商城相机列表",
    brand: "Canon",
    url: "https://shop.canon.com.cn/prolist?category_id=59&page=1",
    sourceType: "product-list",
    cadence: "每周",
    priority: "high",
    parserKey: "canon-cn-shop-list",
    region: "China",
    enabled: false,
    fieldScope: ["在售机型", "套机价格", "产品链接", "上市状态"],
    robotsUrl: "https://shop.canon.com.cn/robots.txt",
    termsUrl: "https://www.canon.com.cn/",
    notes: "产品页可访问，但 robots.txt 返回 403；按合规策略暂停自动采集，待人工确认许可。",
  },
  {
    name: "Canon EOS R 中国产品阵容",
    brand: "Canon",
    url: "https://www.canon.com.cn/special/eosr/",
    sourceType: "product-lineup",
    cadence: "每周",
    priority: "high",
    parserKey: "canon-cn-eosr",
    region: "China",
    enabled: true,
    fieldScope: ["EOS R 机型", "系列分类", "产品链接", "关键卖点"],
    robotsUrl: "https://www.canon.com.cn/robots.txt",
    termsUrl: "https://www.canon.com.cn/",
    notes: "中国官网 EOS R 系列阵容页，按 R1/R3/R5/R6/R8 等系列组织。",
  },
  {
    name: "Canon 全球相机博物馆",
    brand: "Canon",
    url: "https://global.canon/en/c-museum/",
    sourceType: "product-archive",
    cadence: "每周",
    priority: "medium",
    parserKey: "canon-global-museum",
    region: "Global",
    enabled: true,
    fieldScope: ["历史机型", "发布年份", "系列", "产品档案"],
    robotsUrl: "https://global.canon/robots.txt",
    termsUrl: "https://global.canon/en/terms/",
    notes: "用于补齐历代机型与发布时间，不作为在售价格来源。",
  },
  {
    name: "Nikon 中国 Z 系列",
    brand: "Nikon",
    url: "https://www.nikon.com.cn/sc_CN/products/categories/z-series.page",
    sourceType: "product-lineup",
    cadence: "每周",
    priority: "high",
    parserKey: "nikon-cn-z-series",
    region: "China",
    enabled: true,
    fieldScope: ["Z 系列机型", "像素", "处理器", "对焦", "视频"],
    robotsUrl: "https://www.nikon.com.cn/robots.txt",
    termsUrl: "https://www.nikon.com.cn/",
    notes: "中国官网 Z 系列列表，页面包含机型入口和关键规格。",
  },
  {
    name: "Nikon 中国微单分类",
    brand: "Nikon",
    url: "https://www.nikon.com.cn/sc_CN/products/categories/mirrorless.page",
    sourceType: "product-list",
    cadence: "每周",
    priority: "medium",
    parserKey: "nikon-cn-mirrorless",
    region: "China",
    enabled: true,
    fieldScope: ["微单分类", "机型链接", "系列信息"],
    robotsUrl: "https://www.nikon.com.cn/robots.txt",
    termsUrl: "https://www.nikon.com.cn/",
    notes: "尼康中国微单总分类，可补充 Z 系列之外的产品入口。",
  },
  {
    name: "Nikon 中国产品总览",
    brand: "Nikon",
    url: "https://www.nikon.com.cn/sc_CN/products/",
    sourceType: "product-overview",
    cadence: "每周",
    priority: "medium",
    parserKey: "nikon-cn-products",
    region: "China",
    enabled: false,
    fieldScope: ["产品大类", "微单", "单反", "轻便相机", "镜头"],
    robotsUrl: "https://www.nikon.com.cn/robots.txt",
    termsUrl: "https://www.nikon.com.cn/",
    notes: "当前探测跳转到带 sessionid 的 404 页面，暂停采集并等待入口变化。",
  },
  {
    name: "Sony 中国在线商城",
    brand: "Sony",
    url: "https://www.sonystyle.com.cn/",
    sourceType: "official-store",
    cadence: "每周",
    priority: "high",
    parserKey: "sony-cn-store",
    region: "China",
    enabled: true,
    fieldScope: ["微单", "黑卡", "电影机", "在售价格", "产品链接"],
    robotsUrl: "https://www.sonystyle.com.cn/robots.txt",
    termsUrl: "https://www.sonystyle.com.cn/",
    notes: "索尼中国官方直营商城，按相机系列陈列在售产品。",
  },
  {
    name: "Sony 中国影像产品入口",
    brand: "Sony",
    url: "https://www.sony.com.cn/electronics/",
    sourceType: "product-overview",
    cadence: "每周",
    priority: "medium",
    parserKey: "sony-cn-electronics",
    region: "China",
    enabled: false,
    fieldScope: ["影像大类", "微单", "摄像机", "镜头"],
    robotsUrl: "https://www.sony.com.cn/robots.txt",
    termsUrl: "https://www.sony.com.cn/",
    notes: "当前探测返回 404，暂停采集并等待官方入口更新。",
  },
  {
    name: "Fujifilm 中国 X 系列",
    brand: "Fujifilm",
    url: "https://www.fujifilm.com.cn/cn/zh-hans/consumer/digitalcameras/X",
    sourceType: "product-lineup",
    cadence: "每日",
    priority: "high",
    parserKey: "fujifilm-cn-x",
    region: "China",
    enabled: true,
    fieldScope: ["X 系列机型", "产品链接", "系列分类", "关键规格"],
    robotsUrl: "https://www.fujifilm.com.cn/robots.txt",
    termsUrl: "https://www.fujifilm.com.cn/",
    notes: "富士中国官网 X 系列无反产品阵容页。",
  },
  {
    name: "Fujifilm 中国 GFX 系列",
    brand: "Fujifilm",
    url: "https://www.fujifilm.com.cn/cn/zh-hans/consumer/digitalcameras/GFX",
    sourceType: "product-lineup",
    cadence: "每周",
    priority: "high",
    parserKey: "fujifilm-cn-gfx",
    region: "China",
    enabled: true,
    fieldScope: ["GFX 系列机型", "中画幅规格", "产品链接"],
    robotsUrl: "https://www.fujifilm.com.cn/robots.txt",
    termsUrl: "https://www.fujifilm.com.cn/",
    notes: "富士中国官网 GFX 中画幅相机产品阵容页。",
  },
  {
    name: "Fujifilm 中国民用产品总览",
    brand: "Fujifilm",
    url: "https://www.fujifilm.com.cn/cn/zh-hans/consumer/",
    sourceType: "product-overview",
    cadence: "每周",
    priority: "medium",
    parserKey: "fujifilm-cn-consumer",
    region: "China",
    enabled: true,
    fieldScope: ["数码相机", "instax", "镜头", "民用产品"],
    robotsUrl: "https://www.fujifilm.com.cn/robots.txt",
    termsUrl: "https://www.fujifilm.com.cn/",
    notes: "富士中国民用产品总入口，用于发现新增产品类别。",
  },
  {
    name: "Panasonic 中国 LUMIX S 系列",
    brand: "Panasonic",
    url: "https://consumer.panasonic.cn/product/cameras-camcorders/lumix-series/lumix-s-series_2",
    sourceType: "product-list",
    cadence: "每周",
    priority: "high",
    parserKey: "panasonic-cn-lumix-s",
    region: "China",
    enabled: true,
    fieldScope: ["全画幅机型", "产品链接", "关键规格", "系列分类"],
    robotsUrl: "https://consumer.panasonic.cn/robots.txt",
    termsUrl: "https://consumer.panasonic.cn/",
    notes: "松下中国 LUMIX S 全画幅无反产品列表。",
  },
  {
    name: "Panasonic 中国 LUMIX G 系列",
    brand: "Panasonic",
    url: "https://consumer.panasonic.cn/product/cameras-camcorders/lumix-series/lumix-g-series",
    sourceType: "product-list",
    cadence: "每周",
    priority: "high",
    parserKey: "panasonic-cn-lumix-g",
    region: "China",
    enabled: true,
    fieldScope: ["M4/3 机型", "GH/G/GX/GF", "产品链接"],
    robotsUrl: "https://consumer.panasonic.cn/robots.txt",
    termsUrl: "https://consumer.panasonic.cn/",
    notes: "松下中国 LUMIX G 系列 M4/3 无反产品列表。",
  },
  {
    name: "Panasonic 中国 LUMIX 总览",
    brand: "Panasonic",
    url: "https://consumer.panasonic.cn/product/cameras-camcorders/lumix-series_3/",
    sourceType: "product-overview",
    cadence: "每周",
    priority: "medium",
    parserKey: "panasonic-cn-lumix-overview",
    region: "China",
    enabled: true,
    fieldScope: ["LUMIX 总览", "全画幅", "M4/3", "产品链接"],
    robotsUrl: "https://consumer.panasonic.cn/robots.txt",
    termsUrl: "https://consumer.panasonic.cn/",
    notes: "松下中国 LUMIX 相机总入口。",
  },
  {
    name: "Leica 中文相机一览",
    brand: "Leica",
    url: "https://leica-camera.com/zh/camera",
    sourceType: "product-lineup",
    cadence: "每周",
    priority: "high",
    parserKey: "leica-cn-cameras",
    region: "China",
    enabled: false,
    fieldScope: ["M/SL/Q 系列", "便携相机", "产品链接"],
    robotsUrl: "https://leica-camera.com/robots.txt",
    termsUrl: "https://leica-camera.com/zh/legal-information",
    notes: "页面可访问，但 robots.txt 不允许采集该路径；已暂停自动采集。",
  },
  {
    name: "Leica 英文系统相机",
    brand: "Leica",
    url: "https://leica-camera.com/en-US/photography/cameras",
    sourceType: "product-lineup",
    cadence: "每周",
    priority: "medium",
    parserKey: "leica-en-cameras",
    region: "Global",
    enabled: false,
    fieldScope: ["System Cameras", "英文规格", "产品链接"],
    robotsUrl: "https://leica-camera.com/robots.txt",
    termsUrl: "https://leica-camera.com/en-US/legal-information",
    notes: "页面可访问，但 robots.txt 不允许采集该路径；已暂停自动采集。",
  },
  {
    name: "Hasselblad 欧洲官方商店",
    brand: "Hasselblad",
    url: "https://store-eu.hasselblad.com/",
    sourceType: "official-store",
    cadence: "每周",
    priority: "high",
    parserKey: "hasselblad-eu-store",
    region: "Europe",
    enabled: true,
    fieldScope: ["相机", "镜头", "配件", "在售产品"],
    robotsUrl: "https://store-eu.hasselblad.com/robots.txt",
    termsUrl: "https://www.hasselblad.com/",
    notes: "哈苏欧洲官方直营商店，可作为在售产品主来源。",
  },
  {
    name: "Hasselblad 主站相机入口",
    brand: "Hasselblad",
    url: "https://www.hasselblad.com/cameras/",
    sourceType: "product-overview",
    cadence: "每周",
    priority: "medium",
    parserKey: "hasselblad-cameras",
    region: "Global",
    enabled: false,
    fieldScope: ["相机产品入口", "产品链接"],
    robotsUrl: "https://www.hasselblad.com/robots.txt",
    termsUrl: "https://www.hasselblad.com/",
    notes: "当前探测返回 404，暂停采集并等待官方路径更新。",
  },
  {
    name: "OM System 中国微单产品页",
    brand: "OM System",
    url: "https://om-digitalsolutions.cn/products/mirrorless/",
    sourceType: "product-list",
    cadence: "每周",
    priority: "high",
    parserKey: "om-system-cn-mirrorless",
    region: "China",
    enabled: false,
    fieldScope: ["OM-D", "PEN", "微型单电", "产品链接"],
    robotsUrl: "https://om-digitalsolutions.cn/robots.txt",
    termsUrl: "https://om-digitalsolutions.cn/",
    notes: "当前探测返回 404，暂停采集并等待官方路径更新。",
  },
  {
    name: "OM System 中国官网",
    brand: "OM System",
    url: "https://om-digitalsolutions.cn/",
    sourceType: "product-overview",
    cadence: "每周",
    priority: "high",
    parserKey: "om-system-cn-home",
    region: "China",
    enabled: true,
    fieldScope: ["OM-D", "PEN", "M.ZUIKO", "产品入口"],
    robotsUrl: "https://om-digitalsolutions.cn/robots.txt",
    termsUrl: "https://om-digitalsolutions.cn/",
    notes: "奥之心中国官网总入口，用于发现机型和镜头入口。",
  },
  {
    name: "Ricoh 中国产品总览",
    brand: "Ricoh",
    url: "https://www.ricoh-imaging.com.cn/products/",
    sourceType: "product-overview",
    cadence: "每周",
    priority: "high",
    parserKey: "ricoh-cn-products",
    region: "China",
    enabled: true,
    fieldScope: ["RICOH", "PENTAX", "产品入口"],
    robotsUrl: "https://www.ricoh-imaging.com.cn/robots.txt",
    termsUrl: "https://www.ricoh-imaging.com.cn/",
    notes: "理光映像中国产品总览，覆盖 RICOH 与 PENTAX。",
  },
  {
    name: "PENTAX 中国产品页",
    brand: "Pentax",
    url: "https://www.ricoh-imaging.com.cn/products/pentax/",
    sourceType: "product-lineup",
    cadence: "每周",
    priority: "medium",
    parserKey: "pentax-cn-products",
    region: "China",
    enabled: true,
    fieldScope: ["PENTAX 单反", "镜头", "产品链接"],
    robotsUrl: "https://www.ricoh-imaging.com.cn/robots.txt",
    termsUrl: "https://www.ricoh-imaging.com.cn/",
    notes: "PENTAX 中国产品入口。",
  },
  {
    name: "RICOH GR 中国产品页",
    brand: "Ricoh",
    url: "https://www.ricoh-imaging.com.cn/products/gr/",
    sourceType: "product-lineup",
    cadence: "每周",
    priority: "high",
    parserKey: "ricoh-cn-gr",
    region: "China",
    enabled: true,
    fieldScope: ["GR 系列", "便携相机", "产品链接"],
    robotsUrl: "https://www.ricoh-imaging.com.cn/robots.txt",
    termsUrl: "https://www.ricoh-imaging.com.cn/",
    notes: "RICOH GR 中国产品页。",
  },
  {
    name: "Sigma 官方镜头库",
    brand: "Sigma",
    url: "https://www.sigma-global.com/",
    sourceType: "manufacturer",
    cadence: "每周",
    priority: "high",
    parserKey: "sigma-official",
    region: "Global",
    enabled: true,
    fieldScope: ["镜头规格", "卡口版本", "滤镜口径", "重量", "最近对焦"],
    robotsUrl: "https://www.sigma-global.com/robots.txt",
    termsUrl: "https://www.sigma-global.com/en/terms/",
    notes: "同一光学结构可能对应多个卡口版本，必须以卡口作为独立变体。",
  },
  {
    name: "Tamron 官方镜头库",
    brand: "Tamron",
    url: "https://www.tamron.com/",
    sourceType: "manufacturer",
    cadence: "每周",
    priority: "high",
    parserKey: "tamron-official",
    region: "Global",
    enabled: true,
    fieldScope: ["镜头规格", "卡口版本", "滤镜口径", "重量", "防抖"],
    robotsUrl: "https://www.tamron.com/robots.txt",
    termsUrl: "https://www.tamron.com/legal/",
    notes: "按卡口区分型号，价格字段不应从非官方渠道自动覆盖。",
  },
];

function seedCrawlSources() {
  const timestamp = now();
  const findSourceByParser = db.prepare(`
    SELECT * FROM crawl_sources WHERE parser_key = ? ORDER BY id LIMIT 1
  `);
  const findSourceByUrl = db.prepare("SELECT * FROM crawl_sources WHERE url = ?");
  const insertSource = db.prepare(`
    INSERT INTO crawl_sources (
      name, url, source_type, cadence, status, last_synced_at, brand, region,
      official, enabled, priority, field_scope, parser_key, robots_url, terms_url,
      notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateSeedFields = db.prepare(`
    UPDATE crawl_sources SET
      name = ?, url = ?, source_type = ?, cadence = ?, status = ?,
      brand = ?, region = ?,
      official = 1,
      enabled = ?, priority = ?, field_scope = ?, parser_key = ?,
      robots_url = ?, terms_url = ?, notes = ?,
      created_at = COALESCE(created_at, ?), updated_at = ?
    WHERE id = ?
  `);
  const disableLegacy = db.prepare(`
    UPDATE crawl_sources
    SET enabled = 0, status = 'paused', updated_at = ?,
        notes = CASE
          WHEN notes = '' OR notes LIKE '已迁移到中国官网%'
          THEN '已迁移到中国官网种子页，保留历史记录但暂停采集。'
          ELSE notes
        END
    WHERE url = ?
  `);
  const legacyUrls = [
    "https://www.usa.canon.com/",
    "https://www.nikonusa.com/",
    "https://fujifilm-x.com/",
    "https://www.fujifilm-x.com/zh-cn/",
    "https://www.canon.com.cn/overview/eos.html",
    "https://www.nikon.com.cn/sc_CN",
    "https://electronics.sony.com/",
    "https://shop.panasonic.com/",
    "https://www.ricoh-imaging.co.jp/",
    "https://leica-camera.com/",
    "https://explore.omsystem.com/",
  ];

  db.transaction(() => {
    for (const source of sourcePresets) {
      const existing = findSourceByParser.get(source.parserKey)
        || findSourceByUrl.get(source.url);
      const status = source.enabled
        ? existing?.url === source.url
          ? existing.status
          : "configured"
        : "paused";
      if (existing) {
        updateSeedFields.run(
          source.name,
          source.url,
          source.sourceType,
          source.cadence,
          status,
          source.brand,
          source.region,
          source.enabled ? 1 : 0,
          source.priority,
          JSON.stringify(source.fieldScope),
          source.parserKey,
          source.robotsUrl,
          source.termsUrl,
          source.notes,
          timestamp,
          timestamp,
          existing.id,
        );
      } else {
        insertSource.run(
          source.name,
          source.url,
          source.sourceType,
          source.cadence,
          source.enabled ? "configured" : "paused",
          source.brand,
          source.region,
          source.enabled ? 1 : 0,
          source.priority,
          JSON.stringify(source.fieldScope),
          source.parserKey,
          source.robotsUrl,
          source.termsUrl,
          source.notes,
          timestamp,
          timestamp,
        );
      }
    }
    for (const url of legacyUrls) disableLegacy.run(timestamp, url);
  })();
}

seedAdmin();
seedGearAndScenes();
seedSceneImages();
seedCrawlSources();
seedReviewQueue();

export function passwordDigest(password, salt) {
  return hashPassword(password, salt);
}

export function recordAudit({
  actor,
  action,
  entityType,
  entityId,
  before = null,
  after = null,
  ipAddress = null,
}) {
  db.prepare(`
    INSERT INTO audit_logs (
      actor, action, entity_type, entity_id, before_json, after_json, ip_address, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actor,
    action,
    entityType,
    String(entityId),
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    ipAddress,
    now(),
  );
}
