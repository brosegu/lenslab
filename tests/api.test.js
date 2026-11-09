import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const root = path.resolve(".");
const port = 3317;
const baseUrl = `http://127.0.0.1:${port}`;
const initialAdminPassword = `${crypto.randomBytes(24).toString("base64url")}A1`;
const changedAdminPassword = `${crypto.randomBytes(24).toString("base64url")}B2`;

function storeCookies(response, jar) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    for (const cookie of value.split(/,(?=[^;,]+=)/)) {
      const pair = cookie.split(";")[0].trim();
      const separator = pair.indexOf("=");
      if (separator > 0) {
        jar.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not start");
}

test("critical public and admin workflows", { timeout: 30_000 }, async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "lenslab-test-"));
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, "test.db"),
      NODE_ENV: "development",
      ADMIN_USERNAME: "brose",
      ADMIN_INITIAL_PASSWORD: initialAdminPassword,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer();
    const jar = new Map();

    const gearResponse = await fetch(`${baseUrl}/api/gear`);
    const gearData = await gearResponse.json();
    assert.equal(gearResponse.status, 200);
    assert.ok(gearData.items.length >= 8);

    const scenesResponse = await fetch(`${baseUrl}/api/scenes`);
    const scenesData = await scenesResponse.json();
    assert.equal(scenesResponse.status, 200);
    assert.ok(scenesData.items.length >= 8);
    assert.ok(scenesData.items.every((scene) => scene.image.url.startsWith("/images/scenes/")));

    const advisorResponse = await fetch(`${baseUrl}/api/advisor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gearId: gearData.items[0].id,
        sceneId: 1,
        light: "soft",
        motion: "medium",
        experience: "new",
      }),
    });
    const advisorData = await advisorResponse.json();
    assert.equal(advisorResponse.status, 200);
    assert.equal(advisorData.recommendation.parameters.length, 4);

    const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`);
    storeCookies(csrfResponse, jar);
    const { csrfToken } = await csrfResponse.json();

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({ username: "brose", password: initialAdminPassword }),
    });
    storeCookies(loginResponse, jar);
    const loginData = await loginResponse.json();
    assert.equal(loginResponse.status, 200);
    assert.equal(loginData.user.mustChangePassword, true);

    const blockedStats = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: { Cookie: cookieHeader(jar) },
    });
    const blockedData = await blockedStats.json();
    assert.equal(blockedStats.status, 403);
    assert.equal(blockedData.code, "PASSWORD_CHANGE_REQUIRED");

    const passwordResponse = await fetch(`${baseUrl}/api/admin/password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": loginData.csrfToken,
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        currentPassword: initialAdminPassword,
        newPassword: changedAdminPassword,
      }),
    });
    storeCookies(passwordResponse, jar);
    const passwordData = await passwordResponse.json();
    assert.equal(passwordResponse.status, 200);
    assert.equal(passwordData.user.mustChangePassword, false);

    const statsResponse = await fetch(`${baseUrl}/api/admin/stats`, {
      headers: { Cookie: cookieHeader(jar) },
    });
    const statsData = await statsResponse.json();
    assert.equal(statsResponse.status, 200);
    assert.equal(statsData.counts.pendingReviews, 3);

    const sourcesResponse = await fetch(`${baseUrl}/api/admin/sources`, {
      headers: { Cookie: cookieHeader(jar) },
    });
    const sourcesData = await sourcesResponse.json();
    assert.equal(sourcesResponse.status, 200);
    assert.ok(sourcesData.items.length >= 25);
    assert.ok(sourcesData.items.some((source) => source.brand === "Sony"));
    assert.ok(sourcesData.items.some((source) => source.brand === "Hasselblad"));

    const sourceUpdateResponse = await fetch(
      `${baseUrl}/api/admin/sources/${sourcesData.items[0].id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": passwordData.csrfToken,
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({ enabled: false, cadence: "手动" }),
      },
    );
    const sourceUpdateData = await sourceUpdateResponse.json();
    assert.equal(sourceUpdateResponse.status, 200);
    assert.equal(sourceUpdateData.item.enabled, false);
    assert.equal(sourceUpdateData.item.status, "paused");

    const adminScenesResponse = await fetch(`${baseUrl}/api/admin/scenes`, {
      headers: { Cookie: cookieHeader(jar) },
    });
    const adminScenesData = await adminScenesResponse.json();
    const sceneUpdateResponse = await fetch(
      `${baseUrl}/api/admin/scenes/${adminScenesData.items[0].id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": passwordData.csrfToken,
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({
          imageAlt: "后台更新后的场景图片说明",
          imageCredit: "Unsplash",
        }),
      },
    );
    const sceneUpdateData = await sceneUpdateResponse.json();
    assert.equal(sceneUpdateResponse.status, 200);
    assert.equal(sceneUpdateData.item.image.alt, "后台更新后的场景图片说明");

    const testDb = new Database(path.join(tempDir, "test.db"));
    const sourceId = testDb.prepare("SELECT id FROM crawl_sources LIMIT 1").get().id;
    const candidateId = Number(testDb.prepare(`
      INSERT INTO review_queue (
        gear_id, source_id, record_type, title, source_url, proposed_json,
        current_json, confidence, status, fetched_at
      ) VALUES (NULL, ?, 'gear_candidate', ?, ?, ?, '{}', 'high', 'pending', ?)
    `).run(
      sourceId,
      "发现待入库器材：Test Camera X1",
      "https://example.com/test-camera-x1",
      JSON.stringify({
        gear: {
          brand: "TestBrand",
          model: "X1",
          category: "camera",
          summary: "测试采集候选",
          mount: "Test Mount",
          sensorFormat: "APS-C",
          bestFor: ["测试"],
          accent: "graphite",
          sourceName: "Test Source",
          sourceUrl: "https://example.com/test-camera-x1",
        },
        specs: [
          { key: "sensor", label: "传感器", value: "2600 万像素 CMOS", unit: "" },
        ],
      }),
      new Date().toISOString(),
    ).lastInsertRowid);
    const duplicateCandidateId = Number(testDb.prepare(`
      INSERT INTO review_queue (
        gear_id, source_id, record_type, title, source_url, proposed_json,
        current_json, confidence, status, fetched_at
      ) VALUES (NULL, ?, 'gear_candidate', ?, ?, ?, '{}', 'low', 'pending', ?)
    `).run(
      sourceId,
      "发现待入库器材：Test Camera X1（另一来源）",
      "https://example.com/another-test-camera-x1",
      JSON.stringify({
        gear: {
          brand: "TestBrand",
          model: "X1",
          category: "camera",
          summary: "另一来源的同型号候选",
          sourceName: "Test Source",
          sourceUrl: "https://example.com/another-test-camera-x1",
        },
        specs: [],
      }),
      new Date().toISOString(),
    ).lastInsertRowid);
    testDb.close();

    const pendingReviewsResponse = await fetch(`${baseUrl}/api/admin/reviews?status=pending`, {
      headers: { Cookie: cookieHeader(jar) },
    });
    const pendingReviewsData = await pendingReviewsResponse.json();
    assert.equal(pendingReviewsResponse.status, 200);
    const candidateReview = pendingReviewsData.items.find((item) => item.id === candidateId);
    assert.ok(candidateReview.quality.duplicateReviewIds.includes(duplicateCandidateId));

    const candidateApproveResponse = await fetch(
      `${baseUrl}/api/admin/reviews/${candidateId}/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": passwordData.csrfToken,
          Cookie: cookieHeader(jar),
        },
        body: "{}",
      },
    );
    const candidateApproveData = await candidateApproveResponse.json();
    assert.equal(candidateApproveResponse.status, 200);
    assert.equal(candidateApproveData.item.brand, "TestBrand");
    assert.equal(candidateApproveData.item.specs.length, 1);

    const duplicateApproveResponse = await fetch(
      `${baseUrl}/api/admin/reviews/${duplicateCandidateId}/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": passwordData.csrfToken,
          Cookie: cookieHeader(jar),
        },
        body: "{}",
      },
    );
    assert.equal(duplicateApproveResponse.status, 409);

    const missingCsrf = await fetch(`${baseUrl}/api/admin/reviews/1/reject`, {
      method: "POST",
      headers: { Cookie: cookieHeader(jar), "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(missingCsrf.status, 403);

    const approveResponse = await fetch(`${baseUrl}/api/admin/reviews/1/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": passwordData.csrfToken,
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        proposed: {
          changes: {
            video: "4K 60p 10-bit 4:2:2（人工订正）",
            stabilization: "5 轴机身防抖，最高 7 档",
          },
        },
      }),
    });
    const approveData = await approveResponse.json();
    assert.equal(approveResponse.status, 200);
    assert.equal(
      approveData.item.specs.find((spec) => spec.spec_key === "video").value,
      "4K 60p 10-bit 4:2:2（人工订正）",
    );

    const auditResponse = await fetch(`${baseUrl}/api/admin/audit`, {
      headers: { Cookie: cookieHeader(jar) },
    });
    const auditData = await auditResponse.json();
    assert.ok(auditData.items.some((item) => item.action === "review.approved"));
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(tempDir, { recursive: true, force: true });
    if (stderr) process.stderr.write(stderr);
  }
});
