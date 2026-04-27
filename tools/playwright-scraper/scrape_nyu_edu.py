#!/usr/bin/env python3
"""
NYU.edu Playwright Scraper (Phase 7-B Step 1)
=============================================
Scrapes WAF-gated NYU.edu pages that the existing
`bulletin-scraper/scrape_bulletin.py` (a plain `requests` BFS crawler)
cannot reach. Specifically: pages on `nyu.edu/students/...` and
`nyu.edu/admissions/...` are gated by AWS WAF that returns HTTP 202
+ a JS challenge for non-browser clients.

This scraper uses headless Chromium via Playwright to execute the JS
challenge, accept the WAF cookie, then load the actual page.

Output mirrors the existing `data/bulletin-raw/` pattern:
- `_index.html` (raw HTML after JS execution)
- `_index.md` (markdownified main content with the project's
   `url`/`title`/`scraped_at` frontmatter)

Scope is BOUNDED by a path-prefix allowlist (passed via --prefix).
The scraper only follows internal links whose path starts with one
of the allowed prefixes. This prevents runaway crawling of all of
nyu.edu (which is large + WAF-rate-limited).

Usage:
  python3 scrape_nyu_edu.py \
    --seed https://www.nyu.edu/students/student-information-and-resources/student-visa-and-immigration.html \
    --prefix /students/student-information-and-resources/student-visa-and-immigration/ \
    --output-subdir ogs

  # Step 2 (Stern internal-transfer equivalencies):
  python3 scrape_nyu_edu.py \
    --seed https://www.nyu.edu/admissions/undergraduate-admissions/how-to-apply/internal-transfers/internal-transfers-stern.html \
    --prefix /admissions/undergraduate-admissions/how-to-apply/internal-transfers/ \
    --output-subdir internal-transfer-equivalencies
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse

from bs4 import BeautifulSoup
from markdownify import markdownify as md
from playwright.sync_api import Browser, Page, sync_playwright

# ─── Configuration ──────────────────────────────────────────────────────────

DOMAIN = "www.nyu.edu"
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent  # NYU Path/
OUTPUT_BASE = PROJECT_ROOT / "data" / "bulletin-raw"
PROGRESS_FILE = SCRIPT_DIR / ".scrape_progress.json"
LOG_FILE = SCRIPT_DIR / "scrape.log"

# Browser tuning
PAGE_TIMEOUT_MS = 45_000  # 45s — WAF challenge can take a few seconds
NAV_WAIT_UNTIL = "domcontentloaded"  # don't wait for slow third-party JS
INTER_PAGE_DELAY_S = 1.5  # courteous rate limit
MAX_PAGES_DEFAULT = 30  # safety cap

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/145.0.0.0 Safari/537.36"
)

SKIP_SUBSTRINGS = [
    "javascript:", "mailto:", "tel:",
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".ico",
    ".css", ".js", ".woff", ".woff2", ".ttf",
    "facebook.com", "twitter.com", "instagram.com",
    "youtube.com", "linkedin.com", "tiktok.com",
    "/search/", "/class-search/",
]

# ─── Logging ────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_FILE, mode="a"),
    ],
)
log = logging.getLogger("playwright-scraper")


# ─── URL helpers ────────────────────────────────────────────────────────────

def normalize_url(url: str) -> str:
    """Strip fragments + querystrings; ensure trailing slash for dirs."""
    parsed = urlparse(url)
    path = parsed.path
    if path and not path.endswith("/"):
        last_segment = path.rsplit("/", 1)[-1]
        if "." not in last_segment:
            path = path + "/"
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def should_skip(url: str, allowed_prefixes: list[str]) -> bool:
    """Skip non-HTML / off-domain / out-of-scope URLs."""
    for pat in SKIP_SUBSTRINGS:
        if pat in url.lower():
            return True
    parsed = urlparse(url)
    if parsed.netloc and parsed.netloc != DOMAIN:
        return True
    # Path must start with one of the allowed prefixes.
    return not any(parsed.path.startswith(p) for p in allowed_prefixes)


def url_to_dir(url: str, output_subdir: str) -> Path:
    """Map URL → local dir mirroring the PATH SUFFIX after the prefix root."""
    parsed = urlparse(url)
    path = parsed.path.strip("/")
    if path.endswith(".html"):
        path = path[:-5]
    return OUTPUT_BASE / output_subdir / path.split("/", 1)[-1] if "/" in path else OUTPUT_BASE / output_subdir


# ─── Content extraction ────────────────────────────────────────────────────

def extract_main_content(soup: BeautifulSoup) -> BeautifulSoup:
    """Try common main-content containers, fall back to body sans chrome."""
    candidates = [
        soup.find("main"),
        soup.find("div", id="main"),
        soup.find("div", id="content"),
        soup.find("div", id="contentarea"),
        soup.find("div", class_="page-content"),
        soup.find("article"),
    ]
    for c in candidates:
        if c is not None:
            return c
    body = soup.find("body")
    if body:
        for tag in body.find_all(
            ["nav", "header", "footer", "script", "style", "noscript", "aside"]
        ):
            tag.decompose()
        return body
    return soup


def clean_markdown(raw_md: str) -> str:
    lines = raw_md.split("\n")
    cleaned = []
    blank_run = 0
    for line in lines:
        if line.strip() == "":
            blank_run += 1
            if blank_run <= 2:
                cleaned.append("")
        else:
            blank_run = 0
            cleaned.append(line)
    return "\n".join(cleaned).strip()


def extract_links(soup: BeautifulSoup, page_url: str, allowed_prefixes: list[str]) -> list[str]:
    out: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href:
            continue
        full = normalize_url(urljoin(page_url, href))
        if not should_skip(full, allowed_prefixes):
            out.add(full)
    return sorted(out)


# ─── Scraping core ──────────────────────────────────────────────────────────

def fetch_page(page: Page, url: str) -> tuple[str | None, str | None]:
    """Navigate + wait for WAF challenge to clear. Returns (html, title) or (None, error)."""
    try:
        page.goto(url, timeout=PAGE_TIMEOUT_MS, wait_until=NAV_WAIT_UNTIL)
        # Give the WAF challenge a moment to resolve. The challenge sets
        # a cookie + redirects; once cleared, page.content() returns the
        # actual HTML.
        page.wait_for_load_state("networkidle", timeout=PAGE_TIMEOUT_MS)
        html = page.content()
        title = page.title()
        return html, title
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def save_page(url: str, html: str, title: str, output_subdir: str) -> Path:
    out_dir = url_to_dir(url, output_subdir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "_index.html").write_text(html, encoding="utf-8")

    soup = BeautifulSoup(html, "html.parser")
    content = extract_main_content(soup)
    raw_md = md(str(content), heading_style="ATX", strip=["script", "style"])
    body = clean_markdown(raw_md)

    header = (
        "---\n"
        f"url: {url}\n"
        f'title: "{title}"\n'
        f"scraped_at: {datetime.now().isoformat()}\n"
        "---\n\n"
    )
    (out_dir / "_index.md").write_text(header + body, encoding="utf-8")
    return out_dir


def crawl(
    seed_url: str,
    allowed_prefixes: list[str],
    output_subdir: str,
    max_pages: int,
) -> dict:
    visited: set[str] = set()
    queue: deque[str] = deque([normalize_url(seed_url)])
    failed: dict[str, str] = {}
    saved: list[str] = []

    with sync_playwright() as pw:
        browser: Browser = pw.chromium.launch(headless=True)
        context = browser.new_context(user_agent=USER_AGENT)
        page = context.new_page()

        while queue and len(visited) < max_pages:
            url = queue.popleft()
            if url in visited:
                continue
            visited.add(url)

            log.info(f"[{len(visited)}/{max_pages}] GET {url}")
            html, err_or_title = fetch_page(page, url)
            if html is None:
                failed[url] = str(err_or_title)
                log.warning(f"  failed: {err_or_title}")
                continue

            title = err_or_title or ""
            try:
                out_dir = save_page(url, html, title, output_subdir)
                saved.append(str(out_dir.relative_to(PROJECT_ROOT)))
                log.info(f"  saved → {out_dir.relative_to(PROJECT_ROOT)}")
            except Exception as e:  # noqa: BLE001
                failed[url] = f"save error: {e}"
                log.warning(f"  save failed: {e}")
                continue

            # Discover internal links in the just-fetched page.
            soup = BeautifulSoup(html, "html.parser")
            for link in extract_links(soup, url, allowed_prefixes):
                if link not in visited and link not in queue:
                    queue.append(link)

            time.sleep(INTER_PAGE_DELAY_S)

        browser.close()

    return {
        "scraped_at": datetime.now().isoformat(),
        "seed": seed_url,
        "allowed_prefixes": allowed_prefixes,
        "output_subdir": output_subdir,
        "pages_visited": len(visited),
        "pages_saved": len(saved),
        "saved": saved,
        "failed": failed,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Playwright-backed NYU.edu scraper")
    parser.add_argument("--seed", required=True, help="Seed URL to start BFS")
    parser.add_argument(
        "--prefix",
        action="append",
        required=True,
        help="Path prefix that links must start with (repeatable).",
    )
    parser.add_argument(
        "--output-subdir",
        required=True,
        help="Subdir under data/bulletin-raw/ to write into (e.g. 'ogs').",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=MAX_PAGES_DEFAULT,
        help=f"Safety cap on pages visited (default: {MAX_PAGES_DEFAULT}).",
    )
    args = parser.parse_args()

    log.info(f"Starting scrape: seed={args.seed} prefixes={args.prefix} subdir={args.output_subdir}")
    summary = crawl(
        seed_url=args.seed,
        allowed_prefixes=args.prefix,
        output_subdir=args.output_subdir,
        max_pages=args.max_pages,
    )
    log.info(
        f"Done. visited={summary['pages_visited']} saved={summary['pages_saved']} "
        f"failed={len(summary['failed'])}"
    )
    PROGRESS_FILE.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    log.info(f"Progress: {PROGRESS_FILE}")
    return 0 if summary["pages_saved"] > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
