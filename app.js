/* 経候値 — ケッペンの気候区分版 経県値 */
(() => {
  'use strict';

  const { LEVELS, CLIMATES, GROUPS, RANKS } = window;
  const PLACES = window.PLACES || { groups: [], list: [], rle: '' };
  const N = CLIMATES.length;
  const MAX_SCORE = N * 5;
  const LV = Object.fromEntries(LEVELS.map(l => [l.v, l]));
  const CODE_IDX = Object.fromEntries(CLIMATES.map((c, i) => [c.code, i]));
  const PL = PLACES.list;
  const NP = PL.length;
  const PL_IDX = Object.fromEntries(PL.map((p, i) => [p.id, i]));
  const PARENT = PL.map(p => (p.parent && PL_IDX[p.parent] !== undefined ? PL_IDX[p.parent] : -1));
  const CHILDREN = PL.map(() => []);
  PARENT.forEach((p, i) => { if (p >= 0) CHILDREN[p].push(i); });
  const GROUP_NAME = Object.fromEntries(PLACES.groups);

  const STORAGE_KEY = 'keikouchi:v2';
  const STORAGE_KEY_V1 = 'keikouchi:v1';
  const COLOR_OCEAN = '#dce8f4';
  const COLOR_UNVISITED = '#eceff3';
  const COLOR_COAST = '#7f93ab';
  const COLOR_HL_UNVISITED = '#9aa9bd';
  const SCALE = 3;          // 1セルあたりのオフスクリーン画素数
  const NONE = 0xffff;      // 帰属なし
  const K_OCEAN = 0xffff;   // 描画キー：海
  const K_LAND = 0xfffe;    // 描画キー：帰属なしの陸地
  const MAIN_SHARE = 25;    // 「主な気候」とみなす面積割合（％）

  const $ = id => document.getElementById(id);

  // ------------------------------------------------------------------
  // 状態
  //   my.manual : 気候区分ごとに直接選んだレベル
  //   my.places : { 国・地域ID: { l: レベル, c: [反映する気候コード] } }
  //   実際のレベル = max(manual, その気候を含む国・地域のレベル)
  // ------------------------------------------------------------------
  let my = loadState();
  let shared = null;        // 共有URLで閲覧中のデータ { levels, places }
  let mapMode = 'level';    // 'level' | 'place' | 'koppen'
  let highlight = null;     // { t: 'climate' | 'place', i }
  let popupIndex = -1;      // 気候ポップアップ
  let ppIndex = -1;         // 国・地域ポップアップ
  let ppTemp = null;
  let curLevels = new Array(N).fill(0);
  let curPlaceLv = new Uint8Array(NP);

  const isReadonly = () => shared !== null;
  const levels = () => curLevels;
  const curPlaces = () => (shared ? shared.places : my.places);

  function emptyState() { return { manual: new Array(N).fill(0), places: {} }; }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (s && Array.isArray(s.manual) && s.manual.length === N) {
        const places = {};
        for (const [id, p] of Object.entries(s.places || {})) {
          if (PL_IDX[id] !== undefined && p.l >= 1 && p.l <= 5) places[id] = { l: p.l, c: (p.c || []).filter(c => c in CODE_IDX) };
        }
        return { manual: s.manual.map(v => Math.max(0, Math.min(5, v | 0))), places };
      }
      const v1 = localStorage.getItem(STORAGE_KEY_V1);
      if (v1 && new RegExp(`^[0-5]{${N}}$`).test(v1)) return { manual: v1.split('').map(Number), places: {} };
    } catch (e) { /* ignore */ }
    return emptyState();
  }
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(my)); } catch (e) { /* ignore */ }
  }

  function effectiveLevels(st) {
    const e = st.manual.slice();
    for (const p of Object.values(st.places)) {
      for (const code of p.c) {
        const i = CODE_IDX[code];
        if (i !== undefined && p.l > e[i]) e[i] = p.l;
      }
    }
    return e;
  }
  function recompute() {
    curLevels = shared ? shared.levels.slice() : effectiveLevels(my);
    curPlaceLv = new Uint8Array(NP);
    for (const [id, p] of Object.entries(curPlaces())) {
      const k = PL_IDX[id];
      if (k !== undefined) curPlaceLv[k] = p.l;
    }
  }
  /** 地図表示用：都道府県は「日本」のレベルも考慮 */
  function placeDisplayLevel(k) {
    const p = PARENT[k];
    return Math.max(curPlaceLv[k], p >= 0 ? curPlaceLv[p] : 0);
  }

  function setLevel(i, v) {
    if (isReadonly()) return;
    my.manual[i] = v;
    saveState();
    refresh();
    const eff = curLevels[i];
    if (eff > v) {
      const src = sourcesOf(i).filter(s => s.l === eff).map(s => s.name);
      toast(`${CLIMATES[i].code} は ${src.slice(0, 2).join('・')} の記録により「${LV[eff].label}」のままです`);
    }
  }

  function defaultCodes(p) {
    return p.c.filter((x, j) => j === 0 || x[1] >= MAIN_SHARE).map(x => x[0]);
  }
  function setPlace(k, l, codes) {
    if (isReadonly()) return;
    const id = PL[k].id;
    if (l > 0) my.places[id] = { l, c: codes.slice() };
    else delete my.places[id];
    saveState();
    refresh();
  }
  function quickSetPlace(k, l) {
    const id = PL[k].id;
    const cur = my.places[id];
    const codes = cur ? cur.c : defaultCodes(PL[k]);
    setPlace(k, l, codes);
    if (l > 0) {
      toast(codes.length
        ? `${placeName(k)}：${codes.join('・')} に「${LV[l].label}」を反映`
        : `${placeName(k)} を「${LV[l].label}」で記録（反映する気候なし）`);
    }
  }
  /** 気候 i にレベルを与えている国・地域 */
  function sourcesOf(i) {
    const code = CLIMATES[i].code, out = [];
    for (const [id, p] of Object.entries(curPlaces())) {
      if (p.c.includes(code)) out.push({ name: PL[PL_IDX[id]].ja, l: p.l });
    }
    return out.sort((a, b) => b.l - a.l);
  }

  // ------------------------------------------------------------------
  // ユーティリティ
  // ------------------------------------------------------------------
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function pack([r, g, b]) { return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0; }
  function mix(a, b, t) { return a.map((x, k) => Math.round(x + (b[k] - x) * t)); }
  function textOn(hex) {
    const [r, g, b] = hexToRgb(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0f172a' : '#ffffff';
  }
  function rankOf(score) { return RANKS.find(r => score >= r.min).title; }
  function fmtLat(lat) { return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`; }
  function fmtLon(lon) { return `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`; }
  function placeName(k) { return PL[k].ja; }
  function placeFullName(k) { return PARENT[k] >= 0 ? `${PL[PARENT[k]].ja}・${PL[k].ja}` : PL[k].ja; }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  /** 検索用正規化：小文字化・ひらがな→カタカナ・記号除去 */
  function norm(s) {
    return s.toLowerCase()
      .replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
      .replace(/[\s・･\-.,()（）'’]/g, '');
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function computeStats(lv) {
    const score = lv.reduce((a, b) => a + b, 0);
    const counts = Object.fromEntries(LEVELS.map(l => [l.v, 0]));
    lv.forEach(v => counts[v]++);
    const types = lv.filter(v => v > 0).length;
    const visited = lv.filter(v => v >= 3).length; // 住んだ(5)・泊まった(4)・訪れた(3)
    const share = grid ? lv.reduce((a, v, i) => a + (v >= 3 ? grid.landShare[i] : 0), 0) : 0;
    const allShare = grid ? lv.reduce((a, v, i) => a + (v > 0 ? grid.landShare[i] : 0), 0) : 0;
    const groups = new Set(CLIMATES.filter((c, i) => lv[i] > 0).map(c => c.g)).size;
    const ids = Object.keys(curPlaces());
    const countries = ids.filter(id => !PL[PL_IDX[id]].parent).length;
    const prefs = ids.length - countries;
    return { score, counts, types, visited, share, allShare, groups, countries, prefs, rank: rankOf(score) };
  }

  // ------------------------------------------------------------------
  // 地図データ
  // ------------------------------------------------------------------
  let grid = null; // { w, h, cells, owner, landShare }

  function decodeGrid(d) {
    const cells = new Uint8Array(d.width * d.height).fill(255);
    const map = d.classes.map(c => CLIMATES.findIndex(x => x.code === c));
    const s = d.rle;
    let i = 0, p = 0;
    while (p < s.length) {
      const ch = s.charCodeAt(p++);
      let n = 0;
      while (p < s.length) {
        const c = s.charCodeAt(p);
        if (c >= 48 && c <= 57) { n = n * 10 + (c - 48); p++; } else break;
      }
      if (n === 0) n = 1;
      let v = 255;
      if (ch !== 46) {
        const k = ch >= 97 ? ch - 97 + 26 : ch - 65;
        v = map[k] >= 0 ? map[k] : 255;
      }
      cells.fill(v, i, i + n);
      i += n;
    }
    const landShare = CLIMATES.map(c => {
      const k = d.classes.indexOf(c.code);
      return k >= 0 ? d.landShare[k] : 0;
    });
    return { w: d.width, h: d.height, cells, landShare };
  }
  function decodeOwner(rle, size) {
    const owner = new Uint16Array(size).fill(NONE);
    let i = 0, p = 0;
    while (p < rle.length) {
      const ch = rle.charCodeAt(p++);
      let n = 0;
      while (p < rle.length) {
        const c = rle.charCodeAt(p);
        if (c >= 48 && c <= 57) { n = n * 10 + (c - 48); p++; } else break;
      }
      if (n === 0) n = 1;
      const v = ch === 46 ? NONE : ch - 0x100;
      owner.fill(v >= 0 && v < NP ? v : NONE, i, i + n);
      i += n;
    }
    return owner;
  }

  let climateKeys = null, placeKeys = null;
  function buildKeys() {
    const n = grid.w * grid.h;
    climateKeys = new Uint16Array(n);
    placeKeys = new Uint16Array(n);
    for (let k = 0; k < n; k++) {
      const v = grid.cells[k];
      climateKeys[k] = v === 255 ? K_OCEAN : v;
      const o = grid.owner[k];
      placeKeys[k] = v === 255 ? K_OCEAN : o !== NONE ? o : K_LAND;
    }
  }

  function cellIndex(col, row) {
    if (!grid || row < 0 || row >= grid.h) return -1;
    col = ((col % grid.w) + grid.w) % grid.w;
    return row * grid.w + col;
  }
  const colToLon = col => (col + 0.5) * 360 / grid.w - 180;
  const rowToLat = row => 90 - (row + 0.5) * 180 / grid.h;
  const lonToX = lon => (lon + 180) * grid.w / 360;
  const latToY = lat => (90 - lat) * grid.h / 180;

  // ------------------------------------------------------------------
  // オフスクリーン描画
  // ------------------------------------------------------------------
  const base = document.createElement('canvas');
  const PAL = {
    fill: new Uint32Array(65536), fade: new Uint32Array(65536), hl: new Uint32Array(65536),
    edge: new Uint32Array(65536), edgeFade: new Uint32Array(65536),
  };
  const WHITE = [255, 255, 255], DARK = [30, 41, 59];

  function setPal(k, rgb, hlRgb, edgeT) {
    const f = mix(rgb, WHITE, 0.72);
    PAL.fill[k] = pack(rgb);
    PAL.fade[k] = pack(f);
    PAL.hl[k] = pack(hlRgb || rgb);
    PAL.edge[k] = pack(mix(rgb, DARK, edgeT));
    PAL.edgeFade[k] = pack(mix(f, DARK, edgeT * 0.6));
  }
  function buildPalette(mode, lv, placeLvFn) {
    if (mode === 'place') {
      for (let k = 0; k < NP; k++) {
        const L = placeLvFn(k);
        const rgb = hexToRgb(L > 0 ? LV[L].color : COLOR_UNVISITED);
        setPal(k, rgb, L > 0 ? rgb : hexToRgb(COLOR_HL_UNVISITED), 0.22);
      }
      setPal(K_LAND, hexToRgb(COLOR_UNVISITED), hexToRgb(COLOR_HL_UNVISITED), 0.22);
    } else if (mode === 'visited') {
      for (let i = 0; i < N; i++) {
        const L = lv[i];
        // 住んだ(5)・泊まった(4)・訪れた(3) のみ色を付け、降り立った(2)・通過した(1)・未踏(0)は未踏色
        const visited = L >= 3;
        const rgb = hexToRgb(visited ? LV[L].color : COLOR_UNVISITED);
        const hlRgb = !visited ? hexToRgb(CLIMATES[i].color) : rgb;
        setPal(i, rgb, hlRgb, 0.18);
      }
    } else {
      for (let i = 0; i < N; i++) {
        const rgb = mode === 'koppen' ? hexToRgb(CLIMATES[i].color)
          : hexToRgb(lv[i] > 0 ? LV[lv[i]].color : COLOR_UNVISITED);
        const hlRgb = mode === 'level' && lv[i] === 0 ? hexToRgb(CLIMATES[i].color) : rgb;
        setPal(i, rgb, hlRgb, mode === 'level' ? 0.18 : 0);
      }
    }
    setPal(K_OCEAN, hexToRgb(COLOR_OCEAN), null, 0);
    PAL.fade[K_OCEAN] = PAL.fill[K_OCEAN];
  }

  function makeHlTest(hl) {
    if (!hl || !grid) return null;
    if (hl.t === 'climate') { const cells = grid.cells; return k => cells[k] === hl.i; }
    const m = new Uint8Array(NP + 1);
    m[hl.i] = 1;
    CHILDREN[hl.i].forEach(c => { m[c] = 1; });
    const owner = grid.owner;
    return k => { const o = owner[k]; return o !== NONE && m[o] === 1; };
  }

  function renderBase(target, mode, lv, placeLvFn, hl) {
    const { w: W, h: H } = grid;
    const S = SCALE, PW = W * S, PH = H * S;
    if (target.width !== PW) { target.width = PW; target.height = PH; }
    const ctx = target.getContext('2d');
    const img = ctx.createImageData(PW, PH);
    const buf = new Uint32Array(img.data.buffer);
    buildPalette(mode, lv, placeLvFn);
    const keys = mode === 'place' ? placeKeys : climateKeys;
    const test = makeHlTest(hl);
    const coast = pack(hexToRgb(COLOR_COAST));
    const hlEdge = pack([15, 23, 42]);
    const isHl = test ? new Uint8Array(W * H) : null;
    if (test) for (let k = 0; k < W * H; k++) isHl[k] = test(k) ? 1 : 0;

    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const k = r * W + c, key = keys[k];
        const col = !isHl ? PAL.fill[key] : isHl[k] ? PAL.hl[key] : PAL.fade[key];
        const x0 = c * S, y0 = r * S;
        for (let dy = 0; dy < S; dy++) {
          const o = (y0 + dy) * PW + x0;
          for (let dx = 0; dx < S; dx++) buf[o + dx] = col;
        }
      }
    }
    const edgeColor = (k, other) => {
      const key = keys[k], ko = keys[other];
      if (isHl && isHl[k] !== isHl[other]) return hlEdge;
      if (key === K_OCEAN || ko === K_OCEAN) return coast;
      if (mode === 'koppen') return 0;
      return isHl && !isHl[k] ? PAL.edgeFade[key] : PAL.edge[key];
    };
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const k = r * W + c;
        const kr = r * W + ((c + 1) % W);
        if (keys[k] !== keys[kr] || (isHl && isHl[k] !== isHl[kr])) {
          const color = edgeColor(k, kr);
          if (color) { const x = c * S + S - 1; for (let dy = 0; dy < S; dy++) buf[(r * S + dy) * PW + x] = color; }
        }
        if (r + 1 < H) {
          const kb = k + W;
          if (keys[k] !== keys[kb] || (isHl && isHl[k] !== isHl[kb])) {
            const color = edgeColor(k, kb);
            if (color) { const o = (r * S + S - 1) * PW + c * S; for (let dx = 0; dx < S; dx++) buf[o + dx] = color; }
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return target;
  }

  let baseDirty = true;
  function invalidateBase() { baseDirty = true; requestDraw(); }

  // ------------------------------------------------------------------
  // 表示キャンバス（パン・ズーム）
  // ------------------------------------------------------------------
  const canvas = $('mapCanvas');
  const wrap = $('mapWrap');
  const ctx = canvas.getContext('2d');
  const cam = { cx: 360, cy: 180, z: 1 }; // cx, cy: セル座標, z: CSS px / セル
  let vw = 0, vh = 0, dpr = 1;
  let marker = null;

  function minZoom() { return grid ? Math.max(vw / grid.w, vh / grid.h) : 1; }
  const MAX_ZOOM = 40;

  function clampView() {
    if (!grid) return;
    cam.z = Math.min(MAX_ZOOM, Math.max(minZoom(), cam.z));
    const hw = vw / 2 / cam.z, hh = vh / 2 / cam.z;
    cam.cx = Math.min(grid.w - hw, Math.max(hw, cam.cx));
    cam.cy = Math.min(grid.h - hh, Math.max(hh, cam.cy));
  }

  function resize() {
    const rect = wrap.getBoundingClientRect();
    const atMin = vw === 0 || Math.abs(cam.z - minZoom()) < 1e-6;
    vw = rect.width; vh = rect.height; dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    if (atMin) cam.z = minZoom();
    clampView();
    requestDraw();
  }

  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  function draw() {
    if (!grid || !vw) return;
    if (baseDirty) { renderBase(base, mapMode, levels(), placeDisplayLevel, highlight); baseDirty = false; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLOR_OCEAN;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const sw = vw / cam.z, sh = vh / cam.z;
    const sx = cam.cx - sw / 2, sy = cam.cy - sh / 2;
    ctx.imageSmoothingEnabled = cam.z * dpr < SCALE * 1.5;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, sx * SCALE, sy * SCALE, sw * SCALE, sh * SCALE, 0, 0, canvas.width, canvas.height);

    if (marker) {
      const px = (marker.x - sx) * cam.z * dpr, py = (marker.y - sy) * cam.z * dpr;
      ctx.beginPath();
      ctx.arc(px, py, 6 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = '#0f172a';
      ctx.stroke();
    }
  }

  function screenToCell(px, py) {
    const x = cam.cx + (px - vw / 2) / cam.z;
    const y = cam.cy + (py - vh / 2) / cam.z;
    return { x, y, col: Math.floor(x), row: Math.floor(y) };
  }

  function zoomAt(px, py, factor) {
    const before = screenToCell(px, py);
    cam.z *= factor;
    clampView();
    cam.cx = before.x - (px - vw / 2) / cam.z;
    cam.cy = before.y - (py - vh / 2) / cam.z;
    clampView();
    requestDraw();
  }

  let anim = null;
  function flyTo(cx, cy, z, dur = 450) {
    cancelAnimationFrame(anim);
    const from = { ...cam };
    const to = { cx, cy, z: Math.min(MAX_ZOOM, Math.max(minZoom(), z)) };
    const t0 = performance.now();
    const step = now => {
      // rAF のタイムスタンプは t0 より前になることがあるので 0〜1 に収める
      const t = Math.max(0, Math.min(1, (now - t0) / dur));
      const e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      cam.z = Math.exp(Math.log(from.z) + (Math.log(to.z) - Math.log(from.z)) * e);
      cam.cx = from.cx + (to.cx - from.cx) * e;
      cam.cy = from.cy + (to.cy - from.cy) * e;
      clampView();
      draw();
      if (t < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  /** 国・地域の範囲に地図を合わせる */
  function flyToPlace(k) {
    if (!grid) return;
    const m = new Uint8Array(NP); m[k] = 1; CHILDREN[k].forEach(c => { m[c] = 1; });
    let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1, n = 0;
    const { w, h, owner } = grid;
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const o = owner[r * w + c];
      if (o !== NONE && m[o]) { n++; if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c; }
    }
    if (!n) return;
    if (c1 - c0 > w / 2) return; // 日付変更線をまたぐ国（ロシアなど）は移動しない
    const spanW = Math.max(c1 - c0 + 1, 16), spanH = Math.max(r1 - r0 + 1, 10);
    const z = Math.min(vw / (spanW * 1.4), vh / (spanH * 1.4));
    flyTo((c0 + c1 + 1) / 2, (r0 + r1 + 1) / 2, Math.max(cam.z * 0.5, Math.min(z, 24)));
  }

  const VIEWS = {
    world:    null,
    japan:    { lon: 137, lat: 37, span: 28 },
    europe:   { lon: 15, lat: 52, span: 55 },
    namerica: { lon: -100, lat: 45, span: 85 },
    asia:     { lon: 100, lat: 32, span: 90 },
  };
  function goView(name) {
    if (!grid) return;
    const v = VIEWS[name];
    if (!v) { flyTo(grid.w / 2, grid.h / 2, minZoom()); return; }
    const z = vw / (v.span * grid.w / 360);
    flyTo(lonToX(v.lon), latToY(v.lat), z);
  }

  // ポインター操作
  const pointers = new Map();
  let drag = null, pinch = null;

  function localPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    const p = localPos(e);
    pointers.set(e.pointerId, p);
    cancelAnimationFrame(anim);
    if (pointers.size === 1) {
      drag = { start: p, last: p, moved: false };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), z: cam.z, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      if (drag) drag.moved = true;
    }
  });

  canvas.addEventListener('pointermove', e => {
    const p = localPos(e);
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') showTooltip(p);
      return;
    }
    pointers.set(e.pointerId, p);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const anchor = screenToCell(pinch.mid.x, pinch.mid.y);
      cam.z = pinch.z * dist / pinch.dist;
      clampView();
      cam.cx = anchor.x - (mid.x - vw / 2) / cam.z;
      cam.cy = anchor.y - (mid.y - vh / 2) / cam.z;
      clampView();
      pinch.mid = mid; pinch.z = cam.z; pinch.dist = dist;
      requestDraw();
    } else if (drag) {
      const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
      if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 5) {
        drag.moved = true;
        canvas.classList.add('dragging');
        hideTooltip();
      }
      if (drag.moved) {
        cam.cx -= dx / cam.z;
        cam.cy -= dy / cam.z;
        clampView();
        requestDraw();
      }
      drag.last = p;
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = localPos(e);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      if (drag && !drag.moved && e.type === 'pointerup') selectAt(p);
      drag = null;
      canvas.classList.remove('dragging');
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hideTooltip(); });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const p = localPos(e);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  $('zoomIn').addEventListener('click', () => flyTo(cam.cx, cam.cy, cam.z * 1.8, 250));
  $('zoomOut').addEventListener('click', () => flyTo(cam.cx, cam.cy, cam.z / 1.8, 250));

  // ツールチップ
  const tooltip = $('tooltip');
  let ttCell = -2;
  function levelBadge(l) {
    const st = l.v > 0 ? `background:${l.color};color:#fff` : 'background:#e2e8f0;color:#334155';
    return `<span class="tt-level" style="${st}">${l.label}</span>`;
  }
  function showTooltip(p) {
    if (!grid) return;
    const { col, row } = screenToCell(p.x, p.y);
    const k = cellIndex(col, row);
    const v = k >= 0 ? grid.cells[k] : 255;
    if (v === 255) { hideTooltip(); return; }
    if (k !== ttCell) {
      ttCell = k;
      const c = CLIMATES[v];
      const o = grid.owner[k];
      const pname = o !== NONE ? esc(placeFullName(o)) : '';
      if (mapMode === 'place') {
        tooltip.innerHTML = `<b>${pname || '（国・地域データなし）'}</b><br>${c.code} ${c.name}<br>${o !== NONE ? levelBadge(LV[placeDisplayLevel(o)]) : ''}`;
      } else {
        tooltip.innerHTML = `<b>${c.code}</b> ${c.name}<br>${pname ? pname + ' · ' : ''}${fmtLat(rowToLat(row))}, ${fmtLon(colToLon(col))}<br>${levelBadge(LV[levels()[v]])}`;
      }
    }
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    const left = p.x + tw + 24 > vw ? p.x - tw - 24 : p.x;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.min(p.y, vh - 80)}px`;
  }
  function hideTooltip() { tooltip.hidden = true; ttCell = -2; }

  function selectAt(p) {
    if (!grid) return;
    const { col, row } = screenToCell(p.x, p.y);
    const k = cellIndex(col, row);
    const v = k >= 0 ? grid.cells[k] : 255;
    if (v === 255) { toast('そこは海です 🌊'); return; }
    const o = grid.owner[k];
    if (mapMode === 'place') {
      if (o === NONE) { toast('この地点の国・地域データがありません'); return; }
      openPlacePopup(o);
      return;
    }
    marker = { x: col + 0.5, y: row + 0.5 };
    requestDraw();
    openPopup(v, `地点：${fmtLat(rowToLat(row))}, ${fmtLon(colToLon(col))}`, o);
  }

  // ------------------------------------------------------------------
  // 気候ポップアップ
  // ------------------------------------------------------------------
  function showBackdrop(show) { $('popupBackdrop').hidden = !show; }

  function openPopup(i, meta = '', ownerIdx = NONE) {
    closePlacePopup(true);
    popupIndex = i;
    const c = CLIMATES[i];
    const g = GROUPS[c.g];
    const code = $('popupCode');
    code.textContent = c.code;
    code.style.background = c.color;
    code.style.color = textOn(c.color);
    $('popupGroup').textContent = `${c.g} ${g.name}`;
    $('popupName').textContent = c.name;
    $('popupDesc').textContent = c.desc;
    $('popupEx').textContent = c.ex;
    const share = grid ? `陸地面積の約 ${grid.landShare[i] < 0.1 ? grid.landShare[i].toFixed(2) : grid.landShare[i].toFixed(1)}%` : '';
    $('popupMeta').textContent = [meta, share].filter(Boolean).join(' ／ ');

    const pp = $('popupPlace');
    if (ownerIdx !== NONE && ownerIdx !== undefined) {
      const btns = [ownerIdx, ...(PARENT[ownerIdx] >= 0 ? [PARENT[ownerIdx]] : [])]
        .map(k => `<button class="chip-btn" data-place="${k}">${esc(PL[k].ja)}として記録</button>`).join('');
      pp.innerHTML = `<b>📍 ${esc(placeFullName(ownerIdx))}</b>${btns}`;
      pp.hidden = false;
    } else {
      pp.hidden = true;
    }
    renderPopupLevels();
    $('popup').hidden = false;
    showBackdrop(true);
    setHighlight({ t: 'climate', i });
  }
  function renderPopupLevels() {
    const cur = levels()[popupIndex];
    $('popupLevels').innerHTML = LEVELS.map(l => {
      const on = l.v === cur;
      const style = on && l.v > 0 ? `background:${l.color};border-color:${l.color}` : `border-color:${on ? '' : l.v > 0 ? l.color + '55' : ''}`;
      return `<button class="pl-btn l${l.v} ${on ? 'on' : ''}" data-v="${l.v}" style="${style}" ${isReadonly() ? 'disabled' : ''}>
        ${l.label}<span class="pl-pt">${l.v}点</span><small>${l.desc}</small></button>`;
    }).join('');
  }
  function closePopup(keepState) {
    if (popupIndex < 0) return;
    $('popup').hidden = true;
    popupIndex = -1;
    if (!keepState) { showBackdrop(false); marker = null; setHighlight(null); }
  }
  $('popupLevels').addEventListener('click', e => {
    const b = e.target.closest('.pl-btn');
    if (!b || isReadonly()) return;
    const i = popupIndex, v = Number(b.dataset.v);
    closePopup();
    setLevel(i, v);
    if (curLevels[i] === v) toast(`${CLIMATES[i].code} を「${LV[v].label}」にしました`);
  });
  $('popupPlace').addEventListener('click', e => {
    const b = e.target.closest('[data-place]');
    if (b) openPlacePopup(Number(b.dataset.place));
  });
  $('popupClose').addEventListener('click', () => closePopup());

  // ------------------------------------------------------------------
  // 国・地域ポップアップ
  // ------------------------------------------------------------------
  function openPlacePopup(k) {
    closePopup(true);
    ppIndex = k;
    const p = PL[k];
    const rec = curPlaces()[p.id];
    ppTemp = { l: rec ? rec.l : 0, c: rec ? rec.c.slice() : defaultCodes(p) };
    $('ppGroup').textContent = p.parent ? `${GROUP_NAME[p.g] || ''}` : (GROUP_NAME[p.g] || '');
    $('ppName').textContent = placeFullName(k);
    $('ppEn').textContent = p.en;
    renderPlacePopup();
    $('placePopup').hidden = false;
    showBackdrop(true);
    setHighlight({ t: 'place', i: k });
    flyToPlace(k);
  }
  function renderPlacePopup() {
    const p = PL[ppIndex];
    const ro = isReadonly();
    $('ppLevels').innerHTML = LEVELS.map(l => {
      const on = l.v === ppTemp.l;
      const style = on && l.v > 0 ? `background:${l.color};border-color:${l.color}` : `border-color:${on ? '' : l.v > 0 ? l.color + '55' : ''}`;
      return `<button class="pl-btn l${l.v} ${on ? 'on' : ''}" data-v="${l.v}" style="${style}" ${ro ? 'disabled' : ''}>${l.label}<span class="pl-pt">${l.v}点</span></button>`;
    }).join('');
    if (!p.c.length) {
      $('ppClimates').innerHTML = '<div class="pp-empty">この国・地域は小さいため、気候データがありません。「気候区分から選ぶ」タブで直接選んでください。</div>';
    } else {
      $('ppClimates').innerHTML = p.c.map(([code, pct]) => {
        const c = CLIMATES[CODE_IDX[code]];
        const checked = ppTemp.c.includes(code);
        return `<label class="pp-cl">
          <input type="checkbox" data-code="${code}" ${checked ? 'checked' : ''} ${ro ? 'disabled' : ''} />
          <span class="cl-code" style="background:${c.color};color:${textOn(c.color)}">${code}</span>
          <span class="pp-cl-name">${c.name}<div class="pp-cl-bar"><span style="width:${Math.min(100, pct)}%"></span></div></span>
          <span class="pp-cl-pct">${pct < 1 ? '<1' : Math.round(pct)}%</span>
        </label>`;
      }).join('');
    }
    ['ppMain', 'ppAll', 'ppNone'].forEach(id => { $(id).disabled = ro || !p.c.length; });
    $('ppHint').textContent = ro
      ? '共有データの閲覧中は編集できません。'
      : 'チェックした気候区分に、選んだレベルが反映されます。％は面積に占める割合です。都市単位で区別したいときは「経候値マップ」で地点をクリックしてください。';
  }
  function applyPlaceTemp() {
    if (isReadonly() || ppIndex < 0) return;
    const rec = my.places[PL[ppIndex].id];
    if (ppTemp.l > 0 || rec) setPlace(ppIndex, ppTemp.l, ppTemp.c);
  }
  function closePlacePopup(keepState) {
    if (ppIndex < 0) return;
    $('placePopup').hidden = true;
    ppIndex = -1;
    ppTemp = null;
    if (!keepState) { showBackdrop(false); setHighlight(null); }
  }
  $('ppLevels').addEventListener('click', e => {
    const b = e.target.closest('.pl-btn');
    if (!b || isReadonly()) return;
    ppTemp.l = Number(b.dataset.v);
    applyPlaceTemp();
    renderPlacePopup();
  });
  $('ppClimates').addEventListener('change', e => {
    const cb = e.target.closest('input[data-code]');
    if (!cb || isReadonly()) return;
    const code = cb.dataset.code;
    ppTemp.c = ppTemp.c.filter(x => x !== code);
    if (cb.checked) ppTemp.c.push(code);
    applyPlaceTemp();
  });
  const setTempCodes = codes => { ppTemp.c = codes; applyPlaceTemp(); renderPlacePopup(); };
  $('ppMain').addEventListener('click', () => setTempCodes(defaultCodes(PL[ppIndex])));
  $('ppAll').addEventListener('click', () => setTempCodes(PL[ppIndex].c.map(x => x[0])));
  $('ppNone').addEventListener('click', () => setTempCodes([]));
  $('ppDone').addEventListener('click', () => {
    const k = ppIndex, l = ppTemp ? ppTemp.l : 0;
    closePlacePopup();
    if (!isReadonly() && l > 0) toast(`${placeName(k)} を「${LV[l].label}」で記録しました`);
  });
  $('placePopupClose').addEventListener('click', () => closePlacePopup());

  $('popupBackdrop').addEventListener('click', () => { closePopup(); closePlacePopup(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closePopup(); closePlacePopup();
  });

  function setHighlight(h) {
    const same = (highlight && h && highlight.t === h.t && highlight.i === h.i) || (!highlight && !h);
    if (same) return;
    highlight = h;
    document.querySelectorAll('.cl-row').forEach(r => r.classList.toggle('hl', !!h && h.t === 'climate' && Number(r.dataset.i) === h.i));
    document.querySelectorAll('.pr').forEach(r => r.classList.toggle('hl', !!h && h.t === 'place' && Number(r.dataset.k) === h.i));
    invalidateBase();
  }
  const popupOpen = () => popupIndex >= 0 || ppIndex >= 0;

  // ------------------------------------------------------------------
  // 気候区分リスト
  // ------------------------------------------------------------------
  function lvButtons(attr, idx) {
    return LEVELS.map(l => `<button class="lv-btn l${l.v}" ${attr}="${idx}" data-v="${l.v}" title="${l.label}（${l.v}点）">${l.short}</button>`).join('');
  }
  function buildClimateList() {
    const list = $('climateList');
    let html = '';
    for (const gk of Object.keys(GROUPS)) {
      const g = GROUPS[gk];
      html += `<div class="group-head">
        <span class="group-letter" style="background:${g.color}">${gk}</span>
        <div><div class="group-name">${g.name}</div><div class="group-desc">${g.desc}</div></div>
        <span class="group-score" data-group="${gk}"></span></div>`;
      CLIMATES.forEach((c, i) => {
        if (c.g !== gk) return;
        html += `<div class="cl-row" data-i="${i}">
          <span class="cl-code" style="background:${c.color};color:${textOn(c.color)}" data-open="${i}">${c.code}</span>
          <div class="cl-body">
            <div class="cl-top">
              <span class="cl-name" data-open="${i}" title="${c.name}">${c.name}</span>
              <div class="lv-btns">${lvButtons('data-i', i)}</div>
            </div>
            <div class="cl-ex" data-ex="${i}" title="${c.ex}">${c.ex}</div>
          </div></div>`;
      });
    }
    list.innerHTML = html;

    list.addEventListener('click', e => {
      const lb = e.target.closest('.lv-btn');
      if (lb) { setLevel(Number(lb.dataset.i), Number(lb.dataset.v)); return; }
      const op = e.target.closest('[data-open]');
      if (op) openPopup(Number(op.dataset.open));
    });
    list.addEventListener('pointerover', e => {
      if (e.pointerType !== 'mouse' || popupOpen()) return;
      const row = e.target.closest('.cl-row');
      if (row) setHighlight({ t: 'climate', i: Number(row.dataset.i) });
    });
    list.addEventListener('pointerleave', () => { if (!popupOpen()) setHighlight(null); });

    $('levelKey').innerHTML = LEVELS.filter(l => l.v > 0).map(l => `<span style="background:${l.color}" title="${l.label}">${l.short}</span>`).join('');
    $('aboutLevels').innerHTML = LEVELS.map(l => `<div class="al"><b style="background:${l.v > 0 ? l.color : '#cbd5e1'}">${l.v}</b><div><strong>${l.label}</strong><small>${l.desc}</small></div></div>`).join('');
  }

  function paintLvButtons(scope, attr, getLevel) {
    scope.querySelectorAll('.lv-btn').forEach(b => {
      const v = Number(b.dataset.v);
      const on = getLevel(Number(b.getAttribute(attr))) === v;
      b.classList.toggle('on', on);
      b.style.background = on && v > 0 ? LV[v].color : '';
    });
  }

  let climateFilter = 'all'; // 'all' | 'visited' | 'any' | 'unvisited'

  document.querySelectorAll('.cf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      climateFilter = btn.dataset.filter;
      applyClimateFilter();
    });
  });

  function applyClimateFilter() {
    const lv = levels();
    const list = $('climateList');
    list.querySelectorAll('.cl-row').forEach(row => {
      const i = Number(row.dataset.i);
      const l = lv[i];
      let show = true;
      if (climateFilter === 'visited') show = (l >= 3);
      else if (climateFilter === 'any') show = (l >= 1);
      else if (climateFilter === 'unvisited') show = (l === 0);
      row.hidden = !show;
    });

    // グループヘッダーの表示／非表示
    list.querySelectorAll('.group-head').forEach(gh => {
      const gk = gh.querySelector('.group-letter').textContent.trim();
      let hasVisible = false;
      CLIMATES.forEach((c, i) => {
        if (c.g === gk) {
          const l = lv[i];
          if (climateFilter === 'all') hasVisible = true;
          else if (climateFilter === 'visited' && l >= 3) hasVisible = true;
          else if (climateFilter === 'any' && l >= 1) hasVisible = true;
          else if (climateFilter === 'unvisited' && l === 0) hasVisible = true;
        }
      });
      gh.hidden = !hasVisible;
    });
  }

  function updateClimateList() {
    const lv = levels();
    const list = $('climateList');
    paintLvButtons(list, 'data-i', i => lv[i]);
    list.querySelectorAll('.group-score').forEach(el => {
      const gk = el.dataset.group;
      let s = 0, m = 0;
      CLIMATES.forEach((c, i) => { if (c.g === gk) { s += lv[i]; m += 5; } });
      el.textContent = `${s} / ${m}`;
    });
    list.querySelectorAll('[data-ex]').forEach(el => {
      const i = Number(el.dataset.ex);
      const src = sourcesOf(i);
      if (src.length) {
        const names = src.map(s => s.name);
        el.textContent = `🌐 ${names.slice(0, 3).join('、')}${names.length > 3 ? ` ほか${names.length - 3}件` : ''}`;
        el.title = names.join('、');
        el.classList.add('derived');
      } else {
        el.textContent = CLIMATES[i].ex;
        el.title = CLIMATES[i].ex;
        el.classList.remove('derived');
      }
    });
    list.classList.toggle('readonly', isReadonly());

    // 「実際に訪れた気候（住む・泊まる・訪れる）」のハイライト欄を更新
    const visitedList = [];
    CLIMATES.forEach((c, i) => {
      const l = lv[i];
      if (l >= 3) {
        visitedList.push({ idx: i, code: c.code, name: c.name, color: c.color, lv: l });
      }
    });
    // レベル降順、同レベルならコード順
    visitedList.sort((a, b) => b.lv - a.lv || a.code.localeCompare(b.code));

    if ($('vcbCount')) $('vcbCount').textContent = `${visitedList.length} / 30`;
    if ($('vcbList')) {
      $('vcbList').innerHTML = visitedList.length ? visitedList.map(v => `
        <button class="vcb-chip" data-open="${v.idx}" title="${v.code} ${v.name}（${LV[v.lv].label}）">
          <span class="vcb-tag" style="background:${v.color};color:${textOn(v.color)}">${v.code}</span>
          <span>${esc(v.name)}</span>
          <span class="vcb-lv" style="background:${LV[v.lv].color}">${LV[v.lv].short}</span>
        </button>
      `).join('') : '<div class="vcb-empty">まだ訪れた気候の記録がありません（Lv3以上：住んだ・泊まった・訪れた）</div>';
    }

    // 絞り込みフィルターの再適用
    applyClimateFilter();
  }

  // 訪れた気候欄のチップクリックで気候ポップアップを開く
  if ($('vcbList')) {
    $('vcbList').addEventListener('click', e => {
      const chip = e.target.closest('[data-open]');
      if (chip) openPopup(Number(chip.dataset.open));
    });
  }

  // ------------------------------------------------------------------
  // 国・地域リスト
  // ------------------------------------------------------------------
  const placeSearchKey = PL.map(p => norm(`${p.ja}${p.en}${p.id}`));

  function placeRow(k) {
    const p = PL[k];
    const chips = p.c.length
      ? p.c.slice(0, 4).map(([code]) => {
        const c = CLIMATES[CODE_IDX[code]];
        return `<span class="mini-cl" data-code="${code}" style="background:${c.color};color:${textOn(c.color)}">${code}</span>`;
      }).join('') + (p.c.length > 4 ? `<span class="pr-none">+${p.c.length - 4}</span>` : '')
      : '<span class="pr-none">気候データなし</span>';
    return `<div class="pr" data-k="${k}">
      <button class="pr-main" data-popen="${k}">
        <span class="pr-name">${esc(p.ja)}</span><span class="pr-en">${esc(p.en)}</span>
        <span class="pr-cl">${chips}</span>
      </button>
      <div class="lv-btns">${lvButtons('data-pk', k)}</div>
    </div>`;
  }

  function buildPlaceList() {
    const list = $('placeList');
    if (!NP) {
      list.innerHTML = '<div class="no-result">国・地域データ（places.js）が見つかりません。<br><code>npm run build:places</code> を実行してください。</div>';
      return;
    }
    const collator = new Intl.Collator('ja');
    let html = '';
    const rowWithSubs = k => {
      const kids = CHILDREN[k];
      if (!kids.length || PL[k].id === 'JPN') return placeRow(k);
      const sorted = kids.slice().sort((a, b) => collator.compare(PL[a].ja, PL[b].ja));
      return placeRow(k) + `<details class="subs" data-parent="${k}">
        <summary>州・省ごとに選ぶ（${kids.length}）<span class="sub-count" data-subcount="${k}"></span></summary>
        <div class="subs-body">${sorted.map(placeRow).join('')}</div></details>`;
    };
    for (const [gk, gname] of PLACES.groups) {
      let idxs = PL.map((p, k) => k).filter(k => PL[k].g === gk);
      if (!idxs.length) continue;
      if (gk !== 'jp') idxs.sort((a, b) => collator.compare(PL[a].ja, PL[b].ja));
      const extra = gk === 'jp' && PL_IDX.JPN !== undefined ? placeRow(PL_IDX.JPN) : '';
      html += `<details class="pg" data-g="${gk}">
        <summary><span class="pg-title">${gname}</span><span class="pg-count" data-gcount="${gk}"></span></summary>
        <div class="pg-body">${extra}${idxs.map(rowWithSubs).join('')}</div>
      </details>`;
    }
    html += '<div class="no-result" id="placeNoResult" hidden>見つかりませんでした</div>';
    list.innerHTML = html;

    const onClick = e => {
      const lb = e.target.closest('.lv-btn[data-pk]');
      if (lb) { if (!isReadonly()) quickSetPlace(Number(lb.dataset.pk), Number(lb.dataset.v)); return; }
      const op = e.target.closest('[data-popen]');
      if (op) openPlacePopup(Number(op.dataset.popen));
    };
    list.addEventListener('click', onClick);
    $('placeVisited').addEventListener('click', onClick);
    list.addEventListener('pointerover', e => {
      if (e.pointerType !== 'mouse' || popupOpen()) return;
      const row = e.target.closest('.pr');
      if (row) setHighlight({ t: 'place', i: Number(row.dataset.k) });
    });
    list.addEventListener('pointerleave', () => { if (!popupOpen()) setHighlight(null); });

    $('placeSearch').addEventListener('input', filterPlaces);
  }

  let placeFilter = 'all'; // 'all' | 'visited' | 'any' | 'unvisited'

  document.querySelectorAll('.pf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      placeFilter = btn.dataset.pfilter;
      filterPlaces();
    });
  });

  let groupOpenState = null;
  function filterPlaces() {
    const q = norm($('placeSearch').value);
    const groups = document.querySelectorAll('.pg, .subs');
    if ((q || placeFilter !== 'all') && !groupOpenState) groupOpenState = [...groups].map(g => g.open);
    let total = 0;
    document.querySelectorAll('.pr').forEach(r => {
      const k = Number(r.dataset.k);
      const matchText = !q || placeSearchKey[k].includes(q);
      const lv = curPlaceLv[k];
      let matchLv = true;
      if (placeFilter === 'visited') matchLv = (lv >= 3);
      else if (placeFilter === 'any') matchLv = (lv >= 1);
      else if (placeFilter === 'unvisited') matchLv = (lv === 0);

      const ok = matchText && matchLv;
      r.hidden = !ok;
      if (ok) total++;
    });
    // 子の州がヒットしたら親の国の行も表示
    document.querySelectorAll('.subs').forEach(s => {
      const hit = [...s.querySelectorAll('.pr')].some(r => !r.hidden);
      if ((q || placeFilter !== 'all') && hit) { const pr = s.previousElementSibling; if (pr) pr.hidden = false; }
    });
    groups.forEach((g, gi) => {
      const shown = [...g.querySelectorAll('.pr')].filter(r => !r.hidden).length;
      g.hidden = (q || placeFilter !== 'all') && !shown;
      if (q || placeFilter !== 'all') {
        g.open = shown > 0;
      } else if (groupOpenState) {
        g.open = groupOpenState[gi];
      }
    });
    if (!q && placeFilter === 'all') groupOpenState = null;
    $('placeNoResult').hidden = (!q && placeFilter === 'all') || total > 0;
  }

  function updatePlaceList() {
    if (!NP) return;
    const places = curPlaces();
    const list = $('placeList');
    paintLvButtons(list, 'data-pk', k => curPlaceLv[k]);
    // 反映中の気候チップを強調
    list.querySelectorAll('.pr').forEach(r => {
      const rec = places[PL[Number(r.dataset.k)].id];
      r.querySelectorAll('.mini-cl').forEach(ch => ch.classList.toggle('off', !!rec && !rec.c.includes(ch.dataset.code)));
    });
    list.querySelectorAll('[data-gcount]').forEach(el => {
      const gk = el.dataset.gcount;
      const all = PL.filter(p => p.g === gk);
      const n = all.filter(p => places[p.id]).length;
      el.textContent = n ? `${n} / ${all.length}` : `${all.length}`;
    });
    list.querySelectorAll('[data-subcount]').forEach(el => {
      const n = CHILDREN[Number(el.dataset.subcount)].filter(c => places[PL[c].id]).length;
      el.textContent = n ? ` ・ ${n}件記録` : '';
    });
    list.classList.toggle('readonly', isReadonly());

    const visited = Object.entries(places)
      .map(([id, p]) => ({ k: PL_IDX[id], l: p.l }))
      .filter(x => x.k !== undefined)
      .sort((a, b) => b.l - a.l || PL[a.k].ja.localeCompare(PL[b.k].ja, 'ja'));
    $('placeVisited').innerHTML = visited.length
      ? visited.map(x => `<button class="pv-chip" data-popen="${x.k}" style="border-color:${LV[x.l].color}"><i style="background:${LV[x.l].color}">${LV[x.l].short}</i>${esc(placeFullName(x.k))}</button>`).join('')
      : '<span class="visited-empty">まだ記録がありません。下のリストから行ったことのある国・地域を選んでください。</span>';
    $('placeCount').textContent = visited.length || '';
    if ($('vpbCount')) $('vpbCount').textContent = `${visited.length} 件`;

    filterPlaces();
  }

  // ------------------------------------------------------------------
  // スコア・凡例
  // ------------------------------------------------------------------
  function updateScore() {
    const st = computeStats(levels());
    $('scoreValue').textContent = st.score;
    $('headerScoreValue').textContent = st.score;
    $('rankTitle').textContent = st.rank;
    $('scoreBar').innerHTML = LEVELS.filter(l => l.v > 0)
      .map(l => `<span style="width:${st.counts[l.v] * l.v / MAX_SCORE * 100}%;background:${l.color}" title="${l.label}: ${st.counts[l.v] * l.v}点"></span>`).join('');
    $('levelCounts').innerHTML = LEVELS.map(l => `<div class="lc">
      <span class="lc-badge" style="background:${l.v > 0 ? l.color : '#cbd5e1'}">${l.short}</span>
      <span class="lc-num">${st.counts[l.v]}</span><span class="lc-label">${l.label}</span></div>`).join('');
    if ($('statVisited')) $('statVisited').textContent = `${st.visited}/30`;
    $('statTypes').textContent = st.types;
    $('statLand').textContent = `${st.share.toFixed(st.share > 0 && st.share < 10 ? 1 : 0)}%`;
    if ($('statGroups')) $('statGroups').textContent = `${st.groups}/5`;
    $('statPlaces').textContent = st.countries;
    $('statPlaces').title = st.prefs ? `ほかに州・都道府県 ${st.prefs}` : '';
  }

  function updateLegend() {
    const lg = $('legend');
    if (mapMode === 'koppen') {
      lg.className = 'legend koppen';
      lg.innerHTML = CLIMATES.map((c, i) => `<span class="legend-item" data-i="${i}" title="${c.name}"><span class="legend-sw" style="background:${c.color}"></span>${c.code}</span>`).join('');
    } else if (mapMode === 'visited') {
      lg.className = 'legend';
      lg.innerHTML = LEVELS.filter(l => l.v >= 3).map(l => `<span class="legend-item"><span class="legend-sw" style="background:${l.color}"></span>${l.label}</span>`).join('')
        + `<span class="legend-item"><span class="legend-sw" style="background:${COLOR_UNVISITED}"></span>未訪問（通過・降り立った・未踏）</span>`;
    } else {
      lg.className = 'legend';
      lg.innerHTML = LEVELS.map(l => `<span class="legend-item"><span class="legend-sw" style="background:${l.v > 0 ? l.color : COLOR_UNVISITED}"></span>${l.label}${mapMode === 'level' ? `（${l.v}点）` : ''}</span>`).join('');
    }
  }
  $('legend').addEventListener('click', e => {
    const it = e.target.closest('.legend-item[data-i]');
    if (it) openPopup(Number(it.dataset.i));
  });
  $('legend').addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse' || popupOpen()) return;
    const it = e.target.closest('.legend-item[data-i]');
    if (it) setHighlight({ t: 'climate', i: Number(it.dataset.i) });
  });
  $('legend').addEventListener('pointerleave', () => { if (!popupOpen()) setHighlight(null); });

  function refresh() {
    recompute();
    updateClimateList();
    updatePlaceList();
    updateScore();
    if (popupIndex >= 0) renderPopupLevels();
    invalidateBase();
  }

  // ------------------------------------------------------------------
  // ツールバー・タブ
  // ------------------------------------------------------------------
  function setMapMode(mode) {
    mapMode = mode;
    document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x.dataset.mode === mode));
    updateLegend();
    invalidateBase();
  }
  document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => setMapMode(b.dataset.mode)));
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => goView(b.dataset.view)));

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    const tab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    $('tabClimate').hidden = tab !== 'climate';
    $('tabPlace').hidden = tab !== 'place';
    // 国・地域タブを開いたら地図も国・地域表示に、戻したら経候値表示に
    if (tab === 'place' && mapMode === 'level') setMapMode('place');
    if (tab === 'climate' && mapMode === 'place') setMapMode('level');
  }));

  $('locateBtn').addEventListener('click', () => {
    if (!grid) return;
    if (!navigator.geolocation) { toast('このブラウザでは位置情報を使えません'); return; }
    toast('現在地を取得中…');
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      let col = Math.floor(lonToX(lon)), row = Math.floor(latToY(lat));
      let k = cellIndex(col, row);
      let v = k >= 0 ? grid.cells[k] : 255;
      for (let r = 1; r <= 4 && v === 255; r++) {
        for (let dy = -r; dy <= r && v === 255; dy++) for (let dx = -r; dx <= r && v === 255; dx++) {
          const t = cellIndex(col + dx, row + dy);
          if (t >= 0 && grid.cells[t] !== 255) { v = grid.cells[t]; k = t; col += dx; row += dy; }
        }
      }
      if (v === 255) { toast('現在地付近に陸地のデータがありません'); return; }
      flyTo(col + 0.5, row + 0.5, Math.max(cam.z, vw / (30 * grid.w / 360)));
      marker = { x: col + 0.5, y: row + 0.5 };
      openPopup(v, `現在地：${fmtLat(lat)}, ${fmtLon(lon)}`, grid.owner[k]);
    }, () => toast('位置情報を取得できませんでした'), { timeout: 10000 });
  });

  // ------------------------------------------------------------------
  // 共有
  //   #d=<30桁のレベル>&p=<ID~レベル>.<ID~レベル>...
  // ------------------------------------------------------------------
  function shareUrl() {
    const places = Object.entries(curPlaces()).map(([id, p]) => `${id}~${p.l}`).join('.');
    return `${location.href.split('#')[0]}#d=${levels().join('')}${places ? `&p=${places}` : ''}`;
  }
  function shareText() {
    const st = computeStats(levels());
    const pl = st.countries ? `、${st.countries}の国・地域` : '';
    return `私の経候値は ${st.score}点（称号：${st.rank}）！ ケッペンの気候区分 ${st.types}/30 種類を体験しました${pl}🌏 #経候値 #ケッペンの気候区分`;
  }

  $('shareX').addEventListener('click', () => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText())}&url=${encodeURIComponent(shareUrl())}`;
    window.open(url, '_blank', 'noopener');
  });

  $('copyUrl').addEventListener('click', async () => {
    const url = shareUrl();
    try { await navigator.clipboard.writeText(url); toast('共有URLをコピーしました'); }
    catch (e) { window.prompt('このURLをコピーしてください', url); }
  });

  $('resetAll').addEventListener('click', () => {
    if (isReadonly()) { toast('共有データの閲覧中はリセットできません'); return; }
    if (!confirm('すべての記録（気候区分・国・地域）をリセットしますか？')) return;
    my = emptyState();
    saveState();
    refresh();
  });

  $('saveImage').addEventListener('click', () => {
    if (!grid) { toast('地図データがありません'); return; }
    const lv = levels();
    const st = computeStats(lv);
    const W = 1600, H = 1080;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const c = out.getContext('2d');
    const font = (w, s) => `${w} ${s}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif`;

    c.fillStyle = '#f4f6fb'; c.fillRect(0, 0, W, H);
    const grad = c.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#0f172a'); grad.addColorStop(1, '#1e3a5f');
    c.fillStyle = grad; c.fillRect(0, 0, W, 150);

    c.fillStyle = '#fff';
    c.font = font(900, 54); c.fillText('経候値', 48, 88);
    c.font = font(500, 20); c.globalAlpha = .7;
    c.fillText('ケッペンの気候区分版 経県値', 52, 124); c.globalAlpha = 1;

    c.textAlign = 'right';
    c.font = font(500, 22); c.globalAlpha = .7; c.fillText(`称号：${st.rank}`, W - 48, 124); c.globalAlpha = 1;
    c.font = '800 72px Inter, sans-serif';
    c.fillText(`${st.score}`, W - 140, 96);
    c.font = font(600, 26); c.globalAlpha = .6; c.fillText('/150', W - 48, 96); c.globalAlpha = 1;
    c.textAlign = 'left';

    const map = renderBase(document.createElement('canvas'), 'level', lv, placeDisplayLevel, null);
    baseDirty = true; // パレットを共有しているため描き直す
    const mx = 40, my0 = 180, mw = W - 80, mh = mw / 2;
    c.save();
    c.beginPath(); if (c.roundRect) c.roundRect(mx, my0, mw, mh, 18); else c.rect(mx, my0, mw, mh); c.clip();
    c.imageSmoothingQuality = 'high';
    c.drawImage(map, mx, my0, mw, mh);
    c.restore();

    let x = 48;
    const ly = my0 + mh + 50;
    c.font = font(700, 22);
    LEVELS.forEach(l => {
      c.fillStyle = l.v > 0 ? l.color : COLOR_UNVISITED;
      c.fillRect(x, ly - 20, 26, 26);
      c.strokeStyle = 'rgba(0,0,0,.15)'; c.strokeRect(x, ly - 20, 26, 26);
      c.fillStyle = '#0f172a';
      const label = `${l.label} ${st.counts[l.v]}`;
      c.fillText(label, x + 36, ly);
      x += 36 + c.measureText(label).width + 30;
    });
    c.textAlign = 'right';
    c.fillStyle = '#475569';
    c.font = font(500, 20);
    c.fillText(`体験した気候 ${st.types}/30 ・ 陸地面積の ${st.share.toFixed(1)}%${st.countries ? ` ・ ${st.countries}の国・地域` : ''}`, W - 48, ly);
    c.textAlign = 'left';
    c.fillStyle = '#94a3b8';
    c.font = font(400, 15);
    c.fillText('地図データ: Köppen-Geiger 1986–2010 (Kottek et al. 2006; Rubel et al. 2017) / Natural Earth', 48, H - 24);
    requestDraw();

    const a = document.createElement('a');
    a.download = `keikouchi_${st.score}.png`;
    a.href = out.toDataURL('image/png');
    a.click();
    toast('画像を保存しました');
  });

  // ------------------------------------------------------------------
  // タイムライン JSON 取込機能
  // ------------------------------------------------------------------
  const tlModal = $('timelineModal');
  const tlDrop = $('tlDrop');
  const tlFile = $('tlFile');
  const tlPickBtn = $('tlPickBtn');
  const tlPreviewWrap = $('tlPreviewWrap');
  let tlPendingResult = null;

  function cellOfLatLng(lat, lon) {
    if (!grid) return -1;
    const col = Math.floor((lon + 180) * grid.w / 360);
    const row = Math.floor((90 - lat) * grid.h / 180);
    return cellIndex(col, row);
  }

  function snapCell(k, maxR = 2) {
    if (!grid || k < 0) return -1;
    if (grid.cells[k] !== 255) return k;
    const w = grid.w, h = grid.h;
    const c0 = k % w, r0 = Math.floor(k / w);
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const ry = r0 + dy;
        if (ry < 0 || ry >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const cx = ((c0 + dx) % w + w) % w;
          const idx = ry * w + cx;
          if (grid.cells[idx] !== 255) return idx;
        }
      }
    }
    return -1;
  }

  function openTimelineModal() {
    if (isReadonly()) { toast('共有データの閲覧中は編集できません'); return; }
    closePopup();
    closePlacePopup();
    tlPendingResult = null;
    tlPreviewWrap.hidden = true;
    $('tlClimateList').innerHTML = '';
    $('tlPlaceList').innerHTML = '';
    tlModal.hidden = false;
    showBackdrop(true);
  }

  function closeTimelineModal() {
    tlModal.hidden = true;
    tlPendingResult = null;
    showBackdrop(false);
  }

  $('timelineOpen').addEventListener('click', openTimelineModal);
  $('timelineClose').addEventListener('click', closeTimelineModal);
  $('tlCancel').addEventListener('click', closeTimelineModal);
  tlPickBtn.addEventListener('click', () => tlFile.click());
  tlDrop.addEventListener('click', e => {
    if (e.target !== tlPickBtn) tlFile.click();
  });

  tlDrop.addEventListener('dragover', e => {
    e.preventDefault();
    tlDrop.classList.add('dragover');
  });
  tlDrop.addEventListener('dragleave', () => tlDrop.classList.remove('dragover'));
  tlDrop.addEventListener('drop', e => {
    e.preventDefault();
    tlDrop.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      handleTimelineFiles(e.dataTransfer.files);
    }
  });

  tlFile.addEventListener('change', () => {
    if (tlFile.files && tlFile.files.length) {
      handleTimelineFiles(tlFile.files);
      tlFile.value = '';
    }
  });

  async function handleTimelineFiles(fileList) {
    if (!window.Timeline) {
      toast('タイムライン解析ライブラリがロードされていません');
      return;
    }
    const jsons = [];
    toast('ファイルを読み込んでいます…');
    for (const f of fileList) {
      try {
        const text = await f.text();
        const j = JSON.parse(text);
        jsons.push(j);
      } catch (err) {
        console.warn('JSON パース失敗:', f.name, err);
      }
    }
    if (!jsons.length) {
      toast('有効な JSON ファイルが見つかりませんでした');
      return;
    }

    const events = window.Timeline.parse(jsons);
    if (!events.formats.length && !events.visits.length && !events.passes.length && !events.raw.length) {
      toast('タイムラインの位置情報データを検出できませんでした');
      return;
    }

    // グリッドと突合して集計
    const analyzed = window.Timeline.analyze(events, {
      cellOf: cellOfLatLng,
      snap: snapCell,
      homeNights: 30,
    });

    // 気候区分ごとの最大レベル
    const climMax = new Array(N).fill(0);
    // 国・地域ごとの最大レベル
    const placeMax = new Uint8Array(NP);

    for (const [cell, lv] of analyzed.level) {
      if (cell < 0 || lv <= 0) continue;
      const c = grid.cells[cell];
      if (c >= 0 && c < N && lv > climMax[c]) climMax[c] = lv;
      const o = grid.owner[cell];
      if (o !== NONE && o < NP && lv > placeMax[o]) placeMax[o] = lv;
    }

    // 親（国）にも子の最大レベルを反映
    for (let k = 0; k < NP; k++) {
      if (PARENT[k] >= 0 && placeMax[k] > placeMax[PARENT[k]]) {
        placeMax[PARENT[k]] = placeMax[k];
      }
    }

    tlPendingResult = { analyzed, climMax, placeMax, formats: events.formats };
    renderTimelinePreview();
  }

  function renderTimelinePreview() {
    if (!tlPendingResult) return;
    const { analyzed, climMax, placeMax, formats } = tlPendingResult;
    const mode = $('tlMergeMode').value; // 'merge' or 'replace'

    // サマリーテキスト
    const fmtList = formats.length ? formats.join(' / ') : '検出形式';
    const dateRange = (analyzed.stats.from && analyzed.stats.to)
      ? `${new Date(analyzed.stats.from).toLocaleDateString()} 〜 ${new Date(analyzed.stats.to).toLocaleDateString()}`
      : '期間不明';
    $('tlSummary').innerHTML = `
      <div><b>解析結果：</b> 形式: <code>${esc(fmtList)}</code> (${analyzed.stats.visits + analyzed.stats.rawVisits}箇所の滞在 / 期間: ${dateRange})</div>
      <div style="font-size:12px;color:var(--ink-3);margin-top:4px">
        訪問・宿泊・空港・移動ルートから気候区分・国を判定しました。
      </div>
    `;

    // 気候区分リスト
    const climDiffs = [];
    for (let i = 0; i < N; i++) {
      const detected = climMax[i];
      if (detected <= 0) continue;
      const current = curLevels[i];
      if (mode === 'replace' || detected > current) {
        climDiffs.push({
          idx: i,
          code: CLIMATES[i].code,
          name: CLIMATES[i].name,
          color: CLIMATES[i].color,
          cur: current,
          next: detected,
        });
      }
    }
    climDiffs.sort((a, b) => b.next - a.next || a.code.localeCompare(b.code));
    $('tlClimateCount').textContent = climDiffs.length;
    $('tlClimateList').innerHTML = climDiffs.length ? climDiffs.map(d => `
      <div class="tl-diff-item">
        <span class="mini-cl" style="background:${d.color};color:${textOn(d.color)}">${d.code}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</span>
        <span class="tl-diff-badge" style="background:${LV[d.next].color}">${LV[d.next].label}</span>
        ${d.cur > 0 && mode === 'merge' ? `<span class="tl-diff-up">▲+${d.next - d.cur}</span>` : ''}
      </div>
    `).join('') : '<div style="font-size:12px;color:var(--ink-3);padding:12px;text-align:center">新しく追加・上昇する気候区分はありません</div>';

    // 国・地域リスト
    const placeDiffs = [];
    for (let k = 0; k < NP; k++) {
      const detected = placeMax[k];
      if (detected <= 0) continue;
      const current = curPlaceLv[k];
      if (mode === 'replace' || detected > current) {
        placeDiffs.push({
          idx: k,
          id: PL[k].id,
          name: placeFullName(k),
          cur: current,
          next: detected,
        });
      }
    }
    placeDiffs.sort((a, b) => b.next - a.next || a.name.localeCompare(b.name));
    $('tlPlaceCount').textContent = placeDiffs.length;
    $('tlPlaceList').innerHTML = placeDiffs.length ? placeDiffs.map(d => `
      <div class="tl-diff-item">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</span>
        <span class="tl-diff-badge" style="background:${LV[d.next].color}">${LV[d.next].label}</span>
        ${d.cur > 0 && mode === 'merge' ? `<span class="tl-diff-up">▲+${d.next - d.cur}</span>` : ''}
      </div>
    `).join('') : '<div style="font-size:12px;color:var(--ink-3);padding:12px;text-align:center">新しく追加・上昇する国・地域はありません</div>';

    tlPreviewWrap.hidden = false;
  }

  $('tlMergeMode').addEventListener('change', renderTimelinePreview);

  $('tlApply').addEventListener('click', () => {
    if (!tlPendingResult) return;
    const { climMax, placeMax } = tlPendingResult;
    const mode = $('tlMergeMode').value;

    if (mode === 'replace') {
      my = emptyState();
    }

    // 気候手動記録の更新
    for (let i = 0; i < N; i++) {
      if (climMax[i] > 0) {
        my.manual[i] = Math.max(my.manual[i], climMax[i]);
      }
    }

    // 国・地域の更新
    for (let k = 0; k < NP; k++) {
      if (placeMax[k] > 0) {
        const id = PL[k].id;
        const cur = my.places[id];
        const nextLv = cur ? Math.max(cur.l, placeMax[k]) : placeMax[k];
        const codes = cur ? cur.c : defaultCodes(PL[k]);
        my.places[id] = { l: nextLv, c: codes };
      }
    }

    saveState();
    refresh();
    closeTimelineModal();
    toast(`タイムラインのデータを反映しました！経候値: ${computeStats(effectiveLevels(my)).score}点`);
  });

  function parseHash() {
    const h = location.hash.replace(/^#/, '');
    const params = new URLSearchParams(h);
    const d = params.get('d');
    if (!d || !new RegExp(`^[0-5]{${N}}$`).test(d)) return null;
    const places = {};
    (params.get('p') || '').split('.').forEach(tok => {
      const m = tok.match(/^(.+)~([1-5])$/);
      if (m && PL_IDX[m[1]] !== undefined) places[m[1]] = { l: Number(m[2]), c: [] };
    });
    return { levels: d.split('').map(Number), places };
  }
  function applyHash() {
    const s = parseHash();
    const mine = effectiveLevels(my).join('');
    const minePlaces = Object.entries(my.places).map(([id, p]) => `${id}~${p.l}`).sort().join('.');
    const sPlaces = s ? Object.entries(s.places).map(([id, p]) => `${id}~${p.l}`).sort().join('.') : '';
    if (s && (s.levels.join('') !== mine || sPlaces !== minePlaces)) {
      shared = s;
      $('sharedBanner').hidden = false;
    } else {
      shared = null;
      $('sharedBanner').hidden = true;
    }
    closePopup(); closePlacePopup();
    refresh();
  }
  function exitShared() {
    history.replaceState(null, '', location.href.split('#')[0]);
    applyHash();
  }
  $('closeShared').addEventListener('click', exitShared);
  $('adoptShared').addEventListener('click', () => {
    if (!confirm('現在の自分の記録を、表示中の共有データで上書きしますか？')) return;
    my = { manual: shared.levels.slice(), places: JSON.parse(JSON.stringify(shared.places)) };
    saveState();
    exitShared();
    toast('共有データを自分の記録にしました');
  });
  window.addEventListener('hashchange', applyHash);

  // ------------------------------------------------------------------
  // 初期化
  // ------------------------------------------------------------------
  buildClimateList();
  buildPlaceList();
  updateLegend();

  if (window.KOPPEN_GRID) {
    grid = decodeGrid(window.KOPPEN_GRID);
    grid.owner = NP ? decodeOwner(PLACES.rle, grid.w * grid.h) : new Uint16Array(grid.w * grid.h).fill(NONE);
    buildKeys();
    $('mapLoading').hidden = true;
  } else {
    $('mapLoading').innerHTML = '地図データ（data.js）が見つかりません。<br><code>npm run build:data</code> を実行して生成してください。<br>リストからの入力は利用できます。';
  }

  new ResizeObserver(resize).observe(wrap);
  resize();
  applyHash();
})();
