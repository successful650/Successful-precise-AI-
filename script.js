/* ============================================================
   SUCCESSFUL PINE SCRIPT
   PRECISION SIGNAL ENGINE
   GitHub + Vercel Ready

   LIVE PUBLIC DERIV DATA
   CLOSED-CANDLE / NON-REPAINTING ANALYSIS

   IMPORTANT:
   - Selected timeframe is the actual execution timeframe.
   - No hardcoded M5 analysis.
   - Each symbol stores candles separately by timeframe.
   - 1H is used as structural context, not forced execution TF.
   - Progressive signals:
       EARLY SETUP -> C -> B -> A -> A+
   - Signals can appear before every confirmation is complete.
   - No forced trades.
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

  STALE_DATA_MS: 120000,

  TIMEFRAMES: {
    M1: 60,
    M5: 300,
    M15: 900,
    M30: 1800,
    H1: 3600,
    H2: 7200,
    H4: 14400,
    Daily: 86400
  },

  TIMEFRAME_ORDER: [
    "M1",
    "M5",
    "M15",
    "M30",
    "H1",
    "H2",
    "H4",
    "Daily"
  ]
};


/* ============================================================
   STATE
   ============================================================ */

const state = {
  ws: null,

  connected: false,
  connecting: false,

  reconnectTimer: null,
  reconnectDelay: CONFIG.RECONNECT_MIN,

  symbols: [],
  selectedSymbol: "",

  selectedTimeframe: "M5",
  requestedTimeframe: "M5",

  livePrice: null,

  /*
    CRITICAL:

    candles[symbol][timeframe] = {
      candles: [],
      updatedAt: timestamp
    }

    This prevents M5 data from being reused for H1/H4/etc.
  */
  candles: {},

  historyRequests: new Map(),
  pendingHistory: new Map(),

  ticks: {},

  analysis: null,

  lastSignalKey: "",
  activeSignal: null,

  signalHistory: [],

  notifiedSignals: new Map(),

  analysisTimer: null,

  alertsEnabled: true,

  userInteracted: false,

  loadingHistory: false,

  analysisRunning: false,

  requestId: 1000
};


/* ============================================================
   DOM HELPERS
   ============================================================ */

function $(selector) {
  return document.querySelector(selector);
}

function $all(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function text(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function now() {
  return Date.now();
}


/* ============================================================
   INITIALIZATION
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  initializeExistingUI();
  createQuestionBar();
  createAlertControl();

  connectDeriv();

  state.analysisTimer = setInterval(() => {
    runPrecisionAnalysis(false);
  }, CONFIG.ANALYSIS_INTERVAL);

  updateChosenPairDisplay();
});


function initializeExistingUI() {
  const market = $("#market");

  if (market) {
    market.addEventListener("change", async () => {
      const symbol = market.value;

      if (!symbol) return;

      state.userInteracted = true;
      state.selectedSymbol = symbol;

      state.activeSignal = null;
      state.lastSignalKey = "";

      updateChosenPairDisplay();
      updateMarketName();

      subscribeToSymbol(symbol);

      await loadTimeframeHistory(
        symbol,
        getSelectedTimeframe(),
        true
      );

      await runPrecisionAnalysis(true);
    });
  }

  $all("[data-timeframe]").forEach(button => {
    button.addEventListener("click", async () => {
      const tf =
        button.dataset.timeframe ||
        button.textContent.trim();

      if (!CONFIG.TIMEFRAMES[tf]) return;

      await selectTimeframe(tf);
    });
  });

  const analyzeButton =
    $("#analyze") ||
    $("#analyzeBtn") ||
    $("#analyzeButton");

  if (analyzeButton) {
    analyzeButton.addEventListener("click", async () => {
      state.userInteracted = true;
      await runPrecisionAnalysis(true);
    });
  }
}


/* ============================================================
   TIMEFRAME SYSTEM
   ============================================================ */

function getSelectedTimeframe() {
  const tf = state.selectedTimeframe;

  if (CONFIG.TIMEFRAMES[tf]) {
    return tf;
  }

  return "M5";
}


async function selectTimeframe(tf) {
  if (!CONFIG.TIMEFRAMES[tf]) return;

  state.selectedTimeframe = tf;
  state.requestedTimeframe = tf;
  state.userInteracted = true;

  /*
    Immediately update UI.

    This makes it obvious that the selected timeframe changed
    even before Deriv finishes returning the candles.
  */
  updateTimeframeButtons();
  updateChosenPairDisplay();

  const symbol =
    state.selectedSymbol ||
    $("#market")?.value;

  if (!symbol) {
    setWaitingState(
      `SELECT ${tf}`,
      `Choose a market to analyze on ${tf}.`
    );
    return;
  }

  state.selectedSymbol = symbol;

  updateMarketName();

  try {
    await loadTimeframeHistory(symbol, tf, true);
    await runPrecisionAnalysis(true);
  } catch (error) {
    console.error("Timeframe analysis error:", error);

    setWaitingState(
      `WAIT — ${tf} DATA`,
      `Waiting for ${symbol} ${tf} candle data.`
    );
  }
}


function updateTimeframeButtons() {
  $all("[data-timeframe]").forEach(button => {
    const tf =
      button.dataset.timeframe ||
      button.textContent.trim();

    button.classList.toggle(
      "active",
      tf === getSelectedTimeframe()
    );

    button.setAttribute(
      "aria-selected",
      tf === getSelectedTimeframe() ? "true" : "false"
    );
  });
}


/* ============================================================
   CHOSEN PAIR + TIMEFRAME DISPLAY
   ============================================================ */

function getMarketDisplayName(symbol) {
  if (!symbol) return "Waiting...";

  const found = state.symbols.find(
    item => item.symbol === symbol
  );

  return found?.display_name ||
    found?.name ||
    symbol;
}


function updateChosenPairDisplay() {
  const symbol =
    state.selectedSymbol ||
    $("#market")?.value ||
    "";

  const tf = getSelectedTimeframe();

  const display = symbol
    ? `${getMarketDisplayName(symbol)} — ${tf}`
    : `Waiting — ${tf}`;

  const ids = [
    "#selectedMarket",
    "#marketName",
    "#chosenPair",
    "#chosenMarket",
    "#selectedPair"
  ];

  ids.forEach(selector => {
    const el = $(selector);
    if (el) el.textContent = display;
  });

  /*
    Some existing layouts use the market card itself.
  */
  const marketCard =
    document.querySelector(".market-name");

  if (marketCard) {
    marketCard.textContent = display;
  }
}


function updateMarketName() {
  updateChosenPairDisplay();

  const symbol = state.selectedSymbol;
  const tf = getSelectedTimeframe();

  if (symbol) {
    text(
      "#marketLabel",
      `${getMarketDisplayName(symbol)} — ${tf}`
    );
  }
}


/* ============================================================
   DERIV CONNECTION
   ============================================================ */

function connectDeriv() {
  if (state.connecting) return;

  state.connecting = true;

  updateConnectionUI(
    false,
    "Connecting to Deriv..."
  );

  try {
    state.ws = new WebSocket(CONFIG.DERIV_WS);

    state.ws.onopen = () => {
      state.connected = true;
      state.connecting = false;
      state.reconnectDelay = CONFIG.RECONNECT_MIN;

      updateConnectionUI(
        true,
        "LIVE — Deriv Connected"
      );

      requestActiveSymbols();
    };

    state.ws.onmessage = event => {
      handleDerivMessage(event.data);
    };

    state.ws.onerror = error => {
      console.error("Deriv WebSocket error:", error);
      updateConnectionUI(
        false,
        "Deriv connection error"
      );
    };

    state.ws.onclose = () => {
      state.connected = false;
      state.connecting = false;

      updateConnectionUI(
        false,
        "Reconnecting to Deriv..."
      );

      scheduleReconnect();
    };

  } catch (error) {
    console.error("WebSocket creation failed:", error);

    state.connected = false;
    state.connecting = false;

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


function updateConnectionUI(connected, message) {
  const dot = $(".status-dot");
  const connectionText = $("#connectionText");

  if (dot) {
    dot.classList.toggle("connected", connected);
    dot.classList.toggle("disconnected", !connected);
  }

  if (connectionText) {
    connectionText.textContent = message;
  }
}


/* ============================================================
   DERIV REQUEST
   ============================================================ */

function sendDerivRequest(payload) {
  return new Promise((resolve, reject) => {
    if (
      !state.ws ||
      state.ws.readyState !== WebSocket.OPEN
    ) {
      reject(new Error("Deriv WebSocket is not connected."));
      return;
    }

    const reqId = ++state.requestId;

    const request = {
      ...payload,
      req_id: reqId
    };

    state.pendingHistory.set(reqId, {
      resolve,
      reject,
      createdAt: now()
    });

    try {
      state.ws.send(JSON.stringify(request));
    } catch (error) {
      state.pendingHistory.delete(reqId);
      reject(error);
    }
  });
}


/* ============================================================
   ACTIVE SYMBOLS
   ============================================================ */

function requestActiveSymbols() {
  if (!state.ws) return;

  const request = {
    active_symbols: "brief",
    req_id: ++state.requestId
  };

  state.ws.send(JSON.stringify(request));
}


/* ============================================================
   DERIV MESSAGE HANDLER
   ============================================================ */

function handleDerivMessage(raw) {
  let data;

  try {
    data =
      typeof raw === "string"
        ? JSON.parse(raw)
        : raw;
  } catch (error) {
    console.error("Invalid Deriv message:", error);
    return;
  }

  if (data.error) {
    console.error(
      "Deriv API error:",
      data.error
    );

    const pending =
      state.pendingHistory.get(data.req_id);

    if (pending) {
      state.pendingHistory.delete(data.req_id);

      pending.reject(
        new Error(
          data.error.message ||
          "Deriv request failed."
        )
      );
    }

    return;
  }


  /* ----------------------------------------------------------
     ACTIVE SYMBOLS
     ---------------------------------------------------------- */

  if (data.active_symbols) {
    processActiveSymbols(
      data.active_symbols
    );
  }


  /* ----------------------------------------------------------
     CANDLE HISTORY
     ---------------------------------------------------------- */

  if (data.candles) {
    handleCandleResponse(data);
  }


  /* ----------------------------------------------------------
     TICKS
     ---------------------------------------------------------- */

  if (data.tick) {
    handleTick(data.tick);
  }
}


/* ============================================================
   SYMBOL NORMALIZATION
   ============================================================ */

function normalizeSymbol(raw) {
  return {
    symbol:
      raw.underlying_symbol ||
      raw.symbol ||
      "",

    display_name:
      raw.underlying_symbol_name ||
      raw.display_name ||
      raw.symbol ||
      "",

    type:
      raw.underlying_symbol_type ||
      raw.symbol_type ||
      "other"
  };
}


function processActiveSymbols(rawSymbols) {
  const normalized = rawSymbols
    .map(normalizeSymbol)
    .filter(item => item.symbol);

  const unique = new Map();

  normalized.forEach(item => {
    unique.set(item.symbol, item);
  });

  state.symbols =
    Array.from(unique.values());

  populateMarketSelector();

  const market = $("#market");

  if (
    !state.selectedSymbol &&
    market?.value
  ) {
    state.selectedSymbol = market.value;
  }

  if (
    !state.selectedSymbol &&
    state.symbols.length
  ) {
    state.selectedSymbol =
      state.symbols[0].symbol;
  }

  if (state.selectedSymbol) {
    if (market) {
      market.value =
        state.selectedSymbol;
    }

    subscribeToSymbol(
      state.selectedSymbol
    );

    loadTimeframeHistory(
      state.selectedSymbol,
      getSelectedTimeframe(),
      false
    ).then(() => {
      runPrecisionAnalysis(true);
    });
  }

  updateChosenPairDisplay();
}


/* ============================================================
   MARKET SELECTOR
   ============================================================ */

function populateMarketSelector() {
  const market = $("#market");

  if (!market) return;

  const current =
    state.selectedSymbol ||
    market.value;

  market.innerHTML = "";

  const groups = groupSymbols(
    state.symbols
  );

  Object.keys(groups)
    .sort()
    .forEach(groupName => {
      const group =
        document.createElement("optgroup");

      group.label = groupName;

      groups[groupName].forEach(item => {
        const option =
          document.createElement("option");

        option.value = item.symbol;
        option.textContent =
          item.display_name ||
          item.symbol;

        group.appendChild(option);
      });

      market.appendChild(group);
    });

  if (current) {
    market.value = current;
  }
}


function groupSymbols(symbols) {
  const groups = {};

  symbols.forEach(item => {
    const type =
      String(item.type || "").toLowerCase();

    let group = "Other";

    if (
      type.includes("forex") ||
      type.includes("fx")
    ) {
      group = "Forex";
    } else if (
      type.includes("crypto")
    ) {
      group = "Crypto";
    } else if (
      type.includes("metal")
    ) {
      group = "Metals";
    } else if (
      type.includes("synthetic")
    ) {
      group = "Deriv Synthetic Indices";
    } else if (
      type.includes("index") ||
      type.includes("indices")
    ) {
      group = "Global Indices";
    } else if (
      type.includes("commodity")
    ) {
      group = "Commodities";
    }

    if (!groups[group]) {
      groups[group] = [];
    }

    groups[group].push(item);
  });

  return groups;
}


/* ============================================================
   TICK SUBSCRIPTION
   ============================================================ */

function subscribeToSymbol(symbol) {
  if (
    !symbol ||
    !state.ws ||
    state.ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  try {
    state.ws.send(
      JSON.stringify({
        forget_all: "ticks"
      })
    );

    state.ws.send(
      JSON.stringify({
        ticks: symbol,
        subscribe: 1
      })
    );

  } catch (error) {
    console.error(
      "Tick subscription error:",
      error
    );
  }
}


/* ============================================================
   LIVE TICKS
   ============================================================ */

function handleTick(tick) {
  const symbol = tick.symbol;

  const price = safeNumber(
    tick.quote
  );

  if (!symbol || price === null) return;

  state.ticks[symbol] = {
    price,
    epoch: tick.epoch || Math.floor(now() / 1000)
  };

  if (symbol === state.selectedSymbol) {
    state.livePrice = price;

    updateLivePrice(price);

    /*
      Update global state used by Question Bar.
    */
    window.currentPrice = price;

    /*
      Do not analyze on every tick.
      The 5-second analysis timer handles this.
    */
  }
}


function updateLivePrice(price) {
  const selectors = [
    "#price",
    "#livePrice",
    "#currentPrice"
  ];

  selectors.forEach(selector => {
    const el = $(selector);

    if (el) {
      el.textContent =
        formatPrice(price);
    }
  });
}


/* ============================================================
   EXACT TIMEFRAME HISTORY
   ============================================================ */

async function loadTimeframeHistory(
  symbol,
  timeframe,
  force = false
) {
  if (!symbol) {
    throw new Error("No symbol selected.");
  }

  if (!CONFIG.TIMEFRAMES[timeframe]) {
    throw new Error(
      `Unsupported timeframe: ${timeframe}`
    );
  }

  if (!state.candles[symbol]) {
    state.candles[symbol] = {};
  }

  const existing =
    state.candles[symbol][timeframe];

  if (
    !force &&
    existing &&
    existing.candles?.length &&
    now() - existing.updatedAt <
      CONFIG.STALE_DATA_MS
  ) {
    return existing.candles;
  }

  if (
    !state.ws ||
    state.ws.readyState !== WebSocket.OPEN
  ) {
    throw new Error(
      "Deriv WebSocket is not connected."
    );
  }

  const granularity =
    CONFIG.TIMEFRAMES[timeframe];

  const reqId = ++state.requestId;

  return new Promise((resolve, reject) => {
    state.historyRequests.set(reqId, {
      symbol,
      timeframe,
      granularity
    });

    state.pendingHistory.set(reqId, {
      resolve,
      reject,
      createdAt: now()
    });

    const request = {
      ticks_history: symbol,
      style: "candles",
      granularity,
      count: CONFIG.HISTORY_COUNT,
      end: "latest",
      req_id: reqId
    };

    try {
      state.ws.send(
        JSON.stringify(request)
      );
    } catch (error) {
      state.historyRequests.delete(reqId);
      state.pendingHistory.delete(reqId);
      reject(error);
    }
  });
}


/* ============================================================
   CANDLE RESPONSE
   ============================================================ */

function handleCandleResponse(data) {
  const reqId = data.req_id;

  const metadata =
    state.historyRequests.get(reqId);

  const pending =
    state.pendingHistory.get(reqId);

  /*
    NEVER use the currently selected UI timeframe
    to interpret a response.

    We use the timeframe that belonged to the
    actual request.
  */
  if (!metadata) {
    console.warn(
      "Received candle response without metadata:",
      reqId
    );
    return;
  }

  const {
    symbol,
    timeframe
  } = metadata;

  const candles = normalizeCandles(
    data.candles || []
  );

  if (!state.candles[symbol]) {
    state.candles[symbol] = {};
  }

  state.candles[symbol][timeframe] = {
    candles,
    updatedAt: now()
  };

  state.historyRequests.delete(reqId);

  if (pending) {
    state.pendingHistory.delete(reqId);
    pending.resolve(candles);
  }
}


/* ============================================================
   NORMALIZE CANDLES
   ============================================================ */

function normalizeCandles(rawCandles) {
  return rawCandles
    .map(c => ({
      epoch: safeNumber(c.epoch),
      open: safeNumber(c.open),
      high: safeNumber(c.high),
      low: safeNumber(c.low),
      close: safeNumber(c.close)
    }))
    .filter(
      c =>
        c.epoch !== null &&
        c.open !== null &&
        c.high !== null &&
        c.low !== null &&
        c.close !== null
    )
    .sort(
      (a, b) => a.epoch - b.epoch
    );
}


/* ============================================================
   EXACT CLOSED CANDLES
   ============================================================ */

function getClosedCandles(
  symbol,
  timeframe
) {
  if (!symbol) return [];

  const bucket =
    state.candles[symbol]?.[timeframe];

  if (!bucket?.candles?.length) {
    return [];
  }

  const duration =
    CONFIG.TIMEFRAMES[timeframe];

  const candles =
    bucket.candles.slice();

  const currentEpoch =
    Math.floor(now() / 1000);

  /*
    Remove the candle that is still forming.

    This keeps the analysis non-repainting.
  */
  return candles.filter(c => {
    const candleEnd =
      c.epoch + duration;

    return candleEnd <= currentEpoch;
  });
}


/* ============================================================
   ENSURE TIMEFRAME DATA
   ============================================================ */

async function ensureTimeframeData(
  symbol,
  timeframe,
  force = false
) {
  const existing =
    state.candles[symbol]?.[timeframe];

  if (
    !force &&
    existing?.candles?.length &&
    now() - existing.updatedAt <
      CONFIG.STALE_DATA_MS
  ) {
    return getClosedCandles(
      symbol,
      timeframe
    );
  }

  await loadTimeframeHistory(
    symbol,
    timeframe,
    force
  );

  return getClosedCandles(
    symbol,
    timeframe
  );
}


/* ============================================================
   SWING DETECTION
   ============================================================ */

function detectSwings(candles) {
  const highs = [];
  const lows = [];

  if (candles.length < 7) {
    return { highs, lows };
  }

  const depth = 3;

  for (
    let i = depth;
    i < candles.length - depth;
    i++
  ) {
    const current = candles[i];

    let swingHigh = true;
    let swingLow = true;

    for (
      let j = 1;
      j <= depth;
      j++
    ) {
      if (
        current.high <=
          candles[i - j].high ||
        current.high <=
          candles[i + j].high
      ) {
        swingHigh = false;
      }

      if (
        current.low >=
          candles[i - j].low ||
        current.low >=
          candles[i + j].low
      ) {
        swingLow = false;
      }
    }

    if (swingHigh) {
      highs.push({
        index: i,
        price: current.high,
        epoch: current.epoch
      });
    }

    if (swingLow) {
      lows.push({
        index: i,
        price: current.low,
        epoch: current.epoch
      });
    }
  }

  return {
    highs: highs.slice(-CONFIG.SWING_LOOKBACK),
    lows: lows.slice(-CONFIG.SWING_LOOKBACK)
  };
}


/* ============================================================
   STRUCTURE CLASSIFICATION
   ============================================================ */

function classifyStructure(candles) {
  const swings = detectSwings(candles);

  const highLabels = [];
  const lowLabels = [];

  for (
    let i = 1;
    i < swings.highs.length;
    i++
  ) {
    const previous =
      swings.highs[i - 1];

    const current =
      swings.highs[i];

    highLabels.push({
      type:
        current.price > previous.price
          ? "HH"
          : "LH",
      price: current.price
    });
  }

  for (
    let i = 1;
    i < swings.lows.length;
    i++
  ) {
    const previous =
      swings.lows[i - 1];

    const current =
      swings.lows[i];

    lowLabels.push({
      type:
        current.price > previous.price
          ? "HL"
          : "LL",
      price: current.price
    });
  }

  const recentHighs =
    highLabels.slice(-3);

  const recentLows =
    lowLabels.slice(-3);

  const bullish =
    recentHighs.filter(
      x => x.type === "HH"
    ).length +
    recentLows.filter(
      x => x.type === "HL"
    ).length;

  const bearish =
    recentHighs.filter(
      x => x.type === "LH"
    ).length +
    recentLows.filter(
      x => x.type === "LL"
    ).length;

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

    highs: swings.highs,
    lows: swings.lows,

    latestHigh:
      swings.highs.at(-1) || null,

    previousHigh:
      swings.highs.at(-2) || null,

    latestLow:
      swings.lows.at(-1) || null,

    previousLow:
      swings.lows.at(-2) || null
  };
}


/* ============================================================
   STRUCTURE EVENTS
   ============================================================ */

function detectStructureEvents(candles) {
  const structure =
    classifyStructure(candles);

  const latest =
    candles.at(-1);

  if (!latest) {
    return {
      bos: null,
      choch: null,
      direction: null
    };
  }

  const previousHigh =
    structure.previousHigh;

  const previousLow =
    structure.previousLow;

  let bos = null;
  let choch = null;

  if (
    previousHigh &&
    latest.close > previousHigh.price
  ) {
    bos = "BULLISH";

    if (
      structure.bias === "BEARISH"
    ) {
      choch = "BULLISH";
    }
  }

  if (
    previousLow &&
    latest.close < previousLow.price
  ) {
    bos = "BEARISH";

    if (
      structure.bias === "BULLISH"
    ) {
      choch = "BEARISH";
    }
  }

  return {
    bos,
    choch,
    direction:
      bos ||
      choch ||
      null
  };
}


/* ============================================================
   LIQUIDITY
   ============================================================ */

function detectLiquidity(candles) {
  const structure =
    classifyStructure(candles);

  const latest =
    candles.at(-1);

  if (!latest) {
    return {
      sweep: false,
      direction: null
    };
  }

  const high =
    structure.latestHigh;

  const low =
    structure.latestLow;

  if (
    high &&
    latest.high > high.price &&
    latest.close < high.price
  ) {
    return {
      sweep: true,
      direction: "SELL",
      type: "BUY-SIDE LIQUIDITY SWEEP"
    };
  }

  if (
    low &&
    latest.low < low.price &&
    latest.close > low.price
  ) {
    return {
      sweep: true,
      direction: "BUY",
      type: "SELL-SIDE LIQUIDITY SWEEP"
    };
  }

  return {
    sweep: false,
    direction: null,
    type: null
  };
}


/* ============================================================
   SUPPORT / RESISTANCE
   ============================================================ */

function detectSupportResistance(candles) {
  const structure =
    classifyStructure(candles);

  const supports =
    structure.lows
      .slice(-5)
      .map(x => x.price);

  const resistances =
    structure.highs
      .slice(-5)
      .map(x => x.price);

  return {
    supports,
    resistances,

    support:
      supports.at(-1) ?? null,

    resistance:
      resistances.at(-1) ?? null
  };
}


/* ============================================================
   SUPPLY / DEMAND
   ============================================================ */

function detectSupplyDemand(candles) {
  if (candles.length < 5) {
    return {
      supply: null,
      demand: null
    };
  }

  const recent =
    candles.slice(-20);

  let supply = null;
  let demand = null;

  const highest =
    Math.max(
      ...recent.map(c => c.high)
    );

  const lowest =
    Math.min(
      ...recent.map(c => c.low)
    );

  supply = {
    high: highest,
    low: highest -
      getAverageRange(recent)
  };

  demand = {
    low: lowest,
    high: lowest +
      getAverageRange(recent)
  };

  return {
    supply,
    demand
  };
}


/* ============================================================
   ORDER BLOCK
   ============================================================ */

function detectOrderBlock(candles) {
  if (candles.length < 6) {
    return {
      bullish: null,
      bearish: null
    };
  }

  const averageRange =
    getAverageRange(candles);

  const last = candles.at(-1);
  const previous = candles.at(-2);

  const bullishDisplacement =
    last.close > previous.high &&
    last.close - last.open >
      averageRange * 0.6;

  const bearishDisplacement =
    last.close < previous.low &&
    last.open - last.close >
      averageRange * 0.6;

  let bullish = null;
  let bearish = null;

  if (bullishDisplacement) {
    bullish = {
      high: previous.high,
      low: previous.low,
      index: candles.length - 2
    };
  }

  if (bearishDisplacement) {
    bearish = {
      high: previous.high,
      low: previous.low,
      index: candles.length - 2
    };
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

  const a = candles.at(-3);
  const b = candles.at(-2);
  const c = candles.at(-1);

  let bullish = null;
  let bearish = null;

  if (c.low > a.high) {
    bullish = {
      high: c.low,
      low: a.high,
      midpoint:
        (c.low + a.high) / 2
    };
  }

  if (c.high < a.low) {
    bearish = {
      high: a.low,
      low: c.high,
      midpoint:
        (a.low + c.high) / 2
    };
  }

  return {
    bullish,
    bearish
  };
}


/* ============================================================
   CANDLESTICK CONFIRMATION
   ============================================================ */

function detectCandlestickConfirmation(
  candles
) {
  const candle =
    candles.at(-1);

  if (!candle) {
    return {
      confirmed: false,
      direction: null,
      pattern: null,
      rejection: false,
      momentum: false
    };
  }

  const range =
    candle.high - candle.low;

  if (range <= 0) {
    return {
      confirmed: false,
      direction: null,
      pattern: null,
      rejection: false,
      momentum: false
    };
  }

  const body =
    Math.abs(
      candle.close - candle.open
    );

  const upperWick =
    candle.high -
    Math.max(
      candle.open,
      candle.close
    );

  const lowerWick =
    Math.min(
      candle.open,
      candle.close
    ) -
    candle.low;

  const bullish =
    candle.close > candle.open;

  const bearish =
    candle.close < candle.open;

  const bullishPin =
    lowerWick > body * 1.5 &&
    lowerWick > upperWick;

  const bearishPin =
    upperWick > body * 1.5 &&
    upperWick > lowerWick;

  const strongBull =
    bullish &&
    body / range >= 0.65;

  const strongBear =
    bearish &&
    body / range >= 0.65;

  let direction = null;
  let pattern = null;

  if (
    bullishPin ||
    strongBull
  ) {
    direction = "BUY";

    pattern = bullishPin
      ? "BULLISH REJECTION"
      : "BULLISH MOMENTUM";
  }

  if (
    bearishPin ||
    strongBear
  ) {
    direction = "SELL";

    pattern = bearishPin
      ? "BEARISH REJECTION"
      : "BEARISH MOMENTUM";
  }

  return {
    confirmed: Boolean(direction),
    direction,
    pattern,

    rejection:
      bullishPin ||
      bearishPin,

    momentum:
      strongBull ||
      strongBear
  };
}


/* ============================================================
   DISPLACEMENT
   ============================================================ */

function detectDisplacement(candles) {
  if (candles.length < 10) {
    return {
      detected: false,
      direction: null
    };
  }

  const average =
    getAverageRange(
      candles.slice(-10)
    );

  const last =
    candles.at(-1);

  const range =
    last.high - last.low;

  if (range < average * 1.4) {
    return {
      detected: false,
      direction: null
    };
  }

  return {
    detected: true,

    direction:
      last.close > last.open
        ? "BUY"
        : "SELL"
  };
}


/* ============================================================
   AVERAGE RANGE
   ============================================================ */

function getAverageRange(candles) {
  if (!candles.length) return 0;

  const ranges =
    candles.map(
      c => c.high - c.low
    );

  return (
    ranges.reduce(
      (sum, value) =>
        sum + value,
      0
    ) / ranges.length
  );
}


/* ============================================================
   TIMEFRAME ANALYSIS
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

  if (candles.length < 20) {
    return {
      symbol,
      timeframe,
      candles,
      ready: false,
      reason:
        `Not enough closed ${timeframe} candles.`
    };
  }

  const structure =
    classifyStructure(candles);

  const events =
    detectStructureEvents(candles);

  const liquidity =
    detectLiquidity(candles);

  const sr =
    detectSupportResistance(candles);

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
    symbol,
    timeframe,
    candles,

    ready: true,

    price:
      candles.at(-1)?.close ?? null,

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

async function buildTopDownAnalysis(
  symbol,
  selectedTimeframe
) {
  /*
    Selected timeframe is ALWAYS loaded and used
    as the execution timeframe.
  */

  const execution =
    analyzeTimeframe(
      symbol,
      selectedTimeframe
    );

  /*
    Higher timeframe context.

    These are separate datasets.

    They do NOT replace the selected timeframe.
  */

  const contextTimeframes = [
    "Daily",
    "H4",
    "H2",
    "H1"
  ];

  const context = {};

  for (const tf of contextTimeframes) {
    if (tf === selectedTimeframe) {
      context[tf] = execution;
      continue;
    }

    const existing =
      state.candles[symbol]?.[tf];

    if (
      !existing?.candles?.length
    ) {
      try {
        await loadTimeframeHistory(
          symbol,
          tf,
          false
        );
      } catch (error) {
        console.warn(
          `Unable to load ${tf}:`,
          error
        );
      }
    }

    context[tf] =
      analyzeTimeframe(
        symbol,
        tf
      );
  }

  const h1 =
    context.H1;

  const htfBias =
    getHTFBias(context);

  return {
    symbol,

    selectedTimeframe,

    execution,

    context,

    h1,

    htfBias
  };
}


/* ============================================================
   HIGHER TIMEFRAME BIAS
   ============================================================ */

function getHTFBias(context) {
  const weights = {
    Daily: 4,
    H4: 3,
    H2: 2,
    H1: 1
  };

  let bullish = 0;
  let bearish = 0;

  Object.keys(weights).forEach(tf => {
    const item = context[tf];

    if (!item?.ready) return;

    if (
      item.structure?.bias ===
      "BULLISH"
    ) {
      bullish += weights[tf];
    }

    if (
      item.structure?.bias ===
      "BEARISH"
    ) {
      bearish += weights[tf];
    }
  });

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
  execution,
  topDown
) {
  const scores = {
    BUY: 0,
    SELL: 0
  };

  if (
    execution.structure.bias ===
    "BULLISH"
  ) {
    scores.BUY += 2;
  }

  if (
    execution.structure.bias ===
    "BEARISH"
  ) {
    scores.SELL += 2;
  }

  if (
    execution.events.bos ===
    "BULLISH"
  ) {
    scores.BUY += 3;
  }

  if (
    execution.events.bos ===
    "BEARISH"
  ) {
    scores.SELL += 3;
  }

  if (
    execution.events.choch ===
    "BULLISH"
  ) {
    scores.BUY += 2;
  }

  if (
    execution.events.choch ===
    "BEARISH"
  ) {
    scores.SELL += 2;
  }

  if (
    execution.liquidity.direction ===
    "BUY"
  ) {
    scores.BUY += 2;
  }

  if (
    execution.liquidity.direction ===
    "SELL"
  ) {
    scores.SELL += 2;
  }

  if (
    execution.displacement.direction ===
    "BUY"
  ) {
    scores.BUY += 2;
  }

  if (
    execution.displacement.direction ===
    "SELL"
  ) {
    scores.SELL += 2;
  }

  if (
    execution.candle.direction ===
    "BUY"
  ) {
    scores.BUY += 2;
  }

  if (
    execution.candle.direction ===
    "SELL"
  ) {
    scores.SELL += 2;
  }

  /*
    HTF context is confirmation,
    not a replacement for execution timeframe.
  */

  if (topDown.htfBias === "BULLISH") {
    scores.BUY += 2;
  }

  if (topDown.htfBias === "BEARISH") {
    scores.SELL += 2;
  }

  if (
    scores.BUY === 0 &&
    scores.SELL === 0
  ) {
    return null;
  }

  if (scores.BUY > scores.SELL) {
    return "BUY";
  }

  if (scores.SELL > scores.BUY) {
    return "SELL";
  }

  return null;
}


/* ============================================================
   EVIDENCE SCORING
   ============================================================ */

function scoreEvidence(
  direction,
  execution,
  topDown
) {
  let score = 0;
  const evidence = [];

  if (
    direction === "BUY" &&
    execution.structure.bias ===
      "BULLISH"
  ) {
    score += 2;
    evidence.push(
      `${execution.timeframe} bullish structure`
    );
  }

  if (
    direction === "SELL" &&
    execution.structure.bias ===
      "BEARISH"
  ) {
    score += 2;
    evidence.push(
      `${execution.timeframe} bearish structure`
    );
  }

  if (
    execution.events.bos ===
    direction
  ) {
    score += 3;
    evidence.push(
      `${execution.timeframe} BOS ${direction}`
    );
  }

  if (
    execution.events.choch ===
    direction
  ) {
    score += 2;
    evidence.push(
      `${execution.timeframe} CHoCH ${direction}`
    );
  }

  if (
    execution.liquidity.direction ===
    direction
  ) {
    score += 2;
    evidence.push(
      `${execution.timeframe} liquidity sweep`
    );
  }

  if (
    execution.displacement.direction ===
    direction
  ) {
    score += 2;
    evidence.push(
      `${execution.timeframe} displacement`
    );
  }

  if (
    execution.candle.direction ===
    direction
  ) {
    score += 2;
    evidence.push(
      execution.candle.pattern ||
      "Candlestick confirmation"
    );
  }

  if (
    direction === "BUY" &&
    topDown.htfBias === "BULLISH"
  ) {
    score += 2;
    evidence.push(
      "HTF bullish alignment"
    );
  }

  if (
    direction === "SELL" &&
    topDown.htfBias === "BEARISH"
  ) {
    score += 2;
    evidence.push(
      "HTF bearish alignment"
    );
  }

  if (
    execution.fvg?.bullish &&
    direction === "BUY"
  ) {
    score += 1;
    evidence.push(
      "Bullish FVG"
    );
  }

  if (
    execution.fvg?.bearish &&
    direction === "SELL"
  ) {
    score += 1;
    evidence.push(
      "Bearish FVG"
    );
  }

  if (
    execution.orderBlock?.bullish &&
    direction === "BUY"
  ) {
    score += 1;
    evidence.push(
      "Bullish order block"
    );
  }

  if (
    execution.orderBlock?.bearish &&
    direction === "SELL"
  ) {
    score += 1;
    evidence.push(
      "Bearish order block"
    );
  }

  return {
    score,
    evidence
  };
}


/* ============================================================
   SETUP GRADE
   ============================================================ */

function gradeSetup(
  direction,
  execution,
  evidence
) {
  const score =
    evidence.score;

  const candleConfirmed =
    execution.candle.direction ===
    direction;

  const structuralConfirmation =
    execution.events.bos ===
      direction ||
    execution.events.choch ===
      direction ||
    execution.liquidity.direction ===
      direction ||
    execution.displacement.direction ===
      direction;

  /*
    EARLY SETUP

    Does NOT require every confirmation.

    This is intentional.
  */

  if (
    score >= 4 &&
    structuralConfirmation
  ) {
    if (
      score >= 13 &&
      candleConfirmed &&
      execution.events.bos ===
        direction
    ) {
      return "A+";
    }

    if (
      score >= 10 &&
      candleConfirmed
    ) {
      return "A";
    }

    if (score >= 7) {
      return "B";
    }

    if (score >= 4) {
      return "C";
    }
  }

  /*
    EARLY monitoring signal.

    Allows the bot to alert before
    every confirmation is present.
  */

  if (
    score >= 3 &&
    (
      execution.structure.bias ===
        (direction === "BUY"
          ? "BULLISH"
          : "BEARISH") ||
      execution.liquidity.direction ===
        direction ||
      execution.displacement.direction ===
        direction
    )
  ) {
    return "EARLY SETUP";
  }

  return "NO SETUP";
}


/* ============================================================
   TRADE LEVELS
   ============================================================ */

function calculateTradeLevels(
  direction,
  execution
) {
  const candles =
    execution.candles;

  const last =
    candles.at(-1);

  if (!last) return null;

  const entry =
    last.close;

  const range =
    getAverageRange(
      candles.slice(-20)
    );

  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(range) ||
    range <= 0
  ) {
    return null;
  }

  const structure =
    execution.structure;

  let sl;

  if (direction === "BUY") {
    const structuralLow =
      structure.latestLow?.price;

    sl =
      structuralLow &&
      structuralLow < entry
        ? structuralLow -
          range * 0.15
        : entry -
          range * 1.2;
  } else {
    const structuralHigh =
      structure.latestHigh?.price;

    sl =
      structuralHigh &&
      structuralHigh > entry
        ? structuralHigh +
          range * 0.15
        : entry +
          range * 1.2;
  }

  const risk =
    Math.abs(entry - sl);

  if (!risk) return null;

  const tp1 =
    direction === "BUY"
      ? entry + risk * 2
      : entry - risk * 2;

  const tp2 =
    direction === "BUY"
      ? entry + risk * 3
      : entry - risk * 3;

  const be =
    entry;

  return {
    entry,
    sl,
    be,
    tp1,
    tp2,

    risk,

    rrTP1: 2,
    rrTP2: 3
  };
}


/* ============================================================
   SIGNAL GENERATION
   ============================================================ */

function generatePrecisionSignal(
  symbol,
  timeframe,
  topDown
) {
  /*
    CRITICAL:

    Signal is generated from topDown.execution,
    which is the EXACT selected timeframe.

    There is no M5 fallback here.
  */

  const execution =
    topDown.execution;

  if (
    !execution ||
    !execution.ready
  ) {
    return {
      status: "WAIT",
      signal: null,
      reason:
        `Waiting for ${timeframe} closed candles.`
    };
  }

  const direction =
    determineDirection(
      execution,
      topDown
    );

  if (!direction) {
    return {
      status: "NO SETUP",
      signal: null,
      reason:
        `No confirmed ${timeframe} directional setup.`
    };
  }

  const evidence =
    scoreEvidence(
      direction,
      execution,
      topDown
    );

  const grade =
    gradeSetup(
      direction,
      execution,
      evidence
    );

  if (grade === "NO SETUP") {
    return {
      status: "NO SETUP",
      signal: null,
      reason:
        `No valid ${timeframe} setup.`
    };
  }

  const levels =
    calculateTradeLevels(
      direction,
      execution
    );

  if (!levels) {
    return {
      status: "WAIT",
      signal: null,
      reason:
        `Waiting for valid ${timeframe} trade levels.`
    };
  }

  const signal = {
    id:
      `${symbol}_${timeframe}_${direction}`,

    symbol,

    timeframe,

    direction,

    grade,

    score:
      evidence.score,

    confidence:
      clamp(
        50 +
          evidence.score * 3,
        50,
        97
      ),

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
      levels.rrTP2,

    htfBias:
      topDown.htfBias,

    structure:
      execution.structure.bias,

    bos:
      execution.events.bos,

    choch:
      execution.events.choch,

    liquidity:
      execution.liquidity,

    candle:
      execution.candle,

    fvg:
      execution.fvg,

    orderBlock:
      execution.orderBlock,

    evidence:
      evidence.evidence,

    explanation:
      buildAIExplanation(
        direction,
        timeframe,
        grade,
        execution,
        topDown,
        evidence,
        levels
      ),

    createdAt: now(),

    invalidated: false
  };

  return {
    status: "SIGNAL",
    signal,
    reason: ""
  };
}


/* ============================================================
   AI EXPLANATION
   ============================================================ */

function buildAIExplanation(
  direction,
  timeframe,
  grade,
  execution,
  topDown,
  evidence,
  levels
) {
  const parts = [];

  parts.push(
    `${direction} setup detected on ${timeframe}.`
  );

  parts.push(
    `Setup grade: ${grade}.`
  );

  parts.push(
    `HTF bias: ${topDown.htfBias}.`
  );

  if (
    execution.structure?.bias
  ) {
    parts.push(
      `${timeframe} structure is ${execution.structure.bias}.`
    );
  }

  if (
    execution.events.bos
  ) {
    parts.push(
      `${timeframe} ${execution.events.bos} BOS detected.`
    );
  }

  if (
    execution.events.choch
  ) {
    parts.push(
      `${timeframe} ${execution.events.choch} CHoCH detected.`
    );
  }

  if (
    execution.liquidity?.sweep
  ) {
    parts.push(
      `${execution.liquidity.type} detected.`
    );
  }

  if (
    execution.displacement?.detected
  ) {
    parts.push(
      `${timeframe} displacement confirmed.`
    );
  }

  if (
    execution.candle?.confirmed
  ) {
    parts.push(
      `${execution.candle.pattern} candle confirmation.`
    );
  } else {
    parts.push(
      `Candlestick confirmation is not yet complete.`
    );
  }

  parts.push(
    `Entry: ${formatPrice(levels.entry)}.`
  );

  parts.push(
    `SL: ${formatPrice(levels.sl)}.`
  );

  parts.push(
    `TP1: ${formatPrice(levels.tp1)}.`
  );

  parts.push(
    `TP2: ${formatPrice(levels.tp2)}.`
  );

  parts.push(
    `Risk-to-TP2 is approximately 1:${levels.rrTP2}.`
  );

  return parts.join(" ");
}


/* ============================================================
   MAIN ANALYSIS ENGINE
   ============================================================ */

async function runPrecisionAnalysis(
  force = false
) {
  if (state.analysisRunning) {
    return;
  }

  const symbol =
    state.selectedSymbol ||
    $("#market")?.value;

  const timeframe =
    getSelectedTimeframe();

  if (!symbol) {
    setWaitingState(
      "NO MARKET",
      "Select a market first."
    );
    return;
  }

  state.selectedSymbol = symbol;

  updateChosenPairDisplay();
  updateMarketName();

  state.analysisRunning = true;

  try {
    /*
      STEP 1:
      Get EXACT selected timeframe data.
    */

    let candles =
      await ensureTimeframeData(
        symbol,
        timeframe,
        force
      );

    /*
      If data is too short, request again.
    */

    if (candles.length < 20) {
      candles =
        await ensureTimeframeData(
          symbol,
          timeframe,
          true
        );
    }

    /*
      STEP 2:
      Build top-down context.
    */

    const topDown =
      await buildTopDownAnalysis(
        symbol,
        timeframe
      );

    /*
      STEP 3:
      Generate signal using selected timeframe.
    */

    const result =
      generatePrecisionSignal(
        symbol,
        timeframe,
        topDown
      );

    const analysis = {
      symbol,

      timeframe,

      selectedTimeframe:
        timeframe,

      price:
        state.livePrice ??
        candles.at(-1)?.close ??
        null,

      candles,

      topDown,

      execution:
        topDown.execution,

      result,

      generatedAt: now()
    };

    state.analysis =
      analysis;

    /*
      Expose current analysis to the UI
      and Question Bar.
    */

    window.lastAnalysis =
      analysis;

    window.currentAnalysis =
      analysis;

    window.currentSymbol =
      symbol;

    window.currentPrice =
      state.livePrice ??
      candles.at(-1)?.close ??
      null;

    window.currentTimeframe =
      timeframe;

    window.closedCandles =
      candles;

    /*
      STEP 4:
      Update dashboard.
    */

    updateDashboard(
      analysis
    );

    /*
      STEP 5:
      Process progressive signal.
    */

    if (
      result.status === "SIGNAL" &&
      result.signal
    ) {
      processSignal(
        result.signal
      );
    } else {
      /*
        Only show NO SETUP when there really
        isn't a valid setup.
      */

      setWaitingState(
        result.status,
        result.reason
      );
    }

    /*
      Allow charts or other UI components
      to receive the latest analysis.
    */

    document.dispatchEvent(
      new CustomEvent(
        "precision-analysis",
        {
          detail: analysis
        }
      )
    );

  } catch (error) {
    console.error(
      "Precision analysis failed:",
      error
    );

    setWaitingState(
      "WAIT",
      `Waiting for ${symbol} ${timeframe} data.`
    );

  } finally {
    state.analysisRunning = false;
  }
}


/* ============================================================
   SIGNAL PROCESSING
   ============================================================ */

function processSignal(signal) {
  if (!signal) return;

  /*
    Never allow a signal from a different timeframe
    to overwrite the selected timeframe.
  */

  if (
    signal.timeframe !==
    getSelectedTimeframe()
  ) {
    console.warn(
      "Blocked stale timeframe signal:",
      signal
    );

    return;
  }

  const key =
    `${signal.symbol}_${signal.timeframe}_${signal.direction}`;

  const previous =
    state.activeSignal;

  const rank = {
    "EARLY SETUP": 1,
    C: 2,
    B: 3,
    A: 4,
    "A+": 5
  };

  /*
    New setup.
  */

  if (!previous) {
    state.activeSignal =
      signal;

    state.lastSignalKey =
      key;

    addSignalHistory(
      signal
    );

    notifySignal(
      signal,
      "NEW"
    );

    updateSignalDashboard(
      signal
    );

    return;
  }

  /*
    Different direction:
    replace only when new signal is stronger.
  */

  if (
    previous.direction !==
    signal.direction
  ) {
    state.activeSignal =
      signal;

    state.lastSignalKey =
      key;

    addSignalHistory(
      signal
    );

    notifySignal(
      signal,
      "NEW DIRECTION"
    );

    updateSignalDashboard(
      signal
    );

    return;
  }

  /*
    Same direction and timeframe:
    upgrade when confirmation improves.
  */

  const oldRank =
    rank[previous.grade] || 0;

  const newRank =
    rank[signal.grade] || 0;

  if (
    newRank > oldRank
  ) {
    state.activeSignal =
      signal;

    state.lastSignalKey =
      key;

    addSignalHistory(
      signal
    );

    notifySignal(
      signal,
      `UPGRADED ${previous.grade} → ${signal.grade}`
    );

    updateSignalDashboard(
      signal
    );

    return;
  }

  /*
    Refresh price/levels without generating
    duplicate notifications.
  */

  state.activeSignal = {
    ...previous,
    ...signal
  };

  updateSignalDashboard(
    state.activeSignal
  );
}


/* ============================================================
   SIGNAL INVALIDATION
   ============================================================ */

function checkSignalInvalidation() {
  const signal =
    state.activeSignal;

  if (!signal) return;

  const price =
    state.livePrice;

  if (!Number.isFinite(price)) {
    return;
  }

  let invalid = false;

  if (
    signal.direction === "BUY" &&
    price <= signal.sl
  ) {
    invalid = true;
  }

  if (
    signal.direction === "SELL" &&
    price >= signal.sl
  ) {
    invalid = true;
  }

  if (!invalid) return;

  state.activeSignal = null;

  text(
    "#signal",
    "INVALIDATED"
  );

  text(
    "#direction",
    `${signal.direction} — ${signal.timeframe}`
  );

  text(
    "#setup",
    "SETUP INVALIDATED"
  );

  text(
    "#explanationText",
    `${signal.symbol} ${signal.timeframe} setup invalidated because price crossed the stop level.`
  );
}


/* ============================================================
   DASHBOARD UPDATE
   ============================================================ */

function updateDashboard(
  analysis
) {
  const tf =
    analysis.timeframe;

  const symbol =
    analysis.symbol;

  const price =
    analysis.price;

  updateChosenPairDisplay();

  updateMarketName();

  updateLivePrice(
    price
  );

  /*
    Explicitly display selected timeframe.
  */

  const timeframeSelectors = [
    "#analysisTimeframe",
    "#selectedTimeframe",
    "#signalTimeframe"
  ];

  timeframeSelectors.forEach(selector => {
    const el = $(selector);

    if (el) {
      el.textContent =
        tf;
    }
  });

  const result =
    analysis.result;

  if (
    result?.signal
  ) {
    updateSignalDashboard(
      result.signal
    );
  }
}


/* ============================================================
   SIGNAL CARD
   ============================================================ */

function updateSignalDashboard(
  signal
) {
  if (!signal) return;

  const directionText =
    `${signal.direction} • ${signal.timeframe}`;

  text(
    "#signal",
    directionText
  );

  text(
    "#direction",
    `${signal.direction} — ${signal.timeframe}`
  );

  text(
    "#setup",
    `${signal.grade} SETUP • ${signal.timeframe}`
  );

  text(
    "#confidence",
    `${signal.confidence}%`
  );

  text(
    "#rr",
    `1:${signal.rr}`
  );

  text(
    "#entry",
    formatPrice(
      signal.entry
    )
  );

  text(
    "#sl",
    formatPrice(
      signal.sl
    )
  );

  text(
    "#tp1",
    formatPrice(
      signal.tp1
    )
  );

  text(
    "#tp2",
    formatPrice(
      signal.tp2
    )
  );

  text(
    "#swing",
    signal.structure ||
      "N/A"
  );

  text(
    "#structure",
    signal.bos ||
      signal.choch ||
      signal.structure ||
      "WAITING"
  );

  text(
    "#liquidity",
    signal.liquidity?.type ||
      "WAITING"
  );

  text(
    "#sr",
    "ACTIVE"
  );

  text(
    "#pattern",
    signal.candle?.pattern ||
      "WAITING"
  );

  text(
    "#rejection",
    signal.candle?.rejection
      ? "CONFIRMED"
      : "WAITING"
  );

  text(
    "#momentum",
    signal.candle?.momentum
      ? "CONFIRMED"
      : "WAITING"
  );

  text(
    "#confirmation",
    signal.candle?.confirmed
      ? "CONFIRMED"
      : "WAITING"
  );

  text(
    "#explanationText",
    signal.explanation
  );

  updateChosenPairDisplay();

  /*
    Add timeframe to signal card title
    if such an element exists.
  */

  const label =
    $("#signalLabel");

  if (label) {
    label.textContent =
      `${getMarketDisplayName(signal.symbol)} — ${signal.timeframe}`;
  }
}


/* ============================================================
   WAITING / NO SETUP
   ============================================================ */

function setWaitingState(
  status,
  reason
) {
  const tf =
    getSelectedTimeframe();

  const symbol =
    state.selectedSymbol ||
    $("#market")?.value ||
    "MARKET";

  updateChosenPairDisplay();

  if (status === "NO SETUP") {
    text(
      "#signal",
      `NO SETUP — ${tf}`
    );

    text(
      "#direction",
      `WAIT — ${tf}`
    );

    text(
      "#setup",
      `NO CONFIRMED SETUP — ${tf}`
    );
  } else {
    text(
      "#signal",
      `${status} — ${tf}`
    );

    text(
      "#direction",
      `WAIT — ${tf}`
    );

    text(
      "#setup",
      `${status} — ${tf}`
    );
  }

  text(
    "#confidence",
    "--"
  );

  text(
    "#rr",
    "--"
  );

  text(
    "#explanationText",
    reason ||
      `${symbol} is being analyzed on ${tf}.`
  );
}


/* ============================================================
   SIGNAL HISTORY
   ============================================================ */

function addSignalHistory(
  signal
) {
  const key =
    `${signal.symbol}_${signal.timeframe}_${signal.direction}_${signal.grade}`;

  const duplicate =
    state.signalHistory.some(
      item => item.key === key
    );

  if (duplicate) return;

  state.signalHistory.unshift({
    key,

    symbol:
      signal.symbol,

    timeframe:
      signal.timeframe,

    direction:
      signal.direction,

    grade:
      signal.grade,

    entry:
      signal.entry,

    sl:
      signal.sl,

    tp1:
      signal.tp1,

    tp2:
      signal.tp2,

    createdAt:
      signal.createdAt
  });

  state.signalHistory =
    state.signalHistory.slice(
      0,
      50
    );

  renderSignalHistory();
}


function renderSignalHistory() {
  const container =
    $("#signalHistory");

  if (!container) return;

  container.innerHTML = "";

  state.signalHistory
    .slice(0, 20)
    .forEach(item => {
      const row =
        document.createElement("div");

      row.className =
        "signal-history-item";

      row.textContent =
        `${item.symbol} • ${item.timeframe} • ${item.direction} • ${item.grade} • Entry ${formatPrice(item.entry)}`;

      container.appendChild(row);
    });
}


/* ============================================================
   ALERTS
   ============================================================ */

function notifySignal(
  signal,
  eventType
) {
  if (!state.alertsEnabled) {
    return;
  }

  const key =
    `${signal.symbol}_${signal.timeframe}_${signal.direction}_${signal.grade}_${eventType}`;

  const last =
    state.notifiedSignals.get(key);

  if (
    last &&
    now() - last <
      CONFIG.DUPLICATE_COOLDOWN
  ) {
    return;
  }

  state.notifiedSignals.set(
    key,
    now()
  );

  const title =
    `SUCCESSFUL PINE SCRIPT — ${signal.grade}`;

  const message =
    `${signal.symbol} • ${signal.timeframe}\n` +
    `${signal.direction}\n` +
    `Entry: ${formatPrice(signal.entry)}\n` +
    `SL: ${formatPrice(signal.sl)}\n` +
    `TP1: ${formatPrice(signal.tp1)}\n` +
    `TP2: ${formatPrice(signal.tp2)}`;

  showInAppAlert(
    title,
    message
  );

  sendBrowserNotification(
    title,
    message
  );
}


function showInAppAlert(
  title,
  message
) {
  let box =
    $("#precisionAlert");

  if (!box) {
    box =
      document.createElement("div");

    box.id =
      "precisionAlert";

    box.style.position =
      "fixed";

    box.style.right =
      "16px";

    box.style.bottom =
      "16px";

    box.style.zIndex =
      "99999";

    box.style.maxWidth =
      "360px";

    box.style.padding =
      "14px";

    box.style.borderRadius =
      "12px";

    box.style.background =
      "#111";

    box.style.color =
      "#fff";

    box.style.whiteSpace =
      "pre-line";

    document.body.appendChild(
      box
    );
  }

  box.textContent =
    `${title}\n${message}`;

  box.style.display =
    "block";

  setTimeout(() => {
    box.style.display =
      "none";
  }, 10000);
}


async function sendBrowserNotification(
  title,
  body
) {
  if (
    !("Notification" in window)
  ) {
    return;
  }

  try {
    if (
      Notification.permission ===
      "default"
    ) {
      await Notification.requestPermission();
    }

    if (
      Notification.permission ===
      "granted"
    ) {
      new Notification(
        title,
        {
          body
        }
      );
    }
  } catch (error) {
    console.warn(
      "Notification error:",
      error
    );
  }
}


/* ============================================================
   ALERT CONTROL
   ============================================================ */

function createAlertControl() {
  const existing =
    $("#alertToggle");

  if (existing) {
    existing.addEventListener(
      "click",
      () => {
        state.alertsEnabled =
          !state.alertsEnabled;

        existing.textContent =
          state.alertsEnabled
            ? "🔔 Alerts ON"
            : "🔕 Alerts OFF";
      }
    );

    return;
  }

  /*
    Only create the control if there
    isn't already one.
  */

  const button =
    document.createElement("button");

  button.id =
    "alertToggle";

  button.textContent =
    "🔔 Alerts ON";

  button.style.position =
    "fixed";

  button.style.left =
    "12px";

  button.style.bottom =
    "12px";

  button.style.zIndex =
    "9999";

  button.addEventListener(
    "click",
    () => {
      state.alertsEnabled =
        !state.alertsEnabled;

      button.textContent =
        state.alertsEnabled
          ? "🔔 Alerts ON"
          : "🔕 Alerts OFF";
    }
  );

  document.body.appendChild(
    button
  );
}


/* ============================================================
   QUESTION BAR
   ============================================================ */

function createQuestionBar() {
  if (
    $("#aiQuestion") ||
    $("#questionInput")
  ) {
    setupExistingQuestionBar();
    return;
  }

  const wrapper =
    document.createElement("div");

  wrapper.id =
    "successfulAIQuestionBar";

  wrapper.style.margin =
    "20px 0";

  wrapper.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;">
      <input
        id="aiQuestion"
        type="text"
        placeholder="Ask Successful AI about this live market..."
        style="flex:1;"
      />

      <button id="aiAskButton">
        Ask AI
      </button>
    </div>

    <div
      id="aiAnswer"
      style="margin-top:10px;white-space:pre-line;"
    >
      Ask a question about the selected market or setup.
    </div>
  `;

  const target =
    $(".container") ||
    $("main") ||
    document.body;

  target.appendChild(
    wrapper
  );

  const input =
    $("#aiQuestion");

  const button =
    $("#aiAskButton");

  if (button) {
    button.addEventListener(
      "click",
      () => {
        askSuccessfulAI(
          input?.value || ""
        );
      }
    );
  }

  if (input) {
    input.addEventListener(
      "keydown",
      event => {
        if (
          event.key ===
          "Enter"
        ) {
          askSuccessfulAI(
            input.value
          );
        }
      }
    );
  }
}


function setupExistingQuestionBar() {
  const input =
    $("#aiQuestion") ||
    $("#questionInput");

  const button =
    $("#aiAskButton") ||
    $("#askAI") ||
    $("#askButton");

  if (button) {
    button.addEventListener(
      "click",
      () => {
        askSuccessfulAI(
          input?.value || ""
        );
      }
    );
  }

  if (input) {
    input.addEventListener(
      "keydown",
      event => {
        if (
          event.key ===
          "Enter"
        ) {
          askSuccessfulAI(
            input.value
          );
        }
      }
    );
  }
}


/* ============================================================
   AI QUESTION BAR
   ============================================================ */

async function askSuccessfulAI(
  question
) {
  question =
    String(
      question || ""
    ).trim();

  if (!question) {
    return;
  }

  const answerBox =
    $("#aiAnswer") ||
    $("#answer");

  if (answerBox) {
    answerBox.textContent =
      "Analyzing the live market data...";
  }

  const analysis =
    window.lastAnalysis ||
    window.currentAnalysis ||
    {};

  const candles =
    window.closedCandles ||
    window.currentCandles ||
    [];

  const marketSelect =
    $("#market");

  const symbol =
    marketSelect?.value ||
    window.currentSymbol ||
    state.selectedSymbol ||
    "Unknown";

  const timeframe =
    getSelectedTimeframe();

  const market = {
    symbol,

    name:
      marketSelect
        ?.selectedOptions?.[0]
        ?.textContent ||
      getMarketDisplayName(
        symbol
      ),

    price:
      window.currentPrice ??
      state.livePrice ??
      null
  };

  const payload = {
    question,

    market,

    timeframe,

    granularity:
      CONFIG.TIMEFRAMES[timeframe],

    analysis,

    candles
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

          body:
            JSON.stringify(
              payload
            )
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
        "AI request failed."
      );
    }

    const answer =
      data.answer ||
      data.fallback ||
      "No answer returned.";

    if (answerBox) {
      answerBox.textContent =
        answer;
    }

    window.lastAIAnswer =
      answer;

    return answer;

  } catch (error) {
    console.error(
      "AI Question Bar error:",
      error
    );

    /*
      Local fallback keeps the Question Bar
      useful even if /api/ask is unavailable.
    */

    const fallback =
      localAIAnswer(
        question
      );

    if (answerBox) {
      answerBox.textContent =
        fallback;
    }

    window.lastAIAnswer =
      fallback;

    return fallback;
  }
}


/* ============================================================
   LOCAL AI FALLBACK
   ============================================================ */

function localAIAnswer(
  question
) {
  const analysis =
    window.lastAnalysis;

  const tf =
    getSelectedTimeframe();

  const symbol =
    state.selectedSymbol;

  const lower =
    question.toLowerCase();

  if (!analysis) {
    return `I do not have enough live ${tf} analysis data yet. Wait for the ${symbol || "selected market"} ${tf} candles to load.`;
  }

  const result =
    analysis.result;

  if (
    lower.includes("signal") ||
    lower.includes("trade") ||
    lower.includes("buy") ||
    lower.includes("sell")
  ) {
    if (
      result?.signal
    ) {
      const s =
        result.signal;

      return (
        `${s.symbol} is currently being analyzed on ${s.timeframe}.\n\n` +
        `Direction: ${s.direction}\n` +
        `Setup: ${s.grade}\n` +
        `Entry: ${formatPrice(s.entry)}\n` +
        `SL: ${formatPrice(s.sl)}\n` +
        `TP1: ${formatPrice(s.tp1)}\n` +
        `TP2: ${formatPrice(s.tp2)}\n` +
        `RR: 1:${s.rr}\n\n` +
        `${s.explanation}`
      );
    }

    return (
      `${symbol} currently has no confirmed ${tf} setup. ` +
      `The engine is waiting for stronger price-action confirmation.`
    );
  }

  if (
    lower.includes("timeframe") ||
    lower.includes("tf")
  ) {
    return (
      `The selected analysis timeframe is ${tf}. ` +
      `Signals and entries are generated from the ${tf} candles, while higher timeframes are used only for context.`
    );
  }

  if (
    lower.includes("why")
  ) {
    return (
      analysis.result?.signal?.explanation ||
      `The engine is analyzing ${symbol} on ${tf} using structure, liquidity, displacement, FVG, order block and candlestick price action.`
    );
  }

  return (
    `Live ${symbol} ${tf} analysis is active. ` +
    `Ask me about the signal, entry, SL, TP, structure, liquidity, candle confirmation, RR or why the setup is waiting.`
  );
}


/* ============================================================
   PRICE FORMAT
   ============================================================ */

function formatPrice(
  price
) {
  const n =
    Number(price);

  if (!Number.isFinite(n)) {
    return "--";
  }

  if (
    Math.abs(n) >= 1000
  ) {
    return n.toFixed(2);
  }

  if (
    Math.abs(n) >= 100
  ) {
    return n.toFixed(2);
  }

  if (
    Math.abs(n) >= 10
  ) {
    return n.toFixed(3);
  }

  return n.toFixed(5);
}


/* ============================================================
   PERIODIC INVALIDATION CHECK
   ============================================================ */

setInterval(() => {
  checkSignalInvalidation();
}, 1000);


/* ============================================================
   CLEAN OLD REQUESTS
   ============================================================ */

setInterval(() => {
  const expiry =
    30000;

  const current =
    now();

  state.pendingHistory.forEach(
    (pending, reqId) => {
      if (
        current -
          pending.createdAt >
        expiry
      ) {
        state.pendingHistory.delete(
          reqId
        );

        state.historyRequests.delete(
          reqId
        );

        pending.reject(
          new Error(
            "Deriv history request timed out."
          )
        );
      }
    }
  );
}, 10000);


/* ============================================================
   GLOBAL API
   ============================================================ */

window.SuccessfulPrecisionAI = {
  state,

  CONFIG,

  connectDeriv,

  selectTimeframe,

  runPrecisionAnalysis,

  loadTimeframeHistory,

  getClosedCandles,

  analyzeTimeframe,

  buildTopDownAnalysis,

  generatePrecisionSignal,

  askSuccessfulAI
};


/* ============================================================
   GLOBAL VARIABLES FOR EXISTING UI / QUESTION BAR
   ============================================================ */

window.lastAnalysis = null;
window.currentAnalysis = null;
window.currentSymbol = "";
window.currentPrice = null;
window.currentTimeframe =
  state.selectedTimeframe;
window.closedCandles = [];

window.askSuccessfulAI =
  askSuccessfulAI;


/* ============================================================
   INITIAL TIMEFRAME BUTTON STATE
   ============================================================ */

updateTimeframeButtons();
updateChosenPairDisplay();


/* ============================================================
   END
   ============================================================ */
