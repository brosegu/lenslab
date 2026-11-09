import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { load } from "cheerio";
import { chromium } from "playwright";
import robotsParser from "robots-parser";
import { db, recordAudit } from "./db.js";
import {
  brandComparisonKey,
  modelComparisonKey,
} from "./candidate-quality.js";

const USER_AGENT = "LensLabBot/0.1 (manual official-source verification)";
const BOT_TOKEN = "LensLabBot";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const SOURCE_CONCURRENCY = 3;
const MAX_PRODUCT_LINKS = 12;
const MAX_CATALOG_PAGES = 2;
const robotsCache = new Map();
const activeRuns = new Set();
let browserPromise = null;

const now = () => new Date().toISOString();

function privateIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0
    || a >= 224
  );
}

function privateAddress(address) {
  if (net.isIP(address) === 4) return privateIpv4(address);
  const normalized = address.toLowerCase();
  return (
    normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
    || normalized.startsWith("::ffff:127.")
    || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.")
  );
}

async function validatePublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("来源 URL 格式无效");
  }
  if (url.protocol !== "https:") throw new Error("只允许采集 HTTPS 地址");
  if (url.username || url.password) throw new Error("来源 URL 不允许包含登录凭据");
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname === "metadata.google.internal"
  ) {
    throw new Error("来源地址解析到非公网主机");
  }
  if (net.isIP(hostname) && privateAddress(hostname)) {
    throw new Error("来源地址解析到内网 IP");
  }
  if (!net.isIP(hostname)) {
    let addresses;
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error(`域名无法解析：${hostname}`);
    }
    if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) {
      throw new Error("来源域名解析到内网地址");
    }
  }
  return url;
}

async function readLimitedBody(response, limit) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength && declaredLength > limit) {
    throw new Error(`页面超过 ${Math.round(limit / 1024 / 1024)}MB 限制`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`页面超过 ${Math.round(limit / 1024 / 1024)}MB 限制`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function safeFetch(rawUrl, maxBytes = MAX_HTML_BYTES) {
  let current = await validatePublicUrl(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`HTTP ${response.status} 响应缺少跳转地址`);
      if (redirects === MAX_REDIRECTS) throw new Error("页面跳转次数过多");
      const next = new URL(location, current);
      if (next.protocol === "http:") next.protocol = "https:";
      current = await validatePublicUrl(next.toString());
      continue;
    }
    const text = await readLimitedBody(response, maxBytes);
    return {
      status: response.status,
      finalUrl: current.toString(),
      contentType: response.headers.get("content-type") || "",
      text,
    };
  }
  throw new Error("页面跳转次数过多");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeJsonLdCandidates(value, output, seen, depth = 0) {
  if (depth > 8 || output.length >= 30 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) decodeJsonLdCandidates(item, output, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some((type) => /product/i.test(String(type || "")))) {
    const name = cleanText(value.name || value.headline);
    const url = cleanText(value.url || value["@id"]);
    if (name) {
      const key = `${name}|${url}`;
      if (!seen.has(key)) {
        seen.add(key);
        output.push({
          name: name.slice(0, 160),
          sku: cleanText(value.sku || value.productID).slice(0, 80),
          brand: cleanText(value.brand?.name || value.brand).slice(0, 80),
          description: cleanText(value.description).slice(0, 500),
          url: url.slice(0, 500),
        });
      }
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "@context" || key === "description") continue;
    if (child && typeof child === "object") {
      decodeJsonLdCandidates(child, output, seen, depth + 1);
    }
  }
}

function extractPage(html, finalUrl) {
  const $ = load(html);
  const products = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      decodeJsonLdCandidates(JSON.parse($(element).text()), products, new Set());
    } catch {
      // Invalid publisher JSON should not fail the whole source.
    }
  });

  const title = cleanText(
    $('meta[property="og:title"]').attr("content")
    || $("title").first().text(),
  ).slice(0, 300);
  const description = cleanText(
    $('meta[name="description"]').attr("content")
    || $('meta[property="og:description"]').attr("content"),
  ).slice(0, 1000);
  const canonical = cleanText(
    $('link[rel="canonical"]').attr("href") || finalUrl,
  ).slice(0, 500);
  const headings = $("h1, h2")
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean)
    .slice(0, 12);
  const links = [];
  $("a[href]").each((_, element) => {
    if (links.length >= 20) return false;
    const label = cleanText($(element).text());
    const href = $(element).attr("href");
    if (!label || !href) return;
    try {
      const resolved = new URL(href, finalUrl);
      if (!["http:", "https:"].includes(resolved.protocol)) return;
      links.push({
        label: label.slice(0, 120),
        url: resolved.toString().slice(0, 500),
      });
    } catch {
      // Invalid links are ignored.
    }
  });
  const signatureInput = JSON.stringify({
    title,
    description,
    canonical,
    headings,
    products: products.map((product) => `${product.name}|${product.url}`),
  });
  return {
    title,
    description,
    canonical,
    headings,
    links,
    products,
    contentHash: crypto.createHash("sha256").update(signatureInput).digest("hex"),
  };
}

const brandRules = {
  canon: {
    productPattern: /\/special\/eosr\/r\d+[a-z0-9-]*\.html$/i,
    catalogPattern: /\/special\/eosr\/(?:index\.html)?$/i,
  },
  nikon: {
    productPattern: /\/sc_CN\/product\/mirrorless\/z-[a-z0-9-]+\/?$/i,
  },
  sony: {
    productPattern: /\/products\/(?:ilc|cyber-shot)\/[a-z0-9_-]+\/[a-z0-9_-]+\.html$/i,
  },
  fujifilm: {
    productPattern: /\/products\/(?:cameras|lenses)\/[a-z0-9_-]+\/?$/i,
    catalogPattern: /\/consumer\/digitalcameras\/(?:X|GFX)\/?$/i,
  },
  panasonic: {
    productPattern: /\/product\/cameras-camcorders\/lumix-series\/lumix-[sg]-series\/dc-[a-z0-9-]+\.html$/i,
  },
  leica: {
    productPattern: /\/photography\/cameras\/[a-z0-9_-]+\/?$/i,
  },
  hasselblad: {
    productPattern: /\/products\/[a-z0-9-]+$/i,
  },
  "om-system": {
    productPattern: /\/product\/dslr\/(?:om|em|pen|ep|epl)[a-z0-9_-]*\/index\.html$/i,
    discoveryUrl: "https://om-digitalsolutions.cn/product/dslr/index.html",
  },
  ricoh: {
    productPattern: /\/products\/gr\/[a-z0-9_-]+\/?$/i,
  },
  pentax: {
    productPattern: /\/products\/pentax\/[a-z0-9_-]+\/?$/i,
  },
  sigma: {
    productPattern: /\/en\/lenses\/[acs]\d{3}_[a-z0-9_]+\/?$/i,
    discoveryUrl: "https://www.sigma-global.com/en/lenses/",
  },
  tamron: {
    productPattern: /\/global\/consumer\/lenses\/[a-z]\d{3}\/?$/i,
    catalogPattern: /\/global\/consumer\/lenses\/(?:sony_e|nikon_z|fujifilm_x|canon_rf)\/?$/i,
  },
};

function sourceBrandKey(source) {
  const parserKey = source.parser_key || "";
  return Object.keys(brandRules).find((key) => parserKey.startsWith(key)) || "";
}

function allowedProductOrigins(source, finalUrl) {
  const origins = new Set();
  for (const value of [source.url, finalUrl]) {
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Ignore malformed historical source values.
    }
  }
  const brandKey = sourceBrandKey(source);
  if (brandKey === "fujifilm") {
    origins.add("https://fujifilm-x.com");
    origins.add("https://www.fujifilm-x.com");
  }
  if (brandKey === "sony") origins.add("https://electronics.sony.com");
  if (brandKey === "canon") origins.add("https://www.usa.canon.com");
  return origins;
}

export function normalizeProductUrl(raw, baseUrl) {
  try {
    const url = new URL(raw.replaceAll("&amp;", "&"), baseUrl);
    url.hash = "";
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.hostname === "www.fujifilm-x.com") url.hostname = "fujifilm-x.com";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function collectOfficialLinks(html, source, finalUrl) {
  const $ = load(html);
  const allowedOrigins = allowedProductOrigins(source, finalUrl);
  const links = new Map();
  $("a[href]").each((_, element) => {
    const normalized = normalizeProductUrl($(element).attr("href"), finalUrl);
    if (!normalized) return;
    try {
      if (!allowedOrigins.has(new URL(normalized).origin)) return;
    } catch {
      return;
    }
    const label = cleanText($(element).text()).slice(0, 180);
    const existing = links.get(normalized);
    if (!existing) {
      links.set(normalized, { url: normalized, label });
    } else if (!existing.label && label) {
      existing.label = label;
    }
  });
  return [...links.values()];
}

export function discoverProductLinks(html, source, finalUrl, limit = MAX_PRODUCT_LINKS) {
  const brandKey = sourceBrandKey(source);
  const rule = brandRules[brandKey];
  if (!rule) return [];
  const candidates = [];
  const seen = new Set();
  const maxLinks = Math.max(1, Math.min(MAX_PRODUCT_LINKS, Number(limit) || MAX_PRODUCT_LINKS));
  const addCandidate = (normalized, label = "") => {
    if (!normalized || seen.has(normalized)) return;
    let url;
    try {
      url = new URL(normalized);
    } catch {
      return;
    }
    if (!allowedProductOrigins(source, finalUrl).has(url.origin)) return;
    if (url.pathname === "/" || /\.(?:css|js|jpg|jpeg|png|svg|webp|pdf|zip)$/i.test(url.pathname)) return;
    if (/^\/index\.html?$/i.test(url.pathname)) return;
    if (!rule.productPattern.test(normalized)) return;
    seen.add(normalized);
    candidates.push({ url: normalized, label });
  };

  for (const link of collectOfficialLinks(html, source, finalUrl)) {
    addCandidate(link.url, link.label);
    if (candidates.length >= maxLinks) break;
  }
  return candidates;
}

export function discoverCatalogLinks(html, source, finalUrl, limit = MAX_CATALOG_PAGES) {
  const rule = brandRules[sourceBrandKey(source)];
  if (!rule?.catalogPattern) return [];
  const maxLinks = Math.max(1, Math.min(MAX_CATALOG_PAGES, Number(limit) || MAX_CATALOG_PAGES));
  const output = [];
  const seen = new Set();
  for (const link of collectOfficialLinks(html, source, finalUrl)) {
    if (seen.has(link.url) || !rule.catalogPattern.test(link.url)) continue;
    if (new URL(link.url).pathname === new URL(finalUrl).pathname) continue;
    seen.add(link.url);
    output.push(link);
    if (output.length >= maxLinks) break;
  }
  return output;
}

async function renderPageContent(url) {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  const browser = await browserPromise;
  const page = await browser.newPage({
    viewport: { width: 1365, height: 900 },
    locale: "zh-CN",
    userAgent: USER_AGENT,
  });
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: REQUEST_TIMEOUT_MS,
      referer: "about:blank",
    });
    if (response && response.status() >= 400) {
      throw new Error(`浏览器渲染返回 HTTP ${response.status()}`);
    }
    await page.waitForTimeout(1200);
    const finalUrl = await validatePublicUrl(page.url());
    return {
      html: await page.content(),
      finalUrl: finalUrl.toString(),
      status: response?.status() || 200,
    };
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  const current = browserPromise;
  browserPromise = null;
  try {
    const browser = await current;
    await browser.close();
  } catch {
    // Browser startup may already have failed.
  }
}

function collectProductObjects(value, output, depth = 0) {
  if (depth > 8 || value == null || output.length >= 5) return;
  if (Array.isArray(value)) {
    for (const item of value) collectProductObjects(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some((type) => /^product$/i.test(String(type || "")))) output.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "offers" || key === "image") continue;
    if (child && typeof child === "object") collectProductObjects(child, output, depth + 1);
  }
}

function inferCategory(brand, title, url, linkLabel) {
  const text = `${brand} ${title} ${linkLabel} ${url}`;
  if (/\/products\/(?:ilc|cyber-shot)\/|\/special\/eosr\/|\/product\/mirrorless\/|\/lumix-[sg]-series\//i.test(url)) {
    return "camera";
  }
  if (
    /^(?:Sigma|Tamron)$/i.test(brand)
    || /lens|镜头/i.test(text)
    || /\b\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?mm\s*(?:F\/?|F)\d/i.test(text)
    || /XCD\s/i.test(text)
  ) {
    return "lens";
  }
  return "camera";
}

function inferModel(brand, title, url, linkLabel) {
  const clean = (value) => cleanText(value)
    .replace(/\s*[-|｜]\s*(?:Sony|Canon|Nikon|Panasonic|Fujifilm|Hasselblad|Sigma|TAMRON).*$/i, "")
    .trim();
  const titleText = clean(title);
  const labelText = clean(linkLabel);
  let model = "";
  if (brand === "Canon") {
    model = (labelText.match(/\bEOS\s+[A-Z0-9]+(?:\s+Mark\s+[IVX]+)?/i)
      || titleText.match(/\bEOS\s+[A-Z0-9]+(?:\s+Mark\s+[IVX]+)?/i)
      || [])[0];
  } else if (brand === "Nikon") {
    const fromUrl = url.match(/\/z-?([a-z0-9]+)(?:\/|$)/i)?.[1];
    const matched = labelText.match(/\bZ\s?(?:\d+(?:\s?II)?|f|fc)\b/i)
      || titleText.match(/\bZ\s?(?:\d+(?:\s?II)?|f|fc)\b/i)
      || [];
    model = matched[0] || (fromUrl ? `Z ${fromUrl.toUpperCase()}` : "");
  } else if (brand === "Sony") {
    const alphaModel = titleText.match(/\bAlpha\s+(\d+[A-Za-z]*)\s*(VIII|VII|VI|V|IV|III|II)?/i);
    if (alphaModel) {
      model = `α${alphaModel[1]}${alphaModel[2] ? ` ${alphaModel[2].toUpperCase()}` : ""}`;
    } else {
      model = (titleText.match(/α\s?\d+[A-Za-z]*\s*(?:VIII|VII|VI|V|IV|III|II)?/i)
      || titleText.match(/ILCE-?[A-Z0-9]+/i)
      || labelText.match(/ILCE-?[A-Z0-9]+/i)
      || [])[0] || "";
    }
  } else if (brand === "Panasonic") {
    const matched = titleText.match(/\bDC-[A-Z0-9-]+/i)
      || labelText.match(/\bDC-[A-Z0-9-]+/i);
    model = matched?.[0]
      || (url.match(/\/(?:dc-|DMC-)([a-z0-9-]+)\.html/i)?.[1]
        ? `DC-${url.match(/\/(?:dc-|DMC-)([a-z0-9-]+)\.html/i)[1].toUpperCase()}`
        : "");
  } else if (brand === "Fujifilm") {
    model = (titleText.match(/\b(?:X-[A-Z0-9]+|GFX\s?\d+[A-Z0-9 ]*)/i)
      || labelText.match(/\b(?:X-[A-Z0-9]+|GFX\s?\d+[A-Z0-9 ]*)/i)
      || [])[0] || "";
  } else if (brand === "Hasselblad") {
    model = (titleText.match(/\b(?:X2D(?:\s+II)?\s+100C|907X(?:\s*&\s*CFV\s+100C)?|CFV\s+100C|XCD[^|]{1,40})/i)
      || labelText.match(/\b(?:X2D(?:\s+II)?\s+100C|907X(?:\s*&\s*CFV\s+100C)?|CFV\s+100C|XCD[^|]{1,40})/i)
      || [])[0] || "";
  } else if (brand === "OM System") {
    model = (titleText.match(/\b(?:OM-\d+(?:\s+Mark\s+[IVX]+)?|PEN[^|]{0,20})/i)
      || labelText.match(/\b(?:OM-\d+(?:\s+Mark\s+[IVX]+)?|PEN[^|]{0,20})/i)
      || [])[0] || "";
  } else if (brand === "Leica") {
    model = (titleText.match(/\b(?:M|SL|Q|S)\d+[A-Za-z-]*/i)
      || labelText.match(/\b(?:M|SL|Q|S)\d+[A-Za-z-]*/i)
      || [])[0] || "";
  } else if (brand === "Sigma") {
    model = titleText.replace(/^CONTEMPORARY\s*/i, "").replace(/\s*\|.*$/, "").trim();
  } else if (brand === "Tamron") {
    model = (titleText || labelText)
      .replace(/\s*\|\s*(?:Lenses?|Specifications?|TAMRON).*$/i, "")
      .replace(/^.*?(?=\d+(?:-\d+)?mm)/i, "")
      .trim();
  } else if (brand === "Ricoh" || brand === "Pentax") {
    model = (titleText.match(/\b(?:RICOH\s+)?(?:GR\s+[IVX]+|PENTAX\s+[A-Z0-9-]+)/i)
      || labelText.match(/\b(?:RICOH\s+)?(?:GR\s+[IVX]+|PENTAX\s+[A-Z0-9-]+)/i)
      || [])[0] || "";
  }
  return clean(model || labelText || titleText).slice(0, 120);
}

const specAliases = [
  ["sensor", "传感器", /(?:传感器|感光元件|影像传感器|sensor type|image sensor)/i],
  ["resolution", "有效像素", /(?:有效像素|像素数|resolution|megapixel|effective pixels)/i],
  ["mount", "镜头卡口", /(?:镜头卡口|卡口|lens mount|mount)/i],
  ["autofocus", "对焦系统", /(?:自动对焦|对焦系统|autofocus|af system)/i],
  ["stabilization", "防抖", /(?:防抖|减震|stabilis|stabiliz)/i],
  ["video", "视频", /(?:视频|短片|movie|video)/i],
  ["burst", "连拍", /(?:连拍|burst|continuous shooting)/i],
  ["iso", "感光度", /(?:感光度|iso)/i],
  ["weight", "重量", /(?:重量|weight)/i],
  ["weather", "防护", /(?:防护|防尘|防滴|weather)/i],
  ["viewfinder", "取景器", /(?:取景器|viewfinder)/i],
  ["screen", "显示屏", /(?:显示屏|显示器|screen|monitor)/i],
  ["focal_length", "焦距", /(?:焦距|focal length)/i],
  ["aperture", "最大光圈", /(?:最大光圈|光圈|maximum aperture|minimum aperture|aperture)/i],
  ["filter_size", "滤镜口径", /(?:滤镜口径|滤镜尺寸|filter (?:size|diameter))/i],
  ["minimum_focus", "最近对焦", /(?:最近对焦|最近拍摄距离|minimum focusing|minimum focus)/i],
];

function normalizeSpecs(pairs) {
  const output = new Map();
  for (const [rawLabel, rawValue] of pairs) {
    const label = cleanText(rawLabel).replace(/[：:]$/, "").slice(0, 80);
    const value = cleanText(rawValue).slice(0, 1000);
    if (!label || !value || label.length > 80 || /^\d+$/.test(label)) continue;
    const parts = label.split(/\s*\/\s*/);
    const leafLabel = parts.at(-1);
    let match = specAliases.find(([, , pattern]) => pattern.test(leafLabel));
    if (!match && /^(?:类型|格式|尺寸)$/i.test(leafLabel)) {
      match = specAliases.find(([, , pattern]) => pattern.test(label));
    }
    const key = match?.[0] || `detail_${crypto.createHash("sha1").update(label).digest("hex").slice(0, 8)}`;
    if (output.has(key)) continue;
    output.set(key, {
      key,
      label: match?.[1] || label,
      value,
      unit: "",
    });
  }
  return [...output.values()]
    .sort((left, right) => (
      Number(left.key.startsWith("detail_")) - Number(right.key.startsWith("detail_"))
    ))
    .slice(0, 18);
}

function schemaPropertyPairs(value, output, depth = 0) {
  if (depth > 8 || value == null || output.length >= 40) return;
  if (Array.isArray(value)) {
    for (const item of value) schemaPropertyPairs(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const properties = Array.isArray(value.additionalProperty)
    ? value.additionalProperty
    : value.additionalProperty
      ? [value.additionalProperty]
      : [];
  for (const property of properties) {
    const label = cleanText(property?.name || property?.propertyID);
    const rawValue = property?.value ?? property?.description;
    const propertyValue = typeof rawValue === "object"
      ? cleanText(rawValue?.name || rawValue?.value)
      : cleanText(rawValue);
    if (label && propertyValue) output.push([label, propertyValue]);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "offers" || key === "image" || key === "additionalProperty") continue;
    if (child && typeof child === "object") schemaPropertyPairs(child, output, depth + 1);
  }
}

function candidateConfidence(specs, fullText) {
  const knownSpecs = specs.filter((spec) => spec.key && !spec.key.startsWith("detail_"));
  if (knownSpecs.length >= 3) return "high";
  if (knownSpecs.length > 0 || referenceSpecCount(fullText) > 0) return "medium";
  return "low";
}

function candidateContentHash(candidate) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      model: candidate.model,
      title: candidate.title,
      description: candidate.description,
      priceAmount: candidate.price?.amount || 0,
      priceCurrency: candidate.price?.currency || "",
      specs: candidate.specs,
    }))
    .digest("hex");
}

function mergeCandidateDetails(primary, detail) {
  const specs = normalizeSpecs([
    ...primary.specs.map((spec) => [spec.label, spec.value]),
    ...detail.specs.map((spec) => [spec.label, spec.value]),
  ]);
  const fullText = [
    primary.title,
    primary.description,
    detail.title,
    detail.description,
    ...specs.map((spec) => `${spec.label} ${spec.value}`),
  ].join(" ");
  const merged = {
    ...primary,
    title: primary.title || detail.title,
    description: primary.description || detail.description,
    priceCny: primary.priceCny || detail.priceCny,
    price: primary.price || detail.price,
    mount: primary.mount || detail.mount,
    sensorFormat: primary.sensorFormat || detail.sensorFormat,
    specs,
    specSourceUrl: detail.sourceUrl,
  };
  merged.summary = merged.description.slice(0, 300) || `${merged.brand} ${merged.model} 官方产品页采集候选。`;
  merged.confidence = candidateConfidence(specs, fullText);
  merged.contentHash = candidateContentHash(merged);
  return merged;
}

export function findSpecificationUrl(html, finalUrl, source) {
  const $ = load(html);
  const allowedOrigins = allowedProductOrigins(source, finalUrl);
  let found = "";
  $("a[href]").each((_, element) => {
    if (found) return false;
    const label = cleanText($(element).text());
    const href = $(element).attr("href");
    if (!href || !/(?:\b(?:specifications?|specs?)\b|规格|参数|技术规格)/i.test(label)) return;
    const normalized = normalizeProductUrl(href, finalUrl);
    try {
      const url = new URL(normalized);
      if (allowedOrigins.has(url.origin) && !/\.(?:pdf|zip)$/i.test(url.pathname)) found = normalized;
    } catch {
      // Ignore invalid specification links.
    }
  });
  return found;
}

export function extractProductDetail(html, finalUrl, source, linkLabel) {
  const $ = load(html);
  const schemaProducts = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      collectProductObjects(JSON.parse($(element).text()), schemaProducts);
    } catch {
      // Ignore malformed publisher JSON.
    }
  });
  const schema = schemaProducts[0] || {};
  const schemaOffers = Array.isArray(schema.offers)
    ? schema.offers
    : schema.offers
      ? [schema.offers]
      : [];
  const offer = schemaOffers.find((item) => item?.price || item?.lowPrice);
  const title = cleanText(
    schema.name
    || $('meta[property="og:title"]').attr("content")
    || $("h1").first().text()
    || $("title").text(),
  ).slice(0, 300);
  let description = cleanText(
    $('meta[name="description"]').attr("content")
    || $('meta[property="og:description"]').attr("content")
    || schema.description
    || "",
  ).slice(0, 1000);
  const model = inferModel(source.brand, title, finalUrl, linkLabel);
  const category = inferCategory(source.brand, title, finalUrl, linkLabel);
  const pairs = [];
  schemaPropertyPairs(schema, pairs);
  $("table tr").each((_, row) => {
    const cells = $(row).find("th,td").map((__, cell) => cleanText($(cell).text())).get();
    if (cells.length === 2) pairs.push(cells);
  });
  $("dl").each((_, dl) => {
    $(dl).find("dt").each((__, dt) => {
      const label = cleanText($(dt).text());
      const value = cleanText($(dt).next("dd").text());
      if (label && value) pairs.push([label, value]);
    });
  });
  $("li.left").each((_, element) => {
    const label = cleanText($(element).text());
    const value = cleanText($(element).next("li.right").text());
    if (label && value) pairs.push([label, value]);
  });
  $(".c-specList li").each((_, element) => {
    const row = $(element).children(".l-grid").first();
    if (!row.length) return;
    const label = cleanText(row.children("p").first().text());
    const value = cleanText(row.children("div").first().text());
    if (label && value) pairs.push([label, value]);
  });
  $(".camera-params-item").each((_, element) => {
    const item = $(element);
    const label = cleanText(item.children(".camera-params-lv1").first().text());
    const value = cleanText(item.children("ul").first().text());
    const section = cleanText(
      item.closest(".camera-params-paper").find(".camera-params-title").first().text(),
    );
    if (!label || !value) return;
    pairs.push([section && section !== label ? `${section} / ${label}` : label, value]);
  });
  $('[itemprop="additionalProperty"]').each((_, element) => {
    const item = $(element);
    const label = cleanText(
      item.find('[itemprop="name"]').first().text() || item.find("dt").first().text(),
    );
    const value = cleanText(
      item.find('[itemprop="value"]').first().text() || item.find("dd").first().text(),
    );
    if (label && value) pairs.push([label, value]);
  });
  const descriptionText = String(schema.description || "").replace(/\\n/g, "\n");
  for (const line of descriptionText.split("\n")) {
    const match = line.match(/^\s*([^:：]{2,60})[:：]\s*(.{2,500})$/);
    if (match) pairs.push([match[1], match[2]]);
  }
  const specs = normalizeSpecs(pairs);
  const fullText = `${title} ${description} ${specs.map((spec) => `${spec.label} ${spec.value}`).join(" ")}`;
  let sensorFormat = "";
  if (/中画幅|medium format/i.test(fullText)) sensorFormat = "中画幅";
  else if (/全画幅|full[- ]frame|35mm全画幅|35mm full/i.test(fullText)) sensorFormat = "全画幅";
  else if (/APS-C/i.test(fullText)) sensorFormat = "APS-C";
  else if (/M4\/3|Micro Four Thirds|微型四三|4\/3/i.test(fullText)) sensorFormat = "M4/3";
  let mount = specs.find((spec) => spec.key === "mount")?.value || "";
  if (!mount) {
    if (source.brand === "Canon") mount = "Canon RF";
    else if (source.brand === "Nikon") mount = "Nikon Z";
    else if (source.brand === "Sony") mount = "Sony E";
    else if (source.brand === "Fujifilm") mount = category === "camera" ? "Fujifilm X / GF" : "Fujifilm X";
    else if (source.brand === "Hasselblad") mount = "Hasselblad XCD";
  }
  const priceAmount = Number(offer?.price || offer?.lowPrice || 0);
  const priceCurrency = cleanText(offer?.priceCurrency || "");
  if (/SPECIFICATIONS/i.test(description)) {
    description = description.split(/SPECIFICATIONS/i)[0].replace(/^DESCRIPTION\s*/i, "").trim().slice(0, 600);
  }
  const confidence = candidateConfidence(specs, fullText);
  const candidate = {
    brand: source.brand,
    model,
    category,
    title,
    description,
    summary: description.slice(0, 300) || `${source.brand} ${model} 官方产品页采集候选。`,
    priceCny: priceCurrency === "CNY" ? priceAmount : null,
    price: priceAmount ? { amount: priceAmount, currency: priceCurrency } : null,
    mount,
    sensorFormat,
    specs,
    confidence,
    contentHash: "",
    sourceUrl: finalUrl,
    specSourceUrl: "",
  };
  candidate.contentHash = candidateContentHash(candidate);
  return candidate;
}

function referenceSpecCount(text) {
  return specAliases.reduce((count, [, , pattern]) => count + (pattern.test(text) ? 1 : 0), 0);
}

async function robotsAllows(sourceUrl, robotsUrl) {
  const configuredUrl = robotsUrl || new URL("/robots.txt", sourceUrl).toString();
  let cached = robotsCache.get(configuredUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  let result;
  try {
    const response = await safeFetch(configuredUrl, MAX_ROBOTS_BYTES);
    if (response.status === 401 || response.status === 403) {
      result = { allowed: false, reason: `robots.txt 返回 HTTP ${response.status}` };
    } else if (response.status >= 400) {
      result = { allowed: true, reason: `robots.txt 返回 HTTP ${response.status}，按未提供规则处理` };
    } else {
      const parser = robotsParser(configuredUrl, response.text);
      result = parser.isAllowed(sourceUrl, BOT_TOKEN)
        ? { allowed: true, reason: "" }
        : { allowed: false, reason: "robots.txt 不允许采集该路径" };
    }
  } catch (error) {
    result = {
      allowed: true,
      reason: `robots.txt 无法读取：${String(error.message).slice(0, 160)}`,
    };
  }
  robotsCache.set(configuredUrl, { result, expiresAt: Date.now() + 60 * 60 * 1000 });
  return result;
}

function insertRunItem(runId, source, status, details = {}) {
  return db.prepare(`
    INSERT INTO crawl_run_items (
      run_id, source_id, status, http_status, final_url, page_title, content_hash,
      previous_hash, bytes, links_found, product_candidates, review_id,
      error_message, product_results_json, duration_ms, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    source.id,
    status,
    details.httpStatus || null,
    details.finalUrl || null,
    details.pageTitle || null,
    details.contentHash || null,
    details.previousHash || null,
    details.bytes || 0,
    details.linksFound || 0,
    details.productCandidates || 0,
    details.reviewId || null,
    details.errorMessage || null,
    details.productResults ? JSON.stringify(details.productResults) : null,
    details.durationMs || 0,
    now(),
  );
}

function brandAccent(brand) {
  return {
    Canon: "coral",
    Nikon: "violet",
    Sony: "amber",
    Fujifilm: "forest",
    Panasonic: "ocean",
    Leica: "rose",
    Hasselblad: "graphite",
  }[brand] || "graphite";
}

function findMatchingGear(candidate) {
  const rows = db.prepare("SELECT id, brand, model FROM gear").all();
  const candidateBrandKey = brandComparisonKey(candidate.brand);
  const candidateModelKey = modelComparisonKey(candidate.model, candidate.brand);
  return rows.find((row) => {
    const existingKey = modelComparisonKey(row.model, row.brand);
    return candidateModelKey
      && candidateModelKey === existingKey
      && candidateBrandKey === brandComparisonKey(row.brand);
  }) || null;
}

function findMatchingCrawlProduct(candidate) {
  const rows = db.prepare(`
    SELECT id, brand, model, product_url, review_id, status
    FROM crawl_products
    WHERE status IN ('pending', 'approved')
  `).all();
  const candidateBrandKey = brandComparisonKey(candidate.brand);
  const candidateModelKey = modelComparisonKey(candidate.model, candidate.brand);
  return rows.find((row) => (
    candidateModelKey
    && candidateModelKey === modelComparisonKey(row.model, row.brand)
    && candidateBrandKey === brandComparisonKey(row.brand)
  )) || null;
}

function queueProductReview(source, candidate) {
  const existingProduct = db.prepare(`
    SELECT * FROM crawl_products WHERE product_url = ?
  `).get(candidate.sourceUrl);
  if (existingProduct) {
    db.prepare("UPDATE crawl_products SET last_seen_at = ? WHERE id = ?")
      .run(now(), existingProduct.id);
    if (
      existingProduct.content_hash === candidate.contentHash
      || existingProduct.status === "pending"
      || existingProduct.status === "approved"
    ) {
      return { created: false, reason: "unchanged-or-already-reviewed" };
    }
  }

  const matchingGear = findMatchingGear(candidate);
  if (matchingGear) {
    const changes = {};
    if (candidate.summary) changes.summary = candidate.summary;
    if (candidate.priceCny) changes.price_cny = candidate.priceCny;
    if (candidate.mount) changes.mount = candidate.mount;
    if (candidate.sensorFormat) changes.sensor_format = candidate.sensorFormat;
    for (const spec of candidate.specs) changes[spec.key] = spec.value;
    if (!Object.keys(changes).length) {
      return { created: false, reason: "existing-gear-no-new-fields" };
    }
    const result = db.prepare(`
      INSERT INTO review_queue (
        gear_id, source_id, record_type, title, source_url, proposed_json,
        current_json, confidence, status, fetched_at
      ) VALUES (?, ?, 'gear_update', ?, ?, ?, '{}', ?, 'pending', ?)
    `).run(
      matchingGear.id,
      source.id,
      `官方页面发现规格变化：${candidate.brand} ${candidate.model}`,
      candidate.sourceUrl,
      JSON.stringify({ changes }),
      candidate.confidence,
      now(),
    );
    if (existingProduct) {
      db.prepare(`
        UPDATE crawl_products
        SET content_hash = ?, review_id = ?, status = 'pending', last_seen_at = ?
        WHERE id = ?
      `).run(candidate.contentHash, result.lastInsertRowid, now(), existingProduct.id);
    } else {
      db.prepare(`
        INSERT INTO crawl_products (
          source_id, product_url, brand, model, category, content_hash, status,
          review_id, gear_id, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        source.id,
        candidate.sourceUrl,
        candidate.brand,
        candidate.model,
        candidate.category,
        candidate.contentHash,
        result.lastInsertRowid,
        matchingGear.id,
        now(),
        now(),
      );
    }
    return { created: true, reviewId: Number(result.lastInsertRowid) };
  }

  const duplicateProduct = findMatchingCrawlProduct(candidate);
  if (duplicateProduct) {
    db.prepare("UPDATE crawl_products SET last_seen_at = ? WHERE id = ?")
      .run(now(), duplicateProduct.id);
    return {
      created: false,
      reason: "duplicate-model",
      reviewId: duplicateProduct.review_id || null,
    };
  }

  const proposed = {
    gear: {
      brand: candidate.brand,
      model: candidate.model,
      category: candidate.category,
      summary: candidate.summary,
      priceCny: candidate.priceCny,
      price: candidate.price,
      mount: candidate.mount,
      sensorFormat: candidate.sensorFormat,
      bestFor: ["新品采集", "参数待核验"],
      accent: brandAccent(candidate.brand),
      sourceName: source.name,
      sourceUrl: candidate.sourceUrl,
      confidence: "unverified",
    },
    specs: candidate.specs,
    product: {
      title: candidate.title,
      description: candidate.description,
      contentHash: candidate.contentHash,
      specSourceUrl: candidate.specSourceUrl || "",
    },
  };
  const result = db.prepare(`
    INSERT INTO review_queue (
      gear_id, source_id, record_type, title, source_url, proposed_json,
      current_json, confidence, status, fetched_at
    ) VALUES (NULL, ?, 'gear_candidate', ?, ?, ?, '{}', ?, 'pending', ?)
  `).run(
    source.id,
    `发现待入库器材：${candidate.brand} ${candidate.model}`,
    candidate.sourceUrl,
    JSON.stringify(proposed),
    candidate.confidence,
    now(),
  );
  if (existingProduct) {
    db.prepare(`
      UPDATE crawl_products
      SET model = ?, category = ?, content_hash = ?, review_id = ?,
          status = 'pending', last_seen_at = ?
      WHERE id = ?
    `).run(
      candidate.model,
      candidate.category,
      candidate.contentHash,
      result.lastInsertRowid,
      now(),
      existingProduct.id,
    );
  } else {
    db.prepare(`
      INSERT INTO crawl_products (
        source_id, product_url, brand, model, category, content_hash, status,
        review_id, gear_id, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)
    `).run(
      source.id,
      candidate.sourceUrl,
      candidate.brand,
      candidate.model,
      candidate.category,
      candidate.contentHash,
      result.lastInsertRowid,
      now(),
      now(),
    );
  }
  return { created: true, reviewId: Number(result.lastInsertRowid) };
}

async function crawlProductLink(source, productLink) {
  const robots = await robotsAllows(productLink.url, source.robots_url);
  if (!robots.allowed) return { parsed: false, reviewCreated: false, error: robots.reason };
  let response = await safeFetch(productLink.url);
  if (response.status === 429 || response.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    response = await safeFetch(productLink.url);
  }
  if (response.status < 200 || response.status >= 300) {
    return { parsed: false, reviewCreated: false, error: `产品页 HTTP ${response.status}` };
  }
  let candidate = extractProductDetail(
    response.text,
    response.finalUrl,
    source,
    productLink.label,
  );
  if (!candidate.model || candidate.model.length < 2) {
    return { parsed: false, reviewCreated: false, error: "未识别到产品型号" };
  }
  if (
    !/\d/.test(candidate.model)
    || /(?:mount|卡口分类|系列|可换镜头|购买渠道|了解更多|首页|美图|导航|compare models|our lenses)/i
      .test(candidate.model)
    || /\/(?:sony_e|nikon_z|fujifilm_x|canon_rf)\/?$/i.test(productLink.url)
  ) {
    return { parsed: false, reviewCreated: false, error: "链接或标题不是具体产品页" };
  }
  if (candidate.specs.length < 3) {
    const specUrl = findSpecificationUrl(response.text, response.finalUrl, source);
    if (specUrl) {
      try {
        const specRobots = await robotsAllows(specUrl, source.robots_url);
        if (specRobots.allowed) {
          const specResponse = await safeFetch(specUrl);
          if (specResponse.status >= 200 && specResponse.status < 300) {
            const detail = extractProductDetail(
              specResponse.text,
              specResponse.finalUrl,
              source,
              productLink.label,
            );
            candidate = mergeCandidateDetails(candidate, detail);
          }
        }
      } catch {
        // The primary product page remains useful when its spec page is unavailable.
      }
    }
  }
  const queued = queueProductReview(source, candidate);
  return {
    parsed: true,
    reviewCreated: queued.created,
    reviewId: queued.reviewId,
    reason: queued.reason || null,
    model: candidate.model,
    error: null,
  };
}

async function crawlSource(runId, source) {
  const started = Date.now();
  try {
    const robots = await robotsAllows(source.url, source.robots_url);
    if (!robots.allowed) throw new Error(robots.reason);
    const response = await safeFetch(source.url);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`目标页面返回 HTTP ${response.status}`);
    }
    if (!/html|xhtml|text\/plain|application\/json/i.test(response.contentType)) {
      throw new Error(`不支持的响应类型：${response.contentType || "unknown"}`);
    }
    const page = extractPage(response.text, response.finalUrl);
    const previous = db.prepare(`
      SELECT * FROM source_snapshots
      WHERE source_id = ?
      ORDER BY fetched_at DESC, id DESC
      LIMIT 1
    `).get(source.id);
    const changed = Boolean(previous && previous.content_hash !== page.contentHash);
    const baseline = !previous;
    let reviewId = null;

    db.prepare(`
      INSERT OR IGNORE INTO source_snapshots (
        source_id, content_hash, final_url, page_title, page_description,
        product_candidates_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.id,
      page.contentHash,
      response.finalUrl,
      page.title,
      page.description,
      JSON.stringify(page.products),
      now(),
    );

    if (changed) {
      const proposed = {
        snapshot: {
          pageTitle: page.title,
          description: page.description,
          contentHash: page.contentHash,
          products: page.products,
          headings: page.headings,
          capturedAt: now(),
        },
      };
      const current = {
        snapshot: {
          pageTitle: previous.page_title,
          description: previous.page_description,
          contentHash: previous.content_hash,
          products: JSON.parse(previous.product_candidates_json || "[]"),
          capturedAt: previous.fetched_at,
        },
      };
      reviewId = db.prepare(`
        INSERT INTO review_queue (
          gear_id, source_id, record_type, title, source_url, proposed_json,
          current_json, confidence, status, fetched_at
        ) VALUES (NULL, ?, 'source_snapshot', ?, ?, ?, ?, 'medium', 'pending', ?)
      `).run(
        source.id,
        `官方页面发生变化：${source.name}`,
        response.finalUrl,
        JSON.stringify(proposed),
        JSON.stringify(current),
        now(),
      ).lastInsertRowid;
    }

    let productLinks = discoverProductLinks(response.text, source, response.finalUrl);
    if (!productLinks.length) {
      const rule = brandRules[sourceBrandKey(source)];
      const discoveryUrls = discoverCatalogLinks(response.text, source, response.finalUrl);
      if (rule?.discoveryUrl) discoveryUrls.unshift({
        url: normalizeProductUrl(rule.discoveryUrl, response.finalUrl),
        label: "官方产品目录",
      });
      const seenDiscovery = new Set();
      for (const discovery of discoveryUrls.slice(0, MAX_CATALOG_PAGES + 1)) {
        if (!discovery.url || seenDiscovery.has(discovery.url)) continue;
        seenDiscovery.add(discovery.url);
        try {
          const discoveryRobots = await robotsAllows(discovery.url, source.robots_url);
          if (!discoveryRobots.allowed) continue;
          const discoveryResponse = await safeFetch(discovery.url);
          if (discoveryResponse.status < 200 || discoveryResponse.status >= 300) continue;
          const discovered = discoverProductLinks(
            discoveryResponse.text,
            source,
            discoveryResponse.finalUrl,
          );
          const known = new Set(productLinks.map((link) => link.url));
          productLinks.push(...discovered.filter((link) => !known.has(link.url)));
          productLinks = productLinks.slice(0, MAX_PRODUCT_LINKS);
          if (productLinks.length >= MAX_PRODUCT_LINKS) break;
        } catch (error) {
          console.warn(`Catalog discovery failed for ${source.name}: ${error.message}`);
        }
      }
    }
    if (
      !productLinks.length
      && ["fujifilm", "sigma", "ricoh", "pentax", "om-system"].includes(sourceBrandKey(source))
    ) {
      try {
        const rendered = await renderPageContent(response.finalUrl);
        productLinks = discoverProductLinks(rendered.html, source, rendered.finalUrl);
      } catch (error) {
        console.warn(`Rendered discovery failed for ${source.name}: ${error.message}`);
      }
    }
    const productResults = [];
    for (const productLink of productLinks) {
      try {
        productResults.push({
          ...(await crawlProductLink(source, productLink)),
          url: productLink.url,
        });
      } catch (error) {
        productResults.push({
          parsed: false,
          reviewCreated: false,
          url: productLink.url,
          error: String(error.message || error).slice(0, 240),
        });
      }
    }
    const productReviews = productResults.filter((result) => result.reviewCreated).length;

    const status = baseline ? "baseline" : changed ? "changed" : "unchanged";
    insertRunItem(runId, source, status, {
      httpStatus: response.status,
      finalUrl: response.finalUrl,
      pageTitle: page.title,
      contentHash: page.contentHash,
      previousHash: previous?.content_hash,
      bytes: Buffer.byteLength(response.text),
      linksFound: page.links.length,
      productCandidates: productLinks.length,
      reviewId,
      productResults,
      durationMs: Date.now() - started,
    });
    db.prepare(`
      UPDATE crawl_sources
      SET status = 'healthy', last_synced_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now(), now(), source.id);
    return {
      status,
      changed,
      baseline,
      reviewCount: productReviews + (reviewId ? 1 : 0),
      warning: robots.reason,
      productResults,
    };
  } catch (error) {
    const message = String(error.message || error).slice(0, 500);
    insertRunItem(runId, source, "failed", {
      errorMessage: message,
      durationMs: Date.now() - started,
    });
    db.prepare(`
      UPDATE crawl_sources SET status = 'error', updated_at = ? WHERE id = ?
    `).run(now(), source.id);
    return { status: "failed", error: message };
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) return;
    results[index] = await worker(items[index], index);
    await next();
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => next()),
  );
  return results;
}

async function executeRun(runId) {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  db.prepare(`
    UPDATE crawl_runs SET status = 'running', started_at = ? WHERE id = ?
  `).run(now(), runId);
  try {
    const run = db.prepare("SELECT * FROM crawl_runs WHERE id = ?").get(runId);
    const sourceIds = JSON.parse(run.error_summary || "[]");
    const placeholders = sourceIds.map(() => "?").join(",");
    const sources = sourceIds.length
      ? db.prepare(`
          SELECT * FROM crawl_sources
          WHERE id IN (${placeholders}) AND enabled = 1
          ORDER BY id
        `).all(...sourceIds)
      : db.prepare(`
          SELECT * FROM crawl_sources WHERE enabled = 1 ORDER BY id
        `).all();
    db.prepare(`
      UPDATE crawl_runs SET source_count = ?, error_summary = NULL WHERE id = ?
    `).run(sources.length, runId);
    const results = await mapWithConcurrency(sources, SOURCE_CONCURRENCY, (source) => (
      crawlSource(runId, source)
    ));
    const counts = results.reduce((acc, result) => {
      if (result.status === "failed") acc.failure += 1;
      else acc.success += 1;
      if (result.status === "baseline") acc.baseline += 1;
      if (result.status === "changed") acc.changed += 1;
      if (result.status === "unchanged") acc.unchanged += 1;
      if (result.reviewCount) acc.reviews += result.reviewCount;
      return acc;
    }, { success: 0, baseline: 0, changed: 0, unchanged: 0, failure: 0, reviews: 0 });
    const status = counts.success === 0 ? "failed" : counts.failure > 0 ? "partial" : "completed";
    db.prepare(`
      UPDATE crawl_runs SET
        status = ?, success_count = ?, baseline_count = ?, unchanged_count = ?,
        changed_count = ?, failure_count = ?, review_count = ?, finished_at = ?
      WHERE id = ?
    `).run(
      status,
      counts.success,
      counts.baseline,
      counts.unchanged,
      counts.changed,
      counts.failure,
      counts.reviews,
      now(),
      runId,
    );
    recordAudit({
      actor: run.requested_by,
      action: "crawl.completed",
      entityType: "crawl_run",
      entityId: runId,
      after: { status, sources: sources.length, ...counts },
    });
  } catch (error) {
    db.prepare(`
      UPDATE crawl_runs SET status = 'failed', error_summary = ?, finished_at = ? WHERE id = ?
    `).run(String(error.message || error).slice(0, 1000), now(), runId);
  } finally {
    await closeBrowser();
    activeRuns.delete(runId);
  }
}

export function recoverInterruptedCrawlRuns() {
  db.prepare(`
    UPDATE crawl_runs
    SET status = 'failed',
        error_summary = '服务重启时采集中断',
        finished_at = ?
    WHERE status IN ('queued', 'running')
  `).run(now());
}

export function createCrawlRun({ sourceIds = [], requestedBy }) {
  const active = db.prepare(`
    SELECT id FROM crawl_runs WHERE status IN ('queued', 'running') LIMIT 1
  `).get();
  if (active) {
    const error = new Error(`已有采集任务正在运行（#${active.id}）`);
    error.status = 409;
    throw error;
  }
  const ids = [...new Set(
    sourceIds.map(Number).filter((id) => Number.isInteger(id) && id > 0),
  )].slice(0, 30);
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const available = db.prepare(`
      SELECT id FROM crawl_sources WHERE id IN (${placeholders}) AND enabled = 1
    `).all(...ids);
    if (available.length !== ids.length) {
      const error = new Error("包含不存在或已暂停的采集来源");
      error.status = 400;
      throw error;
    }
  }
  const result = db.prepare(`
    INSERT INTO crawl_runs (
      status, trigger_type, requested_by, source_count, error_summary, created_at
    ) VALUES ('queued', 'manual', ?, ?, ?, ?)
  `).run(requestedBy, ids.length, JSON.stringify(ids), now());
  const runId = Number(result.lastInsertRowid);
  setImmediate(() => executeRun(runId));
  return getCrawlRun(runId);
}

function serializeRunItem(row) {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    status: row.status,
    httpStatus: row.http_status,
    finalUrl: row.final_url,
    pageTitle: row.page_title,
    contentHash: row.content_hash,
    previousHash: row.previous_hash,
    bytes: row.bytes,
    linksFound: row.links_found,
    productCandidates: row.product_candidates,
    productResults: row.product_results_json
      ? JSON.parse(row.product_results_json)
      : [],
    reviewId: row.review_id,
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
    fetchedAt: row.fetched_at,
  };
}

export function getCrawlRun(runId) {
  const row = db.prepare("SELECT * FROM crawl_runs WHERE id = ?").get(runId);
  if (!row) return null;
  const items = db.prepare(`
    SELECT i.*, s.name AS source_name
    FROM crawl_run_items i
    JOIN crawl_sources s ON s.id = i.source_id
    WHERE i.run_id = ?
    ORDER BY i.id
  `).all(runId);
  return {
    id: row.id,
    status: row.status,
    triggerType: row.trigger_type,
    requestedBy: row.requested_by,
    sourceCount: row.source_count,
    successCount: row.success_count,
    baselineCount: row.baseline_count,
    unchangedCount: row.unchanged_count,
    changedCount: row.changed_count,
    failureCount: row.failure_count,
    reviewCount: row.review_count,
    errorSummary: row.error_summary,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    items: items.map(serializeRunItem),
  };
}

export function listCrawlRuns(limit = 8) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 8));
  return db.prepare(`
    SELECT * FROM crawl_runs ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(safeLimit).map((row) => getCrawlRun(row.id));
}

recoverInterruptedCrawlRuns();
