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

const TAB_TITLES = {
  today: 'Today',
  sports: 'Sports',
  entertainment: 'Entertainment',
  following: 'Following',
};

const TAB_COLORS = {
  today: '#FF3B30',
  sports: '#34C759',
  entertainment: '#AF52DE',
  following: '#007AFF',
};

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setHeaderDate();
  injectDesktopNav();
  setupTabBar();
  setupRefreshBtn();
  setupPullToRefresh();
  loadSources().then(() => loadArticles());
});

// ── Header ─────────────────────────────────────────────────────────────────
function setHeaderDate() {
  const el = document.getElementById('header-date');
  if (!el) return;
  el.textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

// ── Desktop sidebar nav ────────────────────────────────────────────────────
function injectDesktopNav() {
  if (window.innerWidth < 768) return;
  const app = document.getElementById('app');
  const nav = document.createElement('nav');
  nav.id = 'desktop-nav';

  const tabs = [
    { tab: 'today', label: 'Today', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="4" x2="9" y2="9"/><line x1="15" y1="4" x2="15" y2="9"/><line x1="7" y1="13" x2="12" y2="13"/><line x1="7" y1="17" x2="10" y2="17"/></svg>` },
    { tab: 'sports', label: 'Sports', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3c0 0-3 4-3 9s3 9 3 9"/><path d="M12 3c0 0 3 4 3 9s-3 9-3 9"/><path d="M3 12h18"/></svg>` },
    { tab: 'entertainment', label: 'Entertainment', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>` },
    { tab: 'following', label: 'Following', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>` },
  ];

  tabs.forEach(({ tab, label, icon }) => {
    const btn = document.createElement('button');
    btn.className = 'desktop-nav-btn' + (tab === 'today' ? ' active' : '');
    btn.dataset.tab = tab;
    btn.innerHTML = `${icon}<span>${label}</span>`;
    btn.addEventListener('click', () => switchTab(tab));
    nav.appendChild(btn);
  });

  app.insertBefore(nav, document.getElementById('main'));
}

// ── Sources ────────────────────────────────────────────────────────────────
async function loadSources() {
  try {
    const res = await fetch('/api/sources');
    const data = await res.json();
    state.sources = data.sources;
    renderSourceChips();
  } catch (_) { /* non-fatal */ }
}

function renderSourceChips() {
  const container = document.getElementById('source-chips');
  if (!container) return;

  const tabSources = state.currentTab === 'today'
    ? state.sources
    : state.sources.filter(s => s.tab === state.currentTab);

  const chips = [
    makeChip('all', 'All', state.currentSource === 'all'),
    ...tabSources.map(s => makeChip(s.id, s.short, state.currentSource === s.id, s.color)),
  ];

  container.innerHTML = '';
  chips.forEach(c => container.appendChild(c));
}

function makeChip(id, label, active, color) {
  const btn = document.createElement('button');
  btn.className = 'chip' + (active ? ' active' : '');
  btn.textContent = label;
  btn.dataset.source = id;
  if (active && color) btn.style.background = color;
  btn.addEventListener('click', () => {
    state.currentSource = id;
    renderSourceChips();
    loadArticles();
    document.getElementById('main').scrollTo({ top: 0, behavior: 'smooth' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  return btn;
}

// ── Articles ───────────────────────────────────────────────────────────────
async function loadArticles() {
  if (state.loading) return;
  state.loading = true;

  const feed = document.getElementById('feed');
  feed.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading…</p></div>`;

  try {
    const params = new URLSearchParams({ tab: state.currentTab });
    if (state.currentSource !== 'all') params.set('source', state.currentSource);

    const res = await fetch(`/api/articles?${params}`);
    if (!res.ok) throw new Error('Network error');
    const data = await res.json();
    state.articles = data.articles;
    state.lastFetch = new Date();

    if (state.currentTab === 'following') {
      renderFollowing();
    } else {
      renderFeed();
    }
  } catch (err) {
    feed.innerHTML = `
      <div class="error-state">
        <p>Couldn't load articles.</p>
        <button class="retry-btn" onclick="loadArticles()">Try Again</button>
      </div>`;
  } finally {
    state.loading = false;
  }
}

// ── Feed Render ────────────────────────────────────────────────────────────
function renderFeed() {
  const feed = document.getElementById('feed');
  const articles = state.articles;

  if (!articles.length) {
    feed.innerHTML = '<div class="empty-state"><p>No articles found.</p></div>';
    return;
  }

  const frag = document.createDocumentFragment();

  // Hero block: first article as big card, next 2 as sub-items
  const heroGroup = articles.slice(0, 3);
  const hero = heroGroup[0];
  const heroEl = buildHeroCard(hero, heroGroup.slice(1));
  frag.appendChild(heroEl);

  // 2-col grid: next 4 articles with images
  const withImages = articles.slice(3).filter(a => a.image);
  const noImages = articles.slice(3).filter(a => !a.image);
  const gridItems = withImages.splice(0, 4);

  if (gridItems.length >= 2) {
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    gridItems.forEach(a => grid.appendChild(buildStandardCard(a)));
    frag.appendChild(grid);
  } else {
    // fold them back into the list
    withImages.unshift(...gridItems);
  }

  // Remaining as list cards, with section dividers
  const remaining = [...withImages, ...noImages].sort(
    (a, b) => new Date(b.published) - new Date(a.published)
  );

  let lastSection = null;
  remaining.forEach((article, i) => {
    if (state.currentSource === 'all' && i % 6 === 0 && article.source !== lastSection) {
      if (i > 0) {
        const sep = document.createElement('div');
        sep.className = 'section-sep';
        sep.innerHTML = `<div class="section-sep-line"></div>`;
        frag.appendChild(sep);
      }
      const secEl = document.createElement('div');
      secEl.className = 'section-header';
      secEl.innerHTML = `<span class="section-title" style="color:${esc(article.color)}">${esc(article.source)}</span>`;
      frag.appendChild(secEl);
      lastSection = article.source;
    }
    frag.appendChild(buildListCard(article));
  });

  // Updated badge
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
  const articles = state.articles;

  if (!articles.length) {
    feed.innerHTML = '<div class="empty-state"><p>No articles found.</p></div>';
    return;
  }

  // Group by source preserving order
  const order = [];
  const bySource = {};
  articles.forEach(a => {
    if (!bySource[a.source_id]) {
      bySource[a.source_id] = { meta: a, items: [] };
      order.push(a.source_id);
    }
    bySource[a.source_id].items.push(a);
  });

  const frag = document.createDocumentFragment();

  order.forEach(id => {
    const { meta, items } = bySource[id];

    const section = document.createElement('div');
    section.className = 'following-section';

    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = `<span class="section-title" style="color:${esc(meta.color)}">${esc(meta.source)}</span>`;
    section.appendChild(header);

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'horiz-scroll-wrap';
    const scrollRow = document.createElement('div');
    scrollRow.className = 'horiz-scroll';

    items.slice(0, 8).forEach(a => scrollRow.appendChild(buildHorizCard(a)));
    scrollWrap.appendChild(scrollRow);
    section.appendChild(scrollWrap);

    const sep = document.createElement('div');
    sep.innerHTML = '<div class="section-sep-line" style="margin-top:14px"></div>';
    section.appendChild(sep);

    frag.appendChild(section);
  });

  feed.innerHTML = '';
  feed.appendChild(frag);
}

// ── Card Builders ──────────────────────────────────────────────────────────
function buildHeroCard(article, subArticles) {
  const el = makeCardEl('card card-hero', article.link);

  let inner = '';
  if (article.image) {
    inner += `<div class="card-img-wrap"><img src="${esc(article.image)}" alt="" loading="eager" onerror="this.parentElement.remove()"></div>`;
  }

  inner += `<div class="card-body">
    <span class="card-source" style="color:${esc(article.color)}">${esc(article.source)}</span>
    <h2 class="card-title">${esc(article.title)}</h2>
    ${article.summary ? `<p class="card-summary">${esc(article.summary)}</p>` : ''}
    <span class="card-time">${esc(article.time_ago)}</span>
  </div>`;

  if (subArticles && subArticles.length) {
    inner += '<div class="hero-sub">';
    subArticles.forEach(sub => {
      const subEl = document.createElement('div');
      subEl.className = 'hero-sub-item';
      subEl.innerHTML = `
        <div class="card-title">${esc(sub.title)}</div>
        <div class="card-meta">
          <span class="card-source" style="color:${esc(sub.color)}">${esc(sub.source)}</span>
          <span class="card-time">${esc(sub.time_ago)}</span>
        </div>`;
      subEl.addEventListener('click', e => { e.stopPropagation(); openUrl(sub.link); });
      // Return raw HTML — we'll append after setting innerHTML
      inner += `<div data-sub-placeholder="${esc(sub.link)}"></div>`;
    });
    inner += '</div>';
  }

  el.innerHTML = inner;

  // Replace placeholders with real sub-items (needed to attach click handlers)
  if (subArticles && subArticles.length) {
    subArticles.forEach(sub => {
      const ph = el.querySelector(`[data-sub-placeholder="${CSS.escape(sub.link)}"]`);
      if (!ph) return;
      const subEl = document.createElement('div');
      subEl.className = 'hero-sub-item';
      subEl.innerHTML = `
        <div class="card-title">${esc(sub.title)}</div>
        <div class="card-meta">
          <span class="card-source" style="color:${esc(sub.color)}">${esc(sub.source)}</span>
          <span class="card-time">${esc(sub.time_ago)}</span>
        </div>`;
      subEl.addEventListener('click', e => { e.stopPropagation(); openUrl(sub.link); });
      ph.replaceWith(subEl);
    });
  }

  return el;
}

function buildStandardCard(article) {
  const el = makeCardEl('card card-standard', article.link);
  el.innerHTML = `
    ${article.image
      ? `<div class="card-img-wrap"><img src="${esc(article.image)}" alt="" loading="lazy" onerror="this.parentElement.remove()"></div>`
      : `<div class="card-img-wrap" style="background:${esc(article.color)}18;height:110px;display:flex;align-items:center;justify-content:center"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="${esc(article.color)}" stroke-width="1.5" opacity=".4"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg></div>`}
    <div class="card-body">
      <span class="card-source" style="color:${esc(article.color)}">${esc(article.source)}</span>
      <h3 class="card-title">${esc(article.title)}</h3>
      <span class="card-time">${esc(article.time_ago)}</span>
    </div>`;
  return el;
}

function buildListCard(article) {
  const el = makeCardEl('card card-list', article.link);
  el.innerHTML = `
    <div class="card-text">
      <span class="card-source" style="color:${esc(article.color)}">${esc(article.source)}</span>
      <h3 class="card-title">${esc(article.title)}</h3>
      <div class="card-meta">
        <span class="card-time">${esc(article.time_ago)}</span>
      </div>
    </div>
    ${article.image ? `<img class="card-thumb" src="${esc(article.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}`;
  return el;
}

function buildHorizCard(article) {
  const el = makeCardEl('card card-horiz', article.link);
  el.innerHTML = `
    ${article.image
      ? `<div class="card-img-wrap"><img src="${esc(article.image)}" alt="" loading="lazy" onerror="this.parentElement.remove()"></div>`
      : `<div class="card-img-wrap" style="background:${esc(article.color)}18;height:100px"></div>`}
    <div class="card-body">
      <h3 class="card-title">${esc(article.title)}</h3>
      <span class="card-time">${esc(article.time_ago)}</span>
    </div>`;
  return el;
}

function makeCardEl(className, url) {
  const el = document.createElement('div');
  el.className = className;
  el.addEventListener('click', () => openUrl(url));
  return el;
}

// ── Tab switching ──────────────────────────────────────────────────────────
function setupTabBar() {
  document.querySelectorAll('.tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  if (tab === state.currentTab && !state.loading) return;
  state.currentTab = tab;
  state.currentSource = 'all';

  // Update CSS accent color
  const color = TAB_COLORS[tab] || '#FF3B30';
  document.documentElement.style.setProperty('--tab-color', color);

  // Update title
  const titleEl = document.getElementById('header-title');
  if (titleEl) titleEl.textContent = TAB_TITLES[tab] || tab;

  // Update bottom tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });

  // Update desktop nav
  document.querySelectorAll('.desktop-nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });

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

// ── Pull to Refresh (mobile) ───────────────────────────────────────────────
function setupPullToRefresh() {
  let startY = 0;
  let pulling = false;
  const indicator = document.getElementById('ptr-indicator');

  document.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    pulling = window.scrollY === 0;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 60) indicator?.classList.add('visible');
  }, { passive: true });

  document.addEventListener('touchend', async () => {
    if (!indicator?.classList.contains('visible')) return;
    indicator.classList.remove('visible');
    if (!state.loading) {
      await fetch('/api/refresh');
      await loadArticles();
    }
    pulling = false;
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function openUrl(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(date) {
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
