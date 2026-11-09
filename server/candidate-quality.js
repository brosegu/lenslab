const brandAliases = {
  fujinon: "fujifilm",
};

const knownSpecKeys = new Set([
  "sensor",
  "resolution",
  "mount",
  "autofocus",
  "stabilization",
  "video",
  "burst",
  "iso",
  "weight",
  "weather",
  "viewfinder",
  "screen",
  "focal_length",
  "aperture",
  "filter_size",
  "minimum_focus",
]);

function compact(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/α/g, "a")
    .replace(/&/g, "and")
    .replace(/[^\p{Letter}\p{Number}]/gu, "");
}

export function brandComparisonKey(brand) {
  const key = compact(brand);
  return brandAliases[key] || key;
}

export function modelComparisonKey(model, brand = "") {
  let key = compact(model)
    .replace(/^(?:sony|canon|nikon|fujifilm|panasonic|lumix|hasselblad)/, "")
    .replace(/^eos/, "");
  if (brandComparisonKey(brand) === "panasonic") {
    key = key.replace(/^dc/, "");
    // Panasonic suffixes such as K/C/L/GK describe kits, colours or regional
    // SKUs rather than a different camera body. X remains significant because
    // models such as DC-S5M2X are distinct products.
    key = key.replace(/(?:gkk|gk|k|c|l|m|n|w)+$/, "");
  }
  return key;
}

export function candidateComparisonKey(gear = {}) {
  return `${brandComparisonKey(gear.brand)}:${modelComparisonKey(gear.model, gear.brand)}`;
}

export function assessCandidate(proposed = {}, { duplicateReviewIds = [] } = {}) {
  const gear = proposed.gear && typeof proposed.gear === "object" ? proposed.gear : {};
  const specs = Array.isArray(proposed.specs) ? proposed.specs : [];
  const knownSpecCount = specs.filter((spec) => knownSpecKeys.has(spec?.key)).length;
  const missingFields = [];
  const warnings = [];

  if (!String(gear.brand || "").trim()) missingFields.push("品牌");
  if (!String(gear.model || "").trim()) missingFields.push("型号");
  if (!String(gear.mount || "").trim()) missingFields.push("卡口");
  if (gear.category !== "lens" && !String(gear.sensorFormat || "").trim()) {
    missingFields.push("画幅 / 传感器格式");
  }

  if (!specs.length) {
    warnings.push("没有提取到结构化规格，请在原始页面核对后补充关键字段");
  } else if (knownSpecCount < 3) {
    warnings.push(`仅提取到 ${knownSpecCount} 项可用关键规格，建议对照规格页补全`);
  }
  if (missingFields.length) {
    warnings.push(`缺少：${missingFields.join("、")}`);
  }
  if (duplicateReviewIds.length) {
    warnings.push(`与待审候选 ${duplicateReviewIds.map((id) => `#${id}`).join("、")} 为同型号，可能重复`);
  }
  if (gear.category === "lens" && /(?:GK|KIT|套装|套机)/i.test(String(gear.model || ""))) {
    warnings.push("型号可能包含套装或颜色代码，请核对后再发布");
  }

  return {
    specCount: specs.length,
    knownSpecCount,
    missingFields,
    warnings,
    duplicateReviewIds,
  };
}
