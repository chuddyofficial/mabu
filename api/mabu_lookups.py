"""
mabu_lookups.py — public-record lookups: WHOIS, DNS, platform
handle-existence checks, phone number metadata, and opt-in breach checks.

All lookups here talk only to the target's own public infrastructure
(the domain's WHOIS server, its DNS resolvers, the platform's own
profile-page URL) or, for breach checks, the official Have I Been Pwned
API using a key *you* supply — nothing here scrapes third-party
aggregators or unofficial breach dumps.

Handle checks are deliberately rate-limited and capped to a fixed platform
list to avoid hammering any single service.
"""

import json
import os
import socket
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import phonenumbers
from phonenumbers import geocoder, carrier as pn_carrier, timezone as pn_timezone
import whois as pywhois

REQUEST_TIMEOUT = 6
USER_AGENT = "Mozilla/5.0 (compatible; MABU-local-research-tool/1.0)"
HIBP_API_KEY_ENV = "MABU_HIBP_API_KEY"
HIBP_API_BASE = "https://haveibeenpwned.com/api/v3"

# platform -> profile URL template. Each platform also gets a bespoke
# existence check in _check_platform() below — a bare HTTP status code is
# NOT a reliable "exists" signal for most of these sites. Several serve a
# 200 OK "not found" / login-wall / challenge page to any request that
# doesn't look like a real browser session, which would otherwise show
# every username (even made-up ones) as "likely exists". Platforms that
# can't be checked reliably this way are intentionally left out rather
# than shown with misleading results.
HANDLE_PLATFORMS = {
    "GitHub": "https://github.com/{u}",
    "GitLab": "https://gitlab.com/{u}",
    "Reddit": "https://www.reddit.com/user/{u}/about.json",
    "Steam": "https://steamcommunity.com/id/{u}?xml=1",
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


def _fetch(url: str) -> tuple[int | None, str, str | None]:
    """Returns (status_code, body_text, error). body_text is '' on non-2xx/3xx
    responses read via HTTPError, since many of these platforms put useful
    "not found" markers in a 404 page body, not just the status code."""
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            body = resp.read(65536).decode("utf-8", errors="replace")
            return resp.status, body, None
    except HTTPError as e:
        try:
            body = e.read(65536).decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return e.code, body, None
    except URLError as e:
        return None, "", f"unreachable: {e.reason}"
    except Exception as e:
        return None, "", f"error: {e}"


def _check_github_gitlab(url: str) -> tuple[bool | None, str]:
    status, _body, err = _fetch(url)
    if err:
        return None, err
    if status == 404:
        return False, "HTTP 404 (not found)"
    if status and status < 400:
        return True, f"HTTP {status}"
    return None, f"HTTP {status} (inconclusive)"


def _check_reddit(url: str) -> tuple[bool | None, str]:
    status, body, err = _fetch(url)
    if err:
        return None, err
    if status == 404:
        return False, "HTTP 404 (not found)"
    if status == 403 or status == 429:
        return None, f"HTTP {status} (blocked/rate-limited by Reddit — inconclusive)"
    if status and status < 400:
        # Reddit's own API marks a suspended/shadowbanned/nonexistent user
        # with an explicit error body even on a 200-family response.
        if '"error"' in body and ("USER_REQUIRED" in body or "NOT_FOUND" in body.upper()):
            return False, "account not found (per Reddit API response)"
        return True, f"HTTP {status}"
    return None, f"HTTP {status} (inconclusive)"


def _check_steam(url: str) -> tuple[bool | None, str]:
    status, body, err = _fetch(url)
    if err:
        return None, err
    if status and status < 400:
        # The XML profile endpoint returns <response><error>The specified
        # profile could not be found.</error></response> for a nonexistent
        # vanity URL, still with a 200 status — the HTML page does the same
        # thing invisibly, which is why the XML variant is used here.
        if "<error>" in body.lower():
            return False, "profile not found (per Steam XML response)"
        if "<steamid64>" in body.lower() or "<steamid>" in body.lower():
            return True, f"HTTP {status}"
        return None, f"HTTP {status} (unrecognized response format)"
    return None, f"HTTP {status} (inconclusive)"


PLATFORM_CHECKERS = {
    "GitHub": _check_github_gitlab,
    "GitLab": _check_github_gitlab,
    "Reddit": _check_reddit,
    "Steam": _check_steam,
}


def handle_check_all(username: str) -> dict:
    results = []
    for platform, template in HANDLE_PLATFORMS.items():
        url = template.format(u=username)
        checker = PLATFORM_CHECKERS[platform]
        exists, detail = checker(url)
        results.append({
            "platform": platform,
            "url": url,
            "likely_exists": exists,
            "detail": detail,
        })
        time.sleep(0.15)  # courteous pacing between requests

    return {"username": username, "results": results}


# ---------------------------------------------------------------------------
# Phone number lookup (local, protocol/library-based — no external API)
# ---------------------------------------------------------------------------

def phone_lookup(raw_number: str, default_region: str = "US") -> dict:
    try:
        parsed = phonenumbers.parse(raw_number, default_region)
    except phonenumbers.NumberParseException as e:
        return {"input": raw_number, "valid": False, "error": str(e)}

    return {
        "input": raw_number,
        "valid": phonenumbers.is_valid_number(parsed),
        "possible": phonenumbers.is_possible_number(parsed),
        "e164": phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164),
        "international": phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.INTERNATIONAL),
        "national": phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.NATIONAL),
        "country_code": parsed.country_code,
        "region": geocoder.description_for_number(parsed, "en") or None,
        "carrier": pn_carrier.name_for_number(parsed, "en") or None,
        "timezones": list(pn_timezone.time_zones_for_number(parsed)),
        "number_type": str(phonenumbers.number_type(parsed)),
    }


# ---------------------------------------------------------------------------
# Breach check (Have I Been Pwned — official API, requires your own key)
# ---------------------------------------------------------------------------

def hibp_is_configured() -> bool:
    return bool(os.environ.get(HIBP_API_KEY_ENV))


def hibp_breach_check(email: str) -> dict:
    api_key = os.environ.get(HIBP_API_KEY_ENV)
    if not api_key:
        return {
            "configured": False,
            "error": f"Set the {HIBP_API_KEY_ENV} environment variable with your own HaveIBeenPwned API key to enable this feature.",
        }

    url = f"{HIBP_API_BASE}/breachedaccount/{email}?truncateResponse=false"
    req = Request(url, headers={
        "hibp-api-key": api_key,
        "User-Agent": USER_AGENT,
    })

    try:
        with urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            breaches = json.loads(resp.read().decode("utf-8"))
            return {
                "configured": True,
                "email": email,
                "breached": True,
                "breach_count": len(breaches),
                "breaches": [
                    {
                        "name": b.get("Name"),
                        "title": b.get("Title"),
                        "domain": b.get("Domain"),
                        "breach_date": b.get("BreachDate"),
                        "data_classes": b.get("DataClasses", []),
                    }
                    for b in breaches
                ],
            }
    except HTTPError as e:
        if e.code == 404:
            return {"configured": True, "email": email, "breached": False, "breach_count": 0, "breaches": []}
        if e.code == 401:
            return {"configured": True, "error": "HIBP API key was rejected (401) — check the key is valid."}
        if e.code == 429:
            return {"configured": True, "error": "Rate limited by HIBP (429) — wait a moment and try again."}
        return {"configured": True, "error": f"HIBP request failed: HTTP {e.code}"}
    except URLError as e:
        return {"configured": True, "error": f"Could not reach HIBP: {e.reason}"}
