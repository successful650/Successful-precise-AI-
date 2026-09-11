/* ============================================================
   SUCCESSFUL PINE SCRIPT
   PRECISION SNIPER AI
   ------------------------------------------------------------
   Strategy:
   SWING → DIRECTION → CONFIRMATION → ENTRY → SL → TP

   NON-REPAINTING:
   - CLOSED CANDLES ONLY
   - NO INTRABAR CONFIRMED SIGNALS
   - CONFIRMED ENTRY/SL/TP ARE FROZEN
   - NO FUTURE DATA
   - CONFIRMED SWINGS ONLY
   - TIMEFRAME-SPECIFIC ANALYSIS
   - NO OLD-TIMEFRAME SIGNALS AFTER TF CHANGE

   LIVE DATA:
   Deriv public WebSocket
   ============================================================ */

"use strict";

/* ============================================================
   CONFIG
   ============================================================ */

const CONFIG = {
  DERIV_WS: "wss://api.derivws.com/trading/v1/options/ws/public",

  HISTORY_COUNT: 1000,

  // SignalLib-style swing parameters
  DEPTH: 30,
  DEVIATION: 5,
  BACKSTEP: 5,

  // Simple confirmation
  EMA_LENGTH: 9,

  // ATR safety check
  ATR_LENGTH: 14,
  ATR_SAFETY_MULTIPLIER: 0.15,

  // Targets
  TP1_RR: 1,
  TP2_RR: 2,
  TP3_RR: 3,

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

  RECONNECT_MIN: 1000,
  RECONNECT_MAX: 30000,

  ANALYSIS_INTERVAL: 5000,

  SIGNAL_COOLDOWN: 60 * 60 * 1000
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

  /*
    candles[symbol][timeframe] = {
      candles: [],
      updatedAt: timestamp
    }
  */
  candles: {},

  pendingRequests: new Map(),
  requestId: 1,

  analysis: null,
  activeSignal: null,

  signalHistory: [],
  notifiedSignals: new Set(),

  alertsEnabled: true,

  analysisGeneration: 0,
  analysisRunning: false,

  lastClosedCandleTime: {},

  tradeState: null,

  initialized: false
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
  if (el) el.textContent = value;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


/* ============================================================
   TIMEFRAME HELPERS
   ============================================================ */

function normalizeTimeframe(value) {
  if (!value) return null;

  const raw = String(value).trim();

  const map = {
    "1": "M1",
    "1M": "M1",
    "M1": "M1",

    "5": "M5",
    "5M": "M5",
    "M5": "M5",

    "15": "M15",
    "15M": "M15",
    "M15": "M15",

    "30": "M30",
    "30M": "M30",
    "M30": "M30",

    "60": "H1",
    "1H": "H1",
    "H1": "H1",

    "120": "H2",
    "2H": "H2",
    "H2": "H2",

    "240": "H4",
    "4H": "H4",
    "H4": "H4",

    "D": "Daily",
    "DAY": "Daily",
    "DAILY": "Daily"
  };

  return map[raw.toUpperCase()] || null;
}


function getSelectedTimeframe() {
  return normalizeTimeframe(state.selectedTimeframe) || "M5";
}


function getSelectedGranularity() {
  return CONFIG.TIMEFRAMES[getSelectedTimeframe()];
}


/* ============================================================
   TIMEFRAME UI
   ============================================================ */

function updateTimeframeButtons() {
  const tf = getSelectedTimeframe();

  $all("[data-timeframe]").forEach(button => {
    const buttonTF = normalizeTimeframe(
      button.dataset.timeframe ||
      button.value ||
      button.textContent
    );

    button.classList.toggle("active", buttonTF === tf);

    if (buttonTF === tf) {
      button.setAttribute("aria-selected", "true");
    } else {
      button.setAttribute("aria-selected", "false");
    }
  });

  const select = $("#timeframe");

  if (select && normalizeTimeframe(select.value)) {
    select.value = tf;
  }
}


/* ============================================================
   CHOSEN PAIR DISPLAY
   ============================================================ */

function getSelectedMarketName() {
  const select = $("#market");

  if (!select) {
    return state.selectedSymbol || "Waiting...";
  }

  const option = select.selectedOptions?.[0];

  return option?.textContent?.trim() ||
    state.selectedSymbol ||
    "Waiting...";
}


function updateChosenPairDisplay() {
  const marketName = getSelectedMarketName();
  const tf = getSelectedTimeframe();

  const display = `${marketName} — ${tf}`;

  const possibleElements = [
    "#chosenPair",
    "#chosenPairDisplay",
    "#selectedPair",
    "#selectedMarket",
    "#currentMarket",
    "#marketName"
  ];

  let found = false;

  possibleElements.forEach(selector => {
    const el = $(selector);

    if (el) {
      el.textContent = display;
      found = true;
    }
  });

  /*
    If the existing HTML has no chosen-pair element,
    create one under the market selector.
  */
  if (!found) {
    const market = $("#market");

    if (market && market.parentElement) {
      let el = $("#sniperChosenPair");

      if (!el) {
        el = document.createElement("div");
        el.id = "sniperChosenPair";

        el.style.fontWeight = "600";
        el.style.marginTop = "8px";

        market.parentElement.appendChild(el);
      }

      el.textContent = `Chosen Pair: ${display}`;
    }
  }

  window.currentSymbol = state.selectedSymbol;
  window.currentTimeframe = tf;
}


/* ============================================================
   CONNECTION STATUS
   ============================================================ */

function updateConnectionUI(connected) {
  const dot = $(".status-dot");
  const text = $("#connectionText");

  if (dot) {
    dot.classList.toggle("connected", connected);
    dot.classList.toggle("disconnected", !connected);
  }

  if (text) {
    text.textContent = connected
      ? "LIVE — Deriv Connected"
      : "Connecting to Deriv...";
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

  updateConnectionUI(false);

  try {
    state.ws = new WebSocket(CONFIG.DERIV_WS);
  } catch (error) {
    scheduleReconnect();
    return;
  }

  state.ws.onopen = () => {
    state.connected = true;
    state.reconnectDelay = CONFIG.RECONNECT_MIN;

    updateConnectionUI(true);

    requestActiveSymbols();

    if (state.selectedSymbol) {
      subscribeToTicks(state.selectedSymbol);
    }
  };

  state.ws.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      handleDerivMessage(message);
    } catch (error) {
      console.error("Deriv message error:", error);
    }
  };

  state.ws.onerror = error => {
    console.error("Deriv WebSocket error:", error);
  };

  state.ws.onclose = () => {
    state.connected = false;

    updateConnectionUI(false);

    rejectPendingRequests(
      new Error("Deriv connection closed.")
    );

    scheduleReconnect();
  };
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


function rejectPendingRequests(error) {
  for (const [, pending] of state.pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  state.pendingRequests.clear();
}


/* ============================================================
   DERIV REQUEST
   ============================================================ */

function sendRequest(payload, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (
      !state.ws ||
      state.ws.readyState !== WebSocket.OPEN
    ) {
      reject(new Error("Deriv WebSocket is not connected."));
      return;
    }

    const reqId = state.requestId++;

    const request = {
      ...payload,
      req_id: reqId
    };

    const timer = setTimeout(() => {
      state.pendingRequests.delete(reqId);
      reject(new Error("Deriv request timed out."));
    }, timeout);

    state.pendingRequests.set(reqId, {
      resolve,
      reject,
      timeout
    });

    state.ws.send(JSON.stringify(request));
  });
}


/* ============================================================
   DERIV MESSAGE HANDLER
   ============================================================ */

function handleDerivMessage(message) {
  if (message.req_id && state.pendingRequests.has(message.req_id)) {
    const pending = state.pendingRequests.get(message.req_id);

    clearTimeout(pending.timeout);
    state.pendingRequests.delete(message.req_id);

    if (message.error) {
      pending.reject(
        new Error(
          message.error.message ||
          "Deriv request failed."
        )
      );
    } else {
      pending.resolve(message);
    }
  }

  if (message.msg_type === "active_symbols") {
    handleActiveSymbols(message);
  }

  if (message.msg_type === "tick") {
    handleTick(message);
  }

  if (message.msg_type === "candles") {
    handleCandleResponse(message);
  }
}


/* ============================================================
   ACTIVE SYMBOLS
   ============================================================ */

async function requestActiveSymbols() {
  try {
    const response = await sendRequest({
      active_symbols: "full"
    });

    handleActiveSymbols(response);
  } catch (error) {
    console.error("Active symbols error:", error);
  }
}


function handleActiveSymbols(response) {
  const raw = Array.isArray(response.active_symbols)
    ? response.active_symbols
    : [];

  state.symbols = raw
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

  populateMarketSelector();

  if (!state.selectedSymbol && state.symbols.length) {
    const first =
      state.symbols.find(
        x => x.symbol === "frxXAUUSD"
      ) ||
      state.symbols[0];

    selectMarket(first.symbol);
  }
}


/* ============================================================
   MARKET SELECTOR
   ============================================================ */

function populateMarketSelector() {
  const select = $("#market");

  if (!select) return;

  const current = state.selectedSymbol;

  select.innerHTML = "";

  const grouped = {};

  state.symbols.forEach(item => {
    let group = item.type || "Other";

    if (!grouped[group]) {
      grouped[group] = [];
    }

    grouped[group].push(item);
  });

  Object.keys(grouped)
    .sort()
    .forEach(group => {
      const optgroup = document.createElement("optgroup");

      optgroup.label = group;

      grouped[group]
        .sort((a, b) =>
          a.name.localeCompare(b.name)
        )
        .forEach(item => {
          const option = document.createElement("option");

          option.value = item.symbol;
          option.textContent =
            `${item.name} (${item.symbol})`;

          optgroup.appendChild(option);
        });

      select.appendChild(optgroup);
    });

  if (
    current &&
    state.symbols.some(
      item => item.symbol === current
    )
  ) {
    select.value = current;
  }
}


/* ============================================================
   MARKET SELECTION
   ============================================================ */

async function selectMarket(symbol) {
  if (!symbol) return;

  const generation = ++state.analysisGeneration;

  state.selectedSymbol = symbol;

  state.activeSignal = null;
  state.analysis = null;
  state.tradeState = null;

  updateChosenPairDisplay();

  setWaitingState(
    "LOADING",
    `Loading ${symbol} ${getSelectedTimeframe()} data...`
  );

  subscribeToTicks(symbol);

  try {
    await loadTimeframeHistory(
      symbol,
      getSelectedTimeframe(),
      true
    );

    if (generation !== state.analysisGeneration) {
      return;
    }

    await runPrecisionAnalysis(
      true,
      generation
    );
  } catch (error) {
    console.error("Market load error:", error);

    if (generation === state.analysisGeneration) {
      setWaitingState(
        "WAIT",
        "Waiting for confirmed market data."
      );
    }
  }
}


/* ============================================================
   TICKS
   ============================================================ */

function subscribeToTicks(symbol) {
  if (
    !state.ws ||
    state.ws.readyState !== WebSocket.OPEN ||
    !symbol
  ) {
    return;
  }

  try {
    state.ws.send(
      JSON.stringify({
        forget_all: "ticks"
      })
    );
  } catch (_) {}

  try {
    state.ws.send(
      JSON.stringify({
        ticks: symbol,
        subscribe: 1
      })
    );
  } catch (error) {
    console.error("Tick subscription error:", error);
  }
}


function handleTick(message) {
  const tick = message.tick;

  if (!tick) return;

  const symbol = tick.symbol;

  if (
    state.selectedSymbol &&
    symbol !== state.selectedSymbol
  ) {
    return;
  }

  state.livePrice = Number(tick.quote);

  updateLivePrice(state.livePrice);

  /*
    IMPORTANT:
    Live tick is displayed but NEVER used to confirm
    a new BUY or SELL signal.
  */

  if (state.tradeState) {
    updateTradeManagement(state.livePrice);
  }
}


function updateLivePrice(price) {
  if (!Number.isFinite(price)) return;

  const elements = [
    "#livePrice",
    "#price",
    "#currentPrice"
  ];

  elements.forEach(selector => {
    const el = $(selector);

    if (el) {
      el.textContent = formatPrice(price);
    }
  });

  window.currentPrice = price;
}


/* ============================================================
   HISTORY
   ============================================================ */

function historyKey(symbol, timeframe) {
  return `${symbol}::${timeframe}`;
}


async function loadTimeframeHistory(
  symbol,
  timeframe,
  force = false
) {
  timeframe = normalizeTimeframe(timeframe);

  if (!symbol || !timeframe) {
    throw new Error("Invalid market or timeframe.");
  }

  const key = historyKey(symbol, timeframe);

  const cached = state.candles[symbol]?.[timeframe];

  if (
    !force &&
    cached &&
    cached.candles?.length >= 100
  ) {
    return cached.candles;
  }

  /*
    Prevent duplicate requests for the exact same
    symbol/timeframe.
  */
  if (state.pendingHistory?.has(key)) {
    return state.pendingHistory.get(key);
  }

  if (!state.pendingHistory) {
    state.pendingHistory = new Map();
  }

  const promise = (async () => {
    const response = await sendRequest({
      ticks_history: symbol,

      style: "candles",

      granularity:
        CONFIG.TIMEFRAMES[timeframe],

      count: CONFIG.HISTORY_COUNT,

      end: "latest"
    }, 20000);

    const candles =
      parseDerivCandles(response);

    if (!candles.length) {
      throw new Error(
        `No ${timeframe} candles returned for ${symbol}.`
      );
    }

    if (!state.candles[symbol]) {
      state.candles[symbol] = {};
    }

    state.candles[symbol][timeframe] = {
      candles,
      updatedAt: Date.now()
    };

    return candles;
  })();

  state.pendingHistory.set(key, promise);

  try {
    return await promise;
  } finally {
    state.pendingHistory.delete(key);
  }
}


function parseDerivCandles(response) {
  if (!Array.isArray(response?.candles)) {
    return [];
  }

  return response.candles
    .map(c => ({
      epoch: Number(c.epoch),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .filter(c =>
      Number.isFinite(c.epoch) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort((a, b) => a.epoch - b.epoch);
}


function handleCandleResponse(message) {
  /*
    History requests are handled by sendRequest().
    This function intentionally does not create signals.
  */
}


/* ============================================================
   CLOSED CANDLES ONLY
   ============================================================ */

function getClosedCandles(
  symbol,
  timeframe
) {
  timeframe = normalizeTimeframe(timeframe);

  const stored =
    state.candles[symbol]?.[timeframe]?.candles;

  if (!stored?.length) {
    return [];
  }

  const duration =
    CONFIG.TIMEFRAMES[timeframe];

  const now =
    Math.floor(Date.now() / 1000);

  /*
    Candle is closed only when:
    candle start + timeframe <= current time
  */

  return stored.filter(
    candle =>
      candle.epoch + duration <= now
  );
}


/* ============================================================
   ATR
   ============================================================ */

function calculateATR(
  candles,
  length = CONFIG.ATR_LENGTH
) {
  if (candles.length < length + 1) {
    return 0;
  }

  const ranges = [];

  for (
    let i = candles.length - length;
    i < candles.length;
    i++
  ) {
    const current = candles[i];
    const previous = candles[i - 1];

    if (!previous) continue;

    const tr = Math.max(
      current.high - current.low,

      Math.abs(
        current.high - previous.close
      ),

      Math.abs(
        current.low - previous.close
      )
    );

    ranges.push(tr);
  }

  if (!ranges.length) return 0;

  return (
    ranges.reduce(
      (sum, value) => sum + value,
      0
    ) / ranges.length
  );
}


/* ============================================================
   EMA 9
   ============================================================ */

function calculateEMA(
  candles,
  length = CONFIG.EMA_LENGTH
) {
  if (candles.length < length) {
    return null;
  }

  const multiplier =
    2 / (length + 1);

  let ema = candles
    .slice(0, length)
    .reduce(
      (sum, candle) =>
        sum + candle.close,
      0
    ) / length;

  for (
    let i = length;
    i < candles.length;
    i++
  ) {
    ema =
      (
        candles[i].close - ema
      ) *
        multiplier +
      ema;
  }

  return ema;
}


/* ============================================================
   SIGNAL-LIB STYLE SWING ENGINE
   DEPTH = 30
   DEVIATION = 5
   BACKSTEP = 5

   Important:
   A pivot is NOT usable until the required candles
   AFTER it have closed.

   Therefore no future information is used for
   historical signals.
   ============================================================ */

function detectSwings(candles) {
  const swings = [];

  const depth = CONFIG.DEPTH;
  const backstep = CONFIG.BACKSTEP;

  if (
    candles.length <
    depth * 2 + 10
  ) {
    return swings;
  }

  for (
    let i = depth;
    i < candles.length - depth;
    i++
  ) {
    const candidate = candles[i];

    const left =
      candles.slice(
        i - depth,
        i
      );

    const right =
      candles.slice(
        i + 1,
        i + depth + 1
      );

    const highestLeft =
      Math.max(
        ...left.map(c => c.high)
      );

    const highestRight =
      Math.max(
        ...right.map(c => c.high)
      );

    const lowestLeft =
      Math.min(
        ...left.map(c => c.low)
      );

    const lowestRight =
      Math.min(
        ...right.map(c => c.low)
      );

    const avgRange =
      getAverageRange(
        candles,
        Math.max(0, i - 50),
        i
      );

    const deviationThreshold =
      avgRange *
      (CONFIG.DEVIATION / 5);

    const isHigh =
      candidate.high >= highestLeft &&
      candidate.high >= highestRight &&
      (
        candidate.high -
        Math.min(
          lowestLeft,
          lowestRight
        )
      ) >= deviationThreshold;

    const isLow =
      candidate.low <= lowestLeft &&
      candidate.low <= lowestRight &&
      (
        Math.max(
          highestLeft,
          highestRight
        ) -
        candidate.low
      ) >= deviationThreshold;

    if (isHigh) {
      swings.push({
        type: "HIGH",
        price: candidate.high,
        epoch: candidate.epoch,
        index: i,
        confirmedAtIndex:
          i + depth
      });
    }

    if (isLow) {
      swings.push({
        type: "LOW",
        price: candidate.low,
        epoch: candidate.epoch,
        index: i,
        confirmedAtIndex:
          i + depth
      });
    }
  }

  /*
    BACKSTEP:
    Remove nearby duplicate pivots.
  */

  const filtered = [];

  for (const swing of swings) {
    const previous =
      [...filtered]
        .reverse()
        .find(
          x =>
            x.type === swing.type
        );

    if (!previous) {
      filtered.push(swing);
      continue;
    }

    if (
      swing.index -
      previous.index <
      backstep
    ) {
      if (
        swing.type === "HIGH" &&
        swing.price > previous.price
      ) {
        filtered[
          filtered.indexOf(previous)
        ] = swing;
      }

      if (
        swing.type === "LOW" &&
        swing.price < previous.price
      ) {
        filtered[
          filtered.indexOf(previous)
        ] = swing;
      }

      continue;
    }

    filtered.push(swing);
  }

  return filtered.sort(
    (a, b) =>
      a.index - b.index
  );
}


function getAverageRange(
  candles,
  start,
  end
) {
  const subset =
    candles.slice(start, end);

  if (!subset.length) {
    return 0;
  }

  return (
    subset.reduce(
      (sum, candle) =>
        sum +
        (
          candle.high -
          candle.low
        ),
      0
    ) / subset.length
  );
}


/* ============================================================
   CONFIRMED SWINGS ONLY
   ============================================================ */

function getUsableSwings(
  candles,
  swings
) {
  const lastClosedIndex =
    candles.length - 1;

  return swings.filter(
    swing =>
      swing.confirmedAtIndex <=
      lastClosedIndex
  );
}


/* ============================================================
   DIRECTION
   ============================================================ */

function determineDirection(
  swings
) {
  if (swings.length < 2) {
    return {
      direction: "WAIT",
      reason:
        "Waiting for a meaningful swing."
    };
  }

  const highs =
    swings.filter(
      s => s.type === "HIGH"
    );

  const lows =
    swings.filter(
      s => s.type === "LOW"
    );

  const lastHigh =
    highs[highs.length - 1];

  const previousHigh =
    highs[highs.length - 2];

  const lastLow =
    lows[lows.length - 1];

  const previousLow =
    lows[lows.length - 2];

  if (
    lastHigh &&
    previousHigh &&
    lastLow &&
    previousLow
  ) {
    const bullish =
      lastHigh.price >
        previousHigh.price &&
      lastLow.price >
        previousLow.price;

    const bearish =
      lastHigh.price <
        previousHigh.price &&
      lastLow.price <
        previousLow.price;

    if (bullish) {
      return {
        direction: "BUY",
        reason:
          "Bullish swing structure."
      };
    }

    if (bearish) {
      return {
        direction: "SELL",
        reason:
          "Bearish swing structure."
      };
    }
  }

  /*
    Also detect meaningful break of latest
    confirmed swing.
  */

  const latest =
    swings[swings.length - 1];

  if (latest) {
    return {
      direction:
        latest.type === "LOW"
          ? "BUY"
          : "SELL",

      reason:
        latest.type === "LOW"
          ? "Latest confirmed swing low supports bullish direction."
          : "Latest confirmed swing high supports bearish direction."
    };
  }

  return {
    direction: "WAIT",
    reason:
      "Direction is unclear."
  };
}


/* ============================================================
   SUPPORT / RESISTANCE
   ============================================================ */

function findSupport(
  candles,
  swings,
  price
) {
  const lows =
    swings
      .filter(
        s =>
          s.type === "LOW" &&
          s.price <= price
      )
      .sort(
        (a, b) =>
          b.price - a.price
      );

  return lows[0] || null;
}


function findResistance(
  candles,
  swings,
  price
) {
  const highs =
    swings
      .filter(
        s =>
          s.type === "HIGH" &&
          s.price >= price
      )
      .sort(
        (a, b) =>
          a.price - b.price
      );

  return highs[0] || null;
}


function isNearLevel(
  price,
  level,
  atr
) {
  if (!level) return false;

  const distance =
    Math.abs(
      price - level
    );

  const tolerance =
    Math.max(
      atr * 0.75,
      Math.abs(price) * 0.001
    );

  return distance <= tolerance;
}


/* ============================================================
   CANDLE CONFIRMATION
   ============================================================ */

function bullishCandle(candle) {
  if (!candle) return false;

  const body =
    candle.close -
    candle.open;

  const range =
    candle.high -
    candle.low;

  if (range <= 0) return false;

  const bodyRatio =
    Math.abs(body) / range;

  return (
    body > 0 &&
    bodyRatio >= 0.45
  );
}


function bearishCandle(candle) {
  if (!candle) return false;

  const body =
    candle.open -
    candle.close;

  const range =
    candle.high -
    candle.low;

  if (range <= 0) return false;

  const bodyRatio =
    Math.abs(body) / range;

  return (
    body > 0 &&
    bodyRatio >= 0.45
  );
}


function bullishRejection(candle) {
  if (!candle) return false;

  const body =
    Math.abs(
      candle.close -
      candle.open
    );

  const lowerWick =
    Math.min(
      candle.open,
      candle.close
    ) -
    candle.low;

  return (
    lowerWick > body * 1.2 &&
    candle.close >
      candle.open
  );
}


function bearishRejection(candle) {
  if (!candle) return false;

  const body =
    Math.abs(
      candle.close -
      candle.open
    );

  const upperWick =
    candle.high -
    Math.max(
      candle.open,
      candle.close
    );

  return (
    upperWick > body * 1.2 &&
    candle.close <
      candle.open
  );
}


/* ============================================================
   SIMPLE CONFIRMATION
   ============================================================ */

function getConfirmation(
  candles,
  direction,
  support,
  resistance,
  ema
) {
  const last =
    candles[candles.length - 1];

  if (!last) {
    return {
      confirmed: false,
      reason:
        "No closed candle available."
    };
  }

  if (direction === "BUY") {
    const candleOK =
      bullishCandle(last) ||
      bullishRejection(last);

    const emaOK =
      ema !== null &&
      last.close >= ema;

    const supportOK =
      !!support &&
      (
        isNearLevel(
          last.close,
          support.price,
          calculateATR(candles)
        ) ||
        last.low <= support.price
      );

    return {
      confirmed:
        candleOK &&
        emaOK &&
        supportOK,

      candleOK,
      emaOK,
      levelOK: supportOK,

      reason:
        candleOK &&
        emaOK &&
        supportOK
          ? "Bullish swing + support + bullish candle + EMA 9."
          : "Waiting for bullish candle, support, and EMA 9 confirmation."
    };
  }

  if (direction === "SELL") {
    const candleOK =
      bearishCandle(last) ||
      bearishRejection(last);

    const emaOK =
      ema !== null &&
      last.close <= ema;

    const resistanceOK =
      !!resistance &&
      (
        isNearLevel(
          last.close,
          resistance.price,
          calculateATR(candles)
        ) ||
        last.high >= resistance.price
      );

    return {
      confirmed:
        candleOK &&
        emaOK &&
        resistanceOK,

      candleOK,
      emaOK,
      levelOK: resistanceOK,

      reason:
        candleOK &&
        emaOK &&
        resistanceOK
          ? "Bearish swing + resistance + bearish candle + EMA 9."
          : "Waiting for bearish candle, resistance, and EMA 9 confirmation."
    };
  }

  return {
    confirmed: false,
    reason:
      "Waiting for clear direction."
  };
}


/* ============================================================
   TRADE LEVELS
   ============================================================ */

function calculateTradeLevels(
  direction,
  entry,
  swing,
  atr
) {
  if (
    !Number.isFinite(entry) ||
    !swing
  ) {
    return null;
  }

  let sl;

  if (direction === "BUY") {
    sl =
      swing.price -
      Math.max(
        atr *
          CONFIG.ATR_SAFETY_MULTIPLIER,
        0
      );

    if (sl >= entry) {
      return null;
    }
  }

  if (direction === "SELL") {
    sl =
      swing.price +
      Math.max(
        atr *
          CONFIG.ATR_SAFETY_MULTIPLIER,
        0
      );

    if (sl <= entry) {
      return null;
    }
  }

  const risk =
    Math.abs(
      entry - sl
    );

  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {
    return null;
  }

  let tp1;
  let tp2;
  let tp3;

  if (direction === "BUY") {
    tp1 =
      entry +
      risk * CONFIG.TP1_RR;

    tp2 =
      entry +
      risk * CONFIG.TP2_RR;

    tp3 =
      entry +
      risk * CONFIG.TP3_RR;
  } else {
    tp1 =
      entry -
      risk * CONFIG.TP1_RR;

    tp2 =
      entry -
      risk * CONFIG.TP2_RR;

    tp3 =
      entry -
      risk * CONFIG.TP3_RR;
  }

  return {
    entry,
    sl,
    tp1,
    tp2,
    tp3,
    risk,
    rr: "1:3"
  };
}


/* ============================================================
   SIGNAL GENERATION
   ============================================================ */

function generateSniperSignal(
  symbol,
  timeframe,
  candles
) {
  /*
    CRITICAL:
    This function receives CLOSED candles only.
  */

  if (
    !symbol ||
    !timeframe ||
    candles.length < 100
  ) {
    return {
      status: "WAIT",
      timeframe,
      symbol,
      reason:
        "Waiting for enough closed candles."
    };
  }

  const swings =
    getUsableSwings(
      candles,
      detectSwings(candles)
    );

  if (swings.length < 2) {
    return {
      status: "WAIT",
      timeframe,
      symbol,
      reason:
        "Waiting for a confirmed swing."
    };
  }

  const directionInfo =
    determineDirection(swings);

  if (
    directionInfo.direction ===
    "WAIT"
  ) {
    return {
      status: "WAIT",
      timeframe,
      symbol,
      reason:
        "Waiting for a meaningful change in direction."
    };
  }

  const direction =
    directionInfo.direction;

  const last =
    candles[candles.length - 1];

  const atr =
    calculateATR(candles);

  const ema =
    calculateEMA(candles);

  const support =
    findSupport(
      candles,
      swings,
      last.close
    );

  const resistance =
    findResistance(
      candles,
      swings,
      last.close
    );

  const confirmation =
    getConfirmation(
      candles,
      direction,
      support,
      resistance,
      ema
    );

  /*
    Confirmation is mandatory.
    No forced BUY/SELL.
  */

  if (!confirmation.confirmed) {
    return {
      status: "WAIT",

      symbol,
      timeframe,

      direction,

      price: last.close,

      swings,

      ema,

      atr,

      support,
      resistance,

      confirmation,

      reason:
        confirmation.reason
    };
  }

  /*
    Important:
    Use the most recent appropriate
    CONFIRMED swing for SL.
  */

  const swing =
    direction === "BUY"
      ? [...swings]
          .reverse()
          .find(
            s => s.type === "LOW"
          )
      : [...swings]
          .reverse()
          .find(
            s => s.type === "HIGH"
          );

  if (!swing) {
    return {
      status: "WAIT",

      symbol,
      timeframe,

      direction,

      reason:
        "Waiting for an important confirmed swing for stop loss."
    };
  }

  /*
    ENTRY IS FROZEN HERE.
    It is the CLOSED candle's confirmed close.
  */

  const entry =
    Number(last.close);

  const levels =
    calculateTradeLevels(
      direction,
      entry,
      swing,
      atr
    );

  if (!levels) {
    return {
      status: "WAIT",

      symbol,
      timeframe,

      direction,

      reason:
        "Invalid risk structure. Waiting for a cleaner setup."
    };
  }

  /*
    Create immutable signal.
  */

  const signal = {
    id:
      `${symbol}_${timeframe}_${last.epoch}_${direction}`,

    symbol,
    timeframe,
    direction,

    status: "SNIPER",

    confirmedAt:
      last.epoch,

    confirmedCandle:
      last.epoch,

    entry:
      levels.entry,

    sl:
      levels.sl,

    tp1:
      levels.tp1,

    tp2:
      levels.tp2,

    tp3:
      levels.tp3,

    risk:
      levels.risk,

    rr:
      levels.rr,

    ema,

    atr,

    swing: {
      type: swing.type,
      price: swing.price,
      epoch: swing.epoch
    },

    support:
      support
        ? {
            price: support.price,
            epoch: support.epoch
          }
        : null,

    resistance:
      resistance
        ? {
            price: resistance.price,
            epoch: resistance.epoch
          }
        : null,

    reason:
      direction === "BUY"
        ? "Bullish swing + support + bullish candle + EMA 9."
        : "Bearish swing + resistance + bearish candle + EMA 9.",

    frozen: true
  };

  return signal;
}


/* ============================================================
   SIGNAL KEY
   ============================================================ */

function signalKey(signal) {
  if (!signal) return "";

  return [
    signal.symbol,
    signal.timeframe,
    signal.direction,
    signal.confirmedCandle
  ].join("_");
}


/* ============================================================
   PROCESS CONFIRMED SIGNAL
   ============================================================ */

function processSignal(signal) {
  /*
    NEVER allow another timeframe to overwrite
    the selected timeframe.
  */

  if (
    !signal ||
    signal.status !== "SNIPER"
  ) {
    return;
  }

  if (
    signal.symbol !==
    state.selectedSymbol
  ) {
    return;
  }

  if (
    signal.timeframe !==
    getSelectedTimeframe()
  ) {
    return;
  }

  /*
    Same confirmed candle:
    never replace it.
  */

  if (
    state.activeSignal &&
    state.activeSignal.id ===
      signal.id
  ) {
    return;
  }

  /*
    Opposite signal on a later CLOSED candle
    is a new signal, not a modification of
    the old signal.
  */

  state.activeSignal =
    deepFreezeSignal(signal);

  state.tradeState = {
    signal:
      state.activeSignal,

    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    stopHit: false,
    breakEvenMoved: false,

    currentSL:
      signal.sl
  };

  state.signalHistory.unshift(
    state.activeSignal
  );

  state.signalHistory =
    state.signalHistory.slice(
      0,
      100
    );

  updateDashboard(
    state.activeSignal
  );

  addSignalToHistory(
    state.activeSignal
  );

  sendSignalAlert(
    state.activeSignal
  );
}


function deepFreezeSignal(signal) {
  /*
    Clone first so the original object
    cannot be accidentally modified.
  */

  const clone =
    JSON.parse(
      JSON.stringify(signal)
    );

  return Object.freeze(clone);
}


/* ============================================================
   TRADE MANAGEMENT
   ============================================================ */

function updateTradeManagement(
  price
) {
  const trade =
    state.tradeState;

  if (
    !trade ||
    !trade.signal ||
    trade.stopHit
  ) {
    return;
  }

  const signal =
    trade.signal;

  /*
    BUY
  */

  if (signal.direction === "BUY") {
    if (
      !trade.tp1Hit &&
      price >= signal.tp1
    ) {
      trade.tp1Hit = true;

      /*
        Move SL toward BE only forward.
      */

      if (
        trade.currentSL <
        signal.entry
      ) {
        trade.currentSL =
          signal.entry;

        trade.breakEvenMoved =
          true;
      }

      showTradeEvent(
        "TP1 HIT ✅",
        "Break Even protection activated when appropriate."
      );
    }

    if (
      !trade.tp2Hit &&
      price >= signal.tp2
    ) {
      trade.tp2Hit = true;

      showTradeEvent(
        "TP2 HIT ✅",
        "Second target reached."
      );
    }

    if (
      !trade.tp3Hit &&
      price >= signal.tp3
    ) {
      trade.tp3Hit = true;

      showTradeEvent(
        "TP3 HIT 🎯",
        "Final target reached."
      );
    }

    if (
      price <=
      trade.currentSL
    ) {
      trade.stopHit = true;

      showTradeEvent(
        "STOP LOSS HIT ❌",
        "Trade management complete."
      );
    }
  }

  /*
    SELL
  */

  if (signal.direction === "SELL") {
    if (
      !trade.tp1Hit &&
      price <= signal.tp1
    ) {
      trade.tp1Hit = true;

      if (
        trade.currentSL >
        signal.entry
      ) {
        trade.currentSL =
          signal.entry;

        trade.breakEvenMoved =
          true;
      }

      showTradeEvent(
        "TP1 HIT ✅",
        "Break Even protection activated when appropriate."
      );
    }

    if (
      !trade.tp2Hit &&
      price <= signal.tp2
    ) {
      trade.tp2Hit = true;

      showTradeEvent(
        "TP2 HIT ✅",
        "Second target reached."
      );
    }

    if (
      !trade.tp3Hit &&
      price <= signal.tp3
    ) {
      trade.tp3Hit = true;

      showTradeEvent(
        "TP3 HIT 🎯",
        "Final target reached."
      );
    }

    if (
      price >=
      trade.currentSL
    ) {
      trade.stopHit = true;

      showTradeEvent(
        "STOP LOSS HIT ❌",
        "Trade management complete."
      );
    }
  }
}


function showTradeEvent(
  title,
  message
) {
  const box =
    $("#explanationText") ||
    $("#explanation");

  if (box) {
    box.textContent =
      `${title} — ${message}`;
  }

  if (
    "Notification" in window &&
    Notification.permission ===
      "granted"
  ) {
    try {
      new Notification(
        `PRECISION SNIPER AI — ${title}`,
        {
          body: message
        }
      );
    } catch (_) {}
  }
}


/* ============================================================
   DASHBOARD
   ============================================================ */

function updateDashboard(
  signal
) {
  if (!signal) return;

  const direction =
    signal.direction === "BUY"
      ? "🟢 PRECISION SNIPER BUY"
      : "🔴 PRECISION SNIPER SELL";

  setText(
    "#signal",
    direction
  );

  setText(
    "#direction",
    signal.direction
  );

  setText(
    "#setup",
    "SNIPER"
  );

  setText(
    "#confidence",
    "CONFIRMED"
  );

  setText(
    "#rr",
    signal.rr
  );

  setText(
    "#entry",
    formatPrice(signal.entry)
  );

  setText(
    "#sl",
    formatPrice(signal.sl)
  );

  setText(
    "#tp1",
    formatPrice(signal.tp1)
  );

  setText(
    "#tp2",
    formatPrice(signal.tp2)
  );

  setText(
    "#tp3",
    formatPrice(signal.tp3)
  );

  setText(
    "#pattern",
    signal.direction === "BUY"
      ? "Bullish confirmation"
      : "Bearish confirmation"
  );

  setText(
    "#rejection",
    signal.support
      ? "Support confirmed"
      : signal.resistance
        ? "Resistance confirmed"
        : "Confirmed"
  );

  setText(
    "#momentum",
    `EMA ${CONFIG.EMA_LENGTH} aligned`
  );

  setText(
    "#confirmation",
    "CLOSED CANDLE CONFIRMED"
  );

  setText(
    "#swing",
    `${signal.swing.type} @ ${formatPrice(signal.swing.price)}`
  );

  setText(
    "#structure",
    signal.direction === "BUY"
      ? "BULLISH"
      : "BEARISH"
  );

  setText(
    "#liquidity",
    "Swing confirmed"
  );

  setText(
    "#sr",
    signal.direction === "BUY"
      ? `Support ${formatPrice(signal.support?.price)}`
      : `Resistance ${formatPrice(signal.resistance?.price)}`
  );

  setText(
    "#explanationText",
    signal.reason
  );

  /*
    Ensure chosen pair ALWAYS shows timeframe.
  */

  updateChosenPairDisplay();

  window.lastAnalysis =
    state.analysis;

  window.currentAnalysis =
    state.analysis;

  window.currentSymbol =
    signal.symbol;

  window.currentTimeframe =
    signal.timeframe;

  window.currentPrice =
    signal.entry;

  window.currentSignal =
    signal;
}


/* ============================================================
   WAIT STATE
   ============================================================ */

function setWaitingState(
  title = "WAIT",
  reason =
    "Waiting for a confirmed setup."
) {
  const tf =
    getSelectedTimeframe();

  const symbol =
    state.selectedSymbol ||
    "Market";

  setText(
    "#signal",
    "⚪ WAIT — NO CONFIRMED SETUP"
  );

  setText(
    "#direction",
    "WAIT"
  );

  setText(
    "#setup",
    `${symbol} • ${tf}`
  );

  setText(
    "#confidence",
    "WAIT"
  );

  setText(
    "#rr",
    "—"
  );

  setText(
    "#entry",
    "—"
  );

  setText(
    "#sl",
    "—"
  );

  setText(
    "#tp1",
    "—"
  );

  setText(
    "#tp2",
    "—"
  );

  setText(
    "#tp3",
    "—"
  );

  setText(
    "#explanationText",
    reason
  );

  setText(
    "#confirmation",
    "WAITING"
  );

  updateChosenPairDisplay();

  window.currentTimeframe = tf;
}


/* ============================================================
   SIGNAL HISTORY
   ============================================================ */

function addSignalToHistory(
  signal
) {
  const container =
    $("#signalHistory");

  if (!container) return;

  const row =
    document.createElement("div");

  row.className =
    "signal-history-item";

  row.innerHTML = `
    <strong>
      ${signal.direction === "BUY" ? "🟢" : "🔴"}
      ${escapeHTML(signal.direction)}
    </strong>

    <span>
      ${escapeHTML(signal.symbol)}
      •
      ${escapeHTML(signal.timeframe)}
    </span>

    <span>
      Entry:
      ${escapeHTML(formatPrice(signal.entry))}
    </span>

    <span>
      ${new Date(
        signal.confirmedAt * 1000
      ).toLocaleString()}
    </span>
  `;

  container.prepend(row);
}


/* ============================================================
   ALERTS
   ============================================================ */

function createAlertControl() {
  if ($("#sniperAlertControl")) {
    return;
  }

  const button =
    document.createElement("button");

  button.id =
    "sniperAlertControl";

  button.type =
    "button";

  button.textContent =
    "🔔 Alerts ON";

  button.style.margin =
    "8px 0";

  button.onclick = () => {
    state.alertsEnabled =
      !state.alertsEnabled;

    button.textContent =
      state.alertsEnabled
        ? "🔔 Alerts ON"
        : "🔕 Alerts OFF";

    if (
      state.alertsEnabled &&
      "Notification" in window &&
      Notification.permission ===
        "default"
    ) {
      Notification.requestPermission()
        .catch(() => {});
    }
  };

  const header =
    $(".connection") ||
    $("header");

  if (header?.parentElement) {
    header.parentElement.appendChild(
      button
    );
  } else {
    document.body.prepend(button);
  }
}


function sendSignalAlert(
  signal
) {
  if (!state.alertsEnabled) {
    return;
  }

  const key =
    signalKey(signal);

  /*
    Never notify the same confirmed candle twice.
  */

  if (
    state.notifiedSignals.has(key)
  ) {
    return;
  }

  state.notifiedSignals.add(key);

  const title =
    signal.direction === "BUY"
      ? "🟢 PRECISION SNIPER BUY"
      : "🔴 PRECISION SNIPER SELL";

  const message =
    `${signal.symbol} • ${signal.timeframe}\n` +
    `Entry: ${formatPrice(signal.entry)}\n` +
    `SL: ${formatPrice(signal.sl)}\n` +
    `TP1: ${formatPrice(signal.tp1)}\n` +
    `TP2: ${formatPrice(signal.tp2)}\n` +
    `TP3: ${formatPrice(signal.tp3)}\n` +
    `${signal.reason}`;

  if (
    "Notification" in window &&
    Notification.permission ===
      "granted"
  ) {
    try {
      new Notification(
        title,
        {
          body: message
        }
      );
    } catch (_) {}
  }

  showInAppAlert(
    title,
    message
  );
}


function showInAppAlert(
  title,
  message
) {
  let box =
    $("#sniperAlert");

  if (!box) {
    box =
      document.createElement("div");

    box.id =
      "sniperAlert";

    box.style.position =
      "fixed";

    box.style.right =
      "15px";

    box.style.bottom =
      "15px";

    box.style.zIndex =
      "99999";

    box.style.maxWidth =
      "360px";

    box.style.padding =
      "15px";

    box.style.borderRadius =
      "12px";

    box.style.background =
      "rgba(0,0,0,.92)";

    box.style.color =
      "#fff";

    document.body.appendChild(
      box
    );
  }

  box.innerHTML = `
    <strong>
      ${escapeHTML(title)}
    </strong>

    <div style="margin-top:8px;white-space:pre-line;">
      ${escapeHTML(message)}
    </div>
  `;

  box.style.display =
    "block";

  clearTimeout(
    box._timer
  );

  box._timer =
    setTimeout(() => {
      box.style.display =
        "none";
    }, 10000);
}


/* ============================================================
   PRECISION ANALYSIS
   ============================================================ */

async function runPrecisionAnalysis(
  force = false,
  expectedGeneration = null
) {
  const symbol =
    state.selectedSymbol;

  const timeframe =
    getSelectedTimeframe();

  if (!symbol || !timeframe) {
    return;
  }

  /*
    Every analysis run receives its own generation.
    Older asynchronous analysis cannot overwrite
    a newer timeframe selection.
  */

  const generation =
    expectedGeneration !== null
      ? expectedGeneration
      : ++state.analysisGeneration;

  state.analysisRunning = true;

  try {
    /*
      EXACT selected timeframe.
      No M5 substitution.
    */

    await loadTimeframeHistory(
      symbol,
      timeframe,
      force
    );

    if (
      generation !==
      state.analysisGeneration
    ) {
      return;
    }

    const candles =
      getClosedCandles(
        symbol,
        timeframe
      );

    if (
      candles.length < 100
    ) {
      setWaitingState(
        "WAIT",
        `Waiting for more closed ${timeframe} candles.`
      );

      return;
    }

    /*
      The execution timeframe is the
      timeframe selected by the user.
    */

    const signal =
      generateSniperSignal(
        symbol,
        timeframe,
        candles
      );

    if (
      generation !==
      state.analysisGeneration
    ) {
      return;
    }

    /*
      Save exact selected analysis.
    */

    state.analysis = {
      symbol,
      timeframe,

      executionTimeframe:
        timeframe,

      candles,

      signal,

      lastClosedCandle:
        candles[
          candles.length - 1
        ],

      updatedAt:
        Date.now()
    };

    /*
      Expose exact data to the
      Question Bar and chart.
    */

    window.lastAnalysis =
      state.analysis;

    window.currentAnalysis =
      state.analysis;

    window.closedCandles =
      candles;

    window.currentCandles =
      candles;

    window.currentSymbol =
      symbol;

    window.currentTimeframe =
      timeframe;

    window.currentPrice =
      state.livePrice;

    /*
      Dispatch event so existing charts
      can update without being removed.
    */

    try {
      window.dispatchEvent(
        new CustomEvent(
          "precision-analysis",
          {
            detail:
              state.analysis
          }
        )
      );
    } catch (_) {}

    /*
      Only a CONFIRMED sniper signal
      reaches processSignal().
    */

    if (
      signal.status === "SNIPER"
    ) {
      processSignal(signal);
    } else {
      /*
        No new confirmed signal.
        Do not invent one.
      */

      if (
        !state.activeSignal ||
        state.activeSignal.timeframe !==
          timeframe
      ) {
        setWaitingState(
          "WAIT",
          signal.reason ||
            "Waiting for a new swing and candle confirmation."
        );
      }
    }

    updateChosenPairDisplay();

  } catch (error) {
    console.error(
      "Precision analysis error:",
      error
    );

    if (
      generation ===
      state.analysisGeneration
    ) {
      setWaitingState(
        "WAIT",
        "Waiting for live confirmed market data."
      );
    }
  } finally {
    if (
      generation ===
      state.analysisGeneration
    ) {
      state.analysisRunning =
        false;
    }
  }
}


/* ============================================================
   TIMEFRAME CHANGE
   ============================================================ */

async function selectTimeframe(
  timeframe
) {
  timeframe =
    normalizeTimeframe(timeframe);

  if (!timeframe) {
    return;
  }

  /*
    INVALIDATE ALL OLD ASYNC ANALYSIS.
  */

  const generation =
    ++state.analysisGeneration;

  /*
    THIS IS THE IMPORTANT FIX:
    selectedTimeframe is changed FIRST.
  */

  state.selectedTimeframe =
    timeframe;

  /*
    Never carry an old M5/H1/etc signal
    into the new timeframe.
  */

  state.activeSignal =
    null;

  state.tradeState =
    null;

  state.analysis =
    null;

  updateTimeframeButtons();

  updateChosenPairDisplay();

  setWaitingState(
    "LOADING",
    `Loading ${state.selectedSymbol} ${timeframe} candles...`
  );

  if (!state.selectedSymbol) {
    return;
  }

  try {
    await loadTimeframeHistory(
      state.selectedSymbol,
      timeframe,
      true
    );

    if (
      generation !==
      state.analysisGeneration
    ) {
      return;
    }

    await runPrecisionAnalysis(
      false,
      generation
    );

  } catch (error) {
    console.error(
      "Timeframe change error:",
      error
    );

    if (
      generation ===
      state.analysisGeneration
    ) {
      setWaitingState(
        "WAIT",
        `Waiting for ${timeframe} confirmed candles.`
      );
    }
  }
}


/* ============================================================
   AI QUESTION BAR
   ============================================================ */

function createQuestionBar() {
  /*
    Do not create a duplicate if HTML already
    contains an AI question bar.
  */

  if (
    $("#aiQuestion") ||
    $("#questionInput") ||
    $("#aiQuestionInput")
  ) {
    return;
  }

  const wrapper =
    document.createElement("div");

  wrapper.id =
    "sniperQuestionBar";

  wrapper.style.margin =
    "15px 0";

  wrapper.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <input
        id="sniperQuestionInput"
        type="text"
        placeholder="Ask about this market..."
        style="flex:1;min-width:220px;"
      />

      <button
        id="sniperQuestionButton"
        type="button"
      >
        Ask AI
      </button>
    </div>

    <div
      id="aiAnswer"
      style="margin-top:10px;white-space:pre-wrap;"
    >
      Ask me about the current market.
    </div>
  `;

  const history =
    $("#signalHistory");

  if (
    history?.parentElement
  ) {
    history.parentElement.insertBefore(
      wrapper,
      history
    );
  } else {
    document.body.appendChild(
      wrapper
    );
  }

  $("#sniperQuestionButton")
    ?.addEventListener(
      "click",
      () => {
        askSuccessfulAI(
          $("#sniperQuestionInput")
            ?.value
        );
      }
    );

  $("#sniperQuestionInput")
    ?.addEventListener(
      "keydown",
      event => {
        if (
          event.key === "Enter"
        ) {
          askSuccessfulAI(
            event.target.value
          );
        }
      }
    );
}


/* ============================================================
   AI QUESTION
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
      "Analyzing the selected market and timeframe...";
  }

  const symbol =
    state.selectedSymbol;

  const timeframe =
    getSelectedTimeframe();

  const candles =
    getClosedCandles(
      symbol,
      timeframe
    );

  const analysis =
    state.analysis || {};

  const market = {
    symbol,

    name:
      getSelectedMarketName(),

    price:
      state.livePrice,

    timeframe,

    granularity:
      CONFIG.TIMEFRAMES[timeframe]
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
            JSON.stringify({
              question,

              market,

              timeframe,

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
      "AI Question error:",
      error
    );

    const fallback =
      buildLocalAIAnswer(
        question,
        analysis,
        timeframe
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

function buildLocalAIAnswer(
  question,
  analysis,
  timeframe
) {
  const signal =
    analysis?.signal;

  if (!signal) {
    return (
      `Current timeframe: ${timeframe}\n\n` +
      "There is no confirmed sniper setup right now. " +
      "The strategy is waiting for a confirmed swing and candle confirmation."
    );
  }

  if (
    signal.status === "SNIPER"
  ) {
    return (
      `${signal.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"} ` +
      `confirmed on ${signal.symbol} ${signal.timeframe}.\n\n` +

      `Entry: ${formatPrice(signal.entry)}\n` +
      `SL: ${formatPrice(signal.sl)}\n` +
      `TP1: ${formatPrice(signal.tp1)}\n` +
      `TP2: ${formatPrice(signal.tp2)}\n` +
      `TP3: ${formatPrice(signal.tp3)}\n\n` +

      `Reason: ${signal.reason}`
    );
  }

  return (
    `WAIT on ${signal.symbol} ${signal.timeframe}.\n\n` +
    signal.reason
  );
}


/* ============================================================
   INITIAL UI
   ============================================================ */

function initializeExistingUI() {
  /*
    Detect currently selected timeframe.
  */

  let initialTF = null;

  const activeButton =
    document.querySelector(
      "[data-timeframe].active"
    );

  if (activeButton) {
    initialTF =
      normalizeTimeframe(
        activeButton.dataset.timeframe ||
        activeButton.value ||
        activeButton.textContent
      );
  }

  const timeframeSelect =
    $("#timeframe");

  if (
    !initialTF &&
    timeframeSelect
  ) {
    initialTF =
      normalizeTimeframe(
        timeframeSelect.value
      );
  }

  /*
    Only use M5 as initial default.
    It is NOT used as a fallback for
    another selected timeframe.
  */

  state.selectedTimeframe =
    initialTF ||
    "M5";

  updateTimeframeButtons();
  updateChosenPairDisplay();

  /*
    Market selector.
  */

  $("#market")
    ?.addEventListener(
      "change",
      event => {
        selectMarket(
          event.target.value
        );
      }
    );

  /*
    Robust event delegation:
    works even if timeframe buttons
    are dynamically created.
  */

  document.addEventListener(
    "click",
    event => {
      const button =
        event.target.closest(
          "[data-timeframe]"
        );

      if (!button) {
        return;
      }

      event.preventDefault();

      const tf =
        normalizeTimeframe(
          button.dataset.timeframe ||
          button.value ||
          button.textContent
        );

      if (tf) {
        selectTimeframe(tf);
      }
    }
  );

  /*
    Optional timeframe select.
  */

  timeframeSelect
    ?.addEventListener(
      "change",
      event => {
        const tf =
          normalizeTimeframe(
            event.target.value
          );

        if (tf) {
          selectTimeframe(tf);
        }
      }
    );

  /*
    Existing Analyze buttons.
  */

  const analyzeButtons = [
    "#analyze",
    "#analyzeBtn",
    "#analyzeButton"
  ];

  analyzeButtons.forEach(
    selector => {
      $(selector)
        ?.addEventListener(
          "click",
          () => {
            runPrecisionAnalysis(
              true
            );
          }
        );
    }
  );

  /*
    Initial WAIT state.
  */

  setWaitingState(
    "WAIT",
    "Waiting for live market data and a confirmed swing."
  );
}


/* ============================================================
   UTILITIES
   ============================================================ */

function formatPrice(
  value
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(
      Number(value)
    )
  ) {
    return "—";
  }

  const number =
    Number(value);

  const absolute =
    Math.abs(number);

  let decimals = 2;

  if (
    absolute >= 1000
  ) {
    decimals = 2;
  } else if (
    absolute >= 100
  ) {
    decimals = 2;
  } else if (
    absolute >= 1
  ) {
    decimals = 3;
  } else {
    decimals = 5;
  }

  return number.toFixed(
    decimals
  );
}


/* ============================================================
   NOTIFICATION PERMISSION
   ============================================================ */

function requestNotificationPermission() {
  if (
    "Notification" in window &&
    Notification.permission ===
      "default"
  ) {
    Notification.requestPermission()
      .catch(() => {});
  }
}


/* ============================================================
   PERIODIC ANALYSIS
   ============================================================ */

function startAnalysisLoop() {
  setInterval(
    () => {
      /*
        Only analyze when a selected market exists.
      */

      if (
        !state.selectedSymbol
      ) {
        return;
      }

      /*
        Use the EXACT selected timeframe.
      */

      runPrecisionAnalysis(
        false
      );
    },
    CONFIG.ANALYSIS_INTERVAL
  );
}


/* ============================================================
   START APPLICATION
   ============================================================ */

document.addEventListener(
  "DOMContentLoaded",
  () => {
    if (state.initialized) {
      return;
    }

    state.initialized =
      true;

    initializeExistingUI();

    createQuestionBar();

    createAlertControl();

    requestNotificationPermission();

    connectDeriv();

    startAnalysisLoop();

    /*
      Public API for existing app components.
    */

    window.SuccessfulPrecisionAI = {
      state,

      CONFIG,

      connectDeriv,

      selectMarket,

      selectTimeframe,

      runPrecisionAnalysis,

      askSuccessfulAI,

      getClosedCandles,

      detectSwings,

      determineDirection,

      generateSniperSignal
    };

    /*
      Useful globals for existing charts
      and other frontend components.
    */

    window.askSuccessfulAI =
      askSuccessfulAI;

    window.selectTimeframe =
      selectTimeframe;

    window.selectMarket =
      selectMarket;

    window.runPrecisionAnalysis =
      runPrecisionAnalysis;

    window.currentTimeframe =
      state.selectedTimeframe;
  }
);


/* ============================================================
   FINAL GLOBALS
   ============================================================ */

window.PrecisionSniperAI = {
  CONFIG,
  state
};
