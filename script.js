/* ============================================================
   SUCCESSFUL PINE SCRIPT
   PRECISION SIGNAL ENGINE
   GitHub + Vercel Ready

   LIVE PUBLIC DERIV DATA
   CLOSED-CANDLE / NON-REPAINTING ANALYSIS

   DYNAMIC TIMEFRAME ENGINE
   ------------------------------------------------------------
   The user's selected timeframe is ALWAYS the primary
   analysis timeframe.

   M1  -> M1 analysis
   M5  -> M5 analysis
   M15 -> M15 analysis
   M30 -> M30 analysis
   H1  -> H1 analysis
   H2  -> H2 analysis
   H4  -> H4 analysis
   Daily -> Daily analysis

   Higher timeframes are used only as context.
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
  },

  TOP_DOWN: [
    "Daily",
    "H4",
    "H2",
    "H1",
    "M30",
    "M15",
    "M5",
    "M1"
  ]
};


/* ============================================================
   GLOBAL STATE
   ============================================================ */

const state = {
  ws: null,

  connected: false,

  reconnectTimer: null,
  reconnectDelay: CONFIG.RECONNECT_MIN,

  symbols: [],
  selectedSymbol: "",

  selectedTimeframe: "M5",
  requestedTimeframe: "M5",

  livePrice: null,

  /*
   * IMPORTANT:
   * Candles are stored separately for every symbol AND TF.
   *
   * state.candles[symbol][timeframe]
   */
  candles: {},

  ticks: {},

  /*
   * Request tracking prevents an H1 response from being
   * accidentally interpreted as M5.
   */
  historyRequests: new Map(),

  pendingHistory: new Map(),

  analysis: null,

  lastSignal: null,
  lastSignalKey: "",

  signalHistory: [],

  notifiedSignals: new Map(),

  analysisTimer: null,

  analysisRunning: false,

  alertsEnabled: true,

  userInteracted: false,

  activeSetup: null
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

function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value == null ? "" : String(value);
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 5) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;

  const factor = Math.pow(10, decimals);

  return Math.round(n * factor) / factor;
}


/* ============================================================
   TIMEFRAME ENGINE
   ============================================================ */

function getSelectedTimeframe() {
  let tf =
    state.requestedTimeframe ||
    state.selectedTimeframe ||
    null;

  /*
   * Try UI controls as fallback.
   */

  if (!tf) {
    const active = document.querySelector(
      "[data-timeframe].active"
    );

    if (active) {
      tf = active.dataset.timeframe;
    }
  }

  if (!tf) {
    const select =
      $("#timeframe") ||
      $("#timeframeSelect") ||
      $("#timeframe-selector");

    if (select) {
      tf = select.value;
    }
  }

  tf = String(tf || "M5").trim();

  if (!CONFIG.TIMEFRAMES[tf]) {
    console.warn(
      `Invalid timeframe "${tf}". Falling back to M5.`
    );

    tf = "M5";
  }

  return tf;
}


function setSelectedTimeframe(tf) {
  tf = String(tf || "").trim();

  if (!CONFIG.TIMEFRAMES[tf]) {
    console.warn(`Unsupported timeframe: ${tf}`);
    return false;
  }

  state.selectedTimeframe = tf;
  state.requestedTimeframe = tf;

  /*
   * Keep UI controls synchronized.
   */

  $all("[data-timeframe]").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.timeframe === tf
    );
  });

  const select =
    $("#timeframe") ||
    $("#timeframeSelect") ||
    $("#timeframe-selector");

  if (select) {
    select.value = tf;
  }

  updateTimeframeDisplay(tf);

  return true;
}


function updateTimeframeDisplay(tf) {
  setText("#selectedTimeframe", tf);
  setText("#analysisTimeframe", tf);
  setText("#signalTimeframe", tf);
}


/* ============================================================
   INITIALIZATION
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  initializeExistingUI();

  createQuestionBar();

  createAlertControl();

  connectDeriv();

  /*
   * Analyze periodically using the CURRENT selected timeframe.
   */
  state.analysisTimer = setInterval(() => {
    runPrecisionAnalysis(false);
  }, CONFIG.ANALYSIS_INTERVAL);
});


function initializeExistingUI() {
  updateTimeframeDisplay(getSelectedTimeframe());

  /*
   * Market selector
   */
  const market = $("#market");

  if (market) {
    market.addEventListener("change", async event => {
      const symbol = event.target.value;

      if (!symbol) return;

      state.selectedSymbol = symbol;
      state.userInteracted = true;

      ensureSymbolStorage(symbol);

      subscribeToSymbol(symbol);

      const tf = getSelectedTimeframe();

      await loadRequiredTimeframes(symbol, tf);

      await runPrecisionAnalysis(true);
    });
  }


  /*
   * Timeframe buttons
   */
  $all("[data-timeframe]").forEach(button => {
    button.addEventListener("click", async () => {
      const tf = button.dataset.timeframe;

      if (!setSelectedTimeframe(tf)) return;

      state.userInteracted = true;

      if (!state.selectedSymbol) return;

      /*
       * Fetch the ACTUAL selected timeframe.
       */
      await ensureTimeframeData(
        state.selectedSymbol,
        tf,
        true
      );

      await runPrecisionAnalysis(true);
    });
  });


  /*
   * Analyze button
   */
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
   DERIV CONNECTION
   ============================================================ */

function connectDeriv() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch (_) {}
  }

  updateConnectionUI("Connecting to Deriv...", false);

  const ws = new WebSocket(CONFIG.DERIV_WS);

  state.ws = ws;

  ws.addEventListener("open", async () => {
    state.connected = true;

    state.reconnectDelay = CONFIG.RECONNECT_MIN;

    updateConnectionUI("LIVE", true);

    requestActiveSymbols();
  });


  ws.addEventListener("message", event => {
    try {
      const data = JSON.parse(event.data);

      handleDerivMessage(data);
    } catch (error) {
      console.error(
        "Deriv message parse error:",
        error
      );
    }
  });


  ws.addEventListener("error", error => {
    console.error("Deriv WebSocket error:", error);

    updateConnectionUI(
      "Connection error",
      false
    );
  });


  ws.addEventListener("close", () => {
    state.connected = false;

    updateConnectionUI(
      "Reconnecting...",
      false
    );

    scheduleReconnect();
  });
}


function scheduleReconnect() {
  if (state.reconnectTimer) return;

  const delay = state.reconnectDelay;

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;

    connectDeriv();

    state.reconnectDelay = Math.min(
      state.reconnectDelay * 2,
      CONFIG.RECONNECT_MAX
    );
  }, delay);
}


function sendDeriv(payload) {
  if (
    !state.ws ||
    state.ws.readyState !== WebSocket.OPEN
  ) {
    return false;
  }

  state.ws.send(JSON.stringify(payload));

  return true;
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


function handleDerivMessage(data) {
  if (data.error) {
    console.error(
      "Deriv API error:",
      data.error
    );
  }


  /*
   * Active symbols
   */
  if (Array.isArray(data.active_symbols)) {
    handleActiveSymbols(
      data.active_symbols
    );

    return;
  }


  /*
   * Tick
   */
  if (data.tick) {
    handleTick(data.tick);
  }


  /*
   * Historical candles
   */
  if (Array.isArray(data.candles)) {
    handleHistoricalCandles(
      data.candles,
      data.req_id
    );
  }
}


/* ============================================================
   ACTIVE SYMBOL NORMALIZATION
   ============================================================ */

function normalizeSymbol(raw) {
  if (!raw) return null;

  return {
    symbol:
      raw.underlying_symbol ||
      raw.symbol ||
      "",

    displayName:
      raw.underlying_symbol_name ||
      raw.display_name ||
      raw.symbol ||
      "",

    type:
      raw.underlying_symbol_type ||
      raw.symbol_type ||
      "unknown"
  };
}


function handleActiveSymbols(rawSymbols) {
  const normalized = rawSymbols
    .map(normalizeSymbol)
    .filter(item => item.symbol);

  state.symbols = normalized;

  populateMarketSelector(normalized);

  if (!state.selectedSymbol && normalized.length) {
    state.selectedSymbol =
      normalized[0].symbol;

    const market = $("#market");

    if (market) {
      market.value = state.selectedSymbol;
    }

    ensureSymbolStorage(
      state.selectedSymbol
    );

    subscribeToSymbol(
      state.selectedSymbol
    );

    loadRequiredTimeframes(
      state.selectedSymbol,
      getSelectedTimeframe()
    ).then(() => {
      runPrecisionAnalysis(true);
    });
  }
}


/* ============================================================
   MARKET SELECTOR
   ============================================================ */

function populateMarketSelector(symbols) {
  const select = $("#market");

  if (!select) return;

  const previous =
    state.selectedSymbol ||
    select.value;

  select.innerHTML = "";

  const grouped = {};

  symbols.forEach(item => {
    const type =
      item.type || "Other";

    if (!grouped[type]) {
      grouped[type] = [];
    }

    grouped[type].push(item);
  });


  Object.keys(grouped)
    .sort()
    .forEach(type => {
      const group =
        document.createElement("optgroup");

      group.label = formatCategory(type);

      grouped[type]
        .sort((a, b) =>
          a.displayName.localeCompare(
            b.displayName
          )
        )
        .forEach(item => {
          const option =
            document.createElement("option");

          option.value = item.symbol;

          option.textContent =
            item.displayName ||
            item.symbol;

          group.appendChild(option);
        });

      select.appendChild(group);
    });


  if (
    previous &&
    symbols.some(x => x.symbol === previous)
  ) {
    select.value = previous;
  } else if (symbols.length) {
    select.value = symbols[0].symbol;
  }
}


function formatCategory(value) {
  return String(value || "Other")
    .replace(/_/g, " ")
    .replace(/\b\w/g, c =>
      c.toUpperCase()
    );
}


/* ============================================================
   SYMBOL STORAGE
   ============================================================ */

function ensureSymbolStorage(symbol) {
  if (!symbol) return;

  if (!state.candles[symbol]) {
    state.candles[symbol] = {};
  }

  if (!state.ticks[symbol]) {
    state.ticks[symbol] = [];
  }
}


/* ============================================================
   TICK SUBSCRIPTION
   ============================================================ */

function subscribeToSymbol(symbol) {
  if (!symbol) return;

  ensureSymbolStorage(symbol);

  /*
   * Clear previous tick subscription.
   */
  sendDeriv({
    forget_all: "ticks"
  });

  sendDeriv({
    ticks: symbol,
    subscribe: 1
  });
}


function handleTick(tick) {
  const symbol = tick.symbol;

  if (!symbol) return;

  const price = safeNumber(tick.quote);

  if (price == null) return;

  state.livePrice = price;

  ensureSymbolStorage(symbol);

  state.ticks[symbol].push({
    time:
      Number(tick.epoch) ||
      Math.floor(Date.now() / 1000),

    quote: price
  });


  /*
   * Keep memory controlled.
   */
  if (state.ticks[symbol].length > 2000) {
    state.ticks[symbol].splice(
      0,
      state.ticks[symbol].length - 2000
    );
  }


  if (symbol === state.selectedSymbol) {
    updatePriceUI(price);
  }
}


/* ============================================================
   TIMEFRAME HISTORY REQUEST
   ============================================================ */

async function loadTimeframeHistory(
  symbol,
  timeframe,
  force = false
) {
  if (!symbol) return [];

  if (!CONFIG.TIMEFRAMES[timeframe]) {
    throw new Error(
      `Invalid timeframe: ${timeframe}`
    );
  }

  ensureSymbolStorage(symbol);

  /*
   * Don't unnecessarily reload existing data.
   */
  if (
    !force &&
    state.candles[symbol][timeframe] &&
    state.candles[symbol][timeframe].length >= 50
  ) {
    return state.candles[symbol][timeframe];
  }


  if (!state.connected) {
    throw new Error(
      "Deriv WebSocket is not connected."
    );
  }


  /*
   * Unique request ID.
   *
   * This is the critical fix for dynamic TF requests.
   */
  const reqId =
    Date.now() +
    Math.floor(Math.random() * 100000);


  const granularity =
    CONFIG.TIMEFRAMES[timeframe];


  const promise = new Promise(
    (resolve, reject) => {
      state.pendingHistory.set(
        reqId,
        {
          resolve,
          reject
        }
      );

      state.historyRequests.set(
        reqId,
        {
          symbol,
          timeframe,
          granularity
        }
      );


      const sent = sendDeriv({
        ticks_history: symbol,

        style: "candles",

        granularity,

        count: CONFIG.HISTORY_COUNT,

        end: "latest",

        req_id: reqId
      });


      if (!sent) {
        state.pendingHistory.delete(
          reqId
        );

        state.historyRequests.delete(
          reqId
        );

        reject(
          new Error(
            "Deriv WebSocket unavailable."
          )
        );
      }
    }
  );


  /*
   * Prevent a permanently pending request.
   */
  const timeout = new Promise(
    (_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Timeout loading ${timeframe} data`
          )
        );
      }, 15000);
    }
  );


  try {
    return await Promise.race([
      promise,
      timeout
    ]);
  } catch (error) {
    state.pendingHistory.delete(reqId);
    state.historyRequests.delete(reqId);

    throw error;
  }
}


/* ============================================================
   LOAD REQUIRED TIMEFRAMES
   ============================================================ */

async function loadRequiredTimeframes(
  symbol,
  selectedTF
) {
  if (!symbol) return;

  selectedTF =
    selectedTF || getSelectedTimeframe();

  /*
   * Primary selected TF MUST be included.
   */

  const required = new Set([
    selectedTF
  ]);


  /*
   * Top-down context.
   *
   * These do not replace the selected timeframe.
   */
  CONFIG.TOP_DOWN.forEach(tf => {
    required.add(tf);
  });


  /*
   * Do not request unsupported duplicates.
   */

  const timeframes =
    Array.from(required)
      .filter(tf =>
        CONFIG.TIMEFRAMES[tf]
      );


  setAnalysisStatus(
    `Loading ${selectedTF} + market context...`
  );


  /*
   * Load in parallel.
   */
  await Promise.allSettled(
    timeframes.map(tf =>
      ensureTimeframeData(
        symbol,
        tf,
        false
      )
    )
  );


  return timeframes;
}


/* ============================================================
   ENSURE TIMEFRAME DATA
   ============================================================ */

async function ensureTimeframeData(
  symbol,
  timeframe,
  force = false
) {
  ensureSymbolStorage(symbol);

  const existing =
    state.candles[symbol][timeframe];


  if (
    !force &&
    Array.isArray(existing) &&
    existing.length >= 50
  ) {
    return existing;
  }


  try {
    return await loadTimeframeHistory(
      symbol,
      timeframe,
      force
    );
  } catch (error) {
    console.error(
      `Failed to load ${timeframe}:`,
      error
    );

    return [];
  }
}


/* ============================================================
   HANDLE HISTORICAL CANDLES
   ============================================================ */

function handleHistoricalCandles(
  rawCandles,
  reqId
) {
  if (!Array.isArray(rawCandles)) {
    return;
  }


  const request =
    state.historyRequests.get(reqId);


  /*
   * If request metadata exists, use it.
   *
   * NEVER infer timeframe from the currently selected UI.
   */
  if (!request) {
    console.warn(
      "Received candle response without request metadata:",
      reqId
    );

    return;
  }


  const {
    symbol,
    timeframe
  } = request;


  ensureSymbolStorage(symbol);


  const candles = rawCandles
    .map(normalizeCandle)
    .filter(Boolean)
    .sort(
      (a, b) => a.time - b.time
    );


  state.candles[symbol][timeframe] =
    candles;


  /*
   * Resolve waiting Promise.
   */

  const pending =
    state.pendingHistory.get(reqId);


  if (pending) {
    pending.resolve(candles);

    state.pendingHistory.delete(reqId);
  }


  state.historyRequests.delete(reqId);


  /*
   * Keep selected timeframe exposed globally.
   */
  if (
    symbol === state.selectedSymbol &&
    timeframe === getSelectedTimeframe()
  ) {
    window.closedCandles =
      getClosedCandles(
        symbol,
        timeframe
      );
  }
}


function normalizeCandle(candle) {
  if (!candle) return null;

  const time =
    Number(candle.epoch ?? candle.time);

  const open =
    safeNumber(candle.open);

  const high =
    safeNumber(candle.high);

  const low =
    safeNumber(candle.low);

  const close =
    safeNumber(candle.close);

  if (
    !Number.isFinite(time) ||
    open == null ||
    high == null ||
    low == null ||
    close == null
  ) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close
  };
}


/* ============================================================
   CLOSED CANDLES
   ============================================================ */

function getClosedCandles(
  symbol,
  timeframe
) {
  if (!symbol) return [];

  ensureSymbolStorage(symbol);

  const candles =
    state.candles[symbol][timeframe] ||
    [];


  if (!candles.length) {
    return [];
  }


  const tfSeconds =
    CONFIG.TIMEFRAMES[timeframe];


  const now =
    Math.floor(Date.now() / 1000);


  /*
   * Remove current open candle.
   *
   * This keeps analysis closed-candle based.
   */
  return candles.filter(candle => {
    const start =
      Math.floor(
        candle.time / tfSeconds
      ) * tfSeconds;

    return (
      start + tfSeconds <= now
    );
  });
}


/* ============================================================
   SWING DETECTION
   ============================================================ */

function detectSwings(candles) {
  const swings = [];

  if (!Array.isArray(candles)) {
    return swings;
  }

  if (candles.length < 10) {
    return swings;
  }


  const depth =
    Math.min(
      CONFIG.DEPTH,
      Math.floor(
        candles.length / 4
      )
    );


  const deviation =
    getDeviation(candles);


  const step =
    Math.max(
      2,
      Math.floor(
        CONFIG.BACKSTEP / 2
      )
    );


  for (
    let i = depth;
    i < candles.length - depth;
    i += step
  ) {
    const current =
      candles[i];


    let isHigh = true;
    let isLow = true;


    for (
      let j = i - depth;
      j <= i + depth;
      j++
    ) {
      if (j === i) continue;

      if (
        candles[j].high >=
        current.high
      ) {
        isHigh = false;
      }

      if (
        candles[j].low <=
        current.low
      ) {
        isLow = false;
      }

      if (
        !isHigh &&
        !isLow
      ) {
        break;
      }
    }


    if (
      isHigh &&
      current.high - current.low >=
        deviation
    ) {
      swings.push({
        type: "HIGH",
        price: current.high,
        time: current.time,
        index: i
      });
    }


    if (
      isLow &&
      current.high - current.low >=
        deviation
    ) {
      swings.push({
        type: "LOW",
        price: current.low,
        time: current.time,
        index: i
      });
    }
  }


  return swings
    .sort((a, b) =>
      a.time - b.time
    )
    .slice(-100);
}


/* ============================================================
   VOLATILITY / DEVIATION
   ============================================================ */

function getAverageRange(
  candles,
  count = 50
) {
  if (!candles.length) return 0;

  const sample =
    candles.slice(-count);

  const total =
    sample.reduce(
      (sum, c) =>
        sum + Math.abs(
          c.high - c.low
        ),
      0
    );

  return total / sample.length;
}


function getDeviation(candles) {
  const avg =
    getAverageRange(
      candles,
      50
    );

  return avg *
    (CONFIG.DEVIATION / 5);
}


/* ============================================================
   MARKET STRUCTURE
   ============================================================ */

function classifyStructure(
  swings
) {
  const highs =
    swings.filter(
      s => s.type === "HIGH"
    );

  const lows =
    swings.filter(
      s => s.type === "LOW"
    );


  let highLabels = [];
  let lowLabels = [];


  for (
    let i = 1;
    i < highs.length;
    i++
  ) {
    highLabels.push(
      highs[i].price >
      highs[i - 1].price
        ? "HH"
        : "LH"
    );
  }


  for (
    let i = 1;
    i < lows.length;
    i++
  ) {
    lowLabels.push(
      lows[i].price >
      lows[i - 1].price
        ? "HL"
        : "LL"
    );
  }


  const recentHighs =
    highLabels.slice(-3);

  const recentLows =
    lowLabels.slice(-3);


  const bullish =
    recentHighs.includes("HH") &&
    recentLows.includes("HL");


  const bearish =
    recentHighs.includes("LH") &&
    recentLows.includes("LL");


  let bias = "NEUTRAL";

  if (bullish && !bearish) {
    bias = "BULLISH";
  } else if (
    bearish &&
    !bullish
  ) {
    bias = "BEARISH";
  }


  return {
    bias,

    highs,

    lows,

    highLabels,

    lowLabels,

    latestHigh:
      highs[highs.length - 1] ||
      null,

    previousHigh:
      highs[highs.length - 2] ||
      null,

    latestLow:
      lows[lows.length - 1] ||
      null,

    previousLow:
      lows[lows.length - 2] ||
      null
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
      choch: null,
      direction: null
    };
  }


  const last =
    candles[candles.length - 1];


  let bos = null;
  let choch = null;
  let direction = null;


  const previousHigh =
    structure.previousHigh ||
    structure.latestHigh;


  const previousLow =
    structure.previousLow ||
    structure.latestLow;


  if (
    previousHigh &&
    last.close >
      previousHigh.price
  ) {
    direction = "BULLISH";

    bos = {
      type: "BOS",
      direction: "BULLISH",
      level: previousHigh.price
    };

    if (
      structure.bias === "BEARISH"
    ) {
      choch = {
        type: "CHoCH",
        direction: "BULLISH"
      };
    }
  }


  if (
    previousLow &&
    last.close <
      previousLow.price
  ) {
    direction = "BEARISH";

    bos = {
      type: "BOS",
      direction: "BEARISH",
      level: previousLow.price
    };

    if (
      structure.bias === "BULLISH"
    ) {
      choch = {
        type: "CHoCH",
        direction: "BEARISH"
      };
    }
  }


  return {
    bos,
    choch,
    direction
  };
}


/* ============================================================
   LIQUIDITY
   ============================================================ */

function detectLiquidity(
  candles,
  structure
) {
  if (
    candles.length < 2
  ) {
    return {
      swept: false,
      direction: null,
      level: null
    };
  }


  const last =
    candles[candles.length - 1];


  const previous =
    candles
      .slice(
        Math.max(
          0,
          candles.length - 20
        ),
        -1
      );


  const highs =
    previous.map(
      c => c.high
    );

  const lows =
    previous.map(
      c => c.low
    );


  const liquidityHigh =
    Math.max(
      ...highs
    );


  const liquidityLow =
    Math.min(
      ...lows
    );


  /*
   * Buy-side liquidity swept:
   * price trades above high and closes back below.
   */
  if (
    last.high >
      liquidityHigh &&
    last.close <
      liquidityHigh
  ) {
    return {
      swept: true,
      direction: "BEARISH",
      type: "BUY-SIDE SWEEP",
      level: liquidityHigh
    };
  }


  /*
   * Sell-side liquidity swept:
   * price trades below low and closes back above.
   */
  if (
    last.low <
      liquidityLow &&
    last.close >
      liquidityLow
  ) {
    return {
      swept: true,
      direction: "BULLISH",
      type: "SELL-SIDE SWEEP",
      level: liquidityLow
    };
  }


  return {
    swept: false,
    direction: null,
    type: null,
    level: null
  };
}


/* ============================================================
   SUPPORT / RESISTANCE
   ============================================================ */

function detectSupportResistance(
  candles,
  swings
) {
  if (!candles.length) {
    return {
      support: null,
      resistance: null
    };
  }


  const lows =
    swings
      .filter(
        s => s.type === "LOW"
      )
      .slice(-5);


  const highs =
    swings
      .filter(
        s => s.type === "HIGH"
      )
      .slice(-5);


  const support =
    lows.length
      ? Math.min(
          ...lows.map(
            s => s.price
          )
        )
      : null;


  const resistance =
    highs.length
      ? Math.max(
          ...highs.map(
            s => s.price
          )
        )
      : null;


  return {
    support,
    resistance
  };
}


/* ============================================================
   SUPPLY / DEMAND
   ============================================================ */

function detectSupplyDemand(
  candles
) {
  if (
    candles.length < 10
  ) {
    return {
      demand: null,
      supply: null
    };
  }


  const avgRange =
    getAverageRange(
      candles,
      30
    );


  const recent =
    candles.slice(-10);


  let demand = null;
  let supply = null;


  for (
    let i = recent.length - 2;
    i >= 0;
    i--
  ) {
    const base =
      recent[i];


    const move =
      recent
        .slice(i + 1)
        .reduce(
          (sum, c) =>
            sum +
            Math.abs(
              c.close -
              c.open
            ),
          0
        );


    if (
      !demand &&
      move >
        avgRange * 1.5 &&
      base.close <
        base.open
    ) {
      demand = {
        low: base.low,
        high: base.high,
        index: i
      };
    }


    if (
      !supply &&
      move >
        avgRange * 1.5 &&
      base.close >
        base.open
    ) {
      supply = {
        low: base.low,
        high: base.high,
        index: i
      };
    }
  }


  return {
    demand,
    supply
  };
}


/* ============================================================
   ORDER BLOCK
   ============================================================ */

function detectOrderBlock(
  candles,
  displacement
) {
  if (
    candles.length < 5
  ) {
    return null;
  }


  const last =
    candles[
      candles.length - 1
    ];


  const range =
    last.high - last.low;


  if (
    !displacement
  ) {
    return null;
  }


  /*
   * Search backward for the opposite candle
   * before displacement.
   */
  for (
    let i =
      candles.length - 2;
    i >=
      Math.max(
        0,
        candles.length - 8
      );
    i--
  ) {
    const candle =
      candles[i];


    if (
      displacement.direction ===
      "BULLISH" &&
      candle.close <
        candle.open
    ) {
      return {
        direction: "BULLISH",
        high: candle.high,
        low: candle.low,
        midpoint:
          (candle.high +
            candle.low) /
          2
      };
    }


    if (
      displacement.direction ===
      "BEARISH" &&
      candle.close >
        candle.open
    ) {
      return {
        direction: "BEARISH",
        high: candle.high,
        low: candle.low,
        midpoint:
          (candle.high +
            candle.low) /
          2
      };
    }
  }


  return null;
}


/* ============================================================
   FAIR VALUE GAP
   ============================================================ */

function detectFVG(
  candles
) {
  if (
    candles.length < 3
  ) {
    return null;
  }


  const a =
    candles[
      candles.length - 3
    ];

  const b =
    candles[
      candles.length - 2
    ];

  const c =
    candles[
      candles.length - 1
    ];


  /*
   * Bullish FVG
   */
  if (
    c.low > a.high &&
    b.close > b.open
  ) {
    return {
      direction: "BULLISH",
      low: a.high,
      high: c.low,
      midpoint:
        (a.high + c.low) /
        2
    };
  }


  /*
   * Bearish FVG
   */
  if (
    c.high < a.low &&
    b.close < b.open
  ) {
    return {
      direction: "BEARISH",
      low: c.high,
      high: a.low,
      midpoint:
        (c.high + a.low) /
        2
    };
  }


  return null;
}


/* ============================================================
   DISPLACEMENT
   ============================================================ */

function detectDisplacement(
  candles
) {
  if (
    candles.length < 10
  ) {
    return null;
  }


  const last =
    candles[
      candles.length - 1
    ];


  const avg =
    getAverageRange(
      candles.slice(0, -1),
      20
    );


  const range =
    last.high -
    last.low;


  if (
    range <
    avg * 1.5
  ) {
    return null;
  }


  if (
    last.close >
    last.open
  ) {
    return {
      direction: "BULLISH",
      strength:
        range / avg
    };
  }


  if (
    last.close <
    last.open
  ) {
    return {
      direction: "BEARISH",
      strength:
        range / avg
    };
  }


  return null;
}


/* ============================================================
   CANDLESTICK CONFIRMATION
   ============================================================ */

function detectCandlestickConfirmation(
  candles
) {
  if (
    candles.length < 2
  ) {
    return {
      confirmed: false,
      pattern: null,
      direction: null
    };
  }


  const c =
    candles[
      candles.length - 1
    ];

  const p =
    candles[
      candles.length - 2
    ];


  const body =
    Math.abs(
      c.close - c.open
    );


  const upperWick =
    c.high -
    Math.max(
      c.open,
      c.close
    );


  const lowerWick =
    Math.min(
      c.open,
      c.close
    ) -
    c.low;


  const range =
    c.high - c.low;


  if (!range) {
    return {
      confirmed: false,
      pattern: null,
      direction: null
    };
  }


  /*
   * Bullish rejection
   */
  if (
    lowerWick >
      body * 1.5 &&
    c.close >
      c.open
  ) {
    return {
      confirmed: true,
      pattern:
        "Bullish Rejection",
      direction: "BULLISH"
    };
  }


  /*
   * Bearish rejection
   */
  if (
    upperWick >
      body * 1.5 &&
    c.close <
      c.open
  ) {
    return {
      confirmed: true,
      pattern:
        "Bearish Rejection",
      direction: "BEARISH"
    };
  }


  /*
   * Bullish engulfing
   */
  if (
    p.close < p.open &&
    c.close > c.open &&
    c.open <= p.close &&
    c.close >= p.open
  ) {
    return {
      confirmed: true,
      pattern:
        "Bullish Engulfing",
      direction: "BULLISH"
    };
  }


  /*
   * Bearish engulfing
   */
  if (
    p.close > p.open &&
    c.close < c.open &&
    c.open >= p.close &&
    c.close <= p.open
  ) {
    return {
      confirmed: true,
      pattern:
        "Bearish Engulfing",
      direction: "BEARISH"
    };
  }


  /*
   * Strong bullish close
   */
  if (
    c.close >
      c.open &&
    (c.close - c.low) /
      range >
      0.75
  ) {
    return {
      confirmed: true,
      pattern:
        "Strong Bullish Close",
      direction: "BULLISH"
    };
  }


  /*
   * Strong bearish close
   */
  if (
    c.close <
      c.open &&
    (c.high - c.close) /
      range >
      0.75
  ) {
    return {
      confirmed: true,
      pattern:
        "Strong Bearish Close",
      direction: "BEARISH"
    };
  }


  return {
    confirmed: false,
    pattern: null,
    direction: null
  };
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


  if (
    candles.length < 30
  ) {
    return {
      symbol,
      timeframe,
      ready: false,
      reason:
        `Not enough ${timeframe} closed candles.`,
      candles
    };
  }


  const swings =
    detectSwings(candles);


  const structure =
    classifyStructure(
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


  const displacement =
    detectDisplacement(
      candles
    );


  const fvg =
    detectFVG(candles);


  const orderBlock =
    detectOrderBlock(
      candles,
      displacement
    );


  const supplyDemand =
    detectSupplyDemand(
      candles
    );


  const candle =
    detectCandlestickConfirmation(
      candles
    );


  const last =
    candles[
      candles.length - 1
    ];


  return {
    symbol,

    timeframe,

    ready: true,

    candles,

    currentPrice: last.close,

    swings,

    structure,

    events,

    liquidity,

    supportResistance: sr,

    displacement,

    fvg,

    orderBlock,

    supplyDemand,

    candleConfirmation: candle
  };
}


/* ============================================================
   TOP-DOWN ANALYSIS
   ============================================================ */

function buildTopDownAnalysis(
  symbol,
  selectedTimeframe
) {
  selectedTimeframe =
    selectedTimeframe ||
    getSelectedTimeframe();


  /*
   * IMPORTANT:
   * Selected TF is explicitly marked PRIMARY.
   */

  const timeframes =
    Array.from(
      new Set([
        ...CONFIG.TOP_DOWN,
        selectedTimeframe
      ])
    );


  const result = {};


  timeframes.forEach(tf => {
    result[tf] =
      analyzeTimeframe(
        symbol,
        tf
      );
  });


  return {
    symbol,

    selectedTimeframe,

    primary:
      result[selectedTimeframe],

    timeframes: result,

    htfBias:
      getHTFBias(result)
  };
}


/* ============================================================
   HTF BIAS
   ============================================================ */

function getHTFBias(
  analyses
) {
  const priority = [
    "Daily",
    "H4",
    "H2",
    "H1"
  ];


  let bullish = 0;
  let bearish = 0;


  priority.forEach(tf => {
    const analysis =
      analyses[tf];


    if (
      !analysis ||
      !analysis.ready
    ) {
      return;
    }


    if (
      analysis.structure.bias ===
      "BULLISH"
    ) {
      bullish++;
    }


    if (
      analysis.structure.bias ===
      "BEARISH"
    ) {
      bearish++;
    }
  });


  if (
    bullish > bearish
  ) {
    return "BULLISH";
  }


  if (
    bearish > bullish
  ) {
    return "BEARISH";
  }


  return "NEUTRAL";
}


/* ============================================================
   DIRECTION
   ============================================================ */

function determineDirection(
  primary,
  htfBias
) {
  if (!primary) {
    return null;
  }


  const votes = {
    BULLISH: 0,
    BEARISH: 0
  };


  if (
    primary.structure.bias ===
    "BULLISH"
  ) {
    votes.BULLISH++;
  }


  if (
    primary.structure.bias ===
    "BEARISH"
  ) {
    votes.BEARISH++;
  }


  if (
    primary.events.direction ===
    "BULLISH"
  ) {
    votes.BULLISH += 2;
  }


  if (
    primary.events.direction ===
    "BEARISH"
  ) {
    votes.BEARISH += 2;
  }


  if (
    primary.liquidity.direction ===
    "BULLISH"
  ) {
    votes.BULLISH += 2;
  }


  if (
    primary.liquidity.direction ===
    "BEARISH"
  ) {
    votes.BEARISH += 2;
  }


  if (
    primary.displacement?.direction ===
    "BULLISH"
  ) {
    votes.BULLISH++;
  }


  if (
    primary.displacement?.direction ===
    "BEARISH"
  ) {
    votes.BEARISH++;
  }


  if (
    primary.candleConfirmation?.direction ===
    "BULLISH"
  ) {
    votes.BULLISH++;
  }


  if (
    primary.candleConfirmation?.direction ===
    "BEARISH"
  ) {
    votes.BEARISH++;
  }


  /*
   * HTF context is supportive, not an automatic trigger.
   */
  if (htfBias === "BULLISH") {
    votes.BULLISH++;
  }


  if (htfBias === "BEARISH") {
    votes.BEARISH++;
  }


  if (
    votes.BULLISH ===
    votes.BEARISH
  ) {
    return null;
  }


  return votes.BULLISH >
    votes.BEARISH
    ? "BULLISH"
    : "BEARISH";
}


/* ============================================================
   EVIDENCE SCORE
   ============================================================ */

function scoreEvidence(
  primary,
  direction
) {
  if (!primary || !direction) {
    return {
      score: 0,
      confirmations: 0,
      reasons: []
    };
  }


  let score = 0;

  let confirmations = 0;

  const reasons = [];


  if (
    primary.structure.bias ===
    direction
  ) {
    score += 2;
    confirmations++;

    reasons.push(
      `${direction} market structure`
    );
  }


  if (
    primary.events.direction ===
    direction
  ) {
    score += 2;
    confirmations++;

    reasons.push(
      primary.events.choch
        ? "CHoCH confirmation"
        : "BOS confirmation"
    );
  }


  if (
    primary.liquidity.direction ===
    direction &&
    primary.liquidity.swept
  ) {
    score += 2;
    confirmations++;

    reasons.push(
      primary.liquidity.type
    );
  }


  if (
    primary.displacement?.direction ===
    direction
  ) {
    score += 2;
    confirmations++;

    reasons.push(
      "Displacement"
    );
  }


  if (
    primary.fvg?.direction ===
    direction
  ) {
    score += 1;
    confirmations++;

    reasons.push(
      "FVG"
    );
  }


  if (
    primary.orderBlock?.direction ===
    direction
  ) {
    score += 1;
    confirmations++;

    reasons.push(
      "Order Block"
    );
  }


  if (
    primary.candleConfirmation?.direction ===
    direction &&
    primary.candleConfirmation.confirmed
  ) {
    score += 2;
    confirmations++;

    reasons.push(
      primary.candleConfirmation.pattern
    );
  }


  const zone =
    direction === "BULLISH"
      ? primary.supplyDemand?.demand
      : primary.supplyDemand?.supply;


  if (zone) {
    score += 1;
    confirmations++;

    reasons.push(
      direction === "BULLISH"
        ? "Demand zone"
        : "Supply zone"
    );
  }


  return {
    score,
    confirmations,
    reasons
  };
}


/* ============================================================
   SETUP GRADE
   ============================================================ */

function gradeSetup(
  primary,
  direction,
  evidence
) {
  if (
    !primary ||
    !direction ||
    !evidence
  ) {
    return {
      grade: "NO SETUP",
      rank: 0
    };
  }


  const {
    score,
    confirmations
  } = evidence;


  const candleConfirmed =
    primary.candleConfirmation
      ?.confirmed &&
    primary.candleConfirmation
      ?.direction === direction;


  /*
   * A+
   */
  if (
    score >= 11 &&
    confirmations >= 6 &&
    candleConfirmed
  ) {
    return {
      grade: "A+",
      rank: 5
    };
  }


  /*
   * A
   */
  if (
    score >= 8 &&
    confirmations >= 5
  ) {
    return {
      grade: "A",
      rank: 4
    };
  }


  /*
   * B
   */
  if (
    score >= 6 &&
    confirmations >= 4
  ) {
    return {
      grade: "B",
      rank: 3
    };
  }


  /*
   * C
   */
  if (
    score >= 4 &&
    confirmations >= 3
  ) {
    return {
      grade: "C",
      rank: 2
    };
  }


  /*
   * EARLY SETUP
   *
   * Candlestick confirmation is NOT mandatory here.
   */
  const structuralTrigger =
    primary.events.direction ===
      direction ||
    (
      primary.liquidity.swept &&
      primary.liquidity.direction ===
        direction
    ) ||
    primary.displacement?.direction ===
      direction;


  if (
    score >= 3 &&
    structuralTrigger
  ) {
    return {
      grade: "EARLY SETUP",
      rank: 1
    };
  }


  return {
    grade: "NO SETUP",
    rank: 0
  };
}


/* ============================================================
   TRADE LEVELS
   ============================================================ */

function calculateTradeLevels(
  primary,
  direction
) {
  if (
    !primary ||
    !primary.candles?.length ||
    !direction
  ) {
    return null;
  }


  const candles =
    primary.candles;


  const current =
    candles[
      candles.length - 1
    ].close;


  const avgRange =
    getAverageRange(
      candles,
      20
    );


  let entry =
    current;


  let sl;


  if (
    direction ===
    "BULLISH"
  ) {
    const swingLow =
      primary.structure
        .latestLow?.price;


    const demandLow =
      primary.supplyDemand
        ?.demand?.low;


    const candidates =
      [
        swingLow,
        demandLow
      ].filter(
        Number.isFinite
      );


    const base =
      candidates.length
        ? Math.min(
            ...candidates
          )
        : current -
          avgRange;


    sl =
      base -
      avgRange * 0.15;


    if (
      sl >= entry
    ) {
      sl =
        entry -
        avgRange;
    }
  } else {
    const swingHigh =
      primary.structure
        .latestHigh?.price;


    const supplyHigh =
      primary.supplyDemand
        ?.supply?.high;


    const candidates =
      [
        swingHigh,
        supplyHigh
      ].filter(
        Number.isFinite
      );


    const base =
      candidates.length
        ? Math.max(
            ...candidates
          )
        : current +
          avgRange;


    sl =
      base +
      avgRange * 0.15;


    if (
      sl <= entry
    ) {
      sl =
        entry +
        avgRange;
    }
  }


  const risk =
    Math.abs(
      entry - sl
    );


  if (
    !risk ||
    !Number.isFinite(risk)
  ) {
    return null;
  }


  const tp1 =
    direction ===
    "BULLISH"
      ? entry + risk * 2
      : entry - risk * 2;


  const tp2 =
    direction ===
    "BULLISH"
      ? entry + risk * 3
      : entry - risk * 3;


  const be = entry;


  return {
    entry: round(entry),
    sl: round(sl),
    be: round(be),
    tp1: round(tp1),
    tp2: round(tp2),

    rrTP1: 2,

    rrTP2: 3,

    risk: round(risk)
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
  const primary =
    topDown.primary;


  if (
    !primary ||
    !primary.ready
  ) {
    return {
      signal: "WAIT",
      grade: "NO SETUP",
      timeframe,
      reason:
        `Waiting for ${timeframe} closed-candle data.`
    };
  }


  const direction =
    determineDirection(
      primary,
      topDown.htfBias
    );


  if (!direction) {
    return {
      signal: "WAIT",
      grade: "NO SETUP",
      timeframe,
      reason:
        `No clear ${timeframe} directional structure.`
    };
  }


  const evidence =
    scoreEvidence(
      primary,
      direction
    );


  const grade =
    gradeSetup(
      primary,
      direction,
      evidence
    );


  if (
    grade.rank === 0
  ) {
    return {
      signal: "WAIT",
      grade: "NO SETUP",
      timeframe,

      direction,

      score:
        evidence.score,

      confirmations:
        evidence.confirmations,

      reasons:
        evidence.reasons,

      reason:
        `No confirmed ${timeframe} setup.`
    };
  }


  const levels =
    calculateTradeLevels(
      primary,
      direction
    );


  return {
    signal:
      direction ===
      "BULLISH"
        ? "BUY"
        : "SELL",

    direction,

    grade:
      grade.grade,

    rank:
      grade.rank,

    timeframe,

    symbol,

    score:
      evidence.score,

    confirmations:
      evidence.confirmations,

    reasons:
      evidence.reasons,

    levels,

    htfBias:
      topDown.htfBias,

    structure:
      primary.structure,

    liquidity:
      primary.liquidity,

    events:
      primary.events,

    fvg:
      primary.fvg,

    orderBlock:
      primary.orderBlock,

    supplyDemand:
      primary.supplyDemand,

    candleConfirmation:
      primary.candleConfirmation,

    supportResistance:
      primary.supportResistance,

    currentPrice:
      primary.currentPrice
  };
}


/* ============================================================
   AI EXPLANATION
   ============================================================ */

function buildAIExplanation(
  signal
) {
  if (!signal) {
    return "No analysis available.";
  }


  if (
    signal.signal ===
    "WAIT"
  ) {
    return (
      `WAIT on ${signal.timeframe}. ` +
      `${signal.reason || "No confirmed setup."} ` +
      `The engine will continue monitoring live closed-candle data.`
    );
  }


  const directionText =
    signal.signal === "BUY"
      ? "bullish"
      : "bearish";


  let explanation =
    `${signal.signal} ${signal.grade} setup on ${signal.timeframe}. `;


  explanation +=
    `The primary ${signal.timeframe} structure is being used as the signal timeframe. `;


  if (
    signal.htfBias &&
    signal.htfBias !==
      "NEUTRAL"
  ) {
    explanation +=
      `Higher-timeframe context is ${signal.htfBias}. `;
  }


  if (
    signal.events?.bos
  ) {
    explanation +=
      `${signal.events.bos.type} supports the ${directionText} direction. `;
  }


  if (
    signal.liquidity?.swept
  ) {
    explanation +=
      `${signal.liquidity.type} has been detected. `;
  }


  if (
    signal.fvg
  ) {
    explanation +=
      `A ${signal.fvg.direction} FVG is present. `;
  }


  if (
    signal.orderBlock
  ) {
    explanation +=
      `A ${signal.orderBlock.direction} order block is present. `;
  }


  if (
    signal.candleConfirmation
      ?.confirmed
  ) {
    explanation +=
      `${signal.candleConfirmation.pattern} confirms price action. `;
  } else {
    explanation +=
      `Candlestick confirmation is not yet complete. `;
  }


  if (
    signal.levels
  ) {
    explanation +=
      `Entry ${signal.levels.entry}, ` +
      `SL ${signal.levels.sl}, ` +
      `TP1 ${signal.levels.tp1}, ` +
      `TP2 ${signal.levels.tp2}.`;
  }


  return explanation;
}


/* ============================================================
   MAIN ANALYSIS ENGINE
   ============================================================ */

async function runPrecisionAnalysis(
  manual = false
) {
  if (
    state.analysisRunning
  ) {
    return state.analysis;
  }


  const symbol =
    state.selectedSymbol ||
    $("#market")?.value;


  const timeframe =
    getSelectedTimeframe();


  if (!symbol) {
    setAnalysisStatus(
      "Select a market."
    );

    return null;
  }


  /*
   * CRITICAL:
   * Re-bind the state to the current UI selection
   * immediately before analysis.
   */
  state.selectedTimeframe =
    timeframe;

  state.requestedTimeframe =
    timeframe;


  state.analysisRunning = true;


  try {
    setAnalysisStatus(
      manual
        ? `Analyzing ${symbol} on ${timeframe}...`
        : `Monitoring ${symbol} on ${timeframe}...`
    );


    /*
     * Make absolutely sure the selected TF exists.
     */
    await ensureTimeframeData(
      symbol,
      timeframe,
      manual
    );


    /*
     * Load context timeframes too.
     */
    await loadRequiredTimeframes(
      symbol,
      timeframe
    );


    /*
     * Build analysis AFTER the requested TF data
     * has been stored under the correct timeframe.
     */
    const topDown =
      buildTopDownAnalysis(
        symbol,
        timeframe
      );


    const signal =
      generatePrecisionSignal(
        symbol,
        timeframe,
        topDown
      );


    signal.explanation =
      buildAIExplanation(
        signal
      );


    const analysis = {
      symbol,

      timeframe,

      timestamp:
        Date.now(),

      currentPrice:
        state.livePrice ??
        topDown.primary?.currentPrice,

      primaryTimeframe:
        timeframe,

      topDown,

      signal,

      marketInsight:
        buildMarketInsight(
          topDown,
          signal
        )
    };


    state.analysis =
      analysis;


    /*
     * Expose current state for the Question Bar.
     */
    window.lastAnalysis =
      analysis;

    window.currentAnalysis =
      analysis;

    window.currentSymbol =
      symbol;

    window.currentPrice =
      state.livePrice ??
      topDown.primary?.currentPrice;

    window.closedCandles =
      getClosedCandles(
        symbol,
        timeframe
      );


    updateDashboard(
      analysis
    );


    processSignal(
      signal,
      analysis
    );


    /*
     * Allow chart code to update without
     * replacing the chart implementation.
     */
    window.dispatchEvent(
      new CustomEvent(
        "precision-analysis",
        {
          detail: analysis
        }
      )
    );


    return analysis;
  } catch (error) {
    console.error(
      "Precision analysis error:",
      error
    );

    setAnalysisStatus(
      `Analysis error: ${error.message}`
    );

    return null;
  } finally {
    state.analysisRunning =
      false;
  }
}


/* ============================================================
   MARKET INSIGHTS
   ============================================================ */

function buildMarketInsight(
  topDown,
  signal
) {
  const primary =
    topDown.primary;


  if (
    !primary ||
    !primary.ready
  ) {
    return {
      bias: "WAIT",
      structure: "Waiting",
      liquidity: "Waiting",
      supportResistance:
        "Waiting",
      zones: "Waiting",
      candle:
        "Waiting"
    };
  }


  return {
    timeframe:
      topDown.selectedTimeframe,

    bias:
      primary.structure.bias,

    htfBias:
      topDown.htfBias,

    structure:
      formatStructure(
        primary.structure
      ),

    bos:
      primary.events.bos
        ? primary.events.bos.type
        : "None",

    choch:
      primary.events.choch
        ? primary.events.choch.type
        : "None",

    liquidity:
      primary.liquidity.swept
        ? primary.liquidity.type
        : "No confirmed sweep",

    support:
      primary.supportResistance
        .support,

    resistance:
      primary.supportResistance
        .resistance,

    demand:
      primary.supplyDemand
        ?.demand || null,

    supply:
      primary.supplyDemand
        ?.supply || null,

    fvg:
      primary.fvg || null,

    orderBlock:
      primary.orderBlock || null,

    candle:
      primary.candleConfirmation
        ?.confirmed
        ? primary
            .candleConfirmation
            .pattern
        : "No confirmation",

    signal:
      signal?.signal || "WAIT"
  };
}


function formatStructure(
  structure
) {
  if (!structure) {
    return "NEUTRAL";
  }

  return (
    structure.bias ||
    "NEUTRAL"
  );
}


/* ============================================================
   SIGNAL PROCESSING
   ============================================================ */

function processSignal(
  signal,
  analysis
) {
  if (!signal) return;


  /*
   * WAIT
   */
  if (
    signal.signal ===
    "WAIT"
  ) {
    return;
  }


  const key =
    [
      analysis.symbol,
      analysis.timeframe,
      signal.signal,
      signal.grade
    ].join("|");


  /*
   * Upgrade an existing setup.
   */
  if (
    state.activeSetup &&
    state.activeSetup.symbol ===
      analysis.symbol &&
    state.activeSetup.timeframe ===
      analysis.timeframe &&
    state.activeSetup.direction ===
      signal.direction
  ) {
    const previousRank =
      state.activeSetup.rank ||
      0;


    if (
      signal.rank >
      previousRank
    ) {
      state.activeSetup =
        {
          ...signal,
          ...analysis,
          upgraded: true
        };


      notifySignal(
        signal,
        true
      );
    }

    return;
  }


  /*
   * New setup.
   */
  state.activeSetup =
    {
      ...signal,
      ...analysis
    };


  state.lastSignal =
    signal;


  state.lastSignalKey =
    key;


  state.signalHistory.unshift({
    ...signal,

    timestamp:
      Date.now()
  });


  if (
    state.signalHistory.length >
    50
  ) {
    state.signalHistory.pop();
  }


  notifySignal(
    signal,
    false
  );


  updateSignalHistoryUI();
}


/* ============================================================
   SIGNAL INVALIDATION
   ============================================================ */

function checkSignalInvalidation() {
  const setup =
    state.activeSetup;


  if (!setup) return;


  if (
    !setup.levels ||
    state.livePrice == null
  ) {
    return;
  }


  const price =
    state.livePrice;


  const sl =
    setup.levels.sl;


  let invalid = false;


  if (
    setup.direction ===
    "BULLISH" &&
    price <= sl
  ) {
    invalid = true;
  }


  if (
    setup.direction ===
    "BEARISH" &&
    price >= sl
  ) {
    invalid = true;
  }


  if (invalid) {
    state.activeSetup =
      null;

    setAnalysisStatus(
      "Previous setup invalidated. Monitoring for a new setup."
    );
  }
}


/* ============================================================
   NOTIFICATIONS
   ============================================================ */

function notifySignal(
  signal,
  isUpgrade
) {
  if (
    !state.alertsEnabled
  ) {
    return;
  }


  const key =
    [
      signal.symbol,
      signal.timeframe,
      signal.direction,
      signal.grade
    ].join("|");


  const previous =
    state.notifiedSignals.get(
      key
    );


  if (
    previous &&
    Date.now() -
      previous <
      CONFIG.DUPLICATE_COOLDOWN
  ) {
    return;
  }


  state.notifiedSignals.set(
    key,
    Date.now()
  );


  const title =
    isUpgrade
      ? `SIGNAL UPGRADE — ${signal.grade}`
      : `${signal.signal} — ${signal.grade}`;


  const message =
    `${signal.symbol} | ` +
    `${signal.timeframe} | ` +
    `${signal.signal} | ` +
    `${signal.grade}`;


  showInAppAlert(
    title,
    message
  );


  if (
    "Notification" in window
  ) {
    if (
      Notification.permission ===
      "granted"
    ) {
      new Notification(
        title,
        {
          body: message
        }
      );
    }
  }
}


async function requestNotificationPermission() {
  if (
    !("Notification" in window)
  ) {
    return;
  }


  if (
    Notification.permission ===
    "default"
  ) {
    try {
      await Notification.requestPermission();
    } catch (_) {}
  }
}


/* ============================================================
   UI — CONNECTION
   ============================================================ */

function updateConnectionUI(
  text,
  live
) {
  setText(
    "#connectionText",
    text
  );


  const dot =
    $(".status-dot");


  if (dot) {
    dot.classList.toggle(
      "live",
      Boolean(live)
    );
  }
}


/* ============================================================
   UI — PRICE
   ============================================================ */

function updatePriceUI(price) {
  const value =
    round(
      price,
      5
    );


  setText(
    "#price",
    value
  );


  setText(
    "#livePrice",
    value
  );


  const selected =
    $("#selectedMarket");


  if (
    selected &&
    state.selectedSymbol
  ) {
    selected.textContent =
      state.selectedSymbol;
  }
}


/* ============================================================
   UI — STATUS
   ============================================================ */

function setAnalysisStatus(
  text
) {
  setText(
    "#analysisStatus",
    text
  );

  setText(
    "#engineStatus",
    text
  );
}


/* ============================================================
   UI — DASHBOARD
   ============================================================ */

function updateDashboard(
  analysis
) {
  if (!analysis) return;


  const signal =
    analysis.signal;


  const primary =
    analysis.topDown.primary;


  /*
   * Signal
   */
  setText(
    "#signal",
    signal.signal
  );


  setText(
    "#direction",
    signal.direction ||
      signal.signal
  );


  setText(
    "#setup",
    signal.grade
  );


  setText(
    "#confidence",
    signal.score != null
      ? `${signal.score}/15`
      : "—"
  );


  setText(
    "#rr",
    signal.levels
      ? `1:${signal.levels.rrTP2}`
      : "—"
  );


  /*
   * Selected timeframe
   */
  setText(
    "#selectedTimeframe",
    analysis.timeframe
  );


  setText(
    "#analysisTimeframe",
    analysis.timeframe
  );


  /*
   * Trade levels
   */
  const levels =
    signal.levels;


  if (levels) {
    setText(
      "#entry",
      levels.entry
    );

    setText(
      "#sl",
      levels.sl
    );

    setText(
      "#be",
      levels.be
    );

    setText(
      "#tp1",
      levels.tp1
    );

    setText(
      "#tp2",
      levels.tp2
    );
  }


  /*
   * Structure
   */
  if (primary) {
    setText(
      "#swing",
      primary.structure?.bias ||
        "NEUTRAL"
    );


    setText(
      "#structure",
      primary.events?.bos
        ? primary.events.bos.type
        : primary.structure?.bias ||
          "NONE"
    );


    setText(
      "#liquidity",
      primary.liquidity?.swept
        ? primary.liquidity.type
        : "NONE"
    );


    setText(
      "#sr",
      formatSR(
        primary.supportResistance
      )
    );


    /*
     * Candlestick
     */
    setText(
      "#pattern",
      primary.candleConfirmation
        ?.pattern ||
        "NONE"
    );


    setText(
      "#rejection",
      primary.candleConfirmation
        ?.confirmed
        ? "CONFIRMED"
        : "WAITING"
    );


    setText(
      "#momentum",
      primary.displacement
        ? primary.displacement.direction
        : "NONE"
    );


    setText(
      "#confirmation",
      primary.candleConfirmation
        ?.confirmed
        ? "CONFIRMED"
        : "WAITING"
    );
  }


  /*
   * Explanation
   */
  setText(
    "#explanationText",
    signal.explanation ||
      signal.reason ||
      "Monitoring market structure."
  );


  setAnalysisStatus(
    `${analysis.symbol} — ${analysis.timeframe} — ${signal.signal} ${signal.grade}`
  );


  updateMarketInsightUI(
    analysis.marketInsight
  );


  updateSignalHistoryUI();
}


function formatSR(sr) {
  if (!sr) return "NONE";

  const support =
    sr.support != null
      ? round(sr.support)
      : "—";

  const resistance =
    sr.resistance != null
      ? round(sr.resistance)
      : "—";

  return `S: ${support} | R: ${resistance}`;
}


/* ============================================================
   MARKET INSIGHT UI
   ============================================================ */

function updateMarketInsightUI(
  insight
) {
  if (!insight) return;


  setText(
    "#marketBias",
    insight.bias
  );


  setText(
    "#htfBias",
    insight.htfBias
  );


  setText(
    "#marketStructure",
    insight.structure
  );


  setText(
    "#bos",
    insight.bos
  );


  setText(
    "#choch",
    insight.choch
  );


  setText(
    "#marketLiquidity",
    insight.liquidity
  );


  setText(
    "#marketSupport",
    insight.support != null
      ? round(insight.support)
      : "—"
  );


  setText(
    "#marketResistance",
    insight.resistance != null
      ? round(insight.resistance)
      : "—"
  );


  setText(
    "#marketCandle",
    insight.candle
  );
}


/* ============================================================
   SIGNAL HISTORY UI
   ============================================================ */

function updateSignalHistoryUI() {
  const container =
    $("#signalHistory");


  if (!container) return;


  container.innerHTML = "";


  state.signalHistory
    .slice(0, 20)
    .forEach(item => {
      const row =
        document.createElement(
          "div"
        );


      row.className =
        "signal-history-item";


      const time =
        new Date(
          item.timestamp
        ).toLocaleTimeString();


      row.textContent =
        `${time} — ` +
        `${item.symbol} — ` +
        `${item.timeframe} — ` +
        `${item.signal} — ` +
        `${item.grade}`;


      container.appendChild(row);
    });
}


/* ============================================================
   IN-APP ALERT
   ============================================================ */

function showInAppAlert(
  title,
  message
) {
  let container =
    $("#signalAlert");


  if (!container) {
    container =
      document.createElement(
        "div"
      );

    container.id =
      "signalAlert";

    container.style.position =
      "fixed";

    container.style.top =
      "20px";

    container.style.right =
      "20px";

    container.style.zIndex =
      "99999";

    document.body.appendChild(
      container
    );
  }


  const alert =
    document.createElement(
      "div"
    );


  alert.style.padding =
    "14px";


  alert.style.marginBottom =
    "8px";


  alert.style.borderRadius =
    "10px";


  alert.style.background =
    "#111";


  alert.style.color =
    "#fff";


  alert.style.boxShadow =
    "0 5px 20px rgba(0,0,0,.3)";


  alert.innerHTML =
    `<strong>${escapeHTML(title)}</strong>
     <div>${escapeHTML(message)}</div>`;


  container.appendChild(
    alert
  );


  setTimeout(() => {
    alert.remove();
  }, 7000);
}


/* ============================================================
   ALERT CONTROL
   ============================================================ */

function createAlertControl() {
  const existing =
    $("#alertControl");


  if (existing) {
    existing.addEventListener(
      "click",
      async () => {
        state.alertsEnabled =
          !state.alertsEnabled;

        await requestNotificationPermission();

        existing.textContent =
          state.alertsEnabled
            ? "🔔 Alerts ON"
            : "🔕 Alerts OFF";
      }
    );

    return;
  }


  /*
   * Do not modify the user's layout unnecessarily.
   *
   * If no existing alert button exists,
   * create a small fixed control.
   */
  const button =
    document.createElement(
      "button"
    );


  button.id =
    "alertControl";


  button.textContent =
    "🔔 Alerts ON";


  button.style.position =
    "fixed";


  button.style.bottom =
    "20px";


  button.style.right =
    "20px";


  button.style.zIndex =
    "9999";


  button.addEventListener(
    "click",
    async () => {
      state.alertsEnabled =
        !state.alertsEnabled;

      if (
        state.alertsEnabled
      ) {
        await requestNotificationPermission();
      }

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
   AI QUESTION BAR
   ============================================================ */

function createQuestionBar() {
  if (
    $("#aiQuestionBar") ||
    $("#questionBar")
  ) {
    return;
  }


  const wrapper =
    document.createElement(
      "div"
    );


  wrapper.id =
    "aiQuestionBar";


  wrapper.style.margin =
    "20px 0";


  wrapper.innerHTML = `
    <div style="
      display:flex;
      gap:8px;
      align-items:center;
      flex-wrap:wrap;
    ">
      <input
        id="aiQuestion"
        type="text"
        placeholder="Ask Successful AI about the current market..."
        style="
          flex:1;
          min-width:220px;
          padding:12px;
        "
      />

      <button id="askAIButton">
        Ask AI
      </button>
    </div>

    <div
      id="aiAnswer"
      style="
        margin-top:10px;
        white-space:pre-wrap;
      "
    ></div>
  `;


  const target =
    document.querySelector(
      "main"
    ) ||
    document.body;


  target.appendChild(
    wrapper
  );


  const input =
    $("#aiQuestion");


  const button =
    $("#askAIButton");


  button.addEventListener(
    "click",
    () => {
      askSuccessfulAI(
        input.value
      );
    }
  );


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


/* ============================================================
   AI QUESTION FUNCTION
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
    state.analysis ||
    {};


  const timeframe =
    getSelectedTimeframe();


  const symbol =
    state.selectedSymbol ||
    $("#market")?.value ||
    "Unknown";


  const candles =
    getClosedCandles(
      symbol,
      timeframe
    );


  const market = {
    symbol,

    name:
      $("#market")
        ?.selectedOptions?.[0]
        ?.textContent ||
      "",

    price:
      state.livePrice ??
      null,

    timeframe
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

            timeframe,

            granularity:
              CONFIG.TIMEFRAMES[
                timeframe
              ],

            analysis,

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


    if (answerBox) {
      answerBox.textContent =
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


    const fallback =
      localAIAnswer(
        question,
        analysis
      );


    if (answerBox) {
      answerBox.textContent =
        fallback;
    }


    return fallback;
  }
}


/* ============================================================
   LOCAL AI FALLBACK
   ============================================================ */

function localAIAnswer(
  question,
  analysis
) {
  const signal =
    analysis?.signal;


  const timeframe =
    analysis?.timeframe ||
    getSelectedTimeframe();


  const symbol =
    analysis?.symbol ||
    state.selectedSymbol;


  if (!signal) {
    return (
      `No completed ${timeframe} analysis ` +
      `is currently available for ${symbol}.`
    );
  }


  return (
    `${symbol} ${timeframe} insight:\n\n` +

    `Signal: ${signal.signal}\n` +

    `Setup: ${signal.grade}\n` +

    `HTF Bias: ${
      signal.htfBias || "NEUTRAL"
    }\n` +

    `Score: ${
      signal.score ?? "—"
    }\n\n` +

    `${
      signal.explanation ||
      signal.reason ||
      "No additional explanation."
    }`
  );
}


/* ============================================================
   UTILITIES
   ============================================================ */

function escapeHTML(value) {
  return String(value)
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}


/* ============================================================
   CONTINUOUS INVALIDATION CHECK
   ============================================================ */

setInterval(() => {
  checkSignalInvalidation();
}, 1000);


/* ============================================================
   PUBLIC API
   ============================================================ */

window.SuccessfulPrecisionAI = {
  state,

  connectDeriv,

  runPrecisionAnalysis,

  analyzeTimeframe,

  getSelectedTimeframe,

  setSelectedTimeframe,

  loadTimeframeHistory,

  loadRequiredTimeframes,

  ensureTimeframeData,

  getClosedCandles,

  generatePrecisionSignal,

  askSuccessfulAI
};


/* ============================================================
   GLOBALS FOR EXISTING UI / AI BAR / CHARTS
   ============================================================ */

window.askSuccessfulAI =
  askSuccessfulAI;

window.runPrecisionAnalysis =
  runPrecisionAnalysis;

window.getSelectedTimeframe =
  getSelectedTimeframe;

window.getClosedCandles =
  getClosedCandles;


/* ============================================================
   INITIAL GLOBAL STATE
   ============================================================ */

window.lastAnalysis = null;
window.currentAnalysis = null;
window.currentSymbol = "";
window.currentPrice = null;
window.closedCandles = [];

/* ============================================================
   END SUCCESSFUL PINE SCRIPT
   ============================================================ */
