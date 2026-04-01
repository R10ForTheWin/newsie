import asyncio
import json
import re
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

import feedparser
import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import os
app = FastAPI(title="Newsie")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
STATIC_VERSION = os.environ.get("RAILWAY_GIT_COMMIT_SHA", str(int(time.time())))[:8]

_cache: dict = {}
CACHE_TTL = 900  # 15 minutes
MAX_PER_FEED = 15

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
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
        feeds = [f for f in FEEDS if not f.get("paywall")]
    else:
        feeds = [f for f in FEEDS if f.get("tab") == tab and not f.get("paywall")]

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
                "priority": feed_config.get("priority", 99),
                "published": pub.isoformat(),
                "time_ago": time_ago(pub),
            })

    articles.sort(key=lambda x: x["published"], reverse=True)          # 1st: newest first
    articles.sort(key=lambda x: x["priority"])                          # 2nd: source priority (stable)
    result = {"articles": articles, "count": len(articles), "tab": tab}
    _cache[cache_key] = {"ts": now, "data": result}
    return result


STOOQ_SYMBOLS = [
    {"stooq": "^spx",    "label": "S&P 500"},
    {"stooq": "^dji",    "label": "Dow Jones"},
    {"stooq": "gc.f",    "label": "Gold"},
    {"stooq": "rivn.us", "label": "Rivian"},
]

_STOOQ_HEADERS = {"User-Agent": "Mozilla/5.0"}

async def _fetch_stooq(client: httpx.AsyncClient, item: dict) -> dict | None:
    url = f"https://stooq.com/q/l/?s={item['stooq']}&f=sd2t2ohlcv&h&e=csv"
    try:
        r = await client.get(url, headers=_STOOQ_HEADERS, timeout=8)
        lines = [l.strip() for l in r.text.strip().splitlines()
                 if l.strip() and not l.startswith("Symbol")]
        if not lines:
            return None
        parts = lines[-1].split(",")
        if len(parts) < 7:
            return None
        o, c = float(parts[3]), float(parts[6])
        change = c - o
        pct = (change / o * 100) if o else 0
        return {"label": item["label"], "price": c, "change": round(change, 2), "pct": round(pct, 2)}
    except Exception:
        return None

async def _fetch_bitcoin() -> dict | None:
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.get(
                "https://api.coingecko.com/api/v3/simple/price"
                "?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
                headers=_STOOQ_HEADERS,
            )
            data = r.json()["bitcoin"]
            price = data["usd"]
            pct = data.get("usd_24h_change", 0)
            return {"label": "Bitcoin", "price": price, "change": round(price * pct / 100, 2), "pct": round(pct, 2)}
    except Exception:
        return None

@app.get("/api/markets")
async def get_markets():
    cache_key = "markets"
    now = time.time()
    if cache_key in _cache and now - _cache[cache_key]["ts"] < 300:
        return _cache[cache_key]["data"]

    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        stooq_results = await asyncio.gather(*[_fetch_stooq(client, s) for s in STOOQ_SYMBOLS])

    result = [r for r in stooq_results if r is not None]
    btc = await _fetch_bitcoin()
    if btc:
        result.insert(2, btc)  # after S&P 500 and Dow Jones
    mtg = await _fetch_mortgage_rate()
    if mtg:
        result.append(mtg)

    if result:
        _cache[cache_key] = {"ts": now, "data": result}
    return result


async def _fetch_mortgage_rate() -> dict | None:
    """Fetch 30-year fixed rate from Freddie Mac PMMS page (weekly)."""
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            r = await client.get(
                "https://www.freddiemac.com/pmms",
                headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"},
            )
        soup = BeautifulSoup(r.text, "lxml")
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string or "")
                desc = data.get("description", "")
                m = re.search(r'averaged\s+(\d+\.\d+)%', desc)
                if m:
                    return {"label": "30yr Mtg", "price": float(m.group(1)), "change": 0, "pct": None}
            except Exception:
                continue
    except Exception:
        pass
    return None


def _weather_emoji(code: int) -> str:
    if code == 113: return "☀️"
    if code == 116: return "🌤"
    if code in (119, 122): return "☁️"
    if code in (143, 248, 260): return "🌫"
    if 176 <= code <= 314: return "🌧"
    if 315 <= code <= 395: return "❄️"
    return "🌡"

async def _fetch_ocean_temp() -> str | None:
    """Fetch water temp (°F) from NOAA buoy 46025 (Santa Monica Bay)."""
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(
                "https://www.ndbc.noaa.gov/data/realtime2/46025.txt",
                headers={"User-Agent": "Mozilla/5.0"},
            )
        lines = [l for l in r.text.splitlines() if not l.startswith("#") and l.strip()]
        if not lines:
            return None
        parts = lines[0].split()
        wtmp_c = parts[14] if len(parts) > 14 else "MM"
        if wtmp_c == "MM":
            return None
        wtmp_f = round(float(wtmp_c) * 9 / 5 + 32)
        return str(wtmp_f)
    except Exception:
        return None

@app.get("/api/weather")
async def get_weather():
    cache_key = "weather"
    now = time.time()
    if cache_key in _cache and now - _cache[cache_key]["ts"] < 1800:
        return _cache[cache_key]["data"]
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            r = await client.get(
                "https://wttr.in/90266?format=j1",
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            )
            cond = r.json()["current_condition"][0]
            result = {
                "temp": cond["temp_F"],
                "emoji": _weather_emoji(int(cond["weatherCode"])),
            }
        ocean = await _fetch_ocean_temp()
        if ocean:
            result["ocean"] = ocean
        _cache[cache_key] = {"ts": now, "data": result}
        return result
    except Exception:
        return {}


@app.get("/api/bubble")
async def get_bubble():
    cache_key = "bubble"
    now = time.time()
    if cache_key in _cache and now - _cache[cache_key]["ts"] < 1800:
        return _cache[cache_key]["data"]

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    async def _try_imginn():
        r = await client.get("https://imginn.com/the.bubble/", headers=headers)
        soup = BeautifulSoup(r.text, "lxml")
        posts = []
        for item in soup.select(".item"):
            img = item.select_one("img")
            src = (img.get("data-src") or img.get("src")) if img else None
            caption = (img.get("alt") or "").strip() if img else ""
            if src and src.startswith("http"):
                posts.append({"image": src, "caption": caption})
        return posts

    async def _try_picuki():
        r = await client.get("https://www.picuki.com/profile/the.bubble", headers=headers)
        soup = BeautifulSoup(r.text, "lxml")
        posts = []
        for item in soup.select(".box-photo"):
            img = item.select_one("img")
            src = (img.get("src") or img.get("data-src")) if img else None
            caption = (item.select_one(".photo-description") or {}).get_text(strip=True) if item.select_one(".photo-description") else ""
            if src and src.startswith("http"):
                posts.append({"image": src, "caption": caption})
        return posts

    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            posts = await _try_imginn()
            if not posts:
                posts = await _try_picuki()
        if posts:
            _cache[cache_key] = {"ts": now, "data": posts}
        return posts
    except Exception:
        return []


@app.get("/api/onion")
async def get_onion():
    cache_key = "onion"
    now = time.time()
    if cache_key in _cache and now - _cache[cache_key]["ts"] < 1800:  # 30-min cache
        return _cache[cache_key]["data"]
    try:
        entries = await fetch_feed("https://www.theonion.com/rss")
        headlines = [
            {"title": e.get("title", "").strip(), "link": e.get("link", ""), "image": extract_image(e)}
            for e in (entries or [])
            if e.get("title") and e.get("link")
        ]
        # fetch OG images for entries missing one
        async with httpx.AsyncClient(timeout=6, follow_redirects=True, headers=HEADERS) as client:
            async def _fill_image(h):
                if not h["image"]:
                    h["image"] = await fetch_og_image(h["link"])
                return h
            headlines = list(await asyncio.gather(*[_fill_image(h) for h in headlines]))
        _cache[cache_key] = {"ts": now, "data": headlines}
        return headlines
    except Exception:
        return []


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
    return templates.TemplateResponse("index.html", {"request": request, "v": STATIC_VERSION})
