'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  articles: [],
  sources: [],
  currentTab: 'today',
  currentSource: 'all',
  loading: false,
  lastFetch: null,
};

const TAB_TITLES  = { today: 'Today', sports: 'Sports', entertainment: 'Entertainment', magazines: 'Magazines', following: 'Following', search: 'Search' };
const TAB_COLORS  = { today: '#FF3A30', sports: '#30D158', entertainment: '#FF375F', magazines: '#FF9F0A', following: '#0A84FF', search: '#636366' };

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setHeaderDate();
  injectDesktopNav();
  setupTabBar();
  setupRefreshBtn();
  setupPullToRefresh();
  setupSettings();
  loadSources().then(() => loadArticles());
  initTicker();
  initWeather();
  initOnion();
  initBubble().then(() => { if (state.articles.length) renderFeed(); });
});

// ── Header ─────────────────────────────────────────────────────────────────
function setHeaderDate() {
  const el = document.getElementById('header-date');
  if (el) el.innerHTML = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + '<span id="weather-inline"></span>';
}

async function initWeather() {
  try {
    const data = await fetch('/api/weather').then(r => r.json());
    const el = document.getElementById('weather-inline');
    if (el && data.temp && data.emoji) {
      let txt = ` · ${data.emoji} ${data.temp}°`;
      if (data.ocean) txt += ` 🌊 ${data.ocean}°`;
      el.textContent = txt;
    }
  } catch {}
}

// ── Desktop nav ────────────────────────────────────────────────────────────
function injectDesktopNav() {
  if (window.innerWidth < 768) return;
  const nav = document.createElement('nav');
  nav.id = 'desktop-nav';
  [
    { tab: 'today',         label: 'Today',         icon: iconNewspaper() },
    { tab: 'sports',        label: 'Sports',        icon: iconSports() },
    { tab: 'magazines',     label: 'Magazines',     icon: iconBook() },
    { tab: 'following',     label: 'Following',     icon: iconHeart() },
    { tab: 'search',        label: 'Search',        icon: iconSearch() },
  ].forEach(({ tab, label, icon }) => {
    const btn = document.createElement('button');
    btn.className = 'desktop-nav-btn' + (tab === 'today' ? ' active' : '');
    btn.dataset.tab = tab;
    btn.innerHTML = `${icon}<span>${label}</span>`;
    btn.addEventListener('click', () => switchTab(tab));
    nav.appendChild(btn);
  });
  document.getElementById('app').insertBefore(nav, document.getElementById('main'));
}

// ── Sources ────────────────────────────────────────────────────────────────
async function loadSources() {
  try {
    const data = await fetch('/api/sources').then(r => r.json());
    state.sources = data.sources;
    renderSourceChips();
  } catch (_) {}
}

function renderSourceChips() {
  const container = document.getElementById('source-chips');
  if (!container) return;
  const list = state.currentTab === 'today'
    ? state.sources
    : state.sources.filter(s => s.tab === state.currentTab);

  container.innerHTML = '';
  [{ id: 'all', short: 'All', color: null }, ...list].forEach(s => {
    const btn = document.createElement('button');
    const active = state.currentSource === s.id;
    btn.className = 'chip' + (active ? ' active' : '');
    btn.textContent = s.short;
    if (active && s.color) btn.style.background = s.color;
    btn.addEventListener('click', () => {
      state.currentSource = s.id;
      renderSourceChips();
      loadArticles();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    container.appendChild(btn);
  });
}

// ── Articles ───────────────────────────────────────────────────────────────
async function loadArticles() {
  if (state.loading) return;
  state.loading = true;

  const feed = document.getElementById('feed');
  feed.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading…</p></div>`;

  try {
    // Search tab fetches everything for full-text search
    const fetchTab = state.currentTab === 'search' ? 'today' : state.currentTab;
    const params = new URLSearchParams({ tab: fetchTab });
    if (state.currentSource !== 'all') params.set('source', state.currentSource);
    const data = await fetch(`/api/articles?${params}`).then(r => { if (!r.ok) throw 0; return r.json(); });
    let articles = data.articles;

    // Merge custom sources
    const { custom } = getSourceSettings();
    if (custom.length && (state.currentTab === 'today' || state.currentSource === 'all')) {
      const customFetches = custom
        .filter(c => !state.currentSource || state.currentSource === 'all' || state.currentSource === c.id)
        .map(c => fetch(`/api/custom-articles?url=${encodeURIComponent(c.url)}&name=${encodeURIComponent(c.name)}&color=${encodeURIComponent(c.color || '#888')}&tab=${encodeURIComponent(c.tab || 'today')}`).then(r => r.json()).catch(() => ({ articles: [] })));
      const customResults = await Promise.all(customFetches);
      const customArticles = customResults.flatMap(r => r.articles || []);
      const seenIds = new Set(articles.map(a => a.id));
      articles = [...articles, ...customArticles.filter(a => !seenIds.has(a.id))];
      articles.sort((a, b) => {
        if ((a.priority ?? 99) !== (b.priority ?? 99)) return (a.priority ?? 99) - (b.priority ?? 99);
        return new Date(b.published) - new Date(a.published);
      });
    }

    state.articles = articles;
    state.lastFetch = new Date();
    if (articles.length) allArticlesCache = [...allArticlesCache, ...articles].filter((a, i, arr) => arr.findIndex(x => x.id === a.id) === i);
    if      (state.currentTab === 'following')  renderFollowing();
    else if (state.currentTab === 'magazines')  renderMagazines();
    else if (state.currentTab === 'search')     renderSearch();
    else                                         renderFeed();
  } catch {
    feed.innerHTML = `<div class="error-state"><p>Couldn't load articles.</p><button class="retry-btn" onclick="loadArticles()">Try Again</button></div>`;
  } finally {
    state.loading = false;
  }
}

// ── Feed Render ────────────────────────────────────────────────────────────
function renderFeed() {
  const feed = document.getElementById('feed');
  const articles = splicePinnedIntoFeed(applySourceSettings(applyPrefs(state.articles)));

  if (!articles.length) {
    feed.innerHTML = '<div class="empty-state"><p>No articles.</p></div>';
    return;
  }

  const frag = document.createDocumentFragment();

  // Hero: first article with large image
  frag.appendChild(buildHeroCard(articles[0]));


  // 2-col grid: next articles that have images
  const withImg  = articles.slice(1).filter(a => a.image);
  const withoutImg = articles.slice(1).filter(a => !a.image);
  const gridItems = withImg.splice(0, 4);

  if (gridItems.length >= 2) {
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    gridItems.forEach(a => grid.appendChild(buildGridCard(a)));
    frag.appendChild(grid);
  } else {
    withImg.unshift(...gridItems);
  }

  // Remaining: grouped into Apple News-style sections by source.
  // Sort by recency first to get source freshness order, then cluster by source.
  const _byRecency = [...withImg, ...withoutImg].sort((a, b) => {
    if ((a.priority ?? 99) !== (b.priority ?? 99)) return (a.priority ?? 99) - (b.priority ?? 99);
    return new Date(b.published) - new Date(a.published);
  });
  const _srcOrder = new Map();
  _byRecency.forEach((a, i) => {
    const k = `${a.priority ?? 99}:${a.source_id}`;
    if (!_srcOrder.has(k)) _srcOrder.set(k, i);
  });
  const remaining = _byRecency.sort((a, b) => {
    const pa = a.priority ?? 99, pb = b.priority ?? 99;
    if (pa !== pb) return pa - pb;
    const oa = _srcOrder.get(`${pa}:${a.source_id}`);
    const ob = _srcOrder.get(`${pb}:${b.source_id}`);
    if (oa !== ob) return oa - ob;
    return new Date(b.published) - new Date(a.published);
  });

  // Group into runs of same source (max 4 per group) for Apple News style
  const groups = [];
  remaining.forEach(a => {
    const last = groups[groups.length - 1];
    if (last && last[0].source_id === a.source_id && last.length < 4) {
      last.push(a);
    } else {
      groups.push([a]);
    }
  });

  groups.forEach(group => {
    const section = document.createElement('div');
    section.className = 'news-section';
    if (state.currentSource === 'all') {
      const hdr = document.createElement('div');
      hdr.className = 'section-from-header';
      hdr.innerHTML = `<span class="section-from-name" style="color:${esc(group[0].color)}">${esc(group[0].source)}</span>`;
      section.appendChild(hdr);
    }
    group.forEach(a => section.appendChild(buildRowCard(a)));
    frag.appendChild(section);
  });

  if (state.lastFetch) {
    const badge = document.createElement('p');
    badge.className = 'updated-badge';
    badge.textContent = `Updated ${formatTime(state.lastFetch)}`;
    frag.appendChild(badge);
  }

  feed.innerHTML = '';
  feed.appendChild(frag);
}

// ── Following Render ───────────────────────────────────────────────────────
function renderFollowing() {
  const feed = document.getElementById('feed');
  const articles = applySourceSettings(applyPrefs(state.articles));

  if (!articles.length) { feed.innerHTML = '<div class="empty-state"><p>No articles.</p></div>'; return; }

  // Group by source, order by source weight (liked sources first)
  const prefs = getPrefs();
  const bySource = {};
  const order = [];
  articles.forEach(a => {
    if (!bySource[a.source_id]) { bySource[a.source_id] = { meta: a, items: [] }; order.push(a.source_id); }
    bySource[a.source_id].items.push(a);
  });
  order.sort((a, b) => (prefs.weights[b] || 1) - (prefs.weights[a] || 1));

  const frag = document.createDocumentFragment();
  order.forEach(id => {
    const { meta, items } = bySource[id];
    const section = document.createElement('div');
    section.className = 'following-section';

    const hdr = document.createElement('div');
    hdr.className = 'following-section-header';
    hdr.innerHTML = `<span class="following-section-name" style="color:${esc(meta.color)}">${esc(meta.source)}</span>`;
    section.appendChild(hdr);

    const wrap = document.createElement('div');
    wrap.className = 'horiz-scroll-wrap';
    const row = document.createElement('div');
    row.className = 'horiz-scroll';
    items.slice(0, 8).forEach(a => row.appendChild(buildHorizCard(a)));
    wrap.appendChild(row);
    section.appendChild(wrap);

    const sep = document.createElement('div');
    sep.style.cssText = 'height:0.5px;background:var(--separator);margin:14px 0 0';
    section.appendChild(sep);
    frag.appendChild(section);
  });

  feed.innerHTML = '';
  feed.appendChild(frag);
}

// ── Card Builders ──────────────────────────────────────────────────────────
function buildHeroCard(article) {
  const el = document.createElement('div');
  el.className = 'card-hero';

  el.innerHTML = `
    <div class="card-hero-body">
      <span class="card-hero-source" style="color:${esc(article.color)}">${esc(article.source)}</span>
      <h2 class="card-hero-title">${esc(article.title)}</h2>
      ${article.summary ? `<p class="card-hero-summary">${esc(article.summary)}</p>` : ''}
    </div>`;

  if (article.image) {
    const wrap = document.createElement('div');
    wrap.className = 'card-hero-img-wrap';
    const img = document.createElement('img');
    img.src = article.image;
    img.alt = '';
    img.loading = 'eager';
    img.onerror = () => wrap.remove();
    wrap.appendChild(img);
    el.insertBefore(wrap, el.firstChild);
  } else {
    lazyLoadOgImage(article.link, imgUrl => {
      if (imgUrl && el.isConnected) {
        const wrap = document.createElement('div');
        wrap.className = 'card-hero-img-wrap';
        const img = document.createElement('img');
        img.src = imgUrl;
        img.alt = '';
        wrap.appendChild(img);
        el.insertBefore(wrap, el.firstChild);
      }
    });
  }

  el.querySelector('.card-hero-body').appendChild(buildFeedbackRow(article, el));
  el.addEventListener('click', e => { if (!e.target.closest('.feedback-btn')) openUrl(article.link); });
  return el;
}

function buildRowCard(article) {
  const el = document.createElement('div');
  el.className = 'card-row';

  el.innerHTML = `
    <div class="card-row-text">
      <div class="card-row-meta">
        <span class="card-row-source" style="color:${esc(article.color)}">${esc(article.source)}</span>
        <span class="card-row-dot">·</span>
        <span class="card-row-time">${esc(article.time_ago)}</span>
        <div class="card-row-feedback"></div>
      </div>
      <h3 class="card-row-title">${esc(article.title)}</h3>
    </div>`;

  // Thumb: show if we have image, otherwise lazy-fetch OG image
  if (article.image) {
    const img = document.createElement('img');
    img.className = 'card-row-thumb';
    img.src = article.image;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.remove();
    el.appendChild(img);
  } else {
    lazyLoadOgImage(article.link, img => {
      if (img && el.isConnected) {
        const thumb = document.createElement('img');
        thumb.className = 'card-row-thumb';
        thumb.src = img;
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.onerror = () => thumb.remove();
        el.appendChild(thumb);
      }
    });
  }

  el.querySelector('.card-row-feedback').replaceWith(buildFeedbackRow(article, el));
  el.addEventListener('click', e => { if (!e.target.closest('.feedback-btn')) openUrl(article.link); });
  return el;
}

function buildGridCard(article) {
  const el = document.createElement('div');
  el.className = 'card-grid-item';

  const imgWrap = document.createElement('div');
  imgWrap.className = 'card-grid-img-wrap';

  if (article.image) {
    const img = document.createElement('img');
    img.className = 'card-grid-img';
    img.src = article.image;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { img.remove(); imgWrap.style.background = `${article.color}22`; };
    imgWrap.appendChild(img);
  } else {
    // Colored source-branded placeholder — looks designed, not broken
    imgWrap.style.cssText = `background:linear-gradient(135deg,${article.color}33,${article.color}11);display:flex;align-items:center;justify-content:center`;
    imgWrap.innerHTML = `<span style="font-size:11px;font-weight:800;color:${esc(article.color)};text-transform:uppercase;letter-spacing:1px;opacity:0.6;text-align:center;padding:8px">${esc(article.source)}</span>`;
    lazyLoadOgImage(article.link, img => {
      if (img && imgWrap.isConnected) {
        imgWrap.innerHTML = '';
        imgWrap.style.cssText = '';
        const thumb = document.createElement('img');
        thumb.className = 'card-grid-img';
        thumb.src = img;
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.onerror = () => thumb.remove();
        imgWrap.appendChild(thumb);
      }
    });
  }

  el.appendChild(imgWrap);
  el.innerHTML += `
    <div class="card-grid-body">
      <span class="card-grid-source" style="color:${esc(article.color)}">${esc(article.source)}</span>
      <h3 class="card-grid-title">${esc(article.title)}</h3>
      <span class="card-grid-time">${esc(article.time_ago)}</span>
    </div>`;

  el.addEventListener('click', () => openUrl(article.link));
  return el;
}

function buildHorizCard(article) {
  const el = document.createElement('div');
  el.className = 'card-horiz';
  el.innerHTML = `
    ${article.image
      ? `<img class="card-horiz-img" src="${esc(article.image)}" alt="" loading="lazy" onerror="this.style.background='var(--fill-1)'">`
      : `<div class="card-horiz-img"></div>`}
    <div class="card-horiz-body">
      <span class="card-horiz-source" style="color:${esc(article.color)}">${esc(article.source)}</span>
      <h3 class="card-horiz-title">${esc(article.title)}</h3>
      <span class="card-horiz-time">${esc(article.time_ago)}</span>
    </div>`;
  el.addEventListener('click', () => openUrl(article.link));
  return el;
}

// ── Magazines Render ───────────────────────────────────────────────────────
function renderMagazines() {
  const feed = document.getElementById('feed');
  const articles = applyPrefs(state.articles);

  if (!articles.length) { feed.innerHTML = '<div class="empty-state"><p>No magazines.</p></div>'; return; }

  // Group by source, take latest article as the "cover"
  const bySource = {};
  const order = [];
  articles.forEach(a => {
    if (!bySource[a.source_id]) { bySource[a.source_id] = []; order.push(a.source_id); }
    bySource[a.source_id].push(a);
  });

  const grid = document.createElement('div');
  grid.className = 'magazine-grid';

  order.forEach(id => {
    const items = bySource[id];
    const cover = items[0]; // latest = cover story
    const isNew = (Date.now() - new Date(cover.published)) < 86_400_000; // < 24h

    const card = document.createElement('div');
    card.className = 'card-magazine';
    card.addEventListener('click', () => {
      // Switch to Today tab filtered by this source
      state.currentTab = 'today';
      state.currentSource = cover.source_id;
      document.documentElement.style.setProperty('--tab-color', TAB_COLORS.today);
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'today'));
      document.querySelectorAll('.desktop-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'today'));
      document.getElementById('header-title').textContent = cover.source;
      renderSourceChips();
      loadArticles();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    const coverWrap = document.createElement('div');
    coverWrap.className = 'mag-cover-wrap';

    if (cover.image) {
      coverWrap.innerHTML = `
        <img class="mag-cover-img" src="${esc(cover.image)}" alt="${esc(cover.source)}" loading="lazy" onerror="this.parentElement.innerHTML=placeholderCover('${esc(cover.source)}','${esc(cover.color)}')">
        <div class="mag-cover-gradient"></div>
        <div class="mag-cover-name">${esc(cover.source)}</div>
        ${isNew ? '<div class="mag-new-badge">New</div>' : ''}`;
    } else {
      coverWrap.innerHTML = `
        <div class="mag-cover-placeholder" style="background:${esc(cover.color)}18">
          <div class="mag-cover-placeholder-name" style="color:${esc(cover.color)}">${esc(cover.source)}</div>
        </div>
        ${isNew ? '<div class="mag-new-badge">New</div>' : ''}`;
    }

    card.innerHTML = `
      <div class="mag-body">
        <p class="mag-latest">${esc(cover.title)}</p>
        <span class="mag-time">${esc(cover.time_ago)}</span>
      </div>`;
    card.insertBefore(coverWrap, card.firstChild);
    grid.appendChild(card);
  });

  feed.innerHTML = '';
  feed.appendChild(grid);
}

function placeholderCover(name, color) {
  return `<div class="mag-cover-placeholder" style="background:${color}18"><div class="mag-cover-placeholder-name" style="color:${color}">${name}</div></div>`;
}

// ── Search Render ──────────────────────────────────────────────────────────
let searchDebounce = null;
let allArticlesCache = [];

function renderSearch() {
  const feed = document.getElementById('feed');

  const container = document.createElement('div');
  container.className = 'search-container';

  // Search bar
  const barWrap = document.createElement('div');
  barWrap.className = 'search-bar-wrap';
  barWrap.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
    <input type="search" class="search-input" id="search-input" placeholder="Search Newsie" autocomplete="off" autocorrect="off" spellcheck="false">
    <button class="search-clear hidden" id="search-clear" aria-label="Clear">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  container.appendChild(barWrap);

  const resultsArea = document.createElement('div');
  resultsArea.id = 'search-results-area';
  resultsArea.innerHTML = `
    <div class="search-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <h3>Search Newsie</h3>
      <p>Find articles from all your sources</p>
    </div>`;
  container.appendChild(resultsArea);

  feed.innerHTML = '';
  feed.appendChild(container);

  // Cache all articles for searching
  allArticlesCache = state.articles.length ? state.articles : allArticlesCache;

  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');

  // Auto-focus on desktop
  if (window.innerWidth >= 768) setTimeout(() => input.focus(), 100);

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearBtn.classList.toggle('hidden', !q);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => doSearch(q), 180);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.add('hidden');
    resultsArea.innerHTML = `<div class="search-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <h3>Search Newsie</h3><p>Find articles from all your sources</p></div>`;
    input.focus();
  });
}

function doSearch(query) {
  const area = document.getElementById('search-results-area');
  if (!area) return;

  if (!query) {
    area.innerHTML = `<div class="search-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <h3>Search Newsie</h3><p>Find articles from all your sources</p></div>`;
    return;
  }

  const q = query.toLowerCase();
  const results = allArticlesCache.filter(a =>
    a.title.toLowerCase().includes(q) ||
    a.source.toLowerCase().includes(q) ||
    (a.summary || '').toLowerCase().includes(q)
  );

  if (!results.length) {
    area.innerHTML = `<div class="search-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <h3>No Results</h3><p>No articles found for "<strong>${esc(query)}</strong>"</p></div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  const count = document.createElement('p');
  count.className = 'search-results-count';
  count.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
  frag.appendChild(count);

  const section = document.createElement('div');
  section.className = 'search-result-section';
  results.slice(0, 50).forEach(a => section.appendChild(buildRowCard(a)));
  frag.appendChild(section);

  area.innerHTML = '';
  area.appendChild(frag);
}

// ─────────────────────────────────────────────────────────
// PREFERENCES & FEEDBACK
// ─────────────────────────────────────────────────────────
const PREFS_KEY = 'newsie_prefs';

function getPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || { hidden: [], liked: [], weights: {} }; }
  catch { return { hidden: [], liked: [], weights: {} }; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
}

function applyPrefs(articles) {
  const { hidden, liked, weights } = getPrefs();
  const hiddenSet = new Set(hidden);
  const likedSet  = new Set(liked);
  return articles
    .filter(a => !hiddenSet.has(a.id))
    .map(a => ({ ...a, _liked: likedSet.has(a.id), _w: weights[a.source_id] ?? 1 }))
    .sort((a, b) => {
      if ((a.priority ?? 99) !== (b.priority ?? 99)) return (a.priority ?? 99) - (b.priority ?? 99);
      const hoursOld = iso => (Date.now() - new Date(iso)) / 3_600_000;
      return (1 / (hoursOld(b.published) + 1)) * b._w - (1 / (hoursOld(a.published) + 1)) * a._w;
    });
}

function likeArticle(id, sourceId, btn) {
  const p = getPrefs();
  const idx = p.liked.indexOf(id);
  if (idx === -1) {
    p.liked.push(id);
    p.weights[sourceId] = Math.min((p.weights[sourceId] ?? 1) + 0.15, 3);
    btn.classList.add('active');
  } else {
    p.liked.splice(idx, 1);
    p.weights[sourceId] = Math.max((p.weights[sourceId] ?? 1) - 0.15, 0.2);
    btn.classList.remove('active');
  }
  savePrefs(p);
}

function dismissArticle(id, sourceId, cardEl) {
  const p = getPrefs();
  if (!p.hidden.includes(id)) {
    p.hidden.push(id);
    p.weights[sourceId] = Math.max((p.weights[sourceId] ?? 1) - 0.1, 0.2);
    savePrefs(p);
  }
  const h = cardEl.offsetHeight;
  cardEl.style.cssText = `overflow:hidden;transition:max-height 0.28s ease,opacity 0.22s ease,margin-bottom 0.28s ease;max-height:${h}px;opacity:1;margin-bottom:0`;
  requestAnimationFrame(() => { cardEl.style.maxHeight = '0'; cardEl.style.opacity = '0'; });
  setTimeout(() => cardEl.remove(), 300);
}

function buildFeedbackRow(article, cardEl) {
  const prefs  = getPrefs();
  const liked  = prefs.liked.includes(article.id);

  const wrap = document.createElement('div');
  wrap.className = 'card-feedback';

  const likeBtn = document.createElement('button');
  likeBtn.className = 'feedback-btn like-btn' + (liked ? ' active' : '');
  likeBtn.setAttribute('aria-label', 'Like');
  likeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>`;
  likeBtn.addEventListener('click', e => {
    e.stopPropagation();
    likeArticle(article.id, article.source_id, likeBtn);
    const svg = likeBtn.querySelector('svg');
    svg.setAttribute('fill', likeBtn.classList.contains('active') ? 'currentColor' : 'none');
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'feedback-btn dismiss-btn';
  dismissBtn.setAttribute('aria-label', 'Not interested');
  dismissBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>`;
  dismissBtn.addEventListener('click', e => { e.stopPropagation(); dismissArticle(article.id, article.source_id, cardEl); });

  wrap.appendChild(likeBtn);
  wrap.appendChild(dismissBtn);
  return wrap;
}

// ── Tab switching ──────────────────────────────────────────────────────────
function setupTabBar() {
  document.querySelectorAll('.tab[data-tab]').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
}

function switchTab(tab) {
  if (tab === state.currentTab && !state.loading) return;
  state.currentTab = tab;
  state.currentSource = 'all';

  const color = TAB_COLORS[tab] || '#FF3A30';
  document.documentElement.style.setProperty('--tab-color', color);

  const titleEl = document.getElementById('header-title');
  if (titleEl) titleEl.textContent = TAB_TITLES[tab] || tab;

  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.desktop-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

  renderSourceChips();
  loadArticles();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Refresh ────────────────────────────────────────────────────────────────
function setupRefreshBtn() {
  const btn = document.getElementById('refresh-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.classList.add('spinning');
    await fetch('/api/refresh');
    state.articles = [];
    await loadArticles();
    btn.classList.remove('spinning');
  });
}

// ── Pull-to-refresh ────────────────────────────────────────────────────────
function setupPullToRefresh() {
  let startY = 0, pulling = false;
  const ind = document.getElementById('ptr-indicator');
  document.addEventListener('touchstart', e => { startY = e.touches[0].clientY; pulling = window.scrollY === 0; }, { passive: true });
  document.addEventListener('touchmove',  e => { if (pulling && e.touches[0].clientY - startY > 60) ind?.classList.add('visible'); }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (!ind?.classList.contains('visible')) return;
    ind.classList.remove('visible');
    if (!state.loading) { await fetch('/api/refresh'); await loadArticles(); }
    pulling = false;
  });
}

// ── OG Image lazy loader ───────────────────────────────────────────────────
const _ogCache = {};
const _ogQueue = new Set();

function lazyLoadOgImage(articleUrl, callback) {
  if (_ogCache[articleUrl] !== undefined) { callback(_ogCache[articleUrl]); return; }
  if (_ogQueue.has(articleUrl)) return;
  _ogQueue.add(articleUrl);
  // Throttle: small delay so we don't fire 100 requests at once
  setTimeout(async () => {
    try {
      const data = await fetch(`/api/ogimage?url=${encodeURIComponent(articleUrl)}`).then(r => r.json());
      _ogCache[articleUrl] = data.image || null;
      callback(_ogCache[articleUrl]);
    } catch {
      _ogCache[articleUrl] = null;
    }
    _ogQueue.delete(articleUrl);
  }, Math.random() * 800 + 100); // stagger requests 100-900ms
}

// ── Helpers ────────────────────────────────────────────────────────────────
function openUrl(url) { window.open(url, '_blank', 'noopener,noreferrer'); }

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function formatTime(d) {
  const s = (Date.now() - d) / 1000;
  if (s < 60)   return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─────────────────────────────────────────────────────────
// SOURCE SETTINGS
// ─────────────────────────────────────────────────────────
const SETTINGS_KEY = 'newsie_settings';

function getSourceSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || { disabled: [], custom: [] }; }
  catch { return { disabled: [], custom: [] }; }
}
function saveSourceSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function isSourceEnabled(sourceId) {
  return !getSourceSettings().disabled.includes(sourceId);
}

function toggleSource(sourceId, toggleEl) {
  const s = getSourceSettings();
  const idx = s.disabled.indexOf(sourceId);
  if (idx === -1) {
    s.disabled.push(sourceId);
    toggleEl.classList.remove('on');
  } else {
    s.disabled.splice(idx, 1);
    toggleEl.classList.add('on');
  }
  saveSourceSettings(s);
}

function addCustomSource(source) {
  const s = getSourceSettings();
  source.id = 'custom_' + Date.now();
  s.custom.push(source);
  saveSourceSettings(s);
  return source;
}

function removeCustomSource(id) {
  const s = getSourceSettings();
  s.custom = s.custom.filter(c => c.id !== id);
  saveSourceSettings(s);
}

// ── Settings Panel UI ──────────────────────────────────────────────────────
function setupSettings() {
  const btn     = document.getElementById('settings-btn');
  const panel   = document.getElementById('settings-panel');
  const overlay = document.getElementById('settings-overlay');
  const closeBtn = document.getElementById('settings-close');

  function openSettings() {
    panel.classList.remove('hidden');
    overlay.classList.remove('hidden');
    renderSettingsPanel();
    // small delay to let display:none clear before animating
    requestAnimationFrame(() => {
      panel.style.transform = 'translateX(0)';
      overlay.style.opacity = '1';
    });
  }

  function closeSettings() {
    panel.style.transform = '';
    panel.classList.add('hidden');
    overlay.style.opacity = '';
    overlay.classList.add('hidden');
    // reload feed to reflect changes
    state.articles = [];
    loadArticles();
  }

  btn?.addEventListener('click', openSettings);
  closeBtn?.addEventListener('click', closeSettings);
  overlay?.addEventListener('click', closeSettings);

  setupAddPeriodical();
  setupAddTopic();
}

function renderSettingsPanel() {
  const list = document.getElementById('sources-list');
  const customList = document.getElementById('custom-sources-list');
  const customLabel = document.getElementById('custom-label');
  if (!list) return;

  const settings = getSourceSettings();
  list.innerHTML = '';

  state.sources.forEach((src, i) => {
    const enabled = !settings.disabled.includes(src.id);
    const row = document.createElement('div');
    row.className = 'settings-source-row';

    const toggle = document.createElement('button');
    toggle.className = 'toggle' + (enabled ? ' on' : '');
    toggle.setAttribute('aria-label', enabled ? 'Disable' : 'Enable');
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      toggleSource(src.id, toggle);
    });

    row.innerHTML = `
      <span class="source-dot" style="background:${esc(src.color)}"></span>
      <span class="settings-source-name">${esc(src.name)}</span>
      <span class="settings-source-category">${esc(src.category)}</span>`;
    row.appendChild(toggle);
    row.addEventListener('click', () => toggleSource(src.id, toggle));

    if (i > 0) {
      const sep = document.createElement('div');
      sep.style.cssText = 'height:0.5px;background:var(--separator);margin-left:34px';
      list.appendChild(sep);
    }
    list.appendChild(row);
  });

  // Custom sources
  customList.innerHTML = '';
  if (settings.custom.length) {
    customLabel.style.display = '';
    settings.custom.forEach((src, i) => {
      const enabled = !settings.disabled.includes(src.id);
      const row = document.createElement('div');
      row.className = 'settings-source-row';

      const toggle = document.createElement('button');
      toggle.className = 'toggle' + (enabled ? ' on' : '');
      toggle.addEventListener('click', e => { e.stopPropagation(); toggleSource(src.id, toggle); });

      const delBtn = document.createElement('button');
      delBtn.className = 'settings-delete-btn';
      delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (confirm(`Remove "${src.name}"?`)) {
          removeCustomSource(src.id);
          renderSettingsPanel();
        }
      });

      row.innerHTML = `
        <span class="source-dot" style="background:${esc(src.color || '#888')}"></span>
        <span class="settings-source-name">${esc(src.name)}</span>
        <span class="settings-source-category">${esc(src.is_topic ? 'Topic' : 'Custom')}</span>`;
      row.appendChild(delBtn);
      row.appendChild(toggle);

      if (i > 0) {
        const sep = document.createElement('div');
        sep.style.cssText = 'height:0.5px;background:var(--separator);margin-left:34px';
        customList.appendChild(sep);
      }
      customList.appendChild(row);
    });
  } else {
    customLabel.style.display = 'none';
  }
}

// ── Add Periodical form ────────────────────────────────────────────────────
function setupAddPeriodical() {
  const btn      = document.getElementById('add-periodical-btn');
  const form     = document.getElementById('add-periodical-form');
  const backBtn  = document.getElementById('periodical-back');
  const previewBtn = document.getElementById('periodical-preview-btn');
  const addBtn   = document.getElementById('periodical-add-btn');
  const urlInput = document.getElementById('periodical-url');
  const nameInput = document.getElementById('periodical-name');
  const resultEl = document.getElementById('periodical-preview-result');
  const errorEl  = document.getElementById('periodical-error');
  let previewData = null;

  btn?.addEventListener('click', () => form.classList.remove('hidden'));
  backBtn?.addEventListener('click', () => {
    form.classList.add('hidden');
    urlInput.value = '';
    nameInput.value = '';
    resultEl.classList.add('hidden');
    addBtn.classList.add('hidden');
    errorEl.classList.add('hidden');
    previewData = null;
  });

  previewBtn?.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    previewBtn.textContent = 'Checking…';
    previewBtn.disabled = true;
    resultEl.classList.add('hidden');
    addBtn.classList.add('hidden');
    errorEl.classList.add('hidden');

    try {
      const name = nameInput.value.trim();
      const res = await fetch(`/api/feed-preview?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`).then(r => r.json());
      if (!res.valid) throw new Error(res.error || 'Invalid feed');

      previewData = { url, name: name || res.name };
      resultEl.innerHTML = `<div class="preview-result-header">✓ Found ${res.article_count} articles from "${esc(previewData.name)}"</div>` +
        res.sample.map(a => `<div class="preview-article">${esc(a.title)}</div>`).join('');
      resultEl.classList.remove('hidden');
      addBtn.classList.remove('hidden');
      if (!nameInput.value) nameInput.value = res.name;
    } catch (e) {
      errorEl.textContent = e.message || 'Could not load feed. Check the URL.';
      errorEl.classList.remove('hidden');
    } finally {
      previewBtn.textContent = 'Preview Feed';
      previewBtn.disabled = false;
    }
  });

  addBtn?.addEventListener('click', () => {
    if (!previewData) return;
    const colors = ['#FF3A30','#007AFF','#34C759','#FF9F0A','#AF52DE','#FF375F','#5AC8FA'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    addCustomSource({
      name: nameInput.value.trim() || previewData.name,
      short: (nameInput.value.trim() || previewData.name).slice(0, 10),
      url: previewData.url,
      color,
      tab: 'today',
      is_topic: false,
    });
    backBtn.click();
    renderSettingsPanel();
  });
}

// ── Add Topic form ─────────────────────────────────────────────────────────
function setupAddTopic() {
  const btn      = document.getElementById('add-topic-btn');
  const form     = document.getElementById('add-topic-form');
  const backBtn  = document.getElementById('topic-back');
  const addBtn   = document.getElementById('topic-add-btn');
  const input    = document.getElementById('topic-name');

  btn?.addEventListener('click', () => form.classList.remove('hidden'));
  backBtn?.addEventListener('click', () => { form.classList.add('hidden'); input.value = ''; });

  addBtn?.addEventListener('click', () => {
    const topic = input.value.trim();
    if (!topic) return;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`;
    const colors = ['#0066CC','#34C759','#FF9F0A','#AF52DE','#FF375F'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    addCustomSource({ name: topic, short: topic.slice(0, 10), url, color, tab: 'today', is_topic: true });
    backBtn.click();
    renderSettingsPanel();
    input.value = '';
  });
}

// ── Apply source settings to article list ──────────────────────────────────
function applySourceSettings(articles) {
  const { disabled } = getSourceSettings();
  if (!disabled.length) return articles;
  return articles.filter(a => !disabled.includes(a.source_id));
}

// ── Tab SVG icons ──────────────────────────────────────────────────────────
const svgAttr = `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"`;
function iconNewspaper() { return `<svg ${svgAttr}><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="4" x2="9" y2="9"/><line x1="15" y1="4" x2="15" y2="9"/><line x1="7" y1="13" x2="12" y2="13"/><line x1="7" y1="17" x2="10" y2="17"/></svg>`; }
function iconSports()    { return `<svg ${svgAttr}><circle cx="12" cy="12" r="9"/><path d="M12 3s-3 4-3 9 3 9 3 9"/><path d="M12 3s3 4 3 9-3 9-3 9"/><line x1="3" y1="12" x2="21" y2="12"/></svg>`; }
function iconStar()      { return `<svg ${svgAttr}><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>`; }
function iconHeart()     { return `<svg ${svgAttr}><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`; }
function iconBook()      { return `<svg ${svgAttr}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`; }

// ── Market Ticker ──────────────────────────────────────────────────────────
function initTicker() {
  fetchAndRenderTicker();
  setInterval(fetchAndRenderTicker, 5 * 60 * 1000); // refresh every 5 min
}

async function fetchAndRenderTicker() {
  try {
    const data = await fetch('/api/markets').then(r => r.json());
    if (!data || !data.length) return;
    renderTicker(data);
  } catch (_) {}
}

function renderTicker(items) {
  const bar = document.getElementById('ticker-bar');
  const track = document.getElementById('ticker-track');
  if (!bar || !track) return;

  function makeItems() {
    return items.map(item => {
      const up = item.pct >= 0;
      const arrow = up ? '▲' : '▼';
      const cls = up ? 'ticker-up' : 'ticker-down';
      const price = formatTickerPrice(item.label, item.price);
      const pct = Math.abs(item.pct).toFixed(2) + '%';
      return `<span class="ticker-item">
        <span class="ticker-label">${item.label}</span>
        <span class="ticker-price">${price}</span>
        <span class="ticker-change ${cls}">${arrow} ${pct}</span>
      </span>`;
    }).join('');
  }

  // Duplicate for seamless loop
  track.innerHTML = makeItems() + makeItems();
  bar.classList.remove('hidden');
}

function formatTickerPrice(label, price) {
  if (label === 'Bitcoin') return '$' + price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (label === 'Gold')    return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (label === 'Rivian')  return '$' + price.toFixed(2);
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function iconSearch()    { return `<svg ${svgAttr}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`; }

// ── The Onion (peppered into feed as regular articles) ────────────────────
let _onionHeadlines = [];

async function initOnion() {
  try {
    _onionHeadlines = await fetch('/api/onion').then(r => r.json());
  } catch (_) {}
}

function splicePinnedIntoFeed(articles) {
  const pinned = [];

  // Exactly 3 Onion articles, evenly distributed, each with a unique source_id so they don't group
  if (_onionHeadlines.length) {
    const shuffled = [..._onionHeadlines].sort(() => Math.random() - 0.5);
    const total = articles.length;
    const positions = [Math.floor(total * 0.2), Math.floor(total * 0.5), Math.floor(total * 0.8)];
    positions.forEach((pos, i) => {
      const item = shuffled[i % shuffled.length];
      const neighbor = articles[pos];
      pinned.push({ at: pos, article: {
        id: 'onion-' + i + '-' + item.link,
        title: item.title,
        link: item.link,
        image: item.image || null,
        source: 'The Onion',
        source_id: 'theonion-' + i,
        source_short: 'The Onion',
        color: '#3a7d3a',
        tab: 'today',
        priority: neighbor ? (neighbor.priority ?? 99) : 99,
        published: neighbor ? neighbor.published : new Date().toISOString(),
        time_ago: 'satire',
      }});
    });
  }

  // One Bubble post near the top
  if (_bubblePosts.length) {
    const post = _bubblePosts[Math.floor(Math.random() * _bubblePosts.length)];
    pinned.push({ at: 3, article: {
      id: 'bubble-top',
      title: post.caption || 'Check out @the.bubble',
      link: 'https://www.instagram.com/the.bubble/',
      image: post.image || null,
      source: '@the.bubble',
      source_id: 'bubble',
      source_short: 'The Bubble',
      color: '#833ab4',
      tab: 'today',
      priority: 0,
      published: new Date().toISOString(),
      time_ago: 'instagram',
    }});
  }

  if (!pinned.length) return articles;
  pinned.sort((a, b) => a.at - b.at);
  const result = [...articles];
  let offset = 0;
  pinned.forEach(({ at, article }) => {
    const idx = Math.min(at + offset, result.length);
    result.splice(idx, 0, article);
    offset++;
  });
  return result;
}

// ── The Bubble ────────────────────────────────────────────────────────────
let _bubblePosts = [];

async function initBubble() {
  try {
    _bubblePosts = await fetch('/api/bubble').then(r => r.json());
  } catch (_) {}
}
