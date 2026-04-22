#!/usr/bin/env python3
"""
NYU Bulletin Full-Site Scraper
==============================
Crawls the ENTIRE bulletins.nyu.edu website starting from the root,
following every internal link via BFS. The original URL path structure
is mirrored exactly as the local directory hierarchy.

NO hardcoded assumptions about site structure — the crawler discovers
everything organically by following links.

Output structure mirrors the URL paths EXACTLY:
  data/bulletin-raw/
  └── (mirrors the exact path from bulletins.nyu.edu)

Usage:
  python3 scrape_bulletin.py                    # full scrape
  python3 scrape_bulletin.py --resume           # resume from last progress
"""

import os
import sys
import json
import time
import argparse
import logging
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse
from collections import deque
from datetime import datetime

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify as md

# ─── Configuration ──────────────────────────────────────────────────────────

BASE_URL = "https://bulletins.nyu.edu/"
DOMAIN = "bulletins.nyu.edu"

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent  # NYU Path/
OUTPUT_DIR = PROJECT_ROOT / "data" / "bulletin-raw"
PROGRESS_FILE = SCRIPT_DIR / ".scrape_progress.json"
LOG_FILE = SCRIPT_DIR / "scrape.log"

# Defaults
DEFAULT_DELAY = 0.5  # seconds between requests
MAX_RETRIES = 3
RETRY_DELAY = 5
TIMEOUT = 30

USER_AGENT = (
    "NYUPathBot/1.0 (Academic Advising Research; "
    "contact: nyu-path-research@nyu.edu)"
)
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}

# URL patterns to NEVER follow (assets, external, dynamic)
SKIP_SUBSTRINGS = [
    "javascript:", "mailto:", "tel:",
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".ico",
    ".css", ".js", ".woff", ".woff2", ".ttf",
    "facebook.com", "twitter.com", "instagram.com",
    "youtube.com", "linkedin.com", "tiktok.com",
    "/class-search/",   # dynamic search widget
    "/search/",         # per-course lookups (247k+ pages, data already in /courses/)
    "/archive/",        # previous years' bulletins (full mirrors, causes queue explosion)
    "/courses/",        # department course catalogs (already scraped ~658 pages)
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
log = logging.getLogger("bulletin-scraper")

# ─── Scraper ────────────────────────────────────────────────────────────────


class BulletinScraper:
    """
    BFS crawler that:
    1. Starts from bulletins.nyu.edu/
    2. Follows every <a href> that stays within the same domain
    3. Saves each page as _index.html (raw) + _index.md (markdown)
       in a directory that mirrors the URL path exactly
    """

    def __init__(self, output_dir: Path, delay: float = DEFAULT_DELAY, resume: bool = False):
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.delay = delay

        self.session = requests.Session()
        self.session.headers.update(HEADERS)

        # State
        self.visited: set = set()
        self.failed: dict = {}
        self.queue: deque = deque()
        self.stats = {
            "pages_scraped": 0,
            "pages_skipped": 0,
            "pages_failed": 0,
            "bytes_downloaded": 0,
            "start_time": datetime.now().isoformat(),
        }

        if resume and PROGRESS_FILE.exists():
            self._load_progress()
            log.info(f"Resumed: {len(self.visited)} already scraped, {len(self.queue)} in queue")
        else:
            # Single root seed — BFS discovers everything
            self.queue.append(BASE_URL)

    # ── URL helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _normalize_url(url: str) -> str:
        """Normalize: strip fragment, ensure trailing slash for path-only URLs."""
        parsed = urlparse(url)
        path = parsed.path

        # Remove fragment
        # Ensure trailing slash if path looks like a directory (no extension)
        if path and not path.endswith("/"):
            last_segment = path.rsplit("/", 1)[-1]
            if "." not in last_segment:
                path = path + "/"

        return urlunparse(
            (parsed.scheme, parsed.netloc, path, "", parsed.query, "")
        )

    @staticmethod
    def _should_skip(url: str) -> bool:
        """Skip non-HTML / external / unwanted URLs."""
        for pat in SKIP_SUBSTRINGS:
            if pat in url.lower():
                return True
        parsed = urlparse(url)
        if parsed.netloc and parsed.netloc != DOMAIN:
            return True
        return False

    def _url_to_dir(self, url: str) -> Path:
        """Map a URL to a local directory path, mirroring the URL path exactly."""
        parsed = urlparse(url)
        path = parsed.path.strip("/")
        if not path:
            return self.output_dir  # root
        return self.output_dir / path

    def _extract_links(self, soup: BeautifulSoup, page_url: str) -> list:
        """Extract all internal links from a page."""
        links = set()
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            if not href:
                continue
            full = urljoin(page_url, href)
            full = self._normalize_url(full)
            if not self._should_skip(full) and full not in self.visited:
                links.add(full)
        return list(links)

    # ── Content extraction ───────────────────────────────────────────────

    @staticmethod
    def _extract_main_content(soup: BeautifulSoup) -> BeautifulSoup:
        """Isolate the main content, removing site chrome."""
        # The bulletin site uses a #contentarea div
        content = (
            soup.find("div", id="contentarea")
            or soup.find("main")
            or soup.find("div", class_="page-content")
        )
        if content:
            return content

        # Fallback: remove nav/header/footer from body
        body = soup.find("body")
        if body:
            for tag in body.find_all(["nav", "header", "footer", "script",
                                      "style", "noscript"]):
                tag.decompose()
            return body
        return soup

    @staticmethod
    def _clean_markdown(raw_md: str) -> str:
        """Remove excessive blank lines."""
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

    # ── I/O ──────────────────────────────────────────────────────────────

    def _save_page(self, url: str, html: str, soup: BeautifulSoup):
        """Save raw HTML + markdown, mirroring URL path."""
        out_dir = self._url_to_dir(url)
        out_dir.mkdir(parents=True, exist_ok=True)

        # 1. Raw HTML
        (out_dir / "_index.html").write_text(html, encoding="utf-8")

        # 2. Extracted markdown
        content_soup = self._extract_main_content(soup)
        raw_md = md(str(content_soup), heading_style="ATX", strip=["script", "style"])
        clean = self._clean_markdown(raw_md)

        # Metadata header
        title_tag = soup.find("title")
        title = title_tag.get_text(strip=True) if title_tag else ""
        header = (
            f"---\n"
            f"url: {url}\n"
            f"title: \"{title}\"\n"
            f"scraped_at: {datetime.now().isoformat()}\n"
            f"---\n\n"
        )
        (out_dir / "_index.md").write_text(header + clean, encoding="utf-8")

        self.stats["bytes_downloaded"] += len(html)

    def _save_progress(self):
        data = {
            "visited": list(self.visited),
            "failed": self.failed,
            "queue": list(self.queue),
            "stats": self.stats,
        }
        PROGRESS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _load_progress(self):
        data = json.loads(PROGRESS_FILE.read_text(encoding="utf-8"))
        self.visited = set(data.get("visited", []))
        self.failed = data.get("failed", {})
        self.queue = deque(data.get("queue", []))
        prev = data.get("stats", {})
        self.stats["pages_scraped"] = prev.get("pages_scraped", 0)
        self.stats["pages_skipped"] = prev.get("pages_skipped", 0)
        self.stats["pages_failed"] = prev.get("pages_failed", 0)
        self.stats["bytes_downloaded"] = prev.get("bytes_downloaded", 0)

    # ── Network ──────────────────────────────────────────────────────────

    def _fetch(self, url: str):
        """Fetch with retries. Returns (html, status) or (None, error_str)."""
        for attempt in range(MAX_RETRIES):
            try:
                r = self.session.get(url, timeout=TIMEOUT, allow_redirects=True)
                if r.status_code == 200:
                    # Only process HTML responses
                    ct = r.headers.get("Content-Type", "")
                    if "text/html" not in ct and "application/xhtml" not in ct:
                        return None, f"non-html ({ct})"
                    return r.text, 200
                elif r.status_code == 404:
                    return None, "404"
                elif r.status_code == 429:
                    wait = RETRY_DELAY * (attempt + 2)
                    log.warning(f"  429 rate-limited, waiting {wait}s")
                    time.sleep(wait)
                else:
                    log.warning(f"  HTTP {r.status_code}: {url}")
                    if attempt < MAX_RETRIES - 1:
                        time.sleep(RETRY_DELAY)
            except requests.exceptions.RequestException as e:
                log.warning(f"  Net error (attempt {attempt+1}/{MAX_RETRIES}): {e}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(RETRY_DELAY)
        return None, "max_retries"

    # ── Main loop ────────────────────────────────────────────────────────

    def scrape(self):
        log.info(f"Output: {self.output_dir}")
        log.info(f"Delay: {self.delay}s | Queue: {len(self.queue)} | Visited: {len(self.visited)}")
        log.info("Starting BFS crawl from root...")

        try:
            while self.queue:
                url = self.queue.popleft()
                url = self._normalize_url(url)

                if url in self.visited:
                    continue
                if self._should_skip(url):
                    self.stats["pages_skipped"] += 1
                    continue

                self.visited.add(url)
                time.sleep(self.delay)

                n = self.stats["pages_scraped"] + 1
                # Show short path for readability
                short = url.replace("https://bulletins.nyu.edu", "")
                log.info(f"[{n}] {short}")

                html, status = self._fetch(url)
                if html is None:
                    self.failed[url] = str(status)
                    self.stats["pages_failed"] += 1
                    if str(status) != "404":
                        log.warning(f"  FAILED: {status}")
                    continue

                soup = BeautifulSoup(html, "html.parser")
                self._save_page(url, html, soup)
                self.stats["pages_scraped"] += 1

                # Discover new links
                new_links = self._extract_links(soup, url)
                for link in new_links:
                    if link not in self.visited:
                        self.queue.append(link)

                # Periodic progress save
                if n % 50 == 0:
                    self._save_progress()
                    log.info(
                        f"  ── checkpoint: scraped={n} queue={len(self.queue)} "
                        f"failed={self.stats['pages_failed']} ──"
                    )

        except KeyboardInterrupt:
            log.info("\n⚠️  Interrupted — saving progress for --resume ...")
        finally:
            self._save_progress()
            self._print_summary()

    def _print_summary(self):
        elapsed = "?"
        try:
            t0 = datetime.fromisoformat(self.stats["start_time"])
            elapsed = str(datetime.now() - t0).split(".")[0]
        except Exception:
            pass

        mb = self.stats["bytes_downloaded"] / (1024 * 1024)
        log.info("")
        log.info("=" * 60)
        log.info("  SCRAPE SUMMARY")
        log.info("=" * 60)
        log.info(f"  Pages scraped : {self.stats['pages_scraped']}")
        log.info(f"  Pages skipped : {self.stats['pages_skipped']}")
        log.info(f"  Pages failed  : {self.stats['pages_failed']}")
        log.info(f"  Downloaded    : {mb:.1f} MB")
        log.info(f"  Elapsed       : {elapsed}")
        log.info(f"  Output        : {self.output_dir}")

        if self.failed:
            log.info(f"\n  Failed ({len(self.failed)}):")
            for url, reason in sorted(self.failed.items())[:30]:
                short = url.replace("https://bulletins.nyu.edu", "")
                log.info(f"    [{reason}] {short}")
            if len(self.failed) > 30:
                log.info(f"    ... +{len(self.failed)-30} more")

        log.info("=" * 60)

        # Write manifest
        manifest = {
            "completed_at": datetime.now().isoformat(),
            "stats": self.stats,
            "total_urls_visited": len(self.visited),
            "failed_urls": self.failed,
        }
        mf = self.output_dir / "_manifest.json"
        mf.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        log.info(f"  Manifest: {mf}")


# ─── CLI ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Scrape bulletins.nyu.edu (full BFS)")
    parser.add_argument("--resume", action="store_true", help="Resume from saved progress")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY, help="Seconds between requests")
    parser.add_argument("--output", type=str, default=None, help="Custom output directory")
    args = parser.parse_args()

    out = Path(args.output) if args.output else OUTPUT_DIR

    scraper = BulletinScraper(output_dir=out, delay=args.delay, resume=args.resume)
    scraper.scrape()


if __name__ == "__main__":
    main()
