/* ============================================================
   SUCCESSFUL PINE SCRIPT
   PRECISION SIGNAL ENGINE
   GitHub + Vercel Ready
   ------------------------------------------------------------
   LIVE PUBLIC DERIV DATA
   CLOSED-CANDLE / NON-REPAINTING ANALYSIS
   MARKET STRUCTURE + PRICE ACTION + SMC
   DEPTH 30 / DEVIATION 5 / BACKSTEP 5
   ============================================================ */

"use strict";

/* ============================================================
   CONFIG
   ============================================================ */

const CONFIG = {
  DERIV_WS:
    "wss://api.derivws.com/trading/v1/options/ws/public",

  HISTORY_COUNT: 500,

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

  lastSignalKey: "",
  signalHistory: [],

  notifiedSignals: new Map(),

  analysisTimer: null,

  alertsEnabled: false,

  userInteracted: false
};

/* ============================================================
   DOM HELPERS
   ============================================================ */

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value == null ? "" : String(value);
}

function setHTML(id, value) {
  const el = $(id);
  if (el) el.innerHTML = value == null ? "" : String(value);
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundPrice(price) {
  if (!Number.isFinite(price)) return "--";

  const abs = Math.abs(price);

  if (abs >= 1000) return price.toFixed(2);
  if (abs >= 100) return price.toFixed(2);
  if (abs >= 10) return price.toFixed(3);
  if (abs >= 1) return price.toFixed(4);

  return price.toFixed(5);
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

  state.analysisTimer = setInterval(() => {
    runPrecisionAnalysis(false);
  }, CONFIG.ANALYSIS_INTERVAL);
});

/* ============================================================
   EXISTING UI COMPATIBILITY
   ============================================================ */

function initializeExistingUI() {
  const market = $("market");

  if (market) {
    market.addEventListener("change", () => {
      state.selectedSymbol = market.value;

      if (state.selectedSymbol) {
        subscribeToSymbol(state.selectedSymbol);
        loadHistoricalData(state.selectedSymbol);
      }
    });
  }

  document.querySelectorAll("[data-timeframe]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTimeframe = button.dataset.timeframe;
      runPrecisionAnalysis(true);
    });
  });

  const analyzeButton =
    $("analyze") ||
    $("analyzeBtn") ||
    document.querySelector("#analyzeButton");

  if (analyzeButton) {
    analyzeButton.addEventListener("click", () => {
      state.userInteracted = true;
      runPrecisionAnalysis(true);
    });
  }

  setText("connectionText", "Connecting to Deriv...");
}

/* ============================================================
   DERIV CONNECTION
   ============================================================ */

function connectDeriv() {
  clearTimeout(state.reconnectTimer);

  try {
    if (state.ws) {
      try {
        state.ws.close();
      } catch (_) {}
    }

    updateConnectionUI(false, "Connecting to Deriv...");

    state.ws = new WebSocket(CONFIG.DERIV_WS);

    state.ws.onopen = () => {
      state.connected = true;
      state.reconnectDelay = CONFIG.RECONNECT_MIN;

      updateConnectionUI(true, "LIVE");

      requestActiveSymbols();

      if (state.selectedSymbol) {
        subscribeToSymbol(state.selectedSymbol);
        loadHistoricalData(state.selectedSymbol);
      }
    };

    state.ws.onmessage = (event) => {
      handleDerivMessage(event.data);
    };

    state.ws.onerror = () => {
      updateConnectionUI(false, "Connection error");
    };

    state.ws.onclose = () => {
      state.connected = false;

      updateConnectionUI(false, "Reconnecting...");

      scheduleReconnect();
    };
  } catch (error) {
    console.error("Deriv connection error:", error);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);

  state.reconnectTimer = setTimeout(() => {
    connectDeriv();
  }, state.reconnectDelay);

  state.reconnectDelay = Math.min(
    state.reconnectDelay * 2,
    CONFIG.RECONNECT_MAX
  );
}

function updateConnectionUI(connected, text) {
  setText("connectionText", text);

  const dot = document.querySelector(".status-dot");

  if (dot) {
    dot.classList.toggle("connected", connected);
    dot.classList.toggle("offline", !connected);
  }
}

/* ============================================================
   DERIV MESSAGE HANDLER
   ============================================================ */

function handleDerivMessage(raw) {
  let data;

  try {
    data = JSON.parse(raw);
  } catch (_) {
    return;
  }

  if (data.error) {
    console.warn("Deriv API:", data.error);
    return;
  }

  if (data.msg_type === "active_symbols") {
    processActiveSymbols(data.active_symbols || []);
    return;
  }

  if (data.msg_type === "tick") {
    processTick(data.tick);
    return;
  }

  if (data.msg_type === "candles") {
    processHistoricalCandles(data);
    return;
  }
}

/* ============================================================
   ACTIVE SYMBOLS
   ============================================================ */

function requestActiveSymbols() {
  sendDeriv({
    active_symbols: "full",
    req_id: Date.now()
  });
}

function processActiveSymbols(list) {
  const normalized = list
    .map((item) => {
      const symbol =
        item.underlying_symbol ||
        item.symbol ||
        item.name;

      const name =
        item.underlying_symbol_name ||
        item.display_name ||
        symbol;

      const type =
        item.underlying_symbol_type ||
        item.symbol_type ||
        "Other";

      if (!symbol) return null;

      return {
        symbol,
        name,
        type
      };
    })
    .filter(Boolean);

  state.symbols = normalized;

  populateMarketSelector(normalized);
}

function populateMarketSelector(symbols) {
  const select = $("market");

  if (!select) return;

  const previous = state.selectedSymbol || select.value;

  select.innerHTML = "";

  const groups = {
    "Synthetic Indices": [],
    "Forex": [],
    "Commodities / Metals": [],
    "Indices": [],
    "Cryptocurrencies": [],
    "Other": []
  };

  symbols.forEach((item) => {
    const text =
      `${item.name} ${item.symbol} ${item.type}`.toLowerCase();

    let group = "Other";

    if (
      text.includes("volatility") ||
      text.includes("step") ||
      text.includes("jump") ||
      text.includes("boom") ||
      text.includes("crash") ||
      text.includes("range break") ||
      text.includes("drift")
    ) {
      group = "Synthetic Indices";
    } else if (
      text.includes("forex") ||
      text.includes("usd") ||
      text.includes("eur") ||
      text.includes("gbp") ||
      text.includes("jpy") ||
      text.includes("aud") ||
      text.includes("cad") ||
      text.includes("chf") ||
      text.includes("nzd")
    ) {
      group = "Forex";
    } else if (
      text.includes("gold") ||
      text.includes("silver") ||
      text.includes("metal") ||
      text.includes("commodity") ||
      text.includes("oil")
    ) {
      group = "Commodities / Metals";
    } else if (
      text.includes("index") ||
      text.includes("nasdaq") ||
      text.includes("s&p") ||
      text.includes("dow") ||
      text.includes("dax")
    ) {
      group = "Indices";
    } else if (
      text.includes("crypto") ||
      text.includes("bitcoin") ||
      text.includes("ethereum")
    ) {
      group = "Cryptocurrencies";
    }

    groups[group].push(item);
  });

  Object.entries(groups).forEach(([groupName, items]) => {
    if (!items.length) return;

    const optgroup = document.createElement("optgroup");
    optgroup.label = groupName;

    items
      .sort((a, b) =>
        a.name.localeCompare(b.name)
      )
      .forEach((item) => {
        const option = document.createElement("option");

        option.value = item.symbol;
        option.textContent =
          `${item.name} (${item.symbol})`;

        optgroup.appendChild(option);
      });

    select.appendChild(optgroup);
  });

  if (previous && symbols.some((x) => x.symbol === previous)) {
    select.value = previous;
    state.selectedSymbol = previous;
  } else if (symbols.length) {
    const first = symbols[0].symbol;

    select.value = first;
    state.selectedSymbol = first;

    subscribeToSymbol(first);
    loadHistoricalData(first);
  }
}

/* ============================================================
   TICKS
   ============================================================ */

function subscribeToSymbol(symbol) {
  if (!symbol || !state.connected) return;

  sendDeriv({
    forget_all: "ticks"
  });

  sendDeriv({
    ticks: symbol,
    subscribe: 1
  });
}

function processTick(tick) {
  if (!tick) return;

  const symbol = tick.symbol || state.selectedSymbol;
  const quote = safeNumber(tick.quote);

  if (!symbol || quote == null) return;

  state.ticks[symbol] = {
    price: quote,
    epoch: Number(tick.epoch || Date.now() / 1000)
  };

  if (symbol === state.selectedSymbol) {
    state.livePrice = quote;

    setText("price", roundPrice(quote));
    setText("livePrice", roundPrice(quote));

    const marketLabel =
      state.symbols.find(
        (x) => x.symbol === symbol
      );

    setText(
      "selectedMarket",
      marketLabel
        ? marketLabel.name
        : symbol
    );
  }
}

/* ============================================================
   HISTORICAL CANDLES
   ============================================================ */

function loadHistoricalData(symbol) {
  if (!symbol || !state.connected) return;

  const request = {
    ticks_history: symbol,
    style: "candles",
    granularity: 60,
    count: CONFIG.HISTORY_COUNT,
    end: "latest",
    req_id: Date.now()
  };

  sendDeriv(request);
}

function processHistoricalCandles(data) {
  const symbol =
    data.echo_req?.ticks_history ||
    data.echo_req?.symbol ||
    state.selectedSymbol;

  if (!symbol || !Array.isArray(data.candles)) return;

  const candles = data.candles
    .map((c) => ({
      time: Number(c.epoch),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
    )
    .sort((a, b) => a.time - b.time);

  state.candles[symbol] = candles;

  runPrecisionAnalysis(true);
}

/* ============================================================
   CLOSED CANDLE ENGINE
   ============================================================ */

function getClosedCandles(symbol, timeframe) {
  const base = state.candles[symbol];

  if (!base || base.length < 100) {
    return [];
  }

  const seconds =
    CONFIG.TIMEFRAMES[timeframe] ||
    CONFIG.TIMEFRAMES.M5;

  if (seconds === 60) {
    return removeOpenCandle(base);
  }

  return aggregateCandles(
    removeOpenCandle(base),
    seconds
  );
}

function removeOpenCandle(candles) {
  if (!candles.length) return [];

  const now = Math.floor(Date.now() / 1000);

  return candles.filter((c) => {
    return (
      c.time + 60 <= now
    );
  });
}

function aggregateCandles(candles, seconds) {
  if (!candles.length) return [];

  const buckets = new Map();

  candles.forEach((c) => {
    const bucket =
      Math.floor(c.time / seconds) *
      seconds;

    if (!buckets.has(bucket)) {
      buckets.set(bucket, {
        time: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      });
    } else {
      const current = buckets.get(bucket);

      current.high = Math.max(
        current.high,
        c.high
      );

      current.low = Math.min(
        current.low,
        c.low
      );

      current.close = c.close;
    }
  });

  return [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .filter(
      (c) =>
        c.open != null &&
        c.high != null &&
        c.low != null &&
        c.close != null
    );
}

/* ============================================================
   SWING DETECTION
   DEPTH 30 / DEVIATION 5 / BACKSTEP 5
   ============================================================ */

function detectSwings(candles) {
  const swings = [];

  const depth = CONFIG.DEPTH;
  const deviation = CONFIG.DEVIATION;
  const backstep = CONFIG.BACKSTEP;

  if (candles.length < depth * 2 + 5) {
    return swings;
  }

  for (
    let i = depth;
    i < candles.length - depth;
    i++
  ) {
    const c = candles[i];

    let highest = true;
    let lowest = true;

    for (
      let j = i - depth;
      j <= i + depth;
      j++
    ) {
      if (j === i) continue;

      if (candles[j].high > c.high) {
        highest = false;
      }

      if (candles[j].low < c.low) {
        lowest = false;
      }

      if (!highest && !lowest) break;
    }

    if (highest) {
      const previous =
        swings.filter(
          (s) => s.type === "HIGH"
        ).at(-1);

      if (
        !previous ||
        Math.abs(c.high - previous.price) >=
          getDeviation(candles, deviation)
      ) {
        swings.push({
          type: "HIGH",
          price: c.high,
          time: c.time,
          index: i
        });
      }
    }

    if (lowest) {
      const previous =
        swings.filter(
          (s) => s.type === "LOW"
        ).at(-1);

      if (
        !previous ||
        Math.abs(c.low - previous.price) >=
          getDeviation(candles, deviation)
      ) {
        swings.push({
          type: "LOW",
          price: c.low,
          time: c.time,
          index: i
        });
      }
    }
  }

  /* BACKSTEP CLEANUP */

  const cleaned = [];

  for (const swing of swings) {
    const last = cleaned.at(-1);

    if (
      last &&
      swing.index - last.index <= backstep &&
      swing.type === last.type
    ) {
      if (swing.type === "HIGH") {
        if (swing.price > last.price) {
          cleaned[cleaned.length - 1] =
            swing;
        }
      } else {
        if (swing.price < last.price) {
          cleaned[cleaned.length - 1] =
            swing;
        }
      }
    } else {
      cleaned.push(swing);
    }
  }

  return cleaned;
}

function getDeviation(candles, multiplier) {
  const recent = candles.slice(-50);

  const ranges = recent.map(
    (c) => c.high - c.low
  );

  const avg =
    ranges.reduce(
      (a, b) => a + b,
      0
    ) / Math.max(ranges.length, 1);

  return avg * (multiplier / 5);
}

/* ============================================================
   HH / HL / LH / LL
   ============================================================ */

function classifyStructure(swings) {
  const highs = swings.filter(
    (s) => s.type === "HIGH"
  );

  const lows = swings.filter(
    (s) => s.type === "LOW"
  );

  const labels = [];

  for (let i = 1; i < highs.length; i++) {
    labels.push({
      type:
        highs[i].price >
        highs[i - 1].price
          ? "HH"
          : "LH",
      price: highs[i].price,
      time: highs[i].time
    });
  }

  for (let i = 1; i < lows.length; i++) {
    labels.push({
      type:
        lows[i].price >
        lows[i - 1].price
          ? "HL"
          : "LL",
      price: lows[i].price,
      time: lows[i].time
    });
  }

  labels.sort(
    (a, b) => a.time - b.time
  );

  const recent = labels.slice(-10);

  let bullish = 0;
  let bearish = 0;

  recent.forEach((x) => {
    if (
      x.type === "HH" ||
      x.type === "HL"
    ) {
      bullish++;
    }

    if (
      x.type === "LH" ||
      x.type === "LL"
    ) {
      bearish++;
    }
  });

  let bias = "NEUTRAL";

  if (bullish > bearish) {
    bias = "BULLISH";
  } else if (bearish > bullish) {
    bias = "BEARISH";
  }

  return {
    labels,
    recent,
    bias,
    lastHigh:
      highs.at(-1) || null,
    previousHigh:
      highs.at(-2) || null,
    lastLow:
      lows.at(-1) || null,
    previousLow:
      lows.at(-2) || null
  };
}

/* ============================================================
   BOS / CHOCH
   ============================================================ */

function detectStructureEvents(
  candles,
  structure
) {
  if (!candles.length) {
    return {
      bos: null,
      choch: null
    };
  }

  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const high =
    structure.lastHigh?.price;

  const low =
    structure.lastLow?.price;

  const previousHigh =
    structure.previousHigh?.price;

  const previousLow =
    structure.previousLow?.price;

  let bos = null;
  let choch = null;

  if (
    high != null &&
    last.close > high &&
    previous.close <= high
  ) {
    bos = {
      direction: "BULLISH",
      price: high,
      time: last.time
    };

    if (
      structure.bias === "BEARISH"
    ) {
      choch = {
        direction: "BULLISH",
        price: high,
        time: last.time
      };
    }
  }

  if (
    low != null &&
    last.close < low &&
    previous.close >= low
  ) {
    bos = {
      direction: "BEARISH",
      price: low,
      time: last.time
    };

    if (
      structure.bias === "BULLISH"
    ) {
      choch = {
        direction: "BEARISH",
        price: low,
        time: last.time
      };
    }
  }

  return {
    bos,
    choch,
    previousHigh,
    previousLow
  };
}

/* ============================================================
   LIQUIDITY
   ============================================================ */

function detectLiquidity(
  candles,
  structure
) {
  if (candles.length < 3) {
    return {
      bullishSweep: false,
      bearishSweep: false,
      type: null
    };
  }

  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const high =
    structure.lastHigh?.price;

  const low =
    structure.lastLow?.price;

  const bullishSweep =
    low != null &&
    last.low < low &&
    last.close > low;

  const bearishSweep =
    high != null &&
    last.high > high &&
    last.close < high;

  return {
    bullishSweep,
    bearishSweep,

    type: bullishSweep
      ? "SELL-SIDE LIQUIDITY SWEPT"
      : bearishSweep
      ? "BUY-SIDE LIQUIDITY SWEPT"
      : null,

    price:
      bullishSweep
        ? low
        : bearishSweep
        ? high
        : null,

    candleTime: last.time,

    previousClose: previous.close
  };
}

/* ============================================================
   SUPPORT / RESISTANCE
   ============================================================ */

function detectSupportResistance(
  candles,
  swings
) {
  const supports = swings
    .filter((x) => x.type === "LOW")
    .map((x) => x.price);

  const resistances = swings
    .filter((x) => x.type === "HIGH")
    .map((x) => x.price);

  const price =
    candles.at(-1)?.close;

  const tolerance =
    getAverageRange(candles) * 0.75;

  let support = null;
  let resistance = null;

  if (price != null) {
    support =
      supports
        .filter(
          (x) =>
            x <= price &&
            price - x <= tolerance * 5
        )
        .at(-1) || null;

    resistance =
      resistances
        .filter(
          (x) =>
            x >= price &&
            x - price <= tolerance * 5
        )[0] || null;
  }

  return {
    supports,
    resistances,
    nearestSupport: support,
    nearestResistance: resistance
  };
}

/* ============================================================
   SUPPLY / DEMAND
   ============================================================ */

function detectSupplyDemand(candles) {
  if (candles.length < 10) {
    return {
      demand: null,
      supply: null
    };
  }

  const range =
    getAverageRange(candles);

  const recent =
    candles.slice(-20);

  let demand = null;
  let supply = null;

  recent.forEach((c, i) => {
    if (i < 2) return;

    const next = recent[i + 1];

    if (!next) return;

    if (
      c.close < c.open &&
      next.close > next.open &&
      next.close - next.open >
        range * 1.2
    ) {
      demand = {
        high: c.open,
        low: c.low,
        time: c.time
      };
    }

    if (
      c.close > c.open &&
      next.close < next.open &&
      next.open - next.close >
        range * 1.2
    ) {
      supply = {
        high: c.high,
        low: c.open,
        time: c.time
      };
    }
  });

  return {
    demand,
    supply
  };
}

/* ============================================================
   ORDER BLOCK
   ============================================================ */

function detectOrderBlock(candles) {
  if (candles.length < 5) {
    return {
      bullish: null,
      bearish: null
    };
  }

  const range =
    getAverageRange(candles);

  let bullish = null;
  let bearish = null;

  for (
    let i = candles.length - 5;
    i < candles.length - 1;
    i++
  ) {
    const c = candles[i];
    const next = candles[i + 1];

    if (
      c.close < c.open &&
      next.close > next.open &&
      next.close - next.open >
        range * 1.2
    ) {
      bullish = {
        high: c.open,
        low: c.low,
        midpoint:
          (c.open + c.low) / 2,
        time: c.time
      };
    }

    if (
      c.close > c.open &&
      next.close < next.open &&
      next.open - next.close >
        range * 1.2
    ) {
      bearish = {
        high: c.high,
        low: c.open,
        midpoint:
          (c.high + c.open) / 2,
        time: c.time
      };
    }
  }

  return {
    bullish,
    bearish
  };
}

/* ============================================================
   FAIR VALUE GAP
   ============================================================ */

function detectFVG(candles) {
  if (candles.length < 3) {
    return {
      bullish: null,
      bearish: null
    };
  }

  const a =
    candles[candles.length - 3];

  const b =
    candles[candles.length - 2];

  const c =
    candles[candles.length - 1];

  let bullish = null;
  let bearish = null;

  if (c.low > a.high) {
    bullish = {
      low: a.high,
      high: c.low,
      midpoint:
        (a.high + c.low) / 2,
      time: c.time
    };
  }

  if (c.high < a.low) {
    bearish = {
      low: c.high,
      high: a.low,
      midpoint:
        (c.high + a.low) / 2,
      time: c.time
    };
  }

  return {
    bullish,
    bearish
  };
}

/* ============================================================
   PRICE ACTION / CANDLESTICKS
   ============================================================ */

function detectCandlestickConfirmation(
  candles
) {
  if (candles.length < 3) {
    return {
      bullish: false,
      bearish: false,
      pattern: "NONE"
    };
  }

  const c =
    candles[candles.length - 1];

  const p =
    candles[candles.length - 2];

  const body =
    Math.abs(c.close - c.open);

  const range =
    c.high - c.low;

  const upperWick =
    c.high -
    Math.max(c.open, c.close);

  const lowerWick =
    Math.min(c.open, c.close) -
    c.low;

  const bullishPin =
    lowerWick > body * 2 &&
    lowerWick > upperWick * 1.5 &&
    c.close > c.open;

  const bearishPin =
    upperWick > body * 2 &&
    upperWick > lowerWick * 1.5 &&
    c.close < c.open;

  const bullishEngulf =
    p.close < p.open &&
    c.close > c.open &&
    c.open <= p.close &&
    c.close >= p.open;

  const bearishEngulf =
    p.close > p.open &&
    c.close < c.open &&
    c.open >= p.close &&
    c.close <= p.open;

  const strongBull =
    range > 0 &&
    body / range >= 0.65 &&
    c.close > c.open;

  const strongBear =
    range > 0 &&
    body / range >= 0.65 &&
    c.close < c.open;

  let pattern = "NONE";

  if (bullishEngulf) {
    pattern = "BULLISH ENGULFING";
  } else if (bearishEngulf) {
    pattern = "BEARISH ENGULFING";
  } else if (bullishPin) {
    pattern = "BULLISH PIN BAR";
  } else if (bearishPin) {
    pattern = "BEARISH PIN BAR";
  } else if (strongBull) {
    pattern = "STRONG BULLISH CANDLE";
  } else if (strongBear) {
    pattern = "STRONG BEARISH CANDLE";
  }

  return {
    bullish:
      bullishPin ||
      bullishEngulf ||
      strongBull,

    bearish:
      bearishPin ||
      bearishEngulf ||
      strongBear,

    pattern
  };
}

/* ============================================================
   DISPLACEMENT
   ============================================================ */

function detectDisplacement(candles) {
  if (candles.length < 10) {
    return {
      bullish: false,
      bearish: false
    };
  }

  const average =
    getAverageRange(
      candles.slice(0, -1)
    );

  const c = candles.at(-1);

  const body =
    Math.abs(c.close - c.open);

  return {
    bullish:
      c.close > c.open &&
      body >= average * 1.5,

    bearish:
      c.close < c.open &&
      body >= average * 1.5
  };
}

function getAverageRange(candles) {
  if (!candles.length) return 0;

  const ranges =
    candles
      .slice(-50)
      .map(
        (c) => c.high - c.low
      );

  return (
    ranges.reduce(
      (a, b) => a + b,
      0
    ) / ranges.length
  );
}

/* ============================================================
   TOP-DOWN ANALYSIS
   ============================================================ */

function analyzeTimeframe(
  symbol,
  timeframe
) {
  const candles =
    getClosedCandles(
      symbol,
      timeframe
    );

  if (candles.length < 100) {
    return null;
  }

  const swings =
    detectSwings(candles);

  const structure =
    classifyStructure(swings);

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
    swings,
    structure,
    events,
    liquidity,
    sr,
    supplyDemand,
    orderBlock,
    fvg,
    candle,
    displacement,

    lastClosedCandle:
      candles.at(-1)
  };
}

function buildTopDownAnalysis(symbol) {
  const frames = [
    "Daily",
    "H4",
    "H2",
    "H1",
    "M30",
    "M15",
    "M5"
  ];

  const result = {};

  frames.forEach((tf) => {
    result[tf] =
      analyzeTimeframe(
        symbol,
        tf
      );
  });

  return result;
}

/* ============================================================
   1H PRIORITY
   ============================================================ */

function getHTFBias(topDown) {
  const daily =
    topDown.Daily;

  const h4 =
    topDown.H4;

  const h2 =
    topDown.H2;

  const h1 =
    topDown.H1;

  const votes = {
    BULLISH: 0,
    BEARISH: 0
  };

  [
    daily,
    h4,
    h2
  ].forEach((x) => {
    if (!x) return;

    if (
      x.structure.bias ===
      "BULLISH"
    ) {
      votes.BULLISH++;
    }

    if (
      x.structure.bias ===
      "BEARISH"
    ) {
      votes.BEARISH++;
    }
  });

  let bias = "NEUTRAL";

  if (
    votes.BULLISH >
    votes.BEARISH
  ) {
    bias = "BULLISH";
  }

  if (
    votes.BEARISH >
    votes.BULLISH
  ) {
    bias = "BEARISH";
  }

  /* 1H HAS PRIORITY */

  if (h1) {
    if (
      h1.structure.bias ===
      "BULLISH"
    ) {
      bias = "BULLISH";
    }

    if (
      h1.structure.bias ===
      "BEARISH"
    ) {
      bias = "BEARISH";
    }
  }

  return {
    bias,
    votes,
    h1Bias:
      h1?.structure.bias ||
      "NEUTRAL"
  };
}

/* ============================================================
   PRECISION SIGNAL ENGINE
   ============================================================ */

function generatePrecisionSignal(
  symbol,
  topDown
) {
  const h1 =
    topDown.H1;

  const execution =
    topDown[state.selectedTimeframe] ||
    topDown.M15 ||
    topDown.M30;

  if (!h1 || !execution) {
    return {
      status:
        "WAIT — NO CONFIRMED SETUP.",
      signal: null
    };
  }

  const htf =
    getHTFBias(topDown);

  const direction =
    determineDirection(
      h1,
      execution,
      htf.bias
    );

  if (!direction) {
    return {
      status:
        "WAIT — NO CONFIRMED SETUP.",
      signal: null
    };
  }

  const evidence =
    scoreEvidence(
      direction,
      h1,
      execution,
      topDown
    );

  const minimumConfirmed =
    evidence.confirmations >= 3;

  if (!minimumConfirmed) {
    return {
      status:
        "WAIT — NO CONFIRMED SETUP.",
      signal: null,
      evidence
    };
  }

  const grade =
    gradeSetup(evidence);

  const levels =
    calculateTradeLevels(
      direction,
      execution,
      h1
    );

  if (!levels) {
    return {
      status:
        "WAIT — NO CONFIRMED SETUP.",
      signal: null,
      evidence
    };
  }

  if (
    levels.rr <
    CONFIG.MIN_RR
  ) {
    return {
      status:
        "WAIT — NO CONFIRMED SETUP.",
      signal: null,
      evidence: {
        ...evidence,
        rrRejected: true
      }
    };
  }

  const signal = {
    symbol,
    direction,

    grade,

    entry:
      levels.entry,

    entryZone:
      levels.entryZone,

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

    htfBias:
      htf.bias,

    h1Structure:
      h1.structure.bias,

    swing:
      h1.structure.recent.at(-1)
        ?.type || "N/A",

    bos:
      h1.events.bos?.direction ||
      execution.events.bos?.direction ||
      "NONE",

    choch:
      h1.events.choch?.direction ||
      execution.events.choch?.direction ||
      "NONE",

    liquidity:
      direction === "BUY"
        ? h1.liquidity.bullishSweep ||
          execution.liquidity.bullishSweep
        : h1.liquidity.bearishSweep ||
          execution.liquidity.bearishSweep,

    candle:
      execution.candle.pattern,

    fvg:
      Boolean(
        direction === "BUY"
          ? execution.fvg.bullish
          : execution.fvg.bearish
      ),

    orderBlock:
      Boolean(
        direction === "BUY"
          ? execution.orderBlock.bullish
          : execution.orderBlock.bearish
      ),

    displacement:
      direction === "BUY"
        ? execution.displacement.bullish
        : execution.displacement.bearish,

    confirmations:
      evidence.confirmations,

    score:
      evidence.score,

    timestamp:
      Date.now(),

    candleTime:
      execution.lastClosedCandle.time,

    explanation:
      buildAIExplanation(
        direction,
        grade,
        evidence,
        htf,
        h1,
        execution,
        levels
      )
  };

  return {
    status: `PRECISION ${direction}`,
    signal,
    evidence
  };
}

/* ============================================================
   DIRECTION
   ============================================================ */

function determineDirection(
  h1,
  execution,
  htfBias
) {
  const h1Bias =
    h1.structure.bias;

  const executionBias =
    execution.structure.bias;

  if (
    h1Bias === "BULLISH" &&
    (
      executionBias ===
        "BULLISH" ||
      execution.events.choch
        ?.direction ===
        "BULLISH" ||
      execution.events.bos
        ?.direction ===
        "BULLISH"
    )
  ) {
    return "BUY";
  }

  if (
    h1Bias === "BEARISH" &&
    (
      executionBias ===
        "BEARISH" ||
      execution.events.choch
        ?.direction ===
        "BEARISH" ||
      execution.events.bos
        ?.direction ===
        "BEARISH"
    )
  ) {
    return "SELL";
  }

  /* HTF reversal possibility */

  if (
    h1.events.choch?.direction ===
      "BULLISH" &&
    htfBias === "BULLISH"
  ) {
    return "BUY";
  }

  if (
    h1.events.choch?.direction ===
      "BEARISH" &&
    htfBias === "BEARISH"
  ) {
    return "SELL";
  }

  return null;
}

/* ============================================================
   EVIDENCE SCORING
   ============================================================ */

function scoreEvidence(
  direction,
  h1,
  execution,
  topDown
) {
  let score = 0;
  let confirmations = 0;

  const reasons = [];

  const bullish =
    direction === "BUY";

  const bearish =
    direction === "SELL";

  /* HTF */

  if (
    (
      bullish &&
      h1.structure.bias ===
        "BULLISH"
    ) ||
    (
      bearish &&
      h1.structure.bias ===
        "BEARISH"
    )
  ) {
    score += 2;
    confirmations++;
    reasons.push(
      "1H structure aligned"
    );
  }

  /* BOS */

  if (
    execution.events.bos?.direction ===
    (bullish
      ? "BULLISH"
      : "BEARISH")
  ) {
    score += 2;
    confirmations++;
    reasons.push(
      "Confirmed BOS"
    );
  }

  /* CHOCH */

  if (
    execution.events.choch?.direction ===
    (bullish
      ? "BULLISH"
      : "BEARISH")
  ) {
    score += 2;
    confirmations++;
    reasons.push(
      "Confirmed CHoCH"
    );
  }

  /* LIQUIDITY */

  if (
    (
      bullish &&
      execution.liquidity
        .bullishSweep
    ) ||
    (
      bearish &&
      execution.liquidity
        .bearishSweep
    )
  ) {
    score += 2;
    confirmations++;
    reasons.push(
      "Liquidity sweep confirmed"
    );
  }

  /* DISPLACEMENT */

  if (
    (
      bullish &&
      execution.displacement
        .bullish
    ) ||
    (
      bearish &&
      execution.displacement
        .bearish
    )
  ) {
    score += 2;
    confirmations++;
    reasons.push(
      "Displacement confirmed"
    );
  }

  /* FVG */

  if (
    (
      bullish &&
      execution.fvg.bullish
    ) ||
    (
      bearish &&
      execution.fvg.bearish
    )
  ) {
    score++;
    confirmations++;
    reasons.push(
      "Valid FVG"
    );
  }

  /* ORDER BLOCK */

  if (
    (
      bullish &&
      execution.orderBlock
        .bullish
    ) ||
    (
      bearish &&
      execution.orderBlock
        .bearish
    )
  ) {
    score++;
    confirmations++;
    reasons.push(
      "Valid Order Block"
    );
  }

  /* CANDLE */

  if (
    (
      bullish &&
      execution.candle.bullish
    ) ||
    (
      bearish &&
      execution.candle.bearish
    )
  ) {
    score += 2;
    confirmations++;
    reasons.push(
      `Candle confirmation: ${execution.candle.pattern}`
    );
  }

  /* SUPPORT / RESISTANCE */

  if (
    bullish &&
    execution.sr.nearestSupport
  ) {
    score++;
    reasons.push(
      "Support context present"
    );
  }

  if (
    bearish &&
    execution.sr.nearestResistance
  ) {
    score++;
    reasons.push(
      "Resistance context present"
    );
  }

  return {
    score,
    confirmations,
    reasons
  };
}

/* ============================================================
   GRADING
   ============================================================ */

function gradeSetup(evidence) {
  if (
    evidence.score >= 11 &&
    evidence.confirmations >= 6
  ) {
    return "A+";
  }

  if (
    evidence.score >= 8 &&
    evidence.confirmations >= 5
  ) {
    return "A";
  }

  if (
    evidence.score >= 6 &&
    evidence.confirmations >= 4
  ) {
    return "B";
  }

  return "C";
}

/* ============================================================
   TRADE LEVELS
   ============================================================ */

function calculateTradeLevels(
  direction,
  execution,
  h1
) {
  const price =
    execution.lastClosedCandle.close;

  if (!Number.isFinite(price)) {
    return null;
  }

  const range =
    getAverageRange(
      execution.candles
    );

  if (!range) return null;

  const buffer =
    range * 0.15;

  let sl;
  let tp1;
  let tp2;

  if (direction === "BUY") {
    const structuralLow =
      Math.min(
        h1.structure.lastLow?.price ??
          price - range * 2,
        execution.structure.lastLow?.price ??
          price - range
      );

    sl =
      structuralLow - buffer;

    const risk =
      price - sl;

    tp1 =
      price + risk * 2;

    tp2 =
      price + risk * 3;
  } else {
    const structuralHigh =
      Math.max(
        h1.structure.lastHigh?.price ??
          price + range * 2,
        execution.structure.lastHigh?.price ??
          price + range
      );

    sl =
      structuralHigh + buffer;

    const risk =
      sl - price;

    tp1 =
      price - risk * 2;

    tp2 =
      price - risk * 3;
  }

  const risk =
    Math.abs(price - sl);

  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {
    return null;
  }

  const reward =
    Math.abs(tp2 - price);

  const rr =
    reward / risk;

  return {
    entry: price,

    entryZone: {
      low:
        direction === "BUY"
          ? price - range * 0.25
          : price - range * 0.25,

      high:
        direction === "BUY"
          ? price + range * 0.25
          : price + range * 0.25
    },

    sl,

    be: price,

    tp1,

    tp2,

    rr: Number(rr.toFixed(2)),

    invalidation:
      direction === "BUY"
        ? `Closed candle below ${roundPrice(sl)}`
        : `Closed candle above ${roundPrice(sl)}`
  };
}

/* ============================================================
   AI EXPLANATION
   ============================================================ */

function buildAIExplanation(
  direction,
  grade,
  evidence,
  htf,
  h1,
  execution,
  levels
) {
  const reasons =
    evidence.reasons.join("; ");

  return (
    `${grade} ${direction} confirmed. ` +
    `HTF bias: ${htf.bias}. ` +
    `1H structure: ${h1.structure.bias}. ` +
    `Closed-candle execution: ${execution.timeframe}. ` +
    `Evidence: ${reasons}. ` +
    `Entry ${roundPrice(levels.entry)}, ` +
    `SL ${roundPrice(levels.sl)}, ` +
    `TP1 ${roundPrice(levels.tp1)}, ` +
    `TP2 ${roundPrice(levels.tp2)}, ` +
    `RR 1:${levels.rr}. ` +
    `${levels.invalidation}.`
  );
}

/* ============================================================
   MAIN ANALYSIS
   ============================================================ */

function runPrecisionAnalysis(manual = false) {
  const symbol =
    state.selectedSymbol;

  if (!symbol) {
    showWaiting();
    return;
  }

  const topDown =
    buildTopDownAnalysis(symbol);

  const result =
    generatePrecisionSignal(
      symbol,
      topDown
    );

  state.analysis = {
    symbol,
    topDown,
    result,
    timestamp: Date.now()
  };

  updateExistingDashboard(
    state.analysis
  );

  if (
    result.signal
  ) {
    processSignal(
      result.signal,
      manual
    );
  } else {
    showWaiting(
      result.status
    );
  }
}

/* ============================================================
   DASHBOARD UPDATE
   ============================================================ */

function updateExistingDashboard(analysis) {
  const result =
    analysis.result;

  const signal =
    result.signal;

  if (signal) {
    setText(
      "signal",
      `PRECISION ${signal.direction}`
    );

    setText(
      "direction",
      signal.direction
    );

    setText(
      "setup",
      `${signal.grade} SETUP`
    );

    setText(
      "confidence",
      `${signal.score} SCORE`
    );

    setText(
      "rr",
      `1:${signal.rr}`
    );

    setText(
      "entry",
      roundPrice(signal.entry)
    );

    setText(
      "sl",
      roundPrice(signal.sl)
    );

    setText(
      "tp1",
      roundPrice(signal.tp1)
    );

    setText(
      "tp2",
      roundPrice(signal.tp2)
    );

    setText(
      "swing",
      signal.swing
    );

    setText(
      "structure",
      signal.h1Structure
    );

    setText(
      "liquidity",
      signal.liquidity
        ? "CONFIRMED"
        : "NOT TAKEN"
    );

    setText(
      "sr",
      signal.direction === "BUY"
        ? "SUPPORT"
        : "RESISTANCE"
    );

    setText(
      "pattern",
      signal.candle
    );

    setText(
      "rejection",
      signal.liquidity
        ? "CONFIRMED"
        : "WAIT"
    );

    setText(
      "momentum",
      signal.displacement
        ? "CONFIRMED"
        : "WAIT"
    );

    setText(
      "confirmation",
      `${signal.grade} CONFIRMED`
    );

    setText(
      "explanationText",
      signal.explanation
    );

    updateOptionalFields(
      signal
    );

    return;
  }

  showWaiting(
    result.status
  );
}

function showWaiting(
  message =
    "WAIT — NO CONFIRMED SETUP."
) {
  setText(
    "signal",
    message
  );

  setText(
    "direction",
    "WAIT"
  );

  setText(
    "setup",
    "NO CONFIRMED SETUP"
  );

  setText(
    "confidence",
    "--"
  );

  setText(
    "rr",
    "--"
  );

  setText(
    "explanationText",
    "No confirmed precision setup is currently available from the closed-candle analysis. The engine will continue monitoring live market data."
  );
}

function updateOptionalFields(signal) {
  setText(
    "be",
    roundPrice(signal.be)
  );

  setText(
    "htfBias",
    signal.htfBias
  );

  setText(
    "h1Structure",
    signal.h1Structure
  );

  setText(
    "invalidation",
    signal.invalidation
  );

  setText(
    "choch",
    signal.choch
  );

  setText(
    "bos",
    signal.bos
  );

  setText(
    "fvg",
    signal.fvg
      ? "CONFIRMED"
      : "NONE"
  );

  setText(
    "orderBlock",
    signal.orderBlock
      ? "CONFIRMED"
      : "NONE"
  );
}

/* ============================================================
   SIGNAL PROCESSING
   ============================================================ */

function processSignal(
  signal,
  manual
) {
  const key =
    createSignalKey(
      signal
    );

  const previous =
    state.lastSignalKey;

  if (key === previous) {
    return;
  }

  state.lastSignalKey = key;

  addSignalHistory(
    signal
  );

  /*
    Alert every newly confirmed setup.
    Duplicate protection is based on symbol,
    direction, grade and closed candle time.
  */

  if (
    !wasRecentlyNotified(key)
  ) {
    notifySignal(signal);
    rememberNotification(key);
  }

  console.log(
    "PRECISION SIGNAL:",
    signal
  );
}

function createSignalKey(signal) {
  return [
    signal.symbol,
    signal.direction,
    signal.grade,
    signal.candleTime
  ].join("|");
}

function wasRecentlyNotified(key) {
  const time =
    state.notifiedSignals.get(key);

  if (!time) return false;

  return (
    Date.now() - time <
    CONFIG.DUPLICATE_COOLDOWN
  );
}

function rememberNotification(key) {
  state.notifiedSignals.set(
    key,
    Date.now()
  );

  if (
    state.notifiedSignals.size >
    500
  ) {
    const first =
      state.notifiedSignals
        .keys()
        .next()
        .value;

    state.notifiedSignals.delete(
      first
    );
  }
}

/* ============================================================
   ALERTS
   ============================================================ */

function createAlertControl() {
  if (
    document.getElementById(
      "enableAlertsButton"
    )
  ) {
    return;
  }

  const button =
    document.createElement("button");

  button.id =
    "enableAlertsButton";

  button.textContent =
    "🔔 Enable Alerts";

  button.style.cssText =
    "margin:8px;padding:8px 12px;cursor:pointer;";

  button.addEventListener(
    "click",
    async () => {
      state.userInteracted = true;

      if (
        "Notification" in window
      ) {
        try {
          const permission =
            await Notification.requestPermission();

          state.alertsEnabled =
            permission === "granted";
        } catch (_) {}
      }

      button.textContent =
        state.alertsEnabled
          ? "🔔 Alerts Enabled"
          : "🔕 Alerts Unavailable";
    }
  );

  const parent =
    document.querySelector(
      ".connection"
    )?.parentElement ||
    document.body;

  parent.appendChild(button);
}

function notifySignal(signal) {
  const title =
    `PRECISION ${signal.direction} — ${signal.grade}`;

  const message =
    `${signal.symbol}\n` +
    `Entry: ${roundPrice(signal.entry)}\n` +
    `SL: ${roundPrice(signal.sl)}\n` +
    `TP1: ${roundPrice(signal.tp1)}\n` +
    `TP2: ${roundPrice(signal.tp2)}\n` +
    `RR: 1:${signal.rr}`;

  /* IN-APP */

  showInAppAlert(
    title,
    message
  );

  /* BROWSER */

  if (
    state.alertsEnabled &&
    "Notification" in window &&
    Notification.permission ===
      "granted"
  ) {
    try {
      new Notification(
        title,
        {
          body: message,
          tag:
            `${signal.symbol}-${signal.direction}-${signal.grade}-${signal.candleTime}`
        }
      );
    } catch (_) {}
  }

  /* OPTIONAL EXISTING ALERT FUNCTION */

  if (
    typeof window.showAlert ===
    "function"
  ) {
    try {
      window.showAlert(
        title,
        message
      );
    } catch (_) {}
  }
}

function showInAppAlert(
  title,
  message
) {
  let alert =
    document.getElementById(
      "precisionAlert"
    );

  if (!alert) {
    alert =
      document.createElement(
        "div"
      );

    alert.id =
      "precisionAlert";

    alert.style.cssText = `
      position:fixed;
      right:15px;
      bottom:15px;
      z-index:99999;
      max-width:360px;
      padding:15px;
      border-radius:12px;
      background:#111;
      color:#fff;
      box-shadow:0 5px 30px rgba(0,0,0,.35);
      font-family:Arial,sans-serif;
    `;

    document.body.appendChild(
      alert
    );
  }

  alert.innerHTML = `
    <strong>${escapeHTML(title)}</strong>
    <br><br>
    ${escapeHTML(message).replace(
      /\n/g,
      "<br>"
    )}
  `;

  clearTimeout(
    alert._timer
  );

  alert._timer =
    setTimeout(() => {
      alert.remove();
    }, 15000);
}

/* ============================================================
   SIGNAL HISTORY
   ============================================================ */

function addSignalHistory(signal) {
  state.signalHistory.unshift(
    signal
  );

  if (
    state.signalHistory.length >
    100
  ) {
    state.signalHistory.pop();
  }

  renderSignalHistory();
}

function renderSignalHistory() {
  const container =
    $("signalHistory");

  if (!container) return;

  container.innerHTML = "";

  state.signalHistory
    .slice(0, 30)
    .forEach((signal) => {
      const row =
        document.createElement(
          "div"
        );

      row.className =
        "signal-history-item";

      row.innerHTML = `
        <strong>
          ${escapeHTML(signal.direction)}
          ${escapeHTML(signal.grade)}
        </strong>
        —
        ${escapeHTML(signal.symbol)}
        |
        Entry ${escapeHTML(roundPrice(signal.entry))}
        |
        RR 1:${escapeHTML(signal.rr)}
      `;

      container.appendChild(row);
    });
}

/* ============================================================
   QUESTION / AI CHAT BAR
   ============================================================ */

function createQuestionBar() {
  if (
    document.getElementById(
      "questionBar"
    )
  ) {
    return;
  }

  const wrapper =
    document.createElement("section");

  wrapper.id =
    "questionBar";

  wrapper.style.cssText = `
    margin:20px 0;
    padding:15px;
    border-radius:12px;
    border:1px solid rgba(127,127,127,.25);
  `;

  wrapper.innerHTML = `
    <div style="font-weight:700;margin-bottom:8px;">
      🤖 Ask Successful AI
    </div>

    <div style="font-size:13px;opacity:.75;margin-bottom:10px;">
      Ask about the current market, signal, chart,
      strategy, indicators, or why a setup was not confirmed.
    </div>

    <div style="display:flex;gap:8px;">
      <input
        id="questionInput"
        type="text"
        placeholder="Why is there no confirmed setup?"
        autocomplete="off"
        style="flex:1;padding:10px;border-radius:8px;border:1px solid #888;"
      />

      <button
        id="askQuestionButton"
        type="button"
        style="padding:10px 15px;border-radius:8px;cursor:pointer;"
      >
        Ask
      </button>
    </div>

    <div
      id="questionAnswer"
      style="margin-top:12px;line-height:1.5;"
    ></div>
  `;

  const anchor =
    document.querySelector(
      ".analysis-engine"
    ) ||
    document.querySelector(
      "#explanationText"
    )?.parentElement ||
    document.body;

  anchor.parentNode.insertBefore(
    wrapper,
    anchor.nextSibling
  );

  const input =
    $("questionInput");

  const button =
    $("askQuestionButton");

  button.addEventListener(
    "click",
    askAIQuestion
  );

  input.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key === "Enter"
      ) {
        askAIQuestion();
      }
    }
  );
}

async function askAIQuestion() {
  const input =
    $("questionInput");

  const answer =
    $("questionAnswer");

  if (!input || !answer) return;

  const question =
    input.value.trim();

  if (!question) return;

  answer.textContent =
    "Analyzing the current market data...";

  const context =
    buildAIContext();

  /*
    Vercel backend endpoint.
    NEVER place an OpenAI/Gemini/other secret
    directly inside this script.js.
  */

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
            market:
              state.selectedSymbol,
            timeframe:
              state.selectedTimeframe,
            livePrice:
              state.livePrice,
            analysis:
              context
          })
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    answer.textContent =
      data.answer ||
      "No AI answer was returned.";

  } catch (error) {
    console.warn(
      "AI backend unavailable:",
      error
    );

    /*
      Local fallback prevents the question
      bar from inventing information.
    */

    answer.textContent =
      localQuestionAnswer(
        question
      );
  }
}

/* ============================================================
   AI CONTEXT
   ============================================================ */

function buildAIContext() {
  const analysis =
    state.analysis;

  if (!analysis) {
    return {
      status:
        "NO ANALYSIS AVAILABLE",
      livePrice:
        state.livePrice
    };
  }

  const result =
    analysis.result;

  const signal =
    result.signal;

  return {
    symbol:
      analysis.symbol,

    timeframe:
      state.selectedTimeframe,

    livePrice:
      state.livePrice,

    status:
      result.status,

    signal:
      signal
        ? {
            direction:
              signal.direction,

            grade:
              signal.grade,

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

            h1Structure:
              signal.h1Structure,

            bos:
              signal.bos,

            choch:
              signal.choch,

            liquidity:
              signal.liquidity,

            candle:
              signal.candle,

            fvg:
              signal.fvg,

            orderBlock:
              signal.orderBlock,

            displacement:
              signal.displacement,

            explanation:
              signal.explanation
          }
        : null,

    evidence:
      result.evidence || null
  };
}

/* ============================================================
   LOCAL QUESTION FALLBACK
   ============================================================ */

function localQuestionAnswer(
  question
) {
  const q =
    question.toLowerCase();

  const analysis =
    state.analysis;

  if (!analysis) {
    return (
      "There is not enough live analysis data yet. " +
      "Wait for the bot to receive and analyze closed candles."
    );
  }

  const result =
    analysis.result;

  if (
    result.signal
  ) {
    const s =
      result.signal;

    if (
      q.includes("why") ||
      q.includes("reason")
    ) {
      return (
        `${s.grade} ${s.direction} is confirmed because ` +
        `${s.explanation}`
      );
    }

    if (
      q.includes("entry")
    ) {
      return (
        `Current confirmed ${s.direction} entry is ` +
        `${roundPrice(s.entry)}. ` +
        `SL: ${roundPrice(s.sl)}, ` +
        `TP1: ${roundPrice(s.tp1)}, ` +
        `TP2: ${roundPrice(s.tp2)}, ` +
        `RR: 1:${s.rr}.`
      );
    }

    if (
      q.includes("sl") ||
      q.includes("stop")
    ) {
      return (
        `The calculated stop is ${roundPrice(s.sl)}. ` +
        `Invalidation: ${s.invalidation}.`
      );
    }

    if (
      q.includes("tp") ||
      q.includes("target")
    ) {
      return (
        `TP1 is ${roundPrice(s.tp1)} and ` +
        `TP2 is ${roundPrice(s.tp2)}.`
      );
    }

    return (
      `The current analysis is ${s.grade} ${s.direction}. ` +
      `HTF bias: ${s.htfBias}. ` +
      `1H structure: ${s.h1Structure}. ` +
      `RR: 1:${s.rr}.`
    );
  }

  return (
    "WAIT — NO CONFIRMED SETUP. " +
    "The current closed-candle analysis does not meet " +
    "the confirmation requirements. The bot will continue monitoring."
  );
}

/* ============================================================
   UTILITIES
   ============================================================ */

function sendDeriv(payload) {
  if (
    !state.ws ||
    state.ws.readyState !==
      WebSocket.OPEN
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
      "WebSocket send error:",
      error
    );

    return false;
  }
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll(
      "'",
      "&#039;"
    );
}

/* ============================================================
   PUBLIC DEBUG API
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
    state.analysis?.result
      ?.signal || null,

  ask: (
    question
  ) => {
    const input =
      $("questionInput");

    if (input) {
      input.value = question;
      askAIQuestion();
    }
  }
};

/* ============================================================
   END
   ============================================================ */

// ============================================================
// SUCCESSFUL PINE SCRIPT — AI QUESTION BAR CONNECTION
// ============================================================

async function askSuccessfulAI(question) {
  question = String(question || "").trim();

  if (!question) return;

  const answerBox =
    document.getElementById("aiAnswer") ||
    document.getElementById("answer");

  if (answerBox) {
    answerBox.textContent = "Analyzing the live market data...";
  }

  // Use the latest analysis already produced by the bot
  const analysis =
    window.lastAnalysis ||
    window.currentAnalysis ||
    {};

  // Use the latest closed candles if available
  const candles =
    window.closedCandles ||
    window.currentCandles ||
    [];

  const marketSelect =
    document.getElementById("market");

  const market = {
    symbol:
      marketSelect?.value ||
      window.currentSymbol ||
      "Unknown",

    name:
      marketSelect?.selectedOptions?.[0]?.textContent ||
      "",

    price:
      window.currentPrice ??
      null
  };

  try {
    const response = await fetch("/api/ask", {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        question,
        market,
        analysis,
        candles
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "AI request failed"
      );
    }

    const answer =
      data.answer ||
      data.fallback ||
      "No answer returned.";

    if (answerBox) {
      answerBox.textContent = answer;
    }

    // Also expose the answer for other UI components
    window.lastAIAnswer = answer;

    return answer;

  } catch (error) {

    console.error(
      "Question Bar Error:",
      error
    );

    if (answerBox) {
      answerBox.textContent =
        "Unable to connect to the AI assistant right now. Please try again.";
    }
  }
}


// ------------------------------------------------------------
// Connect existing Question Bar
// ------------------------------------------------------------

document.addEventListener(
  "DOMContentLoaded",
  () => {

    const input =
      document.getElementById("aiQuestion");

    const button =
      document.getElementById("askAI");

    if (!input || !button) {
      console.warn(
        "AI Question Bar elements not found."
      );
      return;
    }

    button.addEventListener(
      "click",
      () => {
        askSuccessfulAI(input.value);
      }
    );

    input.addEventListener(
      "keydown",
      (event) => {

        if (event.key === "Enter") {
          event.preventDefault();

          askSuccessfulAI(
            input.value
          );
        }
      }
    );
  }
);


// ------------------------------------------------------------
// Make function available globally
// ------------------------------------------------------------

window.askSuccessfulAI =
  askSuccessfulAI;
