/* ============================================================
   SUCCESSFUL PINE SCRIPT
   PRECISION SIGNAL ENGINE
   ------------------------------------------------------------
   LIVE DERIV PUBLIC DATA
   ALL PAIRS × ALL TIMEFRAMES BACKGROUND SCANNER
   CLOSED-CANDLE / NON-REPAINTING
   MARKET STRUCTURE + PRICE ACTION + S/R + EMA9
   DEPTH 30 / DEVIATION 5 / BACKSTEP 5
   SNIPER ENTRY + SL + TP1 + TP2 + TP3
   NO FUTURE DATA / NO LOOKAHEAD
   ============================================================ */

"use strict";

/* ============================================================
   CONFIGURATION
   ============================================================ */

const CONFIG = {
  DERIV_WS:
    "wss://api.derivws.com/trading/v1/options/ws/public",

  HISTORY_COUNT: 250,

  DEPTH: 30,
  DEVIATION: 5,
  BACKSTEP: 5,

  EMA_LENGTH: 9,
  ATR_LENGTH: 14,

  ATR_SAFETY_MULTIPLIER: 0.15,

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

  /* ==========================================================
     FULL SCANNER
     ========================================================== */

  SCANNER_ENABLED: true,

  SCANNER_ALL_SYMBOLS: true,

  SCANNER_ALL_TIMEFRAMES: true,

  SCANNER_BATCH_SIZE: 3,

  SCANNER_DELAY: 250,

  SCANNER_HISTORY_COUNT: 250,

  /* Do not alert historical setup during initial baseline. */
  BASELINE_WITHOUT_ALERT: true,

  /* Prevent repeated alerts for same setup. */
  SIGNAL_COOLDOWN: 60 * 60 * 1000,

  RECONNECT_MIN: 1000,

  RECONNECT_MAX: 30000,

  /* Selected pair analysis frequency. */
  ANALYSIS_INTERVAL: 5000,

  /* Maximum number of history requests waiting at once. */
  MAX_PENDING_HISTORY: 6
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

  livePrice: null,

  candles: {},

  pendingRequests: new Map(),

  pendingHistory: new Map(),

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

  initialized: false,

  /* ==========================================================
     FULL SCANNER STATE
     ========================================================== */

  scannerRunning: false,

  scannerBusy: false,

  scannerQueue: [],

  scannerQueueIndex: 0,

  scannerLastClosedCandle: {},

  scannerSignals: {},

  scannerSeenSignals: new Set(),

  scannerNotifiedSignals: new Set(),

  scannerInitialized: {},

  scannerGeneration: 0,

  scannerStats: {
    pairs: 0,
    timeframes: 0,
    combinations: 0,
    scanned: 0,
    signals: 0,
    lastRun: null
  }
};


/* ============================================================
   DOM HELPERS
   ============================================================ */

function $(id) {
  return document.getElementById(id);
}


function $all(selector) {
  return Array.from(document.querySelectorAll(selector));
}


function setText(id, value) {

  const element = $(id);

  if (element) {
    element.textContent =
      value === undefined ||
      value === null
        ? ""
        : String(value);
  }
}


function escapeHTML(value) {

  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


/* ============================================================
   NUMBER HELPERS
   ============================================================ */

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}


function toNumber(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


function roundPrice(price) {

  if (!isFiniteNumber(price)) {
    return null;
  }

  const p = Math.abs(Number(price));

  let decimals = 5;

  if (p >= 1000) decimals = 2;
  else if (p >= 100) decimals = 3;
  else if (p >= 10) decimals = 4;

  return Number(Number(price).toFixed(decimals));
}


function formatPrice(price) {

  if (!isFiniteNumber(price)) {
    return "—";
  }

  const p = Math.abs(Number(price));

  let decimals = 5;

  if (p >= 1000) decimals = 2;
  else if (p >= 100) decimals = 3;
  else if (p >= 10) decimals = 4;

  return Number(price).toFixed(decimals);
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/* ============================================================
   TIMEFRAME HELPERS
   ============================================================ */

function normalizeTimeframe(value) {

  const raw = String(value || "")
    .trim()
    .toUpperCase();

  if (raw === "D1") return "Daily";

  if (raw === "1D") return "Daily";

  if (raw === "DAY") return "Daily";

  if (CONFIG.TIMEFRAMES[raw]) {
    return raw;
  }

  return "M5";
}


function getTimeframeSeconds(timeframe) {

  const tf = normalizeTimeframe(timeframe);

  return CONFIG.TIMEFRAMES[tf];
}


function getTimeframeLabel(timeframe) {

  return normalizeTimeframe(timeframe);
}


function getAllTimeframes() {

  return Object.keys(CONFIG.TIMEFRAMES);
}


/* ============================================================
   EXPECTED CLOSED CANDLE
   ============================================================ */

function getExpectedLatestClosedEpoch(timeframe) {

  const duration =
    getTimeframeSeconds(timeframe);

  if (!duration) return 0;

  const now =
    Math.floor(Date.now() / 1000);

  return (
    Math.floor(now / duration) * duration
  ) - duration;
}


/* ============================================================
   CONNECTION STATUS
   ============================================================ */

function setConnectionStatus(text, connected = false) {

  setText(
    "connectionText",
    text
  );

  const element =
    $("connectionText");

  if (element) {

    element.classList.toggle(
      "connected",
      connected
    );

    element.classList.toggle(
      "disconnected",
      !connected
    );
  }
}


/* ============================================================
   DERIV WEBSOCKET
   ============================================================ */

function connectDeriv() {

  if (
    state.ws &&
    (
      state.ws.readyState ===
      WebSocket.OPEN ||

      state.ws.readyState ===
      WebSocket.CONNECTING
    )
  ) {
    return;
  }

  setConnectionStatus(
    "Connecting...",
    false
  );

  try {

    state.ws =
      new WebSocket(
        CONFIG.DERIV_WS
      );

  } catch (error) {

    console.error(
      "WebSocket creation error:",
      error
    );

    scheduleReconnect();

    return;
  }


  state.ws.onopen = () => {

    console.log(
      "Deriv WebSocket connected."
    );

    state.connected = true;

    state.reconnectDelay =
      CONFIG.RECONNECT_MIN;

    setConnectionStatus(
      "LIVE",
      true
    );

    requestActiveSymbols();

    state.scannerGeneration++;

    if (state.initialized) {

      setTimeout(
        () => {
          startFullScanner();
        },
        1000
      );
    }
  };


  state.ws.onmessage = event => {

    try {

      const message =
        JSON.parse(event.data);

      handleDerivMessage(message);

    } catch (error) {

      console.error(
        "Deriv message parse error:",
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
      "Connection Error",
      false
    );
  };


  state.ws.onclose = () => {

    state.connected = false;

    setConnectionStatus(
      "Disconnected",
      false
    );

    scheduleReconnect();
  };
}


function scheduleReconnect() {

  if (state.reconnectTimer) {
    return;
  }

  const delay =
    state.reconnectDelay;

  state.reconnectTimer =
    setTimeout(() => {

      state.reconnectTimer = null;

      connectDeriv();

      state.reconnectDelay =
        Math.min(
          state.reconnectDelay * 2,
          CONFIG.RECONNECT_MAX
        );

    }, delay);
}


/* ============================================================
   REQUEST HANDLING
   ============================================================ */

function sendRequest(payload, timeout = 20000) {

  return new Promise((resolve, reject) => {

    if (
      !state.ws ||
      state.ws.readyState !==
      WebSocket.OPEN
    ) {

      reject(
        new Error(
          "Deriv WebSocket is not connected."
        )
      );

      return;
    }


    const reqId =
      state.requestId++;


    payload.req_id = reqId;


    const timer =
      setTimeout(() => {

        state.pendingRequests.delete(
          reqId
        );

        reject(
          new Error(
            "Deriv request timeout."
          )
        );

      }, timeout);


    state.pendingRequests.set(
      reqId,
      {
        resolve,
        reject,
        timer
      }
    );


    try {

      state.ws.send(
        JSON.stringify(payload)
      );

    } catch (error) {

      clearTimeout(timer);

      state.pendingRequests.delete(
        reqId
      );

      reject(error);
    }
  });
}


function handleDerivMessage(message) {

  if (
    message.req_id &&
    state.pendingRequests.has(
      message.req_id
    )
  ) {

    const pending =
      state.pendingRequests.get(
        message.req_id
      );

    clearTimeout(
      pending.timer
    );

    state.pendingRequests.delete(
      message.req_id
    );

    if (message.error) {

      pending.reject(
        new Error(
          message.error.message ||
          "Deriv API error."
        )
      );

    } else {

      pending.resolve(message);
    }
  }


  if (message.msg_type === "active_symbols") {

    handleActiveSymbols(
      message.active_symbols || []
    );
  }


  if (message.msg_type === "tick") {

    handleTick(
      message.tick
    );
  }


  if (
    message.msg_type ===
    "history"
  ) {

    handleHistoryMessage(
      message
    );
  }


  if (
    message.msg_type ===
    "candles"
  ) {

    handleHistoryMessage(
      message
    );
  }
}


/* ============================================================
   ACTIVE SYMBOLS
   ============================================================ */

function requestActiveSymbols() {

  sendRequest({
    active_symbols: "full",
    product_type: "basic"
  })
    .then(response => {

      handleActiveSymbols(
        response.active_symbols || []
      );

    })
    .catch(error => {

      console.error(
        "Active symbols error:",
        error
      );
    });
}


function handleActiveSymbols(symbols) {

  const parsed = [];

  for (
    const item of symbols
  ) {

    const symbol =
      item.underlying_symbol ||
      item.symbol ||
      "";

    const name =
      item.underlying_symbol_name ||
      item.display_name ||
      symbol;

    const type =
      item.underlying_symbol_type ||
      item.symbol_type ||
      "";


    if (!symbol) continue;


    parsed.push({
      symbol,
      name,
      type,
      raw: item
    });
  }


  const unique =
    new Map();


  for (
    const item of parsed
  ) {

    if (
      !unique.has(
        item.symbol
      )
    ) {

      unique.set(
        item.symbol,
        item
      );
    }
  }


  state.symbols =
    Array.from(
      unique.values()
    ).sort(
      (a, b) =>
        a.name.localeCompare(
          b.name
        )
    );


  populateMarketSelector();


  state.scannerGeneration++;

  if (
    state.initialized &&
    CONFIG.SCANNER_ENABLED
  ) {

    startFullScanner();
  }
}


/* ============================================================
   MARKET SELECTOR
   ============================================================ */

function populateMarketSelector() {

  const select =
    $("market");

  if (!select) return;


  const oldValue =
    state.selectedSymbol ||
    select.value;


  select.innerHTML = "";


  for (
    const market of state.symbols
  ) {

    const option =
      document.createElement(
        "option"
      );

    option.value =
      market.symbol;

    option.textContent =
      market.name +
      (
        market.name !==
        market.symbol
          ? ` (${market.symbol})`
          : ""
      );

    select.appendChild(
      option
    );
  }


  if (
    oldValue &&
    state.symbols.some(
      item =>
        item.symbol ===
        oldValue
    )
  ) {

    select.value =
      oldValue;

    state.selectedSymbol =
      oldValue;

  } else if (
    state.symbols.length
  ) {

    state.selectedSymbol =
      state.symbols[0].symbol;

    select.value =
      state.selectedSymbol;
  }


  updateSelectedMarketDisplay();
}


function updateSelectedMarketDisplay() {

  const market =
    state.symbols.find(
      item =>
        item.symbol ===
        state.selectedSymbol
    );


  if (!market) return;


  setText(
    "selectedMarket",
    market.name
  );

  setText(
    "marketName",
    market.name
  );
}


/* ============================================================
   MARKET SELECTION
   ============================================================ */

async function selectMarket(symbol) {

  if (!symbol) return;


  state.selectedSymbol =
    symbol;

  state.analysisGeneration++;

  state.activeSignal = null;

  state.tradeState = null;

  state.analysis = null;

  updateSelectedMarketDisplay();


  subscribeToTick(
    symbol
  );


  await runPrecisionAnalysis(
    true
  );
}


/* ============================================================
   TICK SUBSCRIPTION
   ============================================================ */

function subscribeToTick(symbol) {

  if (
    !state.connected ||
    !symbol
  ) {
    return;
  }


  sendRequest({
    ticks: symbol,
    subscribe: 1
  })
    .catch(error => {

      console.error(
        "Tick subscription error:",
        error
      );
    });
}


/* ============================================================
   TICK HANDLING
   ============================================================ */

function handleTick(tick) {

  if (!tick) return;


  const symbol =
    tick.symbol;

  const quote =
    toNumber(tick.quote);


  if (!symbol || quote === null) {
    return;
  }


  if (
    symbol ===
    state.selectedSymbol
  ) {

    state.livePrice =
      quote;

    updateLivePrice(
      quote
    );

    manageActiveTrade(
      quote
    );
  }
}


function updateLivePrice(price) {

  setText(
    "livePrice",
    formatPrice(price)
  );

  setText(
    "price",
    formatPrice(price)
  );
}


/* ============================================================
   HISTORY CACHE
   ============================================================ */

function historyCacheKey(
  symbol,
  timeframe
) {

  return (
    `${symbol}::${normalizeTimeframe(timeframe)}`
  );
}


/* ============================================================
   HISTORY MESSAGE
   ============================================================ */

function handleHistoryMessage(message) {

  const reqId =
    message.req_id;

  if (!reqId) return;


  const pending =
    state.pendingHistory.get(
      reqId
    );

  if (!pending) return;


  state.pendingHistory.delete(
    reqId
  );


  const candles =
    parseHistoryResponse(
      message
    );


  if (
    candles.length
  ) {

    state.candles[
      historyCacheKey(
        pending.symbol,
        pending.timeframe
      )
    ] = {
      candles,
      updatedAt:
        Date.now()
    };
  }


  pending.resolve(
    candles
  );
}


/* ============================================================
   HISTORY PARSER
   ============================================================ */

function parseHistoryResponse(
  response
) {

  const raw =
    response.candles ||
    response.history?.candles ||
    [];


  if (
    Array.isArray(raw) &&
    raw.length
  ) {

    return raw
      .map(candle => ({
        epoch:
          Number(
            candle.epoch
          ),
        open:
          Number(
            candle.open
          ),
        high:
          Number(
            candle.high
          ),
        low:
          Number(
            candle.low
          ),
        close:
          Number(
            candle.close
          )
      }))
      .filter(
        candle =>
          Number.isFinite(
            candle.epoch
          ) &&
          Number.isFinite(
            candle.open
          ) &&
          Number.isFinite(
            candle.high
          ) &&
          Number.isFinite(
            candle.low
          ) &&
          Number.isFinite(
            candle.close
          )
      )
      .sort(
        (a, b) =>
          a.epoch -
          b.epoch
      );
  }


  const history =
    response.history;


  if (
    history &&
    Array.isArray(
      history.times
    )
  ) {

    const opens =
      history.open || [];

    const highs =
      history.high || [];

    const lows =
      history.low || [];

    const closes =
      history.close || [];


    return history.times
      .map(
        (time, index) => ({
          epoch:
            Number(time),

          open:
            Number(
              opens[index]
            ),

          high:
            Number(
              highs[index]
            ),

          low:
            Number(
              lows[index]
            ),

          close:
            Number(
              closes[index]
            )
        })
      )
      .filter(
        candle =>
          Number.isFinite(
            candle.epoch
          ) &&
          Number.isFinite(
            candle.open
          ) &&
          Number.isFinite(
            candle.high
          ) &&
          Number.isFinite(
            candle.low
          ) &&
          Number.isFinite(
            candle.close
          )
      )
      .sort(
        (a, b) =>
          a.epoch -
          b.epoch
      );
  }


  return [];
}


/* ============================================================
   LOAD EXACT TIMEFRAME HISTORY
   ============================================================ */

function loadTimeframeHistory(
  symbol,
  timeframe,
  force = false
) {

  const tf =
    normalizeTimeframe(
      timeframe
    );

  const key =
    historyCacheKey(
      symbol,
      tf
    );


  const cached =
    state.candles[key];


  const expected =
    getExpectedLatestClosedEpoch(
      tf
    );


  if (
    !force &&
    cached &&
    cached.candles &&
    cached.candles.length >= 100
  ) {

    const latest =
      cached.candles[
        cached.candles.length - 1
      ]?.epoch || 0;


    if (
      latest >= expected
    ) {

      return Promise.resolve(
        cached.candles
      );
    }
  }


  if (
    state.pendingHistoryByKey &&
    state.pendingHistoryByKey.has(key)
  ) {

    return state.pendingHistoryByKey.get(
      key
    );
  }


  if (
    !state.pendingHistoryByKey
  ) {

    state.pendingHistoryByKey =
      new Map();
  }


  const promise =
    new Promise(
      (resolve, reject) => {

        if (
          !state.connected
        ) {

          reject(
            new Error(
              "Not connected."
            )
          );

          return;
        }


        const requestId =
          state.requestId++;


        state.pendingHistory.set(
          requestId,
          {
            symbol,
            timeframe: tf,
            resolve,
            reject
          }
        );


        state.pendingHistoryByKey.set(
          key,
          promise
        );


        const timer =
          setTimeout(() => {

            if (
              state.pendingHistory.has(
                requestId
              )
            ) {

              state.pendingHistory.delete(
                requestId
              );

              state.pendingHistoryByKey.delete(
                key
              );

              reject(
                new Error(
                  "History request timeout."
                )
              );
            }

          }, 20000);


        try {

          state.ws.send(
            JSON.stringify({
              ticks_history:
                symbol,

              adjust_start_time:
                1,

              count:
                CONFIG.SCANNER_HISTORY_COUNT,

              end:
                "latest",

              start:
                1,

              style:
                "candles",

              granularity:
                getTimeframeSeconds(
                  tf
                ),

              req_id:
                requestId
            })
          );

        } catch (error) {

          clearTimeout(timer);

          state.pendingHistory.delete(
            requestId
          );

          state.pendingHistoryByKey.delete(
            key
          );

          reject(error);
        }
      }
    );


  promise.finally(
    () => {
      state.pendingHistoryByKey.delete(
        key
      );
    }
  );


  return promise;
}


/* ============================================================
   CLOSED CANDLES
   ============================================================ */

function getClosedCandles(
  candles,
  timeframe
) {

  if (
    !Array.isArray(candles) ||
    !candles.length
  ) {

    return [];
  }


  const duration =
    getTimeframeSeconds(
      timeframe
    );


  const currentCandleStart =
    Math.floor(
      Date.now() / 1000 / duration
    ) * duration;


  return candles.filter(
    candle =>
      Number(candle.epoch) <
      currentCandleStart
  );
}


/* ============================================================
   ATR
   ============================================================ */

function calculateATR(
  candles,
  length = CONFIG.ATR_LENGTH
) {

  if (
    candles.length <
    length + 1
  ) {
    return null;
  }


  const ranges = [];


  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const current =
      candles[i];

    const previous =
      candles[i - 1];


    const trueRange =
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
          previous.close
        ),

        Math.abs(
          current.low -
          previous.close
        )
      );


    ranges.push(
      trueRange
    );
  }


  if (
    ranges.length <
    length
  ) {

    return null;
  }


  const recent =
    ranges.slice(
      -length
    );


  return (
    recent.reduce(
      (sum, value) =>
        sum + value,
      0
    ) / recent.length
  );
}


/* ============================================================
   EMA
   ============================================================ */

function calculateEMA(
  candles,
  length = CONFIG.EMA_LENGTH
) {

  if (
    candles.length <
    length
  ) {
    return null;
  }


  const closes =
    candles.map(
      candle =>
        Number(candle.close)
    );


  const multiplier =
    2 / (length + 1);


  let ema =
    closes
      .slice(
        0,
        length
      )
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / length;


  for (
    let i = length;
    i < closes.length;
    i++
  ) {

    ema =
      (
        closes[i] -
        ema
      ) *
      multiplier +
      ema;
  }


  return ema;
}


/* ============================================================
   SWING DETECTION
   DEPTH 30 / DEVIATION 5 / BACKSTEP 5
   ============================================================ */

function detectSwings(
  candles
) {

  const depth =
    CONFIG.DEPTH;

  const deviation =
    CONFIG.DEVIATION;

  const backstep =
    CONFIG.BACKSTEP;


  const highs = [];

  const lows = [];


  if (
    candles.length <
    depth * 2 + 5
  ) {

    return {
      highs,
      lows
    };
  }


  for (
    let i = depth;
    i < candles.length - depth;
    i++
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
        candles[j].high >
        current.high
      ) {

        isHigh = false;
      }


      if (
        candles[j].low <
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


    if (isHigh) {

      highs.push({
        index: i,
        epoch: current.epoch,
        price: current.high,
        type: "HIGH"
      });
    }


    if (isLow) {

      lows.push({
        index: i,
        epoch: current.epoch,
        price: current.low,
        type: "LOW"
      });
    }
  }


  /* ==========================================================
     DEVIATION FILTER
     ========================================================== */

  const filteredHighs =
    filterSwingsByDeviation(
      highs,
      deviation
    );


  const filteredLows =
    filterSwingsByDeviation(
      lows,
      deviation
    );


  /* ==========================================================
     BACKSTEP
     ========================================================== */

  return {
    highs:
      applyBackstep(
        filteredHighs,
        backstep,
        true
      ),

    lows:
      applyBackstep(
        filteredLows,
        backstep,
        false
      )
  };
}


function filterSwingsByDeviation(
  swings,
  deviation
) {

  if (
    swings.length <= 1
  ) {

    return swings;
  }


  const result = [
    swings[0]
  ];


  for (
    let i = 1;
    i < swings.length;
    i++
  ) {

    const previous =
      result[
        result.length - 1
      ];

    const current =
      swings[i];


    const distance =
      Math.abs(
        current.price -
        previous.price
      );


    const minimum =
      Math.abs(
        previous.price
      ) *
      (
        deviation /
        10000
      );


    if (
      distance >= minimum
    ) {

      result.push(
        current
      );

    } else if (
      current.index >
      previous.index
    ) {

      if (
        current.type ===
        "HIGH" &&
        current.price >
        previous.price
      ) {

        result[
          result.length - 1
        ] = current;
      }


      if (
        current.type ===
        "LOW" &&
        current.price <
        previous.price
      ) {

        result[
          result.length - 1
        ] = current;
      }
    }
  }


  return result;
}


function applyBackstep(
  swings,
  backstep,
  isHigh
) {

  if (
    swings.length <= 1
  ) {

    return swings;
  }


  const result = [];


  for (
    const swing of swings
  ) {

    let replaced = false;


    for (
      let i = result.length - 1;
      i >= 0;
      i--
    ) {

      const previous =
        result[i];


      if (
        swing.index -
        previous.index >
        backstep
      ) {

        break;
      }


      if (
        isHigh &&
        swing.price >=
        previous.price
      ) {

        result[i] =
          swing;

        replaced = true;

        break;
      }


      if (
        !isHigh &&
        swing.price <=
        previous.price
      ) {

        result[i] =
          swing;

        replaced = true;

        break;
      }
    }


    if (!replaced) {

      result.push(
        swing
      );
    }
  }


  return result;
}


/* ============================================================
   USABLE SWINGS
   ============================================================ */

function getUsableSwings(
  candles
) {

  const detected =
    detectSwings(
      candles
    );


  const lastIndex =
    candles.length - 1;


  return {
    highs:
      detected.highs.filter(
        swing =>
          swing.index <
          lastIndex
      ),

    lows:
      detected.lows.filter(
        swing =>
          swing.index <
          lastIndex
      )
  };
}


/* ============================================================
   MARKET DIRECTION
   ============================================================ */

function determineDirection(
  swings
) {

  const highs =
    swings.highs;

  const lows =
    swings.lows;


  if (
    highs.length < 2 ||
    lows.length < 2
  ) {

    return "NEUTRAL";
  }


  const lastHigh =
    highs[highs.length - 1];

  const previousHigh =
    highs[highs.length - 2];


  const lastLow =
    lows[lows.length - 1];

  const previousLow =
    lows[lows.length - 2];


  if (
    lastHigh.price >
    previousHigh.price &&
    lastLow.price >
    previousLow.price
  ) {

    return "BULLISH";
  }


  if (
    lastHigh.price <
    previousHigh.price &&
    lastLow.price <
    previousLow.price
  ) {

    return "BEARISH";
  }


  return "NEUTRAL";
}


/* ============================================================
   SUPPORT / RESISTANCE
   ============================================================ */

function findSupportResistance(
  candles,
  swings
) {

  const price =
    candles[
      candles.length - 1
    ].close;


  const supports =
    swings.lows
      .filter(
        swing =>
          swing.price <=
          price
      )
      .sort(
        (a, b) =>
          Math.abs(
            price - a.price
          ) -
          Math.abs(
            price - b.price
          )
      );


  const resistances =
    swings.highs
      .filter(
        swing =>
          swing.price >=
          price
      )
      .sort(
        (a, b) =>
          Math.abs(
            price - a.price
          ) -
          Math.abs(
            price - b.price
          )
      );


  return {
    support:
      supports[0] || null,

    resistance:
      resistances[0] || null
  };
}


/* ============================================================
   CANDLE CONFIRMATION
   ============================================================ */

function candleConfirmation(
  candles
) {

  if (
    candles.length < 3
  ) {

    return {
      bullish: false,
      bearish: false,
      pattern: "WAIT",
      rejection: false,
      momentum: false
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


  const currentBody =
    Math.abs(
      current.close -
      current.open
    );


  const currentRange =
    current.high -
    current.low;


  const upperWick =
    current.high -
    Math.max(
      current.open,
      current.close
    );


  const lowerWick =
    Math.min(
      current.open,
      current.close
    ) -
    current.low;


  const bullishBody =
    current.close >
    current.open;


  const bearishBody =
    current.close <
    current.open;


  const strongBody =
    currentRange > 0 &&
    currentBody /
      currentRange >=
      0.55;


  const bullishRejection =
    lowerWick >
      currentBody * 1.2 &&
    current.close >
      current.open;


  const bearishRejection =
    upperWick >
      currentBody * 1.2 &&
    current.close <
      current.open;


  const bullishMomentum =
    bullishBody &&
    strongBody &&
    current.close >
      previous.high;


  const bearishMomentum =
    bearishBody &&
    strongBody &&
    current.close <
      previous.low;


  let pattern =
    "NEUTRAL";


  if (
    bullishMomentum
  ) {

    pattern =
      "BULLISH MOMENTUM";

  } else if (
    bearishMomentum
  ) {

    pattern =
      "BEARISH MOMENTUM";

  } else if (
    bullishRejection
  ) {

    pattern =
      "BULLISH REJECTION";

  } else if (
    bearishRejection
  ) {

    pattern =
      "BEARISH REJECTION";
  }


  return {

    bullish:
      bullishMomentum ||
      bullishRejection,

    bearish:
      bearishMomentum ||
      bearishRejection,

    pattern,

    rejection:
      bullishRejection ||
      bearishRejection,

    momentum:
      bullishMomentum ||
      bearishMomentum
  };
}


/* ============================================================
   PRICE PROXIMITY
   ============================================================ */

function isNearLevel(
  price,
  level,
  atr
) {

  if (
    price === null ||
    level === null
  ) {

    return false;
  }


  const distance =
    Math.abs(
      price - level
    );


  const tolerance =
    atr
      ? Math.max(
          atr * 0.75,
          price *
            0.001
        )
      : price * 0.0015;


  return (
    distance <=
    tolerance
  );
}


/* ============================================================
   TRADE LEVELS
   ============================================================ */

function calculateTradeLevels(
  direction,
  entry,
  swings,
  atr
) {

  let stop = null;


  if (
    direction ===
    "BUY"
  ) {

    const lows =
      swings.lows;


    if (lows.length) {

      stop =
        lows[
          lows.length - 1
        ].price;
    }


    if (
      stop === null ||
      stop >= entry
    ) {

      stop =
        entry -
        (
          atr ||
          entry * 0.002
        );
    }


    if (
      atr &&
      entry - stop <
        atr *
          CONFIG.ATR_SAFETY_MULTIPLIER
    ) {

      stop =
        entry -
        atr *
          CONFIG.ATR_SAFETY_MULTIPLIER;
    }

  } else {

    const highs =
      swings.highs;


    if (highs.length) {

      stop =
        highs[
          highs.length - 1
        ].price;
    }


    if (
      stop === null ||
      stop <= entry
    ) {

      stop =
        entry +
        (
          atr ||
          entry * 0.002
        );
    }


    if (
      atr &&
      stop - entry <
        atr *
          CONFIG.ATR_SAFETY_MULTIPLIER
    ) {

      stop =
        entry +
        atr *
          CONFIG.ATR_SAFETY_MULTIPLIER;
    }
  }


  stop =
    roundPrice(stop);


  const risk =
    Math.abs(
      entry - stop
    );


  if (
    !risk ||
    !Number.isFinite(risk)
  ) {

    return null;
  }


  let tp1;
  let tp2;
  let tp3;


  if (
    direction ===
    "BUY"
  ) {

    tp1 =
      entry +
      risk *
      CONFIG.TP1_RR;

    tp2 =
      entry +
      risk *
      CONFIG.TP2_RR;

    tp3 =
      entry +
      risk *
      CONFIG.TP3_RR;

  } else {

    tp1 =
      entry -
      risk *
      CONFIG.TP1_RR;

    tp2 =
      entry -
      risk *
      CONFIG.TP2_RR;

    tp3 =
      entry -
      risk *
      CONFIG.TP3_RR;
  }


  return {

    entry:
      roundPrice(entry),

    sl:
      roundPrice(stop),

    tp1:
      roundPrice(tp1),

    tp2:
      roundPrice(tp2),

    tp3:
      roundPrice(tp3),

    risk,

    rr:
      "1:3"
  };
}


/* ============================================================
   MAIN SNIPER SIGNAL ENGINE
   ============================================================ */

function generateSniperSignal(
  symbol,
  timeframe,
  candles
) {

  const tf =
    normalizeTimeframe(
      timeframe
    );


  const closed =
    getClosedCandles(
      candles,
      tf
    );


  if (
    closed.length < 100
  ) {

    return {
      status: "WAIT",
      symbol,
      timeframe: tf,
      reason:
        "Not enough closed candles."
    };
  }


  const last =
    closed[
      closed.length - 1
    ];


  const swings =
    getUsableSwings(
      closed
    );


  const direction =
    determineDirection(
      swings
    );


  const sr =
    findSupportResistance(
      closed,
      swings
    );


  const candle =
    candleConfirmation(
      closed
    );


  const ema9 =
    calculateEMA(
      closed,
      CONFIG.EMA_LENGTH
    );


  const atr =
    calculateATR(
      closed,
      CONFIG.ATR_LENGTH
    );


  const price =
    Number(last.close);


  const nearSupport =
    sr.support
      ? isNearLevel(
          price,
          sr.support.price,
          atr
        )
      : false;


  const nearResistance =
    sr.resistance
      ? isNearLevel(
          price,
          sr.resistance.price,
          atr
        )
      : false;


  const emaBullish =
    ema9 !== null &&
    price >= ema9;


  const emaBearish =
    ema9 !== null &&
    price <= ema9;


  const bullish =
    direction ===
      "BULLISH" &&

    nearSupport &&

    candle.bullish &&

    emaBullish;


  const bearish =
    direction ===
      "BEARISH" &&

    nearResistance &&

    candle.bearish &&

    emaBearish;


  if (
    !bullish &&
    !bearish
  ) {

    return {

      status:
        "WAIT",

      symbol,

      timeframe: tf,

      candleTime:
        last.epoch,

      direction,

      entry:
        roundPrice(price),

      ema9:
        roundPrice(ema9),

      atr:
        roundPrice(atr),

      support:
        sr.support?.price
          ? roundPrice(
              sr.support.price
            )
          : null,

      resistance:
        sr.resistance?.price
          ? roundPrice(
              sr.resistance.price
            )
          : null,

      pattern:
        candle.pattern,

      reason:
        buildWaitReason({
          direction,
          nearSupport,
          nearResistance,
          candle,
          emaBullish,
          emaBearish
        })
    };
  }


  const signalDirection =
    bullish
      ? "BUY"
      : "SELL";


  const levels =
    calculateTradeLevels(
      signalDirection,
      price,
      swings,
      atr
    );


  if (!levels) {

    return {

      status:
        "WAIT",

      symbol,

      timeframe: tf,

      candleTime:
        last.epoch,

      reason:
        "Unable to calculate safe trade levels."
    };
  }


  const reason =
    bullish

      ? "Bullish swing + support + bullish candle + EMA9 confirmation."

      : "Bearish swing + resistance + bearish candle + EMA9 confirmation.";


  return {

    status:
      "SIGNAL",

    signal:
      signalDirection,

    direction:
      signalDirection,

    symbol,

    timeframe: tf,

    candleTime:
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

    rr:
      levels.rr,

    risk:
      levels.risk,

    ema9:
      roundPrice(ema9),

    atr:
      roundPrice(atr),

    support:
      sr.support?.price
        ? roundPrice(
            sr.support.price
          )
        : null,

    resistance:
      sr.resistance?.price
        ? roundPrice(
            sr.resistance.price
          )
        : null,

    pattern:
      candle.pattern,

    rejection:
      candle.rejection,

    momentum:
      candle.momentum,

    reason
  };
}


/* ============================================================
   WAIT REASON
   ============================================================ */

function buildWaitReason(
  data
) {

  if (
    data.direction ===
    "NEUTRAL"
  ) {

    return "No clear bullish or bearish swing direction.";
  }


  if (
    data.direction ===
    "BULLISH"
  ) {

    if (
      !data.nearSupport
    ) {

      return "Bullish structure detected, but price is not near confirmed support.";
    }


    if (
      !data.candle.bullish
    ) {

      return "Waiting for bullish candle confirmation.";
    }


    if (
      !data.emaBullish
    ) {

      return "Waiting for EMA9 bullish confirmation.";
    }
  }


  if (
    data.direction ===
    "BEARISH"
  ) {

    if (
      !data.nearResistance
    ) {

      return "Bearish structure detected, but price is not near confirmed resistance.";
    }


    if (
      !data.candle.bearish
    ) {

      return "Waiting for bearish candle confirmation.";
    }


    if (
      !data.emaBearish
    ) {

      return "Waiting for EMA9 bearish confirmation.";
    }
  }


  return "Waiting for complete sniper confirmation.";
}


/* ============================================================
   SIGNAL KEY
   ============================================================ */

function signalKey(
  signal
) {

  if (!signal) return "";


  return [
    signal.symbol,
    signal.timeframe,
    signal.signal ||
      signal.direction,
    signal.candleTime
  ].join("::");
}


/* ============================================================
   BACKGROUND SCANNER KEY
   ============================================================ */

function scannerContextKey(
  symbol,
  timeframe
) {

  return (
    `${symbol}::${normalizeTimeframe(timeframe)}`
  );
}


/* ============================================================
   SCANNER SIGNAL KEY
   ============================================================ */

function scannerSignalKey(
  signal
) {

  return signalKey(
    signal
  );
}


/* ============================================================
   CHECK WHETHER SIGNAL IS NEW
   ============================================================ */

function isNewScannerSignal(
  signal
) {

  const key =
    scannerSignalKey(
      signal
    );


  if (
    !key
  ) {
    return false;
  }


  if (
    state.scannerSeenSignals.has(
      key
    )
  ) {

    return false;
  }


  state.scannerSeenSignals.add(
    key
  );


  return true;
}


/* ============================================================
   CENTRAL SIGNAL PROCESSOR
   ============================================================ */

function processSignal(
  signal,
  options = {}
) {

  if (
    !signal ||
    signal.status !==
    "SIGNAL"
  ) {

    return;
  }


  const key =
    signalKey(
      signal
    );


  if (!key) return;


  const alreadyNotified =
    state.notifiedSignals.has(
      key
    );


  if (
    !alreadyNotified &&
    options.notify !== false
  ) {

    state.notifiedSignals.add(
      key
    );

    sendSignalAlert(
      signal
    );
  }


  addSignalToHistory(
    signal
  );


  if (
    signal.symbol ===
    state.selectedSymbol &&
    signal.timeframe ===
    state.selectedTimeframe
  ) {

    state.activeSignal =
      signal;

    state.tradeState = {

      signal,

      tp1Hit: false,

      tp2Hit: false,

      tp3Hit: false,

      stopped: false,

      breakeven: false,

      currentSL:
        signal.sl
    };
  }
}


/* ============================================================
   BACKGROUND SIGNAL ALERT
   ============================================================ */

function sendBackgroundSignalAlert(
  signal
) {

  const key =
    scannerSignalKey(
      signal
    );


  if (
    state.scannerNotifiedSignals.has(
      key
    )
  ) {

    return;
  }


  state.scannerNotifiedSignals.add(
    key
  );


  if (
    !state.notifiedSignals.has(
      key
    )
  ) {

    state.notifiedSignals.add(
      key
    );

    sendSignalAlert(
      signal
    );
  }


  addSignalToHistory(
    signal
  );


  state.scannerSignals[
    scannerContextKey(
      signal.symbol,
      signal.timeframe
    )
  ] = signal;
}


/* ============================================================
   BUILD SIGNAL MESSAGE
   ============================================================ */

function buildSignalMessage(
  signal
) {

  const direction =
    signal.signal ||
    signal.direction;


  const icon =
    direction === "BUY"
      ? "🟢"
      : "🔴";


  const action =
    direction === "BUY"
      ? "SNIPER BUY"
      : "SNIPER SELL";


  return (
`${icon} PRECISION ${action}

Market: ${signal.symbol}
Timeframe: ${signal.timeframe}

Entry: ${formatPrice(signal.entry)}
SL: ${formatPrice(signal.sl)}
TP1: ${formatPrice(signal.tp1)}
TP2: ${formatPrice(signal.tp2)}
TP3: ${formatPrice(signal.tp3)}

RR: 1:3

Reason:
${signal.reason}`
  );
}


/* ============================================================
   BROWSER / IN-APP ALERT
   ============================================================ */

function sendSignalAlert(
  signal
) {

  if (
    !state.alertsEnabled
  ) {
    return;
  }


  const message =
    buildSignalMessage(
      signal
    );


  console.log(
    "PRECISION SIGNAL:",
    message
  );


  /* Browser notification. */
  if (
    "Notification" in window
  ) {

    if (
      Notification.permission ===
      "granted"
    ) {

      try {

        new Notification(
          `PRECISION ${signal.signal} — ${signal.symbol}`,
          {
            body:
              `TF: ${signal.timeframe} | Entry: ${formatPrice(signal.entry)} | SL: ${formatPrice(signal.sl)} | TP3: ${formatPrice(signal.tp3)}`,

            tag:
              signalKey(signal)
          }
        );

      } catch (error) {

        console.warn(
          "Notification error:",
          error
        );
      }

    } else if (
      Notification.permission ===
      "default"
    ) {

      Notification.requestPermission()
        .catch(
          () => {}
        );
    }
  }


  /* Optional custom alert hooks. */
  if (
    typeof window.onPrecisionSignal ===
    "function"
  ) {

    try {

      window.onPrecisionSignal(
        signal
      );

    } catch (error) {

      console.error(
        error
      );
    }
  }


  /* Optional custom event for UI. */
  window.dispatchEvent(
    new CustomEvent(
      "precision-signal",
      {
        detail:
          signal
      }
    )
  );


  updateSignalDisplay(
    signal
  );
}


/* ============================================================
   SIGNAL DISPLAY
   ============================================================ */

function updateSignalDisplay(
  signal
) {

  if (
    !signal
  ) {
    return;
  }


  const direction =
    signal.signal ||
    signal.direction;


  setText(
    "signal",
    direction === "BUY"
      ? "🟢 SNIPER BUY"
      : "🔴 SNIPER SELL"
  );


  setText(
    "direction",
    direction === "BUY"
      ? "🟢 BUY DIRECTION"
      : "🔴 SELL DIRECTION"
  );


  setText(
    "setup",
    "PRECISION SNIPER SETUP"
  );


  setText(
    "confidence",
    "HIGH"
  );


  setText(
    "rr",
    signal.rr || "1:3"
  );


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


  setText(
    "tp3",
    formatPrice(
      signal.tp3
    )
  );


  setText(
    "swing",
    direction === "BUY"
      ? "Bullish Swing"
      : "Bearish Swing"
  );


  setText(
    "structure",
    direction
  );


  setText(
    "liquidity",
    direction === "BUY"
      ? "Support / Swing Low"
      : "Resistance / Swing High"
  );


  setText(
    "sr",
    direction === "BUY"
      ? formatPrice(
          signal.support
        )
      : formatPrice(
          signal.resistance
        )
  );


  setText(
    "pattern",
    signal.pattern
  );


  setText(
    "rejection",
    signal.rejection
      ? "Confirmed"
      : "Not required"
  );


  setText(
    "momentum",
    signal.momentum
      ? "Confirmed"
      : "Waiting"
  );


  setText(
    "confirmation",
    "CONFIRMED"
  );


  setText(
    "explanationText",
    signal.reason
  );


  updateAnalysisChecklist(
    signal
  );
}


/* ============================================================
   WAIT DISPLAY
   ============================================================ */

function showWaitState(
  result
) {

  setText(
    "signal",
    "⚪ WAIT — NO SETUP"
  );


  setText(
    "direction",
    result.direction ||
      "NEUTRAL"
  );


  setText(
    "setup",
    "NO CONFIRMED SETUP"
  );


  setText(
    "confidence",
    "WAIT"
  );


  setText(
    "rr",
    "—"
  );


  setText(
    "entry",
    result.entry
      ? formatPrice(
          result.entry
        )
      : "—"
  );


  setText(
    "sl",
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
    "tp3",
    "—"
  );


  setText(
    "swing",
    result.direction ||
      "WAIT"
  );


  setText(
    "structure",
    result.direction ||
      "NEUTRAL"
  );


  setText(
    "liquidity",
    "Waiting"
  );


  setText(
    "sr",
    "—"
  );


  setText(
    "pattern",
    result.pattern ||
      "WAIT"
  );


  setText(
    "rejection",
    "Waiting"
  );


  setText(
    "momentum",
    "Waiting"
  );


  setText(
    "confirmation",
    "WAIT"
  );


  setText(
    "explanationText",
    result.reason ||
      "No complete setup."
  );


  updateAnalysisChecklist(
    result
  );
}


/* ============================================================
   ANALYSIS CHECKLIST
   ============================================================ */

function updateAnalysisChecklist(
  result
) {

  const direction =
    result.signal ||
    result.direction;


  const checks = {

    swing:
      direction === "BUY" ||
      direction === "SELL",

    structure:
      direction === "BUY" ||
      direction === "SELL",

    sr:
      Boolean(
        result.support ||
        result.resistance
      ),

    candle:
      result.rejection ||
      result.momentum ||
      result.pattern
  };


  const mappings = [
    [
      "swingCheck",
      checks.swing
    ],

    [
      "structureCheck",
      checks.structure
    ],

    [
      "srCheck",
      checks.sr
    ],

    [
      "candleCheck",
      checks.candle
    ]
  ];


  for (
    const [id, passed]
    of mappings
  ) {

    const element =
      $(id);

    if (!element) continue;


    element.textContent =
      passed
        ? "✓"
        : "○";
  }
}


/* ============================================================
   SIGNAL HISTORY
   ============================================================ */

function addSignalToHistory(
  signal
) {

  if (
    !signal ||
    signal.status !==
    "SIGNAL"
  ) {
    return;
  }


  const key =
    signalKey(
      signal
    );


  if (
    state.signalHistory.some(
      item =>
        signalKey(item) ===
        key
    )
  ) {

    return;
  }


  state.signalHistory.unshift(
    signal
  );


  if (
    state.signalHistory.length >
    100
  ) {

    state.signalHistory =
      state.signalHistory.slice(
        0,
        100
      );
  }


  renderSignalHistory();
}


function renderSignalHistory() {

  const container =
    $(
      "signalHistory"
    );


  if (!container) return;


  container.innerHTML =
    "";


  for (
    const signal of
    state.signalHistory
  ) {

    const direction =
      signal.signal ||
      signal.direction;


    const item =
      document.createElement(
        "div"
      );


    item.className =
      "signal-history-item";


    item.innerHTML =
`
<div>
  <strong>
    ${
      direction === "BUY"
        ? "🟢 BUY"
        : "🔴 SELL"
    }
  </strong>
  ${escapeHTML(signal.symbol)}
  — ${escapeHTML(signal.timeframe)}
</div>

<div>
  Entry:
  ${escapeHTML(formatPrice(signal.entry))}
</div>

<div>
  SL:
  ${escapeHTML(formatPrice(signal.sl))}
</div>

<div>
  TP1:
  ${escapeHTML(formatPrice(signal.tp1))}
  |
  TP2:
  ${escapeHTML(formatPrice(signal.tp2))}
  |
  TP3:
  ${escapeHTML(formatPrice(signal.tp3))}
</div>
`;


    container.appendChild(
      item
    );
  }
}


/* ============================================================
   TRADE MANAGEMENT
   ============================================================ */

function manageActiveTrade(
  price
) {

  const trade =
    state.tradeState;


  if (
    !trade ||
    trade.stopped
  ) {

    return;
  }


  const signal =
    trade.signal;


  const direction =
    signal.signal ||
    signal.direction;


  if (
    direction === "BUY"
  ) {

    if (
      !trade.tp1Hit &&
      price >= signal.tp1
    ) {

      trade.tp1Hit = true;

      trade.currentSL =
        signal.entry;

      trade.breakeven =
        true;

      notifyTradeEvent(
        "TP1 HIT ✅",
        signal
      );
    }


    if (
      !trade.tp2Hit &&
      price >= signal.tp2
    ) {

      trade.tp2Hit = true;

      notifyTradeEvent(
        "TP2 HIT ✅",
        signal
      );
    }


    if (
      !trade.tp3Hit &&
      price >= signal.tp3
    ) {

      trade.tp3Hit = true;

      notifyTradeEvent(
        "TP3 HIT 🎯",
        signal
      );
    }


    if (
      price <=
      trade.currentSL
    ) {

      trade.stopped = true;

      notifyTradeEvent(
        trade.breakeven
          ? "BREAKEVEN HIT"
          : "STOP LOSS HIT ❌",
        signal
      );
    }

  } else {

    if (
      !trade.tp1Hit &&
      price <= signal.tp1
    ) {

      trade.tp1Hit = true;

      trade.currentSL =
        signal.entry;

      trade.breakeven =
        true;

      notifyTradeEvent(
        "TP1 HIT ✅",
        signal
      );
    }


    if (
      !trade.tp2Hit &&
      price <= signal.tp2
    ) {

      trade.tp2Hit = true;

      notifyTradeEvent(
        "TP2 HIT ✅",
        signal
      );
    }


    if (
      !trade.tp3Hit &&
      price <= signal.tp3
    ) {

      trade.tp3Hit = true;

      notifyTradeEvent(
        "TP3 HIT 🎯",
        signal
      );
    }


    if (
      price >=
      trade.currentSL
    ) {

      trade.stopped = true;

      notifyTradeEvent(
        trade.breakeven
          ? "BREAKEVEN HIT"
          : "STOP LOSS HIT ❌",
        signal
      );
    }
  }
}


/* ============================================================
   TRADE EVENT
   ============================================================ */

function notifyTradeEvent(
  text,
  signal
) {

  console.log(
    text,
    signal.symbol,
    signal.timeframe
  );


  window.dispatchEvent(
    new CustomEvent(
      "precision-trade-event",
      {
        detail: {
          text,
          signal
        }
      }
    )
  );


  if (
    "Notification" in window &&
    Notification.permission ===
      "granted"
  ) {

    try {

      new Notification(
        `${text} — ${signal.symbol}`,
        {
          body:
            `${signal.timeframe} | Entry ${formatPrice(signal.entry)}`,

          tag:
            `${signalKey(signal)}::${text}`
        }
      );

    } catch (error) {

      console.warn(
        error
      );
    }
  }
}


/* ============================================================
   FULL SCANNER QUEUE
   PAIR × TIMEFRAME
   ============================================================ */

function buildScannerQueue() {

  const queue = [];


  const symbols =
    state.symbols
      .map(
        item =>
          item.symbol
      )
      .filter(Boolean);


  const timeframes =
    CONFIG.SCANNER_ALL_TIMEFRAMES
      ? getAllTimeframes()
      : [
          state.selectedTimeframe
        ];


  for (
    const symbol of symbols
  ) {

    for (
      const timeframe
      of timeframes
    ) {

      queue.push({
        symbol,
        timeframe
      });
    }
  }


  return queue;
}


/* ============================================================
   START FULL SCANNER
   ============================================================ */

function startFullScanner() {

  if (
    !CONFIG.SCANNER_ENABLED
  ) {
    return;
  }


  if (
    !state.connected
  ) {
    return;
  }


  state.scannerGeneration++;


  state.scannerQueue =
    buildScannerQueue();


  state.scannerQueueIndex =
    0;


  state.scannerStats.pairs =
    state.symbols.length;


  state.scannerStats.timeframes =
    getAllTimeframes().length;


  state.scannerStats.combinations =
    state.scannerQueue.length;


  state.scannerStats.scanned =
    0;


  if (
    state.scannerRunning
  ) {

    return;
  }


  state.scannerRunning =
    true;


  runScannerWorker();
}


/* ============================================================
   SCANNER WORKER
   ============================================================ */

async function runScannerWorker() {

  while (
    state.scannerRunning
  ) {

    if (
      !state.connected
    ) {

      await sleep(
        1000
      );

      continue;
    }


    if (
      !state.scannerQueue.length
    ) {

      state.scannerQueue =
        buildScannerQueue();

      state.scannerQueueIndex =
        0;
    }


    const generation =
      state.scannerGeneration;


    const batch =
      state.scannerQueue.slice(
        state.scannerQueueIndex,
        state.scannerQueueIndex +
          CONFIG.SCANNER_BATCH_SIZE
      );


    if (
      !batch.length
    ) {

      state.scannerQueue =
        buildScannerQueue();

      state.scannerQueueIndex =
        0;

      state.scannerStats.lastRun =
        new Date().toISOString();

      await sleep(
        CONFIG.SCANNER_DELAY
      );

      continue;
    }


    for (
      const item of batch
    ) {

      if (
        generation !==
        state.scannerGeneration
      ) {

        break;
      }


      await scanSingleMarket(
        item.symbol,
        item.timeframe
      );


      state.scannerStats.scanned++;


      await sleep(
        CONFIG.SCANNER_DELAY
      );
    }


    state.scannerQueueIndex +=
      batch.length;


    if (
      state.scannerQueueIndex >=
      state.scannerQueue.length
    ) {

      state.scannerQueue =
        buildScannerQueue();

      state.scannerQueueIndex =
        0;

      state.scannerStats.lastRun =
        new Date().toISOString();
    }
  }
}


/* ============================================================
   SCAN ONE PAIR + TIMEFRAME
   ============================================================ */

async function scanSingleMarket(
  symbol,
  timeframe
) {

  const tf =
    normalizeTimeframe(
      timeframe
    );


  const context =
    scannerContextKey(
      symbol,
      tf
    );


  try {

    const candles =
      await loadTimeframeHistory(
        symbol,
        tf,
        false
      );


    if (
      !candles ||
      candles.length < 100
    ) {

      return;
    }


    const closed =
      getClosedCandles(
        candles,
        tf
      );


    if (
      closed.length < 100
    ) {

      return;
    }


    const latestClosed =
      closed[
        closed.length - 1
      ];


    const latestEpoch =
      Number(
        latestClosed.epoch
      );


    if (
      !latestEpoch
    ) {

      return;
    }


    /* ========================================================
       FIRST OBSERVATION
       ======================================================== */

    if (
      !state.scannerInitialized[
        context
      ]
    ) {

      state.scannerInitialized[
        context
      ] = true;


      state.scannerLastClosedCandle[
        context
      ] =
        latestEpoch;


      /*
       IMPORTANT:
       Do not alert on historical setup during
       initial baseline.
      */

      const baseline =
        generateSniperSignal(
          symbol,
          tf,
          closed
        );


      if (
        baseline.status ===
        "SIGNAL"
      ) {

        state.scannerSignals[
          context
        ] = baseline;


        state.scannerSeenSignals.add(
          scannerSignalKey(
            baseline
          )
        );
      }


      return;
    }


    /* ========================================================
       SAME CLOSED CANDLE
       ======================================================== */

    if (
      state.scannerLastClosedCandle[
        context
      ] === latestEpoch
    ) {

      return;
    }


    /* ========================================================
       NEW CLOSED CANDLE
       ======================================================== */

    state.scannerLastClosedCandle[
      context
    ] =
      latestEpoch;


    const signal =
      generateSniperSignal(
        symbol,
        tf,
        closed
      );


    state.scannerSignals[
      context
    ] =
      signal;


    if (
      signal.status !==
      "SIGNAL"
    ) {

      return;
    }


    const isNew =
      isNewScannerSignal(
        signal
      );


    if (!isNew) {

      return;
    }


    /*
     Only new confirmed signal is alerted.
    */

    sendBackgroundSignalAlert(
      signal
    );


    state.scannerStats.signals++;


  } catch (error) {

    console.warn(
      `Scanner error ${symbol} ${tf}:`,
      error.message ||
      error
    );
  }
}


/* ============================================================
   FORCE SCAN ONE PAIR + TIMEFRAME
   ============================================================ */

async function forceScan(
  symbol,
  timeframe
) {

  const tf =
    normalizeTimeframe(
      timeframe
    );


  const context =
    scannerContextKey(
      symbol,
      tf
    );


  try {

    const candles =
      await loadTimeframeHistory(
        symbol,
        tf,
        true
      );


    const closed =
      getClosedCandles(
        candles,
        tf
      );


    if (
      closed.length < 100
    ) {

      return null;
    }


    const signal =
      generateSniperSignal(
        symbol,
        tf,
        closed
      );


    state.scannerInitialized[
      context
    ] = true;


    state.scannerLastClosedCandle[
      context
    ] =
      closed[
        closed.length - 1
      ].epoch;


    return signal;

  } catch (error) {

    console.error(
      "Force scan error:",
      error
    );

    return null;
  }
}


/* ============================================================
   SELECTED PAIR ANALYSIS
   ============================================================ */

async function runPrecisionAnalysis(
  force = false
) {

  const symbol =
    state.selectedSymbol;


  const timeframe =
    state.selectedTimeframe;


  if (
    !symbol ||
    !timeframe
  ) {

    return;
  }


  const generation =
    state.analysisGeneration;


  if (
    state.analysisRunning
  ) {

    return;
  }


  state.analysisRunning =
    true;


  try {

    const candles =
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


    const closed =
      getClosedCandles(
        candles,
        timeframe
      );


    if (
      closed.length < 100
    ) {

      showWaitState({
        direction:
          "NEUTRAL",

        reason:
          "Waiting for enough closed market data."
      });

      return;
    }


    const result =
      generateSniperSignal(
        symbol,
        timeframe,
        closed
      );


    state.analysis =
      result;


    window.currentTimeframe =
      timeframe;

    window.closedCandles =
      closed;

    window.currentAnalysis =
      result;


    if (
      result.status ===
      "SIGNAL"
    ) {

      /*
       Selected analyzer should display the signal,
       but background scanner remains independent.
      */

      state.activeSignal =
        result;

      updateSignalDisplay(
        result
      );

      updateTradeState(
        result
      );

    } else {

      showWaitState(
        result
      );
    }


    window.dispatchEvent(
      new CustomEvent(
        "precision-analysis",
        {
          detail:
            result
        }
      )
    );


  } catch (error) {

    console.error(
      "Precision analysis error:",
      error
    );


    showWaitState({
      direction:
        "ERROR",

      reason:
        "Unable to retrieve live market data."
    });

  } finally {

    state.analysisRunning =
      false;
  }
}


/* ============================================================
   UPDATE SELECTED TRADE STATE
   ============================================================ */

function updateTradeState(
  signal
) {

  if (
    !signal ||
    signal.status !==
    "SIGNAL"
  ) {

    return;
  }


  const existing =
    state.tradeState;


  if (
    existing &&
    signalKey(
      existing.signal
    ) ===
    signalKey(signal)
  ) {

    return;
  }


  state.tradeState = {

    signal,

    tp1Hit: false,

    tp2Hit: false,

    tp3Hit: false,

    stopped: false,

    breakeven: false,

    currentSL:
      signal.sl
  };
}


/* ============================================================
   SELECT TIMEFRAME
   ============================================================ */

async function selectTimeframe(
  timeframe
) {

  const tf =
    normalizeTimeframe(
      timeframe
    );


  state.selectedTimeframe =
    tf;


  state.analysisGeneration++;


  state.activeSignal =
    null;


  state.tradeState =
    null;


  state.analysis =
    null;


  const generation =
    state.analysisGeneration;


  try {

    const candles =
      await loadTimeframeHistory(
        state.selectedSymbol,
        tf,
        true
      );


    if (
      generation !==
      state.analysisGeneration
    ) {

      return;
    }


    const closed =
      getClosedCandles(
        candles,
        tf
      );


    const result =
      generateSniperSignal(
        state.selectedSymbol,
        tf,
        closed
      );


    state.analysis =
      result;


    if (
      result.status ===
      "SIGNAL"
    ) {

      updateSignalDisplay(
        result
      );

      updateTradeState(
        result
      );

    } else {

      showWaitState(
        result
      );
    }


  } catch (error) {

    console.error(
      "Timeframe selection error:",
      error
    );
  }
}


/* ============================================================
   ANALYSIS LOOP
   ============================================================ */

function startAnalysisLoop() {

  setInterval(
    () => {

      if (
        state.selectedSymbol
      ) {

        runPrecisionAnalysis(
          false
        );
      }

    },
    CONFIG.ANALYSIS_INTERVAL
  );
}


/* ============================================================
   REQUEST NOTIFICATION PERMISSION
   ============================================================ */

async function enableNotifications() {

  if (
    !("Notification" in window)
  ) {

    return;
  }


  try {

    const permission =
      await Notification.requestPermission();


    state.alertsEnabled =
      permission ===
      "granted";


  } catch (error) {

    console.warn(
      error
    );
  }
}


/* ============================================================
   AI QUESTION BAR
   ============================================================ */

function setupQuestionBar() {

  const input =
    $(
      "questionInput"
    );


  const button =
    $(
      "questionButton"
    );


  const answer =
    $(
      "questionAnswer"
    );


  if (
    !input ||
    !button
  ) {

    return;
  }


  function answerQuestion() {

    const question =
      input.value
        .trim()
        .toLowerCase();


    if (!question) {
      return;
    }


    let response =
      "Ask me about the current market structure, signal, entry, SL, TP, timeframe, support/resistance, candle confirmation or why the bot is waiting.";


    const analysis =
      state.analysis;


    if (
      !analysis
    ) {

      response =
        "The bot is still loading live market data.";

    } else if (
      question.includes(
        "why"
      ) &&
      question.includes(
        "buy"
      )
    ) {

      response =
        analysis.status ===
        "SIGNAL" &&
        (
          analysis.signal ||
          analysis.direction
        ) ===
        "BUY"

          ? analysis.reason

          : "There is currently no confirmed BUY setup.";

    } else if (
      question.includes(
        "why"
      ) &&
      question.includes(
        "sell"
      )
    ) {

      response =
        analysis.status ===
        "SIGNAL" &&
        (
          analysis.signal ||
          analysis.direction
        ) ===
        "SELL"

          ? analysis.reason

          : "There is currently no confirmed SELL setup.";

    } else if (
      question.includes(
        "entry"
      )
    ) {

      response =
        analysis.entry
          ? `Current confirmed entry: ${formatPrice(analysis.entry)}`
          : "There is no confirmed entry.";

    } else if (
      question.includes(
        "stop"
      ) ||
      question.includes(
        "sl"
      )
    ) {

      response =
        analysis.sl
          ? `Current stop loss: ${formatPrice(analysis.sl)}`
          : "There is no confirmed stop loss.";

    } else if (
      question.includes(
        "tp"
      ) ||
      question.includes(
        "take profit"
      )
    ) {

      response =
        analysis.tp1
          ? `TP1: ${formatPrice(analysis.tp1)}, TP2: ${formatPrice(analysis.tp2)}, TP3: ${formatPrice(analysis.tp3)}`
          : "There are no confirmed take-profit levels.";

    } else if (
      question.includes(
        "why"
      ) ||
      question.includes(
        "wait"
      )
    ) {

      response =
        analysis.reason ||
        "The bot is waiting for complete confirmation.";

    } else if (
      question.includes(
        "timeframe"
      )
    ) {

      response =
        `Current timeframe: ${state.selectedTimeframe}`;

    } else if (
      question.includes(
        "market"
      ) ||
      question.includes(
        "pair"
      )
    ) {

      response =
        `Current market: ${state.selectedSymbol}`;

    }


    if (answer) {

      answer.textContent =
        response;
    }


    window.dispatchEvent(
      new CustomEvent(
        "precision-question-answer",
        {
          detail: {
            question,
            answer:
              response
          }
        }
      )
    );
  }


  button.addEventListener(
    "click",
    answerQuestion
  );


  input.addEventListener(
    "keydown",
    event => {

      if (
        event.key ===
        "Enter"
      ) {

        answerQuestion();
      }
    }
  );
}


/* ============================================================
   SELECTOR EVENTS
   ============================================================ */

function setupUI() {

  const market =
    $("market");


  if (market) {

    market.addEventListener(
      "change",
      event => {

        selectMarket(
          event.target.value
        );
      }
    );
  }


  const analyze =
    $("analyze") ||
    $("analyzeBtn") ||
    $("analyzeButton");


  if (analyze) {

    analyze.addEventListener(
      "click",
      () => {

        runPrecisionAnalysis(
          true
        );
      }
    );
  }


  const timeframeButtons =
    $all(
      "[data-timeframe]"
    );


  for (
    const button of
    timeframeButtons
  ) {

    button.addEventListener(
      "click",
      () => {

        selectTimeframe(
          button.dataset.timeframe
        );
      }
    );
  }


  const notifyButton =
    $(
      "enableNotifications"
    );


  if (notifyButton) {

    notifyButton.addEventListener(
      "click",
      enableNotifications
    );
  }
}


/* ============================================================
   SCANNER STATUS EXPORT
   ============================================================ */

function getScannerStatus() {

  return {

    enabled:
      CONFIG.SCANNER_ENABLED,

    running:
      state.scannerRunning,

    connected:
      state.connected,

    pairs:
      state.scannerStats.pairs,

    timeframes:
      state.scannerStats.timeframes,

    combinations:
      state.scannerStats.combinations,

    scanned:
      state.scannerStats.scanned,

    signals:
      state.scannerStats.signals,

    lastRun:
      state.scannerStats.lastRun
  };
}


/* ============================================================
   PUBLIC DEBUG / API
   ============================================================ */

window.SuccessfulPineScript = {

  state,

  CONFIG,

  connect:
    connectDeriv,

  analyze:
    runPrecisionAnalysis,

  scan:
    startFullScanner,

  scanMarket:
    forceScan,

  selectMarket,

  selectTimeframe,

  generateSignal:
    generateSniperSignal,

  scannerStatus:
    getScannerStatus,

  requestNotifications:
    enableNotifications
};


/* ============================================================
   INITIALIZATION
   ============================================================ */

async function initialize() {

  if (
    state.initialized
  ) {

    return;
  }


  state.initialized =
    true;


  setConnectionStatus(
    "Connecting...",
    false
  );


  setupUI();

  setupQuestionBar();


  connectDeriv();


  startAnalysisLoop();


  /*
   Give the WebSocket time to obtain active symbols.
  */

  setTimeout(
    () => {

      if (
        state.connected &&
        state.symbols.length
      ) {

        if (
          !state.selectedSymbol
        ) {

          state.selectedSymbol =
            state.symbols[0].symbol;
        }


        subscribeToTick(
          state.selectedSymbol
        );


        runPrecisionAnalysis(
          true
        );


        startFullScanner();
      }

    },
    2500
  );
}


/* ============================================================
   START APPLICATION
   ============================================================ */

if (
  document.readyState ===
  "loading"
) {

  document.addEventListener(
    "DOMContentLoaded",
    initialize
  );

} else {

  initialize();
}
