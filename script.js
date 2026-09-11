/* ============================================================
   SUCCESSFUL PINE SCRIPT
   PRECISION SIGNAL ENGINE
   GitHub + Vercel Ready

   LIVE PUBLIC DERIV DATA
   CLOSED-CANDLE / NON-REPAINTING ANALYSIS

   MARKET STRUCTURE
   PRICE ACTION
   SMC
   SUPPORT / RESISTANCE
   SUPPLY / DEMAND
   ORDER BLOCK
   FVG
   LIQUIDITY
   CANDLESTICKS

   PROGRESSIVE SIGNAL ENGINE

   EARLY SETUP
        ↓
   C SETUP
        ↓
   B SETUP
        ↓
   A SETUP
        ↓
   A+ SETUP

   IMPORTANT:
   Candlestick confirmation is NOT mandatory for EARLY SETUP.
   The engine can alert before candle confirmation appears.

   DEPTH 30 / DEVIATION 5 / BACKSTEP 5
   MINIMUM RR 1:2
   ============================================================ */

"use strict";

/* ============================================================
   CONFIG
   ============================================================ */

const CONFIG = {
  DERIV_WS:
    "wss://api.derivws.com/trading/v1/options/ws/public",

  HISTORY_COUNT: 5000,

  DEPTH: 30,
  DEVIATION: 5,
  BACKSTEP: 5,

  MIN_RR: 2,

  SWING_LOOKBACK: 30,

  RECONNECT_MIN: 1000,
  RECONNECT_MAX: 30000,

  ANALYSIS_INTERVAL: 5000,

  DUPLICATE_COOLDOWN: 60 * 60 * 1000,

  TIMEFRAMES: {
    M1: 60,
    M5: 300,
    M15: 900,
    M30: 1800,
    H1: 3600,
    H2: 7200,
    H4: 14400,
    Daily: 86400
  }
};


/* ============================================================
   STATE
   ============================================================ */

const state = {
  ws: null,

  connected: false,

  reconnectTimer: null,
  reconnectDelay: CONFIG.RECONNECT_MIN,

  symbols: [],
  selectedSymbol: "",
  selectedTimeframe: "M5",

  livePrice: null,

  candles: {},

  ticks: {},

  analysis: null,

  lastSignalKey: null,

  signalHistory: [],

  notifiedSignals: new Map(),

  activeSignal: null,

  analysisTimer: null,

  alertsEnabled: true,

  userInteracted: false
};


/* ============================================================
   DOM HELPERS
   ============================================================ */

function $(selector) {
  return document.querySelector(selector);
}

function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value ?? "";
}

function setHTML(selector, value) {
  const el = $(selector);
  if (el) el.innerHTML = value ?? "";
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundPrice(value) {
  const n = safeNumber(value);

  if (!n) return "0";

  if (Math.abs(n) >= 1000) {
    return n.toFixed(2);
  }

  if (Math.abs(n) >= 100) {
    return n.toFixed(2);
  }

  if (Math.abs(n) >= 10) {
    return n.toFixed(3);
  }

  return n.toFixed(5);
}


/* ============================================================
   INITIALIZATION
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  state.userInteracted = true;

  initializeExistingUI();

  createQuestionBar();

  createAlertControl();

  connectDeriv();

  if (state.analysisTimer) {
    clearInterval(state.analysisTimer);
  }

  state.analysisTimer = setInterval(() => {
    runPrecisionAnalysis(false);
  }, CONFIG.ANALYSIS_INTERVAL);
});


/* ============================================================
   EXISTING UI
   ============================================================ */

function initializeExistingUI() {
  const market = $("#market");

  if (market) {
    market.addEventListener("change", async () => {
      state.selectedSymbol = market.value;

      if (!state.selectedSymbol) return;

      state.activeSignal = null;

      subscribeToSymbol(state.selectedSymbol);

      await loadHistory(state.selectedSymbol);

      runPrecisionAnalysis(true);
    });
  }

  document.querySelectorAll("[data-timeframe]").forEach(button => {
    button.addEventListener("click", () => {
      const tf = button.dataset.timeframe;

      if (!CONFIG.TIMEFRAMES[tf]) return;

      state.selectedTimeframe = tf;

      document
        .querySelectorAll("[data-timeframe]")
        .forEach(btn => btn.classList.remove("active"));

      button.classList.add("active");

      runPrecisionAnalysis(true);
    });
  });

  const analyzeButton =
    $("#analyze") ||
    $("#analyzeBtn") ||
    $("#analyzeButton");

  if (analyzeButton) {
    analyzeButton.addEventListener("click", () => {
      runPrecisionAnalysis(true);
    });
  }
}


/* ============================================================
   DERIV CONNECTION
   ============================================================ */

function connectDeriv() {
  if (
    state.ws &&
    (
      state.ws.readyState === WebSocket.OPEN ||
      state.ws.readyState === WebSocket.CONNECTING
    )
  ) {
    return;
  }

  updateConnectionStatus("Connecting to Deriv...", false);

  try {
    state.ws = new WebSocket(CONFIG.DERIV_WS);

    state.ws.onopen = async () => {
      state.connected = true;

      state.reconnectDelay = CONFIG.RECONNECT_MIN;

      updateConnectionStatus("LIVE — Deriv Connected", true);

      requestActiveSymbols();

      if (state.selectedSymbol) {
        subscribeToSymbol(state.selectedSymbol);
        await loadHistory(state.selectedSymbol);
      }
    };

    state.ws.onmessage = event => {
      handleDerivMessage(event.data);
    };

    state.ws.onerror = error => {
      console.error("Deriv WebSocket error:", error);

      updateConnectionStatus(
        "Deriv connection error",
        false
      );
    };

    state.ws.onclose = () => {
      state.connected = false;

      updateConnectionStatus(
        "Reconnecting to Deriv...",
        false
      );

      scheduleReconnect();
    };

  } catch (error) {
    console.error("WebSocket creation failed:", error);

    scheduleReconnect();
  }
}


function scheduleReconnect() {
  if (state.reconnectTimer) return;

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;

    connectDeriv();

    state.reconnectDelay = Math.min(
      state.reconnectDelay * 2,
      CONFIG.RECONNECT_MAX
    );
  }, state.reconnectDelay);
}


function updateConnectionStatus(text, live) {
  setText("#connectionText", text);

  const dot = $(".status-dot");

  if (dot) {
    dot.classList.toggle("live", Boolean(live));
  }
}


/* ============================================================
   ACTIVE SYMBOLS
   ============================================================ */

function requestActiveSymbols() {
  sendDeriv({
    active_symbols: "full",
    req_id: 1
  });
}


function handleActiveSymbols(data) {
  if (!Array.isArray(data.active_symbols)) return;

  const symbols = data.active_symbols
    .map(item => ({
      symbol:
        item.underlying_symbol ||
        item.symbol ||
        "",

      name:
        item.underlying_symbol_name ||
        item.display_name ||
        item.symbol ||
        "",

      type:
        item.underlying_symbol_type ||
        item.symbol_type ||
        "Other"
    }))
    .filter(item => item.symbol);

  state.symbols = symbols;

  populateMarketSelector(symbols);
}


function populateMarketSelector(symbols) {
  const select = $("#market");

  if (!select) return;

  const groups = {
    "Synthetic Indices": [],
    "Forex": [],
    "Commodities & Metals": [],
    "Indices": [],
    "Cryptocurrencies": [],
    "Other": []
  };

  symbols.forEach(item => {
    const type = String(item.type).toLowerCase();

    let group = "Other";

    if (
      type.includes("synthetic") ||
      type.includes("derived")
    ) {
      group = "Synthetic Indices";
    } else if (
      type.includes("forex") ||
      type.includes("currency")
    ) {
      group = "Forex";
    } else if (
      type.includes("commodity") ||
      type.includes("metal")
    ) {
      group = "Commodities & Metals";
    } else if (
      type.includes("index") ||
      type.includes("indices")
    ) {
      group = "Indices";
    } else if (
      type.includes("crypto")
    ) {
      group = "Cryptocurrencies";
    }

    groups[group].push(item);
  });

  select.innerHTML = "";

  Object.entries(groups).forEach(([groupName, items]) => {
    if (!items.length) return;

    const optgroup = document.createElement("optgroup");

    optgroup.label = groupName;

    items.forEach(item => {
      const option = document.createElement("option");

      option.value = item.symbol;

      option.textContent =
        item.name !== item.symbol
          ? `${item.name} (${item.symbol})`
          : item.symbol;

      optgroup.appendChild(option);
    });

    select.appendChild(optgroup);
  });

  if (!state.selectedSymbol && symbols.length) {
    state.selectedSymbol = symbols[0].symbol;

    select.value = state.selectedSymbol;

    subscribeToSymbol(state.selectedSymbol);

    loadHistory(state.selectedSymbol);
  }
}


/* ============================================================
   DERIV MESSAGE HANDLER
   ============================================================ */

function handleDerivMessage(raw) {
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  if (data.error) {
    console.error("Deriv API error:", data.error);
    return;
  }

  if (Array.isArray(data.active_symbols)) {
    handleActiveSymbols(data);
  }

  if (data.tick) {
    handleTick(data.tick);
  }

  if (data.candles) {
    handleHistoricalCandles(data.candles);
  }
}


/* ============================================================
   LIVE TICKS
   ============================================================ */

function subscribeToSymbol(symbol) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  sendDeriv({
    forget_all: "ticks"
  });

  sendDeriv({
    ticks: symbol,
    subscribe: 1,
    req_id: 20
  });
}


function handleTick(tick) {
  const symbol = tick.symbol;

  if (!symbol) return;

  const price = safeNumber(
    tick.quote ?? tick.ask ?? tick.bid
  );

  if (!price) return;

  state.livePrice = price;

  state.ticks[symbol] = {
    time: safeNumber(tick.epoch, Date.now() / 1000),
    price
  };

  if (symbol === state.selectedSymbol) {
    setText("#price", roundPrice(price));
    setText("#livePrice", roundPrice(price));

    const selectedMarket = $("#selectedMarket");

    if (selectedMarket) {
      const option =
        $("#market")?.selectedOptions?.[0];

      selectedMarket.textContent =
        option?.textContent || symbol;
    }
  }
}


/* ============================================================
   HISTORY
   ============================================================ */

async function loadHistory(symbol) {
  if (!symbol) return;

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  sendDeriv({
    ticks_history: symbol,
    style: "candles",
    granularity: 60,
    count: CONFIG.HISTORY_COUNT,
    end: "latest",
    req_id: 30
  });
}


function handleHistoricalCandles(candles) {
  if (!Array.isArray(candles)) return;

  const symbol = state.selectedSymbol;

  if (!symbol) return;

  state.candles[symbol] = candles
    .map(c => ({
      time: safeNumber(c.epoch ?? c.time),
      open: safeNumber(c.open),
      high: safeNumber(c.high),
      low: safeNumber(c.low),
      close: safeNumber(c.close)
    }))
    .filter(c =>
      c.time &&
      c.high >= c.low
    )
    .sort((a, b) => a.time - b.time);

  exposeGlobalMarketState();

  runPrecisionAnalysis(false);
}


/* ============================================================
   CLOSED CANDLES
   ============================================================ */

function getClosedCandles(symbol, timeframe) {
  const source = state.candles[symbol] || [];

  if (!source.length) return [];

  const now = Math.floor(Date.now() / 1000);

  const closed1m = source.filter(c => {
    return c.time + 60 <= now;
  });

  if (timeframe === "M1") {
    return closed1m;
  }

  const seconds =
    CONFIG.TIMEFRAMES[timeframe] || 60;

  return aggregateCandles(
    closed1m,
    seconds
  );
}


function aggregateCandles(candles, seconds) {
  if (!candles.length) return [];

  const buckets = new Map();

  candles.forEach(candle => {
    const bucket =
      Math.floor(candle.time / seconds) *
      seconds;

    if (!buckets.has(bucket)) {
      buckets.set(bucket, {
        time: bucket,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      });
    } else {
      const b = buckets.get(bucket);

      b.high = Math.max(b.high, candle.high);

      b.low = Math.min(b.low, candle.low);

      b.close = candle.close;
    }
  });

  return [...buckets.values()]
    .sort((a, b) => a.time - b.time);
}


/* ============================================================
   SWING DETECTION
   ============================================================ */

function detectSwings(candles) {
  const result = {
    highs: [],
    lows: []
  };

  if (
    !Array.isArray(candles) ||
    candles.length < CONFIG.DEPTH * 2 + 5
  ) {
    return result;
  }

  const depth = CONFIG.DEPTH;

  const deviation =
    getDeviation(candles);

  for (
    let i = depth;
    i < candles.length - depth;
    i++
  ) {
    const current = candles[i];

    let isHigh = true;
    let isLow = true;

    for (
      let j = i - depth;
      j <= i + depth;
      j++
    ) {
      if (j === i) continue;

      if (candles[j].high > current.high) {
        isHigh = false;
      }

      if (candles[j].low < current.low) {
        isLow = false;
      }

      if (!isHigh && !isLow) break;
    }

    if (isHigh) {
      result.highs.push({
        ...current,
        index: i,
        type: "HIGH",
        deviation
      });
    }

    if (isLow) {
      result.lows.push({
        ...current,
        index: i,
        type: "LOW",
        deviation
      });
    }
  }

  result.highs = cleanSwings(
    result.highs,
    "HIGH"
  );

  result.lows = cleanSwings(
    result.lows,
    "LOW"
  );

  return result;
}


function cleanSwings(swings, type) {
  const output = [];

  swings.forEach(swing => {
    const last = output[output.length - 1];

    if (
      !last ||
      swing.index - last.index > CONFIG.BACKSTEP
    ) {
      output.push(swing);
      return;
    }

    if (type === "HIGH") {
      if (swing.high > last.high) {
        output[output.length - 1] = swing;
      }
    } else {
      if (swing.low < last.low) {
        output[output.length - 1] = swing;
      }
    }
  });

  return output;
}


function getDeviation(candles) {
  const ranges = candles
    .slice(-50)
    .map(c => c.high - c.low)
    .filter(v => v > 0);

  if (!ranges.length) return 0;

  const avg =
    ranges.reduce((a, b) => a + b, 0) /
    ranges.length;

  return avg * (CONFIG.DEVIATION / 5);
}


/* ============================================================
   MARKET STRUCTURE
   ============================================================ */

function classifyStructure(candles, swings) {
  const highs = swings.highs || [];
  const lows = swings.lows || [];

  const highLabels = [];

  const lowLabels = [];

  for (let i = 1; i < highs.length; i++) {
    highLabels.push(
      highs[i].high > highs[i - 1].high
        ? "HH"
        : "LH"
    );
  }

  for (let i = 1; i < lows.length; i++) {
    lowLabels.push(
      lows[i].low > lows[i - 1].low
        ? "HL"
        : "LL"
    );
  }

  const bullish =
    highLabels.slice(-3).filter(x => x === "HH").length +
    lowLabels.slice(-3).filter(x => x === "HL").length;

  const bearish =
    highLabels.slice(-3).filter(x => x === "LH").length +
    lowLabels.slice(-3).filter(x => x === "LL").length;

  let bias = "NEUTRAL";

  if (bullish > bearish) {
    bias = "BULLISH";
  } else if (bearish > bullish) {
    bias = "BEARISH";
  }

  return {
    bias,

    highLabels,
    lowLabels,

    lastHigh:
      highs[highs.length - 1] || null,

    previousHigh:
      highs[highs.length - 2] || null,

    lastLow:
      lows[lows.length - 1] || null,

    previousLow:
      lows[lows.length - 2] || null
  };
}


/* ============================================================
   BOS / CHOCH
   ============================================================ */

function detectStructureEvents(candles, structure) {
  if (!candles.length) {
    return {
      bos: null,
      choch: null
    };
  }

  const last =
    candles[candles.length - 1];

  let bos = null;
  let choch = null;

  if (
    structure.lastHigh &&
    last.close > structure.lastHigh.high
  ) {
    bos = "BULLISH";

    if (structure.bias === "BEARISH") {
      choch = "BULLISH";
    }
  }

  if (
    structure.lastLow &&
    last.close < structure.lastLow.low
  ) {
    bos = "BEARISH";

    if (structure.bias === "BULLISH") {
      choch = "BEARISH";
    }
  }

  return {
    bos,
    choch
  };
}


/* ============================================================
   LIQUIDITY
   ============================================================ */

function detectLiquidity(candles, structure) {
  if (!candles.length) return null;

  const last =
    candles[candles.length - 1];

  if (
    structure.lastHigh &&
    last.high > structure.lastHigh.high &&
    last.close < structure.lastHigh.high
  ) {
    return {
      type: "BEARISH_SWEEP",
      direction: "BEARISH",
      level: structure.lastHigh.high
    };
  }

  if (
    structure.lastLow &&
    last.low < structure.lastLow.low &&
    last.close > structure.lastLow.low
  ) {
    return {
      type: "BULLISH_SWEEP",
      direction: "BULLISH",
      level: structure.lastLow.low
    };
  }

  return null;
}


/* ============================================================
   SUPPORT / RESISTANCE
   ============================================================ */

function detectSupportResistance(candles, swings) {
  if (!candles.length) {
    return {
      support: null,
      resistance: null
    };
  }

  const price =
    candles[candles.length - 1].close;

  const supports = (swings.lows || [])
    .map(x => x.low)
    .filter(x => x < price)
    .sort((a, b) => b - a);

  const resistances = (swings.highs || [])
    .map(x => x.high)
    .filter(x => x > price)
    .sort((a, b) => a - b);

  return {
    support: supports[0] ?? null,
    resistance: resistances[0] ?? null
  };
}


/* ============================================================
   SUPPLY / DEMAND
   ============================================================ */

function detectSupplyDemand(candles) {
  if (candles.length < 3) return null;

  const a = candles[candles.length - 3];
  const b = candles[candles.length - 2];
  const c = candles[candles.length - 1];

  const avgRange =
    getAverageRange(candles);

  const strongBull =
    c.close > c.open &&
    (c.close - c.open) >= avgRange * 0.7;

  const strongBear =
    c.close < c.open &&
    (c.open - c.close) >= avgRange * 0.7;

  if (
    a.close < a.open &&
    strongBull &&
    c.close > a.high
  ) {
    return {
      type: "DEMAND",
      direction: "BULLISH",
      low: Math.min(a.low, b.low),
      high: Math.max(a.high, b.high)
    };
  }

  if (
    a.close > a.open &&
    strongBear &&
    c.close < a.low
  ) {
    return {
      type: "SUPPLY",
      direction: "BEARISH",
      low: Math.min(a.low, b.low),
      high: Math.max(a.high, b.high)
    };
  }

  return null;
}


/* ============================================================
   ORDER BLOCK
   ============================================================ */

function detectOrderBlock(candles) {
  if (candles.length < 3) return null;

  const a = candles[candles.length - 3];
  const c = candles[candles.length - 1];

  if (
    a.close < a.open &&
    c.close > c.open &&
    c.close > a.high
  ) {
    return {
      direction: "BULLISH",
      low: a.low,
      high: a.high,
      midpoint: (a.low + a.high) / 2
    };
  }

  if (
    a.close > a.open &&
    c.close < c.open &&
    c.close < a.low
  ) {
    return {
      direction: "BEARISH",
      low: a.low,
      high: a.high,
      midpoint: (a.low + a.high) / 2
    };
  }

  return null;
}


/* ============================================================
   FVG
   ============================================================ */

function detectFVG(candles) {
  if (candles.length < 3) return null;

  const a = candles[candles.length - 3];
  const c = candles[candles.length - 1];

  if (c.low > a.high) {
    return {
      direction: "BULLISH",
      low: a.high,
      high: c.low
    };
  }

  if (c.high < a.low) {
    return {
      direction: "BEARISH",
      low: c.high,
      high: a.low
    };
  }

  return null;
}


/* ============================================================
   CANDLESTICK CONFIRMATION
   ============================================================ */

function detectCandlestickConfirmation(candles) {
  if (candles.length < 2) {
    return {
      confirmed: false,
      direction: null,
      pattern: null
    };
  }

  const prev =
    candles[candles.length - 2];

  const last =
    candles[candles.length - 1];

  const body =
    Math.abs(last.close - last.open);

  const range =
    last.high - last.low;

  if (!range) {
    return {
      confirmed: false,
      direction: null,
      pattern: null
    };
  }

  const upperWick =
    last.high -
    Math.max(last.open, last.close);

  const lowerWick =
    Math.min(last.open, last.close) -
    last.low;

  const bullishPin =
    lowerWick > body * 2 &&
    last.close > last.open;

  const bearishPin =
    upperWick > body * 2 &&
    last.close < last.open;

  const bullishEngulf =
    prev.close < prev.open &&
    last.close > last.open &&
    last.open <= prev.close &&
    last.close >= prev.open;

  const bearishEngulf =
    prev.close > prev.open &&
    last.close < last.open &&
    last.open >= prev.close &&
    last.close <= prev.open;

  const strongBull =
    last.close > last.open &&
    body >= range * 0.65;

  const strongBear =
    last.close < last.open &&
    body >= range * 0.65;

  if (
    bullishPin ||
    bullishEngulf ||
    strongBull
  ) {
    return {
      confirmed: true,
      direction: "BULLISH",
      pattern:
        bullishEngulf
          ? "Bullish Engulfing"
          : bullishPin
            ? "Bullish Pin Bar"
            : "Strong Bullish Candle"
    };
  }

  if (
    bearishPin ||
    bearishEngulf ||
    strongBear
  ) {
    return {
      confirmed: true,
      direction: "BEARISH",
      pattern:
        bearishEngulf
          ? "Bearish Engulfing"
          : bearishPin
            ? "Bearish Pin Bar"
            : "Strong Bearish Candle"
    };
  }

  return {
    confirmed: false,
    direction: null,
    pattern: "No Candle Confirmation"
  };
}


/* ============================================================
   DISPLACEMENT
   ============================================================ */

function detectDisplacement(candles) {
  if (!candles.length) return null;

  const last =
    candles[candles.length - 1];

  const body =
    Math.abs(last.close - last.open);

  const average =
    getAverageRange(candles);

  if (body >= average * 1.5) {
    return {
      direction:
        last.close > last.open
          ? "BULLISH"
          : "BEARISH"
    };
  }

  return null;
}


function getAverageRange(candles) {
  const recent =
    candles.slice(-50);

  if (!recent.length) return 0;

  return (
    recent.reduce(
      (sum, c) => sum + (c.high - c.low),
      0
    ) / recent.length
  );
}


/* ============================================================
   TIMEFRAME ANALYSIS
   ============================================================ */

function analyzeTimeframe(symbol, timeframe) {
  const candles =
    getClosedCandles(symbol, timeframe);

  if (candles.length < 20) {
    return {
      timeframe,
      candles,
      insufficientData: true,
      swings: {
        highs: [],
        lows: []
      },
      structure: {
        bias: "NEUTRAL"
      },
      events: {},
      liquidity: null,
      sr: {},
      supplyDemand: null,
      orderBlock: null,
      fvg: null,
      candle: {
        confirmed: false
      },
      displacement: null
    };
  }

  const swings =
    detectSwings(candles);

  const structure =
    classifyStructure(
      candles,
      swings
    );

  const events =
    detectStructureEvents(
      candles,
      structure
    );

  const liquidity =
    detectLiquidity(
      candles,
      structure
    );

  const sr =
    detectSupportResistance(
      candles,
      swings
    );

  const supplyDemand =
    detectSupplyDemand(candles);

  const orderBlock =
    detectOrderBlock(candles);

  const fvg =
    detectFVG(candles);

  const candle =
    detectCandlestickConfirmation(
      candles
    );

  const displacement =
    detectDisplacement(candles);

  return {
    timeframe,
    candles,
    insufficientData: false,
    swings,
    structure,
    events,
    liquidity,
    sr,
    supplyDemand,
    orderBlock,
    fvg,
    candle,
    displacement
  };
}


/* ============================================================
   TOP-DOWN ANALYSIS
   ============================================================ */

function buildTopDownAnalysis(symbol) {
  const timeframes = [
    "Daily",
    "H4",
    "H2",
    "H1",
    "M30",
    "M15",
    "M5"
  ];

  const result = {};

  timeframes.forEach(tf => {
    result[tf] =
      analyzeTimeframe(
        symbol,
        tf
      );
  });

  return result;
}


/* ============================================================
   HTF BIAS
   ============================================================ */

function getHTFBias(topDown) {
  const votes = [];

  ["Daily", "H4", "H2"].forEach(tf => {
    const bias =
      topDown[tf]?.structure?.bias;

    if (
      bias === "BULLISH" ||
      bias === "BEARISH"
    ) {
      votes.push(bias);
    }
  });

  const oneHour =
    topDown.H1?.structure?.bias;

  if (
    oneHour === "BULLISH" ||
    oneHour === "BEARISH"
  ) {
    return oneHour;
  }

  const bullish =
    votes.filter(x => x === "BULLISH")
      .length;

  const bearish =
    votes.filter(x => x === "BEARISH")
      .length;

  if (bullish > bearish) {
    return "BULLISH";
  }

  if (bearish > bullish) {
    return "BEARISH";
  }

  return "NEUTRAL";
}


/* ============================================================
   DIRECTION
   ============================================================ */

function determineDirection(
  h1,
  execution,
  htfBias
) {
  if (!h1 || !execution) {
    return null;
  }

  const candidates = [];

  if (h1.events?.choch) {
    candidates.push(h1.events.choch);
  }

  if (h1.events?.bos) {
    candidates.push(h1.events.bos);
  }

  if (execution.events?.choch) {
    candidates.push(execution.events.choch);
  }

  if (execution.events?.bos) {
    candidates.push(execution.events.bos);
  }

  if (
    h1.structure?.bias === "BULLISH"
  ) {
    candidates.push("BULLISH");
  }

  if (
    h1.structure?.bias === "BEARISH"
  ) {
    candidates.push("BEARISH");
  }

  if (
    execution.structure?.bias === "BULLISH"
  ) {
    candidates.push("BULLISH");
  }

  if (
    execution.structure?.bias === "BEARISH"
  ) {
    candidates.push("BEARISH");
  }

  const bullish =
    candidates.filter(
      x => x === "BULLISH"
    ).length;

  const bearish =
    candidates.filter(
      x => x === "BEARISH"
    ).length;

  if (
    htfBias === "BULLISH" &&
    bullish >= bearish
  ) {
    return "BULLISH";
  }

  if (
    htfBias === "BEARISH" &&
    bearish >= bullish
  ) {
    return "BEARISH";
  }

  if (bullish > bearish) {
    return "BULLISH";
  }

  if (bearish > bullish) {
    return "BEARISH";
  }

  return null;
}


/* ============================================================
   SCORE EVIDENCE
   ============================================================ */

function scoreEvidence(
  h1,
  execution,
  direction,
  htfBias
) {
  let score = 0;

  const confirmations = [];

  const reasons = [];

  const aligned = direction ===
    (
      htfBias === "BULLISH"
        ? "BULLISH"
        : htfBias === "BEARISH"
          ? "BEARISH"
          : direction
    );

  if (aligned) {
    score += 2;

    confirmations.push(
      "HTF alignment"
    );

    reasons.push(
      "Higher-timeframe bias supports the direction."
    );
  }

  if (
    h1.events?.bos === direction
  ) {
    score += 2;

    confirmations.push("1H BOS");

    reasons.push(
      "1H market structure has broken in the signal direction."
    );
  }

  if (
    h1.events?.choch === direction
  ) {
    score += 2;

    confirmations.push("1H CHoCH");

    reasons.push(
      "1H structure shows a change of character."
    );
  }

  if (
    execution.events?.bos === direction
  ) {
    score += 2;

    confirmations.push(
      `${execution.timeframe} BOS`
    );

    reasons.push(
      `${execution.timeframe} structure confirms the direction.`
    );
  }

  if (
    execution.events?.choch === direction
  ) {
    score += 2;

    confirmations.push(
      `${execution.timeframe} CHoCH`
    );

    reasons.push(
      `${execution.timeframe} shows directional structure change.`
    );
  }

  if (
    execution.liquidity?.direction === direction
  ) {
    score += 2;

    confirmations.push(
      "Liquidity sweep"
    );

    reasons.push(
      "Liquidity was swept and price returned back inside the level."
    );
  }

  if (
    execution.displacement?.direction === direction
  ) {
    score += 2;

    confirmations.push(
      "Displacement"
    );

    reasons.push(
      "Strong directional displacement is present."
    );
  }

  if (
    execution.fvg?.direction === direction
  ) {
    score += 1;

    confirmations.push(
      "FVG"
    );

    reasons.push(
      "A directional fair value gap is present."
    );
  }

  if (
    execution.orderBlock?.direction === direction
  ) {
    score += 1;

    confirmations.push(
      "Order Block"
    );

    reasons.push(
      "A directional order block is present."
    );
  }

  if (
    execution.supplyDemand?.direction === direction
  ) {
    score += 1;

    confirmations.push(
      direction === "BULLISH"
        ? "Demand"
        : "Supply"
    );

    reasons.push(
      direction === "BULLISH"
        ? "Fresh demand supports the bullish setup."
        : "Fresh supply supports the bearish setup."
    );
  }

  /*
     IMPORTANT:
     Candle confirmation adds strength,
     but is NOT mandatory for an EARLY SETUP.
  */

  if (
    execution.candle?.confirmed &&
    execution.candle.direction === direction
  ) {
    score += 2;

    confirmations.push(
      "Candlestick confirmation"
    );

    reasons.push(
      execution.candle.pattern
    );
  }

  if (
    execution.sr?.support &&
    direction === "BULLISH"
  ) {
    score += 1;

    confirmations.push(
      "Support"
    );

    reasons.push(
      "Price is interacting with a support area."
    );
  }

  if (
    execution.sr?.resistance &&
    direction === "BEARISH"
  ) {
    score += 1;

    confirmations.push(
      "Resistance"
    );

    reasons.push(
      "Price is interacting with resistance."
    );
  }

  return {
    score,
    confirmations,
    reasons
  };
}


/* ============================================================
   GRADE SETUP
   ============================================================ */

function gradeSetup(
  evidence,
  execution,
  direction
) {
  const candleConfirmed =
    execution.candle?.confirmed &&
    execution.candle.direction === direction;

  /*
     EARLY SETUP
     ---------------------------------------------------------
     This is the important new behavior.

     A trade can become EARLY SETUP without a candlestick
     confirmation.

     Required:
     - directional structure / HTF alignment
     - at least one meaningful structural/price-action event
     - enough evidence to justify watching the setup
  */

  const structuralConfirmation =
    evidence.confirmations.some(item =>
      [
        "1H BOS",
        "1H CHoCH",
        `${execution.timeframe} BOS`,
        `${execution.timeframe} CHoCH`,
        "Liquidity sweep",
        "Displacement"
      ].includes(item)
    );

  const earlyEligible =
    evidence.score >= 4 &&
    structuralConfirmation;

  if (
    evidence.score >= 11 &&
    evidence.confirmations.length >= 6 &&
    candleConfirmed
  ) {
    return {
      grade: "A+",
      stage: "CONFIRMED",
      risk: "LOW"
    };
  }

  if (
    evidence.score >= 8 &&
    evidence.confirmations.length >= 5
  ) {
    return {
      grade: "A",
      stage: "CONFIRMED",
      risk: "LOW"
    };
  }

  if (
    evidence.score >= 6 &&
    evidence.confirmations.length >= 4
  ) {
    return {
      grade: "B",
      stage: "CONFIRMED",
      risk: "MODERATE"
    };
  }

  if (
    evidence.score >= 4 &&
    evidence.confirmations.length >= 3
  ) {
    return {
      grade: "C",
      stage: "CONFIRMED",
      risk: "HIGHER RISK"
    };
  }

  /*
     NEW:
     EARLY SETUP does not require candle confirmation.
  */

  if (earlyEligible) {
    return {
      grade: "EARLY",
      stage: "EARLY SETUP",
      risk: "DEVELOPING"
    };
  }

  return {
    grade: null,
    stage: "WAITING",
    risk: "NONE"
  };
}


/* ============================================================
   TRADE LEVELS
   ============================================================ */

function calculateTradeLevels(
  direction,
  h1,
  execution
) {
  const candles =
    execution.candles || [];

  if (!candles.length) return null;

  const last =
    candles[candles.length - 1];

  const entry =
    safeNumber(last.close);

  const range =
    Math.max(
      getAverageRange(candles),
      entry * 0.0005
    );

  const buffer =
    range * 0.15;

  let sl;

  if (direction === "BULLISH") {
    const h1Low =
      h1?.structure?.lastLow?.low;

    const execLow =
      execution?.structure?.lastLow?.low;

    const candidates =
      [h1Low, execLow]
        .filter(Number.isFinite);

    sl =
      candidates.length
        ? Math.min(...candidates) - buffer
        : entry - range * 1.5;
  } else {
    const h1High =
      h1?.structure?.lastHigh?.high;

    const execHigh =
      execution?.structure?.lastHigh?.high;

    const candidates =
      [h1High, execHigh]
        .filter(Number.isFinite);

    sl =
      candidates.length
        ? Math.max(...candidates) + buffer
        : entry + range * 1.5;
  }

  const risk =
    Math.abs(entry - sl);

  if (!risk) return null;

  const tp1 =
    direction === "BULLISH"
      ? entry + risk * 2
      : entry - risk * 2;

  const tp2 =
    direction === "BULLISH"
      ? entry + risk * 3
      : entry - risk * 3;

  const rr =
    Math.abs(tp2 - entry) / risk;

  const be =
    entry;

  return {
    entry,
    sl,
    be,
    tp1,
    tp2,
    rr,

    invalidation:
      direction === "BULLISH"
        ? `Close below ${roundPrice(sl)}`
        : `Close above ${roundPrice(sl)}`
  };
}


/* ============================================================
   PRECISION SIGNAL
   ============================================================ */

function generatePrecisionSignal(
  symbol,
  timeframe,
  topDown
) {
  const h1 =
    topDown.H1;

  const execution =
    topDown[timeframe];

  if (
    !h1 ||
    !execution ||
    h1.insufficientData ||
    execution.insufficientData
  ) {
    return null;
  }

  const htfBias =
    getHTFBias(topDown);

  const direction =
    determineDirection(
      h1,
      execution,
      htfBias
    );

  if (!direction) {
    return null;
  }

  const evidence =
    scoreEvidence(
      h1,
      execution,
      direction,
      htfBias
    );

  const grade =
    gradeSetup(
      evidence,
      execution,
      direction
    );

  if (!grade.stage ||
      grade.stage === "WAITING") {
    return null;
  }

  const levels =
    calculateTradeLevels(
      direction,
      h1,
      execution
    );

  if (!levels) return null;

  if (
    levels.rr < CONFIG.MIN_RR
  ) {
    return null;
  }

  const candleConfirmed =
    execution.candle?.confirmed &&
    execution.candle.direction === direction;

  const signal = {
    symbol,

    timeframe,

    direction,

    grade: grade.grade,

    stage: grade.stage,

    risk: grade.risk,

    candleConfirmed,

    candlePattern:
      execution.candle?.pattern ||
      "Awaiting candle confirmation",

    score:
      evidence.score,

    confirmations:
      evidence.confirmations,

    reasons:
      evidence.reasons,

    entry:
      levels.entry,

    sl:
      levels.sl,

    be:
      levels.be,

    tp1:
      levels.tp1,

    tp2:
      levels.tp2,

    rr:
      levels.rr,

    invalidation:
      levels.invalidation,

    htfBias,

    h1Bias:
      h1.structure?.bias ||
      "NEUTRAL",

    bos:
      execution.events?.bos ||
      null,

    choch:
      execution.events?.choch ||
      null,

    liquidity:
      execution.liquidity?.type ||
      "None",

    fvg:
      execution.fvg
        ? execution.fvg.direction
        : "None",

    orderBlock:
      execution.orderBlock
        ? execution.orderBlock.direction
        : "None",

    structure:
      execution.structure?.bias ||
      "NEUTRAL",

    timestamp:
      Date.now(),

    candleTime:
      execution.candles?.[
        execution.candles.length - 1
      ]?.time || null
  };

  signal.explanation =
    buildAIExplanation(signal);

  return signal;
}


/* ============================================================
   AI EXPLANATION
   ============================================================ */

function buildAIExplanation(signal) {
  if (!signal) return "";

  const stageText =
    signal.stage === "EARLY SETUP"
      ? "This is an EARLY SETUP. Candlestick confirmation is not required yet. The setup is developing from structure and price-action evidence."
      : signal.stage === "CONFIRMED"
        ? "This setup has sufficient confirmation for its current grade."
        : "The setup is still developing.";

  const candleText =
    signal.candleConfirmed
      ? `Candlestick confirmation: ${signal.candlePattern}.`
      : "Candlestick confirmation is not present yet.";

  return [
    `${signal.direction} ${signal.grade || ""} ${signal.stage}.`,
    stageText,
    `HTF bias: ${signal.htfBias}.`,
    `1H structure: ${signal.h1Bias}.`,
    `Current timeframe structure: ${signal.structure}.`,
    `Evidence score: ${signal.score}.`,
    signal.confirmations.length
      ? `Evidence: ${signal.confirmations.join(", ")}.`
      : "",
    candleText,
    `Entry: ${roundPrice(signal.entry)}.`,
    `Stop loss: ${roundPrice(signal.sl)}.`,
    `TP1: ${roundPrice(signal.tp1)}.`,
    `TP2: ${roundPrice(signal.tp2)}.`,
    `Risk/reward: 1:${signal.rr.toFixed(2)}.`,
    `Invalidation: ${signal.invalidation}.`
  ]
    .filter(Boolean)
    .join(" ");
}


/* ============================================================
   MAIN ANALYSIS ENGINE
   ============================================================ */

async function runPrecisionAnalysis(manual = false) {
  const symbol =
    state.selectedSymbol;

  if (!symbol) {
    showWaiting("Select a market.");
    return null;
  }

  const topDown =
    buildTopDownAnalysis(symbol);

  const result =
    generatePrecisionSignal(
      symbol,
      state.selectedTimeframe,
      topDown
    );

  state.analysis = {
    symbol,
    timeframe:
      state.selectedTimeframe,
    livePrice:
      state.livePrice,
    topDown,
    signal:
      result,
    timestamp:
      Date.now()
  };

  exposeGlobalMarketState();

  updateExistingDashboard(
    state.analysis
  );

  if (result) {
    processSignal(result);
  } else {
    /*
       Only show WAIT when no EARLY/confirmed setup exists.
    */
    showWaiting(
      "WAIT — NO CONFIRMED SETUP."
    );
  }

  return state.analysis;
}


/* ============================================================
   DASHBOARD UPDATE
   ============================================================ */

function updateExistingDashboard(analysis) {
  const signal =
    analysis.signal;

  if (!signal) return;

  setText(
    "#signal",
    `${signal.direction} ${signal.stage}`
  );

  setText(
    "#direction",
    signal.direction
  );

  setText(
    "#setup",
    signal.stage === "EARLY SETUP"
      ? "EARLY SETUP"
      : `${signal.grade} SETUP`
  );

  setText(
    "#confidence",
    `${signal.score} points`
  );

  setText(
    "#rr",
    `1:${signal.rr.toFixed(2)}`
  );

  setText(
    "#entry",
    roundPrice(signal.entry)
  );

  setText(
    "#sl",
    roundPrice(signal.sl)
  );

  setText(
    "#tp1",
    roundPrice(signal.tp1)
  );

  setText(
    "#tp2",
    roundPrice(signal.tp2)
  );

  const h1 =
    analysis.topDown.H1;

  const execution =
    analysis.topDown[
      analysis.timeframe
    ];

  setText(
    "#swing",
    h1?.structure?.bias ||
      "NEUTRAL"
  );

  setText(
    "#structure",
    execution?.structure?.bias ||
      "NEUTRAL"
  );

  setText(
    "#liquidity",
    execution?.liquidity?.type ||
      "None"
  );

  setText(
    "#sr",
    execution?.sr?.support
      ? `S: ${roundPrice(execution.sr.support)}`
      : execution?.sr?.resistance
        ? `R: ${roundPrice(execution.sr.resistance)}`
        : "None"
  );

  setText(
    "#pattern",
    signal.candlePattern
  );

  setText(
    "#rejection",
    execution?.candle?.confirmed
      ? "YES"
      : "WAITING"
  );

  setText(
    "#momentum",
    execution?.displacement
      ? execution.displacement.direction
      : "NORMAL"
  );

  setText(
    "#confirmation",
    signal.candleConfirmed
      ? "CONFIRMED"
      : "NOT REQUIRED FOR EARLY SETUP"
  );

  setText(
    "#explanationText",
    signal.explanation
  );

  updateOptionalFields(
    signal
  );

  /*
     Keep charts/UI alive.
     Existing chart code can listen for this event.
  */

  document.dispatchEvent(
    new CustomEvent(
      "precision-analysis",
      {
        detail: analysis
      }
    )
  );
}


/* ============================================================
   WAITING
   ============================================================ */

function showWaiting(message) {
  setText(
    "#signal",
    message
  );

  setText(
    "#direction",
    "WAIT"
  );

  setText(
    "#setup",
    "NO SETUP"
  );

  setText(
    "#confidence",
    "--"
  );

  setText(
    "#rr",
    "--"
  );

  setText(
    "#explanationText",
    message
  );
}


/* ============================================================
   OPTIONAL DASHBOARD FIELDS
   ============================================================ */

function updateOptionalFields(signal) {
  setText(
    "#be",
    roundPrice(signal.be)
  );

  setText(
    "#htfBias",
    signal.htfBias
  );

  setText(
    "#h1Structure",
    signal.h1Bias
  );

  setText(
    "#invalidation",
    signal.invalidation
  );

  setText(
    "#choch",
    signal.choch || "None"
  );

  setText(
    "#bos",
    signal.bos || "None"
  );

  setText(
    "#fvg",
    signal.fvg
  );

  setText(
    "#orderBlock",
    signal.orderBlock
  );

  setText(
    "#signalStage",
    signal.stage
  );

  setText(
    "#signalRisk",
    signal.risk
  );

  setText(
    "#candleStatus",
    signal.candleConfirmed
      ? "CONFIRMED"
      : "NOT CONFIRMED"
  );
}


/* ============================================================
   SIGNAL PROCESSING
   ============================================================ */

function processSignal(signal) {
  if (!signal) return;

  const key =
    createSignalKey(
      signal
    );

  /*
     New signal
  */

  if (!state.activeSignal) {
    state.activeSignal = signal;

    state.lastSignalKey = key;

    addSignalHistory(
      signal
    );

    notifySignal(
      signal,
      "NEW"
    );

    return;
  }

  const previous =
    state.activeSignal;

  /*
     Invalidation check
  */

  if (
    isSignalInvalidated(
      previous
    )
  ) {
    notifySignal(
      previous,
      "INVALIDATED"
    );

    state.activeSignal = null;

    return;
  }

  /*
     Upgrade:
     EARLY → C → B → A → A+
  */

  const oldRank =
    getStageRank(
      previous
    );

  const newRank =
    getStageRank(
      signal
    );

  if (newRank > oldRank) {
    state.activeSignal = signal;

    addSignalHistory(
      signal
    );

    notifySignal(
      signal,
      "UPGRADED"
    );

    return;
  }

  /*
     Direction changed:
     treat as new setup
  */

  if (
    previous.direction !==
    signal.direction
  ) {
    state.activeSignal = signal;

    addSignalHistory(
      signal
    );

    notifySignal(
      signal,
      "NEW"
    );
  }
}


function getStageRank(signal) {
  if (!signal) return 0;

  if (signal.grade === "A+") return 5;
  if (signal.grade === "A") return 4;
  if (signal.grade === "B") return 3;
  if (signal.grade === "C") return 2;

  if (signal.stage === "EARLY SETUP") {
    return 1;
  }

  return 0;
}


function isSignalInvalidated(signal) {
  if (!signal) return false;

  const price =
    state.livePrice;

  if (!Number.isFinite(price)) {
    return false;
  }

  if (
    signal.direction === "BULLISH" &&
    price < signal.sl
  ) {
    return true;
  }

  if (
    signal.direction === "BEARISH" &&
    price > signal.sl
  ) {
    return true;
  }

  return false;
}


function createSignalKey(signal) {
  return [
    signal.symbol,
    signal.direction,
    signal.grade || signal.stage,
    signal.candleTime
  ].join("|");
}


/* ============================================================
   SIGNAL HISTORY
   ============================================================ */

function addSignalHistory(signal) {
  state.signalHistory.unshift({
    ...signal
  });

  state.signalHistory =
    state.signalHistory.slice(0, 50);

  renderSignalHistory();
}


function renderSignalHistory() {
  const container =
    $("#signalHistory");

  if (!container) return;

  container.innerHTML = "";

  state.signalHistory.forEach(signal => {
    const row =
      document.createElement("div");

    row.className =
      "signal-history-item";

    row.textContent =
      `${signal.direction} ${signal.grade || signal.stage} | ${signal.symbol} | ${new Date(signal.timestamp).toLocaleTimeString()}`;

    container.appendChild(row);
  });
}


/* ============================================================
   ALERT CONTROL
   ============================================================ */

function createAlertControl() {
  if ($("#precisionAlertControl")) {
    return;
  }

  const button =
    document.createElement("button");

  button.id =
    "precisionAlertControl";

  button.textContent =
    "🔔 Alerts ON";

  button.style.margin =
    "8px";

  button.addEventListener(
    "click",
    async () => {
      state.alertsEnabled =
        !state.alertsEnabled;

      button.textContent =
        state.alertsEnabled
          ? "🔔 Alerts ON"
          : "🔕 Alerts OFF";

      if (
        state.alertsEnabled &&
        "Notification" in window &&
        Notification.permission === "default"
      ) {
        try {
          await Notification.requestPermission();
        } catch {}
      }
    }
  );

  document.body.appendChild(
    button
  );
}


/* ============================================================
   NOTIFICATIONS
   ============================================================ */

function notifySignal(signal, type) {
  if (!state.alertsEnabled) {
    return;
  }

  const key =
    `${createSignalKey(signal)}|${type}`;

  const previous =
    state.notifiedSignals.get(key);

  if (
    previous &&
    Date.now() - previous <
      CONFIG.DUPLICATE_COOLDOWN
  ) {
    return;
  }

  state.notifiedSignals.set(
    key,
    Date.now()
  );

  const title =
    type === "UPGRADED"
      ? "🔄 PRECISION SIGNAL UPGRADED"
      : type === "INVALIDATED"
        ? "❌ PRECISION SIGNAL INVALIDATED"
        : "🎯 PRECISION SIGNAL";

  const message =
    type === "INVALIDATED"
      ? `${signal.symbol} ${signal.direction} setup invalidated.`
      : `${signal.symbol} ${signal.direction} — ${signal.stage || signal.grade}. Entry ${roundPrice(signal.entry)} | SL ${roundPrice(signal.sl)} | TP2 ${roundPrice(signal.tp2)}`;

  showInAppAlert(
    title,
    message
  );

  if (
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    try {
      new Notification(
        title,
        {
          body: message
        }
      );
    } catch {}
  }

  if (
    typeof window.showAlert ===
    "function"
  ) {
    try {
      window.showAlert(
        title,
        message
      );
    } catch {}
  }
}


function showInAppAlert(
  title,
  message
) {
  let box =
    $("#precisionInAppAlert");

  if (!box) {
    box =
      document.createElement("div");

    box.id =
      "precisionInAppAlert";

    box.style.position =
      "fixed";

    box.style.right =
      "15px";

    box.style.bottom =
      "15px";

    box.style.zIndex =
      "99999";

    box.style.maxWidth =
      "350px";

    box.style.padding =
      "15px";

    box.style.background =
      "#111";

    box.style.color =
      "#fff";

    box.style.borderRadius =
      "10px";

    document.body.appendChild(
      box
    );
  }

  box.innerHTML = `
    <strong>${escapeHTML(title)}</strong>
    <div style="margin-top:6px">
      ${escapeHTML(message)}
    </div>
  `;

  setTimeout(() => {
    if (box) {
      box.innerHTML = "";
    }
  }, 10000);
}


/* ============================================================
   QUESTION / AI BAR
   ============================================================ */

function createQuestionBar() {
  /*
     If the user already has the Question Bar in HTML,
     don't create another one.
  */

  const existingInput =
    $("#aiQuestion") ||
    $("#questionInput");

  const existingButton =
    $("#askAI") ||
    $("#askQuestionButton");

  const existingAnswer =
    $("#aiAnswer") ||
    $("#answer") ||
    $("#questionAnswer");

  if (
    existingInput &&
    existingButton
  ) {
    attachQuestionHandlers(
      existingInput,
      existingButton,
      existingAnswer
    );

    return;
  }

  const wrapper =
    document.createElement("div");

  wrapper.id =
    "precisionQuestionBar";

  wrapper.style.margin =
    "20px 0";

  wrapper.innerHTML = `
    <div style="font-weight:700;margin-bottom:8px">
      🤖 Ask Successful Precision AI
    </div>

    <div style="display:flex;gap:8px">
      <input
        id="questionInput"
        type="text"
        placeholder="Ask why this signal is early, confirmed, rejected, etc..."
        style="flex:1"
      />

      <button id="askQuestionButton">
        Ask AI
      </button>
    </div>

    <div
      id="questionAnswer"
      style="margin-top:10px"
    >
      Ask a question about the live market or signal.
    </div>
  `;

  document.body.appendChild(
    wrapper
  );

  attachQuestionHandlers(
    $("#questionInput"),
    $("#askQuestionButton"),
    $("#questionAnswer")
  );
}


function attachQuestionHandlers(
  input,
  button,
  answerBox
) {
  if (!input || !button) return;

  if (
    button.dataset.aiBound === "true"
  ) {
    return;
  }

  button.dataset.aiBound = "true";

  button.addEventListener(
    "click",
    () => {
      askSuccessfulAI(
        input.value,
        answerBox
      );
    }
  );

  input.addEventListener(
    "keydown",
    event => {
      if (event.key === "Enter") {
        askSuccessfulAI(
          input.value,
          answerBox
        );
      }
    }
  );
}


/* ============================================================
   AI QUESTION
   ============================================================ */

async function askSuccessfulAI(
  question,
  answerBox
) {
  question =
    String(question || "")
      .trim();

  if (!question) return;

  const box =
    answerBox ||
    $("#aiAnswer") ||
    $("#answer") ||
    $("#questionAnswer");

  if (box) {
    box.textContent =
      "Analyzing the live market data...";
  }

  const analysis =
    state.analysis ||
    window.lastAnalysis ||
    window.currentAnalysis ||
    {};

  const candles =
    getClosedCandles(
      state.selectedSymbol,
      state.selectedTimeframe
    );

  const market = {
    symbol:
      state.selectedSymbol ||
      $("#market")?.value ||
      "Unknown",

    name:
      $("#market")
        ?.selectedOptions?.[0]
        ?.textContent ||
      "",

    price:
      state.livePrice ??
      null
  };

  try {
    const response =
      await fetch(
        "/api/ask",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            question,
            market,
            analysis:
              buildAIContext(
                analysis
              ),
            candles
          })
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "AI request failed"
      );
    }

    const answer =
      data.answer ||
      data.fallback ||
      "No answer returned.";

    if (box) {
      box.textContent =
        answer;
    }

    window.lastAIAnswer =
      answer;

    return answer;

  } catch (error) {
    console.error(
      "AI question error:",
      error
    );

    /*
       The user still gets a useful answer
       even if /api/ask is unavailable.
    */

    const fallback =
      localQuestionAnswer(
        question,
        analysis
      );

    if (box) {
      box.textContent =
        fallback;
    }

    window.lastAIAnswer =
      fallback;

    return fallback;
  }
}


/* ============================================================
   AI CONTEXT
   ============================================================ */

function buildAIContext(
  analysis
) {
  if (!analysis) {
    return {};
  }

  const signal =
    analysis.signal;

  return {
    symbol:
      analysis.symbol,

    timeframe:
      analysis.timeframe,

    livePrice:
      analysis.livePrice,

    signal: signal
      ? {
          direction:
            signal.direction,

          stage:
            signal.stage,

          grade:
            signal.grade,

          risk:
            signal.risk,

          score:
            signal.score,

          confirmations:
            signal.confirmations,

          candleConfirmed:
            signal.candleConfirmed,

          candlePattern:
            signal.candlePattern,

          entry:
            signal.entry,

          sl:
            signal.sl,

          be:
            signal.be,

          tp1:
            signal.tp1,

          tp2:
            signal.tp2,

          rr:
            signal.rr,

          htfBias:
            signal.htfBias,

          h1Bias:
            signal.h1Bias,

          invalidation:
            signal.invalidation,

          explanation:
            signal.explanation
        }
      : null,

    activeSignal:
      state.activeSignal
        ? {
            direction:
              state.activeSignal.direction,

            stage:
              state.activeSignal.stage,

            grade:
              state.activeSignal.grade
          }
        : null
  };
}


/* ============================================================
   LOCAL QUESTION FALLBACK
   ============================================================ */

function localQuestionAnswer(
  question,
  analysis
) {
  const q =
    question.toLowerCase();

  const signal =
    analysis?.signal;

  if (!signal) {
    return (
      "There is currently no Precision setup. " +
      "The engine is waiting for enough market-structure and price-action evidence."
    );
  }

  if (
    q.includes("early") ||
    q.includes("why")
  ) {
    if (
      signal.stage === "EARLY SETUP"
    ) {
      return (
        `This is an EARLY SETUP because the bot has detected enough structural and price-action evidence to start monitoring the opportunity, but candlestick confirmation has not appeared yet. Current direction: ${signal.direction}. HTF bias: ${signal.htfBias}. Evidence: ${signal.confirmations.join(", ")}.`
      );
    }

    return (
      `The current setup is ${signal.stage || signal.grade}. The current evidence includes: ${signal.confirmations.join(", ")}.`
    );
  }

  if (
    q.includes("candle") ||
    q.includes("candlestick")
  ) {
    return signal.candleConfirmed
      ? `Candlestick confirmation is present: ${signal.candlePattern}.`
      : "Candlestick confirmation is not present yet. The setup can remain an EARLY SETUP while the bot waits for additional confirmation.";
  }

  if (
    q.includes("entry") ||
    q.includes("sl") ||
    q.includes("stop") ||
    q.includes("tp")
  ) {
    return (
      `Current ${signal.direction} setup: Entry ${roundPrice(signal.entry)}, SL ${roundPrice(signal.sl)}, TP1 ${roundPrice(signal.tp1)}, TP2 ${roundPrice(signal.tp2)}, RR 1:${signal.rr.toFixed(2)}.`
    );
  }

  if (
    q.includes("confirm")
  ) {
    return (
      `Current stage: ${signal.stage}. Evidence: ${signal.confirmations.join(", ")}. Candlestick confirmation: ${signal.candleConfirmed ? "YES" : "NOT YET"}.`
    );
  }

  return (
    `Current ${signal.direction} ${signal.stage}. HTF bias: ${signal.htfBias}. 1H structure: ${signal.h1Bias}. Evidence score: ${signal.score}. The bot is using closed-candle market data and does not force a trade.`
  );
}


/* ============================================================
   GLOBAL MARKET STATE
   ============================================================ */

function exposeGlobalMarketState() {
  window.lastAnalysis =
    state.analysis;

  window.currentAnalysis =
    state.analysis;

  window.currentSymbol =
    state.selectedSymbol;

  window.currentPrice =
    state.livePrice;

  window.closedCandles =
    getClosedCandles(
      state.selectedSymbol,
      state.selectedTimeframe
    );

  window.currentCandles =
    window.closedCandles;
}


/* ============================================================
   DERIV SEND
   ============================================================ */

function sendDeriv(payload) {
  if (
    !state.ws ||
    state.ws.readyState !== WebSocket.OPEN
  ) {
    return false;
  }

  try {
    state.ws.send(
      JSON.stringify(payload)
    );

    return true;
  } catch (error) {
    console.error(
      "Deriv send error:",
      error
    );

    return false;
  }
}


/* ============================================================
   ESCAPE HTML
   ============================================================ */

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


/* ============================================================
   PUBLIC API
   ============================================================ */

window.SuccessfulPrecisionAI = {
  state,

  analyze: () =>
    runPrecisionAnalysis(true),

  reconnect: () =>
    connectDeriv(),

  getAnalysis: () =>
    state.analysis,

  getSignal: () =>
    state.analysis?.signal ||
    null,

  ask: question =>
    askSuccessfulAI(question)
};


/* ============================================================
   DIRECT GLOBAL AI FUNCTION
   ============================================================ */

window.askSuccessfulAI =
  askSuccessfulAI;


/* ============================================================
   END
   ============================================================ */
