/* MABU Dashboard — frontend core logic */

const MABU_API = "http://127.0.0.1:5057";

/* All API calls must include credentials so the session cookie is sent/stored. */
function mabuFetch(path, options = {}) {
  return fetch(MABU_API + path, { ...options, credentials: "include" });
}

/* ---------------- Boot sequence ---------------- */

const MABU_BOOT_LINES = [
  "MABU-BIOS v2.0.0 :: initializing local kernel...",
  "mounting /vault/mabu-files ... OK",
  "checking fernet keystore ... OK",
  "loading module: email-lookup ... OK",
  "loading module: username-tracker ... OK",
  "loading module: discord-tools ... OK",
  "loading module: network-ip ... OK",
  "loading module: hash-encode ... OK",
  "loading module: research-vault ... OK",
  "loading module: timeline-graph ... OK",
  "binding localhost:5057 ... OK",
  "no external interfaces detected. good.",
  "",
  "> welcome to MABU_",
];

function mabuRunBoot(done) {
  const logEl = document.getElementById("mabuBootLog");
  const fillEl = document.getElementById("mabuBootFill");
  const bootEl = document.getElementById("mabuBoot");

  let i = 0;
  let printed = "";

  function step() {
    if (i < MABU_BOOT_LINES.length) {
      printed += MABU_BOOT_LINES[i] + "\n";
      logEl.textContent = printed;
      fillEl.style.width = `${Math.round(((i + 1) / MABU_BOOT_LINES.length) * 100)}%`;
      i++;
      setTimeout(step, 90 + Math.random() * 60);
    } else {
      setTimeout(() => {
        bootEl.style.transition = "opacity 0.25s ease";
        bootEl.style.opacity = "0";
        setTimeout(() => {
          bootEl.hidden = true;
          done();
        }, 250);
      }, 300);
    }
  }
  step();
}

/* Skip boot sequence if already seen this session, then always go through the auth gate */
function mabuInitBoot() {
  const bootEl = document.getElementById("mabuBoot");
  if (sessionStorage.getItem("mabu_booted")) {
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
      shellEl.hidden = false;
      document.getElementById("loggedInAsText").textContent = `user: ${data.username}`;
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
      document.getElementById("mabuLoginScreen").hidden = true;
      document.getElementById("mabuShell").hidden = false;
      document.getElementById("loggedInAsText").textContent = `user: ${data.username}`;
      mabuInitAll();
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
      /* ignore */
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

function mabuRenderVaultRows(files) {
  const tbody = document.querySelector("#vaultTable tbody");
  tbody.innerHTML = "";
  if (!files.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="mabu-note">no .mabu files found in vault.</td></tr>`;
    return;
  }
  files.forEach((f) => {
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
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("button[data-action='open']").forEach((btn) => {
    btn.addEventListener("click", () => mabuOpenCaseDetail(btn.dataset.file));
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

async function mabuOpenCaseDetail(filename) {
  const card = document.getElementById("caseDetailCard");
  const body = document.getElementById("caseDetailBody");
  card.hidden = false;
  body.innerHTML = `<p class="mabu-note">loading...</p>`;
  document.getElementById("caseDetailTitle").textContent = filename;
  card.scrollIntoView({ behavior: "smooth" });

  try {
    const res = await mabuFetch("/api/vault/decrypt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, passphrase: null }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Decryption failed");

    mabuCurrentCaseFilename = filename;
    const rec = data.record;
    document.getElementById("caseDetailTitle").textContent = rec.title || filename;
    document.getElementById("caseStatusSelect").value = rec.status || "open";
    body.innerHTML = mabuRenderCaseDetail(rec);
  } catch (e) {
    body.innerHTML = `<p class="mabu-note">could not open case: ${mabuEscape(e.message)} (passphrase-protected files must be opened via the Reader tab)</p>`;
    mabuCurrentCaseFilename = null;
  }
}

function mabuRenderCaseDetail(rec) {
  const entries = rec.entries || [];
  const listField = (arr) => (arr && arr.length ? arr.map(mabuEscape).join(", ") : "–");

  const entriesHtml = entries.length
    ? entries.map((e) => `
        <div class="mabu-result-box" style="margin-bottom:10px;">
          <div class="mabu-kv"><span>date</span><b>${mabuEscape((e.date || "").replace("T", " ").slice(0, 19))}</b></div>
          <div class="mabu-kv"><span>author</span><b>${mabuEscape(e.author || "–")}</b></div>
          <div class="mabu-kv"><span>summary</span><b>${mabuEscape(e.summary || "–")}</b></div>
          <div class="mabu-kv"><span>findings</span><b>${mabuEscape(e.findings || "–")}</b></div>
          <div class="mabu-kv"><span>emails</span><b>${listField(e.emails)}</b></div>
          <div class="mabu-kv"><span>usernames</span><b>${listField(e.usernames)}</b></div>
          <div class="mabu-kv"><span>ips</span><b>${listField(e.ips)}</b></div>
        </div>
      `).join("")
    : `<p class="mabu-note">(no entries yet)</p>`;

  const activityHtml = (rec.activity_log || []).map((a) => `
    <div class="mabu-timeline-summary">[${mabuEscape((a.date || "").replace("T", " ").slice(0, 19))}] ${mabuEscape(a.action)}: ${mabuEscape(a.detail)}</div>
  `).join("");

  return `
    <div class="mabu-kv"><span>case_id</span><b>${mabuEscape(rec.case_id || "–")}</b></div>
    <div class="mabu-kv"><span>investigator</span><b>${mabuEscape(rec.investigator || "–")}</b></div>
    <div class="mabu-kv"><span>tags</span><b>${listField(rec.tags)}</b></div>
    <h4 class="mabu-subhead" style="margin-top:14px;">entries (${entries.length})</h4>
    ${entriesHtml}
    <h4 class="mabu-subhead">activity log</h4>
    ${activityHtml || '<p class="mabu-note">(none)</p>'}
  `;
}

function mabuInitVault() {
  document.getElementById("vaultRefreshBtn").addEventListener("click", () => {
    mabuLoadVault();
    document.getElementById("caseDetailCard").hidden = true;
    mabuCurrentCaseFilename = null;
  });

  document.getElementById("vaultSearchBtn").addEventListener("click", async () => {
    const q = document.getElementById("vaultSearchInput").value.trim();
    const tbody = document.querySelector("#vaultTable tbody");
    if (!q) return mabuLoadVault();
    tbody.innerHTML = `<tr><td colspan="7" class="mabu-note">searching...</td></tr>`;
    try {
      const res = await mabuFetch(`/api/vault/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      mabuRenderVaultRows(data.files || []);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="mabu-note">search failed. is the api running?</td></tr>`;
    }
  });

  document.getElementById("caseStatusApplyBtn").addEventListener("click", async () => {
    if (!mabuCurrentCaseFilename) return;
    const status = document.getElementById("caseStatusSelect").value;
    try {
      const res = await mabuFetch(`/api/cases/${encodeURIComponent(mabuCurrentCaseFilename)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, passphrase: null }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "failed");
      mabuOpenCaseDetail(mabuCurrentCaseFilename);
      mabuLoadVault();
    } catch (e) {
      alert("Could not set status: " + e.message);
    }
  });

  document.getElementById("caseReportBtn").addEventListener("click", async () => {
    if (!mabuCurrentCaseFilename) return;
    try {
      const res = await mabuFetch("/api/report/case", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: mabuCurrentCaseFilename, passphrase: null }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "report generation failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = mabuCurrentCaseFilename.replace(".mabu", "") + "_report.pdf";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Could not generate report: " + e.message);
    }
  });

  document.getElementById("ceAddBtn").addEventListener("click", async () => {
    if (!mabuCurrentCaseFilename) {
      alert("Open a case first.");
      return;
    }
    const statusEl = document.getElementById("ceStatus");
    const payload = {
      author: document.getElementById("ceAuthor").value.trim() || undefined,
      summary: document.getElementById("ceSummary").value.trim(),
      findings: document.getElementById("ceFindings").value.trim(),
      emails: mabuSplitList(document.getElementById("ceEmails").value),
      usernames: mabuSplitList(document.getElementById("ceUsernames").value),
      ips: mabuSplitList(document.getElementById("ceIps").value),
      passphrase: null,
    };

    statusEl.textContent = "adding entry...";
    statusEl.style.color = "var(--mabu-text-dim)";
    try {
      const res = await mabuFetch(`/api/cases/${encodeURIComponent(mabuCurrentCaseFilename)}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error || "failed");
      statusEl.textContent = "entry added.";
      statusEl.style.color = "var(--mabu-green)";
      ["ceAuthor", "ceSummary", "ceFindings", "ceEmails", "ceUsernames", "ceIps"].forEach((id) => (document.getElementById(id).value = ""));
      mabuOpenCaseDetail(mabuCurrentCaseFilename);
      mabuLoadVault();
    } catch (e) {
      statusEl.textContent = `error: ${e.message}`;
      statusEl.style.color = "var(--mabu-red)";
    }
  });
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

async function mabuLoadTimeline() {
  const track = document.getElementById("timelineTrack");
  track.innerHTML = `<p class="mabu-note">loading...</p>`;

  let records;
  try {
    records = await mabuFetchFullRecords();
  } catch (e) {
    track.innerHTML = `<p class="mabu-note">could not reach api. is mabu-server.py running?</p>`;
    return;
  }

  if (!records.length) {
    track.innerHTML = `<p class="mabu-note">no decryptable vault entries yet. Create a case without a custom passphrase to see it here.</p>`;
    document.getElementById("graphSvg").innerHTML = "";
    return;
  }

  records.sort((a, b) => new Date(b.updated || b.created) - new Date(a.updated || a.created));

  track.innerHTML = records.map((r) => {
    const entries = r.entries || [];
    const lastEntry = entries[entries.length - 1];
    return `
      <div class="mabu-timeline-item">
        <div class="mabu-timeline-date">${mabuEscape((r.updated || r.created || "").replace("T", " ").slice(0, 19))} UTC — status: ${mabuEscape(r.status || "open")}</div>
        <div class="mabu-timeline-title">${mabuEscape(r.title || r.filename)}</div>
        <div class="mabu-timeline-summary">${mabuEscape((lastEntry && lastEntry.summary) || "(no entries)")} — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}</div>
      </div>
    `;
  }).join("");

  mabuRenderGraph(records, "graphSvg");
}

function mabuRecordIdentifiers(r) {
  const ids = new Set();
  (r.entries || []).forEach((e) => {
    [...(e.emails || []), ...(e.usernames || []), ...(e.ips || []), ...(e.names || []), ...(e.phones || [])]
      .forEach((v) => v && ids.add(v.toLowerCase()));
  });
  return ids;
}

function mabuRenderGraph(records, svgId) {
  const svg = document.getElementById(svgId);
  const width = Math.max(600, svg.parentElement.clientWidth - 20);
  const height = 380;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const nodes = records.map((r, i) => ({
    id: i,
    label: r.title || r.filename,
    identifiers: mabuRecordIdentifiers(r),
  }));

  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = [...nodes[i].identifiers].filter((id) => nodes[j].identifiers.has(id));
      if (shared.length > 0) edges.push({ from: i, to: j, shared });
    }
  }

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 60;
  const positions = nodes.map((_, i) => {
    const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1);
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });

  const svgNS = "http://www.w3.org/2000/svg";

  edges.forEach((e) => {
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("class", "edge");
    line.setAttribute("x1", positions[e.from].x);
    line.setAttribute("y1", positions[e.from].y);
    line.setAttribute("x2", positions[e.to].x);
    line.setAttribute("y2", positions[e.to].y);
    const title = document.createElementNS(svgNS, "title");
    title.textContent = `shared: ${e.shared.join(", ")}`;
    line.appendChild(title);
    svg.appendChild(line);
  });

  nodes.forEach((n, i) => {
    const pos = positions[i];
    const circle = document.createElementNS(svgNS, "circle");
    circle.setAttribute("class", "node");
    circle.setAttribute("cx", pos.x);
    circle.setAttribute("cy", pos.y);
    circle.setAttribute("r", 8);
    const title = document.createElementNS(svgNS, "title");
    title.textContent = `${n.label}\nidentifiers: ${[...n.identifiers].join(", ") || "none"}`;
    circle.appendChild(title);
    svg.appendChild(circle);

    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", pos.x);
    text.setAttribute("y", pos.y - 12);
    text.setAttribute("text-anchor", "middle");
    text.textContent = n.label.length > 18 ? n.label.slice(0, 16) + "…" : n.label;
    svg.appendChild(text);
  });

  if (!nodes.length) {
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", cx);
    text.setAttribute("y", cy);
    text.setAttribute("text-anchor", "middle");
    text.textContent = "no data to graph";
    svg.appendChild(text);
  }
}

/* ---------------- Correlation Engine ---------------- */

async function mabuLoadCorrelation() {
  const clustersEl = document.getElementById("correlateClusters");
  clustersEl.innerHTML = `<p class="mabu-note">scanning vault...</p>`;

  try {
    const res = await mabuFetch("/api/correlate");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "correlation failed");

    if (!data.clusters.length) {
      clustersEl.innerHTML = `<p class="mabu-note">no linked cases found — no shared identifiers detected across the vault.</p>`;
    } else {
      clustersEl.innerHTML = data.clusters.map((cluster, i) => `
        <div class="mabu-result-box" style="margin-bottom:12px;">
          <div class="mabu-kv"><span>cluster ${i + 1}</span><b>${cluster.size} linked cases</b></div>
          <div class="mabu-kv"><span>files</span><b>${cluster.filenames.map(mabuEscape).join(", ")}</b></div>
          <div class="mabu-actions" style="margin-top:8px;">
            <button class="mabu-btn mabu-btn-secondary" data-cluster="${i}">download_cluster_report()</button>
          </div>
        </div>
      `).join("");

      clustersEl.querySelectorAll("button[data-cluster]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const cluster = data.clusters[Number(btn.dataset.cluster)];
          try {
            const res2 = await mabuFetch("/api/report/cluster", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filenames: cluster.filenames, passphrase: null }),
            });
            if (!res2.ok) throw new Error((await res2.json()).error || "report failed");
            const blob = await res2.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "mabu_cluster_report.pdf";
            a.click();
            URL.revokeObjectURL(url);
          } catch (e) {
            alert("Could not generate cluster report: " + e.message);
          }
        });
      });
    }

    const records = data.nodes.map((n) => ({
      filename: n.filename,
      title: n.title,
      entries: [{ emails: n.identifiers, usernames: [], ips: [], names: [], phones: [] }],
    }));
    mabuRenderGraph(records, "correlateGraphSvg");
  } catch (e) {
    clustersEl.innerHTML = `<p class="mabu-note">could not reach api: ${mabuEscape(e.message)}</p>`;
  }
}

function mabuInitCorrelate() {
  document.getElementById("correlateRefreshBtn").addEventListener("click", mabuLoadCorrelation);
}

/* ---------------- Public Record Lookups ---------------- */

function mabuRenderKv(container, obj) {
  container.hidden = false;
  container.innerHTML = Object.entries(obj).map(([k, v]) => {
    const display = Array.isArray(v) ? (v.length ? v.join(", ") : "(none)") : (v ?? "(none)");
    return `<div class="mabu-kv"><span>${mabuEscape(k)}</span><b>${mabuEscape(display)}</b></div>`;
  }).join("");
}

function mabuInitLookups() {
  document.getElementById("whoisBtn").addEventListener("click", async () => {
    const domain = document.getElementById("whoisInput").value.trim();
    const box = document.getElementById("whoisResult");
    if (!domain) return;
    box.hidden = false;
    box.innerHTML = `<p class="mabu-note">running whois...</p>`;
    try {
      const res = await mabuFetch(`/api/lookup/whois?domain=${encodeURIComponent(domain)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "whois failed");
      mabuRenderKv(box, data);
    } catch (e) {
      box.innerHTML = `<p class="mabu-note">error: ${mabuEscape(e.message)}</p>`;
    }
  });

  document.getElementById("dnsBtn").addEventListener("click", async () => {
    const domain = document.getElementById("dnsInput").value.trim();
    const box = document.getElementById("dnsResult");
    if (!domain) return;
    box.hidden = false;
    box.innerHTML = `<p class="mabu-note">running dns lookup...</p>`;
    try {
      const res = await mabuFetch(`/api/lookup/dns?domain=${encodeURIComponent(domain)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "dns lookup failed");
      mabuRenderKv(box, data);
    } catch (e) {
      box.innerHTML = `<p class="mabu-note">error: ${mabuEscape(e.message)}</p>`;
    }
  });

  document.getElementById("handleCheckBtn").addEventListener("click", async () => {
    const username = document.getElementById("handleCheckInput").value.trim();
    const table = document.getElementById("handleCheckTable");
    const tbody = table.querySelector("tbody");
    if (!username) return;
    table.hidden = false;
    tbody.innerHTML = `<tr><td colspan="4" class="mabu-note">checking platforms live (this takes a few seconds)...</td></tr>`;
    try {
      const res = await mabuFetch(`/api/lookup/handle?username=${encodeURIComponent(username)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "handle check failed");
      tbody.innerHTML = data.results.map((r) => `
        <tr>
          <td>${mabuEscape(r.platform)}</td>
          <td><a href="${r.url}" target="_blank" rel="noopener noreferrer">${mabuEscape(r.url)}</a></td>
          <td>${r.likely_exists ? "yes" : "no"}</td>
          <td>${mabuEscape(r.detail)}</td>
        </tr>
      `).join("");
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" class="mabu-note">error: ${mabuEscape(e.message)}</td></tr>`;
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
  mabuInitLookups();
  mabuInitLogout();

  mabuRenderPlatforms();
  mabuRenderDiscordUsers();
  mabuCheckApiStatus();
  mabuLoadStats();
  mabuTickClock();

  setInterval(mabuCheckApiStatus, 15000);
  setInterval(mabuTickClock, 1000);
}

document.addEventListener("DOMContentLoaded", () => {
  mabuInitLogin();
  mabuInitBoot();
});
