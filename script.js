/* ============================================================
   SUCCESSFUL PINE SCRIPT
   PRECISION SIGNAL ENGINE
   GitHub + Vercel Ready
   ------------------------------------------------------------
   LIVE PUBLIC DERIV DATA
   CLOSED-CANDLE / NON-REPAINTING ANALYSIS
   DYNAMIC SELECTED TIMEFRAME ENGINE
   MARKET STRUCTURE + PRICE ACTION + SMC
   PROGRESSIVE SIGNALS:
      EARLY SETUP → C → B → A → A+
   ------------------------------------------------------------
   IMPORTANT:
   The selected timeframe is the ACTUAL execution timeframe.
   M5 is NOT used as a hidden fallback.
   ============================================================ */

"use strict";

/* ============================================================
   CONFIG
   ============================================================ */

const CONFIG = {
  DERIV_WS:
    "wss://api.derivws.com/trading/v1/options/ws/public",

  HISTORY_COUNT: 1000,

  DEPTH: 30,
  DEVIATION: 5,
  BACKSTEP: 5,

  MIN_RR: 2,

  RECONNECT_MIN: 1000,
  RECONNECT_MAX: 30000,

  ANALYSIS_INTERVAL: 5000,

  DUPLICATE_COOLDOWN: 60 * 60 * 1000,

  HISTORY_TIMEOUT: 15000,

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

  /*
    IMPORTANT:
    candles are stored like:

    candles[SYMBOL][TIMEFRAME] = {
      candles: [],
      updatedAt: timestamp
    }
  */
  candles: {},

  ticks: {},

  pendingHistory: new Map(),

  requestCounter: 100,

  analysis: null,

  activeSignal: null,

  lastSignalKey: "",

  signalHistory: [],

  notifiedSignals: new Set(),

  alertsEnabled: true,

  analysisRunning: false,

  /*
    Every new pair/timeframe analysis receives
    a new generation number.

    Old async requests are NOT allowed to
    overwrite the new timeframe.
  */
  analysisGeneration: 0,

  userInteracted: false
};


/* ============================================================
   DOM HELPERS
   ============================================================ */

function $(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value == null ? "" : String(value);
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}


/* ============================================================
   TIMEFRAME HELPERS
   ============================================================ */

function normalizeTimeframe(value) {

  if (!value) return null;

  const raw = String(value)
    .trim()
    .toUpperCase();

  const map = {
    "1": "M1",
    "M1": "M1",
    "1M": "M1",

    "5": "M5",
    "M5": "M5",
    "5M": "M5",

    "15": "M15",
    "M15": "M15",
    "15M": "M15",

    "30": "M30",
    "M30": "M30",
    "30M": "M30",

    "60": "H1",
    "H1": "H1",
    "1H": "H1",

    "120": "H2",
    "H2": "H2",
    "2H": "H2",

    "240": "H4",
    "H4": "H4",
    "4H": "H4",

    "D": "Daily",
    "DAY": "Daily",
    "DAILY": "Daily",
    "1D": "Daily"
  };

  return map[raw] || null;
}

function timeframeLabel(tf) {
  return tf === "Daily" ? "Daily" : String(tf || "");
}

function getSelectedTimeframe() {

  const tf = normalizeTimeframe(state.selectedTimeframe);

  if (tf) return tf;

  /*
    Only startup fallback.
    Execution logic never silently falls back.
  */
  return "M5";
}


/* ============================================================
   SYMBOL HELPERS
   ============================================================ */

function getSelectedSymbol() {

  const market =
    $("market") ||
    $("symbol") ||
    $("instrument");

  const value =
    market?.value ||
    state.selectedSymbol ||
    "";

  return String(value);
}

function marketName(symbol) {

  if (!symbol) return "Unknown Market";

  const found = state.symbols.find(
    s => s.symbol === symbol
  );

  return (
    found?.display_name ||
    found?.name ||
    found?.underlying_symbol_name ||
    symbol
  );
}


/* ============================================================
   INITIALIZATION
   ============================================================ */

document.addEventListener(
  "DOMContentLoaded",
  initializeSuccessfulPine
);

function initializeSuccessfulPine() {

  detectInitialTimeframe();

  initializeExistingUI();

  createQuestionBar();

  createAlertControl();

  updateChosenPairDisplay();

  connectDeriv();

  /*
    Periodic analysis.
    The selected timeframe is always read again.
  */
  setInterval(() => {

    runPrecisionAnalysis(false);

  }, CONFIG.ANALYSIS_INTERVAL);
}


/* ============================================================
   INITIAL TIMEFRAME
   ============================================================ */

function detectInitialTimeframe() {

  const activeButton =
    document.querySelector(
      "[data-timeframe].active, " +
      "[data-timeframe][aria-selected='true']"
    );

  const select =
    $("timeframe") ||
    $("timeframeSelect");

  const detected =
    normalizeTimeframe(
      activeButton?.dataset?.timeframe ||
      activeButton?.textContent ||
      select?.value
    );

  state.selectedTimeframe =
    detected || "M5";

  window.currentTimeframe =
    state.selectedTimeframe;
}


/* ============================================================
   EXISTING UI
   ============================================================ */

function initializeExistingUI() {

  const market =
    $("market") ||
    $("symbol") ||
    $("instrument");

  if (market) {

    market.addEventListener(
      "change",
      async () => {

        const symbol = market.value;

        if (!symbol) return;

        state.userInteracted = true;

        const generation =
          ++state.analysisGeneration;

        state.selectedSymbol = symbol;

        /*
          Kill old signal immediately.
        */
        state.activeSignal = null;
        state.analysis = null;

        updateChosenPairDisplay();

        setWaitingState(
          `LOADING ${timeframeLabel(
            getSelectedTimeframe()
          )}`,
          `Loading ${marketName(symbol)}...`
        );

        subscribeToTicks(symbol);

        try {

          await loadTimeframeHistory(
            symbol,
            getSelectedTimeframe(),
            true
          );

          if (
            generation !== state.analysisGeneration
          ) return;

          await runPrecisionAnalysis(
            true,
            generation
          );

        } catch (error) {

          console.error(
            "Market change error:",
            error
          );

        }

      }
    );
  }

  /*
    Event delegation means dynamically created
    timeframe buttons also work.
  */
  document.addEventListener(
    "click",
    event => {

      const button =
        event.target.closest(
          "[data-timeframe]"
        );

      if (!button) return;

      event.preventDefault();

      const tf =
        normalizeTimeframe(
          button.dataset.timeframe ||
          button.textContent
        );

      if (tf) {

        selectTimeframe(tf);

      }

    }
  );

  const timeframeSelect =
    $("timeframe") ||
    $("timeframeSelect");

  if (timeframeSelect) {

    timeframeSelect.addEventListener(
      "change",
      () => {

        const tf =
          normalizeTimeframe(
            timeframeSelect.value
          );

        if (tf) {
          selectTimeframe(tf);
        }

      }
    );
  }

  const analyzeButton =
    $("analyze") ||
    $("analyzeBtn") ||
    $("analyzeButton");

  if (analyzeButton) {

    analyzeButton.addEventListener(
      "click",
      () => {

        runPrecisionAnalysis(true);

      }
    );
  }
}


/* ============================================================
   TIMEFRAME SELECTION
   ============================================================ */

async function selectTimeframe(tf) {

  tf = normalizeTimeframe(tf);

  if (!tf) return;

  const symbol = getSelectedSymbol();

  /*
    NEW GENERATION:
    Every old analysis is now invalid.
  */
  const generation =
    ++state.analysisGeneration;

  state.selectedTimeframe = tf;

  window.currentTimeframe = tf;

  /*
    NEVER carry M5/M15/H1 signal into another TF.
  */
  state.activeSignal = null;
  state.analysis = null;

  updateTimeframeButtons();

  updateChosenPairDisplay();

  if (!symbol) {

    setWaitingState(
      `WAITING — ${timeframeLabel(tf)}`,
      `Choose a market for ${timeframeLabel(tf)} analysis.`
    );

    return;
  }

  setWaitingState(
    `LOADING ${timeframeLabel(tf)}`,
    `Loading ${marketName(symbol)} — ${timeframeLabel(tf)}...`
  );

  try {

    /*
      EXACT selected timeframe.
    */
    await loadTimeframeHistory(
      symbol,
      tf,
      true
    );

    /*
      User may have clicked another TF
      while loading.
    */
    if (
      generation !== state.analysisGeneration
    ) return;

    await runPrecisionAnalysis(
      true,
      generation
    );

  } catch (error) {

    if (
      generation !== state.analysisGeneration
    ) return;

    console.error(
      "Timeframe selection error:",
      error
    );

    setWaitingState(
      `WAIT — ${timeframeLabel(tf)}`,
      `Waiting for ${marketName(symbol)} ${timeframeLabel(tf)} data.`
    );
  }
}


/* ============================================================
   UPDATE TIMEFRAME BUTTONS
   ============================================================ */

function updateTimeframeButtons() {

  const selected =
    getSelectedTimeframe();

  document
    .querySelectorAll("[data-timeframe]")
    .forEach(button => {

      const tf =
        normalizeTimeframe(
          button.dataset.timeframe ||
          button.textContent
        );

      const active =
        tf === selected;

      button.classList.toggle(
        "active",
        active
      );

      button.setAttribute(
        "aria-selected",
        active ? "true" : "false"
      );
    });

  const select =
    $("timeframe") ||
    $("timeframeSelect");

  if (select) {

    select.value = selected;

  }
}


/* ============================================================
   CHOSEN PAIR DISPLAY
   ============================================================ */

function updateChosenPairDisplay() {

  const symbol =
    getSelectedSymbol();

  const tf =
    getSelectedTimeframe();

  const text =
    `${marketName(symbol)} — ${timeframeLabel(tf)}`;

  const selectors = [
    "chosenPair",
    "chosenPairDisplay",
    "selectedPair",
    "selectedMarket",
    "currentMarket"
  ];

  selectors
    .map(id => $(id))
    .filter(Boolean)
    .forEach(el => {

      el.textContent = text;

    });

  document
    .querySelectorAll(
      "[data-chosen-pair]"
    )
    .forEach(el => {

      el.textContent = text;

    });

  window.currentSymbol = symbol;

  window.currentTimeframe = tf;
}


/* ============================================================
   DERIV CONNECTION
   ============================================================ */

function connectDeriv() {

  clearTimeout(
    state.reconnectTimer
  );

  setConnectionStatus(
    false,
    "Connecting to Deriv..."
  );

  try {

    state.ws =
      new WebSocket(
        CONFIG.DERIV_WS
      );

  } catch (error) {

    console.error(error);

    scheduleReconnect();

    return;
  }

  state.ws.onopen = () => {

    state.connected = true;

    state.reconnectDelay =
      CONFIG.RECONNECT_MIN;

    setConnectionStatus(
      true,
      "LIVE — Deriv Connected"
    );

    requestActiveSymbols();

  };

  state.ws.onmessage = event => {

    try {

      const data =
        JSON.parse(event.data);

      handleDerivMessage(data);

    } catch (error) {

      console.error(
        "Deriv message error:",
        error
      );
    }
  };

  state.ws.onerror = error => {

    console.error(
      "Deriv WebSocket error:",
      error
    );

    setConnectionStatus(
      false,
      "Deriv connection error"
    );
  };

  state.ws.onclose = () => {

    state.connected = false;

    setConnectionStatus(
      false,
      "Reconnecting to Deriv..."
    );

    rejectPendingHistory(
      new Error(
        "Deriv WebSocket disconnected."
      )
    );

    scheduleReconnect();

  };
}


/* ============================================================
   RECONNECT
   ============================================================ */

function scheduleReconnect() {

  clearTimeout(
    state.reconnectTimer
  );

  state.reconnectTimer =
    setTimeout(() => {

      connectDeriv();

    }, state.reconnectDelay);

  state.reconnectDelay =
    Math.min(
      state.reconnectDelay * 2,
      CONFIG.RECONNECT_MAX
    );
}


/* ============================================================
   CONNECTION UI
   ============================================================ */

function setConnectionStatus(
  connected,
  text
) {

  const label =
    $("connectionText");

  if (label) {
    label.textContent = text;
  }

  const dot =
    document.querySelector(
      ".status-dot"
    );

  if (dot) {

    dot.classList.toggle(
      "connected",
      connected
    );

  }
}


/* ============================================================
   DERIV REQUEST
   ============================================================ */

function sendDerivRequest(payload) {

  return new Promise(
    (resolve, reject) => {

      if (
        !state.ws ||
        state.ws.readyState !== WebSocket.OPEN
      ) {

        reject(
          new Error(
            "Deriv WebSocket is not connected."
          )
        );

        return;
      }

      const reqId =
        ++state.requestCounter;

      payload.req_id = reqId;

      state.ws.send(
        JSON.stringify(payload)
      );

      /*
        Generic requests don't need a promise
        unless the caller handles the response.
      */
    }
  );
}


/* ============================================================
   ACTIVE SYMBOLS
   ============================================================ */

function requestActiveSymbols() {

  if (
    !state.ws ||
    state.ws.readyState !== WebSocket.OPEN
  ) return;

  state.ws.send(
    JSON.stringify({
      active_symbols: "brief",
      req_id: ++state.requestCounter
    })
  );
}


/* ============================================================
   DERIV MESSAGE HANDLER
   ============================================================ */

function handleDerivMessage(data) {

  if (
    data.active_symbols
  ) {

    handleActiveSymbols(
      data.active_symbols
    );

    return;
  }

  if (
    data.history ||
    data.candles
  ) {

    handleCandleResponse(data);

    return;
  }

  if (
    data.tick
  ) {

    handleTick(
      data.tick
    );

    return;
  }

  if (
    data.error
  ) {

    console.error(
      "Deriv API error:",
      data.error
    );

    const reqId =
      data.req_id;

    if (
      reqId &&
      state.pendingHistory.has(reqId)
    ) {

      const pending =
        state.pendingHistory.get(
          reqId
        );

      state.pendingHistory.delete(
        reqId
      );

      clearTimeout(
        pending.timeout
      );

      pending.reject(
        new Error(
          data.error.message ||
          "Deriv API error"
        )
      );
    }
  }
}


/* ============================================================
   ACTIVE SYMBOL NORMALIZATION
   ============================================================ */

function handleActiveSymbols(raw) {

  state.symbols =
    (raw || [])
      .map(item => {

        const symbol =
          item.underlying_symbol ||
          item.symbol;

        if (!symbol) return null;

        return {
          symbol,

          display_name:
            item.underlying_symbol_name ||
            item.display_name ||
            symbol,

          name:
            item.underlying_symbol_name ||
            item.display_name ||
            symbol,

          symbol_type:
            item.underlying_symbol_type ||
            item.symbol_type ||
            ""
        };

      })
      .filter(Boolean);

  populateMarketSelect();

  const current =
    getSelectedSymbol();

  if (current) {

    state.selectedSymbol =
      current;

    subscribeToTicks(
      current
    );

    updateChosenPairDisplay();

    loadTimeframeHistory(
      current,
      getSelectedTimeframe(),
      false
    ).then(() => {

      runPrecisionAnalysis(
        false
      );

    }).catch(() => {});

  }
}


/* ============================================================
   MARKET SELECT
   ============================================================ */

function populateMarketSelect() {

  const select =
    $("market") ||
    $("symbol") ||
    $("instrument");

  if (!select) return;

  const previous =
    state.selectedSymbol ||
    select.value;

  select.innerHTML = "";

  const groups = {};

  state.symbols.forEach(item => {

    const type =
      item.symbol_type ||
      "Other";

    if (!groups[type]) {
      groups[type] = [];
    }

    groups[type].push(item);

  });

  Object
    .keys(groups)
    .sort()
    .forEach(type => {

      const optgroup =
        document.createElement(
          "optgroup"
        );

      optgroup.label =
        formatSymbolGroup(type);

      groups[type]
        .sort((a, b) =>
          a.display_name.localeCompare(
            b.display_name
          )
        )
        .forEach(item => {

          const option =
            document.createElement(
              "option"
            );

          option.value =
            item.symbol;

          option.textContent =
            item.display_name;

          optgroup.appendChild(
            option
          );

        });

      select.appendChild(
        optgroup
      );

    });

  if (
    previous &&
    state.symbols.some(
      s => s.symbol === previous
    )
  ) {

    select.value =
      previous;

  } else if (state.symbols.length) {

    select.value =
      state.symbols[0].symbol;

  }

  state.selectedSymbol =
    select.value || "";

  updateChosenPairDisplay();
}


/* ============================================================
   SYMBOL GROUP LABEL
   ============================================================ */

function formatSymbolGroup(type) {

  const text =
    String(type || "Other");

  const upper =
    text.toUpperCase();

  if (
    upper.includes("FOREX")
  ) return "FOREX";

  if (
    upper.includes("CRYPTO")
  ) return "CRYPTO";

  if (
    upper.includes("STOCK") ||
    upper.includes("INDEX")
  ) return "INDICES";

  if (
    upper.includes("METAL")
  ) return "METALS";

  if (
    upper.includes("SYNTHETIC")
  ) return "DERIV SYNTHETIC INDICES";

  return text;
}


/* ============================================================
   TICK SUBSCRIPTION
   ============================================================ */

function subscribeToTicks(symbol) {

  if (
    !state.ws ||
    state.ws.readyState !== WebSocket.OPEN ||
    !symbol
  ) return;

  try {

    state.ws.send(
      JSON.stringify({
        forget_all: "ticks"
      })
    );

    state.ws.send(
      JSON.stringify({
        ticks: symbol,
        subscribe: 1,
        req_id: ++state.requestCounter
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
   LIVE TICK
   ============================================================ */

function handleTick(tick) {

  const symbol =
    tick.symbol;

  const price =
    safeNumber(
      tick.quote
    );

  if (!symbol || price === null) {
    return;
  }

  state.ticks[symbol] = {
    price,
    epoch:
      safeNumber(
        tick.epoch,
        Math.floor(
          Date.now() / 1000
        )
      )
  };

  if (
    symbol === getSelectedSymbol()
  ) {

    state.livePrice =
      price;

    window.currentPrice =
      price;

    updateLivePrice(
      price
    );

    checkSignalInvalidation();

  }
}


/* ============================================================
   LIVE PRICE UI
   ============================================================ */

function updateLivePrice(price) {

  const ids = [
    "price",
    "livePrice",
    "currentPrice"
  ];

  ids
    .map(id => $(id))
    .filter(Boolean)
    .forEach(el => {

      el.textContent =
        formatPrice(price);

    });
}

function formatPrice(price) {

  if (!Number.isFinite(price)) {
    return "—";
  }

  if (
    Math.abs(price) >= 1000
  ) {

    return price.toFixed(2);

  }

  if (
    Math.abs(price) >= 100
  ) {

    return price.toFixed(3);

  }

  if (
    Math.abs(price) >= 10
  ) {

    return price.toFixed(4);

  }

  return price.toFixed(5);
}


/* ============================================================
   LOAD EXACT TIMEFRAME HISTORY
   ============================================================ */

function loadTimeframeHistory(
  symbol,
  timeframe,
  force = false
) {

  timeframe =
    normalizeTimeframe(timeframe);

  if (
    !symbol ||
    !timeframe
  ) {

    return Promise.reject(
      new Error(
        "Missing symbol or timeframe."
      )
    );
  }

  const key =
    `${symbol}|${timeframe}`;

  if (
    !force &&
    state.candles[symbol]?.[timeframe]
      ?.candles?.length
  ) {

    return Promise.resolve(
      state.candles[symbol][timeframe]
    );

  }

  if (
    state.pendingHistoryByKey &&
    state.pendingHistoryByKey.has(key)
  ) {

    return state.pendingHistoryByKey.get(
      key
    );

  }

  if (!state.pendingHistoryByKey) {
    state.pendingHistoryByKey =
      new Map();
  }

  const promise =
    new Promise(
      (resolve, reject) => {

        if (
          !state.ws ||
          state.ws.readyState !== WebSocket.OPEN
        ) {

          reject(
            new Error(
              "Deriv is not connected."
            )
          );

          return;
        }

        const reqId =
          ++state.requestCounter;

        const granularity =
          CONFIG.TIMEFRAMES[
            timeframe
          ];

        const timeout =
          setTimeout(() => {

            state.pendingHistory.delete(
              reqId
            );

            state.pendingHistoryByKey.delete(
              key
            );

            reject(
              new Error(
                `History timeout: ${symbol} ${timeframe}`
              )
            );

          }, CONFIG.HISTORY_TIMEOUT);

        state.pendingHistory.set(
          reqId,
          {
            symbol,
            timeframe,
            key,
            timeout,
            resolve,
            reject
          }
        );

        try {

          state.ws.send(
            JSON.stringify({
              ticks_history:
                symbol,

              style:
                "candles",

              granularity,

              count:
                CONFIG.HISTORY_COUNT,

              end:
                "latest",

              req_id:
                reqId
            })
          );

        } catch (error) {

          clearTimeout(
            timeout
          );

          state.pendingHistory.delete(
            reqId
          );

          reject(error);
        }
      }
    ).finally(() => {

      if (
        state.pendingHistoryByKey
      ) {

        state.pendingHistoryByKey.delete(
          key
        );

      }

    });

  state.pendingHistoryByKey.set(
    key,
    promise
  );

  return promise;
}


/* ============================================================
   HANDLE CANDLE RESPONSE
   ============================================================ */

function handleCandleResponse(data) {

  const reqId =
    data.req_id;

  if (
    !reqId ||
    !state.pendingHistory.has(reqId)
  ) {

    return;
  }

  const pending =
    state.pendingHistory.get(
      reqId
    );

  state.pendingHistory.delete(
    reqId
  );

  clearTimeout(
    pending.timeout
  );

  const raw =
    data.candles ||
    data.history?.candles ||
    [];

  const candles =
    raw
      .map(c => {

        const open =
          safeNumber(c.open);

        const high =
          safeNumber(c.high);

        const low =
          safeNumber(c.low);

        const close =
          safeNumber(c.close);

        const epoch =
          safeNumber(c.epoch);

        if (
          [open, high, low, close, epoch]
            .some(
              v => v === null
            )
        ) {

          return null;

        }

        return {
          epoch,
          open,
          high,
          low,
          close
        };

      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.epoch - b.epoch
      );

  if (!state.candles[pending.symbol]) {

    state.candles[pending.symbol] =
      {};
  }

  state.candles[pending.symbol][
    pending.timeframe
  ] = {

    candles,

    updatedAt:
      Date.now()
  };

  if (
    pending.symbol ===
      getSelectedSymbol() &&
    pending.timeframe ===
      getSelectedTimeframe()
  ) {

    window.closedCandles =
      getClosedCandles(
        pending.symbol,
        pending.timeframe
      );
  }

  pending.resolve(
    state.candles[pending.symbol][
      pending.timeframe
    ]
  );
}


/* ============================================================
   REJECT PENDING HISTORY
   ============================================================ */

function rejectPendingHistory(
  error
) {

  for (
    const [
      reqId,
      pending
    ] of state.pendingHistory
  ) {

    clearTimeout(
      pending.timeout
    );

    pending.reject(
      error
    );

    state.pendingHistory.delete(
      reqId
    );
  }

  if (
    state.pendingHistoryByKey
  ) {

    state.pendingHistoryByKey.clear();

  }
}


/* ============================================================
   GET CLOSED CANDLES
   ============================================================ */

function getClosedCandles(
  symbol,
  timeframe
) {

  timeframe =
    normalizeTimeframe(
      timeframe
    );

  const entry =
    state.candles[
      symbol
    ]?.[
      timeframe
    ];

  if (
    !entry?.candles?.length
  ) {

    return [];

  }

  const duration =
    CONFIG.TIMEFRAMES[
      timeframe
    ];

  const now =
    Math.floor(
      Date.now() / 1000
    );

  return entry.candles
    .filter(
      candle =>
        candle.epoch +
          duration <=
        now
    )
    .slice();
}


/* ============================================================
   AVERAGE RANGE
   ============================================================ */

function getAverageRange(
  candles,
  count = 50
) {

  const source =
    candles.slice(
      Math.max(
        0,
        candles.length - count
      )
    );

  if (!source.length) {
    return 0;
  }

  return (
    source.reduce(
      (sum, c) =>
        sum +
        Math.max(
          0,
          c.high - c.low
        ),
      0
    ) /
    source.length
  );
}


/* ============================================================
   SWING DETECTION
   Depth 30 / Deviation 5 / Backstep 5
   ============================================================ */

function detectSwings(
  candles
) {

  const swings = [];

  const depth =
    Math.min(
      CONFIG.DEPTH,
      Math.max(
        3,
        Math.floor(
          (candles.length - 1) /
            2
        )
      )
    );

  if (
    candles.length <
    depth * 2 + 5
  ) {

    return swings;
  }

  for (
    let i = depth;
    i <
      candles.length - depth;
    i++
  ) {

    const candle =
      candles[i];

    let isHigh = true;
    let isLow = true;

    for (
      let j = 1;
      j <= depth;
      j++
    ) {

      if (
        candle.high <=
          candles[i - j].high ||
        candle.high <
          candles[i + j].high
      ) {

        isHigh = false;

      }

      if (
        candle.low >=
          candles[i - j].low ||
        candle.low >
          candles[i + j].low
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

    const avgRange =
      getAverageRange(
        candles.slice(
          Math.max(
            0,
            i - 50
          ),
          i
        )
      );

    const deviationThreshold =
      avgRange *
      (CONFIG.DEVIATION / 5);

    if (isHigh) {

      const leftLow =
        Math.min(
          ...candles
            .slice(
              Math.max(
                0,
                i - depth
              ),
              i
            )
            .map(
              c => c.low
            )
        );

      const rightLow =
        Math.min(
          ...candles
            .slice(
              i + 1,
              i + depth + 1
            )
            .map(
              c => c.low
            )
        );

      const prominence =
        Math.min(
          candle.high -
            leftLow,
          candle.high -
            rightLow
        );

      if (
        prominence >=
        deviationThreshold
      ) {

        addSwingWithBackstep(
          swings,
          {
            type: "HIGH",
            price: candle.high,
            epoch: candle.epoch,
            index: i
          }
        );

      }
    }

    if (isLow) {

      const leftHigh =
        Math.max(
          ...candles
            .slice(
              Math.max(
                0,
                i - depth
              ),
              i
            )
            .map(
              c => c.high
            )
        );

      const rightHigh =
        Math.max(
          ...candles
            .slice(
              i + 1,
              i + depth + 1
            )
            .map(
              c => c.high
            )
        );

      const prominence =
        Math.min(
          leftHigh -
            candle.low,
          rightHigh -
            candle.low
        );

      if (
        prominence >=
        deviationThreshold
      ) {

        addSwingWithBackstep(
          swings,
          {
            type: "LOW",
            price: candle.low,
            epoch: candle.epoch,
            index: i
          }
        );

      }
    }
  }

  return swings.sort(
    (a, b) =>
      a.epoch - b.epoch
  );
}


/* ============================================================
   BACKSTEP FILTER
   ============================================================ */

function addSwingWithBackstep(
  swings,
  candidate
) {

  const last =
    swings[
      swings.length - 1
    ];

  if (
    !last ||
    candidate.index -
      last.index >
      CONFIG.BACKSTEP
  ) {

    swings.push(
      candidate
    );

    return;
  }

  if (
    candidate.type !==
    last.type
  ) {

    swings.push(
      candidate
    );

    return;
  }

  if (
    candidate.type ===
      "HIGH" &&
    candidate.price >
      last.price
  ) {

    swings[
      swings.length - 1
    ] = candidate;

  }

  if (
    candidate.type ===
      "LOW" &&
    candidate.price <
      last.price
  ) {

    swings[
      swings.length - 1
    ] = candidate;

  }
}


/* ============================================================
   STRUCTURE CLASSIFICATION
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

  const labels = [];

  for (
    let i = 1;
    i < highs.length;
    i++
  ) {

    labels.push(
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

    labels.push(
      lows[i].price >
        lows[i - 1].price
        ? "HL"
        : "LL"
    );

  }

  const recent =
    labels.slice(-8);

  const bullish =
    recent.filter(
      x =>
        x === "HH" ||
        x === "HL"
    ).length;

  const bearish =
    recent.filter(
      x =>
        x === "LH" ||
        x === "LL"
    ).length;

  let bias =
    "NEUTRAL";

  if (
    bullish >= bearish + 2
  ) {

    bias = "BULLISH";

  } else if (
    bearish >= bullish + 2
  ) {

    bias = "BEARISH";

  }

  return {
    bias,
    labels: recent,
    highs,
    lows
  };
}


/* ============================================================
   STRUCTURE EVENTS
   ============================================================ */

function detectStructureEvents(
  candles,
  swings
) {

  if (
    candles.length < 3 ||
    swings.length < 2
  ) {

    return {
      bos: null,
      choch: null
    };
  }

  const lastClose =
    candles[
      candles.length - 1
    ].close;

  const recentHigh =
    [...swings]
      .reverse()
      .find(
        s => s.type === "HIGH"
      );

  const recentLow =
    [...swings]
      .reverse()
      .find(
        s => s.type === "LOW"
      );

  let bos = null;
  let choch = null;

  if (
    recentHigh &&
    lastClose >
      recentHigh.price
  ) {

    bos = "BULLISH";

  }

  if (
    recentLow &&
    lastClose <
      recentLow.price
  ) {

    bos = "BEARISH";

  }

  const structure =
    classifyStructure(
      swings
    );

  if (
    bos === "BULLISH" &&
    structure.bias === "BEARISH"
  ) {

    choch = "BULLISH";

  }

  if (
    bos === "BEARISH" &&
    structure.bias === "BULLISH"
  ) {

    choch = "BEARISH";

  }

  return {
    bos,
    choch
  };
}


/* ============================================================
   LIQUIDITY SWEEP
   ============================================================ */

function detectLiquidity(
  candles,
  swings
) {

  if (
    candles.length < 3
  ) {

    return {
      direction: null,
      level: null
    };
  }

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

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

  const lastLow =
    lows[lows.length - 1];

  if (
    lastHigh &&
    current.high >
      lastHigh.price &&
    current.close <
      lastHigh.price
  ) {

    return {
      direction: "BEARISH",
      type: "BUY_SIDE_SWEEP",
      level: lastHigh.price
    };
  }

  if (
    lastLow &&
    current.low <
      lastLow.price &&
    current.close >
      lastLow.price
  ) {

    return {
      direction: "BULLISH",
      type: "SELL_SIDE_SWEEP",
      level: lastLow.price
    };
  }

  /*
    Wick rejection fallback.
  */
  if (
    lastHigh &&
    previous.high >
      lastHigh.price &&
    current.close <
      previous.close
  ) {

    return {
      direction: "BEARISH",
      type: "HIGH_REJECTION",
      level: lastHigh.price
    };
  }

  if (
    lastLow &&
    previous.low <
      lastLow.price &&
    current.close >
      previous.close
  ) {

    return {
      direction: "BULLISH",
      type: "LOW_REJECTION",
      level: lastLow.price
    };
  }

  return {
    direction: null,
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

  const price =
    candles[
      candles.length - 1
    ].close;

  const lows =
    swings
      .filter(
        s => s.type === "LOW"
      )
      .map(
        s => s.price
      );

  const highs =
    swings
      .filter(
        s => s.type === "HIGH"
      )
      .map(
        s => s.price
      );

  const supports =
    lows.filter(
      p => p <= price
    );

  const resistances =
    highs.filter(
      p => p >= price
    );

  return {
    support:
      supports.length
        ? Math.max(
            ...supports
          )
        : null,

    resistance:
      resistances.length
        ? Math.min(
            ...resistances
          )
        : null
  };
}


/* ============================================================
   SUPPLY / DEMAND
   ============================================================ */

function detectSupplyDemand(
  candles
) {

  if (
    candles.length < 8
  ) {

    return {
      demand: null,
      supply: null
    };
  }

  const avgRange =
    getAverageRange(
      candles,
      50
    );

  const zones = [];

  for (
    let i =
      Math.max(
        2,
        candles.length - 30
      );
    i <
      candles.length - 2;
    i++
  ) {

    const base =
      candles[i];

    const next =
      candles[i + 1];

    const move =
      next.close -
      base.close;

    if (
      Math.abs(move) >=
      avgRange * 1.3
    ) {

      if (
        move > 0
      ) {

        zones.push({
          type: "DEMAND",
          low: base.low,
          high: base.high,
          index: i
        });

      } else {

        zones.push({
          type: "SUPPLY",
          low: base.low,
          high: base.high,
          index: i
        });

      }
    }
  }

  return {
    demand:
      [...zones]
        .reverse()
        .find(
          z => z.type === "DEMAND"
        ) || null,

    supply:
      [...zones]
        .reverse()
        .find(
          z => z.type === "SUPPLY"
        ) || null
  };
}


/* ============================================================
   ORDER BLOCK
   ============================================================ */

function detectOrderBlock(
  candles
) {

  if (
    candles.length < 6
  ) {

    return null;
  }

  const avgRange =
    getAverageRange(
      candles,
      50
    );

  for (
    let i =
      candles.length - 4;
    i >=
      Math.max(
        1,
        candles.length - 12
      );
    i--
  ) {

    const base =
      candles[i];

    const next =
      candles[i + 1];

    const displacement =
      Math.abs(
        next.close -
        next.open
      );

    if (
      displacement <
      avgRange * 1.2
    ) {

      continue;
    }

    if (
      next.close >
      next.open &&
      base.close <
      base.open
    ) {

      return {
        type: "BULLISH",
        low: base.low,
        high: base.high,
        midpoint:
          (
            base.low +
            base.high
          ) / 2
      };
    }

    if (
      next.close <
      next.open &&
      base.close >
      base.open
    ) {

      return {
        type: "BEARISH",
        low: base.low,
        high: base.high,
        midpoint:
          (
            base.low +
            base.high
          ) / 2
      };
    }
  }

  return null;
}


/* ============================================================
   FVG
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

  if (
    c.low > a.high &&
    b.close > b.open
  ) {

    return {
      type: "BULLISH",
      low: a.high,
      high: c.low,
      midpoint:
        (
          a.high +
          c.low
        ) / 2
    };
  }

  if (
    c.high < a.low &&
    b.close < b.open
  ) {

    return {
      type: "BEARISH",
      low: c.high,
      high: a.low,
      midpoint:
        (
          c.high +
          a.low
        ) / 2
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
    candles.length < 3
  ) {

    return {
      direction: null,
      pattern: null,
      confirmed: false
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

  const range =
    Math.max(
      c.high - c.low,
      0.00000001
    );

  const body =
    Math.abs(
      c.close -
      c.open
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

  /*
    Bullish engulfing
  */
  if (
    p.close < p.open &&
    c.close > c.open &&
    c.open <= p.close &&
    c.close >= p.open
  ) {

    return {
      direction: "BULLISH",
      pattern: "Bullish Engulfing",
      confirmed: true
    };
  }

  /*
    Bearish engulfing
  */
  if (
    p.close > p.open &&
    c.close < c.open &&
    c.open >= p.close &&
    c.close <= p.open
  ) {

    return {
      direction: "BEARISH",
      pattern: "Bearish Engulfing",
      confirmed: true
    };
  }

  /*
    Bullish rejection
  */
  if (
    lowerWick >= body * 2 &&
    lowerWick >= range * 0.45 &&
    c.close > c.open
  ) {

    return {
      direction: "BULLISH",
      pattern: "Bullish Rejection",
      confirmed: true
    };
  }

  /*
    Bearish rejection
  */
  if (
    upperWick >= body * 2 &&
    upperWick >= range * 0.45 &&
    c.close < c.open
  ) {

    return {
      direction: "BEARISH",
      pattern: "Bearish Rejection",
      confirmed: true
    };
  }

  return {
    direction: null,
    pattern: null,
    confirmed: false
  };
}


/* ============================================================
   DISPLACEMENT
   ============================================================ */

function detectDisplacement(
  candles
) {

  if (
    candles.length < 5
  ) return null;

  const current =
    candles[
      candles.length - 1
    ];

  const avg =
    getAverageRange(
      candles.slice(
        0,
        -1
      ),
      30
    );

  const range =
    current.high -
    current.low;

  if (
    range <
    avg * 1.4
  ) {

    return null;
  }

  if (
    current.close >
    current.open
  ) {

    return "BULLISH";
  }

  if (
    current.close <
    current.open
  ) {

    return "BEARISH";
  }

  return null;
}


/* ============================================================
   ANALYZE ONE TIMEFRAME
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
    candles.length <
    CONFIG.DEPTH * 2 + 10
  ) {

    return {
      symbol,
      timeframe,
      ready: false,
      candles
    };
  }

  const swings =
    detectSwings(
      candles
    );

  const structure =
    classifyStructure(
      swings
    );

  const events =
    detectStructureEvents(
      candles,
      swings
    );

  const liquidity =
    detectLiquidity(
      candles,
      swings
    );

  const sr =
    detectSupportResistance(
      candles,
      swings
    );

  const supplyDemand =
    detectSupplyDemand(
      candles
    );

  const orderBlock =
    detectOrderBlock(
      candles
    );

  const fvg =
    detectFVG(
      candles
    );

  const candle =
    detectCandlestickConfirmation(
      candles
    );

  const displacement =
    detectDisplacement(
      candles
    );

  return {

    symbol,

    timeframe,

    ready: true,

    candles,

    price:
      candles[
        candles.length - 1
      ].close,

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

async function buildTopDownAnalysis(
  symbol,
  executionTimeframe,
  generation
) {

  /*
    Selected timeframe is ALWAYS execution.
  */

  const required = [
    executionTimeframe,
    "H1",
    "H4",
    "Daily"
  ];

  const unique =
    [...new Set(
      required
    )];

  await Promise.all(
    unique.map(
      tf =>
        loadTimeframeHistory(
          symbol,
          tf,
          false
        )
    )
  );

  if (
    generation != null &&
    generation !==
      state.analysisGeneration
  ) {

    return null;
  }

  const execution =
    analyzeTimeframe(
      symbol,
      executionTimeframe
    );

  const h1 =
    analyzeTimeframe(
      symbol,
      "H1"
    );

  const h4 =
    analyzeTimeframe(
      symbol,
      "H4"
    );

  const daily =
    analyzeTimeframe(
      symbol,
      "Daily"
    );

  return {

    symbol,

    timeframe:
      executionTimeframe,

    execution,

    h1,

    h4,

    daily,

    htfBias:
      getHTFBias(
        daily,
        h4,
        h1
      ),

    generatedAt:
      Date.now()
  };
}


/* ============================================================
   HTF BIAS
   ============================================================ */

function getHTFBias(
  daily,
  h4,
  h1
) {

  const scores = {
    BULLISH: 0,
    BEARISH: 0
  };

  [
    daily,
    h4,
    h1
  ].forEach(tf => {

    if (
      tf?.structure?.bias ===
      "BULLISH"
    ) {

      scores.BULLISH++;

    }

    if (
      tf?.structure?.bias ===
      "BEARISH"
    ) {

      scores.BEARISH++;

    }

  });

  if (
    scores.BULLISH >
    scores.BEARISH
  ) {

    return "BULLISH";
  }

  if (
    scores.BEARISH >
    scores.BULLISH
  ) {

    return "BEARISH";
  }

  return "NEUTRAL";
}


/* ============================================================
   DETERMINE DIRECTION
   ============================================================ */

function determineDirection(
  execution,
  htfBias
) {

  if (!execution) {
    return null;
  }

  let bullish = 0;
  let bearish = 0;

  if (
    execution.structure?.bias ===
    "BULLISH"
  ) bullish += 2;

  if (
    execution.structure?.bias ===
    "BEARISH"
  ) bearish += 2;

  if (
    execution.events?.bos ===
    "BULLISH"
  ) bullish += 3;

  if (
    execution.events?.bos ===
    "BEARISH"
  ) bearish += 3;

  if (
    execution.events?.choch ===
    "BULLISH"
  ) bullish += 3;

  if (
    execution.events?.choch ===
    "BEARISH"
  ) bearish += 3;

  if (
    execution.liquidity?.direction ===
    "BULLISH"
  ) bullish += 2;

  if (
    execution.liquidity?.direction ===
    "BEARISH"
  ) bearish += 2;

  if (
    execution.displacement ===
    "BULLISH"
  ) bullish += 2;

  if (
    execution.displacement ===
    "BEARISH"
  ) bearish += 2;

  if (
    execution.candle?.direction ===
    "BULLISH"
  ) bullish += 2;

  if (
    execution.candle?.direction ===
    "BEARISH"
  ) bearish += 2;

  if (
    execution.fvg?.type ===
    "BULLISH"
  ) bullish++;

  if (
    execution.fvg?.type ===
    "BEARISH"
  ) bearish++;

  if (
    execution.orderBlock?.type ===
    "BULLISH"
  ) bullish++;

  if (
    execution.orderBlock?.type ===
    "BEARISH"
  ) bearish++;

  /*
    HTF bias is context, not a mandatory
    requirement for an early signal.
  */
  if (
    htfBias ===
    "BULLISH"
  ) bullish++;

  if (
    htfBias ===
    "BEARISH"
  ) bearish++;

  if (
    bullish >
      bearish &&
    bullish >= 4
  ) {

    return "BUY";
  }

  if (
    bearish >
      bullish &&
    bearish >= 4
  ) {

    return "SELL";
  }

  return null;
}


/* ============================================================
   SCORE EVIDENCE
   ============================================================ */

function scoreEvidence(
  execution,
  direction,
  htfBias
) {

  if (
    !execution ||
    !direction
  ) {

    return {
      score: 0,
      confirmations: []
    };
  }

  const bullish =
    direction === "BUY";

  const confirmations = [];

  let score = 0;

  const structureDirection =
    bullish
      ? "BULLISH"
      : "BEARISH";

  if (
    execution.structure?.bias ===
    structureDirection
  ) {

    score += 2;

    confirmations.push(
      "Structure"
    );
  }

  if (
    execution.events?.bos ===
    structureDirection
  ) {

    score += 3;

    confirmations.push(
      "BOS"
    );
  }

  if (
    execution.events?.choch ===
    structureDirection
  ) {

    score += 3;

    confirmations.push(
      "CHoCH/MSS"
    );
  }

  if (
    execution.liquidity?.direction ===
    structureDirection
  ) {

    score += 2;

    confirmations.push(
      "Liquidity Sweep"
    );
  }

  if (
    execution.displacement ===
    structureDirection
  ) {

    score += 2;

    confirmations.push(
      "Displacement"
    );
  }

  if (
    execution.fvg?.type ===
    structureDirection
  ) {

    score += 2;

    confirmations.push(
      "FVG"
    );
  }

  if (
    execution.orderBlock?.type ===
    structureDirection
  ) {

    score += 2;

    confirmations.push(
      "Order Block"
    );
  }

  if (
    execution.candle?.direction ===
    structureDirection &&
    execution.candle.confirmed
  ) {

    score += 2;

    confirmations.push(
      "Candle Confirmation"
    );
  }

  if (
    (
      bullish &&
      htfBias === "BULLISH"
    ) ||
    (
      !bullish &&
      htfBias === "BEARISH"
    )
  ) {

    score += 2;

    confirmations.push(
      "HTF Alignment"
    );
  }

  return {
    score,
    confirmations
  };
}


/* ============================================================
   GRADE SETUP
   ============================================================ */

function gradeSetup(
  execution,
  evidence,
  direction
) {

  if (
    !execution ||
    !direction
  ) {

    return null;
  }

  const score =
    evidence.score;

  const count =
    evidence.confirmations.length;

  const candleConfirmed =
    execution.candle?.confirmed &&
    execution.candle.direction ===
      (
        direction === "BUY"
          ? "BULLISH"
          : "BEARISH"
      );

  /*
    A+
  */
  if (
    score >= 11 &&
    count >= 6 &&
    candleConfirmed
  ) {

    return {
      grade: "A+",
      risk: "LOW",
      confidence: 95
    };
  }

  /*
    A
  */
  if (
    score >= 8 &&
    count >= 5
  ) {

    return {
      grade: "A",
      risk: "LOW",
      confidence: 88
    };
  }

  /*
    B
  */
  if (
    score >= 6 &&
    count >= 4
  ) {

    return {
      grade: "B",
      risk: "MEDIUM",
      confidence: 76
    };
  }

  /*
    C
  */
  if (
    score >= 4 &&
    count >= 3
  ) {

    return {
      grade: "C",
      risk: "HIGHER RISK",
      confidence: 63
    };
  }

  /*
    EARLY SETUP:
    Do NOT wait for candlestick confirmation.
  */
  const earlyTrigger =
    execution.events?.bos ||
    execution.events?.choch ||
    execution.liquidity?.direction ||
    execution.displacement;

  if (
    score >= 4 &&
    earlyTrigger
  ) {

    return {
      grade: "EARLY",
      risk: "EARLY / DEVELOPING",
      confidence: 55
    };
  }

  return null;
}


/* ============================================================
   TRADE LEVELS
   ============================================================ */

function calculateTradeLevels(
  execution,
  direction
) {

  if (
    !execution?.candles?.length
  ) {

    return null;
  }

  const price =
    execution.price;

  const swings =
    execution.swings || [];

  const lastLow =
    [...swings]
      .reverse()
      .find(
        s => s.type === "LOW"
      );

  const lastHigh =
    [...swings]
      .reverse()
      .find(
        s => s.type === "HIGH"
      );

  const avgRange =
    getAverageRange(
      execution.candles,
      30
    );

  if (
    !avgRange ||
    !Number.isFinite(price)
  ) {

    return null;
  }

  let entry = price;
  let sl;

  if (
    direction === "BUY"
  ) {

    sl =
      lastLow
        ? Math.min(
            lastLow.price,
            price -
              avgRange * 1.2
          )
        : price -
          avgRange * 1.2;

  } else {

    sl =
      lastHigh
        ? Math.max(
            lastHigh.price,
            price +
              avgRange * 1.2
          )
        : price +
          avgRange * 1.2;
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

  const tp1 =
    direction === "BUY"
      ? entry +
        risk * 2
      : entry -
        risk * 2;

  const tp2 =
    direction === "BUY"
      ? entry +
        risk * 3
      : entry -
        risk * 3;

  return {

    entry,

    sl,

    be:
      entry,

    tp1,

    tp2,

    rrTP1: 2,

    rrTP2: 3,

    riskPoints: risk,

    invalidation:
      direction === "BUY"
        ? `Close below ${formatPrice(sl)}`
        : `Close above ${formatPrice(sl)}`
  };
}


/* ============================================================
   GENERATE PRECISION SIGNAL
   ============================================================ */

function generatePrecisionSignal(
  symbol,
  timeframe,
  topDown
) {

  /*
    HARD TIMEFRAME LOCK.
  */

  if (
    !topDown ||
    !topDown.execution
  ) {

    return null;
  }

  if (
    topDown.execution.timeframe !==
    timeframe
  ) {

    console.warn(
      "Blocked wrong timeframe:",
      topDown.execution.timeframe,
      "requested:",
      timeframe
    );

    return null;
  }

  if (
    timeframe !==
    getSelectedTimeframe()
  ) {

    return null;
  }

  if (
    symbol !==
    getSelectedSymbol()
  ) {

    return null;
  }

  const execution =
    topDown.execution;

  const direction =
    determineDirection(
      execution,
      topDown.htfBias
    );

  if (!direction) {
    return null;
  }

  const evidence =
    scoreEvidence(
      execution,
      direction,
      topDown.htfBias
    );

  const grade =
    gradeSetup(
      execution,
      evidence,
      direction
    );

  if (!grade) {
    return null;
  }

  const levels =
    calculateTradeLevels(
      execution,
      direction
    );

  if (!levels) {
    return null;
  }

  /*
    Never allow RR below minimum.
  */
  if (
    levels.rrTP1 <
    CONFIG.MIN_RR
  ) {

    return null;
  }

  const explanation =
    buildAIExplanation(
      execution,
      topDown,
      direction,
      grade,
      evidence,
      levels
    );

  return {

    id:
      `${symbol}-${timeframe}-${direction}-${execution.candles.at(-1)?.epoch}`,

    symbol,

    market:
      marketName(symbol),

    timeframe,

    direction,

    grade:
      grade.grade,

    risk:
      grade.risk,

    confidence:
      grade.confidence,

    score:
      evidence.score,

    confirmations:
      evidence.confirmations,

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

    rrTP1:
      levels.rrTP1,

    rrTP2:
      levels.rrTP2,

    invalidation:
      levels.invalidation,

    htfBias:
      topDown.htfBias,

    structure:
      execution.structure?.bias ||
      "NEUTRAL",

    liquidity:
      execution.liquidity?.type ||
      "NONE",

    pattern:
      execution.candle?.pattern ||
      "NONE",

    displacement:
      execution.displacement ||
      "NONE",

    explanation,

    createdAt:
      Date.now()
  };
}


/* ============================================================
   AI EXPLANATION
   ============================================================ */

function buildAIExplanation(
  execution,
  topDown,
  direction,
  grade,
  evidence,
  levels
) {

  const side =
    direction === "BUY"
      ? "bullish"
      : "bearish";

  const tf =
    execution.timeframe;

  const reasons =
    evidence.confirmations
      .join(", ");

  return (
    `${grade.grade} ${direction} setup on ${tf}. ` +
    `The selected timeframe is the execution timeframe. ` +
    `HTF bias: ${topDown.htfBias}. ` +
    `Execution structure: ${
      execution.structure?.bias ||
      "NEUTRAL"
    }. ` +
    `Evidence: ${
      reasons || "developing"
    }. ` +
    `Current price is showing ${side} pressure. ` +
    `Entry: ${formatPrice(levels.entry)}. ` +
    `SL: ${formatPrice(levels.sl)}. ` +
    `TP1: ${formatPrice(levels.tp1)}. ` +
    `TP2: ${formatPrice(levels.tp2)}. ` +
    `Risk/Reward to TP2: 1:${levels.rrTP2}. ` +
    `This is an analytical setup, not a guarantee of profit.`
  );
}


/* ============================================================
   RUN PRECISION ANALYSIS
   ============================================================ */

async function runPrecisionAnalysis(
  force = false,
  suppliedGeneration = null
) {

  const symbol =
    getSelectedSymbol();

  const timeframe =
    getSelectedTimeframe();

  if (
    !symbol ||
    !timeframe
  ) return;

  const generation =
    suppliedGeneration ??
    ++state.analysisGeneration;

  state.analysisRunning =
    true;

  updateChosenPairDisplay();

  try {

    /*
      EXACT selected timeframe.
    */
    await loadTimeframeHistory(
      symbol,
      timeframe,
      force
    );

    if (
      generation !==
        state.analysisGeneration ||
      symbol !==
        getSelectedSymbol() ||
      timeframe !==
        getSelectedTimeframe()
    ) {

      return;
    }

    const topDown =
      await buildTopDownAnalysis(
        symbol,
        timeframe,
        generation
      );

    if (
      generation !==
        state.analysisGeneration ||
      !topDown
    ) {

      return;
    }

    const execution =
      topDown.execution;

    if (
      !execution?.ready
    ) {

      state.analysis =
        topDown;

      setWaitingState(
        `WAIT — ${timeframeLabel(timeframe)}`,
        `Not enough closed candles for ${marketName(symbol)} ${timeframeLabel(timeframe)}.`
      );

      return;
    }

    state.analysis =
      topDown;

    window.lastAnalysis =
      topDown;

    window.currentAnalysis =
      topDown;

    window.currentSymbol =
      symbol;

    window.currentTimeframe =
      timeframe;

    window.closedCandles =
      getClosedCandles(
        symbol,
        timeframe
      );

    const signal =
      generatePrecisionSignal(
        symbol,
        timeframe,
        topDown
      );

    /*
      NO SIGNAL
    */
    if (!signal) {

      checkSignalInvalidation();

      if (
        state.activeSignal &&
        state.activeSignal.symbol ===
          symbol &&
        state.activeSignal.timeframe ===
          timeframe
      ) {

        updateDashboard(
          state.activeSignal,
          topDown
        );

      } else {

        setWaitingState(
          `WAIT — NO CONFIRMED SETUP`,
          `${marketName(symbol)} — ${timeframeLabel(timeframe)}`
        );

      }

      return;
    }

    /*
      Final safety.
    */
    if (
      signal.timeframe !==
        timeframe ||
      signal.symbol !==
        symbol
    ) {

      console.warn(
        "Rejected stale signal."
      );

      return;
    }

    processSignal(
      signal
    );

    if (
      generation ===
        state.analysisGeneration &&
      timeframe ===
        getSelectedTimeframe() &&
      symbol ===
        getSelectedSymbol()
    ) {

      updateDashboard(
        state.activeSignal ||
          signal,
        topDown
      );

      dispatchAnalysisEvent(
        state.activeSignal ||
          signal,
        topDown
      );
    }

  } catch (error) {

    if (
      generation !==
      state.analysisGeneration
    ) {

      return;
    }

    console.error(
      "Precision analysis error:",
      error
    );

    setWaitingState(
      `WAIT — ${timeframeLabel(timeframe)}`,
      `Waiting for live ${marketName(symbol)} ${timeframeLabel(timeframe)} data.`
    );

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
   PROCESS SIGNAL
   ============================================================ */

function processSignal(
  signal
) {

  if (!signal) return;

  /*
    Never accept a signal from another
    timeframe.
  */
  if (
    signal.timeframe !==
    getSelectedTimeframe()
  ) {

    return;
  }

  if (
    signal.symbol !==
    getSelectedSymbol()
  ) {

    return;
  }

  const previous =
    state.activeSignal;

  /*
    Different pair or timeframe:
    replace completely.
  */
  if (
    previous &&
    (
      previous.symbol !==
        signal.symbol ||
      previous.timeframe !==
        signal.timeframe
    )
  ) {

    state.activeSignal =
      signal;

    notifySignal(
      signal,
      "NEW"
    );

    return;
  }

  /*
    Same setup:
    upgrade only when grade improves.
  */
  if (
    previous &&
    previous.id === signal.id
  ) {

    const ranks = {
      EARLY: 1,
      C: 2,
      B: 3,
      A: 4,
      "A+": 5
    };

    const oldRank =
      ranks[
        previous.grade
      ] || 0;

    const newRank =
      ranks[
        signal.grade
      ] || 0;

    if (
      newRank > oldRank
    ) {

      state.activeSignal =
        signal;

      notifySignal(
        signal,
        "UPGRADE"
      );

    } else {

      state.activeSignal =
        {
          ...previous,
          ...signal
        };

    }

    return;
  }

  /*
    New setup.
  */
  state.activeSignal =
    signal;

  state.lastSignalKey =
    signal.id;

  state.signalHistory.unshift(
    signal
  );

  state.signalHistory =
    state.signalHistory.slice(
      0,
      50
    );

  notifySignal(
    signal,
    "NEW"
  );
}


/* ============================================================
   SIGNAL INVALIDATION
   ============================================================ */

function checkSignalInvalidation() {

  const signal =
    state.activeSignal;

  if (!signal) return;

  if (
    signal.symbol !==
      getSelectedSymbol() ||
    signal.timeframe !==
      getSelectedTimeframe()
  ) {

    state.activeSignal =
      null;

    return;
  }

  const price =
    state.livePrice;

  if (
    !Number.isFinite(price)
  ) return;

  let invalidated =
    false;

  if (
    signal.direction ===
      "BUY" &&
    price <=
      signal.sl
  ) {

    invalidated =
      true;

  }

  if (
    signal.direction ===
      "SELL" &&
    price >=
      signal.sl
  ) {

    invalidated =
      true;
  }

  if (invalidated) {

    showAlert(
      `INVALIDATED — ${signal.symbol} ${signal.timeframe}`,
      "warning"
    );

    state.activeSignal =
      null;

    setWaitingState(
      `SETUP INVALIDATED — ${timeframeLabel(signal.timeframe)}`,
      `${marketName(signal.symbol)} — waiting for a new setup.`
    );
  }
}


/* ============================================================
   DASHBOARD
   ============================================================ */

function updateDashboard(
  signal,
  analysis
) {

  if (!signal) return;

  const tf =
    signal.timeframe;

  const symbol =
    signal.symbol;

  /*
    Chosen pair.
  */
  updateChosenPairDisplay();

  /*
    Signal.
  */
  setText(
    "signal",
    `${signal.direction} • ${timeframeLabel(tf)} • ${signal.grade}`
  );

  setText(
    "direction",
    signal.direction
  );

  setText(
    "setup",
    `${signal.grade} SETUP — ${timeframeLabel(tf)}`
  );

  setText(
    "confidence",
    `${signal.confidence}%`
  );

  setText(
    "rr",
    `1:${signal.rrTP2}`
  );

  /*
    Levels.
  */
  setText(
    "entry",
    formatPrice(
      signal.entry
    )
  );

  setText(
    "sl",
    formatPrice(
      signal.sl
    )
  );

  setText(
    "be",
    formatPrice(
      signal.be
    )
  );

  setText(
    "tp1",
    formatPrice(
      signal.tp1
    )
  );

  setText(
    "tp2",
    formatPrice(
      signal.tp2
    )
  );

  /*
    Structure.
  */
  setText(
    "swing",
    signal.structure
  );

  setText(
    "structure",
    signal.structure
  );

  setText(
    "liquidity",
    signal.liquidity
  );

  const execution =
    analysis?.execution;

  const sr =
    execution?.sr;

  setText(
    "sr",
    sr
      ? `S ${formatPrice(sr.support)} / R ${formatPrice(sr.resistance)}`
      : "Waiting"
  );

  /*
    Candle confirmation.
  */
  setText(
    "pattern",
    signal.pattern
  );

  setText(
    "rejection",
    execution?.candle?.confirmed
      ? "CONFIRMED"
      : "WAITING"
  );

  setText(
    "momentum",
    signal.displacement
  );

  setText(
    "confirmation",
    signal.confirmations?.join(
      " • "
    ) || "Developing"
  );

  /*
    Explanation.
  */
  setText(
    "explanationText",
    signal.explanation
  );

  /*
    Optional extra elements.
  */
  setText(
    "selectedTimeframe",
    timeframeLabel(tf)
  );

  setText(
    "timeframeDisplay",
    timeframeLabel(tf)
  );

  setText(
    "marketDisplay",
    marketName(symbol)
  );

  renderSignalHistory();
}


/* ============================================================
   WAITING STATE
   ============================================================ */

function setWaitingState(
  title,
  explanation
) {

  const tf =
    getSelectedTimeframe();

  const symbol =
    getSelectedSymbol();

  updateChosenPairDisplay();

  setText(
    "signal",
    title
  );

  setText(
    "direction",
    "WAIT"
  );

  setText(
    "setup",
    `${marketName(symbol)} — ${timeframeLabel(tf)}`
  );

  setText(
    "confidence",
    "—"
  );

  setText(
    "rr",
    "—"
  );

  setText(
    "entry",
    "—"
  );

  setText(
    "sl",
    "—"
  );

  setText(
    "be",
    "—"
  );

  setText(
    "tp1",
    "—"
  );

  setText(
    "tp2",
    "—"
  );

  setText(
    "explanationText",
    explanation
  );

  setText(
    "confirmation",
    "WAITING"
  );
}


/* ============================================================
   SIGNAL HISTORY
   ============================================================ */

function renderSignalHistory() {

  const container =
    $("signalHistory");

  if (!container) return;

  container.innerHTML = "";

  state.signalHistory
    .slice(0, 20)
    .forEach(signal => {

      const item =
        document.createElement(
          "div"
        );

      item.className =
        "signal-history-item";

      item.textContent =
        `${signal.direction} ${signal.symbol} ${signal.timeframe} — ${signal.grade} — ${formatPrice(signal.entry)}`;

      container.appendChild(
        item
      );
    });
}


/* ============================================================
   ALERTS
   ============================================================ */

function createAlertControl() {

  if (
    $("precisionAlertControl")
  ) return;

  const wrapper =
    document.createElement(
      "div"
    );

  wrapper.id =
    "precisionAlertControl";

  wrapper.innerHTML = `
    <label style="
      display:flex;
      align-items:center;
      gap:8px;
      cursor:pointer;
    ">
      <input
        type="checkbox"
        id="precisionAlerts"
        checked
      >
      <span>Signal Alerts</span>
    </label>
  `;

  document.body.appendChild(
    wrapper
  );

  const checkbox =
    $("precisionAlerts");

  checkbox?.addEventListener(
    "change",
    () => {

      state.alertsEnabled =
        checkbox.checked;

    }
  );
}


/* ============================================================
   NOTIFY SIGNAL
   ============================================================ */

function notifySignal(
  signal,
  type
) {

  if (
    !state.alertsEnabled
  ) return;

  const key =
    `${signal.id}-${type}`;

  if (
    state.notifiedSignals.has(
      key
    )
  ) return;

  state.notifiedSignals.add(
    key
  );

  const title =
    `${signal.direction} ${signal.grade} — ${signal.symbol} ${signal.timeframe}`;

  const message =
    `${type}: Entry ${formatPrice(signal.entry)} | SL ${formatPrice(signal.sl)} | TP1 ${formatPrice(signal.tp1)} | TP2 ${formatPrice(signal.tp2)} | RR 1:${signal.rrTP2}`;

  showAlert(
    title,
    message
  );

  /*
    Browser notification.
  */
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

    } else if (
      Notification.permission ===
      "default"
    ) {

      Notification
        .requestPermission()
        .then(permission => {

          if (
            permission ===
            "granted"
          ) {

            new Notification(
              title,
              {
                body: message
              }
            );

          }

        })
        .catch(() => {});

    }
  }
}


/* ============================================================
   IN-APP ALERT
   ============================================================ */

function showAlert(
  title,
  message
) {

  const existing =
    $("precisionAlert");

  if (existing) {
    existing.remove();
  }

  const alert =
    document.createElement(
      "div"
    );

  alert.id =
    "precisionAlert";

  alert.style.cssText = `
    position:fixed;
    top:20px;
    right:20px;
    z-index:99999;
    max-width:360px;
    padding:14px 16px;
    border-radius:12px;
    background:#111;
    color:#fff;
    box-shadow:0 8px 30px rgba(0,0,0,.35);
    font-family:Arial,sans-serif;
  `;

  alert.innerHTML = `
    <strong>${escapeHTML(title)}</strong>
    <div style="margin-top:6px;font-size:13px;">
      ${escapeHTML(message)}
    </div>
  `;

  document.body.appendChild(
    alert
  );

  setTimeout(() => {

    alert.remove();

  }, 8000);
}


/* ============================================================
   QUESTION BAR
   ============================================================ */

function createQuestionBar() {

  if (
    $("successfulAIQuestionBar")
  ) return;

  const wrapper =
    document.createElement(
      "section"
    );

  wrapper.id =
    "successfulAIQuestionBar";

  wrapper.style.cssText = `
    margin:20px 0;
    padding:16px;
    border-radius:14px;
    background:rgba(20,20,20,.08);
  `;

  wrapper.innerHTML = `
    <div style="
      font-weight:700;
      margin-bottom:8px;
    ">
      Ask Successful AI
    </div>

    <div style="
      display:flex;
      gap:8px;
      flex-wrap:wrap;
    ">

      <input
        id="aiQuestion"
        type="text"
        placeholder="Ask about the selected market or timeframe..."
        style="
          flex:1;
          min-width:220px;
          padding:12px;
          border-radius:8px;
          border:1px solid #ccc;
        "
      >

      <button
        id="aiAskButton"
        type="button"
      >
        Ask
      </button>

    </div>

    <div
      id="aiAnswer"
      style="
        margin-top:12px;
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
    $("aiQuestion");

  const button =
    $("aiAskButton");

  button?.addEventListener(
    "click",
    () => {

      askSuccessfulAI(
        input?.value
      );

    }
  );

  input?.addEventListener(
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
   AI QUESTION BAR
   ============================================================ */

async function askSuccessfulAI(
  question
) {

  question =
    String(
      question || ""
    ).trim();

  if (!question) return;

  const answerBox =
    $("aiAnswer") ||
    $("answer");

  if (answerBox) {

    answerBox.textContent =
      "Analyzing the live market data...";
  }

  const symbol =
    getSelectedSymbol();

  const timeframe =
    getSelectedTimeframe();

  const candles =
    getClosedCandles(
      symbol,
      timeframe
    );

  const market = {

    symbol,

    name:
      marketName(symbol),

    price:
      window.currentPrice ??
      state.livePrice ??
      null,

    timeframe,

    granularity:
      CONFIG.TIMEFRAMES[
        timeframe
      ]
  };

  const analysis =
    window.lastAnalysis ||
    window.currentAnalysis ||
    state.analysis ||
    {};

  try {

    const response =
      await fetch(
        "/api/ask",
        {
          method:
            "POST",

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
      "AI question error:",
      error
    );

    const fallback =
      buildLocalAIAnswer(
        question
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
  question
) {

  const symbol =
    getSelectedSymbol();

  const tf =
    getSelectedTimeframe();

  const analysis =
    state.analysis;

  const execution =
    analysis?.execution;

  if (!execution) {

    return (
      `I do not have enough closed-candle data yet for ` +
      `${marketName(symbol)} ${tf}. ` +
      `Wait for the selected timeframe data to load.`
    );
  }

  const direction =
    determineDirection(
      execution,
      analysis.htfBias
    );

  return (
    `Current ${marketName(symbol)} ${tf} analysis: ` +
    `HTF bias = ${analysis.htfBias || "NEUTRAL"}. ` +
    `Selected timeframe structure = ${
      execution.structure?.bias ||
      "NEUTRAL"
    }. ` +
    `Liquidity = ${
      execution.liquidity?.type ||
      "none detected"
    }. ` +
    `BOS = ${
      execution.events?.bos ||
      "none"
    }. ` +
    `Candle confirmation = ${
      execution.candle?.pattern ||
      "none"
    }. ` +
    `Current directional reading = ${
      direction || "NO CONFIRMED DIRECTION"
    }.`
  );
}


/* ============================================================
   ANALYSIS EVENT
   ============================================================ */

function dispatchAnalysisEvent(
  signal,
  analysis
) {

  window.dispatchEvent(
    new CustomEvent(
      "precision-analysis",
      {
        detail: {
          signal,
          analysis
        }
      }
    )
  );
}


/* ============================================================
   ESCAPE HTML
   ============================================================ */

function escapeHTML(
  value
) {

  return String(
    value ?? ""
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}


/* ============================================================
   GLOBAL API
   ============================================================ */

window.SuccessfulPrecisionAI = {

  state,

  selectTimeframe,

  runPrecisionAnalysis,

  loadTimeframeHistory,

  getClosedCandles,

  analyzeTimeframe,

  generatePrecisionSignal,

  askSuccessfulAI,

  connectDeriv

};

window.askSuccessfulAI =
  askSuccessfulAI;

window.selectTimeframe =
  selectTimeframe;

window.runPrecisionAnalysis =
  runPrecisionAnalysis;


/* ============================================================
   INITIAL GLOBAL VALUES
   ============================================================ */

window.currentSymbol =
  state.selectedSymbol;

window.currentTimeframe =
  state.selectedTimeframe;

window.currentPrice =
  null;

window.closedCandles =
  [];

window.lastAnalysis =
  null;

window.currentAnalysis =
  null;

window.lastAIAnswer =
  "";

/* ============================================================
   END SUCCESSFUL PINE SCRIPT
   ============================================================ */
