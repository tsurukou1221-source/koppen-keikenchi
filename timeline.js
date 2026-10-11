/* Googleマップ タイムライン（JSON）の解析 — DOM に依存しない純粋関数
 *
 * 対応形式
 *  A. Android 端末からのエクスポート（Timeline.json）     { semanticSegments: [...], rawSignals: [...], userLocationProfile: {...} }
 *  B. iPhone アプリからのエクスポート（location-history.json） [ { startTime, endTime, visit | activity | timelinePath }, ... ]
 *  C. 旧 Google Takeout「Semantic Location History」（月別） { timelineObjects: [ { placeVisit | activitySegment } ] }
 *  D. 旧 Google Takeout「Records.json」                        { locations: [ { latitudeE7, longitudeE7, timestamp } ] }
 */
(function (root) {
  'use strict';

  const HOME_RE = /^(INFERRED_)?HOME$|^TYPE_HOME$/i;
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;

  // ---------------- 値のパース ----------------
  function fixE7(v) {
    let n = Number(v);
    if (n > 1800000000) n -= 4294967296; // 古いデータの符号なし表現
    return n / 1e7;
  }
  function valid(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    if (lat === 0 && lon === 0) return null;
    return { lat, lon };
  }
  function parseLatLng(v) {
    if (v == null) return null;
    if (typeof v === 'string') {
      // "35.6812°, 139.7671°" / "geo:35.6812,139.7671" / "35.68,139.76"
      const m = v.match(/(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)/);
      return m ? valid(parseFloat(m[1]), parseFloat(m[2])) : null;
    }
    if (typeof v !== 'object') return null;
    if (v.latitudeE7 != null) return valid(fixE7(v.latitudeE7), fixE7(v.longitudeE7));
    if (v.latE7 != null) return valid(fixE7(v.latE7), fixE7(v.lngE7));
    if (v.latLng != null) return parseLatLng(v.latLng);
    if (v.LatLng != null) return parseLatLng(v.LatLng);
    if (v.point != null) return parseLatLng(v.point);
    if (v.placeLocation != null) return parseLatLng(v.placeLocation);
    if (v.location != null) return parseLatLng(v.location);
    if (v.lat != null && (v.lng != null || v.lon != null)) return valid(Number(v.lat), Number(v.lng != null ? v.lng : v.lon));
    if (v.latitude != null && v.longitude != null) return valid(Number(v.latitude), Number(v.longitude));
    return null;
  }
  /** → { t: ミリ秒, off: UTC からのオフセット（分）または null } */
  function parseTime(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' || /^\d+$/.test(v)) {
      const n = Number(v);
      return { t: n > 1e11 ? n : n * 1000, off: null };
    }
    const t = Date.parse(v);
    if (!Number.isFinite(t)) return null;
    const m = String(v).match(/([+-])(\d{2}):?(\d{2})$/);
    return { t, off: m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null };
  }

  // ---------------- 大圏補間 ----------------
  function interpolate(p1, p2, stepDeg) {
    const R = Math.PI / 180;
    const φ1 = p1.lat * R, λ1 = p1.lon * R, φ2 = p2.lat * R, λ2 = p2.lon * R;
    const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
    const n = Math.min(2000, Math.floor(d / R / stepDeg));
    const pts = [];
    if (n < 1 || d === 0) return pts;
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
      const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
      const z = A * Math.sin(φ1) + B * Math.sin(φ2);
      pts.push({ lat: Math.atan2(z, Math.hypot(x, y)) / R, lon: Math.atan2(y, x) / R });
    }
    return pts;
  }

  // ---------------- 形式ごとの読み取り ----------------
  function newOut() {
    return { visits: [], passes: [], lands: [], homes: [], raw: [], seq: [], formats: new Set() };
  }

  function addTrip(out, p1, p2, flying) {
    if (flying) {
      if (p1) out.lands.push(p1);
      if (p2) out.lands.push(p2);
      if (p1 && p2) for (const p of interpolate(p1, p2, 0.25)) out.passes.push({ lat: p.lat, lon: p.lon, air: true });
    } else {
      if (p1) out.passes.push(p1);
      if (p2) out.passes.push(p2);
      if (p1 && p2) for (const p of interpolate(p1, p2, 0.25)) out.passes.push(p);
    }
  }

  /** A / B 共通：semantic segment */
  function readSegment(seg, out) {
    if (!seg || typeof seg !== 'object') return;
    const st = parseTime(seg.startTime), en = parseTime(seg.endTime);
    const off = seg.startTimeTimezoneUtcOffsetMinutes != null ? Number(seg.startTimeTimezoneUtcOffsetMinutes) : st ? st.off : null;
    if (seg.visit) {
      const tc = seg.visit.topCandidate || seg.visit;
      const ll = parseLatLng(tc.placeLocation != null ? tc.placeLocation : tc.location);
      if (ll && st && en) {
        const v = { lat: ll.lat, lon: ll.lon, s: st.t, e: en.t, off, home: HOME_RE.test(tc.semanticType || '') };
        out.visits.push(v);
        out.seq.push({ s: st.t, v });
      }
    }
    if (seg.activity) {
      const a = seg.activity;
      const type = String((a.topCandidate && a.topCandidate.type) || a.activityType || '').toUpperCase();
      const flying = type === 'FLYING';
      addTrip(out, parseLatLng(a.start), parseLatLng(a.end), flying);
      out.seq.push({ s: st ? st.t : 0, act: true, flying });
    }
    if (Array.isArray(seg.timelinePath)) {
      for (const p of seg.timelinePath) { const ll = parseLatLng(p && p.point != null ? p.point : p); if (ll) out.passes.push(ll); }
    }
  }

  function readTakeoutSemantic(json, out) {
    for (const o of json.timelineObjects || []) {
      if (o.placeVisit) {
        const pv = o.placeVisit, d = pv.duration || {};
        const ll = parseLatLng(pv.location);
        const st = parseTime(d.startTimestamp != null ? d.startTimestamp : d.startTimestampMs);
        const en = parseTime(d.endTimestamp != null ? d.endTimestamp : d.endTimestampMs);
        if (ll && st && en) {
          const home = HOME_RE.test((pv.location && pv.location.semanticType) || '') || HOME_RE.test(pv.semanticType || '');
          const v = { lat: ll.lat, lon: ll.lon, s: st.t, e: en.t, off: st.off, home };
          out.visits.push(v);
          out.seq.push({ s: st.t, v });
        }
      }
      if (o.activitySegment) {
        const as = o.activitySegment;
        const flying = String(as.activityType || '').toUpperCase() === 'FLYING';
        addTrip(out, parseLatLng(as.startLocation), parseLatLng(as.endLocation), flying);
        const st = parseTime(as.duration && (as.duration.startTimestamp != null ? as.duration.startTimestamp : as.duration.startTimestampMs));
        out.seq.push({ s: st ? st.t : 0, act: true, flying });
        if (!flying) {
          for (const w of (as.waypointPath && as.waypointPath.waypoints) || []) { const ll = parseLatLng(w); if (ll) out.passes.push(ll); }
          for (const w of (as.simplifiedRawPath && as.simplifiedRawPath.points) || []) { const ll = parseLatLng(w); if (ll) out.passes.push(ll); }
        }
      }
    }
  }

  function readRaw(list, out, getPos, getTime) {
    for (const r of list || []) {
      const ll = parseLatLng(getPos(r));
      const t = parseTime(getTime(r));
      if (ll && t) out.raw.push({ lat: ll.lat, lon: ll.lon, t: t.t });
    }
  }

  /** 1ファイル分の JSON を読み取る。未知の形式なら false */
  function read(json, out) {
    if (Array.isArray(json)) {
      if (json.length && json[0] && (json[0].latitudeE7 != null || json[0].timestampMs != null)) {
        out.formats.add('Records.json');
        readRaw(json, out, r => r, r => r.timestamp != null ? r.timestamp : r.timestampMs);
      } else {
        out.formats.add('iPhone タイムライン');
        json.forEach(s => readSegment(s, out));
      }
      return true;
    }
    if (!json || typeof json !== 'object') return false;
    let ok = false;
    if (Array.isArray(json.semanticSegments)) {
      out.formats.add('Android タイムライン');
      json.semanticSegments.forEach(s => readSegment(s, out));
      ok = true;
    }
    if (Array.isArray(json.rawSignals)) {
      readRaw(json.rawSignals.filter(r => r && r.position), out, r => r.position.LatLng || r.position.latLng, r => r.position.timestamp);
      ok = true;
    }
    if (json.userLocationProfile && Array.isArray(json.userLocationProfile.frequentPlaces)) {
      for (const fp of json.userLocationProfile.frequentPlaces) {
        if (HOME_RE.test(fp.label || '')) { const ll = parseLatLng(fp.placeLocation); if (ll) out.homes.push(ll); }
      }
      ok = true;
    }
    if (Array.isArray(json.timelineObjects)) {
      out.formats.add('Takeout 月別履歴');
      readTakeoutSemantic(json, out);
      ok = true;
    }
    if (Array.isArray(json.locations)) {
      out.formats.add('Records.json');
      readRaw(json.locations, out, r => r, r => r.timestamp != null ? r.timestamp : r.timestampMs);
      ok = true;
    }
    return ok;
  }

  /** 複数ファイルの JSON → イベント */
  function parse(jsons) {
    const out = newOut();
    let unknown = 0;
    for (const j of jsons) if (!read(j, out)) unknown++;
    // 乗り継ぎ：前後が飛行機の移動で、4時間未満の滞在
    out.seq.sort((a, b) => a.s - b.s);
    for (let i = 1; i < out.seq.length - 1; i++) {
      const it = out.seq[i];
      if (!it.v) continue;
      if (it.v.e - it.v.s < 4 * HOUR && out.seq[i - 1].flying && out.seq[i + 1].flying) it.v.layover = true;
    }
    delete out.seq;
    out.unknown = unknown;
    out.formats = [...out.formats];
    return out;
  }

  // ---------------- 集計 ----------------
  /** 区間 [s, e] に含まれる「現地時刻 午前3時」の日付（通し日数）一覧 */
  function nightDays(s, e, offMin) {
    const o = offMin * MIN, T3 = 3 * HOUR;
    const ls = s + o, le = e + o;
    let t = Math.floor((ls - T3) / DAY) * DAY + T3;
    if (t < ls) t += DAY;
    const days = [];
    for (; t <= le && days.length < 5000; t += DAY) days.push(Math.floor(t / DAY));
    return days;
  }

  /**
   * イベント → セルごとのレベル
   * @param ev     parse() の結果
   * @param opts   { cellOf(lat, lon) → セル番号, snap(セル番号, 半径) → 陸地セル番号 | -1, homeNights: 住んだとみなす宿泊数 }
   */
  function analyze(ev, opts) {
    const { cellOf, snap } = opts;
    const homeNights = opts.homeNights || 30;
    const level = new Map(), nights = new Map();
    const up = (k, l) => { if (k >= 0 && (level.get(k) || 0) < l) level.set(k, l); };
    const at = (p, r) => snap(cellOf(p.lat, p.lon), r);
    let tMin = Infinity, tMax = -Infinity;
    const seen = t => { if (t < tMin) tMin = t; if (t > tMax) tMax = t; };

    // 生データ（Records.json / rawSignals）を滞在と通過に分解
    const visits = ev.visits.slice();
    let rawPasses = 0;
    if (ev.raw.length) {
      const raw = ev.raw.slice().sort((a, b) => a.t - b.t);
      let i = 0;
      while (i < raw.length) {
        const k = cellOf(raw[i].lat, raw[i].lon);
        let j = i;
        while (j + 1 < raw.length && cellOf(raw[j + 1].lat, raw[j + 1].lon) === k && raw[j + 1].t - raw[j].t < 6 * HOUR) j++;
        const s = raw[i].t, e = raw[j].t;
        seen(s); seen(e);
        if (e - s >= 20 * MIN) visits.push({ lat: raw[i].lat, lon: raw[i].lon, s, e, off: null, home: false });
        else { up(snap(k, 1), 1); rawPasses++; }
        i = j + 1;
      }
    }

    for (const p of ev.passes) up(at(p, p.air ? 0 : 1), 1);
    for (const p of ev.lands) up(at(p, 1), 2);
    for (const p of ev.homes) up(at(p, 2), 5);
    for (const v of visits) {
      const k = at(v, 2);
      seen(v.s); seen(v.e);
      if (k < 0) continue;
      up(k, v.layover ? 2 : 3);
      if (v.home) up(k, 5);
      const off = v.off != null ? v.off : Math.round(v.lon / 15) * 60;
      const days = nightDays(v.s, v.e, off);
      if (days.length) {
        let set = nights.get(k);
        if (!set) nights.set(k, (set = new Set()));
        days.forEach(d => set.add(d));
      }
    }
    for (const [k, set] of nights) up(k, set.size >= homeNights ? 5 : 4);

    return {
      level,
      nights: new Map([...nights].map(([k, s]) => [k, s.size])),
      stats: {
        visits: ev.visits.length,
        rawVisits: visits.length - ev.visits.length,
        passes: ev.passes.length + rawPasses,
        rawPoints: ev.raw.length,
        from: Number.isFinite(tMin) ? tMin : null,
        to: Number.isFinite(tMax) ? tMax : null,
      },
    };
  }

  root.Timeline = { parse, analyze, parseLatLng, parseTime, nightDays };
})(typeof window !== 'undefined' ? window : globalThis);
