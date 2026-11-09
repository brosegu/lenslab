import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = mkdtempSync(path.join(tmpdir(), "lenslab-crawler-test-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.DATA_DIR = tempDir;
process.env.ADMIN_INITIAL_PASSWORD = `${crypto.randomBytes(24).toString("base64url")}A1`;

const crawler = await import("../server/crawler.js");
const quality = await import("../server/candidate-quality.js");
const { db } = await import("../server/db.js");

test.after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function source(brand, url, parserKey) {
  return { brand, url, parser_key: parserKey };
}

test("catalog discovery follows only official brand domains and exceeds three products", () => {
  const fujifilm = source(
    "Fujifilm",
    "https://www.fujifilm.com.cn/cn/zh-hans/consumer/digitalcameras/X",
    "fujifilm-cn-x",
  );
  const html = `
    <a href="https://fujifilm-x.com/zh-cn/products/cameras/x-s20/">X-S20</a>
    <a href="http://www.fujifilm-x.com/zh-cn/products/cameras/x-t5/">X-T5</a>
    <a href="https://fujifilm-x.com/zh-cn/products/cameras/x-h2/">X-H2</a>
    <a href="https://fujifilm-x.com/zh-cn/products/cameras/x-h2s/">X-H2S</a>
    <a href="https://fujifilm-x.com/zh-cn/products/cameras/x-t50/">X-T50</a>
    <a href="https://example.com/products/cameras/fake/">Fake</a>
  `;
  const links = crawler.discoverProductLinks(html, fujifilm, fujifilm.url);
  assert.equal(links.length, 5);
  assert.ok(links.every((link) => link.url.startsWith("https://fujifilm-x.com/")));
  assert.ok(!links.some((link) => link.url.includes("example.com")));

  const canon = source("Canon", "https://www.canon.com.cn/special/eosr/", "canon-cn-eosr");
  const canonHtml = `
    <a href="/special/eosr/r8m2.html">EOS R8 Mark II</a>
    <a href="/special/eosr/index.html">Home</a>
    <a href="/special/eosr/gallery.html">Gallery</a>
  `;
  assert.deepEqual(
    crawler.discoverProductLinks(canonHtml, canon, canon.url).map((link) => link.url),
    ["https://www.canon.com.cn/special/eosr/r8m2.html"],
  );
});

test("Tamron and OM System directories expose concrete product pages", () => {
  const tamron = source("Tamron", "https://www.tamron.com/", "tamron-official");
  const catalogHtml = `
    <a href="/global/consumer/lenses/sony_e/">Sony E</a>
    <a href="/global/consumer/lenses/nikon_z/">Nikon Z</a>
  `;
  assert.deepEqual(
    crawler.discoverCatalogLinks(catalogHtml, tamron, tamron.url)
      .map((link) => link.url),
    [
      "https://www.tamron.com/global/consumer/lenses/sony_e/",
      "https://www.tamron.com/global/consumer/lenses/nikon_z/",
    ],
  );
  const productHtml = `
    <a href="/global/consumer/lenses/a084/">12-20mm F2.8</a>
    <a href="/global/consumer/lenses/sony_e/">Sony E mount</a>
  `;
  assert.deepEqual(
    crawler.discoverProductLinks(
      productHtml,
      tamron,
      "https://www.tamron.com/global/consumer/lenses/sony_e/",
    ).map((link) => link.url),
    ["https://www.tamron.com/global/consumer/lenses/a084/"],
  );

  const omSystem = source(
    "OM System",
    "https://om-digitalsolutions.cn/",
    "om-system-cn-home",
  );
  const omHtml = `
    <a href="/product/dslr/om1mk2/index.html">OM-1 Mark II</a>
    <a href="/product/dslr/index.html">All cameras</a>
  `;
  assert.deepEqual(
    crawler.discoverProductLinks(
      omHtml,
      omSystem,
      "https://om-digitalsolutions.cn/product/dslr/index.html",
    ).map((link) => link.url),
    ["https://om-digitalsolutions.cn/product/dslr/om1mk2/index.html"],
  );
});

test("structured product page variants extract useful specs", () => {
  const sigma = source("Sigma", "https://www.sigma-global.com/", "sigma-official");
  const sigmaHtml = `
    <script type="application/ld+json">
      {
        "@type": "Product",
        "name": "50mm F1.4 DG DN",
        "description": "A full-frame prime lens.",
        "offers": { "price": "899", "priceCurrency": "USD" },
        "additionalProperty": [
          { "name": "Focal Length", "value": "50mm" },
          { "name": "Maximum Aperture", "value": "F1.4" }
        ]
      }
    </script>
    <ul class="c-specList">
      <li><div class="l-grid"><p>Corresponding Mount</p><div>Sony E-mount</div></div></li>
      <li><div class="l-grid"><p>Filter Size</p><div>φ67mm</div></div></li>
      <li><div class="l-grid"><p>Weight</p><div>660g</div></div></li>
    </ul>
  `;
  const sigmaResult = crawler.extractProductDetail(
    sigmaHtml,
    "https://www.sigma-global.com/en/lenses/a023_50_14/",
    sigma,
    "50mm F1.4 DG DN",
  );
  assert.equal(sigmaResult.model, "50mm F1.4 DG DN");
  assert.equal(sigmaResult.confidence, "high");
  assert.ok(["focal_length", "mount", "filter_size", "weight"].every(
    (key) => sigmaResult.specs.some((spec) => spec.key === key),
  ));
  assert.equal(sigmaResult.price.amount, 899);

  const panasonic = source(
    "Panasonic",
    "https://consumer.panasonic.cn/",
    "panasonic-cn-lumix-s",
  );
  const panasonicHtml = `
    <h1>全画幅无反相机 DC-S5M2K</h1>
    <div>
      <div class="camera-params-paper">
        <div class="camera-params-title"><h3>尺寸和重量</h3></div>
        <div class="camera-params-item">
          <div class="camera-params-lv1">高度</div><ul><li>102.3mm</li></ul>
        </div>
        <div class="camera-params-item">
          <div class="camera-params-lv1">重量</div><ul><li>740g</li></ul>
        </div>
      </div>
      <div class="camera-params-paper">
        <div class="camera-params-title"><h3>图像传感器</h3></div>
        <div class="camera-params-item">
          <div class="camera-params-lv1">类型</div><ul><li>35 毫米全画幅 CMOS传感器</li></ul>
        </div>
        <div class="camera-params-item">
          <div class="camera-params-lv1">相机有效像素数 / 总像素数</div><ul><li>2420 万像素</li></ul>
        </div>
      </div>
      <div class="camera-params-paper">
        <div class="camera-params-title"><h3>类型</h3></div>
        <div class="camera-params-item">
          <div class="camera-params-lv1">镜头卡口</div><ul><li>L卡口</li></ul>
        </div>
      </div>
    </div>
  `;
  const panasonicResult = crawler.extractProductDetail(
    panasonicHtml,
    "https://consumer.panasonic.cn/product/cameras-camcorders/lumix-series/lumix-s-series/dc-s5m2kgk.html",
    panasonic,
    "DC-S5M2K",
  );
  assert.equal(panasonicResult.model, "DC-S5M2K");
  assert.equal(panasonicResult.sensorFormat, "全画幅");
  assert.equal(
    panasonicResult.specs.find((spec) => spec.key === "weight").value,
    "740g",
  );
  assert.ok(panasonicResult.specs.some((spec) => spec.key === "resolution"));
});

test("spec links and Panasonic kit models are normalized", () => {
  const fujifilm = source(
    "Fujifilm",
    "https://www.fujifilm.com.cn/cn/zh-hans/consumer/digitalcameras/X",
    "fujifilm-cn-x",
  );
  const html = `
    <a href="/global/consumer/sp/">Special Contents</a>
    <a href="http://www.fujifilm-x.com/zh-cn/products/cameras/x-s20/specifications/">
      Specifications
    </a>
  `;
  assert.equal(
    crawler.findSpecificationUrl(
      html,
      "https://fujifilm-x.com/zh-cn/products/cameras/x-s20/",
      fujifilm,
    ),
    "https://fujifilm-x.com/zh-cn/products/cameras/x-s20/specifications/",
  );
  assert.equal(
    quality.modelComparisonKey("DC-S5M2K", "Panasonic"),
    quality.modelComparisonKey("DC-S5M2C", "Panasonic"),
  );
  assert.equal(
    quality.modelComparisonKey("DC-G9M2L", "Panasonic"),
    quality.modelComparisonKey("DC-G9M2", "Panasonic"),
  );
  assert.notEqual(
    quality.modelComparisonKey("DC-S5M2", "Panasonic"),
    quality.modelComparisonKey("DC-S5M2X", "Panasonic"),
  );
});

test("low-confidence review quality reports missing fields and duplicates", () => {
  const assessment = quality.assessCandidate({
    gear: {
      brand: "Canon",
      model: "EOS R8 Mark II",
      category: "camera",
      mount: "Canon RF",
      sensorFormat: "全画幅",
    },
    specs: [],
  }, { duplicateReviewIds: [4, 19] });
  assert.equal(assessment.specCount, 0);
  assert.ok(assessment.warnings.some((warning) => warning.includes("没有提取到结构化规格")));
  assert.ok(assessment.warnings.some((warning) => warning.includes("#4、#19")));
});
