/* MABU Dashboard — frontend core logic */

const MABU_VERSION = "2.1.0";

/* When served from a real web origin (http/https), talk to the API on the same
   origin — nginx proxies /api/ to Flask (see README deployment section). When
   opened as a local file (file://) during development, fall back to the local
   dev server on 127.0.0.1. */
const MABU_API = window.location.protocol.startsWith("http") ? "" : "http://127.0.0.1:5057";

/* All API calls must include credentials so the session cookie is sent/stored.
   State-changing requests also need the CSRF token echoed back in a header. */
let mabuCsrfToken = null;
let mabuCurrentUser = { username: null, role: null };
let mabuSessionExpiredHandled = false;

function mabuFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && mabuCsrfToken) {
    headers["X-CSRF-Token"] = mabuCsrfToken;
  }
  return fetch(MABU_API + path, { ...options, headers, credentials: "include" });
}

/* Centralized API client: wraps mabuFetch with consistent JSON parsing,
   status-code handling (401/403/429/5xx), and network/timeout errors, so
   individual call sites don't each reinvent try/catch + res.ok checks.
   Returns { data, res } on success; throws MabuApiError otherwise. Session
   expiry (401 while we believe we're authenticated) triggers one shared
   "session expired" flow instead of N independent failures. */
class MabuApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

async function mabuApi(path, options = {}) {
  const { timeoutMs = 20000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await mabuFetch(path, { ...fetchOptions, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      throw new MabuApiError("Request timed out. The server may be slow or unreachable.", 0, {});
    }
    throw new MabuApiError("Network error — could not reach the MABU server.", 0, {});
  }
  clearTimeout(timer);

  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }

  if (res.status === 401) {
    if (mabuCurrentUser.username && !mabuSessionExpiredHandled) {
      mabuSessionExpiredHandled = true;
      mabuHandleSessionExpired();
    }
    throw new MabuApiError(data.error || "Not authenticated.", 401, data);
  }
  if (res.status === 403) {
    throw new MabuApiError(data.error || "You don't have permission to do that.", 403, data);
  }
  if (res.status === 429) {
    throw new MabuApiError(data.error || "Too many attempts — please wait and try again.", 429, data);
  }
  if (res.status >= 500) {
    throw new MabuApiError("Server error. Check the server console/logs if this persists.", res.status, data);
  }
  if (!res.ok) {
    throw new MabuApiError(data.error || `Request failed (HTTP ${res.status}).`, res.status, data);
  }

  return { data, res };
}

function mabuHandleSessionExpired() {
  mabuToast("error", "Session expired", "Your session has ended. Please log in again.");
  setTimeout(() => {
    document.getElementById("mabuShell").hidden = true;
    document.getElementById("mabuLoginScreen").hidden = false;
    mabuCsrfToken = null;
    mabuCurrentUser = { username: null, role: null };
    mabuSessionExpiredHandled = false;
  }, 1200);
}

/* ---------------- Toast / notification system ---------------- */

function mabuToast(type, title, message, opts = {}) {
  const stack = document.getElementById("mabuToastStack");
  if (!stack) return;

  const icons = { success: "OK", info: "i", warning: "!", error: "X" };
  const el = document.createElement("div");
  el.className = "mabu-toast";
  el.dataset.type = type;
  el.innerHTML = `
    <span class="mabu-toast-icon">${icons[type] || "i"}</span>
    <span class="mabu-toast-body">
      ${title ? `<div class="mabu-toast-title">${mabuEscape(title)}</div>` : ""}
      <div>${mabuEscape(message || "")}</div>
    </span>
    <button class="mabu-toast-close" aria-label="Dismiss notification">&times;</button>
  `;
  stack.appendChild(el);

  const duration = opts.duration ?? (type === "error" ? 7000 : 4500);
  const remove = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 320);
  };
  el.querySelector(".mabu-toast-close").addEventListener("click", remove);
  if (duration > 0) setTimeout(remove, duration);

  mabuPushNotification(type, title, message);
}

/* Persistent notification log (separate from ephemeral toasts) shown from
   the bell icon in the topbar — lets the user check what happened after a
   toast has already faded. Session-local (localStorage), not server state. */
function mabuPushNotification(type, title, message) {
  const list = mabuLoadJSON("mabu_notifications", []);
  list.unshift({ type, title, message, time: new Date().toISOString() });
  mabuSaveJSON("mabu_notifications", list.slice(0, 50));
  mabuUpdateNotifBadge();
}

function mabuUpdateNotifBadge() {
  const btn = document.getElementById("notifBtn");
  if (!btn) return;
  const list = mabuLoadJSON("mabu_notifications", []);
  const unseen = list.filter((n) => !n.seen).length;
  let badge = btn.querySelector(".mabu-badge-count");
  if (unseen > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "mabu-badge-count";
      btn.appendChild(badge);
    }
    badge.textContent = unseen > 9 ? "9+" : String(unseen);
  } else if (badge) {
    badge.remove();
  }
}

function mabuRenderNotificationPanel() {
  const list = mabuLoadJSON("mabu_notifications", []);
  list.forEach((n) => { n.seen = true; });
  mabuSaveJSON("mabu_notifications", list);
  mabuUpdateNotifBadge();

  if (!list.length) {
    return `<div class="mabu-empty-state"><div class="mabu-empty-state-icon">·</div><h4>No notifications</h4><p>Activity from this session will appear here.</p></div>`;
  }
  return list.slice(0, 20).map((n) => `
    <div class="mabu-toast" style="position:static; animation:none; margin-bottom:8px;" data-type="${n.type}">
      <span class="mabu-toast-icon">${{ success: "OK", info: "i", warning: "!", error: "X" }[n.type] || "i"}</span>
      <span class="mabu-toast-body">
        <div class="mabu-toast-title">${mabuEscape(n.title || "")}</div>
        <div>${mabuEscape(n.message || "")}</div>
        <div style="color:var(--mabu-text-faint); font-size:10px; margin-top:4px;">${mabuEscape((n.time || "").slice(0, 19).replace("T", " "))}</div>
      </span>
    </div>
  `).join("");
}

/* ---------------- Confirmation modal ---------------- */

function mabuConfirm({ title, body, danger = false, confirmLabel = "confirm" }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("mabuModalOverlay");
    const modal = document.getElementById("mabuModal");
    document.getElementById("mabuModalTitle").textContent = title;
    document.getElementById("mabuModalBody").textContent = body;
    const confirmBtn = document.getElementById("mabuModalConfirm");
    const cancelBtn = document.getElementById("mabuModalCancel");
    confirmBtn.textContent = confirmLabel;
    modal.classList.toggle("mabu-modal-danger", !!danger);

    function cleanup(result) {
      overlay.hidden = true;
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onConfirm() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onKey(e) { if (e.key === "Escape") cleanup(false); }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    overlay.hidden = false;
    confirmBtn.focus();
  });
}

/* ---------------- Boot sequence ---------------- */

const MABU_BOOT_LINES = [
  `MABU SYSTEM v${MABU_VERSION} :: private research workstation`,
  "initializing core ... OK",
  "loading authentication ... OK",
  "mounting vault ... OK",
  "loading case index ... OK",
  "loading correlation engine ... OK",
  "loading research modules ... OK",
  "",
  "SYSTEM READY_",
];

function mabuRunBoot(done) {
  const logEl = document.getElementById("mabuBootLog");
  const fillEl = document.getElementById("mabuBootFill");
  const bootEl = document.getElementById("mabuBoot");

  let i = 0;
  let printed = "";
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    bootEl.style.transition = "opacity 0.2s ease";
    bootEl.style.opacity = "0";
    setTimeout(() => {
      bootEl.hidden = true;
      bootEl.style.opacity = "";
      done();
    }, 200);
  }

  function step() {
    if (finished) return;
    if (i < MABU_BOOT_LINES.length) {
      printed += MABU_BOOT_LINES[i] + "\n";
      logEl.textContent = printed;
      fillEl.style.width = `${Math.round(((i + 1) / MABU_BOOT_LINES.length) * 100)}%`;
      i++;
      setTimeout(step, 70 + Math.random() * 40);
    } else {
      setTimeout(finish, 250);
    }
  }

  document.getElementById("mabuBootSkip").onclick = finish;
  step();
}

/* Boot sequence is skipped when the user has opted out in Settings, or has
   already seen it this session — either way we always still go through the
   auth gate. */
function mabuInitBoot() {
  const bootEl = document.getElementById("mabuBoot");
  const skipPref = localStorage.getItem("mabu_skip_boot") === "1";
  if (skipPref || sessionStorage.getItem("mabu_booted")) {
    bootEl.hidden = true;
    mabuCheckAuthAndRoute();
    return;
  }
  mabuRunBoot(() => {
    sessionStorage.setItem("mabu_booted", "1");
    mabuCheckAuthAndRoute();
  });
}

/* ---------------- Auth ---------------- */

async function mabuCheckAuthAndRoute() {
  const loginScreen = document.getElementById("mabuLoginScreen");
  const shellEl = document.getElementById("mabuShell");

  try {
    const res = await fetch(`${MABU_API}/api/auth/status`, { credentials: "include" });
    const data = await res.json();

    if (!data.configured) {
      loginScreen.hidden = false;
      document.getElementById("loginSetupHint").hidden = false;
      document.getElementById("loginBtn").disabled = true;
      return;
    }

    if (data.authenticated) {
      mabuCsrfToken = data.csrf_token;
      mabuCurrentUser = { username: data.username, role: data.role };
      shellEl.hidden = false;
      document.getElementById("loggedInAsText").textContent = `user: ${data.username} (${data.role})`;
      mabuInitAll();
    } else {
      loginScreen.hidden = false;
    }
  } catch (e) {
    loginScreen.hidden = false;
    document.getElementById("loginError").textContent = "cannot reach api — is mabu-server.py running?";
  }
}

function mabuInitLogin() {
  const loginBtn = document.getElementById("loginBtn");
  const doLogin = async () => {
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;
    const errEl = document.getElementById("loginError");
    errEl.textContent = "";

    if (!username || !password) {
      errEl.textContent = "username and password required.";
      return;
    }

    try {
      const res = await fetch(`${MABU_API}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error || "login failed.";
        return;
      }
      mabuCsrfToken = data.csrf_token;
      mabuCurrentUser = { username: data.username, role: data.role };
      mabuSessionExpiredHandled = false;
      document.getElementById("mabuLoginScreen").hidden = true;
      document.getElementById("mabuShell").hidden = false;
      document.getElementById("loggedInAsText").textContent = `user: ${data.username} (${data.role})`;
      mabuInitAll();
      mabuToast("success", "Authenticated", `Welcome back, ${data.username}.`);
    } catch (e) {
      errEl.textContent = "cannot reach api — is mabu-server.py running?";
    }
  };

  loginBtn.addEventListener("click", doLogin);
  document.getElementById("loginPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
}

function mabuInitLogout() {
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await fetch(`${MABU_API}/api/auth/logout`, { method: "POST", credentials: "include" });
    } catch (e) {
      /* ignore — we're reloading regardless, which drops the client-side session either way */
    }
    location.reload();
  });
}

/* ---------------- Clock ---------------- */

function mabuTickClock() {
  const el = document.getElementById("mabuClock");
  if (!el) return;
  const now = new Date();
  el.textContent = now.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/* ---------------- Navigation ---------------- */

const MABU_TITLES = {
  home: "overview",
  email: "email-lookup",
  username: "username-tracker",
  discord: "discord-tools",
  network: "network-ip-tools",
  toolkit: "hash-encode-toolkit",
  research: "case-new",
  vault: "mabu-vault",
  reader: "mabu-reader",
  timeline: "timeline-graph",
  correlate: "correlation-engine",
  lookups: "public-record-lookups",
  admin: "users-and-audit",
  settings: "settings",
};

function mabuGoTo(view) {
  document.querySelectorAll(".mabu-nav-item").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  document.querySelectorAll(".mabu-view").forEach((sec) => sec.classList.toggle("active", sec.id === "view-" + view));
  document.getElementById("viewTitle").textContent = MABU_TITLES[view] || view;

  if (view === "vault") mabuLoadVault();
  if (view === "reader") mabuLoadReaderFileList();
  if (view === "home") mabuLoadStats();
  if (view === "timeline") mabuLoadTimeline();
  if (view === "correlate") mabuLoadCorrelation();
  if (view === "admin") mabuLoadAdminPanel();
  if (view === "research") mabuLoadTemplates();
  if (view === "settings") mabuLoadSettingsPanel();
}

/* ---------------- API status ---------------- */

async function mabuCheckApiStatus() {
  const dot = document.getElementById("apiStatusDot");
  const text = document.getElementById("apiStatusText");
  try {
    const res = await mabuFetch("/api/health", { cache: "no-store" });
    if (!res.ok) throw new Error("bad status");
    dot.className = "mabu-status-dot online";
    text.textContent = "api: online";
  } catch (e) {
    dot.className = "mabu-status-dot offline";
    text.textContent = "api: offline (run mabu-server.py)";
  }
}

/* ---------------- Email Lookup ---------------- */

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
  "aol.com", "protonmail.com", "gmx.com", "live.com", "mail.com",
]);

const DISPOSABLE_HINTS = [
  "mailinator", "10minutemail", "guerrillamail", "tempmail", "trashmail",
  "yopmail", "throwaway", "getnada", "fakeinbox", "dispostable",
];

function mabuInitEmail() {
  document.getElementById("emailAnalyzeBtn").addEventListener("click", async () => {
    const value = document.getElementById("emailInput").value.trim();
    const box = document.getElementById("emailResult");
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const valid = emailRegex.test(value);

    box.hidden = false;
    document.getElementById("emValid").textContent = valid ? "true" : "false";

    if (!valid) {
      ["emLocal", "emDomain", "emDomainType", "emMx", "emDisposable"].forEach(
        (id) => (document.getElementById(id).textContent = "–")
      );
      return;
    }

    const [local, domain] = value.split("@");
    document.getElementById("emLocal").textContent = local;
    document.getElementById("emDomain").textContent = domain.toLowerCase();
    document.getElementById("emDomainType").textContent = FREE_EMAIL_DOMAINS.has(domain.toLowerCase())
      ? "free/consumer webmail"
      : "custom/org domain";

    const looksDisposable = DISPOSABLE_HINTS.some((h) => domain.toLowerCase().includes(h));
    document.getElementById("emDisposable").textContent = looksDisposable ? "possible match" : "no match";

    document.getElementById("emMx").textContent = "checking...";
    try {
      const res = await mabuFetch(`/api/email/domain-check?domain=${encodeURIComponent(domain)}`);
      if (res.ok) {
        const data = await res.json();
        document.getElementById("emMx").textContent = data.resolves ? `yes (${data.detail || "resolves"})` : "no / unresolved";
      } else {
        document.getElementById("emMx").textContent = "api unavailable";
      }
    } catch (e) {
      document.getElementById("emMx").textContent = "api offline";
    }
  });

  document.getElementById("platformAddBtn").addEventListener("click", () => {
    const platform = document.getElementById("platformInput").value.trim();
    const status = document.getElementById("platformStatus").value;
    if (!platform) return;
    const list = mabuLoadJSON("mabu_platforms");
    list.push({ platform, status });
    mabuSaveJSON("mabu_platforms", list);
    document.getElementById("platformInput").value = "";
    mabuRenderPlatforms();
  });
}

function mabuRenderPlatforms() {
  const tbody = document.querySelector("#platformTable tbody");
  const list = mabuLoadJSON("mabu_platforms");
  tbody.innerHTML = "";
  list.forEach((item, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${mabuEscape(item.platform)}</td><td>${mabuEscape(item.status)}</td><td><button class="mabu-btn-danger" data-idx="${idx}">rm</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("button[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const list2 = mabuLoadJSON("mabu_platforms");
      list2.splice(Number(btn.dataset.idx), 1);
      mabuSaveJSON("mabu_platforms", list2);
      mabuRenderPlatforms();
    });
  });
}

/* ---------------- Username Module ---------------- */

const USERNAME_PLATFORMS = [
  { name: "GitHub", url: (u) => `https://github.com/${u}` },
  { name: "Reddit", url: (u) => `https://www.reddit.com/user/${u}` },
  { name: "X / Twitter", url: (u) => `https://x.com/${u}` },
  { name: "Instagram", url: (u) => `https://www.instagram.com/${u}/` },
  { name: "TikTok", url: (u) => `https://www.tiktok.com/@${u}` },
  { name: "YouTube", url: (u) => `https://www.youtube.com/@${u}` },
  { name: "Twitch", url: (u) => `https://www.twitch.tv/${u}` },
  { name: "Steam", url: (u) => `https://steamcommunity.com/id/${u}` },
  { name: "Pinterest", url: (u) => `https://www.pinterest.com/${u}/` },
  { name: "Telegram", url: (u) => `https://t.me/${u}` },
  { name: "Medium", url: (u) => `https://medium.com/@${u}` },
  { name: "DeviantArt", url: (u) => `https://www.deviantart.com/${u}` },
];

function mabuInitUsername() {
  document.getElementById("unameGenBtn").addEventListener("click", () => {
    const handle = document.getElementById("unameInput").value.trim();
    if (!handle) return;
    mabuRenderUsernameMatrix(handle);
  });

  document.getElementById("permGenBtn").addEventListener("click", () => {
    const first = document.getElementById("permFirst").value.trim().toLowerCase();
    const last = document.getElementById("permLast").value.trim().toLowerCase();
    if (!first) return;

    const variants = new Set();
    variants.add(first);
    if (last) {
      variants.add(first + last);
      variants.add(first + "." + last);
      variants.add(first + "_" + last);
      variants.add(first + "-" + last);
      variants.add(first[0] + last);
      variants.add(first[0] + "." + last);
      variants.add(last + first);
      variants.add(last + "." + first);
      variants.add(first + last[0]);
    }
    for (const y of ["", "1", "01", "07", "10", "11", "12", "13", "21", "22", "23", "99", "123"]) {
      variants.add(first + y);
      if (last) variants.add(first + last + y);
    }
    variants.add(first + "_official");
    variants.add(first + "official");
    variants.add("the" + first);
    variants.add("real" + first);
    variants.add("im" + first);
    variants.add("_" + first + "_");

    const box = document.getElementById("permResult");
    box.hidden = false;
    document.getElementById("permOutput").textContent = Array.from(variants).sort().join("\n");
  });

  document.getElementById("discordUserAddBtn").addEventListener("click", () => {
    const username = document.getElementById("discordUserInput").value.trim();
    const source = document.getElementById("discordUserSource").value.trim();
    if (!username) return;
    const list = mabuLoadJSON("mabu_discord_users");
    list.push({ username, source: source || "—" });
    mabuSaveJSON("mabu_discord_users", list);
    document.getElementById("discordUserInput").value = "";
    document.getElementById("discordUserSource").value = "";
    mabuRenderDiscordUsers();
  });
}

function mabuRenderUsernameMatrix(handle) {
  const key = "mabu_uname_status_" + handle.toLowerCase();
  const stored = mabuLoadJSON(key, {});
  const tbody = document.querySelector("#unameMatrixTable tbody");
  tbody.innerHTML = "";

  USERNAME_PLATFORMS.forEach((p) => {
    const status = stored[p.name] || "unknown";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${mabuEscape(p.name)}</td>
      <td><a href="${p.url(encodeURIComponent(handle))}" target="_blank" rel="noopener noreferrer">${p.url(handle)}</a></td>
      <td><span class="mabu-pill" data-status="${status}" data-platform="${mabuEscape(p.name)}">${status}</span></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".mabu-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const cycle = ["unknown", "confirmed", "not_found"];
      const cur = pill.dataset.status;
      const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
      pill.dataset.status = next;
      pill.textContent = next;
      const data = mabuLoadJSON(key, {});
      data[pill.dataset.platform] = next;
      mabuSaveJSON(key, data);
    });
  });
}

function mabuRenderDiscordUsers() {
  const tbody = document.querySelector("#discordUserTable tbody");
  const list = mabuLoadJSON("mabu_discord_users");
  tbody.innerHTML = "";
  list.forEach((item, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${mabuEscape(item.username)}</td><td>${mabuEscape(item.source)}</td><td><button class="mabu-btn-danger" data-idx="${idx}">rm</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("button[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const list2 = mabuLoadJSON("mabu_discord_users");
      list2.splice(Number(btn.dataset.idx), 1);
      mabuSaveJSON("mabu_discord_users", list2);
      mabuRenderDiscordUsers();
    });
  });
}

/* ---------------- Discord Tools ---------------- */

const DISCORD_EPOCH = 1420070400000n;

function mabuInitDiscord() {
  document.getElementById("snowflakeBtn").addEventListener("click", () => {
    const raw = document.getElementById("snowflakeInput").value.trim();
    const box = document.getElementById("snowflakeResult");

    if (!/^\d+$/.test(raw)) {
      alert("Please enter a valid numeric Snowflake ID.");
      return;
    }

    const snowflake = BigInt(raw);
    const timestampMs = (snowflake >> 22n) + DISCORD_EPOCH;
    const workerId = (snowflake & 0x3E0000n) >> 17n;
    const processId = (snowflake & 0x1F000n) >> 12n;
    const increment = snowflake & 0xFFFn;

    const date = new Date(Number(timestampMs));
    const now = new Date();
    const ageMs = now.getTime() - date.getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const ageYears = (ageDays / 365.25).toFixed(2);

    box.hidden = false;
    document.getElementById("sfTimestamp").textContent = date.toISOString().replace("T", " ").replace("Z", " UTC");
    document.getElementById("sfAge").textContent = `${ageDays.toLocaleString()} days (~${ageYears}y)`;
    document.getElementById("sfWorker").textContent = workerId.toString();
    document.getElementById("sfProcess").textContent = processId.toString();
    document.getElementById("sfIncrement").textContent = increment.toString();
    document.getElementById("sfUnixMs").textContent = timestampMs.toString();
  });

  mabuInitSnowflakeBatch();
  mabuInitDiscordLinkParser();
  mabuInitCdnDecoder();
  mabuInitDiscordTagCheck();
}

function mabuDecodeSnowflake(raw) {
  const snowflake = BigInt(raw);
  const timestampMs = (snowflake >> 22n) + DISCORD_EPOCH;
  const workerId = (snowflake & 0x3E0000n) >> 17n;
  const processId = (snowflake & 0x1F000n) >> 12n;
  const increment = snowflake & 0xFFFn;
  const date = new Date(Number(timestampMs));
  const ageMs = Date.now() - date.getTime();
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  return {
    raw,
    timestampMs,
    date,
    ageDays,
    workerId,
    processId,
    increment,
  };
}

function mabuInitSnowflakeBatch() {
  document.getElementById("sfBatchBtn").addEventListener("click", () => {
    const lines = document.getElementById("sfBatchInput").value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const table = document.getElementById("sfBatchTable");
    const tbody = table.querySelector("tbody");
    const sortByTime = document.getElementById("sfBatchSort").checked;

    if (!lines.length) {
      mabuToast("warning", "No IDs entered", "Paste one or more snowflake IDs, one per line.");
      return;
    }

    const results = [];
    const errors = [];
    lines.forEach((raw) => {
      if (!/^\d{15,20}$/.test(raw)) {
        errors.push(raw);
        return;
      }
      try {
        results.push(mabuDecodeSnowflake(raw));
      } catch (e) {
        errors.push(raw);
      }
    });

    if (sortByTime) results.sort((a, b) => Number(a.timestampMs - b.timestampMs));

    table.hidden = false;
    tbody.innerHTML = results.map((r) => `
      <tr>
        <td>${mabuEscape(r.raw)}</td>
        <td>${r.date.toISOString().replace("T", " ").replace("Z", " UTC")}</td>
        <td>${r.ageDays.toLocaleString()}d</td>
        <td>${r.workerId}</td>
        <td>${r.processId}</td>
        <td>${r.increment}</td>
      </tr>
    `).join("") || `<tr><td colspan="6" class="mabu-note">no valid snowflakes found.</td></tr>`;

    if (errors.length) {
      mabuToast("warning", "Some lines skipped", `${errors.length} line(s) were not valid snowflake IDs.`);
    } else {
      mabuToast("success", "Decoded", `${results.length} snowflake(s) decoded${sortByTime ? ", sorted by timestamp" : ""}.`);
    }
  });
}

/* ---------------- Discord invite / message-link parser ---------------- */

function mabuInitDiscordLinkParser() {
  document.getElementById("discordLinkBtn").addEventListener("click", () => {
    const raw = document.getElementById("discordLinkInput").value.trim();
    const box = document.getElementById("discordLinkResult");
    if (!raw) return;

    box.hidden = false;

    const inviteMatch = raw.match(/(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([a-zA-Z0-9-]+)/i);
    const msgMatch = raw.match(/discord(?:app)?\.com\/channels\/(@me|\d+)\/(\d+)\/(\d+)/i);

    if (msgMatch) {
      const [, guildId, channelId, messageId] = msgMatch;
      const isDM = guildId === "@me";
      let html = `
        <div class="mabu-kv"><span>link type</span><b>message link${isDM ? " (DM)" : ""}</b></div>
        <div class="mabu-kv"><span>guild_id</span><b>${isDM ? "(direct message — no guild)" : mabuEscape(guildId)}</b></div>
        <div class="mabu-kv"><span>channel_id</span><b>${mabuEscape(channelId)}</b></div>
        <div class="mabu-kv"><span>message_id</span><b>${mabuEscape(messageId)}</b></div>
      `;
      try {
        const decoded = mabuDecodeSnowflake(messageId);
        html += `<div class="mabu-kv"><span>message sent</span><b>${decoded.date.toISOString().replace("T", " ").replace("Z", " UTC")}</b></div>`;
      } catch (e) { /* ignore */ }
      box.innerHTML = html;
    } else if (inviteMatch) {
      box.innerHTML = `
        <div class="mabu-kv"><span>link type</span><b>server invite</b></div>
        <div class="mabu-kv"><span>invite_code</span><b>${mabuEscape(inviteMatch[1])}</b></div>
        <p class="mabu-note" style="margin-top:8px;">Invite codes don't encode a timestamp or guild ID directly — resolving which server/channel this points to would require querying Discord's API, which MABU does not do.</p>
      `;
    } else {
      box.innerHTML = `<p class="mabu-note">Not recognized as a Discord invite link or message link. Expected formats: discord.gg/&lt;code&gt;, discord.com/invite/&lt;code&gt;, or discord.com/channels/&lt;guild&gt;/&lt;channel&gt;/&lt;message&gt;.</p>`;
    }
  });
}

/* ---------------- Discord CDN asset decoder ---------------- */

const DISCORD_CDN_ASSET_TYPES = {
  avatars: "user avatar",
  banners: "user banner",
  icons: "guild icon",
  splashes: "guild splash",
  "discovery-splashes": "guild discovery splash",
  emojis: "custom emoji",
  "app-icons": "application icon",
  stickers: "sticker",
};

function mabuInitCdnDecoder() {
  document.getElementById("cdnDecodeBtn").addEventListener("click", () => {
    const raw = document.getElementById("cdnInput").value.trim();
    const box = document.getElementById("cdnResult");
    if (!raw) return;
    box.hidden = false;

    // Match either a full CDN URL (cdn.discordapp.com/<type>/<owner_id>/<hash>.<ext>)
    // or a bare "<owner_id>/<hash>.<ext>" / just a hash.
    const urlMatch = raw.match(/cdn\.discordapp\.com\/([a-z-]+)\/(\d+)\/([a-zA-Z0-9_]+)\.(\w+)/i);
    const bareMatch = !urlMatch && raw.match(/^(\d+)\/([a-zA-Z0-9_]+)\.(\w+)$/);
    const hashOnly = !urlMatch && !bareMatch && raw.match(/^(a_)?[a-fA-F0-9]{32}$/);

    if (urlMatch) {
      const [, assetType, ownerId, hash, ext] = urlMatch;
      const animated = hash.startsWith("a_");
      let html = `
        <div class="mabu-kv"><span>asset type</span><b>${mabuEscape(DISCORD_CDN_ASSET_TYPES[assetType] || assetType)}</b></div>
        <div class="mabu-kv"><span>owner id</span><b>${mabuEscape(ownerId)}</b></div>
        <div class="mabu-kv"><span>hash</span><b>${mabuEscape(hash)}</b></div>
        <div class="mabu-kv"><span>format</span><b>${mabuEscape(ext.toLowerCase())}</b></div>
        <div class="mabu-kv"><span>animated</span><b>${animated ? "yes (a_ prefix)" : "no"}</b></div>
      `;
      try {
        const decoded = mabuDecodeSnowflake(ownerId);
        html += `<div class="mabu-kv"><span>owner id created</span><b>${decoded.date.toISOString().replace("T", " ").replace("Z", " UTC")}</b></div>`;
      } catch (e) { /* ignore */ }
      box.innerHTML = html;
    } else if (bareMatch) {
      const [, ownerId, hash, ext] = bareMatch;
      const animated = hash.startsWith("a_");
      box.innerHTML = `
        <div class="mabu-kv"><span>owner id</span><b>${mabuEscape(ownerId)}</b></div>
        <div class="mabu-kv"><span>hash</span><b>${mabuEscape(hash)}</b></div>
        <div class="mabu-kv"><span>format</span><b>${mabuEscape(ext.toLowerCase())}</b></div>
        <div class="mabu-kv"><span>animated</span><b>${animated ? "yes (a_ prefix)" : "no"}</b></div>
      `;
    } else if (hashOnly) {
      const hash = hashOnly[0];
      const animated = hash.startsWith("a_");
      box.innerHTML = `
        <div class="mabu-kv"><span>hash</span><b>${mabuEscape(hash)}</b></div>
        <div class="mabu-kv"><span>animated</span><b>${animated ? "yes (a_ prefix)" : "no"}</b></div>
        <p class="mabu-note" style="margin-top:8px;">No owner ID or format present in a bare hash — paste the full CDN URL for those fields.</p>
      `;
    } else {
      box.innerHTML = `<p class="mabu-note">Not recognized. Expected a cdn.discordapp.com asset URL, an "&lt;id&gt;/&lt;hash&gt;.&lt;ext&gt;" path, or a bare 32-character hash.</p>`;
    }
  });
}

/* ---------------- Username/tag format check ---------------- */

function mabuInitDiscordTagCheck() {
  document.getElementById("discordTagBtn").addEventListener("click", () => {
    const raw = document.getElementById("discordTagInput").value.trim();
    const box = document.getElementById("discordTagResult");
    if (!raw) return;
    box.hidden = false;

    const legacyMatch = raw.match(/^(.{2,32})#(\d{4})$/);
    const isLegacySpecialCase = legacyMatch && legacyMatch[2] === "0000";

    if (legacyMatch && !isLegacySpecialCase) {
      box.innerHTML = `
        <div class="mabu-kv"><span>format</span><b>legacy Name#Discriminator</b></div>
        <div class="mabu-kv"><span>display name</span><b>${mabuEscape(legacyMatch[1])}</b></div>
        <div class="mabu-kv"><span>discriminator</span><b>${mabuEscape(legacyMatch[2])}</b></div>
        <p class="mabu-note" style="margin-top:8px;">This format was retired in 2023. Discriminators are no longer assigned to new/migrated accounts, so this handle was likely captured before the migration (or the account never migrated to a unique username).</p>
      `;
      return;
    }

    const uniqueUsernameRe = /^[a-z0-9_.]{2,32}$/;
    if (uniqueUsernameRe.test(raw)) {
      const hasDot = raw.includes(".");
      box.innerHTML = `
        <div class="mabu-kv"><span>format</span><b>unique username (post-2023)</b></div>
        <div class="mabu-kv"><span>username</span><b>${mabuEscape(raw)}</b></div>
        <div class="mabu-kv"><span>valid characters</span><b>yes (lowercase, digits, underscore, period)</b></div>
        ${hasDot ? '<div class="mabu-kv"><span>note</span><b>a single non-leading/trailing period is allowed</b></div>' : ""}
        <p class="mabu-note" style="margin-top:8px;">Consistent with the current unique-username system — no discriminator needed. Doesn't confirm the account exists; this is a format check only.</p>
      `;
    } else {
      box.innerHTML = `
        <div class="mabu-kv"><span>format</span><b>does not match either known format</b></div>
        <p class="mabu-note" style="margin-top:8px;">Not a valid legacy "Name#1234" or current unique-username pattern (lowercase letters, digits, underscore, single period, 2-32 chars). Could be a display/nickname rather than the actual username.</p>
      `;
    }
  });
}

/* ---------------- Network / IP Tools ---------------- */

const PORT_REFERENCE = [
  [20, "TCP", "FTP (data)"],
  [21, "TCP", "FTP (control)"],
  [22, "TCP", "SSH"],
  [23, "TCP", "Telnet"],
  [25, "TCP", "SMTP"],
  [53, "TCP/UDP", "DNS"],
  [80, "TCP", "HTTP"],
  [110, "TCP", "POP3"],
  [123, "UDP", "NTP"],
  [143, "TCP", "IMAP"],
  [389, "TCP/UDP", "LDAP"],
  [443, "TCP", "HTTPS"],
  [445, "TCP", "SMB"],
  [465, "TCP", "SMTPS"],
  [587, "TCP", "SMTP (submission)"],
  [993, "TCP", "IMAPS"],
  [995, "TCP", "POP3S"],
  [3306, "TCP", "MySQL"],
  [3389, "TCP", "RDP"],
  [5432, "TCP", "PostgreSQL"],
  [5900, "TCP", "VNC"],
  [6379, "TCP", "Redis"],
  [8080, "TCP", "HTTP (alt)"],
  [27017, "TCP", "MongoDB"],
];

function ipv4ToBinary(parts) {
  return parts.map((p) => Number(p).toString(2).padStart(8, "0")).join(".");
}

function ipv4ToHex(parts) {
  return "0x" + parts.map((p) => Number(p).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function classifyIPv4Scope(parts) {
  const [a, b] = parts.map(Number);
  if (a === 10) return "private (RFC1918, 10.0.0.0/8)";
  if (a === 172 && b >= 16 && b <= 31) return "private (RFC1918, 172.16.0.0/12)";
  if (a === 192 && b === 168) return "private (RFC1918, 192.168.0.0/16)";
  if (a === 127) return "loopback (127.0.0.0/8)";
  if (a === 169 && b === 254) return "link-local (169.254.0.0/16)";
  if (a >= 224 && a <= 239) return "multicast (224.0.0.0/4)";
  if (a === 0) return "reserved (\"this network\")";
  if (a === 255 && b === 255) return "broadcast";
  return "public / global unicast";
}

function classifyIPv6Scope(addr) {
  const low = addr.toLowerCase();
  if (low === "::1") return "loopback";
  if (low.startsWith("fe80")) return "link-local";
  if (low.startsWith("fc") || low.startsWith("fd")) return "unique local (ULA)";
  if (low.startsWith("ff")) return "multicast";
  if (low.startsWith("::")) return "unspecified / reserved";
  if (low.startsWith("2001:db8")) return "documentation (RFC3849)";
  return "global unicast";
}

function mabuInitNetwork() {
  const portsBody = document.querySelector("#portsTable tbody");
  PORT_REFERENCE.forEach(([port, proto, service]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${port}</td><td>${proto}</td><td>${service}</td>`;
    portsBody.appendChild(tr);
  });

  document.getElementById("ipClassifyBtn").addEventListener("click", () => {
    const value = document.getElementById("ipInput").value.trim();
    const box = document.getElementById("ipResult");
    box.hidden = false;

    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = value.match(ipv4Regex);

    if (match) {
      const parts = match.slice(1);
      const valid = parts.every((p) => Number(p) >= 0 && Number(p) <= 255);
      document.getElementById("ipVersion").textContent = "IPv4";
      document.getElementById("ipValid").textContent = valid ? "true" : "false";
      if (valid) {
        document.getElementById("ipScope").textContent = classifyIPv4Scope(parts);
        document.getElementById("ipBinary").textContent = ipv4ToBinary(parts);
        document.getElementById("ipHex").textContent = ipv4ToHex(parts);
        document.getElementById("ipPtr").textContent = parts.slice().reverse().join(".") + ".in-addr.arpa";
      } else {
        ["ipScope", "ipBinary", "ipHex", "ipPtr"].forEach((id) => (document.getElementById(id).textContent = "–"));
      }
    } else if (value.includes(":")) {
      document.getElementById("ipVersion").textContent = "IPv6";
      const ipv6Regex = /^[0-9a-fA-F:]+$/;
      const valid = ipv6Regex.test(value) && value.split(":").length >= 3;
      document.getElementById("ipValid").textContent = valid ? "true (heuristic)" : "false";
      document.getElementById("ipScope").textContent = valid ? classifyIPv6Scope(value) : "–";
      document.getElementById("ipBinary").textContent = "n/a for IPv6";
      document.getElementById("ipHex").textContent = "n/a for IPv6";
      document.getElementById("ipPtr").textContent = "n/a (use ip6.arpa expansion)";
    } else {
      document.getElementById("ipVersion").textContent = "unknown";
      document.getElementById("ipValid").textContent = "false";
      ["ipScope", "ipBinary", "ipHex", "ipPtr"].forEach((id) => (document.getElementById(id).textContent = "–"));
    }
  });

  document.getElementById("cidrCalcBtn").addEventListener("click", () => {
    const value = document.getElementById("cidrInput").value.trim();
    const box = document.getElementById("cidrResult");
    const cidrMatch = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);

    box.hidden = false;
    if (!cidrMatch) {
      alert("Enter valid CIDR notation, e.g. 192.168.1.0/24");
      box.hidden = true;
      return;
    }

    const octets = cidrMatch.slice(1, 5).map(Number);
    const prefix = Number(cidrMatch[5]);
    if (octets.some((o) => o > 255) || prefix > 32) {
      alert("Invalid CIDR values.");
      box.hidden = true;
      return;
    }

    const ipInt = (octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3];
    const maskInt = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const networkInt = (ipInt & maskInt) >>> 0;
    const broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;

    const toIp = (int) => [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join(".");

    const usableHosts = prefix >= 31 ? 0 : Math.max(0, 2 ** (32 - prefix) - 2);

    document.getElementById("cidrNetwork").textContent = toIp(networkInt);
    document.getElementById("cidrBroadcast").textContent = toIp(broadcastInt);
    document.getElementById("cidrMask").textContent = toIp(maskInt);
    document.getElementById("cidrHosts").textContent = usableHosts.toLocaleString();
    document.getElementById("cidrFirst").textContent = usableHosts > 0 ? toIp(networkInt + 1) : toIp(networkInt);
    document.getElementById("cidrLast").textContent = usableHosts > 0 ? toIp(broadcastInt - 1) : toIp(broadcastInt);
  });
}

/* ---------------- Hash & Encode Toolkit ---------------- */

async function mabuSha(algo, text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest(algo, enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Minimal pure-JS MD5 (Web Crypto does not support MD5) */
function mabuMd5(input) {
  function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }
  function toHexLE(num) {
    let hex = "";
    for (let i = 0; i < 4; i++) {
      hex += ((num >> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    }
    return hex;
  }

  const K = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  const msgBytes = new TextEncoder().encode(input);
  const bitLen = msgBytes.length * 8;

  let padLen = (msgBytes.length % 64 < 56) ? 56 - (msgBytes.length % 64) : 120 - (msgBytes.length % 64);
  const total = msgBytes.length + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(msgBytes, 0);
  buf[msgBytes.length] = 0x80;

  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, bitLen >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let chunkStart = 0; chunkStart < total; chunkStart += 64) {
    const M = [];
    for (let j = 0; j < 16; j++) {
      M[j] = view.getUint32(chunkStart + j * 4, true);
    }

    let [A, B, C, D] = [a0, b0, c0, d0];

    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }

      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}

function mabuInitToolkit() {
  document.getElementById("hashGenBtn").addEventListener("click", async () => {
    const text = document.getElementById("hashInput").value;
    const box = document.getElementById("hashResult");
    box.hidden = false;

    document.getElementById("hashMd5").textContent = mabuMd5(text);
    document.getElementById("hashSha1").textContent = await mabuSha("SHA-1", text);
    document.getElementById("hashSha256").textContent = await mabuSha("SHA-256", text);
    document.getElementById("hashSha512").textContent = await mabuSha("SHA-512", text);
  });

  document.getElementById("b64EncodeBtn").addEventListener("click", () => {
    const input = document.getElementById("codecInput").value;
    try {
      document.getElementById("codecOutput").value = btoa(unescape(encodeURIComponent(input)));
    } catch (e) {
      document.getElementById("codecOutput").value = "ERROR: " + e.message;
    }
  });

  document.getElementById("b64DecodeBtn").addEventListener("click", () => {
    const input = document.getElementById("codecInput").value;
    try {
      document.getElementById("codecOutput").value = decodeURIComponent(escape(atob(input)));
    } catch (e) {
      document.getElementById("codecOutput").value = "ERROR: invalid base64 input";
    }
  });

  document.getElementById("urlEncodeBtn").addEventListener("click", () => {
    const input = document.getElementById("codecInput").value;
    document.getElementById("codecOutput").value = encodeURIComponent(input);
  });

  document.getElementById("urlDecodeBtn").addEventListener("click", () => {
    const input = document.getElementById("codecInput").value;
    try {
      document.getElementById("codecOutput").value = decodeURIComponent(input);
    } catch (e) {
      document.getElementById("codecOutput").value = "ERROR: invalid URL-encoded input";
    }
  });

  document.getElementById("jwtDecodeBtn").addEventListener("click", () => {
    const token = document.getElementById("jwtInput").value.trim();
    const parts = token.split(".");
    const box = document.getElementById("jwtResult");

    if (parts.length < 2) {
      alert("Not a valid JWT (expected header.payload.signature)");
      return;
    }

    function b64uDecode(str) {
      const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
      return decodeURIComponent(escape(atob(padded)));
    }

    try {
      const header = JSON.parse(b64uDecode(parts[0]));
      const payload = JSON.parse(b64uDecode(parts[1]));
      document.getElementById("jwtHeader").textContent = JSON.stringify(header, null, 2);
      document.getElementById("jwtPayload").textContent = JSON.stringify(payload, null, 2);
      box.hidden = false;
    } catch (e) {
      alert("Failed to decode JWT: " + e.message);
    }
  });
}

/* ---------------- Research / Case Creation ---------------- */

function mabuSplitList(value) {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function mabuInitResearch() {
  document.getElementById("rSaveBtn").addEventListener("click", async () => {
    const statusEl = document.getElementById("rSaveStatus");
    const payload = {
      title: document.getElementById("rTitle").value.trim() || "Untitled Case",
      investigator: document.getElementById("rInvestigator").value.trim() || "Unknown",
      summary: document.getElementById("rSummary").value.trim(),
      findings: document.getElementById("rFindings").value.trim(),
      emails: mabuSplitList(document.getElementById("rEmail").value),
      phones: mabuSplitList(document.getElementById("rPhone").value),
      usernames: mabuSplitList(document.getElementById("rUsername").value),
      names: mabuSplitList(document.getElementById("rNames").value),
      ips: mabuSplitList(document.getElementById("rIp").value),
      tags: mabuSplitList(document.getElementById("rTags").value),
      sources: document.getElementById("rSources").value.split("\n").map((s) => s.trim()).filter(Boolean),
      passphrase: document.getElementById("rPassphrase").value || null,
    };

    if (!payload.summary && !payload.findings) {
      statusEl.textContent = "add a summary or findings before saving.";
      statusEl.style.color = "var(--mabu-amber)";
      return;
    }

    statusEl.textContent = "creating case...";
    statusEl.style.color = "var(--mabu-text-dim)";

    try {
      const res = await mabuFetch("/api/cases/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      statusEl.textContent = `case created: ${data.filename}`;
      statusEl.style.color = "var(--mabu-green)";
    } catch (e) {
      statusEl.textContent = `error: ${e.message}. is mabu-server.py running?`;
      statusEl.style.color = "var(--mabu-red)";
    }
  });
}

/* ---------------- Vault (case list + case detail) ---------------- */

let mabuCurrentCaseFilename = null;

const MABU_VAULT_PAGE_SIZE = 50;
let mabuVaultAllFiles = [];
let mabuVaultPage = 0;

function mabuRenderVaultRows(files) {
  mabuVaultAllFiles = files;
  mabuVaultPage = 0;
  mabuRenderVaultPage();
}

function mabuRenderVaultPage() {
  const files = mabuVaultAllFiles;
  const tbody = document.querySelector("#vaultTable tbody");
  const pagination = document.getElementById("vaultPagination");
  tbody.innerHTML = "";

  if (!files.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="mabu-note">no .mabu files found in vault.</td></tr>`;
    pagination.hidden = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(files.length / MABU_VAULT_PAGE_SIZE));
  mabuVaultPage = Math.min(mabuVaultPage, totalPages - 1);
  const start = mabuVaultPage * MABU_VAULT_PAGE_SIZE;
  const pageFiles = files.slice(start, start + MABU_VAULT_PAGE_SIZE);

  pageFiles.forEach((f) => {
    const tags = (f.tags || []).map((t) => `<span class="mabu-tag">${mabuEscape(t)}</span>`).join("");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${mabuEscape(f.title || f.filename)}</td>
      <td>${mabuEscape(f.status || "–")}</td>
      <td>${f.entry_count ?? "–"}</td>
      <td>${mabuEscape((f.updated || "").replace("T", " ").slice(0, 19))}</td>
      <td>${mabuEscape(f.investigator || "–")}</td>
      <td>${tags || "–"}</td>
      <td>
        <button class="mabu-btn-secondary mabu-btn" data-file="${mabuEscape(f.filename)}" data-action="open">open()</button>
        <button class="mabu-btn-secondary mabu-btn" data-file="${mabuEscape(f.filename)}" data-action="reader">reader()</button>
        <button class="mabu-btn-danger" data-file="${mabuEscape(f.filename)}" data-title="${mabuEscape(f.title || f.filename)}" data-action="delete">delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("button[data-action='open']").forEach((btn) => {
    btn.addEventListener("click", () => mabuOpenCaseDetail(btn.dataset.file));
  });
  tbody.querySelectorAll("button[data-action='delete']").forEach((btn) => {
    btn.addEventListener("click", () => mabuDeleteCase(btn.dataset.file, btn.dataset.title));
  });
  tbody.querySelectorAll("button[data-action='reader']").forEach((btn) => {
    btn.addEventListener("click", () => {
      mabuGoTo("reader");
      setTimeout(() => {
        const sel = document.getElementById("readerFileSelect");
        sel.value = btn.dataset.file;
      }, 50);
    });
  });

  if (files.length > MABU_VAULT_PAGE_SIZE) {
    pagination.hidden = false;
    document.getElementById("vaultPageInfo").textContent =
      `showing ${start + 1}-${Math.min(start + MABU_VAULT_PAGE_SIZE, files.length)} of ${files.length}`;
    document.getElementById("vaultPagePrev").disabled = mabuVaultPage === 0;
    document.getElementById("vaultPageNext").disabled = mabuVaultPage >= totalPages - 1;
  } else {
    pagination.hidden = true;
  }
}

async function mabuLoadVault() {
  const tbody = document.querySelector("#vaultTable tbody");
  tbody.innerHTML = `<tr><td colspan="7" class="mabu-note">loading...</td></tr>`;
  try {
    const res = await mabuFetch("/api/vault/list");
    const data = await res.json();
    mabuRenderVaultRows(data.files || []);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="mabu-note">could not reach api. is mabu-server.py running?</td></tr>`;
  }
}

let mabuCurrentCaseRecord = null;

async function mabuOpenCaseDetail(filename) {
  const card = document.getElementById("caseDetailCard");
  card.hidden = false;
  document.getElementById("caseDetailTitle").textContent = filename;
  document.getElementById("caseOverviewBody").innerHTML = `<div class="mabu-loading-state"><span class="mabu-spinner"></span> decrypting case...</div>`;
  card.scrollIntoView({ behavior: "smooth" });

  try {
    const { data } = await mabuApi("/api/vault/decrypt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, passphrase: null }),
    });

    mabuCurrentCaseFilename = filename;
    mabuCurrentCaseRecord = data.record;
    mabuRenderCaseWorkspace(data.record);
  } catch (e) {
    document.getElementById("caseOverviewBody").innerHTML = `<div class="mabu-empty-state"><div class="mabu-empty-state-icon">?</div><h4>Could not open case</h4><p>${mabuEscape(e.message)}. Passphrase-protected files must be opened via the Reader tab instead.</p></div>`;
    mabuCurrentCaseFilename = null;
    mabuCurrentCaseRecord = null;
  }
}

function mabuRenderCaseWorkspace(rec) {
  const entries = rec.entries || [];

  document.getElementById("caseDetailTitle").textContent = rec.title || mabuCurrentCaseFilename;
  document.getElementById("caseMetaId").textContent = rec.case_id || "–";
  document.getElementById("caseMetaInvestigator").textContent = rec.investigator || "–";
  document.getElementById("caseMetaCreated").textContent = (rec.created || "").replace("T", " ").slice(0, 19) || "–";
  document.getElementById("caseMetaUpdated").textContent = (rec.updated || "").replace("T", " ").slice(0, 19) || "–";
  document.getElementById("caseStatusSelect").value = rec.status || "open";
  document.getElementById("caseTagsInput").value = (rec.tags || []).join(", ");

  // Overview
  const tagsHtml = (rec.tags || []).length
    ? rec.tags.map((t) => `<span class="mabu-tag">${mabuEscape(t)}</span>`).join("")
    : `<span class="mabu-note">(no tags)</span>`;
  document.getElementById("caseOverviewBody").innerHTML = `
    <div class="mabu-kv"><span>status</span><b>${mabuEscape(rec.status || "open")}</b></div>
    <div class="mabu-kv"><span>entries</span><b>${entries.length}</b></div>
    <div class="mabu-kv"><span>tags</span><b>${tagsHtml}</b></div>
  `;

  // Entries
  document.getElementById("caseEntriesBody").innerHTML = entries.length
    ? entries.slice().reverse().map((e) => mabuRenderEntryCard(e)).join("")
    : `<div class="mabu-empty-state"><div class="mabu-empty-state-icon">·</div><h4>No entries yet</h4><p>Add the first entry below.</p></div>`;

  // Identifiers (aggregated, deduplicated, with chip UI)
  document.getElementById("caseIdentifiersBody").innerHTML = mabuRenderIdentifierChips(entries);

  // Attachments (aggregated across all entries)
  document.getElementById("caseAttachmentsBody").innerHTML = mabuRenderAttachmentsGallery(entries);

  // Activity log
  const activity = rec.activity_log || [];
  document.getElementById("caseActivityBody").innerHTML = activity.length
    ? `<table class="mabu-table"><thead><tr><th>date</th><th>action</th><th>detail</th></tr></thead><tbody>${
        activity.slice().reverse().map((a) => `
          <tr>
            <td>${mabuEscape((a.date || "").replace("T", " ").slice(0, 19))}</td>
            <td>${mabuEscape((a.action || "").replace(/_/g, " "))}</td>
            <td>${mabuEscape(a.detail || "")}</td>
          </tr>
        `).join("")
      }</tbody></table>`
    : `<div class="mabu-empty-state"><div class="mabu-empty-state-icon">·</div><h4>No activity recorded</h4></div>`;
}

function mabuRenderEntryCard(e) {
  const listField = (arr) => (arr && arr.length ? arr.map(mabuEscape).join(", ") : "–");
  const attachments = e.attachments || [];
  const attachmentsHtml = attachments.length
    ? attachments.map((a) => `<button class="mabu-btn-secondary mabu-btn" data-entry="${mabuEscape(e.entry_id)}" data-attachment="${mabuEscape(a.attachment_id)}" data-filename="${mabuEscape(a.filename)}">${mabuEscape(a.filename)}</button>`).join(" ")
    : "";
  return `
    <div class="mabu-result-box" style="margin-bottom:10px;">
      <div class="mabu-kv"><span>date</span><b>${mabuEscape((e.date || "").replace("T", " ").slice(0, 19))}</b></div>
      <div class="mabu-kv"><span><span class="mabu-provenance" data-kind="observed">observed</span> author</span><b>${mabuEscape(e.author || "–")}</b></div>
      <div class="mabu-kv"><span><span class="mabu-provenance" data-kind="analyst">analyst</span> summary</span><b>${mabuEscape(e.summary || "–")}</b></div>
      <div class="mabu-kv"><span><span class="mabu-provenance" data-kind="analyst">analyst</span> findings</span><b>${mabuEscape(e.findings || "–")}</b></div>
      <div class="mabu-kv"><span><span class="mabu-provenance" data-kind="source">source</span> emails</span><b>${listField(e.emails)}</b></div>
      <div class="mabu-kv"><span><span class="mabu-provenance" data-kind="source">source</span> usernames</span><b>${listField(e.usernames)}</b></div>
      <div class="mabu-kv"><span><span class="mabu-provenance" data-kind="source">source</span> ips</span><b>${listField(e.ips)}</b></div>
      ${e.sources && e.sources.length ? `<div class="mabu-kv"><span>sources</span><b>${listField(e.sources)}</b></div>` : ""}
      ${attachmentsHtml ? `<div class="mabu-kv"><span>attachments</span><b>${attachmentsHtml}</b></div>` : ""}
    </div>
  `;
}

function mabuRenderIdentifierChips(entries) {
  const groups = { emails: "EMAIL", usernames: "USERNAME", ips: "IP", phones: "PHONE", names: "NAME" };
  const agg = {};
  Object.keys(groups).forEach((k) => { agg[k] = new Set(); });

  entries.forEach((e) => {
    Object.keys(groups).forEach((k) => {
      (e[k] || []).forEach((v) => { if (v) agg[k].add(v); });
    });
  });

  const totalCount = Object.values(agg).reduce((sum, s) => sum + s.size, 0);
  if (!totalCount) {
    return `<div class="mabu-empty-state"><div class="mabu-empty-state-icon">·</div><h4>No identifiers recorded</h4><p>Add emails, usernames, IPs, phones, or names via an entry.</p></div>`;
  }

  return Object.entries(groups).map(([key, label]) => {
    const values = [...agg[key]];
    if (!values.length) return "";
    return `
      <h4 class="mabu-subhead">${label}${values.length > 1 ? "S" : ""}</h4>
      <div class="mabu-chip-group">
        ${values.map((v) => `
          <span class="mabu-chip">
            <span class="mabu-chip-type">${label}</span>
            <span class="mabu-chip-value">${mabuEscape(v)}</span>
            <button class="mabu-chip-btn" data-copy="${mabuEscape(v)}" title="copy" aria-label="copy ${mabuEscape(v)}">&#10697;</button>
          </span>
        `).join("")}
      </div>
    `;
  }).join("");
}

function mabuRenderAttachmentsGallery(entries) {
  const rows = [];
  entries.forEach((e) => {
    (e.attachments || []).forEach((a) => {
      rows.push({ entryId: e.entry_id, entryDate: e.date, ...a });
    });
  });

  if (!rows.length) {
    return `<div class="mabu-empty-state"><div class="mabu-empty-state-icon">·</div><h4>No attachments</h4><p>Attach files when adding an entry, from the Entries tab.</p></div>`;
  }

  return `<table class="mabu-table"><thead><tr><th>filename</th><th>type</th><th>added</th><th></th></tr></thead><tbody>${
    rows.map((a) => `
      <tr>
        <td>${mabuEscape(a.filename)}</td>
        <td>${mabuEscape(a.content_type || "–")}</td>
        <td>${mabuEscape((a.added || "").replace("T", " ").slice(0, 19))}</td>
        <td><button class="mabu-btn-secondary mabu-btn" data-entry="${mabuEscape(a.entryId)}" data-attachment="${mabuEscape(a.attachment_id)}" data-filename="${mabuEscape(a.filename)}">download</button></td>
      </tr>
    `).join("")
  }</tbody></table>`;
}

function mabuInitCaseTabs() {
  document.querySelectorAll(".mabu-tab[data-case-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".mabu-tab[data-case-tab]").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".mabu-tab-panel").forEach((p) => p.classList.toggle("active", p.id === `caseTab-${tab.dataset.caseTab}`));
    });
  });

  document.getElementById("caseDetailCard").addEventListener("click", (e) => {
    const copyBtn = e.target.closest("button[data-copy]");
    if (copyBtn) {
      navigator.clipboard?.writeText(copyBtn.dataset.copy).then(
        () => mabuToast("success", "Copied", copyBtn.dataset.copy),
        () => mabuToast("error", "Copy failed", "Clipboard access was denied.")
      );
    }
  });
}

async function mabuDeleteCase(filename, title) {
  const confirmed = await mabuConfirm({
    title: "Delete case permanently?",
    body: `"${title}" (${filename}) will be permanently deleted. This cannot be undone — there is no backup or recycle bin. Make sure you've exported/reported anything you need first.`,
    danger: true,
    confirmLabel: "delete permanently",
  });
  if (!confirmed) return;

  try {
    await mabuApi(`/api/cases/${encodeURIComponent(filename)}`, { method: "DELETE" });
    mabuToast("success", "Case deleted", title);
    if (mabuCurrentCaseFilename === filename) {
      document.getElementById("caseDetailCard").hidden = true;
      mabuCurrentCaseFilename = null;
      mabuCurrentCaseRecord = null;
    }
    mabuLoadVault();
    mabuLoadStats();
  } catch (e) {
    mabuToast("error", "Could not delete case", e.message);
  }
}

function mabuInitVault() {
  document.getElementById("vaultRefreshBtn").addEventListener("click", () => {
    mabuLoadVault();
    document.getElementById("caseDetailCard").hidden = true;
    mabuCurrentCaseFilename = null;
    mabuCurrentCaseRecord = null;
  });

  document.getElementById("caseDeleteBtn").addEventListener("click", () => {
    if (!mabuCurrentCaseFilename) return;
    const title = mabuCurrentCaseRecord?.title || mabuCurrentCaseFilename;
    mabuDeleteCase(mabuCurrentCaseFilename, title);
  });

  const runVaultSearch = async () => {
    const q = document.getElementById("vaultSearchInput").value.trim();
    const tbody = document.querySelector("#vaultTable tbody");
    if (!q) return mabuLoadVault();
    tbody.innerHTML = `<tr><td colspan="7"><div class="mabu-loading-state"><span class="mabu-spinner"></span> searching vault (title, tags, summary, findings, identifiers)...</div></td></tr>`;
    try {
      const { data } = await mabuApi(`/api/vault/search?q=${encodeURIComponent(q)}`);
      mabuRenderVaultRows(data.files || []);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="mabu-note">search failed: ${mabuEscape(e.message)}</td></tr>`;
    }
  };
  document.getElementById("vaultSearchBtn").addEventListener("click", runVaultSearch);
  document.getElementById("vaultSearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runVaultSearch();
  });

  document.getElementById("vaultPagePrev").addEventListener("click", () => {
    mabuVaultPage = Math.max(0, mabuVaultPage - 1);
    mabuRenderVaultPage();
  });
  document.getElementById("vaultPageNext").addEventListener("click", () => {
    mabuVaultPage += 1;
    mabuRenderVaultPage();
  });

  document.getElementById("caseStatusApplyBtn").addEventListener("click", async () => {
    if (!mabuCurrentCaseFilename) return;
    const status = document.getElementById("caseStatusSelect").value;
    const previousStatus = mabuCurrentCaseRecord?.status;
    if (status === previousStatus) return;

    const confirmed = await mabuConfirm({
      title: "Change case status?",
      body: `Set this case's status to "${status}"? This is recorded in the case's activity log.`,
      confirmLabel: "set status",
    });
    if (!confirmed) {
      document.getElementById("caseStatusSelect").value = previousStatus || "open";
      return;
    }

    try {
      await mabuApi(`/api/cases/${encodeURIComponent(mabuCurrentCaseFilename)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, passphrase: null }),
      });
      mabuToast("success", "Status updated", `Case is now "${status}".`);
      mabuOpenCaseDetail(mabuCurrentCaseFilename);
      mabuLoadVault();
    } catch (e) {
      mabuToast("error", "Could not set status", e.message);
    }
  });

  async function mabuDownloadCaseReport() {
    if (!mabuCurrentCaseFilename) return;
    try {
      const res = await mabuFetch("/api/report/case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: mabuCurrentCaseFilename, passphrase: null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `report generation failed (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = mabuCurrentCaseFilename.replace(".mabu", "") + "_report.pdf";
      a.click();
      URL.revokeObjectURL(url);
      mabuToast("success", "Report generated", "PDF download started.");
    } catch (e) {
      mabuToast("error", "Could not generate report", e.message);
    }
  }
  document.getElementById("caseReportBtn").addEventListener("click", mabuDownloadCaseReport);
  document.getElementById("caseReportBtnTab").addEventListener("click", mabuDownloadCaseReport);

  document.getElementById("ceAddBtn").addEventListener("click", async () => {
    if (!mabuCurrentCaseFilename) {
      mabuToast("warning", "No case open", "Open a case from the vault list first.");
      return;
    }
    const statusEl = document.getElementById("ceStatus");
    statusEl.textContent = "adding entry...";
    statusEl.style.color = "var(--mabu-text-dim)";

    const fileInput = document.getElementById("ceAttachments");
    const files = Array.from(fileInput.files || []);
    const attachments = [];
    try {
      for (const f of files) {
        const b64 = await mabuFileToBase64(f);
        attachments.push({ filename: f.name, content_type: f.type, data_b64: b64 });
      }
    } catch (e) {
      statusEl.textContent = `error reading attachment: ${e.message}`;
      statusEl.style.color = "var(--mabu-red)";
      return;
    }

    const payload = {
      author: document.getElementById("ceAuthor").value.trim() || undefined,
      summary: document.getElementById("ceSummary").value.trim(),
      findings: document.getElementById("ceFindings").value.trim(),
      emails: mabuSplitList(document.getElementById("ceEmails").value),
      usernames: mabuSplitList(document.getElementById("ceUsernames").value),
      ips: mabuSplitList(document.getElementById("ceIps").value),
      attachments,
      passphrase: null,
    };

    try {
      await mabuApi(`/api/cases/${encodeURIComponent(mabuCurrentCaseFilename)}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      statusEl.textContent = "entry added.";
      statusEl.style.color = "var(--mabu-green)";
      mabuToast("success", "Entry added", "The new entry was saved to the case.");
      ["ceAuthor", "ceSummary", "ceFindings", "ceEmails", "ceUsernames", "ceIps"].forEach((id) => (document.getElementById(id).value = ""));
      fileInput.value = "";
      mabuOpenCaseDetail(mabuCurrentCaseFilename);
      mabuLoadVault();
    } catch (e) {
      statusEl.textContent = `error: ${e.message}`;
      statusEl.style.color = "var(--mabu-red)";
    }
  });

  document.getElementById("caseDetailCard").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-attachment]");
    if (!btn || !mabuCurrentCaseFilename) return;
    try {
      const res = await mabuFetch(
        `/api/cases/${encodeURIComponent(mabuCurrentCaseFilename)}/attachments/${encodeURIComponent(btn.dataset.entry)}/${encodeURIComponent(btn.dataset.attachment)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase: null }) }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `download failed (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = btn.dataset.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      mabuToast("error", "Could not download attachment", err.message);
    }
  });

  mabuInitCaseTabs();
}

async function mabuLoadStats() {
  try {
    const res = await mabuFetch("/api/vault/list");
    const data = await res.json();
    const files = data.files || [];
    document.getElementById("statFileCount").textContent = files.length;
    const tagSet = new Set();
    let idCount = 0;
    files.forEach((f) => {
      (f.tags || []).forEach((t) => tagSet.add(t.toLowerCase()));
    });
    idCount = mabuLoadJSON("mabu_discord_users").length + mabuLoadJSON("mabu_platforms").length;
    document.getElementById("statTagCount").textContent = tagSet.size;
    document.getElementById("statIdCount").textContent = idCount;
  } catch (e) {
    document.getElementById("statFileCount").textContent = "–";
    document.getElementById("statTagCount").textContent = "–";
    document.getElementById("statIdCount").textContent = "–";
  }
}

/* ---------------- Reader ---------------- */

async function mabuLoadReaderFileList() {
  const sel = document.getElementById("readerFileSelect");
  sel.innerHTML = `<option value="">-- choose a file --</option>`;
  try {
    const res = await mabuFetch("/api/vault/list");
    const data = await res.json();
    (data.files || []).forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.filename;
      opt.textContent = `${f.title || f.filename} (${f.updated || "no date"})`;
      sel.appendChild(opt);
    });
  } catch (e) {
    /* leave default option */
  }
}

function mabuInitReader() {
  document.getElementById("readerDecryptBtn").addEventListener("click", async () => {
    const filename = document.getElementById("readerFileSelect").value;
    const passphrase = document.getElementById("readerPassphrase").value;
    const statusEl = document.getElementById("readerStatus");
    const output = document.getElementById("readerOutput");
    const exportBtn = document.getElementById("readerExportBtn");

    if (!filename) {
      statusEl.textContent = "select a file first.";
      statusEl.style.color = "var(--mabu-amber)";
      return;
    }

    statusEl.textContent = "decrypting...";
    statusEl.style.color = "var(--mabu-text-dim)";

    try {
      const res = await mabuFetch("/api/vault/decrypt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, passphrase: passphrase || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Decryption failed");

      statusEl.textContent = "decrypted successfully.";
      statusEl.style.color = "var(--mabu-green)";

      const rec = data.record;
      output.innerHTML = mabuRenderRecord(rec);
      exportBtn.hidden = false;
      exportBtn.onclick = () => {
        const blob = new Blob([JSON.stringify(rec, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = (rec.title || "mabu-export").replace(/\s+/g, "_") + ".json";
        a.click();
        URL.revokeObjectURL(url);
      };
    } catch (e) {
      statusEl.textContent = `error: ${e.message}`;
      statusEl.style.color = "var(--mabu-red)";
      output.innerHTML = `<p class="mabu-note">decryption failed. check passphrase and try again.</p>`;
      exportBtn.hidden = true;
    }
  });
}

function mabuRenderRecord(rec) {
  const listField = (arr) => (arr && arr.length ? arr.map(mabuEscape).join(", ") : "–");
  const entries = rec.entries || [];
  const entriesHtml = entries.map((e, i) => `
    <h4>entry ${i + 1} — ${mabuEscape((e.date || "").replace("T", " ").slice(0, 19))} by ${mabuEscape(e.author || "-")}</h4>
    <p>summary: ${mabuEscape(e.summary || "–")}</p>
    <p>findings: ${mabuEscape(e.findings || "–")}</p>
    <p>emails: ${listField(e.emails)} | usernames: ${listField(e.usernames)} | ips: ${listField(e.ips)}</p>
  `).join("");

  return `
    <h4>title</h4><p>${mabuEscape(rec.title || "–")}</p>
    <h4>case_id</h4><p>${mabuEscape(rec.case_id || "–")}</p>
    <h4>status</h4><p>${mabuEscape(rec.status || "–")}</p>
    <h4>investigator</h4><p>${mabuEscape(rec.investigator || "–")}</p>
    <h4>tags</h4><p>${listField(rec.tags)}</p>
    <h4>entries (${entries.length})</h4>
    ${entriesHtml || "<p>(none)</p>"}
  `;
}

/* ---------------- Timeline / Relationship Graph ---------------- */

async function mabuFetchFullRecords() {
  const res = await mabuFetch("/api/vault/list");
  const data = await res.json();
  const files = data.files || [];
  const records = [];

  for (const f of files) {
    if (f.locked) continue;
    try {
      const dRes = await mabuFetch("/api/vault/decrypt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: f.filename, passphrase: null }),
      });
      if (!dRes.ok) continue;
      const dData = await dRes.json();
      records.push({ filename: f.filename, ...dData.record });
    } catch (e) {
      /* skip */
    }
  }
  return records;
}

let mabuTimelineRecords = [];

async function mabuLoadTimeline() {
  const track = document.getElementById("timelineTrack");
  track.innerHTML = `<div class="mabu-loading-state"><span class="mabu-spinner"></span> decrypting vault entries...</div>`;

  let records;
  try {
    records = await mabuFetchFullRecords();
  } catch (e) {
    track.innerHTML = `<div class="mabu-empty-state"><div class="mabu-empty-state-icon">?</div><h4>Could not reach API</h4><p>Is mabu-server.py running?</p></div>`;
    return;
  }

  mabuTimelineRecords = records;
  mabuRenderTimeline();

  if (!records.length) {
    document.getElementById("graphSvg").innerHTML = "";
    return;
  }

  mabuRenderGraph(mabuBuildGraphFromRecords(records), "graphSvg", "timeline");
}

function mabuRenderTimeline() {
  const track = document.getElementById("timelineTrack");
  const caseFilter = document.getElementById("timelineCaseFilter").value.trim().toLowerCase();
  const statusFilter = document.getElementById("timelineStatusFilter").value;

  let records = mabuTimelineRecords.filter((r) => {
    if (caseFilter && !(r.title || r.filename || "").toLowerCase().includes(caseFilter)) return false;
    if (statusFilter && (r.status || "open") !== statusFilter) return false;
    return true;
  });

  if (!records.length) {
    track.innerHTML = `<div class="mabu-empty-state"><div class="mabu-empty-state-icon">·</div><h4>No matching entries</h4><p>Create a case without a custom passphrase to see it here, or adjust your filters.</p></div>`;
    return;
  }

  records = records.slice().sort((a, b) => new Date(b.updated || b.created) - new Date(a.updated || a.created));

  track.innerHTML = records.map((r) => {
    const entries = r.entries || [];
    const lastEntry = entries[entries.length - 1];
    return `
      <div class="mabu-timeline-item">
        <div class="mabu-timeline-date">${mabuEscape((r.updated || r.created || "").replace("T", " ").slice(0, 19))} UTC — status: ${mabuEscape(r.status || "open")}</div>
        <div class="mabu-timeline-title" data-open-case="${mabuEscape(r.filename)}" style="cursor:pointer;" title="open case">${mabuEscape(r.title || r.filename)}</div>
        <div class="mabu-timeline-summary">${mabuEscape((lastEntry && lastEntry.summary) || "(no entries)")} — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}</div>
      </div>
    `;
  }).join("");

  track.querySelectorAll("[data-open-case]").forEach((el) => {
    el.addEventListener("click", () => {
      mabuGoTo("vault");
      setTimeout(() => mabuOpenCaseDetail(el.dataset.openCase), 50);
    });
  });
}

function mabuRecordIdentifiers(r, typeFilter) {
  const ids = new Set();
  const keys = typeFilter ? [typeFilter] : ["emails", "usernames", "ips", "names", "phones"];
  (r.entries || []).forEach((e) => {
    keys.forEach((k) => (e[k] || []).forEach((v) => v && ids.add(v.toLowerCase())));
  });
  return ids;
}

/* Builds a graph model {nodes, edges} from full decrypted case records,
   using the SAME union-find-free pairwise-intersection approach for both
   Timeline and (as a fallback) Correlate, so the two views can't silently
   disagree about what counts as "shared." */
function mabuBuildGraphFromRecords(records, typeFilter) {
  const nodes = records.map((r, i) => ({
    id: r.filename || String(i),
    label: r.title || r.filename,
    filename: r.filename,
    identifiers: mabuRecordIdentifiers(r, typeFilter),
  }));

  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = [...nodes[i].identifiers].filter((id) => nodes[j].identifiers.has(id));
      if (shared.length > 0) edges.push({ from: nodes[i].id, to: nodes[j].id, shared });
    }
  }

  return { nodes, edges };
}

/* ---------------- Graph renderer: zoom/pan/select/click-panel ---------------- */

const mabuGraphState = {};

function mabuRenderGraph(graph, svgId, contextKey) {
  const svg = document.getElementById(svgId);
  const width = Math.max(600, svg.parentElement.clientWidth - 20);
  const height = 380;
  const svgNS = "http://www.w3.org/2000/svg";
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const { nodes, edges } = graph;
  mabuGraphState[contextKey] = { graph, svgId, width, height, selected: null, zoom: 1, panX: 0, panY: 0 };

  if (!nodes.length) {
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", width / 2);
    text.setAttribute("y", height / 2);
    text.setAttribute("text-anchor", "middle");
    text.textContent = "no data to graph";
    svg.appendChild(text);
    return;
  }

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 60;
  const positions = {};
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1);
    positions[n.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });

  const g = document.createElementNS(svgNS, "g");
  g.setAttribute("id", `${svgId}-viewport`);
  svg.appendChild(g);

  edges.forEach((e) => {
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("class", "edge");
    line.setAttribute("data-from", e.from);
    line.setAttribute("data-to", e.to);
    line.setAttribute("x1", positions[e.from].x);
    line.setAttribute("y1", positions[e.from].y);
    line.setAttribute("x2", positions[e.to].x);
    line.setAttribute("y2", positions[e.to].y);
    const title = document.createElementNS(svgNS, "title");
    title.textContent = `shared: ${e.shared.join(", ")}`;
    line.appendChild(title);
    g.appendChild(line);
  });

  nodes.forEach((n) => {
    const pos = positions[n.id];
    const circle = document.createElementNS(svgNS, "circle");
    circle.setAttribute("class", "node");
    circle.setAttribute("data-node-id", n.id);
    circle.setAttribute("cx", pos.x);
    circle.setAttribute("cy", pos.y);
    circle.setAttribute("r", 8);
    circle.addEventListener("click", () => mabuSelectGraphNode(contextKey, n.id));
    g.appendChild(circle);

    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", pos.x);
    text.setAttribute("y", pos.y - 12);
    text.setAttribute("text-anchor", "middle");
    text.textContent = n.label.length > 18 ? n.label.slice(0, 16) + "…" : n.label;
    g.appendChild(text);
  });

  mabuApplyGraphTransform(contextKey);
}

function mabuApplyGraphTransform(contextKey) {
  const state = mabuGraphState[contextKey];
  if (!state) return;
  const viewport = document.getElementById(`${state.svgId}-viewport`);
  if (!viewport) return;
  viewport.setAttribute("transform", `translate(${state.panX},${state.panY}) scale(${state.zoom})`);
}

function mabuZoomGraph(contextKey, factor) {
  const state = mabuGraphState[contextKey];
  if (!state) return;
  state.zoom = Math.max(0.3, Math.min(3, state.zoom * factor));
  mabuApplyGraphTransform(contextKey);
}

function mabuResetGraphView(contextKey) {
  const state = mabuGraphState[contextKey];
  if (!state) return;
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  mabuApplyGraphTransform(contextKey);
}

function mabuSelectGraphNode(contextKey, nodeId) {
  const state = mabuGraphState[contextKey];
  if (!state) return;
  state.selected = nodeId;

  const svg = document.getElementById(state.svgId);
  const node = state.graph.nodes.find((n) => n.id === nodeId);
  const connectedIds = new Set([nodeId]);
  const relatedEdges = state.graph.edges.filter((e) => e.from === nodeId || e.to === nodeId);
  relatedEdges.forEach((e) => { connectedIds.add(e.from); connectedIds.add(e.to); });

  svg.querySelectorAll("circle.node").forEach((c) => {
    const id = c.dataset.nodeId;
    c.classList.toggle("selected", id === nodeId);
    c.classList.toggle("dim", !connectedIds.has(id));
  });
  svg.querySelectorAll("line.edge").forEach((l) => {
    const touches = l.dataset.from === nodeId || l.dataset.to === nodeId;
    l.classList.toggle("dim", !touches);
  });

  const panelId = contextKey === "correlate" ? "correlatePanel" : "timelinePanel";
  const panel = document.getElementById(panelId);
  if (!panel || !node) return;

  const references = relatedEdges.map((e) => {
    const otherId = e.from === nodeId ? e.to : e.from;
    const other = state.graph.nodes.find((n) => n.id === otherId);
    return { title: other ? other.label : otherId, filename: otherId, shared: e.shared };
  });

  panel.hidden = false;
  panel.innerHTML = `
    <div class="mabu-kv"><span>case</span><b>${mabuEscape(node.label)}</b></div>
    <div class="mabu-kv"><span>identifiers</span><b>${[...node.identifiers].map(mabuEscape).join(", ") || "(none)"}</b></div>
    ${references.length ? `
      <h4 class="mabu-subhead" style="margin-top:10px;">potential connections (${references.length})</h4>
      ${references.map((r) => `
        <div class="mabu-connection-card">
          <div class="mabu-connection-title">shared identifier</div>
          <div class="mabu-connection-evidence">${mabuEscape(node.label)} &harr; ${mabuEscape(r.title)}<br>via: ${r.shared.map(mabuEscape).join(", ")}</div>
          <div class="mabu-connection-assessment">assessment: potential connection — not confirmed to be the same person</div>
          <div class="mabu-actions" style="margin-top:8px;">
            <button class="mabu-btn mabu-btn-secondary" data-open-case="${mabuEscape(r.filename)}">open_case()</button>
          </div>
        </div>
      `).join("")}
    ` : `<p class="mabu-note" style="margin-top:8px;">no connections to other cases found for this node.</p>`}
  `;

  panel.querySelectorAll("[data-open-case]").forEach((btn) => {
    btn.addEventListener("click", () => {
      mabuGoTo("vault");
      setTimeout(() => mabuOpenCaseDetail(btn.dataset.openCase), 50);
    });
  });
}

function mabuInitGraphControls(prefix, contextKey, svgId, reloadFn) {
  document.getElementById(`${prefix}ZoomIn`).addEventListener("click", () => mabuZoomGraph(contextKey, 1.2));
  document.getElementById(`${prefix}ZoomOut`).addEventListener("click", () => mabuZoomGraph(contextKey, 1 / 1.2));
  document.getElementById(`${prefix}ZoomReset`).addEventListener("click", () => mabuResetGraphView(contextKey));
  document.getElementById(`${prefix}ZoomFit`).addEventListener("click", () => mabuResetGraphView(contextKey));

  const svg = document.getElementById(svgId);
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  svg.addEventListener("mousedown", (e) => {
    if (e.target.closest("circle.node")) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const state = mabuGraphState[contextKey];
    if (!state) return;
    state.panX += e.clientX - lastX;
    state.panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    mabuApplyGraphTransform(contextKey);
  });
  window.addEventListener("mouseup", () => { dragging = false; });
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    mabuZoomGraph(contextKey, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
}

/* ---------------- Correlation Engine ---------------- */

let mabuCorrelateData = null;

async function mabuLoadCorrelation() {
  const clustersEl = document.getElementById("correlateClusters");
  const summaryEl = document.getElementById("correlateSummary");
  clustersEl.innerHTML = `<div class="mabu-loading-state"><span class="mabu-spinner"></span> scanning vault for shared identifiers...</div>`;
  summaryEl.innerHTML = "";

  try {
    const { data } = await mabuApi("/api/correlate");
    mabuCorrelateData = data;

    const totalIdentifiers = new Set(data.nodes.flatMap((n) => n.identifiers)).size;
    summaryEl.innerHTML = `
      <div class="mabu-kv"><span>cases scanned</span><b>${data.nodes.length}</b></div>
      <div class="mabu-kv"><span>unique identifiers seen</span><b>${totalIdentifiers}</b></div>
      <div class="mabu-kv"><span>potential connections found</span><b>${data.edges.length}</b></div>
      <div class="mabu-kv"><span>clusters</span><b>${data.clusters.length}</b></div>
    `;

    if (!data.clusters.length) {
      clustersEl.innerHTML = `<div class="mabu-empty-state"><div class="mabu-empty-state-icon">·</div><h4>No connections found</h4><p>No shared identifiers were found among the decryptable cases in the vault.</p></div>`;
    } else {
      clustersEl.innerHTML = data.clusters.map((cluster, i) => {
        const clusterEdges = data.edges.filter((e) => cluster.filenames.includes(e.from) && cluster.filenames.includes(e.to));
        const titleFor = (fname) => (data.nodes.find((n) => n.filename === fname) || {}).title || fname;
        return `
        <div class="mabu-connection-card" style="margin-bottom:12px;">
          <div class="mabu-connection-title">cluster ${i + 1} — ${cluster.size} related cases</div>
          <div class="mabu-connection-evidence">
            ${clusterEdges.map((e) => `${mabuEscape(titleFor(e.from))} &harr; ${mabuEscape(titleFor(e.to))} <span class="mabu-note">(shared: ${e.shared.map(mabuEscape).join(", ")})</span>`).join("<br>")}
          </div>
          <div class="mabu-connection-assessment">assessment: potential connection between these cases via shared identifier(s) — not confirmed to be the same individual</div>
          <div class="mabu-actions" style="margin-top:8px;">
            <button class="mabu-btn mabu-btn-secondary" data-cluster="${i}">download_cluster_report()</button>
          </div>
        </div>
      `;
      }).join("");

      clustersEl.querySelectorAll("button[data-cluster]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const cluster = data.clusters[Number(btn.dataset.cluster)];
          try {
            const res2 = await mabuFetch("/api/report/cluster", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filenames: cluster.filenames, passphrase: null }),
            });
            if (!res2.ok) {
              const errData = await res2.json().catch(() => ({}));
              throw new Error(errData.error || `report failed (HTTP ${res2.status})`);
            }
            const blob = await res2.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "mabu_cluster_report.pdf";
            a.click();
            URL.revokeObjectURL(url);
            mabuToast("success", "Cluster report generated", "PDF download started.");
          } catch (e) {
            mabuToast("error", "Could not generate cluster report", e.message);
          }
        });
      });
    }

    mabuRenderCorrelateGraph();
  } catch (e) {
    clustersEl.innerHTML = `<div class="mabu-empty-state"><div class="mabu-empty-state-icon">?</div><h4>Could not reach API</h4><p>${mabuEscape(e.message)}</p></div>`;
  }
}

function mabuRenderCorrelateGraph() {
  if (!mabuCorrelateData) return;
  const typeFilter = document.getElementById("correlateIdFilter").value;

  const nodes = mabuCorrelateData.nodes.map((n) => ({
    id: n.filename,
    label: n.title || n.filename,
    filename: n.filename,
    identifiers: new Set(n.identifiers),
  }));

  let edges = mabuCorrelateData.edges.map((e) => ({ from: e.from, to: e.to, shared: e.shared }));
  if (typeFilter) {
    const byFile = {};
    mabuCorrelateData.nodes.forEach((n) => { byFile[n.filename] = new Set(n.identifier_detail?.[typeFilter] || []); });
    edges = edges
      .map((e) => ({ ...e, shared: e.shared.filter((s) => (byFile[e.from] || new Set()).has(s) && (byFile[e.to] || new Set()).has(s)) }))
      .filter((e) => e.shared.length > 0);
  }

  mabuRenderGraph({ nodes, edges }, "correlateGraphSvg", "correlate");
}

function mabuInitCorrelate() {
  document.getElementById("correlateRefreshBtn").addEventListener("click", mabuLoadCorrelation);
  document.getElementById("correlateIdFilter").addEventListener("change", mabuRenderCorrelateGraph);
  mabuInitGraphControls("correlate", "correlate", "correlateGraphSvg", mabuLoadCorrelation);
}

function mabuInitTimeline() {
  document.getElementById("timelineRefreshBtn").addEventListener("click", mabuLoadTimeline);
  document.getElementById("timelineCaseFilter").addEventListener("input", mabuRenderTimeline);
  document.getElementById("timelineStatusFilter").addEventListener("change", mabuRenderTimeline);
  mabuInitGraphControls("timeline", "timeline", "graphSvg", mabuLoadTimeline);
}

/* ---------------- Public Record Lookups ---------------- */

function mabuRenderKv(container, obj) {
  container.hidden = false;
  container.innerHTML = Object.entries(obj).map(([k, v]) => {
    const display = Array.isArray(v) ? (v.length ? v.join(", ") : "(none)") : (v ?? "(none)");
    return `<div class="mabu-kv"><span>${mabuEscape(k)}</span><b>${mabuEscape(display)}</b></div>`;
  }).join("");
}

function mabuLoadingBox(box, message) {
  box.hidden = false;
  box.innerHTML = `<div class="mabu-loading-state"><span class="mabu-spinner"></span> ${mabuEscape(message)}</div>`;
}

function mabuErrorBox(box, message) {
  box.hidden = false;
  box.innerHTML = `<div class="mabu-empty-state" style="padding:16px 0;"><div class="mabu-empty-state-icon">?</div><p style="margin:0;">${mabuEscape(message)}</p></div>`;
}

function mabuInitLookups() {
  document.getElementById("whoisBtn").addEventListener("click", async () => {
    const domain = document.getElementById("whoisInput").value.trim();
    const box = document.getElementById("whoisResult");
    if (!domain) return;
    mabuLoadingBox(box, "querying WHOIS server...");
    try {
      const { data } = await mabuApi(`/api/lookup/whois?domain=${encodeURIComponent(domain)}`);
      if (data.error) { mabuErrorBox(box, data.error); return; }
      const order = ["domain", "registrar", "creation_date", "updated_date", "expiration_date", "status", "name_servers", "org", "country", "emails"];
      const ordered = {};
      order.forEach((k) => { if (k in data) ordered[k] = data[k]; });
      Object.keys(data).forEach((k) => { if (!(k in ordered)) ordered[k] = data[k]; });
      mabuRenderKv(box, ordered);
    } catch (e) {
      mabuErrorBox(box, e.message);
    }
  });

  document.getElementById("dnsBtn").addEventListener("click", async () => {
    const domain = document.getElementById("dnsInput").value.trim();
    const box = document.getElementById("dnsResult");
    if (!domain) return;
    mabuLoadingBox(box, "resolving DNS records...");
    try {
      const { data } = await mabuApi(`/api/lookup/dns?domain=${encodeURIComponent(domain)}`);
      if (data.error && !data.a_records?.length) { mabuErrorBox(box, data.error); return; }
      box.hidden = false;
      box.innerHTML = `
        <div class="mabu-kv"><span>A records</span><b>${(data.a_records || []).join(", ") || "(none)"}</b></div>
        <div class="mabu-kv"><span>reverse DNS (PTR)</span><b>${mabuEscape(data.reverse_dns || "(none)")}</b></div>
        <div class="mabu-kv"><span>aliases (CNAME)</span><b>${(data.aliases || []).join(", ") || "(none)"}</b></div>
        ${data.error ? `<div class="mabu-kv"><span>note</span><b>${mabuEscape(data.error)}</b></div>` : ""}
      `;
    } catch (e) {
      mabuErrorBox(box, e.message);
    }
  });

  document.getElementById("handleCheckBtn").addEventListener("click", async () => {
    const username = document.getElementById("handleCheckInput").value.trim();
    const table = document.getElementById("handleCheckTable");
    const tbody = table.querySelector("tbody");
    if (!username) return;
    table.hidden = false;
    tbody.innerHTML = `<tr><td colspan="5"><div class="mabu-loading-state"><span class="mabu-spinner"></span> checking platforms live (this takes a few seconds)...</div></td></tr>`;
    try {
      const { data } = await mabuApi(`/api/lookup/handle?username=${encodeURIComponent(username)}`);
      const checkedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
      const existsLabel = (v) => (v === true ? "likely yes" : v === false ? "likely no" : "inconclusive");
      tbody.innerHTML = data.results.map((r) => `
        <tr>
          <td>${mabuEscape(r.platform)}</td>
          <td><a href="${r.url}" target="_blank" rel="noopener noreferrer">${mabuEscape(r.url)}</a></td>
          <td>${mabuEscape(r.detail)}</td>
          <td>${existsLabel(r.likely_exists)}</td>
          <td>${checkedAt} UTC</td>
        </tr>
      `).join("");
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="mabu-note">error: ${mabuEscape(e.message)}</td></tr>`;
    }
  });

  document.getElementById("phoneLookupBtn").addEventListener("click", async () => {
    const number = document.getElementById("phoneInput").value.trim();
    const region = document.getElementById("phoneRegion").value.trim() || "US";
    const box = document.getElementById("phoneResult");
    if (!number) return;
    mabuLoadingBox(box, "parsing locally...");
    try {
      const { data } = await mabuApi(`/api/lookup/phone?number=${encodeURIComponent(number)}&region=${encodeURIComponent(region)}`);
      if (data.error) { mabuErrorBox(box, data.error); return; }
      box.hidden = false;
      box.innerHTML = `
        <div class="mabu-kv"><span>valid</span><b>${data.valid ? "yes" : "no"}</b></div>
        <div class="mabu-kv"><span>possible</span><b>${data.possible ? "yes" : "no"}</b></div>
        <div class="mabu-kv"><span>e164</span><b>${mabuEscape(data.e164 || "–")}</b></div>
        <div class="mabu-kv"><span>national format</span><b>${mabuEscape(data.national || "–")}</b></div>
        <div class="mabu-kv"><span>country code</span><b>${mabuEscape(data.country_code ?? "–")}</b></div>
        <div class="mabu-kv"><span>region (offline db)</span><b>${mabuEscape(data.region || "unknown")}</b></div>
        <div class="mabu-kv"><span>carrier block (offline db)</span><b>${mabuEscape(data.carrier || "not available for this number")}</b></div>
        <div class="mabu-kv"><span>timezone(s) (offline db)</span><b>${(data.timezones || []).join(", ") || "unknown"}</b></div>
        <div class="mabu-kv"><span>number type</span><b>${mabuEscape(data.number_type || "–")}</b></div>
        <p class="mabu-note" style="margin-top:8px;">All fields come from libphonenumber's bundled offline data (based on number-range allocation), not a live carrier or subscriber lookup — this cannot identify who owns the number.</p>
      `;
    } catch (e) {
      mabuErrorBox(box, e.message);
    }
  });

  mabuFetch("/api/lookup/breach-status").then((r) => r.json()).then((data) => {
    const note = document.getElementById("breachStatusNote");
    note.textContent = data.configured
      ? "using the official HaveIBeenPwned API with your configured key."
      : "not configured — set MABU_HIBP_API_KEY on the server to enable this (requires your own paid HIBP API key).";
  }).catch(() => {});

  document.getElementById("breachCheckBtn").addEventListener("click", async () => {
    const email = document.getElementById("breachInput").value.trim();
    const box = document.getElementById("breachResult");
    if (!email) return;
    mabuLoadingBox(box, "querying HaveIBeenPwned API...");
    try {
      const res = await mabuFetch(`/api/lookup/breach?email=${encodeURIComponent(email)}`);
      const data = await res.json();
      if (data.error) {
        mabuErrorBox(box, data.error);
        return;
      }
      if (!data.breached) {
        box.hidden = false;
        box.innerHTML = `<div class="mabu-empty-state" style="padding:16px 0;"><div class="mabu-empty-state-icon">OK</div><p style="margin:0;">No breaches found for this email in the HIBP database.</p></div>`;
        return;
      }
      box.hidden = false;
      box.innerHTML = `<div class="mabu-kv"><span>breach count</span><b>${data.breach_count}</b></div>` +
        data.breaches.map((b) => `
          <div class="mabu-kv"><span>${mabuEscape(b.title)}</span><b>${mabuEscape(b.breach_date)} — ${mabuEscape((b.data_classes || []).join(", "))}</b></div>
        `).join("");
    } catch (e) {
      mabuErrorBox(box, e.message);
    }
  });

  document.getElementById("imageMetaBtn").addEventListener("click", async () => {
    const fileInput = document.getElementById("imageMetaInput");
    const box = document.getElementById("imageMetaResult");
    const file = fileInput.files[0];
    if (!file) return;
    mabuLoadingBox(box, "extracting metadata locally...");
    try {
      const b64 = await mabuFileToBase64(file);
      const res = await mabuFetch("/api/lookup/image-metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data_b64: b64 }),
      });
      const data = await res.json();
      if (data.error) {
        mabuErrorBox(box, data.error);
        return;
      }
      let html = `
        <div class="mabu-kv"><span>file</span><b>${mabuEscape(file.name)}</b></div>
        <div class="mabu-kv"><span>size</span><b>${(file.size / 1024).toFixed(1)} KB</b></div>
        <div class="mabu-kv"><span>format</span><b>${mabuEscape(data.format)}</b></div>
        <div class="mabu-kv"><span>dimensions</span><b>${data.size.width} x ${data.size.height}</b></div>
      `;
      if (data.gps) {
        html += `<div class="mabu-kv"><span><span class="mabu-provenance" data-kind="observed">gps found</span></span><b><a href="${data.gps.maps_url}" target="_blank" rel="noopener noreferrer">${data.gps.latitude}, ${data.gps.longitude}</a></b></div>`;
      } else {
        html += `<div class="mabu-kv"><span>gps</span><b>(none found in EXIF)</b></div>`;
      }
      const exifEntries = Object.entries(data.exif || {});
      if (exifEntries.length) {
        html += `<h4 class="mabu-subhead" style="margin-top:10px;">exif fields</h4>`;
        html += exifEntries.map(([k, v]) => `<div class="mabu-kv"><span>${mabuEscape(k)}</span><b>${mabuEscape(v)}</b></div>`).join("");
      } else {
        html += `<p class="mabu-note" style="margin-top:8px;">No EXIF metadata found in this image.</p>`;
      }
      box.hidden = false;
      box.innerHTML = html;
    } catch (e) {
      mabuErrorBox(box, e.message);
    }
  });
}

function mabuFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------- Admin: Users & Audit Log ---------------- */

let mabuAuditCache = [];

async function mabuLoadAdminPanel() {
  await mabuLoadUsers();
  await mabuLoadAuditLog();
  await mabuLoadSystemStatus();
}

async function mabuLoadUsers() {
  const tbody = document.querySelector("#usersTable tbody");
  tbody.innerHTML = `<tr><td colspan="6" class="mabu-note">loading...</td></tr>`;
  try {
    const { data } = await mabuApi("/api/users");
    const users = data.users || [];
    if (!users.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="mabu-note">no users found.</td></tr>`;
      return;
    }

    tbody.innerHTML = users.map((u) => {
      const isSelf = u.username === mabuCurrentUser.username;
      const roleControl = isSelf
        ? `${mabuEscape(u.role)} <span class="mabu-note">(you)</span>`
        : `<select data-role-user="${mabuEscape(u.username)}" aria-label="role for ${mabuEscape(u.username)}">
             <option value="investigator" ${u.role === "investigator" ? "selected" : ""}>investigator</option>
             <option value="admin" ${u.role === "admin" ? "selected" : ""}>admin</option>
           </select>`;
      return `
      <tr>
        <td>${mabuEscape(u.username)}</td>
        <td>${roleControl}</td>
        <td>${u.active ? "active" : "deactivated"}</td>
        <td>${mabuEscape((u.created || "").slice(0, 19).replace("T", " "))}</td>
        <td>${mabuEscape((u.last_login || "").slice(0, 19).replace("T", " ") || "never")}</td>
        <td>
          ${!isSelf && u.active ? `<button class="mabu-btn-danger" data-action="deactivate" data-user="${mabuEscape(u.username)}">deactivate</button>` : ""}
          ${!isSelf && !u.active ? `<button class="mabu-btn-secondary mabu-btn" data-action="reactivate" data-user="${mabuEscape(u.username)}">reactivate</button>` : ""}
          <button class="mabu-btn-secondary mabu-btn" data-action="reset" data-user="${mabuEscape(u.username)}">reset_pw</button>
          ${!isSelf ? `<button class="mabu-btn-danger" data-action="delete" data-user="${mabuEscape(u.username)}">delete</button>` : ""}
        </td>
      </tr>
    `;
    }).join("");

    tbody.querySelectorAll("select[data-role-user]").forEach((sel) => {
      sel.addEventListener("change", async () => {
        const username = sel.dataset.roleUser;
        const newRole = sel.value;
        const confirmed = await mabuConfirm({
          title: "Change role?",
          body: `Change ${username}'s role to ${newRole}? This takes effect immediately.`,
          confirmLabel: "change role",
        });
        if (!confirmed) { mabuLoadUsers(); return; }
        try {
          await mabuApi(`/api/users/${encodeURIComponent(username)}/role`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ role: newRole }),
          });
          mabuToast("success", "Role changed", `${username} is now ${newRole}.`);
          mabuLoadUsers();
        } catch (e) {
          mabuToast("error", "Role change failed", e.message);
          mabuLoadUsers();
        }
      });
    });

    tbody.querySelectorAll("button[data-action='deactivate']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const username = btn.dataset.user;
        const confirmed = await mabuConfirm({
          title: "Deactivate user?",
          body: `${username} will be unable to log in until reactivated. This does not delete their data.`,
          danger: true,
          confirmLabel: "deactivate",
        });
        if (!confirmed) return;
        try {
          await mabuApi(`/api/users/${encodeURIComponent(username)}/deactivate`, { method: "POST" });
          mabuToast("success", "User deactivated", username);
          mabuLoadUsers();
        } catch (e) {
          mabuToast("error", "Deactivate failed", e.message);
        }
      });
    });
    tbody.querySelectorAll("button[data-action='reactivate']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await mabuApi(`/api/users/${encodeURIComponent(btn.dataset.user)}/reactivate`, { method: "POST" });
          mabuToast("success", "User reactivated", btn.dataset.user);
          mabuLoadUsers();
        } catch (e) {
          mabuToast("error", "Reactivate failed", e.message);
        }
      });
    });
    tbody.querySelectorAll("button[data-action='delete']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const username = btn.dataset.user;
        const confirmed = await mabuConfirm({
          title: "Delete user account?",
          body: `This permanently removes ${username}'s account. This cannot be undone. Their case files are not affected.`,
          danger: true,
          confirmLabel: "delete permanently",
        });
        if (!confirmed) return;
        try {
          await mabuApi(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
          mabuToast("success", "User deleted", username);
          mabuLoadUsers();
        } catch (e) {
          mabuToast("error", "Delete failed", e.message);
        }
      });
    });
    tbody.querySelectorAll("button[data-action='reset']").forEach((btn) => {
      btn.addEventListener("click", () => mabuOpenResetPasswordFlow(btn.dataset.user));
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="mabu-note">error: ${mabuEscape(e.message)}</td></tr>`;
  }
}

function mabuOpenResetPasswordFlow(username) {
  const overlay = document.getElementById("mabuModalOverlay");
  const modal = document.getElementById("mabuModal");
  document.getElementById("mabuModalTitle").textContent = `Reset password: ${username}`;
  document.getElementById("mabuModalBody").innerHTML = "";
  const body = document.getElementById("mabuModalBody");
  body.innerHTML = `<div class="mabu-field"><label for="resetPwInput">new password (min 8 characters)</label><input type="password" id="resetPwInput" autocomplete="new-password"></div>`;
  const confirmBtn = document.getElementById("mabuModalConfirm");
  const cancelBtn = document.getElementById("mabuModalCancel");
  confirmBtn.textContent = "reset password";
  modal.classList.remove("mabu-modal-danger");

  function cleanup() {
    overlay.hidden = true;
    confirmBtn.removeEventListener("click", onConfirm);
    cancelBtn.removeEventListener("click", onCancel);
  }
  async function onConfirm() {
    const pw = document.getElementById("resetPwInput").value;
    if (pw.length < 8) {
      mabuToast("warning", "Password too short", "Minimum 8 characters.");
      return;
    }
    try {
      await mabuApi(`/api/users/${encodeURIComponent(username)}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_password: pw }),
      });
      mabuToast("success", "Password reset", `New password set for ${username}.`);
      cleanup();
    } catch (e) {
      mabuToast("error", "Reset failed", e.message);
    }
  }
  function onCancel() { cleanup(); }
  confirmBtn.addEventListener("click", onConfirm);
  cancelBtn.addEventListener("click", onCancel);
  overlay.hidden = false;
  document.getElementById("resetPwInput").focus();
}

async function mabuLoadAuditLog() {
  const tbody = document.querySelector("#auditTable tbody");
  tbody.innerHTML = `<tr><td colspan="4" class="mabu-note">loading...</td></tr>`;
  try {
    const { data } = await mabuApi("/api/audit-log?limit=300");
    mabuAuditCache = data.entries || [];

    const actionFilter = document.getElementById("auditActionFilter");
    const actions = [...new Set(mabuAuditCache.map((e) => e.action))].sort();
    const currentVal = actionFilter.value;
    actionFilter.innerHTML = `<option value="">-- any action --</option>` +
      actions.map((a) => `<option value="${mabuEscape(a)}">${mabuEscape(a)}</option>`).join("");
    actionFilter.value = currentVal;

    mabuRenderAuditLog();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="mabu-note">error: ${mabuEscape(e.message)}</td></tr>`;
  }
}

function mabuRenderAuditLog() {
  const tbody = document.querySelector("#auditTable tbody");
  const query = document.getElementById("auditSearchInput").value.trim().toLowerCase();
  const actionFilter = document.getElementById("auditActionFilter").value;

  const filtered = mabuAuditCache.filter((e) => {
    if (actionFilter && e.action !== actionFilter) return false;
    if (query) {
      const hay = `${e.actor} ${e.action} ${e.detail}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="mabu-note">no matching audit entries.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((e) => `
    <tr>
      <td>${mabuEscape((e.time || "").slice(0, 19).replace("T", " "))}</td>
      <td>${mabuEscape(e.actor)}</td>
      <td>${mabuEscape(e.action.replace(/_/g, " "))}</td>
      <td>${mabuEscape(e.detail)}</td>
    </tr>
  `).join("");
}

async function mabuLoadSystemStatus() {
  try {
    const { data } = await mabuApi("/api/system/status");
    document.getElementById("sysVaultDir").textContent = data.vault_dir;
    document.getElementById("sysVaultKey").textContent = data.vault_key_present ? "present" : "MISSING";
    document.getElementById("sysCaseCount").textContent = data.case_count;
    document.getElementById("sysPublicOrigin").textContent = data.public_origin || "(local only)";
    document.getElementById("sysHibp").textContent = data.hibp_configured ? "configured" : "not configured";
  } catch (e) {
    // Non-fatal — admin can still use the rest of the panel.
  }
}

function mabuInitAdmin() {
  document.getElementById("usersRefreshBtn").addEventListener("click", mabuLoadUsers);
  document.getElementById("auditRefreshBtn").addEventListener("click", mabuLoadAuditLog);
  document.getElementById("auditFilterBtn").addEventListener("click", mabuRenderAuditLog);
  document.getElementById("auditSearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") mabuRenderAuditLog();
  });

  document.getElementById("newUserBtn").addEventListener("click", async () => {
    const username = document.getElementById("newUserUsername").value.trim();
    const password = document.getElementById("newUserPassword").value;
    const role = document.getElementById("newUserRole").value;
    const statusEl = document.getElementById("usersStatus");

    if (!username || !password) {
      statusEl.textContent = "username and password required.";
      statusEl.style.color = "var(--mabu-amber)";
      return;
    }

    try {
      await mabuApi("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role }),
      });
      statusEl.textContent = `user '${username}' created.`;
      statusEl.style.color = "var(--mabu-green)";
      mabuToast("success", "User created", `${username} (${role})`);
      document.getElementById("newUserUsername").value = "";
      document.getElementById("newUserPassword").value = "";
      mabuLoadUsers();
    } catch (e) {
      statusEl.textContent = `error: ${e.message}`;
      statusEl.style.color = "var(--mabu-red)";
    }
  });
}

function mabuApplyRoleVisibility() {
  const isAdmin = mabuCurrentUser.role === "admin";
  document.getElementById("adminNavGroup").hidden = !isAdmin;
  document.getElementById("adminNavBtn").hidden = !isAdmin;
}

/* ---------------- Case Templates ---------------- */

async function mabuLoadTemplates() {
  const select = document.getElementById("rTemplate");
  if (select.dataset.loaded) return;
  try {
    const res = await mabuFetch("/api/templates");
    const data = await res.json();
    select.innerHTML = data.templates.map((t) => `<option value="${t.id}">${mabuEscape(t.label)}</option>`).join("");
    select.dataset.loaded = "1";
  } catch (e) {
    /* leave default */
  }
}

function mabuInitTemplates() {
  document.getElementById("rTemplate").addEventListener("change", async (e) => {
    const templateId = e.target.value;
    const preview = document.getElementById("rTemplatePreview");
    try {
      const { data: tpl } = await mabuApi(`/api/templates/${encodeURIComponent(templateId)}`);

      preview.hidden = false;
      preview.innerHTML = `
        <div class="mabu-kv"><span>template</span><b>${mabuEscape(tpl.label || templateId)}</b></div>
        <div class="mabu-kv"><span>default tags</span><b>${(tpl.tags || []).map(mabuEscape).join(", ") || "(none)"}</b></div>
        <div class="mabu-kv"><span>suggested summary</span><b>${mabuEscape(tpl.summary || "(none)")}</b></div>
      `;

      const tagsEl = document.getElementById("rTags");
      const summaryEl = document.getElementById("rSummary");
      const findingsEl = document.getElementById("rFindings");
      const hasContent = tagsEl.value.trim() || summaryEl.value.trim() || findingsEl.value.trim();

      if (hasContent) {
        const confirmed = await mabuConfirm({
          title: "Apply template?",
          body: "This will replace the tags, summary, and findings you've already typed with this template's defaults.",
          confirmLabel: "apply template",
        });
        if (!confirmed) return;
      }

      tagsEl.value = (tpl.tags || []).join(", ");
      summaryEl.value = tpl.summary || "";
      findingsEl.value = tpl.findings || "";
    } catch (err) {
      mabuToast("error", "Could not load template", err.message);
    }
  });

  let relatedCheckTimeout = null;
  const checkRelated = () => {
    clearTimeout(relatedCheckTimeout);
    relatedCheckTimeout = setTimeout(async () => {
      const emails = mabuSplitList(document.getElementById("rEmail").value);
      const usernames = mabuSplitList(document.getElementById("rUsername").value);
      const ips = mabuSplitList(document.getElementById("rIp").value);
      const names = mabuSplitList(document.getElementById("rNames").value);
      const phones = mabuSplitList(document.getElementById("rPhone").value);

      if (!emails.length && !usernames.length && !ips.length && !names.length && !phones.length) {
        document.getElementById("rRelatedWarning").hidden = true;
        return;
      }

      try {
        const res = await mabuFetch("/api/cases/related", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emails, usernames, ips, names, phones }),
        });
        const data = await res.json();
        const box = document.getElementById("rRelatedWarning");
        if (data.related && data.related.length) {
          box.hidden = false;
          document.getElementById("rRelatedList").innerHTML = data.related.map((r) => `
            <div class="mabu-kv"><span>related case: ${mabuEscape(r.title)}</span><b>shared identifier: ${mabuEscape(r.shared.join(", "))}</b></div>
          `).join("");
        } else {
          box.hidden = true;
        }
      } catch (e) {
        /* ignore */
      }
    }, 500);
  };

  ["rEmail", "rUsername", "rIp", "rNames", "rPhone"].forEach((id) => {
    document.getElementById(id).addEventListener("input", checkRelated);
  });
}

/* ---------------- Vault tag/status filtering ---------------- */

async function mabuLoadVaultTags() {
  const select = document.getElementById("vaultTagFilter");
  try {
    const res = await mabuFetch("/api/vault/tags");
    const data = await res.json();
    select.innerHTML = `<option value="">-- filter by tag --</option>` + data.tags.map((t) => `<option value="${mabuEscape(t)}">${mabuEscape(t)}</option>`).join("");
  } catch (e) {
    /* leave default */
  }
}

function mabuInitVaultFilters() {
  document.getElementById("vaultFilterBtn").addEventListener("click", async () => {
    const tag = document.getElementById("vaultTagFilter").value;
    const status = document.getElementById("vaultStatusFilter").value;
    const params = new URLSearchParams();
    if (tag) params.set("tag", tag);
    if (status) params.set("status", status);

    const tbody = document.querySelector("#vaultTable tbody");
    tbody.innerHTML = `<tr><td colspan="7" class="mabu-note">loading...</td></tr>`;
    try {
      const res = await mabuFetch(`/api/vault/list?${params.toString()}`);
      const data = await res.json();
      mabuRenderVaultRows(data.files || []);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="mabu-note">filter failed.</td></tr>`;
    }
  });
}

/* ---------------- Case tags + attachments (case detail panel) ---------------- */

function mabuInitCaseDetailExtras() {
  document.getElementById("caseTagsApplyBtn").addEventListener("click", async () => {
    if (!mabuCurrentCaseFilename) return;
    const tags = mabuSplitList(document.getElementById("caseTagsInput").value);
    try {
      await mabuApi(`/api/cases/${encodeURIComponent(mabuCurrentCaseFilename)}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags, passphrase: null }),
      });
      mabuToast("success", "Tags updated", tags.join(", ") || "(cleared)");
      mabuOpenCaseDetail(mabuCurrentCaseFilename);
      mabuLoadVault();
      mabuLoadVaultTags();
    } catch (e) {
      mabuToast("error", "Could not update tags", e.message);
    }
  });
}

/* ---------------- Settings ---------------- */

function mabuApplyReducedFx(enabled) {
  document.documentElement.classList.toggle("mabu-reduced-fx", enabled);
  if (enabled) {
    mabuStopRain();
  } else {
    mabuStartRain();
  }
}

// ---------------------------------------------------------------------------
// Background effect: falling Cyrillic characters ("digital rain"), matching
// the Russian-rendered "МАБУ" header. Purely decorative — canvas-drawn,
// no external assets/fonts. Respects the same reduced-motion toggle as the
// scanline/noise overlays.
// ---------------------------------------------------------------------------

const MABU_RAIN_CHARS = "МАБУАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЭЮЯ0123456789";
let mabuRainState = null;

function mabuStartRain() {
  if (mabuRainState) return; // already running
  const canvas = document.getElementById("mabuRain");
  if (!canvas || !canvas.getContext) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const ctx = canvas.getContext("2d");
  const fontSize = 16;
  let columns = 0;
  let drops = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    columns = Math.floor(canvas.width / fontSize);
    drops = new Array(columns).fill(0).map(() => Math.floor(Math.random() * -40));
  }

  function draw() {
    ctx.fillStyle = "rgba(1, 4, 1, 0.08)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = `${fontSize}px "Cascadia Code", "Consolas", monospace`;
    for (let i = 0; i < columns; i++) {
      const char = MABU_RAIN_CHARS[Math.floor(Math.random() * MABU_RAIN_CHARS.length)];
      const x = i * fontSize;
      const y = drops[i] * fontSize;

      ctx.fillStyle = "rgba(200, 255, 220, 0.85)";
      ctx.fillText(char, x, y);
      ctx.fillStyle = "rgba(0, 255, 102, 0.55)";
      ctx.fillText(char, x, y + fontSize);

      if (y > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
  }

  const intervalId = setInterval(draw, 60);
  window.addEventListener("resize", resize);
  resize();

  mabuRainState = { intervalId, resize };
}

function mabuStopRain() {
  if (!mabuRainState) return;
  clearInterval(mabuRainState.intervalId);
  window.removeEventListener("resize", mabuRainState.resize);
  const canvas = document.getElementById("mabuRain");
  if (canvas && canvas.getContext) {
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  }
  mabuRainState = null;
}

function mabuLoadSettingsPanel() {
  document.getElementById("settingsUsername").textContent = mabuCurrentUser.username || "–";
  document.getElementById("settingsRole").textContent = mabuCurrentUser.role || "–";
  document.getElementById("settingsApiOrigin").textContent = MABU_API || window.location.origin;
  document.getElementById("settingsVersion").textContent = MABU_VERSION;
  document.getElementById("settingReducedFx").checked = localStorage.getItem("mabu_reduced_fx") === "1";
  document.getElementById("settingSkipBoot").checked = localStorage.getItem("mabu_skip_boot") === "1";
}

function mabuInitSettings() {
  document.getElementById("settingsBtn").addEventListener("click", () => mabuGoTo("settings"));

  document.getElementById("settingReducedFx").addEventListener("change", (e) => {
    localStorage.setItem("mabu_reduced_fx", e.target.checked ? "1" : "0");
    mabuApplyReducedFx(e.target.checked);
  });
  document.getElementById("settingSkipBoot").addEventListener("change", (e) => {
    localStorage.setItem("mabu_skip_boot", e.target.checked ? "1" : "0");
  });

  document.getElementById("mabuVersionTag").textContent = `MABU v${MABU_VERSION} :: RESEARCH WORKSTATION`;
  mabuApplyReducedFx(localStorage.getItem("mabu_reduced_fx") === "1");
}

/* ---------------- Notifications panel ---------------- */

function mabuInitNotifications() {
  const btn = document.getElementById("notifBtn");
  btn.addEventListener("click", () => {
    mabuOpenNotificationPanel();
  });
  mabuUpdateNotifBadge();
}

function mabuOpenNotificationPanel() {
  const overlay = document.getElementById("mabuModalOverlay");
  const modal = document.getElementById("mabuModal");
  document.getElementById("mabuModalTitle").textContent = "Notifications";
  document.getElementById("mabuModalBody").innerHTML = mabuRenderNotificationPanel();
  modal.classList.remove("mabu-modal-danger");
  const confirmBtn = document.getElementById("mabuModalConfirm");
  const cancelBtn = document.getElementById("mabuModalCancel");
  confirmBtn.hidden = true;
  cancelBtn.textContent = "close";

  function cleanup() {
    overlay.hidden = true;
    confirmBtn.hidden = false;
    confirmBtn.textContent = "confirm";
    cancelBtn.textContent = "cancel";
    cancelBtn.removeEventListener("click", onClose);
  }
  function onClose() { cleanup(); }
  cancelBtn.addEventListener("click", onClose);
  overlay.hidden = false;
}

/* ---------------- Command palette ---------------- */

function mabuFocusVaultSearch() {
  mabuGoTo("vault");
  setTimeout(() => document.getElementById("vaultSearchInput")?.focus(), 50);
}

function mabuCommandList() {
  const isAdmin = mabuCurrentUser.role === "admin";
  const cmds = [
    { label: "New case", hint: "Ctrl+N", action: () => mabuGoTo("research") },
    { label: "Search vault", hint: "Ctrl+/", action: mabuFocusVaultSearch },
    { label: "Correlate vault", hint: "", action: () => mabuGoTo("correlate") },
    { label: "Public records", hint: "", action: () => mabuGoTo("lookups") },
    { label: "Timeline", hint: "", action: () => mabuGoTo("timeline") },
    { label: "Reader", hint: "", action: () => mabuGoTo("reader") },
    { label: "Overview", hint: "", action: () => mabuGoTo("home") },
    { label: "Settings", hint: "", action: () => mabuGoTo("settings") },
  ];
  if (isAdmin) cmds.push({ label: "Admin: users & audit", hint: "", action: () => mabuGoTo("admin") });
  cmds.push({ label: "Logout", hint: "", action: () => document.getElementById("logoutBtn").click() });
  return cmds;
}

let mabuCmdkActiveIndex = 0;
let mabuCmdkFiltered = [];

function mabuRenderCmdkList(query) {
  const all = mabuCommandList();
  mabuCmdkFiltered = query
    ? all.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    : all;
  mabuCmdkActiveIndex = 0;

  const list = document.getElementById("mabuCmdkList");
  if (!mabuCmdkFiltered.length) {
    list.innerHTML = `<div class="mabu-cmdk-empty">no matching commands</div>`;
    return;
  }
  list.innerHTML = mabuCmdkFiltered.map((c, i) => `
    <div class="mabu-cmdk-item ${i === 0 ? "active" : ""}" data-index="${i}">
      <span>${mabuEscape(c.label)}</span>
      ${c.hint ? `<span class="mabu-cmdk-item-hint">${mabuEscape(c.hint)}</span>` : ""}
    </div>
  `).join("");

  list.querySelectorAll(".mabu-cmdk-item").forEach((el) => {
    el.addEventListener("click", () => mabuRunCommand(Number(el.dataset.index)));
  });
}

function mabuRunCommand(index) {
  const cmd = mabuCmdkFiltered[index];
  mabuCloseCmdk();
  if (cmd) cmd.action();
}

function mabuOpenCmdk() {
  const overlay = document.getElementById("mabuCmdkOverlay");
  const input = document.getElementById("mabuCmdkInput");
  overlay.hidden = false;
  input.value = "";
  mabuRenderCmdkList("");
  input.focus();
}

function mabuCloseCmdk() {
  document.getElementById("mabuCmdkOverlay").hidden = true;
}

function mabuInitCommandPalette() {
  const overlay = document.getElementById("mabuCmdkOverlay");
  const input = document.getElementById("mabuCmdkInput");

  document.getElementById("cmdkTriggerBtn").addEventListener("click", mabuOpenCmdk);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) mabuCloseCmdk(); });

  input.addEventListener("input", () => mabuRenderCmdkList(input.value));

  input.addEventListener("keydown", (e) => {
    const items = () => document.querySelectorAll(".mabu-cmdk-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      mabuCmdkActiveIndex = Math.min(mabuCmdkActiveIndex + 1, mabuCmdkFiltered.length - 1);
      items().forEach((el, i) => el.classList.toggle("active", i === mabuCmdkActiveIndex));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      mabuCmdkActiveIndex = Math.max(mabuCmdkActiveIndex - 1, 0);
      items().forEach((el, i) => el.classList.toggle("active", i === mabuCmdkActiveIndex));
    } else if (e.key === "Enter") {
      e.preventDefault();
      mabuRunCommand(mabuCmdkActiveIndex);
    } else if (e.key === "Escape") {
      mabuCloseCmdk();
    }
  });

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || e.target.isContentEditable;

    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      overlay.hidden ? mabuOpenCmdk() : mabuCloseCmdk();
      return;
    }
    if (!overlay.hidden) return;

    if (mod && e.key.toLowerCase() === "n" && !typing) {
      e.preventDefault();
      mabuGoTo("research");
      return;
    }
    if (mod && e.key === "/" && !typing) {
      e.preventDefault();
      mabuFocusVaultSearch();
      return;
    }
    if (e.key === "Escape") {
      if (!document.getElementById("mabuModalOverlay").hidden) {
        document.getElementById("mabuModalCancel").click();
      }
    }
  });
}

/* ---------------- Utility ---------------- */

function mabuEscape(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function mabuLoadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback !== undefined ? fallback : [];
    return JSON.parse(raw);
  } catch (e) {
    return fallback !== undefined ? fallback : [];
  }
}

function mabuSaveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

/* ---------------- Init ---------------- */

function mabuInitAll() {
  document.querySelectorAll(".mabu-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => mabuGoTo(btn.dataset.view));
  });
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => mabuGoTo(btn.dataset.goto));
  });

  mabuInitEmail();
  mabuInitUsername();
  mabuInitDiscord();
  mabuInitNetwork();
  mabuInitToolkit();
  mabuInitResearch();
  mabuInitVault();
  mabuInitReader();
  mabuInitCorrelate();
  mabuInitTimeline();
  mabuInitLookups();
  mabuInitLogout();
  mabuInitAdmin();
  mabuInitTemplates();
  mabuInitVaultFilters();
  mabuInitCaseDetailExtras();
  mabuInitSettings();
  mabuInitNotifications();
  mabuInitCommandPalette();

  mabuApplyRoleVisibility();
  mabuRenderPlatforms();
  mabuRenderDiscordUsers();
  mabuCheckApiStatus();
  mabuLoadStats();
  mabuLoadVaultTags();
  mabuTickClock();

  setInterval(mabuCheckApiStatus, 15000);
  setInterval(mabuTickClock, 1000);
}

document.addEventListener("DOMContentLoaded", () => {
  mabuApplyReducedFx(localStorage.getItem("mabu_reduced_fx") === "1");
  mabuInitLogin();
  mabuInitBoot();
});
