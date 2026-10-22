/* Card Checklist — static PWA. All data stays on the device (localStorage + IndexedDB). */
'use strict';
(() => {
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const LS_SETS = 'cc.sets.v1', LS_COLL = 'cc.collection.v1', LS_PREFS = 'cc.prefs.v1';
const CONDITIONS = ['', 'Raw', 'Near Mint', 'Mint', 'Excellent', 'Very Good', 'Damaged', 'Graded'];

/* ---------------- utils ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
const hashHue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const fmtRun = r => r ? (r === 1 ? '1/1' : '/' + r) : '';
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms); }
function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /Mobi|iPhone|Android/i.test(navigator.userAgent)) {
    navigator.share({ files: [file], title: name }).catch(() => {}); return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------------- storage ---------------- */
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
let sets = load(LS_SETS, []);
let coll = load(LS_COLL, {});
let prefs = load(LS_PREFS, { theme: 'auto', seeded: false });
const saveSets = () => localStorage.setItem(LS_SETS, JSON.stringify(sets));
const saveColl = () => localStorage.setItem(LS_COLL, JSON.stringify(coll));
const savePrefs = () => localStorage.setItem(LS_PREFS, JSON.stringify(prefs));
// my own prices (override the weekly published price; never touched by the refresh): {setId:{cardId:{vid:number}}}
const LS_MYP = 'cc.myprices.v1';
let myPrices = load(LS_MYP, {});
const saveMyPrices = () => localStorage.setItem(LS_MYP, JSON.stringify(myPrices));

// IndexedDB for user photos (Blobs)
const idb = new Promise((res, rej) => {
  const r = indexedDB.open('cc-photos', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('photos');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => { const db = await idb; return new Promise((res, rej) => { const t = db.transaction('photos', mode); const st = t.objectStore('photos'); const out = fn(st); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); };
const photoKeys = new Set();
const photoURLs = new Map();
const pkey = (setId, cardId, parId) => `${setId}|${cardId}|${parId}`;
async function photoPut(key, blob) { await tx('readwrite', st => st.put(blob, key)); photoKeys.add(key); if (photoURLs.has(key)) { URL.revokeObjectURL(photoURLs.get(key)); photoURLs.delete(key); } }
async function photoDel(key) { await tx('readwrite', st => st.delete(key)); photoKeys.delete(key); if (photoURLs.has(key)) { URL.revokeObjectURL(photoURLs.get(key)); photoURLs.delete(key); } }
async function photoGet(key) { return tx('readonly', st => st.get(key)); }
async function photoURL(key) {
  if (photoURLs.has(key)) return photoURLs.get(key);
  const b = await photoGet(key); if (!b) return null;
  const u = URL.createObjectURL(b); photoURLs.set(key, u); return u;
}
async function loadPhotoKeys() { const keys = await tx('readonly', st => st.getAllKeys()); (keys || []).forEach(k => photoKeys.add(k)); }
function hydratePhotos(root = view) {
  root.querySelectorAll('img[data-pk]').forEach(async img => { const u = await photoURL(img.dataset.pk); if (u) img.src = u; });
}
async function resizeImage(file, max = 1400) {
  const bmp = await createImageBitmap(file).catch(() => null);
  let w, h, src = bmp;
  if (!bmp) { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
  w = src.width; h = src.height; const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
}

/* ---------------- data model ---------------- */
const BASE_ID = 'base';
function parseParallelLine(line) {
  // "Gold Refractor /50 #d4a017 [Base|Rookies]"
  let s = line.trim(); if (!s) return null;
  let appliesTo = [], color = '', printRun = null;
  s = s.replace(/\[([^\]]*)\]/, (_, a) => { appliesTo = a.split('|').map(x => x.trim()).filter(Boolean); return ''; });
  s = s.replace(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i, m => { color = m; return ''; });
  s = s.replace(/\b1\s*\/\s*1\b/, () => { printRun = 1; return ''; });
  s = s.replace(/\/\s*(\d+)/, (_, n) => { printRun = +n; return ''; });
  const name = s.replace(/\s+/g, ' ').trim(); if (!name) return null;
  return { name, printRun, color, appliesTo };
}
const parallelToLine = p => [p.name, fmtRun(p.printRun), p.color, p.appliesTo?.length ? `[${p.appliesTo.join('|')}]` : ''].filter(Boolean).join(' ');
const COLOR_GUESS = { gold: '#d4a017', red: '#e0303a', blue: '#2f7cf6', green: '#22a55a', orange: '#f07a1a', purple: '#8a5cf6', pink: '#ec4899', black: '#222', silver: '#b9c6d6', refractor: '#b9c6d6', aqua: '#14b8c4', yellow: '#facc15', super: '#8a5cf6', white: '#f5f5f5', bronze: '#b06a2c', teal: '#14b8a6' };
const guessColor = name => { const n = name.toLowerCase(); for (const k in COLOR_GUESS) if (n.includes(k)) return COLOR_GUESS[k]; return `hsl(${hashHue(name)} 60% 55%)`; };

function normalizeSet(raw) {
  const s = {
    format: 'card-checklist-set', version: 1,
    id: raw.id ? slug(raw.id) : slug(`${raw.year || ''}-${raw.brand || ''}-${raw.name || 'set'}`),
    name: String(raw.name || 'Untitled set').trim(), year: raw.year ? String(raw.year) : '',
    brand: String(raw.brand || '').trim(), sport: String(raw.sport || '').trim(),
    baseName: String(raw.baseName || 'Base').trim(), example: !!raw.example, notes: raw.notes || '',
    team: raw.team || '', chase: !!raw.chase, pinned: !!raw.pinned, chasePlayer: raw.chasePlayer || '', sources: Array.isArray(raw.sources) ? raw.sources : [], dataVersion: raw.dataVersion || 0,
    parallels: [], cards: []
  };
  const pids = new Set([BASE_ID]);
  for (const p0 of raw.parallels || []) {
    const p = typeof p0 === 'string' ? parseParallelLine(p0) : p0; if (!p || !p.name) continue;
    const printRun = p.printRun === '' || p.printRun == null ? null : (parseInt(String(p.printRun).replace(/^\D*?(\d+)$/, '$1').replace(/^1\/1$/, '1'), 10) || null);
    let id = slug(p.id || `${p.name}${printRun ? '-' + printRun : ''}`); while (pids.has(id)) id += '-2'; pids.add(id);
    let applies = p.appliesTo ?? p.applies_to ?? [];
    if (typeof applies === 'string') applies = applies.split('|').map(x => x.trim()).filter(Boolean);
    s.parallels.push({ id, name: String(p.name).trim(), printRun, color: p.color || guessColor(p.name), appliesTo: applies });
  }
  const cids = new Set();
  for (const c of raw.cards || []) {
    if (!c) continue;
    const number = String(c.number ?? '').trim(); const player = String(c.player ?? '').trim();
    if (!number && !player) continue;
    const subset = String(c.subset || '').trim() || s.baseName;
    let id = slug(c.id || `${subset === s.baseName ? '' : subset + '-'}${number || player}`); while (cids.has(id)) id += '-2'; cids.add(id);
    const card = { id, number, player, team: String(c.team || '').trim(), subset, rookie: c.rookie === true || /^(y|yes|true|1|rc|x)$/i.test(String(c.rookie || '')), image: String(c.image || '').trim() };
    // optional per-card exact version list (parallel ids or names); otherwise appliesTo rules are used
    let pl = c.parallels; if (typeof pl === 'string') pl = pl.split('|').map(x => x.trim()).filter(Boolean);
    if (Array.isArray(pl)) card.parallels = pl.map(x => (s.parallels.find(p => p.id === x || p.id === slug(x)) || s.parallels.find(p => p.name.toLowerCase() === String(x).toLowerCase()) || {}).id).filter(Boolean);
    if (c.noBase === true || /^(y|yes|true|1)$/i.test(String(c.noBase || ''))) card.noBase = true;
    if (c.featured === true || /^(y|yes|true|1)$/i.test(String(c.featured || ''))) card.featured = true;
    if (c.images && typeof c.images === 'object') card.images = c.images;
    for (const k of ['notes', 'ref', 'players', 'year', 'product', 'series']) if (c[k]) card[k] = String(c[k]);
    s.cards.push(card);
  }
  return s;
}
const baseVersion = set => ({ id: BASE_ID, name: set.baseName === 'Base' ? 'Base' : set.baseName, printRun: null, color: '' });
const versionsFor = (set, card) => {
  const pars = card.parallels ? set.parallels.filter(p => card.parallels.includes(p.id)) : set.parallels.filter(p => !p.appliesTo?.length || p.appliesTo.includes(card.subset));
  return card.noBase ? pars : [baseVersion(set), ...pars];
};
const verImage = (card, vid) => vid === BASE_ID ? card.image : (card.images && card.images[vid]) || '';
const getSet = id => sets.find(s => s.id === id);
const own = (setId, cardId, parId) => coll[setId]?.[cardId]?.[parId];
function setOwn(setId, cardId, parId, patch) {
  coll[setId] ??= {}; coll[setId][cardId] ??= {};
  if (patch === null) { delete coll[setId][cardId][parId]; if (!Object.keys(coll[setId][cardId]).length) delete coll[setId][cardId]; }
  else coll[setId][cardId][parId] = { ...(coll[setId][cardId][parId] || { q: 1 }), ...patch };
  saveColl();
}
const ownedCount = (set, card) => versionsFor(set, card).filter(v => own(set.id, card.id, v.id)).length;
const isHit = c => /autograph|relic|swatch|material|stitches|patch|real one auto/i.test(c.subset);
const subsets = set => [...new Set(set.cards.map(c => c.subset))];

function stats(set) {
  const st = { combos: 0, owned: 0, anyCards: 0, qty: 0, base: { t: 0, o: 0 }, subsets: {}, par: {} };
  for (const p of set.parallels) st.par[p.id] = { t: 0, o: 0 };
  for (const c of set.cards) {
    let any = false;
    for (const v of versionsFor(set, c)) {
      const o = own(set.id, c.id, v.id); st.combos++;
      if (o) { st.owned++; any = true; st.qty += o.q || 1; }
      if (v.id === BASE_ID) {
        const bucket = c.subset === set.baseName ? st.base : (st.subsets[c.subset] ??= { t: 0, o: 0 });
        bucket.t++; if (o) bucket.o++;
      } else { st.par[v.id].t++; if (o) st.par[v.id].o++; }
    }
    if (any) st.anyCards++;
  }
  return st;
}

/* ---------------- card art (fallback when no image) ---------------- */
function artURL(set, card, ver) {
  const hue = hashHue(card.team || card.player);
  const accent = ver && ver.color ? ver.color : `hsl(${hue} 65% 50%)`;
  const name = esc(card.player || '').slice(0, 26), team = esc(card.team || '').slice(0, 28);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 22%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 50% 12%)"/></linearGradient></defs>
<rect width="250" height="350" rx="14" fill="${accent}"/><rect x="9" y="9" width="232" height="332" rx="9" fill="url(#g)"/>
<circle cx="125" cy="130" r="52" fill="rgba(255,255,255,.10)"/><circle cx="125" cy="112" r="22" fill="rgba(255,255,255,.22)"/><path d="M83 178c6-26 24-38 42-38s36 12 42 38z" fill="rgba(255,255,255,.22)"/>
<text x="20" y="40" font-family="system-ui,sans-serif" font-size="22" font-weight="800" fill="#fff">#${esc(card.number)}</text>
${card.rookie ? `<rect x="190" y="20" width="40" height="24" rx="6" fill="#22c3a6"/><text x="210" y="37" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="800" fill="#fff">RC</text>` : ''}
<rect x="9" y="250" width="232" height="91" fill="rgba(0,0,0,.35)"/>
<text x="125" y="285" text-anchor="middle" font-family="system-ui,sans-serif" font-size="19" font-weight="800" fill="#fff">${name}</text>
<text x="125" y="310" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="rgba(255,255,255,.75)">${team}</text>
<text x="125" y="330" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="${accent}" font-weight="700">${esc(ver && ver.id !== BASE_ID ? ver.name + ' ' + fmtRun(ver.printRun) : card.subset)}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
// When a reference image URL fails, swap to generated art.
document.addEventListener('error', e => { const img = e.target; if (img.tagName === 'IMG' && img.dataset.fallback && img.src !== img.dataset.fallback) img.src = img.dataset.fallback; }, true);
function imgTag(set, card, ver, { pk, alt = '', src: forced } = {}) {
  const fb = artURL(set, card, ver);
  const src = forced || (ver && verImage(card, ver.id)) || card.image || fb;
  return `<img loading="lazy" alt="${esc(alt)}" src="${esc(src)}" data-fallback="${esc(fb)}" ${pk ? `data-pk="${esc(pk)}"` : ''}>`;
}

// First owned version that has one of my photos (used as thumbnail when the card has no reference image)
function photoKeyFor(set, card, preferVid) {
  const ids = [preferVid, ...versionsFor(set, card).filter(v => own(set.id, card.id, v.id)).map(v => v.id), ...versionsFor(set, card).map(v => v.id)].filter(Boolean);
  return ids.map(id => pkey(set.id, card.id, id)).find(k => photoKeys.has(k));
}
const thumbPk = (set, card) => card.image ? undefined : photoKeyFor(set, card);
const cardLine = (set, card) => [card.year, card.product].filter(Boolean).join(' ');

/* ---------------- prices (raw / ungraded) ---------------- */
let PRICES = null; // prices.json: { updated, urlBase, p: {setId:{cardId:{vid:[price, path, date]}}} }
const money = v => v == null || isNaN(v) ? '' : '$' + (v >= 1000 ? Math.round(v).toLocaleString('en-US') : (+v).toFixed(2));
const myPrice = (sid, cid, vid) => myPrices[sid]?.[cid]?.[vid];
function setMyPrice(sid, cid, vid, v) {
  if (v == null) { if (myPrices[sid]?.[cid]) { delete myPrices[sid][cid][vid]; if (!Object.keys(myPrices[sid][cid]).length) delete myPrices[sid][cid]; } }
  else { myPrices[sid] ??= {}; myPrices[sid][cid] ??= {}; myPrices[sid][cid][vid] = v; }
  saveMyPrices();
}
function pubPrice(sid, cid, vid) { const e = PRICES?.p?.[sid]?.[cid]?.[vid]; return e && e[0] != null ? { v: e[0], url: (PRICES.urlBase || 'https://www.sportscardspro.com/game/') + e[1], date: e[2] || PRICES.updated } : null; }
function priceOf(set, card, vid) { const m = myPrice(set.id, card.id, vid); if (m != null) return { v: m, mine: true }; return pubPrice(set.id, card.id, vid); }
function valueOf(sets_) {
  const r = { v: 0, priced: 0, unpriced: 0, items: 0 };
  for (const s of sets_) for (const c of s.cards) for (const ver of versionsFor(s, c)) {
    const o = own(s.id, c.id, ver.id); if (!o) continue; const q = o.q || 1; r.items += q;
    const p = priceOf(s, c, ver.id); if (p) { r.v += p.v * q; r.priced++; } else r.unpriced++;
  }
  return r;
}
const valueLine = r => r.priced ? `${money(r.v)}${r.unpriced ? ` <span class="muted">· ${r.unpriced} unpriced</span>` : ''}` : (r.unpriced ? `<span class="muted">no prices yet</span>` : '');
function cardQuery(set, card, ver) {
  const y = String(card.year || set.year || '').match(/(19|20)\d\d/)?.[0] || '';
  const prod = card.product || [set.brand, set.name.replace(/ — .*/, '').replace(/^Topps /, '')].filter(Boolean).join(' ');
  return [y, prod, (card.player || '').split(' / ')[0], card.number, ver && ver.id !== BASE_ID ? ver.name.replace(/\(.*?\)/g, '') : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
const lookupURL = (set, card, ver) => 'https://www.sportscardspro.com/search-products?type=prices&q=' + encodeURIComponent(cardQuery(set, card, ver));
// eBay: Sports Trading Card Singles (261328); Buy It Now sorted by price + shipping lowest first / sold / auctions
const ebayURL = (set, card, ver, mode = 'bin') => 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(cardQuery(set, card, ver)) + '&_sacat=261328' +
  (mode === 'sold' ? '&LH_Sold=1&LH_Complete=1&_sop=13' : mode === 'auction' ? '&LH_Auction=1&_sop=1' : '&LH_BIN=1&_sop=15');
const whatnotURL = (set, card, ver) => 'https://www.whatnot.com/search?query=' + encodeURIComponent(cardQuery(set, card, ver)) + '&referringSource=typed';
// weekly snapshot of the lowest listed price found (prices.json "l"): {wn:[price, url, iso]} — can be outdated
function listedOf(sid, cid, vid) {
  const e = PRICES?.l?.[sid]?.[cid]?.[vid]; if (!e) return null;
  const best = Object.entries(e).filter(([, x]) => x && x[0] != null).map(([site, x]) => ({ site, v: x[0], url: x[1], t: x[2] })).sort((a, b) => a.v - b.v)[0];
  return best || null;
}
const SITE = { wn: 'Whatnot', eb: 'eBay' };
const shortDay = iso => { try { return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); } catch { return iso; } };
function buyLinks(set, card, v) {
  return `<div class="buy"><a class="btn sm" href="${esc(ebayURL(set, card, v))}" target="_blank" rel="noopener">eBay</a><a class="btn sm" href="${esc(whatnotURL(set, card, v))}" target="_blank" rel="noopener">Whatnot</a></div>`;
}
function priceLine(set, card, v) {
  const p = priceOf(set, card, v.id), l = listedOf(set.id, card.id, v.id);
  if (!p && !l) return '';
  const cheaper = p && l ? (l.v < p.v ? 'l' : 'p') : '';
  return `<div class="small pl">${p ? `<span class="${cheaper === 'p' ? 'best' : ''}">${p.mine ? 'My price' : 'Raw sold'} ${money(p.v)}</span>` : ''}${l ? `${p ? ' · ' : ''}<span class="${cheaper === 'l' ? 'best' : ''}">Listed ${money(l.v)} on ${SITE[l.site] || l.site}</span>` : ''}</div>`;
}
// best known price used for sorting: my price > raw sold > lowest listed
const sortPrice = (set, card, vid) => priceOf(set, card, vid)?.v ?? listedOf(set.id, card.id, vid)?.v ?? null;
/* ---------------- Deals (from the weekly lowest-listing snapshot) ---------------- */
// A deal = a version you don't own, in a set where you own at least one card, whose lowest listing + assumed shipping is
// at least prefs.dealPct % under the raw (ungraded) market price. Ownership is local, so this is computed on the phone.
const dealPct = () => prefs.dealPct ?? 25, dealShip = () => prefs.dealShip ?? 4;
function computeDeals({ includeHidden = false } = {}) {
  const out = []; if (!PRICES?.l) return out;
  const hid = prefs.dealHide || {};
  for (const s of sets) {
    if (s.example || !s.cards.some(c => ownedCount(s, c))) continue;
    const L = PRICES.l[s.id]; if (!L) continue;
    for (const c of s.cards) { const LC = L[c.id]; if (!LC) continue;
      for (const v of versionsFor(s, c)) {
        if (own(s.id, c.id, v.id)) continue;
        const raw = pubPrice(s.id, c.id, v.id); if (!raw || raw.v < 1) continue; // no reliable market price → skip
        const e = LC[v.id]; if (!e) continue;
        for (const [site, x] of Object.entries(e)) {
          if (!x || x[0] == null) continue;
          const total = x[0] + dealShip(), off = 1 - total / raw.v;
          if (off * 100 < dealPct()) continue;
          const key = `${s.id}|${c.id}|${v.id}|${x[1]}`, hidden = !!hid[key];
          if (hidden && !includeHidden) continue;
          out.push({ s, c, v, site, price: x[0], url: x[1], t: x[2], title: x[3] || '', raw, total, off, key, hidden });
        }
      }
    }
  }
  return out.sort((a, b) => b.off - a.off);
}
function dealHtml(d) {
  return `<div class="card deal${d.hidden ? ' hidden-deal' : ''}">
    <div class="row" style="align-items:flex-start;gap:12px">
      <div class="thumb" style="width:72px;flex:none" data-go="#/set/${esc(d.s.id)}/card/${esc(d.c.id)}">${imgTag(d.s, d.c, d.v, { alt: d.c.player })}</div>
      <div class="grow" style="min-width:0">
        <div class="row"><b class="grow ellipsis">${esc(d.c.player)} #${esc(d.c.number)}</b><span class="off">−${Math.round(d.off * 100)}%</span></div>
        <div class="small ellipsis">${esc(d.v.id === BASE_ID ? 'Base' : d.v.name)} · <span class="muted">${esc(d.s.year)} ${esc(d.s.name.replace(/ — .*/, ''))}</span></div>
        <div class="small" style="margin-top:4px"><b class="best">${money(d.price)}</b> + ~${money(dealShip())} ship on ${SITE[d.site] || d.site} <span class="muted">vs raw ${money(d.raw.v)}</span></div>
        <div class="small muted">checked ${esc(shortDay(d.t))}${d.title ? ` · “${esc(d.title.slice(0, 70))}”` : ''}</div>
        ${d.off > 0.8 ? '<div class="small warn">Unusually low — check the photos/description before buying.</div>' : ''}
        <div class="buy" style="margin-top:6px"><a class="btn sm primary" href="${esc(d.url)}" target="_blank" rel="noopener">Open listing ↗</a><a class="btn sm" href="${esc(d.raw.url)}" target="_blank" rel="noopener">Market</a><button class="btn sm" data-hide-deal="${esc(d.key)}">${d.hidden ? 'Unhide' : 'Hide'}</button></div>
      </div></div></div>`;
}
const dealState = { showHidden: false };
function renderDeals() {
  setTitle('Deals');
  const all = computeDeals({ includeHidden: dealState.showHidden }); const nHidden = Object.keys(prefs.dealHide || {}).length;
  const at = PRICES?.listedAt ? shortDay(PRICES.listedAt) : null;
  view.innerHTML = `<div class="card">
      <div class="small"><b>Weekly snapshot</b> of the lowest Buy-It-Now listing found on Whatnot${at ? ` (checked ${esc(at)})` : ''}, compared with the raw (ungraded) market price from SportsCardsPro. Listings sell or change — always check before buying.</div>
      <div class="small muted" style="margin-top:6px">Only versions you don't own, in sets where you own at least one card. eBay isn't checked automatically (its search pages are off-limits to bots) — use the eBay buttons on each card.</div>
      <div class="row" style="gap:10px;margin-top:10px;flex-wrap:wrap">
        <label class="small">At least <select id="dPct" class="input" style="width:auto;display:inline-block;padding:4px 8px">${[10, 15, 20, 25, 30, 40, 50].map(p => `<option value="${p}" ${p === dealPct() ? 'selected' : ''}>${p}%</option>`).join('')}</select> under</label>
        <label class="small">Shipping ~$<input id="dShip" class="input" type="number" min="0" step="0.5" inputmode="decimal" value="${dealShip()}" style="width:64px;display:inline-block;padding:4px 8px"></label>
        ${nHidden ? `<button class="btn sm" id="dHid">${dealState.showHidden ? 'Hide hidden' : `Show hidden (${nHidden})`}</button>` : ''}
      </div></div>
    <div class="card row" style="gap:10px"><div class="grow small">🔔 <b>Deal alerts</b> for the featured chases (40%+ under market).<div class="muted">${prefs.pushSub ? 'On — subscription saved on this phone.' : 'Works from the home-screen app (iOS 16.4+).'}</div></div><button class="btn sm" data-action="push">${prefs.pushSub ? 'Manage' : 'Enable'}</button></div>
    ${!PRICES?.l ? '<div class="empty"><p>No listing snapshot yet — connect to the internet and reopen the app.</p></div>'
      : all.length ? `<div class="section-title">${all.length} deal${all.length === 1 ? '' : 's'} · biggest discount first</div>${all.map(dealHtml).join('')}`
      : `<div class="empty"><p>No deals at ${dealPct()}%+ under market in this week's snapshot. Try a lower threshold.</p></div>`}`;
  $('#dPct').onchange = e => { prefs.dealPct = +e.target.value; savePrefs(); renderDeals(); };
  $('#dShip').onchange = e => { const v = parseFloat(e.target.value); prefs.dealShip = isNaN(v) || v < 0 ? 4 : v; savePrefs(); renderDeals(); };
  const dh = $('#dHid'); if (dh) dh.onclick = () => { dealState.showHidden = !dealState.showHidden; renderDeals(); };
}

/* ---------------- Web Push deal alerts (no backend: the subscription is pasted to Groky) ---------------- */
const VAPID_PUBLIC = 'BGZ2Cw2uhWgLDSj8uydncEU7eeOnU9FBARPJ6aPL4ctQHKLp2JnK0AHQREgpXQ9gDj_WswPAHoiAsgK8kbwdRLo';
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const b64u = s => { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, ch => ch.charCodeAt(0)); };
const pushText = sub => `Groky — please save my deal-alert subscription (Phillies Checklist):\n\`\`\`json\n${JSON.stringify({ format: 'cc-push-sub', label: 'iPhone', endpoint: sub.endpoint, keys: sub.keys })}\n\`\`\``;
function openPush() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const sub = prefs.pushSub;
  openSheet(`<h2>🔔 Deal alerts</h2>
    <p class="small" style="margin-top:0">Get a notification when a card in your <b>featured chases</b> (Cool Crushers, Cycle Complete, VJ Edgecombe, Tyrese Maxey and the three 2008 Phillies sets) is listed at least <b>40% under</b> its raw market price in the weekly snapshot.</p>
    ${!supported || !isStandalone() ? `<p class="small warn">${isStandalone() ? 'This browser doesn’t support web push.' : 'On iPhone this only works from the <b>home-screen app</b> (iOS 16.4 or later): Safari → Share → “Add to Home Screen”, then open it from the home screen icon and tap Enable here.'}</p>` : ''}
    ${sub ? `<p class="small">✅ Alerts are set up on this phone. If you haven't yet, send this to Groky in our chat (it's also included in “Send my cards to Groky”):</p>
       <textarea class="input" id="psT" readonly style="height:120px;font-size:12px;font-family:ui-monospace,monospace">${esc(pushText(sub))}</textarea>
       <div class="btn-row" style="margin-top:10px">${navigator.share ? '<button class="btn primary" id="psShare">Share…</button>' : ''}<button class="btn" id="psCopy">Copy</button><button class="btn" id="psOff">Turn off</button></div>`
      : `<button class="btn primary block" id="psOn" ${supported ? '' : 'disabled'}>Enable deal alerts</button>
         <p class="small muted">After you allow notifications, copy or share the code it shows and paste it into our chat — there's no server, so Groky sends the alerts.</p>`}`, el => {
    const on = $('#psOn', el);
    if (on) on.onclick = () => {
      // must start from the tap itself (iOS requires a user gesture for the permission prompt)
      Notification.requestPermission().then(async perm => {
        if (perm !== 'granted') { toast('Notifications not allowed — you can enable them in Settings › Notifications', 4000); return; }
        try {
          const reg = await navigator.serviceWorker.ready;
          const s = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(VAPID_PUBLIC) });
          const j = s.toJSON(); prefs.pushSub = { endpoint: j.endpoint, keys: j.keys, at: new Date().toISOString() }; savePrefs();
          openPush(); toast('Alerts enabled — now send the code to Groky', 3500);
        } catch (e) { toast('Could not subscribe: ' + e.message, 4000); }
      });
    };
    const t = sub && pushText(sub);
    const cp = $('#psCopy', el); if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(t); toast('Copied — paste it into the chat'); } catch { const ta = $('#psT', el); ta.select(); ta.setSelectionRange(0, t.length); toast(document.execCommand?.('copy') ? 'Copied' : 'Select the text and copy it', 3000); } };
    const sh = $('#psShare', el); if (sh) sh.onclick = () => navigator.share({ title: 'Deal alerts for Groky', text: t }).catch(() => {});
    const off = $('#psOff', el); if (off) off.onclick = async () => { try { const reg = await navigator.serviceWorker.ready; const s = await reg.pushManager.getSubscription(); if (s) await s.unsubscribe(); } catch { } delete prefs.pushSub; savePrefs(); closeSheet(); toast('Deal alerts turned off on this phone'); };
  });
}

async function loadPrices() {
  try { const r = await fetch('prices.json', { cache: 'no-cache' }); if (r.ok) { PRICES = await r.json(); return true; } } catch { }
  return false;
}

/* ---------------- published-card registry & merging cards Groky adds (data/extra.json) ---------------- */
const PUB = new Set(); // "setId|cardId" of every card in the published data
let pubLoaded = false;
const pubKey = (sid, cid) => sid + '|' + cid;
const isUserCard = (s, c) => !c.pub && !PUB.has(pubKey(s.id, c.id));
async function mergeExtra() {
  // Cards Groky publishes after you "Send to Groky". Merge by set id + card id: never duplicates, and never touches your
  // ownership, quantities, notes, photos or your own prices (those are keyed by the same ids, so they stay attached).
  try {
    const r = await fetch('data/extra.json', { cache: 'no-cache' }); if (!r.ok) return 0;
    const ex = await r.json(); let n = 0;
    for (const it of ex.cards || []) {
      const s = getSet(it.set); const pc = it.card; if (!s || !pc?.id) continue;
      PUB.add(pubKey(s.id, pc.id));
      const SAFE = ['number', 'player', 'team', 'subset', 'rookie', 'year', 'product', 'image', 'images', 'ref', 'notes', 'players'];
      let c = s.cards.find(x => x.id === pc.id);
      if (!c) { c = { id: pc.id, team: s.team || '', subset: s.baseName, parallels: s.chase ? [] : undefined }; if (c.parallels === undefined) delete c.parallels; s.cards.push(c); }
      for (const k of SAFE) if (pc[k] !== undefined && pc[k] !== '') c[k] = pc[k];
      if (Array.isArray(pc.parallels) && !s.chase) c.parallels = pc.parallels;
      if (!c.pub) { c.pub = true; n++; }
    }
    if (n) saveSets();
    return n;
  } catch (e) { console.warn('extra.json not merged', e); return 0; }
}

/* ---------------- Send to Groky ---------------- */
function userCards() {
  const out = [];
  for (const s of sets) if (!s.example) for (const c of s.cards) if (isUserCard(s, c)) out.push([s, c]);
  return out;
}
function grokyPayload() {
  const list = userCards();
  const items = list.map(([s, c]) => ({
    set: { id: s.id, name: s.name, year: s.year, brand: s.brand, sport: s.sport, chase: !!s.chase },
    card: { id: c.id, number: c.number, player: c.player, team: c.team, subset: c.subset, rookie: !!c.rookie, year: c.year || '', product: c.product || '' },
    owned: versionsFor(s, c).filter(v => own(s.id, c.id, v.id)).map(v => { const o = own(s.id, c.id, v.id); return { version: v.id, name: v.name, q: o.q || 1, note: o.note || '', cond: o.cond || '', serial: o.serial || '', myPrice: myPrice(s.id, c.id, v.id) ?? null }; }),
    sentBefore: !!prefs.sent?.[pubKey(s.id, c.id)]
  }));
  const lines = items.map(i => {
    const own_ = i.owned.length ? i.owned.map(o => `${o.name}${o.q > 1 ? ' ×' + o.q : ''}${o.note ? ' (' + o.note + ')' : ''}`).join(', ') : 'not owned';
    return `• ${[i.card.year || i.set.year, i.card.product || i.set.name].filter(Boolean).join(' ')} #${i.card.number} ${i.card.player}${i.card.subset && i.card.subset !== 'Base' ? ' — ' + i.card.subset : ''}${i.card.rookie ? ' RC' : ''} [${i.set.name}] — ${own_}`;
  });
  const json = { format: 'cc-user-cards', v: 1, exportedAt: new Date().toISOString(), cards: items };
  if (prefs.pushSub) json.push = { format: 'cc-push-sub', label: 'iPhone', endpoint: prefs.pushSub.endpoint, keys: prefs.pushSub.keys };
  const head = items.length ? `Groky — please add these ${items.length} card${items.length === 1 ? '' : 's'} I entered on my phone to the published checklist (and price them):\n${lines.join('\n')}` : 'Groky — no new cards this time.';
  const text = `${head}${prefs.pushSub ? '\nAlso: please save my deal-alert subscription (in the JSON below, "push").' : ''}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
  return { items, text };
}
function openSendToGroky() {
  const { items, text } = grokyPayload();
  if (!pubLoaded) { openSheet(`<h2>Send to Groky</h2><p>Connect to the internet once and reopen the app so it can tell which cards are already in the published checklist.</p>`); return; }
  if (!items.length && !prefs.pushSub) { openSheet(`<h2>Send to Groky</h2><p>Nothing to send — every card you've entered is already in the published checklist${PUB.size ? '' : ' (connect to the internet once so the app can check)'}.</p>`); return; }
  openSheet(`<h2>Send to Groky</h2>
    <p class="small muted" style="margin-top:0">${items.length} card${items.length === 1 ? '' : 's'} you added on this phone (not in the published checklist yet). Tap <b>Share</b> or <b>Copy</b>, then paste it into our chat. Once they're published, the app merges them with your entries automatically — nothing is duplicated and your ownership, photos and prices stay.</p>
    <textarea class="input" id="gk" readonly style="height:200px;font-size:13px;font-family:ui-monospace,monospace">${esc(text)}</textarea>
    <div class="btn-row" style="margin-top:10px">${navigator.share ? '<button class="btn primary" id="gkShare">Share…</button>' : ''}<button class="btn ${navigator.share ? '' : 'primary'}" id="gkCopy">Copy</button></div>`, el => {
    const mark = () => { prefs.sent ??= {}; const d = new Date().toISOString().slice(0, 10); for (const i of items) prefs.sent[pubKey(i.set.id, i.card.id)] = d; savePrefs(); };
    $('#gkCopy', el).onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied — paste it into the chat'); mark(); }
      catch { const t = $('#gk', el); t.removeAttribute('readonly'); t.select(); t.setSelectionRange(0, text.length); const ok = document.execCommand && document.execCommand('copy'); t.setAttribute('readonly', ''); toast(ok ? 'Copied — paste it into the chat' : 'Select the text and copy it', 3000); if (ok) mark(); }
    };
    const sh = $('#gkShare', el); if (sh) sh.onclick = async () => { try { await navigator.share({ title: 'Cards for Groky', text }); mark(); } catch (e) { if (e.name !== 'AbortError') toast('Share failed — use Copy', 3000); } };
  });
}

/* ---------------- sheet (bottom dialog) ---------------- */
const sheet = $('#sheet'), sheetBody = $('#sheetBody');
function openSheet(html, onMount) { sheetBody.innerHTML = html; sheet.hidden = false; onMount && onMount(sheetBody); }
function closeSheet() { sheet.hidden = true; sheetBody.innerHTML = ''; }
sheet.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });

/* ---------------- routing ---------------- */
const filters = {};
const scrollMem = {};
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').map(decodeURIComponent);
  return { parts, key: h };
}
let currentKey = null;
function render() {
  if (currentKey !== null) scrollMem[currentKey] = window.scrollY;
  const { parts, key } = route(); currentKey = key;
  const back = $('#backBtn');
  let parent = null;
  if (parts[0] === 'set' && getSet(parts[1])) {
    const set = getSet(parts[1]);
    if (parts[2] === 'cards') { parent = `#/set/${set.id}`; renderGrid(set); }
    else if (parts[2] === 'card' && set.cards.find(c => c.id === parts[3])) { parent = `#/set/${set.id}/cards`; renderDetail(set, set.cards.find(c => c.id === parts[3])); }
    else { parent = '#/'; renderOverview(set); }
  } else if (parts[0] === 'deals') { parent = '#/'; renderDeals(); }
  else renderHome();
  back.hidden = !parent; back.dataset.href = parent || '';
  requestAnimationFrame(() => window.scrollTo(0, scrollMem[key] || 0));
}
window.addEventListener('hashchange', () => { if (!sheet.hidden) closeSheet(); render(); });
$('#backBtn').addEventListener('click', e => { location.hash = e.currentTarget.dataset.href; });
const setTitle = t => { $('#title').textContent = t; document.title = t + ' · Card Checklist'; };

/* ---------------- views ---------------- */
function progressRow(label, o, t, color, href) {
  return `<div class="par-row" ${href ? `data-go="${href}" style="cursor:pointer"` : ''}>
    ${color !== undefined ? `<span class="swatch" style="background:${esc(color || 'var(--surface)')}"></span>` : ''}
    <div class="grow"><div class="row"><b class="grow ellipsis">${label}</b><span class="small muted">${o}/${t} · ${pct(o, t)}%</span></div>
    <div class="bar" style="margin-top:6px"><i style="width:${pct(o, t)}%"></i></div></div></div>`;
}

function featuredCards() {
  const out = []; for (const s of sets) for (const c of s.cards) if (c.featured) out.push([s, c]); return out;
}
function chaseStats(s) {
  let vers = 0; for (const c of s.cards) vers += versionsFor(s, c).filter(v => own(s.id, c.id, v.id)).length;
  const cards = s.cards.filter(c => ownedCount(s, c)).length; return { cards, vers };
}
function chaseHtml(s) {
  const cs = chaseStats(s);
  const pc = [...s.cards].reverse().find(c => thumbPk(s, c) || c.image);
  return `<div class="card chase">
    <div class="set-item" data-go="#/set/${esc(s.id)}">
      <div class="thumb" style="width:64px;flex:none">${pc ? imgTag(s, pc, null, { pk: thumbPk(s, pc), alt: s.chasePlayer }) : `<div class="chase-ph">🏀</div>`}</div>
      <div class="grow"><div class="small muted">${esc(s.sport)}${s.team ? ' · ' + esc(s.team) : ''}</div>
        <div class="ellipsis"><b>${esc(s.name)}</b></div>
        <div class="small muted">${cs.cards} card${cs.cards === 1 ? '' : 's'} owned${s.cards.length > cs.cards ? ` · ${s.cards.length} listed` : ''}</div>
        ${(() => { const vl = valueLine(valueOf([s])); return vl ? `<div class="small value">💲 ${vl}</div>` : ''; })()}</div>
      <span class="muted" style="font-size:22px">›</span></div>
    <button class="btn primary block big-add" data-chase-add="${esc(s.id)}">＋ Add a card</button></div>`;
}
function pinnedHtml(s) {
  const st = stats(s); const vl = valueLine(valueOf([s]));
  const pc = s.cards.find(c => c.image);
  return `<div class="card set-item feat" data-go="#/set/${esc(s.id)}">
      <div class="thumb" style="width:64px;flex:none">${pc ? imgTag(s, pc, versionsFor(s, pc)[0], { alt: s.name }) : ''}</div>
      <div class="grow"><div class="small muted">${esc(s.year)} · ${s.cards.length} cards${s.parallels.length ? '' : ' · base only'}</div>
        <div class="ellipsis"><b>${esc(s.name.replace(/^2008 /, ''))}</b></div>
        <div class="small muted">${st.owned}/${st.combos} owned · ${Math.round(pct(st.owned, st.combos))}%</div>
        ${vl ? `<div class="small value">💲 ${vl}</div>` : ''}
        <div class="bar" style="margin-top:6px"><i style="width:${pct(st.owned, st.combos)}%"></i></div></div>
      <span class="muted" style="font-size:22px">›</span></div>`;
}
function renderHome() {
  setTitle('Card Checklist');
  const feat = featuredCards(); const chases = sets.filter(s => s.chase); const pinned = sets.filter(s => s.pinned && !s.chase);
  const featHtml = feat.length || chases.length || pinned.length ? `<div class="section-title">★ Featured chases</div>${feat.map(([s, c]) => {
    const vers = versionsFor(s, c); const n = vers.filter(v => own(s.id, c.id, v.id)).length;
    return `<div class="card set-item feat" data-go="#/set/${esc(s.id)}/card/${esc(c.id)}">
      <div class="thumb" style="width:64px;flex:none">${imgTag(s, c, null, { alt: c.player, pk: thumbPk(s, c) })}</div>
      <div class="grow"><div class="small muted">${esc(s.year)} ${esc(s.name.replace(/ — .*/, ''))} · #${esc(c.number)}</div>
        <div class="ellipsis"><b>${esc(c.player)}</b></div>
        <div class="small muted">${n}/${vers.length} versions owned (rainbow)</div>
        ${(() => { const vl = valueLine(valueOf([{ ...s, cards: [c] }])); return vl ? `<div class="small value">💲 ${vl}</div>` : ''; })()}
        <div class="bar" style="margin-top:6px"><i style="width:${pct(n, vers.length)}%"></i></div></div></div>`; }).join('')}${chases.map(chaseHtml).join('')}${pinned.map(pinnedHtml).join('')}` : '';
  const list = sets.filter(s => !s.chase).map(s => { const st = stats(s); return `
    <div class="card set-item" data-go="#/set/${esc(s.id)}">
      <div class="ring" style="--p:${pct(st.owned, st.combos)};width:64px;height:64px"><span style="width:50px;height:50px;font-size:14px">${Math.round(pct(st.owned, st.combos))}%</span></div>
      <div class="grow"><div class="ellipsis"><b>${esc(s.year)} ${esc(s.name)}</b></div>
        <div class="small muted">${s.cards.length} cards · ${s.parallels.length} parallel types · ${st.combos} versions</div>
        <div class="small muted">${st.anyCards}/${s.cards.length} cards owned · ${st.owned}/${st.combos} incl. parallels</div>
        ${(() => { const vl = valueLine(valueOf([s])); return vl ? `<div class="small value">💲 ${vl}</div>` : ''; })()}
        ${s.example ? '<span class="badge example" style="margin-top:4px">EXAMPLE DATA</span>' : ''}</div></div>`; }).join('');
  setTimeout(() => hydratePhotos(), 0);
  const tv = valueOf(sets.filter(s => !s.example)); const nUser = pubLoaded ? userCards().length : 0;
  const totals = sets.length ? `<div class="card totals">
      <div class="row" style="align-items:flex-end"><div class="grow"><div class="small muted">My collection · raw value</div>
        <div class="big-money">${tv.priced ? money(tv.v) : '—'}</div>
        <div class="small muted">${tv.items} card${tv.items === 1 ? '' : 's'} owned · ${tv.priced} priced${tv.unpriced ? ` · ${tv.unpriced} without a price` : ''}</div>
        <div class="small muted">${PRICES?.updated ? `Ungraded prices as of ${esc(PRICES.updated)} · <a href="https://www.sportscardspro.com" target="_blank" rel="noopener">SportsCardsPro</a>` : 'Prices load when you’re online'}</div></div></div>
      <button class="btn block" style="margin-top:10px" data-action="send-groky">📤 Send my cards to Groky${nUser ? ` (${nUser})` : ''}</button></div>` : '';
  const deals = computeDeals();
  const dealsCard = sets.some(s => !s.example) ? `<div class="card set-item deals-card" data-go="#/deals">
      <div style="font-size:30px;flex:none">🔥</div>
      <div class="grow"><div class="ellipsis"><b>Deals</b> ${deals.length ? `<span class="off">${deals.length}</span>` : ''}</div>
        <div class="small muted">${!PRICES?.l ? 'Weekly listing snapshot loads when you’re online' : deals.length ? `Best: ${esc(deals[0].c.player.replace(/ \(.*/, ''))} ${esc(deals[0].v.id === BASE_ID ? 'Base' : deals[0].v.name)} −${Math.round(deals[0].off * 100)}% · ${dealPct()}%+ under market` : `None ${dealPct()}%+ under market this week`}</div>
        <div class="small muted">Weekly snapshot${PRICES?.listedAt ? ' · checked ' + esc(shortDay(PRICES.listedAt)) : ''}</div></div>
      <span class="muted" style="font-size:22px">›</span></div>` : '';
  view.innerHTML = `${totals}${dealsCard}${featHtml}
    ${list ? `<div class="section-title">My sets</div>${list}` : `<div class="empty"><div style="font-size:48px">🃏</div><p>No sets yet. Import a checklist to get started.</p></div>`}
    <div class="section-title">Add a set</div>
    <div class="card"><div class="btn-row">
      <button class="btn primary" data-action="import">Import checklist</button>
      <button class="btn" data-action="new-set">Create manually</button></div>
      ${!sets.length ? `<button class="btn block" style="margin-top:10px" data-action="load-default">Load Phillies 2026 checklists</button>` : ''}
      <p class="small muted" style="margin:10px 2px 0">Import a JSON or CSV checklist (file, paste, or link). Your collection and photos are stored only on this phone — use <b>Backup</b> in the ⋯ menu to save a copy.</p></div>`;
}

function renderOverview(set) {
  setTitle(set.name);
  const st = stats(set);
  const subs = Object.entries(st.subsets);
  view.innerHTML = `
    <div class="card">
      ${set.example ? '<div class="badge example" style="margin-bottom:8px">EXAMPLE DATA — fictional demo set</div>' : ''}
      <div class="row" style="align-items:center">
        <div class="grow"><div class="small muted">${esc([set.year, set.brand, set.sport].filter(Boolean).join(' · '))}</div>
          <h2 style="margin:2px 0 6px;font-size:22px">${esc(set.name)}</h2>
          <div class="small muted">${set.cards.length} cards · ${set.parallels.length} parallels · ${st.combos} total versions</div>
          <div class="small muted">${st.qty} cards in collection (incl. dupes)</div>
          ${(() => { const vl = valueLine(valueOf([set])); return vl ? `<div class="value" style="margin-top:4px">💲 Raw value: <b>${vl}</b></div>` : ''; })()}</div>
        <div class="ring" style="--p:${pct(st.owned, st.combos)}"><span>${Math.round(pct(st.owned, st.combos))}%</span></div>
      </div>
      ${set.chase ? `<button class="btn primary block big-add" style="margin-top:14px" data-chase-add="${esc(set.id)}">＋ Add a card</button>
        ${set.cards.length ? `<button class="btn block" style="margin-top:10px" data-go="#/set/${esc(set.id)}/cards">Browse my ${set.cards.length} card${set.cards.length === 1 ? '' : 's'}</button>` : '<p class="small muted" style="margin:10px 2px 0">No cards yet. Tap “Add a card” for each card you own — pick a photo from your camera or gallery.</p>'}`
      : `<button class="btn primary block" style="margin-top:14px" data-go="#/set/${esc(set.id)}/cards">Browse cards</button>`}
    </div>
    ${set.cards.filter(c => c.featured).map(c => { const vers = versionsFor(set, c); const n = vers.filter(v => own(set.id, c.id, v.id)).length; return `<div class="card set-item feat" data-go="#/set/${esc(set.id)}/card/${esc(c.id)}"><div class="thumb" style="width:56px;flex:none">${imgTag(set, c, null)}</div><div class="grow"><div class="small muted">★ Featured · #${esc(c.number)}</div><b>${esc(c.player)}</b>${progressRow('Rainbow', n, vers.length)}</div></div>`; }).join('')}
    <div class="section-title">Completion</div>
    <div class="card">
      ${progressRow('Overall (every card × every parallel)', st.owned, st.combos)}
      ${progressRow('Cards owned in any version', st.anyCards, set.cards.length)}
      ${st.base.t ? progressRow(esc(set.baseName) + ' set', st.base.o, st.base.t, '', `filter:${BASE_ID}:${set.baseName}`) : ''}
      ${subs.filter(([, b]) => b.t).map(([n, b]) => progressRow(esc(n) + ' <span class="badge">insert</span>', b.o, b.t, '', `filter:${BASE_ID}:${n}`)).join('')}
    </div>
    ${set.parallels.length ? `<div class="section-title">Parallels</div><div class="card">
      ${set.parallels.map(p => progressRow(`${esc(p.name)} <span class="muted small">${fmtRun(p.printRun)}</span>${p.appliesTo?.length ? ` <span class="small muted">· ${esc(p.appliesTo.join(', '))}</span>` : ''}`, st.par[p.id].o, st.par[p.id].t, p.color, `filter:${p.id}:`)).join('')}
    </div>` : ''}
    <div class="section-title">Manage</div>
    <div class="card">
      <div class="btn-row"><button class="btn" data-action="add-card">+ Card</button>${set.chase ? '' : '<button class="btn" data-action="parallels">Parallels</button>'}</div>
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-action="edit-set">Edit set</button><button class="btn" data-action="export-set">Export checklist</button></div>
      <button class="btn danger block" style="margin-top:10px" data-action="delete-set">Delete set</button>
      ${set.notes ? `<p class="small muted">${esc(set.notes)}</p>` : ''}
      ${set.sources?.length ? `<details class="small muted"><summary style="min-height:40px;cursor:pointer">Sources</summary>${set.sources.map(u => `<div class="ellipsis"><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, ''))}</a></div>`).join('')}</details>` : ''}
    </div>`;
}

function getFilter(set) { return filters[set.id] ??= { q: '', status: 'all', par: 'any', team: '', subset: '', rc: false, sort: 'num', mbp: false }; }
function tilePrice(set, c, parV) {
  if (parV) return sortPrice(set, c, parV.id);
  const vers = versionsFor(set, c); const b = vers.find(v => v.id === BASE_ID);
  const bp = b ? sortPrice(set, c, BASE_ID) : null; if (bp != null) return bp;
  const ps = vers.map(v => sortPrice(set, c, v.id)).filter(x => x != null); return ps.length ? { from: Math.min(...ps) } : null;
}
const tpVal = t => t == null ? null : typeof t === 'object' ? t.from : t;
function renderGrid(set) {
  setTitle(set.name);
  const f = getFilter(set);
  const teams = [...new Set(set.cards.map(c => c.team).filter(Boolean))].sort(natCmp);
  const subs = subsets(set);
  const series = [...new Set(set.cards.map(c => c.series).filter(Boolean))].sort(natCmp);
  view.innerHTML = `
    <div class="searchbar">
      <input class="input" id="q" type="search" placeholder="Search player, team, number…" value="${esc(f.q)}" autocomplete="off">
      <div class="chips">
        ${['all', 'owned', 'missing'].map(s => `<button class="chip ${f.status === s ? 'on' : ''}" data-status="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
        <select class="chip ${f.par !== 'any' ? 'on' : ''}" id="fPar" aria-label="Parallel">
          <option value="any">Any version</option>${set.cards.some(c => !c.noBase) ? `<option value="${BASE_ID}" ${f.par === BASE_ID ? 'selected' : ''}>${esc(baseVersion(set).name)}</option>` : ''}
          ${set.parallels.map(p => `<option value="${esc(p.id)}" ${f.par === p.id ? 'selected' : ''}>${esc(p.name)} ${fmtRun(p.printRun)}</option>`).join('')}</select>
        ${subs.length > 1 ? `<select class="chip ${f.subset ? 'on' : ''}" id="fSub" aria-label="Subset"><option value="">All subsets</option>${subs.map(s => `<option ${f.subset === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}
        ${series.length > 1 ? `<select class="chip ${f.series ? 'on' : ''}" id="fSer" aria-label="Series"><option value="">All series</option>${series.map(t => `<option ${f.series === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
        ${teams.length ? `<select class="chip ${f.team ? 'on' : ''}" id="fTeam" aria-label="Team"><option value="">All teams</option>${teams.map(t => `<option ${f.team === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
        ${set.cards.some(isHit) ? `<button class="chip ${f.nohits ? 'on' : ''}" data-nohits>Hide autos/relics</button>` : ''}
        ${set.cards.some(c => c.featured) ? `<button class="chip ${f.feat ? 'on' : ''}" data-feat>★ Featured</button>` : ''}
        ${set.cards.some(c => c.rookie) ? `<button class="chip ${f.rc ? 'on' : ''}" data-rc>RC</button>` : ''}
        <select class="chip ${f.sort !== 'num' ? 'on' : ''}" id="fSort" aria-label="Sort"><option value="num">Sort: card #</option><option value="price-desc" ${f.sort === 'price-desc' ? 'selected' : ''}>Price: high → low</option><option value="price-asc" ${f.sort === 'price-asc' ? 'selected' : ''}>Price: low → high</option></select>
        <button class="chip ${f.mbp ? 'on' : ''}" data-mbp>💲 Missing, by price</button>
      </div>
    </div>
    <div id="gridArea"></div>
    <button class="fab" data-action="add-card">＋ Card</button>`;
  drawGrid(set);
  const q = $('#q'); let t;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { f.q = q.value; drawGrid(set); }, 120); });
  $('#fPar').addEventListener('change', e => { f.par = e.target.value; renderGrid(set); });
  $('#fSub')?.addEventListener('change', e => { f.subset = e.target.value; renderGrid(set); });
  $('#fTeam')?.addEventListener('change', e => { f.team = e.target.value; renderGrid(set); });
  $('#fSer')?.addEventListener('change', e => { f.series = e.target.value; renderGrid(set); });
  $('#fSort').addEventListener('change', e => { f.sort = e.target.value; drawGrid(set); });
}
function drawGrid(set) {
  const f = getFilter(set); const q = f.q.trim().toLowerCase();
  const parV = f.par === 'any' ? null : (f.par === BASE_ID ? baseVersion(set) : set.parallels.find(p => p.id === f.par));
  let cards = set.cards.filter(c => {
    if (f.subset && c.subset !== f.subset) return false;
    if (f.team && c.team !== f.team) return false;
    if (f.series && c.series !== f.series) return false;
    if (f.rc && !c.rookie) return false;
    if (f.feat && !c.featured) return false;
    if (f.nohits && isHit(c)) return false;
    if (q && !`${c.number} #${c.number} ${c.player} ${c.team} ${c.subset}`.toLowerCase().includes(q)) return false;
    const vers = versionsFor(set, c);
    if (parV && !vers.some(v => v.id === parV.id)) return false;
    const has = parV ? !!own(set.id, c.id, parV.id) : vers.some(v => own(set.id, c.id, v.id));
    if (f.status === 'owned' && !has) return false;
    if (f.status === 'missing' && has) return false;
    return true;
  });
  if (f.mbp) return drawMissingByPrice(set, cards, parV);
  if (f.sort !== 'num') { const dir = f.sort === 'price-asc' ? 1 : -1; cards = cards.map(c => [c, tpVal(tilePrice(set, c, parV))]).sort((a, b) => a[1] == null ? (b[1] == null ? 0 : 1) : b[1] == null ? -1 : (a[1] - b[1]) * dir).map(x => x[0]); }
  const owned = cards.filter(c => parV ? own(set.id, c.id, parV.id) : ownedCount(set, c)).length;
  $('#gridArea').innerHTML = `<div class="small muted" style="margin:2px 2px 10px">${cards.length} cards${parV ? ` · ${esc(parV.name)} ${fmtRun(parV.printRun)}` : ''} · ${owned} owned</div>` +
    (cards.length ? `<div class="grid">${cards.map(c => {
      const vers = versionsFor(set, c);
      const n = vers.filter(v => own(set.id, c.id, v.id)).length;
      const has = parV ? !!own(set.id, c.id, parV.id) : n > 0;
      const pk = [parV?.id, BASE_ID, ...vers.map(v => v.id)].filter(Boolean).map(id => pkey(set.id, c.id, id)).find(k => photoKeys.has(k));
      return `<button class="tile ${has ? '' : 'missing'}" data-go="#/set/${esc(set.id)}/card/${esc(c.id)}">
        <div class="thumb">${imgTag(set, c, parV, { pk, alt: c.player })}
          ${parV ? (has ? '<span class="own">✓</span>' : '') : (n ? `<span class="own">${n}/${vers.length}</span>` : '')}
          ${!parV && vers.length > 1 ? `<div class="dots">${vers.filter(v => own(set.id, c.id, v.id)).slice(0, 12).map(v => `<i style="background:${esc(v.color || '#fff')}"></i>`).join('')}</div>` : ''}
        </div>
        ${(() => { const tp = tilePrice(set, c, parV); return tp == null ? '' : `<span class="tile-price">${typeof tp === 'object' ? 'from ' + money(tp.from) : money(tp)}</span>`; })()}
        <div class="cap"><b class="ellipsis">${c.featured ? '★ ' : ''}${esc(c.player || '—')}</b><span class="muted ellipsis" style="display:block">${c.year || c.product ? esc(cardLine(set, c)) + ' · ' : ''}#${esc(c.number)}${c.subset !== set.baseName ? ' · ' + esc(c.subset) : ''}${c.rookie ? ' · RC' : ''}</span></div>
      </button>`; }).join('')}</div>` : `<div class="empty">No cards match.</div>`);
  hydratePhotos($('#gridArea'));
}

function drawMissingByPrice(set, cards, parV) {
  // every version you still need (in the current filters), cheapest first — for shopping
  const rows = [];
  for (const c of cards) for (const v of versionsFor(set, c)) {
    if (parV && v.id !== parV.id) continue; if (own(set.id, c.id, v.id)) continue;
    rows.push({ c, v, p: sortPrice(set, c, v.id) });
  }
  const f = getFilter(set); const dir = f.sort === 'price-desc' ? -1 : 1;
  rows.sort((a, b) => a.p == null ? (b.p == null ? 0 : 1) : b.p == null ? -1 : (a.p - b.p) * dir);
  const priced = rows.filter(r => r.p != null).length; const LIM = 300;
  $('#gridArea').innerHTML = `<div class="small muted" style="margin:2px 2px 10px">${rows.length} missing versions · ${priced} priced · ${dir === 1 ? 'cheapest' : 'priciest'} first${rows.length > LIM ? ` (showing ${LIM})` : ''}</div>
    <div class="card">${rows.slice(0, LIM).map(({ c, v }) => `<div class="mbp">
      <div class="mbp-main" data-go="#/set/${esc(set.id)}/card/${esc(c.id)}">
        <div class="thumb" style="width:44px;flex:none">${imgTag(set, c, v, { alt: c.player })}</div>
        <div class="grow" style="min-width:0"><b class="ellipsis" style="display:block">${esc(c.player || '—')} <span class="muted small">#${esc(c.number)}</span></b>
          <div class="small muted ellipsis">${esc(v.name)} ${fmtRun(v.printRun)}${c.subset !== set.baseName ? ' · ' + esc(c.subset) : ''}</div>${priceLine(set, c, v) || '<div class="small muted">no price yet</div>'}</div></div>
      ${buyLinks(set, c, v)}</div>`).join('') || '<div class="empty">Nothing missing here 🎉</div>'}</div>`;
  hydratePhotos($('#gridArea'));
}

const detailState = { hero: 'ref', open: {}, vf: 'all', vs: 'default' };
function renderDetail(set, card) {
  setTitle(`#${card.number} ${card.player}`);
  const vers = versionsFor(set, card);
  if (detailState.card !== card.id) { detailState.card = card.id; detailState.open = {}; detailState.hero = 'ref'; detailState.vf = 'all';
    const pk0 = thumbPk(set, card); if (pk0) detailState.hero = 'p:' + pk0.split('|')[2]; }
  // hero: 'ref' (default image), 'p:<vid>' (my photo), 'r:<vid>' (reference image of a parallel)
  const h = detailState.hero; const hv = vers.find(v => v.id === h.slice(2));
  let hero;
  if (h.startsWith('p:') && hv && photoKeys.has(pkey(set.id, card.id, hv.id))) hero = `<img alt="My photo" data-pk="${esc(pkey(set.id, card.id, hv.id))}" src="${artURL(set, card, hv)}">`;
  else if (h.startsWith('r:') && hv) hero = imgTag(set, card, hv, { alt: hv.name });
  else hero = imgTag(set, card, null, { alt: card.player });
  const heroLabel = h.startsWith('p:') && hv ? `My photo · ${hv.name}` : h.startsWith('r:') && hv ? `Reference · ${hv.name} ${fmtRun(hv.printRun)}` : 'Reference image';
  const n = vers.filter(v => own(set.id, card.id, v.id)).length;
  const vf = detailState.vf;
  const shown = vers.filter(v => vf === 'all' || (vf === 'owned') === !!own(set.id, card.id, v.id));
  if (detailState.vs !== 'default') { const dir = detailState.vs === 'price-asc' ? 1 : -1; shown.sort((a, b) => { const pa = sortPrice(set, card, a.id), pb = sortPrice(set, card, b.id); return pa == null ? (pb == null ? 0 : 1) : pb == null ? -1 : (pa - pb) * dir; }); }
  view.innerHTML = `
    <div class="card">
      <div class="detail-hero">
        <div style="width:44%;max-width:240px;flex:none">
          <div class="thumb" style="width:100%">${hero}</div>
          <div class="small muted" style="margin-top:6px;text-align:center">${esc(heroLabel)}</div>
          ${h !== 'ref' ? `<button class="link" style="width:100%" data-hero="ref">Show default image</button>` : ''}
        </div>
        <div class="grow">
          ${card.year || card.product ? `<div class="small muted">${esc(cardLine(set, card))}</div>` : ''}<div class="small muted">#${esc(card.number)} · ${esc(card.subset)}</div>
          <h2 style="margin:2px 0 4px;font-size:21px;line-height:1.15">${card.featured ? '★ ' : ''}${esc(card.player || '—')}</h2>
          ${card.players ? `<div class="small muted">${esc(card.players)}</div>` : ''}
          <div class="muted small">${esc(card.team)}</div>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${card.rookie ? '<span class="badge rc">RC</span>' : ''}${card.featured ? '<span class="badge example">FEATURED</span>' : ''}${set.example ? '<span class="badge example">EXAMPLE</span>' : ''}</div>
          <div style="margin-top:12px"><b style="font-size:28px">${n}</b><span class="muted"> / ${vers.length} versions</span></div>
          <div class="bar" style="margin-top:6px"><i style="width:${pct(n, vers.length)}%"></i></div>
          <div class="small muted" style="margin-top:8px">${esc(set.year)} ${esc(set.name)}</div>
          ${(() => { const bp = vers.length ? priceOf(set, card, vers[0].id) : null; const mv = valueOf([{ ...set, cards: [card] }]);
            return `<div class="price-box"><div><span class="muted small">Raw ${esc(vers[0]?.name || '')}:</span> <b>${bp ? money(bp.v) : '—'}</b>${bp?.mine ? ' <span class="badge">my price</span>' : ''}</div>
              ${mv.priced ? `<div><span class="muted small">My copies:</span> <b>${money(mv.v)}</b></div>` : ''}
              <div class="small muted">${bp && !bp.mine ? `as of ${esc(bp.date)} · <a href="${esc(bp.url)}" target="_blank" rel="noopener">SportsCardsPro ↗</a>` : `<a href="${esc(lookupURL(set, card, null))}" target="_blank" rel="noopener">Look up price ↗</a>`}</div></div>`; })()}
        </div>
      </div>
      ${card.notes ? `<details class="small" style="margin:12px 0 0;padding:4px 10px;border-radius:10px;background:var(--surface2)"><summary style="min-height:36px;display:flex;align-items:center;cursor:pointer">⚠️ Checklist notes</summary><p style="margin:4px 0 8px">${esc(card.notes)}</p></details>` : ''}
    </div>
    <div class="section-title row"><span class="grow">${set.chase ? 'My copy' : 'Versions &amp; parallels'}</span></div>
    <div class="chips" style="margin-bottom:8px;${set.chase ? 'display:none' : ''}">${['all', 'owned', 'missing'].map(x => `<button class="chip ${vf === x ? 'on' : ''}" data-vf="${x}">${x === 'all' ? `All ${vers.length}` : x === 'owned' ? `Owned ${n}` : `Missing ${vers.length - n}`}</button>`).join('')}
      <select class="chip ${detailState.vs !== 'default' ? 'on' : ''}" id="vSort" aria-label="Sort versions"><option value="default">Checklist order</option><option value="price-desc" ${detailState.vs === 'price-desc' ? 'selected' : ''}>Price: high → low</option><option value="price-asc" ${detailState.vs === 'price-asc' ? 'selected' : ''}>Price: low → high</option></select></div>
    ${PRICES?.updated ? `<p class="small muted" style="margin:-2px 4px 8px">Raw = ungraded sold price from <a href="https://www.sportscardspro.com" target="_blank" rel="noopener">SportsCardsPro</a>, as of ${esc(PRICES.updated)}.${PRICES.l ? ` “Listed” = cheapest Buy-It-Now found in a weekly snapshot (${esc(shortDay(PRICES.listedAt || PRICES.updated))}), before shipping — may be gone or changed.` : ''}</p>` : ''}
    <div class="card">${shown.length ? shown.map(v => {
      const o = own(set.id, card.id, v.id); const k = pkey(set.id, card.id, v.id); const hasPhoto = photoKeys.has(k);
      const ref = verImage(card, v.id); const open = detailState.open[v.id];
      return `<div class="pv" data-ver="${esc(v.id)}">
        <div class="pv-head">
          ${hasPhoto ? `<img class="pv-mini" data-pk="${esc(k)}" data-hero="p:${esc(v.id)}" alt="">` : ref ? `<img class="pv-mini" loading="lazy" src="${esc(ref)}" data-hero="r:${esc(v.id)}" alt="">` : `<span class="swatch" style="background:${esc(v.color || 'var(--surface)')}"></span>`}
          <div class="grow" style="min-width:0"><b>${esc(v.name)}</b> <span class="muted small">${fmtRun(v.printRun)}</span>${(() => { const p = priceOf(set, card, v.id); return p ? ` <span class="price-tag ${p.mine ? 'mine' : ''}">${money(p.v)}</span>` : ''; })()}
            ${priceLine(set, card, v)}
            ${o ? `<div class="small muted ellipsis">${[o.serial ? '#' + o.serial : '', o.cond, o.note].filter(Boolean).map(esc).join(' · ') || (hasPhoto ? '📷 photo' : '')}</div>` : ''}</div>
          ${o ? `<div class="stepper"><button data-qty="-1" aria-label="Less">−</button><span>${o.q || 1}</span><button data-qty="1" aria-label="More">+</button></div>` : ''}
          <button class="toggle ${o ? 'on' : ''}" data-toggle>${o ? 'Owned ✓' : 'Missing'}</button>
        </div>
        <div class="row" style="gap:8px;align-items:center"><button class="link grow" style="text-align:left" data-open>${open ? 'Hide details' : (o ? 'Details, price & photo' : 'Price, photo & details')}</button>${buyLinks(set, card, v)}</div>
        ${open ? `<div class="pv-extra">
          <label class="field" style="margin:0">Condition<select class="input" data-field="cond">${CONDITIONS.map(c => `<option ${o?.cond === c ? 'selected' : ''} value="${c}">${c || '—'}</option>`).join('')}</select></label>
          <label class="field" style="margin:0">Note (grade, serial #, where bought…)<input class="input" data-field="note" value="${esc(o?.note || '')}" placeholder="e.g. PSA 9, #23/50"></label>
          ${(() => { const pp = pubPrice(set.id, card.id, v.id); const mp = myPrice(set.id, card.id, v.id);
            return `<label class="field" style="margin:0">My price ($) <span class="small muted" style="font-weight:400">— overrides the weekly price; leave blank to use it</span>
              <input class="input" data-myprice inputmode="decimal" value="${mp != null ? esc(mp) : ''}" placeholder="${pp ? esc(pp.v.toFixed(2)) : 'e.g. 12.50'}"></label>
              <div class="small muted">${pp ? `Raw (ungraded) ${money(pp.v)} as of ${esc(pp.date)} · <a href="${esc(pp.url)}" target="_blank" rel="noopener">SportsCardsPro ↗</a>` : `No published price · <a href="${esc(lookupURL(set, card, v))}" target="_blank" rel="noopener">Look up price ↗</a>`}</div>
              ${(() => { const l = listedOf(set.id, card.id, v.id); return l ? `<div class="small muted">Lowest listed: <b>${money(l.v)}</b> + shipping on <a href="${esc(l.url)}" target="_blank" rel="noopener">${SITE[l.site] || l.site} ↗</a> (checked ${esc(shortDay(l.t))} — snapshot, may be outdated)</div>` : ''; })()}
              <div class="small muted">Shop: <a href="${esc(ebayURL(set, card, v))}" target="_blank" rel="noopener">eBay Buy It Now (lowest + shipping)</a> · <a href="${esc(ebayURL(set, card, v, 'auction'))}" target="_blank" rel="noopener">eBay auctions</a> · <a href="${esc(ebayURL(set, card, v, 'sold'))}" target="_blank" rel="noopener">eBay sold</a> · <a href="${esc(whatnotURL(set, card, v))}" target="_blank" rel="noopener">Whatnot</a></div>`; })()}
          <div class="row">${hasPhoto ? `<img class="pv-photo" data-pk="${esc(k)}" alt="">` : ''}
            <div class="grow btn-row"><button class="btn" data-photo>📷 ${hasPhoto ? 'Replace' : 'Add'} photo</button>${hasPhoto ? '<button class="btn danger" data-delphoto>Remove</button>' : ''}</div></div>
        </div>` : ''}
      </div>`; }).join('') : '<div class="empty">Nothing here.</div>'}</div>
    ${card.ref ? `<p class="small muted" style="margin:4px 4px 12px">Reference photos via <a href="${esc(card.ref)}" target="_blank" rel="noopener">SportsCardsPro</a>. Tap a thumbnail to view it large.</p>` : ''}
    <div class="btn-row"><button class="btn" data-action="edit-card">Edit card</button><button class="btn danger" data-action="delete-card">Delete card</button></div>`;
  hydratePhotos();
  $('#vSort')?.addEventListener('change', e => { detailState.vs = e.target.value; renderDetail(set, card); });
  view.querySelectorAll('[data-myprice]').forEach(inp => inp.addEventListener('change', e => {
    const vid = e.target.closest('[data-ver]').dataset.ver; const raw = e.target.value.replace(/[$,\s]/g, '');
    const v = raw === '' ? null : Math.round(parseFloat(raw) * 100) / 100;
    if (raw !== '' && (isNaN(v) || v < 0)) { toast('Enter a number, e.g. 12.50'); return; }
    setMyPrice(set.id, card.id, vid, v); renderDetail(set, card); toast(v == null ? 'Using the weekly price' : 'Your price saved');
  }));
  view.querySelectorAll('[data-field]').forEach(inp => inp.addEventListener('change', e => {
    const vid = e.target.closest('[data-ver]').dataset.ver;
    const val = e.target.value.trim();
    if (!own(set.id, card.id, vid) && !val) return;
    setOwn(set.id, card.id, vid, { [e.target.dataset.field]: val }); renderDetail(set, card);
  }));
}

/* ---------------- forms ---------------- */
function setForm(s) {
  s = s || {}; // openSetEditor(null) passes null — a default param doesn't cover null (this broke 'Create manually')
  return `<label class="field">Set name<input class="input" name="name" required value="${esc(s.name || '')}" placeholder="e.g. Chrome"></label>
    <div class="two"><label class="field">Year<input class="input" name="year" inputmode="numeric" value="${esc(s.year || '')}" placeholder="2026"></label>
    <label class="field">Brand<input class="input" name="brand" value="${esc(s.brand || '')}" placeholder="Topps, Panini…"></label></div>
    <div class="two"><label class="field">Sport<input class="input" name="sport" value="${esc(s.sport || '')}" placeholder="Baseball"></label>
    <label class="field">Base name<input class="input" name="baseName" value="${esc(s.baseName || 'Base')}"></label></div>`;
}
const PAR_HELP = `<span class="small muted" style="font-weight:400">One per line: <code>Name /run #color [Subset|Subset]</code> — run, color and subsets optional. No subsets = applies to every card.</span>`;
const formData = el => Object.fromEntries(new FormData(el).entries());

function openSetEditor(existing) {
  openSheet(`<h2>${existing ? 'Edit set' : 'Create set'}</h2><form id="f">${setForm(existing)}
    <label class="field">Parallels ${PAR_HELP}<textarea class="input" name="parallels" rows="6" placeholder="Refractor&#10;Gold /50&#10;Red /5&#10;Superfractor 1/1">${esc((existing?.parallels || []).map(parallelToLine).join('\n'))}</textarea></label>
    <button class="btn primary block">${existing ? 'Save' : 'Create set'}</button></form>`, el => {
    $('#f', el).addEventListener('submit', e => {
      e.preventDefault(); const d = formData(e.target);
      const raw = { ...(existing || {}), ...d, parallels: d.parallels.split('\n').map(parseParallelLine).filter(Boolean), cards: existing?.cards || [] };
      if (existing) {
        // keep stable parallel ids when names match
        raw.parallels = raw.parallels.map(p => { const m = existing.parallels.find(x => x.name.toLowerCase() === p.name.toLowerCase() && (x.printRun || null) === (p.printRun || null)); return m ? { ...p, id: m.id, color: p.color || m.color } : p; });
        raw.id = existing.id; const ns = normalizeSet(raw); ns.example = existing.example;
        sets[sets.indexOf(existing)] = ns;
      } else { raw.id = uniqueSetId(normalizeSet(raw).id); sets.push(normalizeSet(raw)); }
      saveSets(); closeSheet(); location.hash = `#/set/${raw.id}`; render(); toast('Saved');
    });
  });
}
const uniqueSetId = id => { let i = id, n = 2; while (getSet(i)) i = `${id}-${n++}`; return i; };

function openCardEditor(set, card) {
  const subs = subsets(set);
  openSheet(`<h2>${card ? 'Edit card' : 'Add card'}</h2><form id="f">
    <div class="two"><label class="field">Card #<input class="input" name="number" required value="${esc(card?.number || '')}"></label>
    <label class="field">Subset / insert<input class="input" name="subset" list="subs" value="${esc(card?.subset || set.baseName)}"></label></div>
    <datalist id="subs">${subs.map(s => `<option>${esc(s)}</option>`).join('')}</datalist>
    <label class="field">Player<input class="input" name="player" value="${esc(card?.player || '')}"></label>
    <label class="field">Team<input class="input" name="team" list="teams" value="${esc(card?.team || '')}"></label>
    <datalist id="teams">${[...new Set(set.cards.map(c => c.team).filter(Boolean))].map(t => `<option>${esc(t)}</option>`).join('')}</datalist>
    <label class="field">Reference image URL<input class="input" name="image" type="url" inputmode="url" value="${esc(card?.image || '')}" placeholder="https://…"></label>
    <label class="row" style="min-height:48px;font-weight:600"><input type="checkbox" name="rookie" ${card?.rookie ? 'checked' : ''} style="width:22px;height:22px"> Rookie card (RC)</label>
    <button class="btn primary block">${card ? 'Save' : 'Add card'}</button></form>`, el => {
    $('#f', el).addEventListener('submit', e => {
      e.preventDefault(); const d = formData(e.target);
      const c = { number: d.number.trim(), player: d.player.trim(), team: d.team.trim(), subset: d.subset.trim() || set.baseName, image: d.image.trim(), rookie: !!d.rookie };
      if (card) Object.assign(card, c);
      else {
        let id = slug(`${c.subset === set.baseName ? '' : c.subset + '-'}${c.number || c.player}`); while (set.cards.some(x => x.id === id)) id += '-2';
        set.cards.push({ id, ...c }); set.cards.sort((a, b) => natCmp(a.subset === set.baseName ? '' : a.subset, b.subset === set.baseName ? '' : b.subset) || natCmp(a.number, b.number));
      }
      saveSets(); closeSheet(); render(); toast(card ? 'Card saved' : 'Card added');
    });
  });
}

function openParallels(set) {
  const subs = subsets(set);
  openSheet(`<h2>Parallels</h2>
    <div>${set.parallels.length ? set.parallels.map(p => `<div class="par-row"><span class="swatch" style="background:${esc(p.color)}"></span>
      <div class="grow"><b>${esc(p.name)}</b> <span class="muted small">${fmtRun(p.printRun)}</span><div class="small muted">${p.appliesTo?.length ? esc(p.appliesTo.join(', ')) : 'All cards'}</div></div>
      <button class="btn danger" data-delpar="${esc(p.id)}">Delete</button></div>`).join('') : '<p class="muted">No parallels yet.</p>'}</div>
    <div class="section-title">Add a parallel</div>
    <form id="f"><label class="field">Name<input class="input" name="name" required placeholder="e.g. Gold Refractor"></label>
      <div class="two"><label class="field">Print run (blank = unnumbered)<input class="input" name="printRun" inputmode="numeric" placeholder="50"></label>
      <label class="field">Color<input class="input" name="color" type="color" value="#d4a017" style="padding:4px"></label></div>
      ${subs.length > 1 ? `<div class="field">Applies to <span class="small muted" style="font-weight:400">(none checked = all cards)</span>${subs.map(s => `<label class="row" style="min-height:40px;color:var(--text)"><input type="checkbox" name="ap" value="${esc(s)}" style="width:20px;height:20px"> ${esc(s)}</label>`).join('')}</div>` : ''}
      <button class="btn primary block">Add parallel</button></form>
    <p class="small muted">Tip: “Edit set” lets you edit all parallels at once as text.</p>`, el => {
    $('#f', el).addEventListener('submit', e => {
      e.preventDefault(); const fd = new FormData(e.target);
      const name = fd.get('name').trim(); const printRun = parseInt(fd.get('printRun'), 10) || null;
      let id = slug(`${name}${printRun ? '-' + printRun : ''}`); while (id === BASE_ID || set.parallels.some(p => p.id === id)) id += '-2';
      set.parallels.push({ id, name, printRun, color: fd.get('color'), appliesTo: fd.getAll('ap') });
      saveSets(); render(); openParallels(set); toast('Parallel added');
    });
    el.querySelectorAll('[data-delpar]').forEach(b => b.addEventListener('click', () => {
      const p = set.parallels.find(x => x.id === b.dataset.delpar);
      if (!confirm(`Delete parallel “${p.name}”? Ownership records for it will be removed.`)) return;
      set.parallels = set.parallels.filter(x => x !== p);
      for (const cid in coll[set.id] || {}) { delete coll[set.id][cid][p.id]; }
      saveSets(); saveColl(); render(); openParallels(set);
    }));
  });
}

/* ---------------- chase sets: add only the cards you own ---------------- */
const CHASES = [
  { id: 'chase-vj-edgecomb', name: 'VJ Edgecombe Chase', chasePlayer: 'VJ Edgecombe', preload: () => vjPreload(), owned: ['2025-26-topps-chrome-253'] },
  { id: 'chase-tyrese-maxey', name: 'Tyrese Maxey Chase', chasePlayer: 'Tyrese Maxey' }
];
// Adds missing chase sets once. Never touches existing sets, ownership or photos; a chase set the user deleted is not re-added.
// The one card the user owns (verified on Checklist Insider's 2025-26 Topps Chrome Basketball checklist: #253 VJ Edgecombe RC).
function vjPreload() {
  return { parallels: [], cards: [{ id: '2025-26-topps-chrome-253', number: '253', player: 'VJ Edgecombe', team: 'Philadelphia 76ers', subset: 'Base', rookie: true, year: '2025-26', product: 'Topps Chrome',
    image: 'img/chase/vj-253.jpg', ref: 'https://www.sportscardspro.com/game/basketball-cards-2025-topps-chrome/vj-edgecombe-253',
    notes: '2025-26 Topps Chrome Basketball #253 VJ Edgecombe RC (base set, Rookies) — verified on Checklist Insider and Topps Ripped checklists. Reference photo via SportsCardsPro (listing photo).' }] };
}
function ensureChases() {
  prefs.chasesAdded ??= []; let changed = false;
  for (const c of CHASES) {
    if (getSet(c.id)) { if (!prefs.chasesAdded.includes(c.id)) prefs.chasesAdded.push(c.id); continue; }
    if (prefs.chasesAdded.includes(c.id)) continue;
    const pre = c.preload ? c.preload() : { parallels: [], cards: [] };
    const ns = normalizeSet({ ...c, chase: true, sport: 'Basketball', team: 'Philadelphia 76ers', brand: '', year: '', baseName: 'Base', ...pre,
      notes: `Your own ${c.chasePlayer} cards. Add each card you own (any year/product) with a photo.` });
    sets.push(ns);
    for (const card of c.owned || []) if (!own(ns.id, card, BASE_ID)) setOwn(ns.id, card, BASE_ID, { q: 1 });
    prefs.chasesAdded.push(c.id); changed = true;
  }
  if (changed) saveSets(); savePrefs();
}
function openChaseCardForm(set, from) {
  const prods = [...new Set(set.cards.map(c => c.product).filter(Boolean))];
  const subs = [...new Set(set.cards.map(c => c.subset).filter(Boolean))];
  openSheet(`<h2>Add a card <span class="muted small" style="font-weight:600">· ${esc(set.chasePlayer || set.name)}</span></h2><form id="f" autocomplete="off">
    <label class="photo-pick" id="pp"><input type="file" name="photo" accept="image/*"><span id="ppTxt">📷 Photo — take or choose from gallery</span><img id="ppImg" alt="" hidden></label>
    <div class="two"><label class="field">Year<input class="input" name="year" value="${esc(from?.year || '')}" placeholder="2025-26"></label>
    <label class="field">Card #<input class="input" name="number" value="${esc(from?.number || '')}" placeholder="e.g. 123"></label></div>
    <label class="field">Brand / product<input class="input" name="product" list="prods" value="${esc(from?.product || '')}" placeholder="e.g. Topps Chrome"></label>
    <datalist id="prods">${prods.map(x => `<option>${esc(x)}</option>`).join('')}</datalist>
    <label class="field">Subset / insert <span class="small muted" style="font-weight:400">(blank = Base)</span><input class="input" name="subset" list="csubs" value="${esc(from && from.subset !== set.baseName ? from.subset : '')}" placeholder="Base"></label>
    <datalist id="csubs">${subs.map(x => `<option>${esc(x)}</option>`).join('')}</datalist>
    <label class="field">Player<input class="input" name="player" value="${esc(from?.player || set.chasePlayer || '')}"></label>
    <label class="field">Note <span class="small muted" style="font-weight:400">(optional — grade, where you got it…)</span><input class="input" name="note" placeholder="e.g. PSA 10, pulled from a blaster"></label>
    <label class="row" style="min-height:48px;font-weight:600"><input type="checkbox" name="rookie" ${from?.rookie ? 'checked' : ''} style="width:22px;height:22px"> Rookie card (RC)</label>
    <button class="btn primary block big-add">Save as owned ✓</button></form>`, el => {
    const fi = $('input[type=file]', el), img = $('#ppImg', el);
    fi.addEventListener('change', () => { const f = fi.files[0]; if (!f) return; img.src = URL.createObjectURL(f); img.hidden = false; $('#ppTxt', el).textContent = '📷 Change photo'; });
    $('#f', el).addEventListener('submit', async e => {
      e.preventDefault(); const fd = new FormData(e.target); const g = k => String(fd.get(k) || '').trim();
      const year = g('year'), product = g('product'), number = g('number').replace(/^#/, ''), subset = g('subset') || set.baseName, player = g('player') || set.chasePlayer || '';
      if (!number && !product && !year) { toast('Add at least the year, product or card #', 3000); return; }
      // find or create the card (same year + product + subset + number); chase sets have no parallels — just the card
      const key = slug(`${year}-${product}-${subset === set.baseName ? '' : subset}-${number || player}`);
      let card = set.cards.find(c => c.id === key);
      if (!card) { card = { id: key, number, player, team: set.team, subset, rookie: !!fd.get('rookie'), image: '', year, product }; set.cards.push(card); }
      else if (fd.get('rookie')) card.rookie = true;
      delete card.noBase; delete card.parallels;
      const vid = BASE_ID; const note = g('note'); const prev = own(set.id, card.id, vid);
      saveSets();
      setOwn(set.id, card.id, vid, { q: prev ? (prev.q || 1) + 1 : 1, ...(note ? { note } : {}) });
      const f = fi.files[0];
      if (f) { try { toast('Saving photo…'); await photoPut(pkey(set.id, card.id, vid), await resizeImage(f)); } catch (err) { toast('Photo failed: ' + err.message, 3000); } }
      closeSheet(); detailState.card = null; location.hash = `#/set/${set.id}/card/${card.id}`; render();
      toast(prev ? 'Already owned — quantity +1' : 'Saved as owned ✓');
    });
  });
}

/* ---------------- import ---------------- */
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^\uFEFF/, '');
  const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
const ALIASES = {
  type: ['type', 'rowtype', 'kind'], number: ['number', 'no', '#', 'card', 'cardnumber', 'card#', 'cardno', 'num'],
  player: ['player', 'playername', 'subject'], team: ['team', 'club', 'teamname'], subset: ['subset', 'insert', 'category', 'section'],
  rookie: ['rookie', 'rc', 'isrookie'], image: ['image', 'imageurl', 'img', 'picture', 'photo', 'imagelink'],
  name: ['name', 'title', 'parallel', 'parallelname', 'setname'], printRun: ['printrun', 'print_run', 'serial', 'numbered', 'run'],
  cardParallels: ['parallels', 'versions'], noBase: ['nobase'], featured: ['featured'],
  color: ['color', 'colour'], appliesTo: ['appliesto', 'applies_to', 'subsets'], year: ['year', 'season'], brand: ['brand', 'manufacturer'], sport: ['sport']
};
function csvToSet(text) {
  const rows = parseCSV(text); if (!rows.length) throw new Error('Empty CSV');
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/[\s_\-]/g, ''));
  const col = {}; for (const k in ALIASES) { const i = head.findIndex(h => ALIASES[k].map(a => a.replace(/_/g, '')).includes(h)); if (i >= 0) col[k] = i; }
  const typed = col.type !== undefined;
  if (!typed && col.player === undefined && col.name !== undefined) { col.player = col.name; delete col.name; }
  if (col.number === undefined && col.player === undefined) throw new Error('CSV needs at least a "number" or "player" column');
  const get = (r, k) => col[k] !== undefined ? (r[col[k]] ?? '').trim() : '';
  const raw = { cards: [], parallels: [] };
  for (const r of rows.slice(1)) {
    const t = typed ? get(r, 'type').toLowerCase() : 'card';
    if (t === 'set') Object.assign(raw, { name: get(r, 'name'), year: get(r, 'year'), brand: get(r, 'brand'), sport: get(r, 'sport') });
    else if (t === 'parallel') raw.parallels.push({ name: get(r, 'name'), printRun: get(r, 'printRun'), color: get(r, 'color'), appliesTo: get(r, 'appliesTo') });
    else { const c = { number: get(r, 'number'), player: get(r, 'player'), team: get(r, 'team'), subset: get(r, 'subset'), rookie: get(r, 'rookie'), image: get(r, 'image'), noBase: get(r, 'noBase'), featured: get(r, 'featured') };
      if (get(r, 'cardParallels')) c.parallels = get(r, 'cardParallels'); raw.cards.push(c); }
  }
  return raw;
}
function parseAny(text) {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    const j = JSON.parse(t);
    if (j.format === 'card-checklist-backup') return { backup: j };
    if (Array.isArray(j)) return { raw: { cards: j, parallels: [] } };
    return { raw: j };
  }
  return { raw: csvToSet(t) };
}
function openImport() {
  openSheet(`<h2>Import checklist</h2>
    <button class="btn primary block" data-file>Choose file (JSON / CSV)</button>
    <div class="section-title">…or paste</div>
    <textarea class="input" id="paste" rows="6" placeholder="Paste JSON or CSV here (spreadsheets: copy cells and paste — tabs work too)"></textarea>
    <button class="btn block" style="margin-top:8px" data-paste>Use pasted text</button>
    <div class="section-title">…or from a link</div>
    <input class="input" id="url" type="url" inputmode="url" placeholder="https://…/checklist.json">
    <button class="btn block" style="margin-top:8px" data-url>Fetch link</button>
    <p class="small muted">The link must allow cross-site downloads (e.g. a raw GitHub/Gist file). See ⋯ → Import format for columns.</p>`, el => {
    $('[data-file]', el).onclick = () => pickFile('.json,.csv,.tsv,.txt,application/json,text/csv', text => handleImportText(text));
    $('[data-paste]', el).onclick = () => handleImportText($('#paste', el).value);
    $('[data-url]', el).onclick = async () => {
      try { const r = await fetch($('#url', el).value); if (!r.ok) throw new Error(r.status); handleImportText(await r.text()); }
      catch (e) { toast('Could not fetch that link: ' + e.message, 3500); }
    };
  });
}
function pickFile(accept, cb) {
  const fi = $('#fileInput'); fi.accept = accept; fi.value = '';
  fi.onchange = async () => { const f = fi.files[0]; if (f) cb(await f.text(), f); };
  fi.click();
}
function handleImportText(text) {
  let parsed; try { parsed = parseAny(text); } catch (e) { toast('Could not read: ' + e.message, 3500); return; }
  if (parsed.backup) return restoreBackup(parsed.backup);
  const raw = parsed.raw; const preview = normalizeSet(raw);
  if (!preview.cards.length) { toast('No cards found in that data', 3000); return; }
  const existing = raw.id || raw.name ? getSet(preview.id) : null;
  openSheet(`<h2>Review import</h2>
    <p class="muted" style="margin-top:0">${preview.cards.length} cards · ${subsets(preview).length} subset(s): ${esc(subsets(preview).join(', '))}</p>
    <form id="f">${setForm(preview)}
    <label class="field">Parallels ${PAR_HELP}<textarea class="input" name="parallels" rows="6">${esc(preview.parallels.map(parallelToLine).join('\n'))}</textarea></label>
    ${existing ? `<label class="row" style="min-height:48px;font-weight:600"><input type="checkbox" name="replace" checked style="width:22px;height:22px"> Update existing “${esc(existing.name)}” (keeps what you own)</label>` : ''}
    <button class="btn primary block">Import ${preview.cards.length} cards</button></form>`, el => {
    $('#f', el).addEventListener('submit', e => {
      e.preventDefault(); const d = formData(e.target);
      const ns = normalizeSet({ ...raw, ...d, id: preview.id, parallels: d.parallels.split('\n').map(parseParallelLine).filter(Boolean) });
      if (existing && d.replace) { ns.parallels = ns.parallels.map(p => { const m = existing.parallels.find(x => x.name.toLowerCase() === p.name.toLowerCase() && (x.printRun || null) === (p.printRun || null)); return m ? { ...p, id: m.id } : p; }); sets[sets.indexOf(existing)] = ns; }
      else { ns.id = uniqueSetId(ns.id); sets.push(ns); }
      saveSets(); closeSheet(); location.hash = `#/set/${ns.id}`; toast(`Imported ${ns.cards.length} cards`);
    });
  });
}

/* ---------------- backup ---------------- */
async function exportBackup(withPhotos) {
  const out = { format: 'card-checklist-backup', version: 1, exportedAt: new Date().toISOString(), sets, collection: coll, myPrices, photos: {} };
  if (withPhotos) for (const k of photoKeys) { const b = await photoGet(k); if (b) out.photos[k] = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); }
  download(`card-checklist-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out));
}
async function restoreBackup(b) {
  if (!confirm(`Restore backup from ${b.exportedAt?.slice(0, 10) || 'file'}? This replaces all sets and ownership on this device (${(b.sets || []).length} sets).`)) return;
  sets = (b.sets || []).map(s => ({ ...normalizeSet(s), example: !!s.example })); coll = b.collection || {}; if (b.myPrices) { myPrices = b.myPrices; saveMyPrices(); } saveSets(); saveColl();
  for (const [k, d] of Object.entries(b.photos || {})) { const blob = await (await fetch(d)).blob(); await photoPut(k, blob); }
  closeSheet(); location.hash = '#/'; render(); toast('Backup restored');
}

/* ---------------- menu ---------------- */
function applyTheme() { if (prefs.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = prefs.theme; }
$('#menuBtn').addEventListener('click', () => {
  openSheet(`<h2>Menu</h2>
    <button class="menu-item" data-m="backup">💾 Backup collection (JSON)</button>
    <button class="menu-item" data-m="backup-photos">🖼️ Backup incl. my photos</button>
    <button class="menu-item" data-m="restore">♻️ Restore backup</button>
    <button class="menu-item" data-m="send-groky">📤 Send my cards to Groky</button>
    <button class="menu-item" data-m="deals">🔥 Deals</button>
    <button class="menu-item" data-m="push">🔔 Deal alerts${prefs.pushSub ? ' (on)' : ''}</button>
    <button class="menu-item" data-m="import">📥 Import checklist</button>
    <button class="menu-item" data-m="offline">📶 Save all card images for offline</button>
    <button class="menu-item" data-m="reload">🔄 Reload bundled Phillies checklists</button>
    <button class="menu-item" data-m="example">🧪 Load example demo set</button>
    <button class="menu-item" data-m="theme">🌓 Theme: ${prefs.theme}</button>
    <button class="menu-item" data-m="format">📄 Import format</button>
    <button class="menu-item" data-m="install">📱 Add to home screen</button>
    <p class="small muted">Everything is stored on this device only. Back up regularly.</p>`, el => {
    el.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
      const m = b.dataset.m;
      if (m === 'backup') exportBackup(false);
      if (m === 'backup-photos') exportBackup(true);
      if (m === 'restore') pickFile('.json,application/json', t => { try { const j = JSON.parse(t); if (j.format !== 'card-checklist-backup') throw new Error('Not a backup file'); restoreBackup(j); } catch (e) { toast(e.message, 3000); } });
      if (m === 'import') openImport();
      if (m === 'send-groky') openSendToGroky();
      if (m === 'deals') { closeSheet(); location.hash = '#/deals'; }
      if (m === 'push') openPush();
      if (m === 'offline') { closeSheet(); cacheAllImages(); }
      if (m === 'reload') { closeSheet(); seedDefault(true).then(render); }
      if (m === 'example') { closeSheet(); seedExample().then(render); }
      if (m === 'theme') { prefs.theme = { auto: 'dark', dark: 'light', light: 'auto' }[prefs.theme]; savePrefs(); applyTheme(); b.textContent = '🌓 Theme: ' + prefs.theme; }
      if (m === 'format') openSheet(FORMAT_HELP);
      if (m === 'install') openSheet(`<h2>Add to home screen</h2><p><b>iPhone (Safari):</b> tap the Share button → “Add to Home Screen”.</p><p><b>Android (Chrome):</b> tap ⋮ → “Install app” / “Add to Home screen”.</p><p class="muted">Once installed it works offline.</p>${deferredInstall ? '<button class="btn primary block" id="inst">Install now</button>' : ''}`, el2 => { const i = $('#inst', el2); if (i) i.onclick = () => deferredInstall.prompt(); });
    }));
  });
});
const FORMAT_HELP = `<h2>Import format</h2>
<p><b>JSON</b> (one set):</p><pre>{
  "name": "Chrome", "year": 2026, "brand": "Topps", "sport": "Baseball",
  "parallels": [
    {"name": "Refractor"},
    {"name": "Gold", "printRun": 50, "color": "#d4a017"},
    {"name": "Red", "printRun": 5, "appliesTo": ["Base"]}
  ],
  "cards": [
    {"number": "1", "player": "Name", "team": "Team", "subset": "Base", "rookie": true, "image": "https://…"},
    {"number": "FP-1", "player": "Name", "team": "Team", "subset": "Future Phenoms"}
  ]
}</pre>
<p><b>CSV — simple</b>: one row per card. Columns: <code>number, player, team, subset, rookie, image</code> (only number or player required). You'll type the set name and parallels on the review screen.</p>
<p><b>CSV — full</b>: add a <code>type</code> column with <code>set</code>, <code>parallel</code> or <code>card</code> rows; extra columns <code>name, print_run, color, applies_to, year, brand, sport</code>. <code>applies_to</code> lists subsets separated by <code>|</code>.</p>
<p class="muted small">Re-importing a set with the same name/year/brand updates the checklist and keeps what you own (cards matched by subset + number).</p>`;
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });

/* ---------------- global click delegation ---------------- */
view.addEventListener('click', async e => {
  const { parts } = route(); const set = parts[0] === 'set' ? getSet(parts[1]) : null;
  const card = set && parts[2] === 'card' ? set.cards.find(c => c.id === parts[3]) : null;
  const ca = e.target.closest('[data-chase-add]');
  if (ca) { const cs = getSet(ca.dataset.chaseAdd); if (cs) openChaseCardForm(cs, ca.dataset.fromCard ? cs.cards.find(c => c.id === ca.dataset.fromCard) : null); return; }
  const go = e.target.closest('[data-go]');
  if (go) {
    const h = go.dataset.go;
    if (h.startsWith('filter:') && set) { const [, par, sub] = h.split(':'); filters[set.id] = { ...getFilter(set), par, subset: sub || '', status: 'all' }; location.hash = `#/set/${set.id}/cards`; }
    else location.hash = h;
    return;
  }
  const st = e.target.closest('[data-status]'); if (st && set) { getFilter(set).status = st.dataset.status; renderGrid(set); return; }
  if (e.target.closest('[data-nohits]') && set) { getFilter(set).nohits = !getFilter(set).nohits; renderGrid(set); return; }
  if (e.target.closest('[data-feat]') && set) { getFilter(set).feat = !getFilter(set).feat; renderGrid(set); return; }
  if (e.target.closest('[data-rc]') && set) { getFilter(set).rc = !getFilter(set).rc; renderGrid(set); return; }
  if (e.target.closest('[data-mbp]') && set) { const f = getFilter(set); f.mbp = !f.mbp; if (f.mbp && f.sort === 'num') f.sort = 'price-asc'; renderGrid(set); return; }
  const hero = e.target.closest('[data-hero]'); if (hero && card) { detailState.hero = hero.dataset.hero; renderDetail(set, card); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const vfb = e.target.closest('[data-vf]'); if (vfb && card) { detailState.vf = vfb.dataset.vf; renderDetail(set, card); return; }
  const ver = e.target.closest('[data-ver]')?.dataset.ver;
  if (ver && card) {
    if (e.target.closest('[data-toggle]')) { setOwn(set.id, card.id, ver, own(set.id, card.id, ver) ? null : { q: 1 }); if (navigator.vibrate) navigator.vibrate(10); renderDetail(set, card); return; }
    const qb = e.target.closest('[data-qty]');
    if (qb) { const o = own(set.id, card.id, ver); const q = (o?.q || 1) + +qb.dataset.qty; setOwn(set.id, card.id, ver, q <= 0 ? null : { q }); renderDetail(set, card); return; }
    if (e.target.closest('[data-open]')) { detailState.open[ver] = !detailState.open[ver]; renderDetail(set, card); return; }
    if (e.target.closest('[data-photo]')) {
      const pi = $('#photoInput'); pi.value = '';
      pi.onchange = async () => { const f = pi.files[0]; if (!f) return; toast('Saving photo…');
        try { const blob = await resizeImage(f); await photoPut(pkey(set.id, card.id, ver), blob); detailState.hero = 'p:' + ver; renderDetail(set, card); toast('Photo saved'); } catch (err) { toast('Photo failed: ' + err.message, 3000); } };
      pi.click(); return;
    }
    if (e.target.closest('[data-delphoto]')) { if (!confirm('Remove this photo?')) return; await photoDel(pkey(set.id, card.id, ver)); if (detailState.hero === 'p:' + ver) detailState.hero = 'ref'; renderDetail(set, card); return; }
  }
  const hd = e.target.closest('[data-hide-deal]');
  if (hd) { const k = hd.dataset.hideDeal; prefs.dealHide ??= {}; if (prefs.dealHide[k]) delete prefs.dealHide[k]; else prefs.dealHide[k] = new Date().toISOString().slice(0, 10); savePrefs(); renderDeals(); toast(prefs.dealHide[k] ? 'Deal hidden' : 'Deal restored'); return; }
  const act = e.target.closest('[data-action]')?.dataset.action; if (!act) return;
  if (act === 'push') openPush();
  if (act === 'import') openImport();
  if (act === 'send-groky') openSendToGroky();
  if (act === 'new-set') openSetEditor(null);
  if (act === 'load-example') { await seedExample(); render(); }
  if (act === 'load-default') { await seedDefault(true); render(); }
  if (act === 'add-card' && set) set.chase ? openChaseCardForm(set, null) : openCardEditor(set, null);
  if (act === 'edit-card' && card) openCardEditor(set, card);
  if (act === 'delete-card' && card && confirm(`Delete card #${card.number} ${card.player} from the checklist?`)) {
    set.cards = set.cards.filter(c => c !== card); if (coll[set.id]) delete coll[set.id][card.id]; saveSets(); saveColl(); location.hash = `#/set/${set.id}/cards`;
  }
  if (act === 'parallels' && set) openParallels(set);
  if (act === 'edit-set' && set) openSetEditor(set);
  if (act === 'export-set' && set) { const { example, ...s } = set; download(`${slug(set.year + '-' + set.brand + '-' + set.name)}.json`, JSON.stringify({ ...s, example }, null, 1)); }
  if (act === 'delete-set' && set && confirm(`Delete “${set.name}” and everything you've tracked in it?`)) {
    sets = sets.filter(s => s !== set); delete coll[set.id]; saveSets(); saveColl();
    for (const k of [...photoKeys]) if (k.startsWith(set.id + '|')) await photoDel(k);
    location.hash = '#/';
  }
});

/* ---------------- boot ---------------- */
// Bundled checklists (data/index.json). New installs get them; newer bundled dataVersion refreshes the
// checklist in place (ownership is kept because card ids are stable).
async function seedDefault(force) {
  try {
    const idx = await (await fetch('data/index.json', { cache: 'no-cache' })).json();
    let changed = 0;
    // sets this phone was already offered (older installs only had the four 2026 sets) — a set you deleted isn't re-added
    const known = new Set(prefs.knownSets || (prefs.seededDefault ? ['2026-topps-s1-phillies', '2026-topps-s2-phillies', '2026-topps-upd-phillies', '2026-topps-chrome-phillies'] : []));
    for (const path of idx.sets || []) {
      const j = await (await fetch(path, { cache: 'no-cache' })).json();
      const ns = normalizeSet(j); const cur = getSet(ns.id);
      for (const c of ns.cards) PUB.add(pubKey(ns.id, c.id));
      if (!cur) { if (force || !known.has(ns.id)) { sets.push(ns); changed++; } }
      else if (!!cur.pinned !== !!ns.pinned && (ns.dataVersion || 0) <= (cur.dataVersion || 0)) { cur.pinned = ns.pinned; changed++; }
      else if ((ns.dataVersion || 0) > (cur.dataVersion || 0)) {
        // refresh the checklist but keep cards & parallels you added yourself (ownership/photos/prices are keyed by id)
        const ids = new Set(ns.cards.map(c => c.id)), pids = new Set(ns.parallels.map(p => p.id));
        for (const c of cur.cards) if (!ids.has(c.id)) ns.cards.push(c);
        for (const p of cur.parallels) if (!pids.has(p.id)) ns.parallels.push(p);
        sets[sets.indexOf(cur)] = ns; changed++;
      }
    }
    if (changed) saveSets();
    prefs.knownSets = [...new Set([...known, ...sets.map(s => s.id)])];
    pubLoaded = true;
    prefs.seededDefault = true; savePrefs();
    if (force) toast(changed ? 'Checklists loaded' : 'Already up to date');
    return changed;
  } catch (e) { console.warn('Could not load bundled checklists', e); return 0; }
}
async function seedExample() {
  try { const j = await (await fetch('sample-set.json')).json(); if (!getSet(slug(j.id))) { sets.push(normalizeSet(j)); saveSets(); toast('Example set loaded'); } }
  catch (e) { console.warn('Could not load example set', e); }
}
async function cacheAllImages() {
  const urls = new Set(); for (const s of sets) for (const c of s.cards) { if (c.image) urls.add(c.image); for (const u of Object.values(c.images || {})) urls.add(u); }
  if (!('caches' in window)) { toast('Offline cache not supported here'); return; }
  const cache = await caches.open('cc-img'); let done = 0; const list = [...urls];
  toast(`Saving ${list.length} images…`, 60000);
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async u => { try { if (!(await cache.match(u))) { const r = await fetch(u); if (r.ok) await cache.put(u, r); } done++; } catch { } }));
    if (i % 80 === 0) toast(`Saving images… ${done}/${list.length}`, 60000);
  }
  toast(`Saved ${done} images for offline use`);
}
(async () => {
  applyTheme();
  await loadPhotoKeys().catch(err => console.warn('Photo storage unavailable', err));
  await seedDefault(false);
  ensureChases();
  for (const c of CHASES) if (c.preload) for (const pc of c.preload().cards) PUB.add(pubKey(c.id, pc.id));
  render();
  // prices + Groky-published cards: network first (cached by the service worker for offline), then re-render
  Promise.all([loadPrices(), mergeExtra()]).then(([p, n]) => { if (p || n) render(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // When an updated version takes over, reload once so the new app shows right away (your data is untouched).
    const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded && $('#sheet').hidden) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(err => console.warn('SW failed', err));
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
})();
})();
