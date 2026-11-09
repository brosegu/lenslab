import { db } from "./db.js";
import { createCrawlRun, getCrawlRun } from "./crawler.js";

const requestedSources = process.argv
  .filter((value) => /^\d+$/.test(value))
  .map(Number);
const sourceIds = requestedSources.length
  ? requestedSources
  : db.prepare("SELECT id FROM crawl_sources WHERE enabled = 1 ORDER BY id")
    .all()
    .map((row) => row.id);

if (!sourceIds.length) {
  console.error("没有可采集的已启用来源");
  process.exit(1);
}

let run = createCrawlRun({ sourceIds, requestedBy: "manual-cli" });
console.log(`crawl run #${run.id} queued with ${sourceIds.length} sources`);

while (["queued", "running"].includes(run.status)) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  run = getCrawlRun(run.id);
  console.log(`crawl run #${run.id}: ${run.status}`);
}

console.log(JSON.stringify({
  id: run.id,
  status: run.status,
  sources: run.sourceCount,
  success: run.successCount,
  baseline: run.baselineCount,
  unchanged: run.unchangedCount,
  changed: run.changedCount,
  failed: run.failureCount,
  reviews: run.reviewCount,
  items: run.items.map((item) => ({
    source: item.sourceName,
    status: item.status,
    httpStatus: item.httpStatus,
    error: item.errorMessage,
  })),
}, null, 2));
