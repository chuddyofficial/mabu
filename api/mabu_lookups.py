"""
mabu_lookups.py — public-record lookups: WHOIS, DNS, and platform
handle-existence checks.

All lookups here talk only to the target's own public infrastructure
(the domain's WHOIS server, its DNS resolvers, or the platform's own
profile-page URL) — the same requests a browser or the `whois`/`dig`
CLI tools would make. Nothing here queries third-party aggregators,
breach databases, or scrapes search results.

Handle checks are deliberately rate-limited and capped to a fixed platform
list to avoid hammering any single service.
"""

import socket
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import whois as pywhois

REQUEST_TIMEOUT = 6
USER_AGENT = "Mozilla/5.0 (compatible; MABU-local-research-tool/1.0)"

# platform -> (profile URL template, "not found" signal)
HANDLE_PLATFORMS = {
    "GitHub": "https://github.com/{u}",
    "Reddit": "https://www.reddit.com/user/{u}/about.json",
    "GitLab": "https://gitlab.com/{u}",
    "Instagram": "https://www.instagram.com/{u}/",
    "TikTok": "https://www.tiktok.com/@{u}",
    "Twitch": "https://www.twitch.tv/{u}",
    "Steam": "https://steamcommunity.com/id/{u}",
    "Telegram": "https://t.me/{u}",
}


def whois_lookup(domain: str) -> dict:
    try:
        w = pywhois.whois(domain)
    except Exception as e:
        return {"domain": domain, "error": str(e)}

    def norm(v):
        if isinstance(v, list):
            return [str(x) for x in v]
        if v is None:
            return None
        return str(v)

    return {
        "domain": domain,
        "registrar": norm(getattr(w, "registrar", None)),
        "creation_date": norm(getattr(w, "creation_date", None)),
        "expiration_date": norm(getattr(w, "expiration_date", None)),
        "updated_date": norm(getattr(w, "updated_date", None)),
        "name_servers": norm(getattr(w, "name_servers", None)),
        "status": norm(getattr(w, "status", None)),
        "emails": norm(getattr(w, "emails", None)),
        "org": norm(getattr(w, "org", None)),
        "country": norm(getattr(w, "country", None)),
    }


def dns_lookup(domain: str) -> dict:
    result = {"domain": domain, "a_records": [], "error": None}
    try:
        infos = socket.getaddrinfo(domain, None, socket.AF_INET)
        result["a_records"] = sorted({info[4][0] for info in infos})
    except socket.gaierror as e:
        result["error"] = f"A record lookup failed: {e}"

    try:
        result["reverse_dns"] = socket.gethostbyaddr(result["a_records"][0])[0] if result["a_records"] else None
    except (socket.herror, socket.gaierror, IndexError):
        result["reverse_dns"] = None

    try:
        aliases, _, addrs = socket.gethostbyname_ex(domain)
        result["aliases"] = aliases
    except socket.gaierror:
        result["aliases"] = []

    return result


def _check_url_exists(url: str) -> tuple[bool, str]:
    req = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return resp.status < 400, f"HTTP {resp.status}"
    except HTTPError as e:
        return e.code < 400, f"HTTP {e.code}"
    except URLError as e:
        return False, f"unreachable: {e.reason}"
    except Exception as e:
        return False, f"error: {e}"


def handle_check_all(username: str) -> dict:
    results = []
    for platform, template in HANDLE_PLATFORMS.items():
        url = template.format(u=username)
        exists, detail = _check_url_exists(url)
        results.append({
            "platform": platform,
            "url": url,
            "likely_exists": exists,
            "detail": detail,
        })
        time.sleep(0.15)  # courteous pacing between requests

    return {"username": username, "results": results}
