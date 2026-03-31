import asyncio
import re
import time
from datetime import datetime, timezone
from typing import Optional

import feedparser
import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI(title="Newsie")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

_cache: dict = {}
CACHE_TTL = 900  # 15 minutes
MAX_PER_FEED = 15

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; Newsie/1.0; RSS Reader)"
}


def extract_image(entry) -> Optional[str]:
    # media:thumbnail
    if hasattr(entry, "media_thumbnail") and entry.media_thumbnail:
        url = entry.media_thumbnail[0].get("url", "")
        if url and url.startswith("http"):
            return url

    # media:content — prefer larger images
    if hasattr(entry, "media_content") and entry.media_content:
        candidates = [m for m in entry.media_content if m.get("url", "").startswith("http")]
        # sort by width descending if available
        candidates.sort(key=lambda m: int(m.get("width", 0) or 0), reverse=True)
        for m in candidates:
            t = m.get("type", "")
            med = m.get("medium", "")
            if "image" in t or med == "image" or (not t and not med):
                url = m["url"]
                if not url.endswith(".gif"):
                    return url

    # enclosures
    if hasattr(entry, "enclosures") and entry.enclosures:
        for enc in entry.enclosures:
            if "image" in enc.get("type", "") and enc.get("url", "").startswith("http"):
                return enc["url"]

    # links with rel="enclosure" or type image
    if hasattr(entry, "links") and entry.links:
        for link in entry.links:
            if "image" in link.get("type", "") and link.get("href", "").startswith("http"):
                return link["href"]

    # parse HTML in content then summary — look for largest img
    for attr in ("content", "summary"):
        html = ""
        if attr == "content" and hasattr(entry, "content") and entry.content:
            html = entry.content[0].get("value", "")
        elif attr == "summary" and hasattr(entry, "summary") and entry.summary:
            html = entry.summary
        if not html:
            continue
        soup = BeautifulSoup(html, "lxml")
        # skip tiny tracking pixels, prefer wide images
        for img in soup.find_all("img"):
            src = img.get("src", "")
            if not src.startswith("http") or src.endswith(".gif"):
                continue
            w = int(img.get("width", 0) or 0)
            h = int(img.get("height", 0) or 0)
            if w and w < 100:
                continue  # skip tiny images
            if h and h < 60:
                continue
            return src

    return None


_og_cache: dict = {}

async def fetch_og_image(url: str) -> Optional[str]:
    """Fetch a page and extract its og:image."""
    if url in _og_cache:
        return _og_cache[url]
    try:
        async with httpx.AsyncClient(timeout=6, follow_redirects=True, headers=HEADERS) as client:
            r = await client.get(url)
            soup = BeautifulSoup(r.text, "lxml")
            for prop in ("og:image", "twitter:image", "og:image:secure_url"):
                tag = soup.find("meta", property=prop) or soup.find("meta", attrs={"name": prop})
                if tag:
                    img = tag.get("content", "")
                    if img.startswith("http"):
                        _og_cache[url] = img
                        return img
    except Exception:
        pass
    _og_cache[url] = None
    return None


def parse_date(entry) -> datetime:
    for attr in ("published_parsed", "updated_parsed"):
        val = getattr(entry, attr, None)
        if val:
            try:
                return datetime(*val[:6], tzinfo=timezone.utc)
            except Exception:
                pass
    return datetime.now(timezone.utc)


def clean_summary(entry) -> str:
    html = ""
    if hasattr(entry, "summary") and entry.summary:
        html = entry.summary
    elif hasattr(entry, "content") and entry.content:
        html = entry.content[0].get("value", "")
    if not html:
        return ""
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(separator=" ", strip=True)
    return text[:220] + "..." if len(text) > 220 else text


def clean_title(title: str, is_google_news: bool = False) -> str:
    title = title.strip()
    if is_google_news:
        # Google News format: "Article Title - Source Name"
        parts = title.rsplit(" - ", 1)
        if len(parts) == 2:
            title = parts[0].strip()
    return title


def time_ago(dt: datetime) -> str:
    diff = datetime.now(timezone.utc) - dt
    s = diff.total_seconds()
    if s < 60:
        return "Just now"
    if s < 3600:
        return f"{int(s/60)}m ago"
    if s < 86400:
        return f"{int(s/3600)}h ago"
    return f"{int(s/86400)}d ago"


async def fetch_feed(url: str) -> list:
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers=HEADERS) as client:
            r = await client.get(url)
            if r.status_code != 200:
                return []
            return feedparser.parse(r.text).entries or []
    except Exception:
        return []


@app.get("/api/articles")
async def get_articles(tab: str = "today", source: Optional[str] = None):
    from feeds import FEEDS

    cache_key = f"{tab}:{source or 'all'}"
    now = time.time()
    if cache_key in _cache and now - _cache[cache_key]["ts"] < CACHE_TTL:
        return _cache[cache_key]["data"]

    if tab == "today":
        feeds = FEEDS
    else:
        feeds = [f for f in FEEDS if f.get("tab") == tab]

    if source:
        feeds = [f for f in feeds if f["id"] == source]

    # Build tasks list
    tasks, feed_map = [], []
    for feed_config in feeds:
        for url in feed_config["urls"]:
            tasks.append(fetch_feed(url))
            feed_map.append(feed_config)

    results = await asyncio.gather(*tasks, return_exceptions=True)

    articles = []
    seen = set()

    for feed_config, entries in zip(feed_map, results):
        if isinstance(entries, Exception) or not entries:
            continue
        is_gn = feed_config.get("is_google_news", False)
        for entry in entries[:MAX_PER_FEED]:
            link = entry.get("link", "")
            if not link or link in seen:
                continue
            seen.add(link)
            pub = parse_date(entry)
            articles.append({
                "id": link,
                "title": clean_title(entry.get("title", "").strip(), is_gn),
                "link": link,
                "summary": clean_summary(entry),
                "image": extract_image(entry),
                "source": feed_config["name"],
                "source_id": feed_config["id"],
                "source_short": feed_config["short"],
                "category": feed_config["category"],
                "color": feed_config["color"],
                "tab": feed_config["tab"],
                "published": pub.isoformat(),
                "time_ago": time_ago(pub),
            })

    articles.sort(key=lambda x: x["published"], reverse=True)
    result = {"articles": articles, "count": len(articles), "tab": tab}
    _cache[cache_key] = {"ts": now, "data": result}
    return result


@app.get("/api/sources")
async def get_sources():
    from feeds import FEEDS
    return {
        "sources": [
            {
                "id": f["id"],
                "name": f["name"],
                "short": f["short"],
                "category": f["category"],
                "color": f["color"],
                "tab": f["tab"],
            }
            for f in FEEDS
        ]
    }


@app.get("/api/ogimage")
async def get_og_image(url: str):
    """Fetch and return the OG image for a given article URL."""
    image = await fetch_og_image(url)
    return {"image": image}


@app.get("/api/feed-preview")
async def feed_preview(url: str, name: str = ""):
    """Validate and preview an RSS feed URL — used when adding custom sources."""
    entries = await fetch_feed(url)
    if not entries:
        return {"valid": False, "error": "No articles found. Check the URL is a valid RSS feed."}

    # Try to detect feed name from entries
    detected_name = name or "Custom Feed"

    articles = []
    seen = set()
    for entry in entries[:5]:
        link = entry.get("link", "")
        if not link or link in seen:
            continue
        seen.add(link)
        pub = parse_date(entry)
        articles.append({
            "title": entry.get("title", "").strip(),
            "link": link,
            "image": extract_image(entry),
            "time_ago": time_ago(pub),
        })

    return {
        "valid": True,
        "name": detected_name,
        "article_count": len(entries),
        "sample": articles,
    }


@app.get("/api/custom-articles")
async def custom_articles(url: str, name: str = "Custom", color: str = "#FF3A30", tab: str = "today"):
    """Fetch articles from a custom RSS URL for rendering in the feed."""
    entries = await fetch_feed(url)
    is_gn = "news.google.com" in url

    articles = []
    seen = set()
    for entry in entries[:MAX_PER_FEED]:
        link = entry.get("link", "")
        if not link or link in seen:
            continue
        seen.add(link)
        pub = parse_date(entry)
        articles.append({
            "id": link,
            "title": clean_title(entry.get("title", "").strip(), is_gn),
            "link": link,
            "summary": clean_summary(entry),
            "image": extract_image(entry),
            "source": name,
            "source_id": f"custom_{url[:20]}",
            "source_short": name[:10],
            "category": "Custom",
            "color": color,
            "tab": tab,
            "published": parse_date(entry).isoformat(),
            "time_ago": time_ago(pub),
        })

    articles.sort(key=lambda x: x["published"], reverse=True)
    return {"articles": articles}


@app.get("/api/refresh")
async def refresh_cache():
    _cache.clear()
    return {"status": "cache cleared"}


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})
