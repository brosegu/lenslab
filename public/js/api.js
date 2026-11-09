let csrfToken = "";

export async function ensureCsrf() {
  if (csrfToken) return csrfToken;
  const response = await fetch("/api/auth/csrf", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("无法建立安全会话");
  const data = await response.json();
  csrfToken = data.csrfToken;
  return csrfToken;
}

export function setCsrf(token) {
  if (token) csrfToken = token;
}

export async function api(path, options = {}, retry = true) {
  const method = options.method || "GET";
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };
  if (method !== "GET" && method !== "HEAD") {
    headers["X-CSRF-Token"] = await ensureCsrf();
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });

  let data = null;
  const contentType = response.headers.get("content-type") || "";
  if (response.status !== 204 && contentType.includes("application/json")) {
    data = await response.json();
  }
  if (data?.csrfToken) setCsrf(data.csrfToken);

  if (response.status === 403 && retry && /安全令牌/.test(data?.error || "")) {
    csrfToken = "";
    await ensureCsrf();
    return api(path, options, false);
  }
  if (!response.ok) {
    const error = new Error(data?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}

export function toast(message, type = "default") {
  const region = document.querySelector("#toast-region");
  if (!region) return;
  const node = document.createElement("div");
  node.className = `toast ${type === "error" ? "error" : ""}`;
  node.textContent = message;
  region.append(node);
  window.setTimeout(() => node.remove(), 3200);
}

export function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
