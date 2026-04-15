const BINANCE_REST = "https://api.binance.com";
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws";
const SYMBOLS_API = "/api/symbols";

const intervalSecondsMap = {
  "1s": 1, "3s": 3, "5s": 5, "15s": 15, "1m": 60, "3m": 180, "5m": 300, "15m": 900,
};

const regimeStyles = {
  "Impulse Up": "#57d38c",
  "Impulse Down": "#ff758c",
  "Buy Pressure": "#8e7dff",
  "Sell Pressure": "#ffb3c1",
  "Chop": "#ffd166",
};

const elements = {
  symbolSearch: document.getElementById("symbol-search"),
  symbolToggle: document.getElementById("symbol-toggle"),
  symbolDropdown: document.getElementById("symbol-dropdown"),
  pauseButton: document.getElementById("pause-button"),
  resetPanButton: document.getElementById("reset-pan-button"),
  settingsButton: document.getElementById("settings-button"),
  settingsPanel: document.getElementById("settings-panel"),
  intervalSelect: document.getElementById("interval-select"),
  showCirclesToggle: document.getElementById("show-circles-toggle"),
  accumulateTradesToggle: document.getElementById("accumulate-trades-toggle"),
  showRegimesToggle: document.getElementById("show-regimes-toggle"),
  showSRToggle: document.getElementById("show-sr-toggle"),
  flowVisibleScaleToggle: document.getElementById("flow-visible-scale-toggle"),
  priceZoom: document.getElementById("price-zoom"),
  mainCanvas: document.getElementById("main-canvas"),
  volumeCanvas: document.getElementById("volume-canvas"),
  notionalCanvas: document.getElementById("notional-canvas"),
  marketTitle: document.getElementById("market-title"),
  marketSubtitle: document.getElementById("market-subtitle"),
  lastPrice: document.getElementById("last-price"),
  lastTrade: document.getElementById("last-trade"),
  largestVisible: document.getElementById("largest-visible"),
  statusPill: document.getElementById("status-pill"),
};

const state = {
  symbols: [],
  filteredSymbols: [],
  selectedSymbol: "BTCUSDT",
  selectedDisplay: "BTC/USDT",
  isPaused: false,
  interval: "5s",
  candles: [],
  trades: [],
  secondBars: [],
  featureBars: [],
  segments: [],
  currentBar: null,
  ws: null,
  lastPrice: null,
  lastTradeAt: null,
  animationFrame: null,
  timeWindowMs: 120000,
  maxObservedTradeQty: 1,
  priceZoom: 100,
  pricePan: 0,
  isDragging: false,
  dragStartY: 0,
  panStart: 0,
  showCircles: true,
  accumulateShortFrameTrades: false,
  showRegimes: true,
  showSR: true,
  visibleScale: true,
  maxTradesStored: 12000,
  maxBarsStored: 2400,
};

function setStatus(text, mode = "neutral") {
  elements.statusPill.textContent = text;
  elements.statusPill.classList.remove("status-live", "status-neutral");
  elements.statusPill.classList.add(mode === "live" ? "status-live" : "status-neutral");
}

function updateTimeWindow() {
  const seconds = intervalSecondsMap[state.interval] || 5;
  const barsTarget = 36;
  state.timeWindowMs = Math.max(30000, seconds * barsTarget * 1000);
}

function normalizeTrade(raw) {
  return {
    id: raw.t,
    ts: Number(raw.T),
    price: Number(raw.p),
    qty: Number(raw.q),
    notional: Number(raw.p) * Number(raw.q),
    isSell: Boolean(raw.m),
  };
}

function getNowLineX(width) { return width * 0.67; }

function resizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

let mainCtx = resizeCanvas(elements.mainCanvas);
let volumeCtx = resizeCanvas(elements.volumeCanvas);
let notionalCtx = resizeCanvas(elements.notionalCanvas);

window.addEventListener("resize", () => {
  mainCtx = resizeCanvas(elements.mainCanvas);
  volumeCtx = resizeCanvas(elements.volumeCanvas);
  notionalCtx = resizeCanvas(elements.notionalCanvas);
});

function updateResetButton() {
  elements.resetPanButton.classList.toggle("hidden", Math.abs(state.pricePan) < 0.000001);
}

async function fetchSymbols() {
  const response = await fetch(SYMBOLS_API);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to fetch symbols");
  state.symbols = data.symbols;
  state.filteredSymbols = [...state.symbols];
  renderSymbolOptions();
  const defaultMatch = state.symbols.find((row) => row.symbol === state.selectedSymbol);
  if (defaultMatch) selectSymbol(defaultMatch, false);
}

function renderSymbolOptions() {
  const dropdown = elements.symbolDropdown;
  dropdown.innerHTML = "";
  for (const item of state.filteredSymbols.slice(0, 250)) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "symbol-option" + (item.symbol === state.selectedSymbol ? " active" : "");
    option.innerHTML = `<span>${item.displayName}</span><small>${item.symbol}</small>`;
    option.addEventListener("click", () => {
      selectSymbol(item, true);
      hideDropdown();
    });
    dropdown.appendChild(option);
  }
  if (state.filteredSymbols.length === 0) {
    const empty = document.createElement("div");
    empty.className = "symbol-option";
    empty.innerHTML = "<span>No symbols found</span>";
    dropdown.appendChild(empty);
  }
}

function showDropdown() { elements.symbolDropdown.classList.remove("hidden"); }
function hideDropdown() { elements.symbolDropdown.classList.add("hidden"); }

function filterSymbols(query) {
  const q = query.trim().toLowerCase();
  state.filteredSymbols = state.symbols.filter((item) => {
    if (!q) return true;
    return item.displayName.toLowerCase().includes(q)
      || item.symbol.toLowerCase().includes(q)
      || item.baseAsset.toLowerCase().includes(q);
  });
  renderSymbolOptions();
}

async function fetchInitialCandles() {
  updateTimeWindow();
  const seconds = intervalSecondsMap[state.interval] || 5;
  const endTime = Date.now();

  if (seconds < 60) {
    const startTime = endTime - Math.max(state.timeWindowMs * 1.2, 5 * 60 * 1000);
    const url = new URL(`${BINANCE_REST}/api/v3/klines`);
    url.searchParams.set("symbol", state.selectedSymbol);
    url.searchParams.set("interval", "1s");
    url.searchParams.set("startTime", String(startTime));
    url.searchParams.set("endTime", String(endTime));
    url.searchParams.set("limit", "1000");
    const response = await fetch(url);
    const rows = await response.json();
    if (!response.ok) throw new Error(rows.msg || "Failed to fetch candles");
    state.candles = aggregateKlines(rows, seconds);
  } else {
    const url = new URL(`${BINANCE_REST}/api/v3/uiKlines`);
    url.searchParams.set("symbol", state.selectedSymbol);
    url.searchParams.set("interval", state.interval);
    url.searchParams.set("limit", "1000");
    const response = await fetch(url);
    const rows = await response.json();
    if (!response.ok) throw new Error(rows.msg || "Failed to fetch candles");
    state.candles = rows.map((row) => ({
      openTime: Number(row[0]),
      closeTime: Number(row[6]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
  }
  trimCandles();
}

function aggregateKlines(rows, bucketSeconds) {
  const bucketMs = bucketSeconds * 1000;
  const buckets = new Map();
  for (const row of rows) {
    const start = Math.floor(Number(row[0]) / bucketMs) * bucketMs;
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    let bucket = buckets.get(start);
    if (!bucket) {
      bucket = { openTime: start, closeTime: start + bucketMs - 1, open, high, low, close, volume };
      buckets.set(start, bucket);
    } else {
      bucket.high = Math.max(bucket.high, high);
      bucket.low = Math.min(bucket.low, low);
      bucket.close = close;
      bucket.volume += volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

function trimCandles() {
  const cutoff = Date.now() - state.timeWindowMs * 1.5;
  state.candles = state.candles.filter((c) => c.closeTime >= cutoff);
}

function trimTrades() {
  const cutoff = Date.now() - state.timeWindowMs * 1.5;
  state.trades = state.trades.filter((t) => t.ts >= cutoff).slice(-state.maxTradesStored);
  state.secondBars = state.secondBars.filter((b) => b.ts >= cutoff).slice(-state.maxBarsStored);
  state.featureBars = state.featureBars.filter((b) => b.ts >= cutoff).slice(-state.maxBarsStored);
  state.segments = state.segments.filter((s) => s.startTime >= cutoff - 60000).slice(-200);
}

function ensureCandleForTrade(trade) {
  const bucketMs = intervalSecondsMap[state.interval] * 1000;
  const openTime = Math.floor(trade.ts / bucketMs) * bucketMs;
  const closeTime = openTime + bucketMs - 1;
  let candle = state.candles[state.candles.length - 1];

  if (!candle || candle.openTime !== openTime) {
    const previousClose = candle ? candle.close : trade.price;
    candle = {
      openTime, closeTime,
      open: previousClose, high: trade.price, low: trade.price, close: trade.price, volume: trade.qty,
    };
    state.candles.push(candle);
  } else {
    candle.high = Math.max(candle.high, trade.price);
    candle.low = Math.min(candle.low, trade.price);
    candle.close = trade.price;
    candle.volume += trade.qty;
  }
}

function maybeAccumulateTrade(trade) {
  if (!state.accumulateShortFrameTrades) return trade;
  const prev = state.trades[state.trades.length - 1];
  if (!prev) return trade;
  const timeDiff = trade.ts - prev.ts;
  const avgPrice = (trade.price + prev.price) / 2;
  const priceDiffRatio = Math.abs(trade.price - prev.price) / Math.max(avgPrice, 1e-9);
  if (timeDiff <= 140 && priceDiffRatio <= 0.00025 && trade.isSell === prev.isSell) {
    const prevQty = prev.qty;
    prev.qty += trade.qty;
    prev.notional += trade.notional;
    prev.price = (prev.price * prevQty + trade.price * trade.qty) / prev.qty;
    prev.ts = trade.ts;
    prev.id = trade.id;
    return null;
  }
  return trade;
}

function finalizeCurrentSecondBar(nextTsMs) {
  if (!state.currentBar) return;
  const b = state.currentBar;
  b.signedNotional = b.buyNotional - b.sellNotional;
  b.totalNotional = b.buyNotional + b.sellNotional;
  b.totalQty = b.buyQty + b.sellQty;
  b.imbalance = b.totalNotional > 0 ? b.signedNotional / b.totalNotional : 0;
  b.returnPct = (b.lastPrice - b.firstPrice) / Math.max(b.firstPrice, 1e-9);
  b.rangePct = (b.high - b.low) / Math.max(b.firstPrice, 1e-9);
  state.secondBars.push(b);
  state.featureBars.push(b);
  state.currentBar = null;
  maybeUpdateRegime();
}

function updateSecondBar(trade) {
  const bucketTs = Math.floor(trade.ts / 1000) * 1000;
  if (!state.currentBar || state.currentBar.ts !== bucketTs) {
    finalizeCurrentSecondBar(bucketTs);
    state.currentBar = {
      ts: bucketTs,
      buyNotional: 0,
      sellNotional: 0,
      buyQty: 0,
      sellQty: 0,
      trades: 0,
      firstPrice: trade.price,
      lastPrice: trade.price,
      high: trade.price,
      low: trade.price,
    };
  }
  const bar = state.currentBar;
  if (trade.isSell) {
    bar.sellNotional += trade.notional;
    bar.sellQty += trade.qty;
  } else {
    bar.buyNotional += trade.notional;
    bar.buyQty += trade.qty;
  }
  bar.trades += 1;
  bar.lastPrice = trade.price;
  bar.high = Math.max(bar.high, trade.price);
  bar.low = Math.min(bar.low, trade.price);
}

function mean(arr, fn) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + fn(x), 0) / arr.length;
}

function classifyWindow(bars) {
  const totalNotional = bars.reduce((s, x) => s + (x.totalNotional || 0), 0);
  const signed = bars.reduce((s, x) => s + (x.signedNotional || 0), 0);
  const move = bars.reduce((s, x) => s + (x.returnPct || 0), 0);
  const range = mean(bars, x => x.rangePct || 0);
  const imbalance = signed / Math.max(totalNotional, 1e-9);

  const secondsPerCandle = intervalSecondsMap[state.interval] || 5;
  const scale = Math.max(1, Math.sqrt(secondsPerCandle));
  const impulseMove = 0.0022 * scale;
  const pressureMove = 0.0012 * scale;
  const chopMove = 0.0015 * scale;

  if (move > impulseMove && imbalance > 0.16) return { label: "Impulse Up", conf: Math.abs(move) + imbalance };
  if (move < -impulseMove && imbalance < -0.16) return { label: "Impulse Down", conf: Math.abs(move) + Math.abs(imbalance) };
  if (Math.abs(move) < pressureMove && imbalance > 0.12) return { label: "Buy Pressure", conf: imbalance };
  if (Math.abs(move) < pressureMove && imbalance < -0.12) return { label: "Sell Pressure", conf: Math.abs(imbalance) };
  return { label: "Chop", conf: 0.4 + (chopMove - Math.min(Math.abs(move), chopMove)) };
}

function maybeUpdateRegime() {
  const secondsPerCandle = intervalSecondsMap[state.interval] || 5;
  const windowBars = secondsPerCandle <= 5 ? 8 : secondsPerCandle <= 15 ? 12 : secondsPerCandle <= 60 ? 20 : 28;
  const minSegMs = Math.max(12000, secondsPerCandle * 1000 * 6);

  if (state.featureBars.length < windowBars * 3) return;
  const recent = state.featureBars.slice(-windowBars);
  const prev = state.featureBars.slice(-(windowBars * 2), -windowBars);
  const nowTs = recent[recent.length - 1].ts;

  const recentCls = classifyWindow(recent);
  const prevCls = classifyWindow(prev);

  if (!state.segments.length) {
    state.segments.push({
      startTime: recent[0].ts,
      label: recentCls.label,
      color: regimeStyles[recentCls.label],
      confidence: recentCls.conf,
    });
    return;
  }

  const current = state.segments[state.segments.length - 1];
  const minLenOk = nowTs - current.startTime >= minSegMs;
  const changed = recentCls.label !== current.label;
  const stable = recentCls.label === prevCls.label;

  if (changed && stable && minLenOk && recentCls.conf > 0.12) {
    state.segments.push({
      startTime: recent[0].ts,
      label: recentCls.label,
      color: regimeStyles[recentCls.label],
      confidence: recentCls.conf,
    });
  }
}

function computeSRAreas(visibleTrades, bounds, nowLineX) {
  if (!state.showSR || visibleTrades.length < 20) return [];

  const secondsPerCandle = intervalSecondsMap[state.interval] || 5;
  const latestTrade = visibleTrades[visibleTrades.length - 1];
  const refPrice = latestTrade ? latestTrade.price : (state.lastPrice || 1);

  // Smaller, fixed "nice" bucket sizes anchored to absolute prices.
  const pctStep =
    secondsPerCandle <= 5 ? 0.00010 :
    secondsPerCandle <= 15 ? 0.00016 :
    secondsPerCandle <= 60 ? 0.00028 : 0.00045;

  const rawBandSize = refPrice * pctStep;

  // Snap to fixed absolute increments so buckets stay on specific prices.
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(rawBandSize, 1e-12))));
  const norm = rawBandSize / mag;
  let niceNorm = 1;
  if (norm >= 7.5) niceNorm = 10;
  else if (norm >= 3.5) niceNorm = 5;
  else if (norm >= 1.5) niceNorm = 2;
  else niceNorm = 1;

  // Half-step from previous version for denser levels.
  const bandSize = Math.max((niceNorm * mag) / 2, 1e-9);

  const cooldownMs = Math.max(1000, secondsPerCandle * 700);
  const buckets = new Map();

  for (const t of visibleTrades) {
    const key = Math.round(t.price / bandSize) * bandSize;
    let entry = buckets.get(key);
    if (!entry) {
      entry = {
        price: key,
        totalNotional: 0,
        sellNotional: 0,
        buyNotional: 0,
        visits: 0,
        lastVisitTs: null,
        reactions: [],
        touchCount: 0,
      };
      buckets.set(key, entry);
    }

    entry.totalNotional += t.notional;
    entry.touchCount += 1;
    if (t.isSell) entry.sellNotional += t.notional;
    else entry.buyNotional += t.notional;

    if (entry.lastVisitTs === null || (t.ts - entry.lastVisitTs) > cooldownMs) {
      entry.visits += 1;
      entry.lastVisitTs = t.ts;
    }
  }

  for (const [key, entry] of buckets.entries()) {
    const touches = visibleTrades.filter(t => Math.abs(t.price - key) <= bandSize * 0.55);
    for (const touch of touches.slice(0, 8)) {
      const future = visibleTrades.find(ft => ft.ts >= touch.ts + Math.max(2500, secondsPerCandle * 1200));
      if (!future) continue;
      const reaction = (future.price - touch.price) / Math.max(touch.price, 1e-9);
      entry.reactions.push(reaction);
    }

    const avgReaction = entry.reactions.length
      ? entry.reactions.reduce((s, x) => s + x, 0) / entry.reactions.length
      : 0;

    const sellerBias = entry.sellNotional / Math.max(entry.totalNotional, 1e-9);

    entry.directionalScore =
      entry.totalNotional *
      (1 + 0.35 * entry.visits) *
      ((avgReaction * 120) + ((0.5 - sellerBias) * 1.3));

    entry.absoluteScore =
      entry.totalNotional *
      (1 + 0.35 * entry.visits) *
      (1 + Math.min(0.8, Math.abs(avgReaction) * 150));
  }

  const rows = [];
  for (const bucket of buckets.values()) {
    if (bucket.touchCount < 2) continue;
    if (bucket.price < bounds.bottomPrice - bandSize || bucket.price > bounds.topPrice + bandSize) continue;
    rows.push({
      price: bucket.price,
      strength: bucket.absoluteScore,
      directional: bucket.directionalScore,
      bandSize,
    });
  }
  rows.sort((a, b) => a.price - b.price);
  return rows;
}

function connectTradeStream() {
  disconnectTradeStream();
  setStatus(state.isPaused ? "Paused" : "Connecting…", "neutral");
  if (state.isPaused) return;

  state.ws = new WebSocket(`${BINANCE_WS_BASE}/${state.selectedSymbol.toLowerCase()}@trade`);
  state.ws.addEventListener("open", () => setStatus(`Live · ${state.selectedSymbol}`, "live"));

  state.ws.addEventListener("message", (event) => {
    if (state.isPaused) return;
    const rawTrade = normalizeTrade(JSON.parse(event.data));
    const maybeTrade = maybeAccumulateTrade(rawTrade);

    if (maybeTrade === null) {
      const updated = state.trades[state.trades.length - 1];
      state.maxObservedTradeQty = Math.max(state.maxObservedTradeQty, updated.qty);
      updateSecondBar(updated);
      ensureCandleForTrade(updated);
      state.lastPrice = updated.price;
      state.lastTradeAt = updated.ts;
      trimTrades();
      trimCandles();
      return;
    }

    state.trades.push(maybeTrade);
    state.maxObservedTradeQty = Math.max(state.maxObservedTradeQty, maybeTrade.qty);
    updateSecondBar(maybeTrade);
    ensureCandleForTrade(maybeTrade);
    state.lastPrice = maybeTrade.price;
    state.lastTradeAt = maybeTrade.ts;
    trimTrades();
    trimCandles();
  });

  state.ws.addEventListener("close", () => {
    if (!state.isPaused) {
      setStatus("Disconnected · retrying…", "neutral");
      window.setTimeout(() => { if (!state.isPaused) connectTradeStream(); }, 1500);
    } else {
      setStatus("Paused", "neutral");
    }
  });

  state.ws.addEventListener("error", () => setStatus("Disconnected", "neutral"));
}

function disconnectTradeStream() {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
}

function formatQty(qty) {
  if (!Number.isFinite(qty)) return "--";
  if (qty >= 1000) return qty.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (qty >= 1) return qty.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return qty.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function formatPrice(price) {
  if (!Number.isFinite(price)) return "--";
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (price >= 1) return price.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return price.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function updateHeaders() {
  elements.marketTitle.textContent = state.selectedDisplay;
  elements.marketSubtitle.textContent = `Interval: ${state.interval} · Candles with wick`;
  elements.lastPrice.textContent = state.lastPrice ? formatPrice(state.lastPrice) : "--";
  elements.lastTrade.textContent = state.lastTradeAt ? `Last trade: ${new Date(state.lastTradeAt).toLocaleTimeString()}` : "Last trade: --";
}

function computeVisibleTrades(now, width) {
  const nowLineX = getNowLineX(width);
  const visible = [];
  for (const trade of state.trades) {
    const age = now - trade.ts;
    if (age < 0 || age > state.timeWindowMs) continue;
    const x = nowLineX - (age / state.timeWindowMs) * nowLineX;
    visible.push({ ...trade, x });
  }
  return visible;
}

function computeVisibleCandles(now, width) {
  const nowLineX = getNowLineX(width);
  const visible = [];
  for (const candle of state.candles) {
    const age = now - candle.closeTime;
    if (age < -1000 || age > state.timeWindowMs) continue;
    const x = nowLineX - (age / state.timeWindowMs) * nowLineX;
    visible.push({ ...candle, x });
  }
  return visible;
}

function timeToX(ts, now, width) {
  const nowLineX = getNowLineX(width);
  const age = now - ts;
  return nowLineX - (age / state.timeWindowMs) * nowLineX;
}

function drawGrid(ctx, width, height, nowLineX) {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 9; i += 1) {
    const y = (height / 9) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  for (let i = 1; i < 8; i += 1) {
    const x = (width / 8) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  ctx.setLineDash([2, 6]);
  ctx.strokeStyle = "rgba(255,255,255,0.36)";
  ctx.beginPath();
  ctx.moveTo(nowLineX, 0);
  ctx.lineTo(nowLineX, height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "12px sans-serif";
  ctx.fillText("NOW", nowLineX - 16, 16);
  ctx.restore();
}

function getMainPriceBounds(visibleCandles) {
  const prices = visibleCandles.flatMap((c) => [c.high, c.low]);
  if (prices.length === 0) return null;
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const rawRange = Math.max(maxPrice - minPrice, maxPrice * 0.000001 || 1e-9);
  const latestVisible = visibleCandles[visibleCandles.length - 1];
  const anchorPrice = latestVisible ? latestVisible.close : ((maxPrice + minPrice) / 2);
  const sliderRatio = state.priceZoom / 100;
  const zoomMultiplier = 4.5 - sliderRatio * 4.0;
  const adjustedRange = Math.max(rawRange * zoomMultiplier, maxPrice * 0.000001 || 1e-9);
  const shiftedMidpoint = anchorPrice + state.pricePan * adjustedRange;
  const topPrice = shiftedMidpoint + adjustedRange / 2;
  const bottomPrice = shiftedMidpoint - adjustedRange / 2;
  return { topPrice, bottomPrice, priceRange: Math.max(topPrice - bottomPrice, 1e-9) };
}

function drawSegments(ctx, now, width, height) {
  if (!state.showRegimes || !state.segments.length) return;
  const nowLineX = getNowLineX(width);
  for (let i = 0; i < state.segments.length; i += 1) {
    const seg = state.segments[i];
    const left = Math.max(0, timeToX(seg.startTime, now, width));
    const right = Math.min(nowLineX, i + 1 < state.segments.length ? timeToX(state.segments[i + 1].startTime, now, width) : nowLineX);
    if (right < 0 || left > nowLineX || right <= left) continue;

    ctx.fillStyle = seg.color + "12";
    ctx.fillRect(left, 0, Math.max(1, right - left), height);

    if (i > 0) {
      ctx.strokeStyle = seg.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(left, 0);
      ctx.lineTo(left, height);
      ctx.stroke();
    }

    ctx.fillStyle = seg.color;
    ctx.font = "12px sans-serif";
    ctx.fillText(seg.label, left + 4, 18);
  }
}

function drawMainChart() {
  const width = elements.mainCanvas.clientWidth;
  const height = elements.mainCanvas.clientHeight;
  const ctx = mainCtx;
  const now = Date.now();
  const nowLineX = getNowLineX(width);

  drawGrid(ctx, width, height, nowLineX);

  const visibleCandles = computeVisibleCandles(now, width).sort((a, b) => a.openTime - b.openTime);
  const visibleTrades = computeVisibleTrades(now, width);
  const bounds = getMainPriceBounds(visibleCandles);
  if (!bounds) return;

  const plotTop = 20;
  const plotBottom = height - 20;
  const plotHeight = plotBottom - plotTop;
  const priceToY = (price) => plotBottom - ((price - bounds.bottomPrice) / bounds.priceRange) * plotHeight;

  drawSegments(ctx, now, width, height);

  const srAreas = computeSRAreas(visibleTrades, bounds, nowLineX);
  if (state.showSR && srAreas.length) {
    const maxScore = Math.max(...srAreas.map(z => z.strength), 1e-9);

    const smoothed = srAreas.map((zone) => {
      let acc = 0;
      let weightSum = 0;
      for (let j = 0; j < srAreas.length; j += 1) {
        const other = srAreas[j];
        const dist = Math.abs(other.price - zone.price) / Math.max(zone.bandSize, 1e-9);
        const w = Math.exp(-(dist * dist) / 3.2);
        acc += (other.strength / maxScore) * w;
        weightSum += w;
      }
      return {
        ...zone,
        likelihood: Math.max(0, Math.min(1, acc / Math.max(weightSum, 1e-9))),
      };
    });

    for (const zone of smoothed) {
      if (zone.likelihood < 0.01) continue;
      const y = priceToY(zone.price);
      const alpha = Math.max(0.01, Math.min(0.70, zone.likelihood * 0.70));
      const lineH = Math.max(1, Math.round((zone.bandSize / Math.max(bounds.priceRange, 1e-9)) * (height - 40)));
      ctx.fillStyle = `rgba(255, 176, 59, ${alpha})`;
      ctx.fillRect(0, y - lineH / 2, width, lineH);
    }
  }

  const visibleMaxTrade = Math.max(...visibleTrades.map(t => t.qty), 1e-6);
  elements.largestVisible.textContent = `Largest visible trade: ${formatQty(visibleMaxTrade)}`;

  if (state.showCircles) {
    const largestTrade = visibleMaxTrade;
    for (const trade of visibleTrades) {
      if (trade.x < 0 || trade.x > width) continue;
      const y = priceToY(trade.price);
      const maxRadius = height / 3;
      const radius = Math.max(3, Math.sqrt(trade.qty / largestTrade) * maxRadius);
      ctx.beginPath();
      ctx.fillStyle = trade.isSell ? "rgba(255, 101, 132, 0.14)" : "rgba(78, 201, 140, 0.14)";
      ctx.strokeStyle = trade.isSell ? "rgba(255, 101, 132, 0.34)" : "rgba(78, 201, 140, 0.34)";
      ctx.lineWidth = 1;
      ctx.arc(trade.x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  const bucketMs = intervalSecondsMap[state.interval] * 1000;
  const candleWidth = Math.max(2, (bucketMs / state.timeWindowMs) * nowLineX * 0.72);

  for (const candle of visibleCandles) {
    const x = candle.x;
    const openY = priceToY(candle.open);
    const closeY = priceToY(candle.close);
    const highY = priceToY(candle.high);
    const lowY = priceToY(candle.low);
    const bullish = candle.close >= candle.open;
    ctx.strokeStyle = bullish ? "rgba(78, 201, 140, 0.95)" : "rgba(255, 101, 132, 0.95)";
    ctx.fillStyle = bullish ? "rgba(78, 201, 140, 0.28)" : "rgba(255, 101, 132, 0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(2, Math.abs(closeY - openY));
    ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    ctx.strokeRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
  }

  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(formatPrice(bounds.topPrice), width - 10, 18);
  ctx.fillText(formatPrice(bounds.bottomPrice), width - 10, height - 8);
  ctx.textAlign = "left";
}

function drawVolumeChart() {
  const width = elements.volumeCanvas.clientWidth;
  const height = elements.volumeCanvas.clientHeight;
  const ctx = volumeCtx;
  const now = Date.now();
  ctx.clearRect(0, 0, width, height);

  const centerY = height / 2;
  const nowLineX = getNowLineX(width);
  const visibleTrades = computeVisibleTrades(now, width);
  const scaleMax = state.visibleScale
    ? Math.max(...visibleTrades.map(t => t.qty), 1e-6)
    : Math.max(state.maxObservedTradeQty, 1e-6);

  ctx.strokeStyle = "rgba(255,255,255,0.26)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();

  ctx.setLineDash([2, 6]);
  ctx.beginPath();
  ctx.moveTo(nowLineX, 0);
  ctx.lineTo(nowLineX, height);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const trade of visibleTrades) {
    const barHeight = Math.max(2, (trade.qty / scaleMax) * (height / 2 - 8));
    const barWidth = 3;
    ctx.fillStyle = trade.isSell ? "rgba(255, 101, 132, 0.38)" : "rgba(78, 201, 140, 0.38)";
    if (trade.isSell) ctx.fillRect(trade.x - barWidth / 2, centerY, barWidth, barHeight);
    else ctx.fillRect(trade.x - barWidth / 2, centerY - barHeight, barWidth, barHeight);
  }

  ctx.fillStyle = "rgba(78, 201, 140, 0.9)";
  ctx.fillText("Buy", 8, 16);
  ctx.fillStyle = "rgba(255, 101, 132, 0.9)";
  ctx.fillText("Sell", 8, height - 8);
}

function drawNotionalChart() {
  const width = elements.notionalCanvas.clientWidth;
  const height = elements.notionalCanvas.clientHeight;
  const ctx = notionalCtx;
  const now = Date.now();
  ctx.clearRect(0, 0, width, height);

  const centerY = height / 2;
  const nowLineX = getNowLineX(width);
  ctx.strokeStyle = "rgba(255,255,255,0.24)";
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();

  const bars = state.featureBars.filter((b) => now - b.ts <= state.timeWindowMs);
  const maxNotional = state.visibleScale
    ? Math.max(...bars.map(b => Math.max(b.buyNotional || 0, b.sellNotional || 0)), 1e-6)
    : Math.max(...state.featureBars.map(b => Math.max(b.buyNotional || 0, b.sellNotional || 0)), 1e-6);

  for (const bar of bars) {
    const x = timeToX(bar.ts, now, width);
    if (x < 0 || x > nowLineX) continue;
    const buyH = ((bar.buyNotional || 0) / maxNotional) * (height / 2 - 8);
    const sellH = ((bar.sellNotional || 0) / maxNotional) * (height / 2 - 8);
    const barW = Math.max(2, (1000 / state.timeWindowMs) * nowLineX * 0.85);
    ctx.fillStyle = "rgba(78, 201, 140, 0.55)";
    ctx.fillRect(x - barW / 2, centerY - buyH, barW, buyH);
    ctx.fillStyle = "rgba(255, 101, 132, 0.55)";
    ctx.fillRect(x - barW / 2, centerY, barW, sellH);
  }

  ctx.setLineDash([2, 6]);
  ctx.beginPath();
  ctx.moveTo(nowLineX, 0);
  ctx.lineTo(nowLineX, height);
  ctx.stroke();
  ctx.setLineDash([]);
}

function animate() {
  updateHeaders();
  drawMainChart();
  drawVolumeChart();
  drawNotionalChart();
  state.animationFrame = window.requestAnimationFrame(animate);
}

async function refreshAllData(resetObservedScale = false) {
  setStatus("Loading history…", "neutral");
  state.candles = [];
  state.trades = [];
  state.secondBars = [];
  state.featureBars = [];
  state.segments = [];
  state.currentBar = null;
  state.lastPrice = null;
  state.lastTradeAt = null;
  state.pricePan = 0;
  updateResetButton();
  if (resetObservedScale) state.maxObservedTradeQty = 1;
  await fetchInitialCandles();
  connectTradeStream();
}

async function selectSymbol(item, reload = true) {
  state.selectedSymbol = item.symbol;
  state.selectedDisplay = item.displayName;
  elements.symbolSearch.value = item.displayName;
  renderSymbolOptions();
  if (reload) await refreshAllData(true);
}

function setupDrag() {
  elements.mainCanvas.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    state.isDragging = true;
    state.dragStartY = event.clientY;
    state.panStart = state.pricePan;
    elements.mainCanvas.classList.add("dragging");
  });

  window.addEventListener("mousemove", (event) => {
    if (!state.isDragging) return;
    const rect = elements.mainCanvas.getBoundingClientRect();
    const deltaY = event.clientY - state.dragStartY;
    state.pricePan = state.panStart + (deltaY / rect.height) * 1.6;
    updateResetButton();
  });

  window.addEventListener("mouseup", () => {
    state.isDragging = false;
    elements.mainCanvas.classList.remove("dragging");
  });

  elements.resetPanButton.addEventListener("click", () => {
    state.pricePan = 0;
    updateResetButton();
  });
}

function setupEvents() {
  elements.symbolToggle.addEventListener("click", () => {
    elements.symbolDropdown.classList.contains("hidden") ? showDropdown() : hideDropdown();
  });
  elements.symbolSearch.addEventListener("focus", () => {
    showDropdown();
    filterSymbols(elements.symbolSearch.value);
  });
  elements.symbolSearch.addEventListener("input", (event) => {
    showDropdown();
    filterSymbols(event.target.value);
  });
  document.addEventListener("click", (event) => {
    const combo = document.getElementById("symbol-combo");
    if (!combo.contains(event.target)) hideDropdown();
  });

  elements.pauseButton.addEventListener("click", async () => {
    state.isPaused = !state.isPaused;
    elements.pauseButton.textContent = state.isPaused ? "Resume" : "Pause";
    elements.pauseButton.classList.toggle("paused", state.isPaused);
    if (state.isPaused) {
      disconnectTradeStream();
      setStatus("Paused", "neutral");
    } else {
      await refreshAllData(false);
    }
  });

  elements.settingsButton.addEventListener("click", () => {
    elements.settingsPanel.classList.toggle("hidden");
  });

  elements.intervalSelect.addEventListener("change", async (event) => {
    state.interval = event.target.value;
    await refreshAllData(false);
  });

  elements.priceZoom.addEventListener("input", (event) => {
    state.priceZoom = Number(event.target.value);
  });

  elements.showCirclesToggle.addEventListener("change", (event) => {
    state.showCircles = event.target.checked;
  });
  elements.accumulateTradesToggle.addEventListener("change", (event) => {
    state.accumulateShortFrameTrades = event.target.checked;
  });
  elements.showRegimesToggle.addEventListener("change", (event) => {
    state.showRegimes = event.target.checked;
  });
  elements.showSRToggle.addEventListener("change", (event) => {
    state.showSR = event.target.checked;
  });
  elements.flowVisibleScaleToggle.addEventListener("change", (event) => {
    state.visibleScale = event.target.checked;
  });

  setupDrag();
}

async function init() {
  setupEvents();
  state.interval = elements.intervalSelect.value;
  state.priceZoom = Number(elements.priceZoom.value);
  state.showCircles = elements.showCirclesToggle.checked;
  state.accumulateShortFrameTrades = elements.accumulateTradesToggle.checked;
  state.showRegimes = elements.showRegimesToggle.checked;
  state.showSR = elements.showSRToggle.checked;
  state.visibleScale = elements.flowVisibleScaleToggle.checked;
  updateResetButton();
  updateTimeWindow();

  try {
    await fetchSymbols();
    await refreshAllData(true);
  } catch (error) {
    console.error(error);
    setStatus("Error loading data", "neutral");
    elements.marketSubtitle.textContent = String(error.message || error);
  }

  if (!state.animationFrame) animate();
}

init();