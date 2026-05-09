(() => {
  'use strict';

  // ------------------------------------------------------------------
  // CONFIG — tune these freely
  // ------------------------------------------------------------------
  const CONFIG = {
    // Tram journey-time fallbacks (used only when live vehicleId match fails)
    TRAM_FALLBACK_ARENA_TO_ECR_MIN: 9,
    TRAM_FALLBACK_ARENA_TO_BKJ_MIN: 8,

    // Fixed platform-to-platform transfers (not live-trackable)
    TRANSFER_ECR_TRAM_TO_RAIL_MIN: 4,
    TRANSFER_BKJ_TRAM_TO_RAIL_MIN: 2,
    TRANSFER_VIC_TO_BUS_MIN: 4,
    TRANSFER_VIC_TO_TUBE_MIN: 5,

    // Final-leg journey-time fallbacks (used only when vehicleId match fails)
    BUS_52_VIC_TO_RAH_MIN: 14,
    TUBE_VIC_TO_SOUTH_KEN_MIN: 7,

    // Fixed walks (not live-trackable)
    WALK_SKS_TO_RAH_MIN: 11,

    // Refresh cadences (ms)
    TFL_REFRESH_MS: 60_000,
    HUXLEY_REFRESH_MS: 90_000,

    DEPARTURE_COUNT: 5,

    // Sanity bounds for live journey time (minutes); outside → treat as no match
    LIVE_JOURNEY_MIN: 1,
    LIVE_JOURNEY_MAX: 45,
  };

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------
  const STOP_IDS = {
    ECR_TRAM: '940GZZCRECR',
    BKJ_TRAM: '940GZZCRBEK',
    VIC_TUBE: '940GZZLUVIC',
    SKS_TUBE: '940GZZLUSKS', // South Kensington
  };

  const LS = {
    TFL_KEY: 'commute.tflAppKey',
    DARWIN: 'commute.darwinToken',
    ARENA_ID: 'commute.arenaStopId',
  };

  const TFL_BASE = 'https://api.tfl.gov.uk';
  const HUXLEY_BASE = 'https://huxley2.azurewebsites.net';

  // Eastern District-line destinations to exclude when platformName is missing
  const EAST_BLOCKLIST = ['upminster', 'barking', 'tower hill', 'aldgate', 'dagenham', 'plaistow', 'whitechapel'];

  // ------------------------------------------------------------------
  // Shared state — fetchers update slots, renderAll() composes the chain
  // ------------------------------------------------------------------
  const state = {
    arena:   { arrs: null, error: null },
    ecrTram: { arrs: [] },
    bkjTram: { arrs: [] },
    vicTube: { arrs: null, error: null },
    sksTube: { arrs: [] },
    bus52:   { all: null,  error: null },
    railECR: { services: null, error: null, placeholder: false },
    railBKJ: { services: null, error: null, placeholder: false },
  };

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const getTflKey = () => (localStorage.getItem(LS.TFL_KEY) || '').trim();
  const getDarwin = () => (localStorage.getItem(LS.DARWIN) || '').trim();

  function tflUrl(path, params = {}) {
    const url = new URL(TFL_BASE + path);
    const key = getTflKey();
    if (key) params.app_key = key;
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  }

  function fmtClock(date) {
    if (!(date instanceof Date) || isNaN(date)) return '--:--';
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function minsUntil(date) {
    if (!(date instanceof Date) || isNaN(date)) return null;
    return Math.max(0, Math.round((date.getTime() - Date.now()) / 60000));
  }

  // Parse "HH:MM" returning a Date for today (or tomorrow if it's clearly in the past)
  function parseHHMM(s) {
    if (typeof s !== 'string' || !/^\d{1,2}:\d{2}$/.test(s)) return null;
    const [h, m] = s.split(':').map(Number);
    const now = new Date();
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    // If parsed time is more than ~6h in the past, assume it rolls to tomorrow
    if (d.getTime() - now.getTime() < -6 * 3600 * 1000) {
      d.setDate(d.getDate() + 1);
    }
    return d;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function findCallingPoint(service, crs) {
    const portions = (service && service.subsequentCallingPoints) || [];
    for (const p of portions) {
      const cp = (p.callingPoint || []).find(c => c && c.crs === crs);
      if (cp) return cp;
    }
    return null;
  }

  function callingPointTime(cp) {
    if (!cp) return null;
    if (typeof cp.et === 'string' && /^\d{1,2}:\d{2}$/.test(cp.et)) return cp.et;
    if (typeof cp.st === 'string' && /^\d{1,2}:\d{2}$/.test(cp.st)) return cp.st;
    return null;
  }

  // ------------------------------------------------------------------
  // Chain-time helpers (compute "earliest catchable" times across legs)
  // ------------------------------------------------------------------

  // Soonest chained arrival at the destination (e.g. ECR/BKJ) given the next
  // tram from Arena: tram's expected arrival + journey-time + transfer.
  function soonestChainTime(arenaArrs, destArrs, fallbackMin, transferMin) {
    if (!arenaArrs || !arenaArrs.length) return null;
    const a = arenaArrs[0];
    const arenaTime = new Date(a.expectedArrival);
    if (isNaN(arenaTime)) return null;
    const live = liveJourneyMin(a, destArrs || []);
    const journey = live != null ? live : fallbackMin;
    return new Date(arenaTime.getTime() + (journey + transferMin) * 60000);
  }

  // Best estimate of when a Huxley service actually departs (etd if live, else std).
  function railServiceTime(s) {
    if (!s) return null;
    if (s.etd === 'Cancelled') return null;
    const t = (typeof s.etd === 'string' && /^\d{1,2}:\d{2}$/.test(s.etd)) ? s.etd
            : (typeof s.std === 'string' && /^\d{1,2}:\d{2}$/.test(s.std)) ? s.std
            : null;
    return t ? parseHHMM(t) : null;
  }

  function filterRailCatchable(services, earliest) {
    if (!services) return null;
    if (!earliest) return services;
    return services.filter(s => {
      // For cancelled trains, fall back to scheduled time so they still surface in the user's window.
      const t = (s.etd === 'Cancelled') ? parseHHMM(s.std) : railServiceTime(s);
      if (!t) return false;
      return t.getTime() >= earliest.getTime();
    });
  }

  function earliestVicArrival(...serviceLists) {
    let min = null;
    for (const list of serviceLists) {
      for (const s of (list || [])) {
        if (!s || s.etd === 'Cancelled') continue;
        const t = callingPointTime(findCallingPoint(s, 'VIC'));
        if (!t) continue;
        const d = parseHHMM(t);
        if (!d) continue;
        const ms = d.getTime();
        if (min == null || ms < min) min = ms;
      }
    }
    return min == null ? null : new Date(min);
  }

  function filterArrivalsByTime(arrs, minTime) {
    if (!arrs) return null;
    if (!minTime) return arrs;
    return arrs.filter(a => Date.parse(a.expectedArrival) >= minTime.getTime());
  }

  // ------------------------------------------------------------------
  // Arena stop ID discovery (cached)
  // ------------------------------------------------------------------
  async function getArenaStopId() {
    const cached = localStorage.getItem(LS.ARENA_ID);
    if (cached) return cached;
    const data = await fetchJson(tflUrl('/StopPoint/Search/Arena', { modes: 'tram' }));
    const matches = (data && data.matches) || [];
    // Prefer an exact-name "Arena" tram stop
    const exact = matches.find(m => /^arena/i.test(m.name) && (m.modes || []).includes('tram'));
    const pick = exact || matches.find(m => (m.modes || []).includes('tram'));
    if (!pick) throw new Error('Arena tram stop not found in StopPoint search');
    localStorage.setItem(LS.ARENA_ID, pick.id);
    return pick.id;
  }

  // ------------------------------------------------------------------
  // Filters
  // ------------------------------------------------------------------
  function destText(a) {
    return ((a.destinationName || '') + ' ' + (a.towards || '')).toLowerCase();
  }

  function isTramTowardsECR(a) {
    const t = destText(a);
    return t.includes('wimbledon') || t.includes('therapia');
  }
  function isTramTowardsBKJ(a) {
    return destText(a).includes('beckenham');
  }

  function isWestboundDistrictCircle(a) {
    if (a.lineId !== 'district' && a.lineId !== 'circle') return false;
    const platform = (a.platformName || '').toLowerCase();
    if (platform.includes('westbound')) return true;
    if (platform.includes('eastbound')) return false;
    // Fallback: exclude obvious eastern destinations
    const t = destText(a);
    return !EAST_BLOCKLIST.some(x => t.includes(x));
  }

  function isBus52OutboundFromVictoria(a) {
    const station = (a.stationName || '').toLowerCase();
    const towards = (a.towards || a.destinationName || '').toLowerCase();
    return station.includes('victoria') && !towards.includes('victoria');
  }

  // ------------------------------------------------------------------
  // Vehicle-ID journey matching
  // ------------------------------------------------------------------
  function liveJourneyMin(arenaArr, destArrivals) {
    if (!arenaArr || !arenaArr.vehicleId) return null;
    const match = destArrivals.find(d => d.vehicleId && d.vehicleId === arenaArr.vehicleId);
    if (!match) return null;
    const aT = Date.parse(arenaArr.expectedArrival);
    const dT = Date.parse(match.expectedArrival);
    if (!Number.isFinite(aT) || !Number.isFinite(dT)) return null;
    const diff = (dT - aT) / 60000;
    if (diff < CONFIG.LIVE_JOURNEY_MIN || diff > CONFIG.LIVE_JOURNEY_MAX) return null;
    return Math.round(diff);
  }

  // ------------------------------------------------------------------
  // Status severity classification
  // ------------------------------------------------------------------
  function statusClass(sev) {
    if (sev === 10 || sev === 8 || sev === 18) return 'good';
    if ([1, 2, 3, 4, 5, 6, 11, 16, 20].includes(sev)) return 'bad';
    return 'warn';
  }

  // ------------------------------------------------------------------
  // Skeleton rows
  // ------------------------------------------------------------------
  function renderSkeletons() {
    $$('.rows[data-skeleton]').forEach(el => {
      const n = parseInt(el.dataset.skeleton, 10) || 5;
      el.innerHTML = Array.from({ length: n }, () => '<div class="row skel"></div>').join('');
    });
  }

  function renderEmpty(containerId, message) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '<div class="row empty">' + escapeHtml(message) + '</div>';
  }

  function renderError(containerId, message) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '<div class="row error">' + escapeHtml(message) + '</div>';
  }

  function renderRailPlaceholder(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML =
      '<div class="row placeholder">' +
      'No Darwin token configured.' +
      '<br><a href="#" data-open-settings>Add Darwin token in settings &darr;</a>' +
      '</div>';
  }

  // ------------------------------------------------------------------
  // Renderers
  // ------------------------------------------------------------------
  function renderTramColumn(containerId, arenaArrivals, destArrivals, fallbackMin, transferMin, mainlineLabel) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!arenaArrivals.length) {
      renderEmpty(containerId, 'No trams in the next hour');
      return;
    }
    el.innerHTML = arenaArrivals.map(a => {
      const arenaTime = new Date(a.expectedArrival);
      const live = liveJourneyMin(a, destArrivals);
      const journey = live != null ? live : fallbackMin;
      const isLive = live != null;
      const mainline = new Date(arenaTime.getTime() + (journey + transferMin) * 60000);
      const mins = minsUntil(arenaTime);
      const dest = a.destinationName || a.towards || '';
      return (
        '<div class="row">' +
          '<div class="time">' + escapeHtml(fmtClock(arenaTime)) + '</div>' +
          '<div class="dest">' + escapeHtml(dest) + '</div>' +
          '<div class="meta">' +
            '<span class="mins">' + (mins === 0 ? 'due' : 'in ' + mins + 'm') + '</span>' +
            '<span class="jt' + (isLive ? '' : ' fallback') + '">' +
              (isLive ? '' : '~') + journey + 'm' +
            '</span>' +
            '<span class="arr">&rarr; ' + escapeHtml(mainlineLabel) + ' plat ' + escapeHtml(fmtClock(mainline)) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderRailColumn(containerId, services) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!services || !services.length) {
      renderEmpty(containerId, 'No trains in the next hour');
      return;
    }
    el.innerHTML = services.slice(0, CONFIG.DEPARTURE_COUNT).map(s => {
      const cancelled = (s.etd === 'Cancelled');
      let timeStr;
      let dateForMins = null;
      if (cancelled) {
        timeStr = 'Cncl';
      } else if (typeof s.etd === 'string' && /^\d{1,2}:\d{2}$/.test(s.etd)) {
        timeStr = s.etd;
        dateForMins = parseHHMM(s.etd);
      } else if (typeof s.std === 'string' && /^\d{1,2}:\d{2}$/.test(s.std)) {
        timeStr = s.std;
        dateForMins = parseHHMM(s.std);
      } else {
        timeStr = s.std || '--:--';
      }
      const platform = s.platform ? 'Plat ' + s.platform : 'Plat ?';
      const dest = (s.destination && s.destination[0] && s.destination[0].locationName) || 'Victoria';
      const operator = s.operator || '';
      const mins = dateForMins ? minsUntil(dateForMins) : null;
      const minsHtml = (mins == null)
        ? ''
        : '<span class="mins">' + (mins === 0 ? 'due' : 'in ' + mins + 'm') + '</span>';
      const arrAtVic = cancelled ? null : callingPointTime(findCallingPoint(s, 'VIC'));
      const arrHtml = arrAtVic
        ? '<span class="arr">&rarr; VIC ' + escapeHtml(arrAtVic) + '</span>'
        : '';
      return (
        '<div class="row' + (cancelled ? ' cancelled' : '') + '">' +
          '<div class="time">' + escapeHtml(timeStr) + '</div>' +
          '<div class="dest">' + escapeHtml(dest) + (operator ? ' <span style="color:var(--dim);font-size:0.65rem">' + escapeHtml(operator) + '</span>' : '') + '</div>' +
          '<div class="meta">' +
            minsHtml +
            '<span class="pl">' + escapeHtml(platform) + '</span>' +
            arrHtml +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function shortPlatform(name) {
    if (!name) return '';
    const m = name.match(/platform\s+(\w+)/i);
    if (m) return 'Plat ' + m[1];
    return name; // e.g. "Stop A"
  }

  // Generic "from Vic to final stop" renderer with vehicleId journey-time match.
  // walkMin is added to the arrival ETA but NOT to the live journey chip
  // (the chip stays a "live trackable" signal; the walk is a fixed addition).
  function renderFinalLegColumn(containerId, fromArrivals, finalArrivals, fallbackMin, finalLabel, walkMin = 0) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!fromArrivals.length) {
      renderEmpty(containerId, 'No departures in the next hour');
      return;
    }
    el.innerHTML = fromArrivals.slice(0, CONFIG.DEPARTURE_COUNT).map(a => {
      const t = new Date(a.expectedArrival);
      const mins = minsUntil(t);
      const dest = a.destinationName || a.towards || a.lineName || '';
      const platform = shortPlatform(a.platformName);
      const platHtml = platform ? '<span class="pl">' + escapeHtml(platform) + '</span>' : '';
      const live = liveJourneyMin(a, finalArrivals);
      const journey = live != null ? live : fallbackMin;
      const isLive = live != null;
      const arr = new Date(t.getTime() + (journey + walkMin) * 60000);
      return (
        '<div class="row">' +
          '<div class="time">' + escapeHtml(fmtClock(t)) + '</div>' +
          '<div class="dest">' + escapeHtml(dest) + '</div>' +
          '<div class="meta">' +
            '<span class="mins">' + (mins === 0 ? 'due' : 'in ' + mins + 'm') + '</span>' +
            platHtml +
            '<span class="jt' + (isLive ? '' : ' fallback') + '">' +
              (isLive ? '' : '~') + journey + 'm' +
            '</span>' +
            (walkMin > 0 ? '<span class="jt fallback">+' + walkMin + 'm walk</span>' : '') +
            '<span class="arr">&rarr; ' + escapeHtml(finalLabel) + ' ' + escapeHtml(fmtClock(arr)) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderStatusBar(lines) {
    const el = $('#status-bar');
    if (!el) return;
    if (!lines || !lines.length) {
      el.innerHTML = '<div class="status-pill warn"><span class="name">status</span><span class="desc">unavailable</span></div>';
      return;
    }
    el.innerHTML = lines.map(line => {
      const ls = (line.lineStatuses && line.lineStatuses[0]) || {};
      const sev = ls.statusSeverity;
      const desc = ls.statusSeverityDescription || 'Unknown';
      const cls = statusClass(sev);
      return (
        '<div class="status-pill ' + cls + '">' +
          '<span class="name">' + escapeHtml(line.name || line.id) + '</span>' +
          '<span class="desc">' + escapeHtml(desc) + '</span>' +
        '</div>'
      );
    }).join('');
  }

  // ------------------------------------------------------------------
  // renderAll — compose chain timings from state, render every board
  // ------------------------------------------------------------------
  function renderAll() {
    // ===== Trams =====
    if (state.arena.error) {
      renderError('tram-ecr', state.arena.error);
      renderError('tram-bkj', state.arena.error);
    } else if (state.arena.arrs != null) {
      const arrs = state.arena.arrs;
      const showECR = arrs.filter(isTramTowardsECR).slice(0, CONFIG.DEPARTURE_COUNT);
      const showBKJ = arrs.filter(isTramTowardsBKJ).slice(0, CONFIG.DEPARTURE_COUNT);
      renderTramColumn('tram-ecr', showECR, state.ecrTram.arrs || [],
        CONFIG.TRAM_FALLBACK_ARENA_TO_ECR_MIN, CONFIG.TRANSFER_ECR_TRAM_TO_RAIL_MIN, 'ECR');
      renderTramColumn('tram-bkj', showBKJ, state.bkjTram.arrs || [],
        CONFIG.TRAM_FALLBACK_ARENA_TO_BKJ_MIN, CONFIG.TRANSFER_BKJ_TRAM_TO_RAIL_MIN, 'BKJ');
    }

    // ===== Earliest catchable arrival at ECR / BKJ =====
    const arenaArrs = state.arena.arrs || [];
    const towardsECRAll = arenaArrs.filter(isTramTowardsECR);
    const towardsBKJAll = arenaArrs.filter(isTramTowardsBKJ);
    const earliestECR = soonestChainTime(towardsECRAll, state.ecrTram.arrs,
      CONFIG.TRAM_FALLBACK_ARENA_TO_ECR_MIN, CONFIG.TRANSFER_ECR_TRAM_TO_RAIL_MIN);
    const earliestBKJ = soonestChainTime(towardsBKJAll, state.bkjTram.arrs,
      CONFIG.TRAM_FALLBACK_ARENA_TO_BKJ_MIN, CONFIG.TRANSFER_BKJ_TRAM_TO_RAIL_MIN);

    // ===== Rail =====
    const ecrFiltered = renderRailBoard('rail-ecr', state.railECR, earliestECR);
    const bkjFiltered = renderRailBoard('rail-bkj', state.railBKJ, earliestBKJ);

    // ===== Earliest catchable arrival at VIC =====
    const earliestVIC = earliestVicArrival(ecrFiltered, bkjFiltered);
    const earliestForBus  = earliestVIC ? new Date(earliestVIC.getTime() + CONFIG.TRANSFER_VIC_TO_BUS_MIN  * 60000) : null;
    const earliestForTube = earliestVIC ? new Date(earliestVIC.getTime() + CONFIG.TRANSFER_VIC_TO_TUBE_MIN * 60000) : null;

    // ===== Final leg: Bus 52 from Victoria =====
    if (state.bus52.error) {
      renderError('bus-52', state.bus52.error);
    } else if (state.bus52.all != null) {
      const all = state.bus52.all;
      const vicArrs = all.filter(isBus52OutboundFromVictoria).sort(sortByExpected);
      const filtered = filterArrivalsByTime(vicArrs, earliestForBus);
      const rahArrs = all.filter(a =>
        (a.stationName || '').toLowerCase().includes('royal albert hall') &&
        !(a.towards || '').toLowerCase().includes('victoria')
      );
      if (!filtered.length && earliestForBus) {
        renderEmpty('bus-52', 'No catchable buses');
      } else {
        renderFinalLegColumn('bus-52', filtered, rahArrs, CONFIG.BUS_52_VIC_TO_RAH_MIN, 'RAH');
      }
    }

    // ===== Final leg: District/Circle from Victoria =====
    if (state.vicTube.error) {
      renderError('tube-vic', state.vicTube.error);
    } else if (state.vicTube.arrs != null) {
      const filtered = filterArrivalsByTime(state.vicTube.arrs, earliestForTube);
      if (!filtered.length && earliestForTube) {
        renderEmpty('tube-vic', 'No catchable tubes');
      } else {
        renderFinalLegColumn('tube-vic', filtered, state.sksTube.arrs || [],
          CONFIG.TUBE_VIC_TO_SOUTH_KEN_MIN, 'RAH', CONFIG.WALK_SKS_TO_RAH_MIN);
      }
    }
  }

  // Render a single rail board and return the catchable services it actually shows
  // (used to compute the next-leg chain time).
  function renderRailBoard(containerId, slot, earliest) {
    if (slot.placeholder) {
      renderRailPlaceholder(containerId);
      return null;
    }
    if (slot.error) {
      renderError(containerId, slot.error);
      return null;
    }
    if (slot.services == null) return null; // still loading
    const filtered = filterRailCatchable(slot.services, earliest);
    if (!filtered.length && earliest) {
      renderEmpty(containerId, 'No catchable trains');
      return filtered;
    }
    renderRailColumn(containerId, filtered);
    return filtered;
  }

  function renderStatusError() {
    const el = $('#status-bar');
    if (!el) return;
    el.innerHTML =
      '<div class="status-pill warn"><span class="name">tram</span><span class="desc">status unavailable</span></div>' +
      '<div class="status-pill warn"><span class="name">district</span><span class="desc">status unavailable</span></div>' +
      '<div class="status-pill warn"><span class="name">circle</span><span class="desc">status unavailable</span></div>';
  }

  // ------------------------------------------------------------------
  // Fetchers
  // ------------------------------------------------------------------
  function sortByExpected(a, b) {
    return Date.parse(a.expectedArrival) - Date.parse(b.expectedArrival);
  }

  async function fetchTflBundle() {
    let arenaId;
    try {
      arenaId = await getArenaStopId();
    } catch (e) {
      console.error('Arena lookup failed', e);
      state.arena = { arrs: null, error: 'Could not find Arena stop' };
      renderAll();
      return;
    }

    const urls = {
      arena:   tflUrl('/StopPoint/' + arenaId + '/Arrivals'),
      ecrTram: tflUrl('/StopPoint/' + STOP_IDS.ECR_TRAM + '/Arrivals'),
      bkjTram: tflUrl('/StopPoint/' + STOP_IDS.BKJ_TRAM + '/Arrivals'),
      vicTube: tflUrl('/StopPoint/' + STOP_IDS.VIC_TUBE + '/Arrivals'),
      sksTube: tflUrl('/StopPoint/' + STOP_IDS.SKS_TUBE + '/Arrivals'),
      bus52:   tflUrl('/Line/52/Arrivals'),
      status:  tflUrl('/Line/tram,district,circle/Status'),
    };

    const settled = await Promise.allSettled(Object.values(urls).map(fetchJson));
    const result = {};
    Object.keys(urls).forEach((k, i) => { result[k] = settled[i]; });

    // Status (rendered directly — not part of the chain)
    if (result.status.status === 'fulfilled') {
      renderStatusBar(result.status.value);
    } else {
      renderStatusError();
    }

    // Arena trams
    if (result.arena.status === 'fulfilled') {
      state.arena = { arrs: (result.arena.value || []).slice().sort(sortByExpected), error: null };
    } else {
      state.arena = { arrs: null, error: 'Could not load Arena arrivals' };
    }
    state.ecrTram.arrs = result.ecrTram.status === 'fulfilled' ? (result.ecrTram.value || []) : [];
    state.bkjTram.arrs = result.bkjTram.status === 'fulfilled' ? (result.bkjTram.value || []) : [];

    // Victoria tube → South Kensington
    if (result.vicTube.status === 'fulfilled') {
      state.vicTube = {
        arrs: (result.vicTube.value || []).filter(isWestboundDistrictCircle).sort(sortByExpected),
        error: null,
      };
    } else {
      state.vicTube = { arrs: null, error: 'Could not load tube arrivals' };
    }
    state.sksTube.arrs = result.sksTube.status === 'fulfilled'
      ? (result.sksTube.value || []).filter(a => a.lineId === 'district' || a.lineId === 'circle')
      : [];

    // 52 bus
    if (result.bus52.status === 'fulfilled') {
      state.bus52 = { all: result.bus52.value || [], error: null };
    } else {
      state.bus52 = { all: null, error: 'Could not load 52 bus arrivals' };
    }

    renderAll();
    setLastUpdated();
  }

  async function fetchHuxley() {
    const token = getDarwin();
    if (!token) {
      state.railECR = { services: null, error: null, placeholder: true };
      state.railBKJ = { services: null, error: null, placeholder: true };
      renderAll();
      return;
    }
    // Fetch a generous window since chain-filtering may discard many earlier services.
    const huxleyCount = Math.max(15, CONFIG.DEPARTURE_COUNT * 3);
    const url = (from, to) =>
      `${HUXLEY_BASE}/departures/${from}/to/${to}/${huxleyCount}?accessToken=${encodeURIComponent(token)}`;

    const [ecr, bkj] = await Promise.allSettled([
      fetchJson(url('ECR', 'VIC')),
      fetchJson(url('BKJ', 'VIC')),
    ]);

    if (ecr.status === 'fulfilled') {
      state.railECR = {
        services: (ecr.value && ecr.value.trainServices) || [],
        error: null,
        placeholder: false,
      };
    } else {
      state.railECR = {
        services: null,
        error: 'Could not load ECR departures (check Darwin token)',
        placeholder: false,
      };
    }

    if (bkj.status === 'fulfilled') {
      state.railBKJ = {
        services: (bkj.value && bkj.value.trainServices) || [],
        error: null,
        placeholder: false,
      };
    } else {
      state.railBKJ = {
        services: null,
        error: 'Could not load BKJ departures (check Darwin token)',
        placeholder: false,
      };
    }

    renderAll();
    setLastUpdated();
  }

  // ------------------------------------------------------------------
  // Schedulers and countdown
  // ------------------------------------------------------------------
  let nextTflAt = 0;
  let nextHuxleyAt = 0;
  let tflTimer = null;
  let huxleyTimer = null;

  function scheduleTfl() {
    if (tflTimer) clearTimeout(tflTimer);
    nextTflAt = Date.now() + CONFIG.TFL_REFRESH_MS;
    tflTimer = setTimeout(async () => {
      try { await fetchTflBundle(); } catch (e) { console.error(e); }
      scheduleTfl();
    }, CONFIG.TFL_REFRESH_MS);
  }

  function scheduleHuxley() {
    if (huxleyTimer) clearTimeout(huxleyTimer);
    nextHuxleyAt = Date.now() + CONFIG.HUXLEY_REFRESH_MS;
    huxleyTimer = setTimeout(async () => {
      try { await fetchHuxley(); } catch (e) { console.error(e); }
      scheduleHuxley();
    }, CONFIG.HUXLEY_REFRESH_MS);
  }

  function tickCountdown() {
    const now = Date.now();
    const next = Math.min(nextTflAt || Infinity, nextHuxleyAt || Infinity);
    if (!Number.isFinite(next)) {
      $('#countdown').textContent = '--s';
      return;
    }
    const sec = Math.max(0, Math.round((next - now) / 1000));
    $('#countdown').textContent = sec + 's';
  }

  function setLastUpdated() {
    const el = $('#last-updated');
    if (el) el.textContent = 'updated ' + fmtClock(new Date());
  }

  async function refreshAll() {
    const btn = $('#refresh-btn');
    btn.classList.add('spinning');
    try {
      await Promise.all([fetchTflBundle(), fetchHuxley()]);
    } catch (e) {
      console.error(e);
    } finally {
      btn.classList.remove('spinning');
      scheduleTfl();
      scheduleHuxley();
      tickCountdown();
    }
  }

  // ------------------------------------------------------------------
  // Settings UI
  // ------------------------------------------------------------------
  function loadSettingsIntoForm() {
    $('#tfl-key').value = getTflKey();
    $('#darwin-token').value = getDarwin();
  }

  function openSettings() {
    const panel = $('#settings-panel');
    const toggle = $('#settings-toggle');
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function wireSettings() {
    const toggle = $('#settings-toggle');
    const panel = $('#settings-panel');
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      panel.hidden = expanded;
      toggle.setAttribute('aria-expanded', String(!expanded));
    });

    $('#save-settings').addEventListener('click', async () => {
      const tfl = $('#tfl-key').value.trim();
      const dar = $('#darwin-token').value.trim();
      if (tfl) localStorage.setItem(LS.TFL_KEY, tfl); else localStorage.removeItem(LS.TFL_KEY);
      if (dar) localStorage.setItem(LS.DARWIN, dar); else localStorage.removeItem(LS.DARWIN);
      const btn = $('#save-settings');
      btn.classList.add('saved');
      btn.textContent = 'Saved';
      setTimeout(() => { btn.classList.remove('saved'); btn.textContent = 'Save'; }, 1200);
      await refreshAll();
    });

    $('#clear-cache').addEventListener('click', async () => {
      localStorage.removeItem(LS.ARENA_ID);
      const btn = $('#clear-cache');
      const original = btn.textContent;
      btn.textContent = 'Cleared';
      setTimeout(() => { btn.textContent = original; }, 1200);
      await refreshAll();
    });

    // Delegated: any "Add Darwin token" link inside a placeholder
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-open-settings]');
      if (a) {
        e.preventDefault();
        openSettings();
      }
    });
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  function init() {
    loadSettingsIntoForm();
    wireSettings();
    renderSkeletons();

    $('#refresh-btn').addEventListener('click', refreshAll);

    // Kick off
    refreshAll();

    // 1Hz countdown
    setInterval(tickCountdown, 1000);
    tickCountdown();

    // When the tab regains visibility after sleep, force a refresh
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        const tflStale = Date.now() > (nextTflAt - CONFIG.TFL_REFRESH_MS / 2);
        if (tflStale) refreshAll();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
