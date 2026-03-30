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

app = FastAPI(title="Newsies")
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

    # media:content
    if hasattr(entry, "media_content") and entry.media_content:
        for m in entry.media_content:
            if m.get("url", "").startswith("http"):
                if "image" in m.get("type", "image") or m.get("medium") == "image":
                    return m["url"]
        if entry.media_content[0].get("url", "").startswith("http"):
            return entry.media_content[0]["url"]

    # enclosures
    if hasattr(entry, "enclosures") and entry.enclosures:
        for enc in entry.enclosures:
            if "image" in enc.get("type", "") and enc.get("url", "").startswith("http"):
                return enc["url"]

    # parse HTML in summary/content for first <img>
    html = ""
    if hasattr(entry, "content") and entry.content:
        html = entry.content[0].get("value", "")
    elif hasattr(entry, "summary") and entry.summary:
        html = entry.summary

    if html:
        soup = BeautifulSoup(html, "lxml")
        img = soup.find("img")
        if img:
            src = img.get("src", "")
            if src.startswith("http") and not src.endswith(".gif"):
                return src

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


@app.get("/api/refresh")
async def refresh_cache():
    _cache.clear()
    return {"status": "cache cleared"}


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})
