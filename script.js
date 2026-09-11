/* ============================================================
   SUCCESSFUL PINE SCRIPT
   PRECISION SNIPER SIGNAL ENGINE
   ------------------------------------------------------------
   LIVE DERIV PUBLIC MARKET DATA
   CLOSED-CANDLE / NON-REPAINTING ANALYSIS
   MARKET STRUCTURE + PRICE ACTION + CANDLE CONFIRMATION
   DEPTH 30 / DEVIATION 5 / BACKSTEP 5
   ------------------------------------------------------------
   IMPORTANT:
   - Public market data only
   - No trading/account token in frontend
   - Signals are educational and must be tested
   ============================================================ */

"use strict";

/* ============================================================
   CONFIGURATION
   ============================================================ */

const CONFIG = {
  DERIV_WS:
    "wss://api.derivws.com/trading/v1/options/ws/public",

  HISTORY_COUNT: 1000,

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

  RECONNECT_MIN: 1000,
  RECONNECT_MAX: 30000,

  ANALYSIS_INTERVAL: 5000,

  SIGNAL_COOLDOWN:
    60 * 60 * 1000,

  /* =========================
     BACKGROUND SCANNER
     ========================= */

  SCANNER_ENABLED: true,

  SCANNER_BATCH_SIZE: 3,

  SCANNER_DELAY: 250,

  /* Don't overload the public websocket */
  MAX_SYMBOLS_TO_SCAN: 250
};


/* ============================================================
   GLOBAL STATE
   ============================================================ */

const state = {
  ws: null,

  connected: false,

  reconnectTimer: null,

  reconnectDelay:
    CONFIG.RECONNECT_MIN,

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

  /* =========================
     BACKGROUND SCANNER STATE
     ========================= */

  scannerRunning: false,

  scannerLastClosedCandle: {},

  scannerSignals: {},

  scannerSeenSignals: new Set(),

  scannerNotifiedSignals: new Set(),

  scannerGeneration: 0
};


/* ============================================================
   DOM HELPERS
   ============================================================ */

function $(id) {
  return document.getElementById(id);
}

function $all(selector) {
  return Array.from(
    document.querySelectorAll(selector)
  );
}

function setText(id, value) {
  const el = $(id);

  if (el) {
    el.textContent =
      value === undefined ||
      value === null
        ? "—"
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
   TIMEFRAME HELPERS
   ============================================================ */

function normalizeTimeframe(value) {
  if (!value) return "M5";

  const v =
    String(value)
      .trim()
      .toUpperCase();

  if (v === "1M") return "M1";
  if (v === "5M") return "M5";
  if (v === "15M") return "M15";
  if (v === "30M") return "M30";
  if (v === "1H") return "H1";
  if (v === "2H") return "H2";
  if (v === "4H") return "H4";
  if (
    v === "D1" ||
    v === "1D" ||
    v === "DAY"
  ) {
    return "Daily";
  }

  if (
    Object.prototype.hasOwnProperty.call(
      CONFIG.TIMEFRAMES,
      v
    )
  ) {
    return v;
  }

  return "M5";
}

function getSelectedTimeframe() {
  const selected =
    document.querySelector(
      "[data-timeframe].active"
    );

  if (selected) {
    return normalizeTimeframe(
      selected.dataset.timeframe
    );
  }

  return normalizeTimeframe(
    state.selectedTimeframe
  );
}


/* ============================================================
   NUMBER / PRICE HELPERS
   ============================================================ */

function getDecimals(price) {
  const n = Number(price);

  if (!Number.isFinite(n)) {
    return 5;
  }

  if (Math.abs(n) >= 1000) {
    return 2;
  }

  if (Math.abs(n) >= 100) {
    return 2;
  }

  if (Math.abs(n) >= 10) {
    return 3;
  }

  if (Math.abs(n) >= 1) {
    return 5;
  }

  return 5;
}

function formatPrice(price) {
  const n = Number(price);

  if (!Number.isFinite(n)) {
    return "—";
  }

  return n.toFixed(
    getDecimals(n)
  );
}

function roundPrice(price) {
  const n = Number(price);

  if (!Number.isFinite(n)) {
    return price;
  }

  return Number(
    n.toFixed(getDecimals(n))
  );
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}


/* ============================================================
   CONNECTION STATUS
   ============================================================ */

function setConnectionStatus(
  connected,
  message
) {
  state.connected = connected;

  setText(
    "connectionText",
    message ||
      (connected
        ? "CONNECTED"
        : "DISCONNECTED")
  );

  const status =
    $("connectionStatus");

  if (status) {
    status.classList.toggle(
      "connected",
      connected
    );

    status.classList.toggle(
      "disconnected",
      !connected
    );
  }
}


/* ============================================================
   WEBSOCKET
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
    false,
    "CONNECTING..."
  );

  try {
    state.ws =
      new WebSocket(
        CONFIG.DERIV_WS
      );
  } catch (error) {
    console.error(
      "WebSocket creation failed:",
      error
    );

    scheduleReconnect();

    return;
  }

  state.ws.onopen = () => {
    state.connected = true;

    state.reconnectDelay =
      CONFIG.RECONNECT_MIN;

    setConnectionStatus(
      true,
      "CONNECTED"
    );

    refreshMarkets();

    if (state.selectedSymbol) {
      subscribeToTick(
        state.selectedSymbol
      );
    }
  };

  state.ws.onmessage = event => {
    handleWebSocketMessage(
      event.data
    );
  };

  state.ws.onerror = error => {
    console.error(
      "Deriv WebSocket error:",
      error
    );

    setConnectionStatus(
      false,
      "CONNECTION ERROR"
    );
  };

  state.ws.onclose = () => {
    state.connected = false;

    setConnectionStatus(
      false,
      "DISCONNECTED"
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
      state.reconnectTimer =
        null;

      connectDeriv();

      state.reconnectDelay =
        Math.min(
          state.reconnectDelay * 2,
          CONFIG.RECONNECT_MAX
        );
    }, delay);
}


/* ============================================================
   REQUEST SYSTEM
   ============================================================ */

function sendRequest(payload) {
  return new Promise(
    (resolve, reject) => {
      if (
        !state.ws ||
        state.ws.readyState !==
          WebSocket.OPEN
      ) {
        reject(
          new Error(
            "WebSocket is not connected"
          )
        );

        return;
      }

      const reqId =
        state.requestId++;

      const request =
        {
          ...payload,
          req_id: reqId
        };

      const timeout =
        setTimeout(() => {
          state.pendingRequests.delete(
            reqId
          );

          reject(
            new Error(
              "Request timeout"
            )
          );
        }, 15000);

      state.pendingRequests.set(
        reqId,
        {
          resolve,
          reject,
          timeout
        }
      );

      try {
        state.ws.send(
          JSON.stringify(request)
        );
      } catch (error) {
        clearTimeout(timeout);

        state.pendingRequests.delete(
          reqId
        );

        reject(error);
      }
    }
  );
}


/* ============================================================
   WEBSOCKET MESSAGE HANDLER
   ============================================================ */

function handleWebSocketMessage(
  raw
) {
  let data;

  try {
    data =
      JSON.parse(raw);
  } catch {
    return;
  }

  if (data.req_id) {
    const pending =
      state.pendingRequests.get(
        data.req_id
      );

    if (pending) {
      clearTimeout(
        pending.timeout
      );

      state.pendingRequests.delete(
        data.req_id
      );

      if (data.error) {
        pending.reject(
          new Error(
            data.error.message ||
              "Deriv request failed"
          )
        );
      } else {
        pending.resolve(data);
      }
    }
  }

  if (
    data.msg_type ===
      "active_symbols" ||
    data.active_symbols
  ) {
    processActiveSymbols(
      data.active_symbols ||
        data.activeSymbols ||
        []
    );
  }

  if (
    data.msg_type === "tick" &&
    data.tick
  ) {
    processTick(
      data.tick
    );
  }

  if (
    data.msg_type ===
      "history"
  ) {
    processHistoryResponse(
      data
    );
  }
}


/* ============================================================
   ACTIVE MARKETS
   ============================================================ */

function processActiveSymbols(
  rawSymbols
) {
  if (!Array.isArray(rawSymbols)) {
    return;
  }

  const parsed =
    rawSymbols
      .map(item => {
        const symbol =
          item.underlying_symbol ||
          item.symbol;

        const name =
          item.underlying_symbol_name ||
          item.display_name ||
          symbol;

        const type =
          item.underlying_symbol_type ||
          item.symbol_type ||
          "";

        if (!symbol) {
          return null;
        }

        return {
          symbol,
          name,
          type
        };
      })
      .filter(Boolean);

  const unique =
    new Map();

  for (const item of parsed) {
    if (!unique.has(item.symbol)) {
      unique.set(
        item.symbol,
        item
      );
    }
  }

  state.symbols =
    Array.from(
      unique.values()
    );

  populateMarketSelector();

  if (
    !state.selectedSymbol &&
    state.symbols.length
  ) {
    const preferred =
      state.symbols.find(
        item =>
          item.symbol ===
          "XAUUSD"
      );

    selectMarket(
      preferred?.symbol ||
        state.symbols[0].symbol
    );
  }
}

async function refreshMarkets() {
  try {
    const response =
      await sendRequest({
        active_symbols:
          "brief"
      });

    processActiveSymbols(
      response.active_symbols ||
        []
    );
  } catch (error) {
    console.error(
      "Active symbols error:",
      error
    );
  }
}


/* ============================================================
   MARKET SELECTOR
   ============================================================ */

function populateMarketSelector() {
  const select =
    $("market");

  if (!select) {
    return;
  }

  const current =
    state.selectedSymbol;

  select.innerHTML = "";

  for (
    const item of state.symbols
  ) {
    const option =
      document.createElement(
        "option"
      );

    option.value =
      item.symbol;

    option.textContent =
      `${item.symbol} — ${item.name}`;

    select.appendChild(
      option
    );
  }

  if (current) {
    select.value =
      current;
  }
}

function selectMarket(
  symbol
) {
  if (!symbol) {
    return;
  }

  state.selectedSymbol =
    symbol;

  const select =
    $("market");

  if (select) {
    select.value =
      symbol;
  }

  updateSelectedMarketUI();

  subscribeToTick(
    symbol
  );

  state.analysisGeneration++;

  state.activeSignal =
    null;

  state.tradeState =
    null;

  state.analysis =
    null;

  runPrecisionAnalysis(
    true
  );
}

function updateSelectedMarketUI() {
  setText(
    "selectedMarket",
    state.selectedSymbol
  );

  setText(
    "chosenPair",
    state.selectedSymbol
  );
}


/* ============================================================
   TICK SUBSCRIPTION
   ============================================================ */

function subscribeToTick(
  symbol
) {
  if (!symbol) {
    return;
  }

  if (
    !state.ws ||
    state.ws.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  try {
    state.ws.send(
      JSON.stringify({
        ticks: symbol,
        subscribe: 1
      })
    );
  } catch (error) {
    console.error(
      "Tick subscription failed:",
      error
    );
  }
}

function processTick(
  tick
) {
  const symbol =
    tick.symbol;

  const quote =
    Number(tick.quote);

  if (!Number.isFinite(quote)) {
    return;
  }

  if (
    symbol ===
    state.selectedSymbol
  ) {
    state.livePrice =
      quote;

    setText(
      "livePrice",
      formatPrice(quote)
    );

    updateTradeManagement(
      quote
    );
  }
}


/* ============================================================
   HISTORY
   ============================================================ */

async function loadTimeframeHistory(
  symbol,
  timeframe,
  force = false
) {
  timeframe =
    normalizeTimeframe(
      timeframe
    );

  const duration =
    CONFIG.TIMEFRAMES[
      timeframe
    ];

  if (!duration) {
    throw new Error(
      `Invalid timeframe: ${timeframe}`
    );
  }

  if (!state.pendingHistory) {
    state.pendingHistory =
      new Map();
  }

  const cacheKey =
    `${symbol}|${timeframe}`;

  const cached =
    state.candles[
      cacheKey
    ];

  /*
   * Important:
   * Do NOT blindly reuse old history.
   * Reuse it only when it already contains
   * the latest CLOSED candle.
   */

  if (
    !force &&
    cached &&
    cached.candles?.length >=
      100
  ) {
    const now =
      Math.floor(
        Date.now() / 1000
      );

    const expectedLatestClosed =
      Math.floor(
        now / duration
      ) *
        duration -
      duration;

    const cachedLatest =
      cached.candles[
        cached.candles.length - 1
      ]?.epoch || 0;

    if (
      cachedLatest >=
      expectedLatestClosed
    ) {
      return cached.candles;
    }
  }

  if (
    state.pendingHistory.has(
      cacheKey
    )
  ) {
    return state.pendingHistory.get(
      cacheKey
    );
  }

  const promise =
    (async () => {
      try {
        const response =
          await sendRequest({
            ticks_history:
              symbol,

            adjust_start_time:
              1,

            count:
              CONFIG.HISTORY_COUNT,

            end:
              "latest",

            style:
              "candles",

            granularity:
              duration
          });

        const candles =
          parseHistoryCandles(
            response
          );

        if (
          candles.length
        ) {
          state.candles[
            cacheKey
          ] = {
            candles,
            updatedAt:
              Date.now()
          };
        }

        return candles;
      } finally {
        state.pendingHistory.delete(
          cacheKey
        );
      }
    })();

  state.pendingHistory.set(
    cacheKey,
    promise
  );

  return promise;
}

function parseHistoryCandles(
  response
) {
  const raw =
    response?.candles ||
    [];

  if (!Array.isArray(raw)) {
    return [];
  }

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


/* ============================================================
   CLOSED CANDLES ONLY
   ============================================================ */

function getClosedCandles(
  candles,
  timeframe
) {
  if (
    !Array.isArray(
      candles
    ) ||
    candles.length <
      10
  ) {
    return [];
  }

  const duration =
    CONFIG.TIMEFRAMES[
      normalizeTimeframe(
        timeframe
      )
    ];

  if (!duration) {
    return [];
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  const currentCandleStart =
    Math.floor(
      now / duration
    ) *
    duration;

  return candles.filter(
    candle =>
      Number(
        candle.epoch
      ) <
      currentCandleStart
  );
}


/* ============================================================
   EMA
   ============================================================ */

function calculateEMA(
  values,
  length
) {
  if (
    !Array.isArray(values) ||
    values.length <
      length
  ) {
    return null;
  }

  const multiplier =
    2 /
    (length + 1);

  let ema =
    values
      .slice(
        0,
        length
      )
      .reduce(
        (sum, value) =>
          sum + Number(value),
        0
      ) / length;

  for (
    let i = length;
    i < values.length;
    i++
  ) {
    ema =
      (Number(
        values[i]
      ) -
        ema) *
        multiplier +
      ema;
  }

  return ema;
}


/* ============================================================
   ATR
   ============================================================ */

function calculateATR(
  candles,
  length =
    CONFIG.ATR_LENGTH
) {
  if (
    candles.length <
    length + 1
  ) {
    return null;
  }

  const trueRanges =
    [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
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

    trueRanges.push(tr);
  }

  if (
    trueRanges.length <
    length
  ) {
    return null;
  }

  return (
    trueRanges
      .slice(
        -length
      )
      .reduce(
        (sum, value) =>
          sum + value,
        0
      ) / length
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

  if (
    !Array.isArray(
      candles
    ) ||
    candles.length <
      CONFIG.DEPTH * 2 + 5
  ) {
    return swings;
  }

  const depth =
    CONFIG.DEPTH;

  const deviation =
    CONFIG.DEVIATION;

  const backstep =
    CONFIG.BACKSTEP;

  let lastHigh =
    null;

  let lastLow =
    null;

  for (
    let i = depth;
    i <
    candles.length - depth;
    i++
  ) {
    const current =
      candles[i];

    let isHigh =
      true;

    let isLow =
      true;

    for (
      let j = 1;
      j <= depth;
      j++
    ) {
      if (
        current.high <=
          candles[i - j].high ||
        current.high <
          candles[i + j].high
      ) {
        isHigh = false;
      }

      if (
        current.low >=
          candles[i - j].low ||
        current.low >
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

    if (isHigh) {
      const price =
        current.high;

      if (
        lastHigh === null ||
        Math.abs(
          price -
            lastHigh
        ) >=
          deviation *
            getMinimumTickDistance(
              candles
            )
      ) {
        swings.push({
          type: "HIGH",
          index: i,
          epoch:
            current.epoch,
          price
        });

        lastHigh =
          price;
      }
    }

    if (isLow) {
      const price =
        current.low;

      if (
        lastLow === null ||
        Math.abs(
          price -
            lastLow
        ) >=
          deviation *
            getMinimumTickDistance(
              candles
            )
      ) {
        swings.push({
          type: "LOW",
          index: i,
          epoch:
            current.epoch,
          price
        });

        lastLow =
          price;
      }
    }
  }

  /*
   * Backstep cleanup.
   * Keep the stronger swing when two same-type
   * swings occur too close together.
   */

  const cleaned = [];

  for (
    const swing of swings
  ) {
    const previous =
      cleaned[
        cleaned.length - 1
      ];

    if (
      previous &&
      previous.type ===
        swing.type &&
      Math.abs(
        swing.index -
          previous.index
      ) <= backstep
    ) {
      if (
        swing.type ===
        "HIGH"
      ) {
        if (
          swing.price >
          previous.price
        ) {
          cleaned[
            cleaned.length - 1
          ] = swing;
        }
      } else {
        if (
          swing.price <
          previous.price
        ) {
          cleaned[
            cleaned.length - 1
          ] = swing;
        }
      }
    } else {
      cleaned.push(
        swing
      );
    }
  }

  return cleaned;
}

function getMinimumTickDistance(
  candles
) {
  const ranges =
    candles
      .slice(-100)
      .map(
        candle =>
          Math.abs(
            candle.high -
              candle.low
          )
      )
      .filter(
        value =>
          Number.isFinite(
            value
          ) &&
          value > 0
      );

  if (!ranges.length) {
    return 0.00001;
  }

  return (
    ranges.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    ranges.length /
    10
  );
}

function getUsableSwings(
  swings,
  candles
) {
  if (
    !swings.length
  ) {
    return {
      highs: [],
      lows: [],
      latestHigh: null,
      latestLow: null
    };
  }

  const lastEpoch =
    candles[
      candles.length - 1
    ]?.epoch || 0;

  const confirmed =
    swings.filter(
      swing =>
        swing.epoch <
        lastEpoch
    );

  const highs =
    confirmed
      .filter(
        swing =>
          swing.type ===
          "HIGH"
      )
      .slice(-10);

  const lows =
    confirmed
      .filter(
        swing =>
          swing.type ===
          "LOW"
      )
      .slice(-10);

  return {
    highs,
    lows,

    latestHigh:
      highs[
        highs.length - 1
      ] || null,

    latestLow:
      lows[
        lows.length - 1
      ] || null
  };
}


/* ============================================================
   MARKET DIRECTION
   ============================================================ */

function determineDirection(
  candles,
  swings
) {
  if (
    candles.length <
    10
  ) {
    return "WAIT";
  }

  const latest =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const usable =
    getUsableSwings(
      swings,
      candles
    );

  if (
    usable.highs.length <
      2 ||
    usable.lows.length <
      2
  ) {
    return "WAIT";
  }

  const high1 =
    usable.highs[
      usable.highs.length - 2
    ];

  const high2 =
    usable.highs[
      usable.highs.length - 1
    ];

  const low1 =
    usable.lows[
      usable.lows.length - 2
    ];

  const low2 =
    usable.lows[
      usable.lows.length - 1
    ];

  const bullishStructure =
    high2.price >
      high1.price &&
    low2.price >
      low1.price;

  const bearishStructure =
    high2.price <
      high1.price &&
    low2.price <
      low1.price;

  if (
    bullishStructure &&
    latest.close >=
      previous.close
  ) {
    return "BUY";
  }

  if (
    bearishStructure &&
    latest.close <=
      previous.close
  ) {
    return "SELL";
  }

  return "WAIT";
}


/* ============================================================
   SUPPORT / RESISTANCE
   ============================================================ */

function getSupportResistance(
  candles,
  swings
) {
  const usable =
    getUsableSwings(
      swings,
      candles
    );

  const price =
    candles[
      candles.length - 1
    ]?.close;

  const supports =
    usable.lows
      .filter(
        swing =>
          swing.price <=
          price
      )
      .sort(
        (a, b) =>
          b.price -
          a.price
      );

  const resistances =
    usable.highs
      .filter(
        swing =>
          swing.price >=
          price
      )
      .sort(
        (a, b) =>
          a.price -
          b.price
      );

  return {
    support:
      supports[0] ||
      usable.latestLow,

    resistance:
      resistances[0] ||
      usable.latestHigh
  };
}


/* ============================================================
   CANDLE CONFIRMATION
   ============================================================ */

function getCandleConfirmation(
  candles
) {
  if (
    candles.length <
    3
  ) {
    return {
      bullish: false,
      bearish: false,
      pattern: "NONE",
      rejection: false,
      momentum: false,
      confirmation: false
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
      c.close -
        c.open
    );

  const range =
    c.high -
    c.low;

  if (
    range <= 0
  ) {
    return {
      bullish: false,
      bearish: false,
      pattern: "NONE",
      rejection: false,
      momentum: false,
      confirmation: false
    };
  }

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

  const bullish =
    c.close >
    c.open;

  const bearish =
    c.close <
    c.open;

  const bullishEngulfing =
    bullish &&
    p.close <
      p.open &&
    c.close >=
      p.open &&
    c.open <=
      p.close;

  const bearishEngulfing =
    bearish &&
    p.close >
      p.open &&
    c.close <=
      p.open &&
    c.open >=
      p.close;

  const bullishRejection =
    lowerWick >
      body * 1.2 &&
    c.close >
      c.low +
        range * 0.55;

  const bearishRejection =
    upperWick >
      body * 1.2 &&
    c.close <
      c.low +
        range * 0.45;

  const bullishMomentum =
    bullish &&
    body >=
      range * 0.55;

  const bearishMomentum =
    bearish &&
    body >=
      range * 0.55;

  let pattern =
    "NONE";

  if (
    bullishEngulfing
  ) {
    pattern =
      "BULLISH ENGULFING";
  } else if (
    bearishEngulfing
  ) {
    pattern =
      "BEARISH ENGULFING";
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
  } else if (
    bullishMomentum
  ) {
    pattern =
      "BULLISH MOMENTUM";
  } else if (
    bearishMomentum
  ) {
    pattern =
      "BEARISH MOMENTUM";
  }

  return {
    bullish:
      bullishEngulfing ||
      bullishRejection ||
      bullishMomentum,

    bearish:
      bearishEngulfing ||
      bearishRejection ||
      bearishMomentum,

    pattern,

    rejection:
      bullishRejection ||
      bearishRejection,

    momentum:
      bullishMomentum ||
      bearishMomentum,

    confirmation:
      bullishEngulfing ||
      bearishEngulfing ||
      bullishRejection ||
      bearishRejection ||
      bullishMomentum ||
      bearishMomentum
  };
}


/* ============================================================
   PROXIMITY TO SUPPORT / RESISTANCE
   ============================================================ */

function nearPrice(
  price,
  level,
  tolerance
) {
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(level)
  ) {
    return false;
  }

  return (
    Math.abs(
      price - level
    ) <= tolerance
  );
}

function calculateLocationTolerance(
  candles
) {
  const atr =
    calculateATR(
      candles
    );

  if (
    Number.isFinite(atr) &&
    atr > 0
  ) {
    return atr * 0.35;
  }

  const latest =
    candles[
      candles.length - 1
    ];

  return (
    Math.abs(
      latest.high -
        latest.low
    ) * 2
  );
}


/* ============================================================
   TRADE LEVELS
   ============================================================ */

function calculateTradeLevels(
  direction,
  entry,
  swings,
  candles
) {
  const usable =
    getUsableSwings(
      swings,
      candles
    );

  const atr =
    calculateATR(
      candles
    );

  let sl;

  if (
    direction ===
    "BUY"
  ) {
    if (
      !usable.latestLow
    ) {
      return null;
    }

    sl =
      usable.latestLow.price;

    if (
      atr &&
      entry - sl <
        atr *
          CONFIG.ATR_SAFETY_MULTIPLIER
    ) {
      sl =
        entry -
        atr *
          CONFIG.ATR_SAFETY_MULTIPLIER;
    }
  } else {
    if (
      !usable.latestHigh
    ) {
      return null;
    }

    sl =
      usable.latestHigh.price;

    if (
      sl - entry <
        atr *
          CONFIG.ATR_SAFETY_MULTIPLIER
    ) {
      sl =
        entry +
        atr *
          CONFIG.ATR_SAFETY_MULTIPLIER;
    }
  }

  const risk =
    Math.abs(
      entry - sl
    );

  if (
    !Number.isFinite(
      risk
    ) ||
    risk <= 0
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
      roundPrice(sl),

    tp1:
      roundPrice(tp1),

    tp2:
      roundPrice(tp2),

    tp3:
      roundPrice(tp3),

    risk:
      roundPrice(risk),

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
  const closed =
    getClosedCandles(
      candles,
      timeframe
    );

  if (
    closed.length <
    100
  ) {
    return null;
  }

  /*
   * NEVER use the unfinished candle.
   */

  const latest =
    closed[
      closed.length - 1
    ];

  const swings =
    detectSwings(
      closed
    );

  const direction =
    determineDirection(
      closed,
      swings
    );

  if (
    direction ===
    "WAIT"
  ) {
    return null;
  }

  const sr =
    getSupportResistance(
      closed,
      swings
    );

  const candle =
    getCandleConfirmation(
      closed
    );

  const ema9 =
    calculateEMA(
      closed.map(
        item =>
          item.close
      ),
      CONFIG.EMA_LENGTH
    );

  if (
    !Number.isFinite(
      ema9
    )
  ) {
    return null;
  }

  const tolerance =
    calculateLocationTolerance(
      closed
    );

  let nearSupport =
    false;

  let nearResistance =
    false;

  if (
    sr.support
  ) {
    nearSupport =
      nearPrice(
        latest.close,
        sr.support.price,
        tolerance
      );
  }

  if (
    sr.resistance
  ) {
    nearResistance =
      nearPrice(
        latest.close,
        sr.resistance.price,
        tolerance
      );
  }

  /*
   * SNIPER BUY
   *
   * bullish structure
   * support / swing low
   * bullish candle
   * EMA9 confirmation
   */

  const buyConfirmed =
    direction ===
      "BUY" &&
    nearSupport &&
    candle.bullish &&
    latest.close >=
      ema9;

  /*
   * SNIPER SELL
   *
   * bearish structure
   * resistance / swing high
   * bearish candle
   * EMA9 confirmation
   */

  const sellConfirmed =
    direction ===
      "SELL" &&
    nearResistance &&
    candle.bearish &&
    latest.close <=
      ema9;

  if (
    !buyConfirmed &&
    !sellConfirmed
  ) {
    return null;
  }

  const signalDirection =
    buyConfirmed
      ? "BUY"
      : "SELL";

  const levels =
    calculateTradeLevels(
      signalDirection,
      latest.close,
      swings,
      closed
    );

  if (!levels) {
    return null;
  }

  const reason =
    signalDirection ===
    "BUY"
      ? "Bullish swing + support + bullish candle + EMA 9 confirmation."
      : "Bearish swing + resistance + bearish candle + EMA 9 confirmation.";

  return {
    id:
      `${symbol}|${timeframe}|${signalDirection}|${latest.epoch}`,

    symbol,

    timeframe,

    direction:
      signalDirection,

    signal:
      signalDirection ===
      "BUY"
        ? "🟢 SNIPER BUY"
        : "🔴 SNIPER SELL",

    candleTime:
      latest.epoch,

    candle:
      latest,

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

    ema9:
      roundPrice(ema9),

    pattern:
      candle.pattern,

    rejection:
      candle.rejection,

    momentum:
      candle.momentum,

    swing:
      signalDirection ===
      "BUY"
        ? "Bullish swing"
        : "Bearish swing",

    structure:
      direction,

    support:
      sr.support?.price ||
      null,

    resistance:
      sr.resistance?.price ||
      null,

    reason,

    confirmed:
      true,

    nonRepainting:
      true,

    createdAt:
      Date.now()
  };
}


/* ============================================================
   SIGNAL KEY
   ============================================================ */

function signalKey(
  signal
) {
  if (!signal) {
    return "";
  }

  return [
    signal.symbol,
    signal.timeframe,
    signal.direction,
    signal.candleTime
  ].join("|");
}


/* ============================================================
   SIGNAL HISTORY DEDUPLICATION
   ============================================================ */

function addSignalToHistory(
  signal
) {
  if (!signal) {
    return;
  }

  const key =
    signalKey(signal);

  const exists =
    state.signalHistory.some(
      item =>
        signalKey(item) ===
        key
    );

  if (exists) {
    return;
  }

  state.signalHistory.unshift(
    signal
  );

  /*
   * Keep memory under control.
   */

  if (
    state.signalHistory.length >
    200
  ) {
    state.signalHistory =
      state.signalHistory.slice(
        0,
        200
      );
  }

  renderSignalHistory();
}


/* ============================================================
   SIGNAL ALERT
   ============================================================ */

async function sendSignalAlert(
  signal
) {
  if (!signal) {
    return;
  }

  const key =
    signalKey(signal);

  /*
   * Global duplicate protection.
   */

  if (
    state.notifiedSignals.has(
      key
    )
  ) {
    return;
  }

  state.notifiedSignals.add(
    key
  );

  const title =
    signal.direction ===
    "BUY"
      ? "🟢 PRECISION SNIPER BUY"
      : "🔴 PRECISION SNIPER SELL";

  const body =
    `${signal.symbol} ${signal.timeframe}\n` +
    `Entry: ${formatPrice(signal.entry)}\n` +
    `SL: ${formatPrice(signal.sl)}\n` +
    `TP1: ${formatPrice(signal.tp1)}\n` +
    `TP2: ${formatPrice(signal.tp2)}\n` +
    `TP3: ${formatPrice(signal.tp3)}\n` +
    `${signal.reason}`;

  showInAppNotification(
    title,
    body
  );

  if (
    state.alertsEnabled &&
    "Notification" in window
  ) {
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
            body,
            tag:
              `precision-${key}`
          }
        );
      }
    } catch (error) {
      console.warn(
        "Browser notification unavailable:",
        error
      );
    }
  }
}


/* ============================================================
   IN-APP NOTIFICATION
   ============================================================ */

function showInAppNotification(
  title,
  message
) {
  let container =
    $("notificationContainer");

  if (!container) {
    container =
      document.createElement(
        "div"
      );

    container.id =
      "notificationContainer";

    container.style.position =
      "fixed";

    container.style.right =
      "15px";

    container.style.top =
      "15px";

    container.style.zIndex =
      "99999";

    container.style.maxWidth =
      "360px";

    document.body.appendChild(
      container
    );
  }

  const item =
    document.createElement(
      "div"
    );

  item.style.marginBottom =
    "10px";

  item.style.padding =
    "14px";

  item.style.borderRadius =
    "12px";

  item.style.background =
    "#111";

  item.style.color =
    "#fff";

  item.style.border =
    "1px solid rgba(255,255,255,.15)";

  item.style.boxShadow =
    "0 8px 30px rgba(0,0,0,.35)";

  item.innerHTML =
    `<strong>${escapeHTML(title)}</strong>
     <div style="margin-top:6px;white-space:pre-line;">
       ${escapeHTML(message)}
     </div>`;

  container.appendChild(
    item
  );

  setTimeout(() => {
    item.remove();
  }, 9000);
}


/* ============================================================
   SELECTED-PAIR SIGNAL PROCESSING
   ============================================================ */

function processSignal(
  signal
) {
  if (!signal) {
    showWaitState(
      "No confirmed sniper setup."
    );

    return;
  }

  /*
   * Selected dashboard signal only.
   */

  if (
    signal.symbol !==
    state.selectedSymbol
  ) {
    return;
  }

  const key =
    signalKey(signal);

  /*
   * Do not replace an already-confirmed
   * signal with the same signal.
   */

  if (
    state.activeSignal &&
    signalKey(
      state.activeSignal
    ) === key
  ) {
    return;
  }

  state.activeSignal =
    Object.freeze({
      ...signal
    });

  state.tradeState = {
    signalKey: key,

    tp1Hit: false,

    tp2Hit: false,

    tp3Hit: false,

    stopped: false,

    currentSL:
      signal.sl
  };

  state.lastClosedCandleTime[
    `${signal.symbol}|${signal.timeframe}`
  ] =
    signal.candleTime;

  addSignalToHistory(
    signal
  );

  sendSignalAlert(
    signal
  );

  renderAnalysis(
    signal
  );
}


/* ============================================================
   TRADE MANAGEMENT
   ============================================================ */

function updateTradeManagement(
  currentPrice
) {
  const signal =
    state.activeSignal;

  const trade =
    state.tradeState;

  if (
    !signal ||
    !trade ||
    trade.stopped
  ) {
    return;
  }

  if (
    signal.direction ===
    "BUY"
  ) {
    if (
      !trade.tp1Hit &&
      currentPrice >=
        signal.tp1
    ) {
      trade.tp1Hit =
        true;

      trade.currentSL =
        signal.entry;

      showInAppNotification(
        "TP1 HIT ✅",
        `${signal.symbol} TP1 reached. SL moved toward BE.`
      );
    }

    if (
      !trade.tp2Hit &&
      currentPrice >=
        signal.tp2
    ) {
      trade.tp2Hit =
        true;

      showInAppNotification(
        "TP2 HIT ✅",
        `${signal.symbol} TP2 reached.`
      );
    }

    if (
      !trade.tp3Hit &&
      currentPrice >=
        signal.tp3
    ) {
      trade.tp3Hit =
        true;

      showInAppNotification(
        "TP3 HIT 🎯",
        `${signal.symbol} TP3 reached.`
      );
    }

    if (
      !trade.tp1Hit &&
      currentPrice <=
        signal.sl
    ) {
      trade.stopped =
        true;

      showInAppNotification(
        "STOP LOSS HIT ❌",
        `${signal.symbol} stop loss reached.`
      );
    }

    if (
      trade.tp1Hit &&
      currentPrice <=
        trade.currentSL
    ) {
      trade.stopped =
        true;

      showInAppNotification(
        "BREAKEVEN / STOP HIT",
        `${signal.symbol} returned to the protected level.`
      );
    }
  } else {
    if (
      !trade.tp1Hit &&
      currentPrice <=
        signal.tp1
    ) {
      trade.tp1Hit =
        true;

      trade.currentSL =
        signal.entry;

      showInAppNotification(
        "TP1 HIT ✅",
        `${signal.symbol} TP1 reached. SL moved toward BE.`
      );
    }

    if (
      !trade.tp2Hit &&
      currentPrice <=
        signal.tp2
    ) {
      trade.tp2Hit =
        true;

      showInAppNotification(
        "TP2 HIT ✅",
        `${signal.symbol} TP2 reached.`
      );
    }

    if (
      !trade.tp3Hit &&
      currentPrice <=
        signal.tp3
    ) {
      trade.tp3Hit =
        true;

      showInAppNotification(
        "TP3 HIT 🎯",
        `${signal.symbol} TP3 reached.`
      );
    }

    if (
      !trade.tp1Hit &&
      currentPrice >=
        signal.sl
    ) {
      trade.stopped =
        true;

      showInAppNotification(
        "STOP LOSS HIT ❌",
        `${signal.symbol} stop loss reached.`
      );
    }

    if (
      trade.tp1Hit &&
      currentPrice >=
        trade.currentSL
    ) {
      trade.stopped =
        true;

      showInAppNotification(
        "BREAKEVEN / STOP HIT",
        `${signal.symbol} returned to the protected level.`
      );
    }
  }

  renderTradeStatus();
}


/* ============================================================
   DASHBOARD RENDERING
   ============================================================ */

function renderAnalysis(
  signal
) {
  if (!signal) {
    return;
  }

  setText(
    "signal",
    signal.signal
  );

  setText(
    "direction",
    signal.direction ===
      "BUY"
      ? "🟢 BUY DIRECTION"
      : "🔴 SELL DIRECTION"
  );

  setText(
    "setup",
    signal.signal
  );

  setText(
    "confidence",
    "CONFIRMED"
  );

  setText(
    "rr",
    signal.rr
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
    signal.swing
  );

  setText(
    "structure",
    signal.structure
  );

  setText(
    "liquidity",
    signal.direction ===
      "BUY"
      ? "Support / swing low"
      : "Resistance / swing high"
  );

  setText(
    "sr",
    signal.direction ===
      "BUY"
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
      ? "YES"
      : "NO"
  );

  setText(
    "momentum",
    signal.momentum
      ? "YES"
      : "NO"
  );

  setText(
    "confirmation",
    "CONFIRMED"
  );

  setText(
    "explanationText",
    signal.reason
  );

  updateChecklist(
    signal
  );
}

function updateChecklist(
  signal
) {
  const checks = {
    swing:
      Boolean(
        signal.swing
      ),

    structure:
      Boolean(
        signal.structure &&
          signal.structure !==
            "WAIT"
      ),

    candle:
      Boolean(
        signal.pattern &&
          signal.pattern !==
            "NONE"
      ),

    confirmation:
      signal.confirmed ===
      true
  };

  const selectors = {
    swing:
      "#checkSwing",
    structure:
      "#checkStructure",
    candle:
      "#checkCandle",
    confirmation:
      "#checkConfirmation"
  };

  for (
    const [
      key,
      selector
    ] of Object.entries(
      selectors
    )
  ) {
    const el =
      document.querySelector(
        selector
      );

    if (el) {
      el.classList.toggle(
        "active",
        checks[key]
      );

      el.classList.toggle(
        "confirmed",
        checks[key]
      );
    }
  }
}

function showWaitState(
  reason =
    "No confirmed setup."
) {
  setText(
    "signal",
    "⚪ WAIT — NO SETUP"
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
    "WAIT"
  );

  setText(
    "rr",
    "—"
  );

  setText(
    "explanationText",
    reason
  );
}


/* ============================================================
   TRADE STATUS UI
   ============================================================ */

function renderTradeStatus() {
  const signal =
    state.activeSignal;

  const trade =
    state.tradeState;

  if (
    !signal ||
    !trade
  ) {
    return;
  }

  let status =
    "ACTIVE";

  if (
    trade.stopped
  ) {
    status =
      "STOP / BE HIT";
  } else if (
    trade.tp3Hit
  ) {
    status =
      "TP3 HIT 🎯";
  } else if (
    trade.tp2Hit
  ) {
    status =
      "TP2 HIT ✅";
  } else if (
    trade.tp1Hit
  ) {
    status =
      "TP1 HIT ✅";
  }

  setText(
    "tradeStatus",
    status
  );

  setText(
    "currentSL",
    formatPrice(
      trade.currentSL
    )
  );
}


/* ============================================================
   SIGNAL HISTORY UI
   ============================================================ */

function renderSignalHistory() {
  const container =
    $("signalHistory");

  if (!container) {
    return;
  }

  if (
    !state.signalHistory.length
  ) {
    container.innerHTML =
      "<div>No confirmed signals yet.</div>";

    return;
  }

  container.innerHTML =
    state.signalHistory
      .map(signal => {
        const color =
          signal.direction ===
          "BUY"
            ? "#16a34a"
            : "#dc2626";

        return `
          <div class="signal-history-item"
               data-signal-id="${escapeHTML(signal.id)}"
               style="padding:12px;margin-bottom:8px;border-radius:10px;">
            <div>
              <strong style="color:${color}">
                ${escapeHTML(signal.signal)}
              </strong>
            </div>

            <div>
              ${escapeHTML(signal.symbol)}
              •
              ${escapeHTML(signal.timeframe)}
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

            <small>
              ${escapeHTML(signal.reason)}
            </small>
          </div>
        `;
      })
      .join("");
}


/* ============================================================
   SELECTED PAIR ANALYSIS
   ============================================================ */

async function runPrecisionAnalysis(
  force = false
) {
  if (
    state.analysisRunning
  ) {
    return;
  }

  if (
    !state.selectedSymbol
  ) {
    return;
  }

  const symbol =
    state.selectedSymbol;

  const timeframe =
    getSelectedTimeframe();

  const generation =
    state.analysisGeneration;

  state.analysisRunning =
    true;

  try {
    const candles =
      await loadTimeframeHistory(
        symbol,
        timeframe,
        force
      );

    /*
     * User may have changed market/timeframe
     * while request was loading.
     */

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

    const signal =
      generateSniperSignal(
        symbol,
        timeframe,
        closed
      );

    state.analysis = {
      symbol,
      timeframe,
      candles: closed,
      signal,
      updatedAt:
        Date.now()
    };

    window.currentTimeframe =
      timeframe;

    window.closedCandles =
      closed;

    window.currentAnalysis =
      state.analysis;

    if (signal) {
      processSignal(
        signal
      );
    } else {
      showWaitState(
        "Price action is not fully confirmed. Waiting for a valid sniper setup."
      );
    }

    document.dispatchEvent(
      new CustomEvent(
        "precision-analysis",
        {
          detail:
            state.analysis
        }
      )
    );
  } catch (error) {
    console.error(
      "Analysis error:",
      error
    );

    showWaitState(
      "Unable to complete market analysis."
    );
  } finally {
    state.analysisRunning =
      false;
  }
}


/* ============================================================
   BACKGROUND SCANNER
   ============================================================ */

function scannerContextKey(
  symbol,
  timeframe
) {
  return `${symbol}|${timeframe}`;
}

function scannerSignalKey(
  signal
) {
  return signalKey(
    signal
  );
}

async function scanSingleMarket(
  symbol,
  timeframe
) {
  if (
    !symbol ||
    !timeframe
  ) {
    return;
  }

  try {
    const candles =
      await loadTimeframeHistory(
        symbol,
        timeframe,
        false
      );

    const closed =
      getClosedCandles(
        candles,
        timeframe
      );

    if (
      closed.length <
      100
    ) {
      return;
    }

    const latest =
      closed[
        closed.length - 1
      ];

    if (!latest) {
      return;
    }

    const context =
      scannerContextKey(
        symbol,
        timeframe
      );

    const previousEpoch =
      state.scannerLastClosedCandle[
        context
      ];

    /*
     * First time this market/timeframe is
     * seen: establish a baseline.
     *
     * This prevents refresh/reconnect from
     * creating fake historical alerts.
     */

    if (
      previousEpoch ===
      undefined
    ) {
      state.scannerLastClosedCandle[
        context
      ] =
        latest.epoch;

      const baselineSignal =
        generateSniperSignal(
          symbol,
          timeframe,
          closed
        );

      if (
        baselineSignal
      ) {
        const key =
          scannerSignalKey(
            baselineSignal
          );

        state.scannerSeenSignals.add(
          key
        );

        state.scannerSignals[
          context
        ] =
          baselineSignal;
      }

      return;
    }

    /*
     * No new CLOSED candle.
     */

    if (
      latest.epoch <=
      previousEpoch
    ) {
      return;
    }

    /*
     * New candle confirmed.
     */

    state.scannerLastClosedCandle[
      context
    ] =
      latest.epoch;

    const signal =
      generateSniperSignal(
        symbol,
        timeframe,
        closed
      );

    if (!signal) {
      return;
    }

    const key =
      scannerSignalKey(
        signal
      );

    /*
     * Never alert the same signal twice.
     */

    if (
      state.scannerSeenSignals.has(
        key
      )
    ) {
      return;
    }

    state.scannerSeenSignals.add(
      key
    );

    state.scannerSignals[
      context
    ] =
      signal;

    /*
     * Add to common history.
     * addSignalToHistory itself
     * prevents duplicate entries.
     */

    addSignalToHistory(
      signal
    );

    /*
     * Central notification protection.
     *
     * If selected-pair analyzer already
     * notified this signal, scanner won't
     * notify it again.
     */

    if (
      state.notifiedSignals.has(
        key
      )
    ) {
      return;
    }

    state.scannerNotifiedSignals.add(
      key
    );

    await sendBackgroundSignalAlert(
      signal
    );
  } catch (error) {
    /*
     * One bad market must never stop
     * the entire scanner.
     */

    console.warn(
      `Scanner error for ${symbol}:`,
      error
    );
  }
}

async function sendBackgroundSignalAlert(
  signal
) {
  if (!signal) {
    return;
  }

  const key =
    scannerSignalKey(
      signal
    );

  /*
   * Use the same global notification
   * system to guarantee one alert.
   */

  if (
    state.notifiedSignals.has(
      key
    )
  ) {
    return;
  }

  const title =
    signal.direction ===
    "BUY"
      ? "🟢 NEW SNIPER BUY"
      : "🔴 NEW SNIPER SELL";

  const body =
    `${signal.symbol} • ${signal.timeframe}\n` +
    `Entry: ${formatPrice(signal.entry)}\n` +
    `SL: ${formatPrice(signal.sl)}\n` +
    `TP1: ${formatPrice(signal.tp1)}\n` +
    `TP2: ${formatPrice(signal.tp2)}\n` +
    `TP3: ${formatPrice(signal.tp3)}\n` +
    `RR: ${signal.rr}\n` +
    `Reason: ${signal.reason}`;

  /*
   * Mark notified BEFORE delivering.
   * This prevents duplicate notifications
   * if two scanner cycles overlap.
   */

  state.notifiedSignals.add(
    key
  );

  state.scannerNotifiedSignals.add(
    key
  );

  showInAppNotification(
    title,
    body
  );

  if (
    state.alertsEnabled &&
    "Notification" in window
  ) {
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
            body,
            tag:
              `scanner-${key}`
          }
        );
      }
    } catch (error) {
      console.warn(
        "Scanner notification failed:",
        error
      );
    }
  }
}


/* ============================================================
   SCAN ALL AVAILABLE MARKETS
   ============================================================ */

async function scanAllMarkets() {
  if (
    !CONFIG.SCANNER_ENABLED ||
    !state.connected ||
    state.scannerRunning
  ) {
    return;
  }

  if (
    !state.symbols.length
  ) {
    return;
  }

  state.scannerRunning =
    true;

  const generation =
    ++state.scannerGeneration;

  try {
    const timeframe =
      getSelectedTimeframe();

    /*
     * Snapshot the list so a market selector
     * change does not mutate the scan halfway.
     */

    const symbols =
      state.symbols
        .map(
          item =>
            item.symbol
        )
        .filter(Boolean)
        .slice(
          0,
          CONFIG.MAX_SYMBOLS_TO_SCAN
        );

    /*
     * Scan in small batches.
     */

    for (
      let i = 0;
      i < symbols.length;
      i +=
        CONFIG.SCANNER_BATCH_SIZE
    ) {
      if (
        generation !==
        state.scannerGeneration
      ) {
        break;
      }

      const batch =
        symbols.slice(
          i,
          i +
            CONFIG.SCANNER_BATCH_SIZE
        );

      await Promise.all(
        batch.map(
          symbol =>
            scanSingleMarket(
              symbol,
              timeframe
            )
        )
      );

      if (
        i +
          CONFIG.SCANNER_BATCH_SIZE <
        symbols.length
      ) {
        await sleep(
          CONFIG.SCANNER_DELAY
        );
      }
    }
  } finally {
    state.scannerRunning =
      false;
  }
}


/* ============================================================
   ANALYSIS LOOP
   ============================================================ */

function startAnalysisLoop() {
  /*
   * Selected market analysis
   */

  setInterval(
    () => {
      if (
        !state.selectedSymbol
      ) {
        return;
      }

      runPrecisionAnalysis(
        false
      );
    },
    CONFIG.ANALYSIS_INTERVAL
  );

  /*
   * Background scanner
   *
   * It scans all available markets
   * independently of the selected pair.
   */

  setInterval(
    () => {
      scanAllMarkets();
    },
    CONFIG.ANALYSIS_INTERVAL
  );
}


/* ============================================================
   TIMEFRAME SELECTION
   ============================================================ */

function selectTimeframe(
  timeframe
) {
  const normalized =
    normalizeTimeframe(
      timeframe
    );

  if (
    !CONFIG.TIMEFRAMES[
      normalized
    ]
  ) {
    return;
  }

  state.analysisGeneration++;

  state.selectedTimeframe =
    normalized;

  state.activeSignal =
    null;

  state.tradeState =
    null;

  state.analysis =
    null;

  /*
   * Timeframe changes should recalculate
   * only that timeframe.
   */

  $all(
    "[data-timeframe]"
  ).forEach(button => {
    button.classList.toggle(
      "active",
      normalizeTimeframe(
        button.dataset.timeframe
      ) === normalized
    );
  });

  runPrecisionAnalysis(
    true
  );
}


/* ============================================================
   QUESTION BAR
   ============================================================ */

function answerTradingQuestion(
  question
) {
  const q =
    String(
      question || ""
    )
      .trim()
      .toLowerCase();

  if (!q) {
    return "Ask me what you are confused about.";
  }

  if (
    q.includes("buy") ||
    q.includes("sell")
  ) {
    if (
      state.activeSignal
    ) {
      return (
        `${state.activeSignal.symbol} ` +
        `${state.activeSignal.timeframe}: ` +
        `${state.activeSignal.direction}. ` +
        `${state.activeSignal.reason}`
      );
    }

    return "There is currently no confirmed sniper BUY or SELL setup. WAIT.";
  }

  if (
    q.includes("entry")
  ) {
    if (
      state.activeSignal
    ) {
      return (
        `Confirmed entry: ${formatPrice(
          state.activeSignal.entry
        )}. ` +
        `SL: ${formatPrice(
          state.activeSignal.sl
        )}.`
      );
    }

    return "No confirmed entry currently.";
  }

  if (
    q.includes("stop") ||
    q.includes("sl")
  ) {
    if (
      state.activeSignal
    ) {
      return (
        `The current stop is ${formatPrice(
          state.activeSignal.sl
        )}. It is based on the important swing used for invalidation.`
      );
    }

    return "No active confirmed setup.";
  }

  if (
    q.includes("tp") ||
    q.includes("take profit")
  ) {
    if (
      state.activeSignal
    ) {
      return (
        `TP1 = ${formatPrice(
          state.activeSignal.tp1
        )}, ` +
        `TP2 = ${formatPrice(
          state.activeSignal.tp2
        )}, ` +
        `TP3 = ${formatPrice(
          state.activeSignal.tp3
        )}.`
      );
    }

    return "No active confirmed setup.";
  }

  if (
    q.includes("repaint") ||
    q.includes("repainting")
  ) {
    return (
      "New signals are confirmed from CLOSED candles only. " +
      "The engine does not use the unfinished candle to create a confirmed signal."
    );
  }

  if (
    q.includes("scanner")
  ) {
    return (
      "The background scanner checks available markets independently using the selected timeframe. " +
      "A new alert requires a newly closed candle and a confirmed sniper setup."
    );
  }

  if (
    q.includes("wait") ||
    q.includes("no setup")
  ) {
    return (
      "WAIT means the required confirmation is incomplete. " +
      "The engine avoids forcing trades when structure, location or candle confirmation is missing."
    );
  }

  if (
    q.includes("ema")
  ) {
    return (
      "EMA 9 is used as directional confirmation. " +
      "BUY requires price to support the bullish direction above EMA 9; SELL requires bearish confirmation below EMA 9."
    );
  }

  if (
    q.includes("rr") ||
    q.includes("risk reward")
  ) {
    return (
      "The current model calculates TP1 at 1R, TP2 at 2R and TP3 at 3R."
    );
  }

  return (
    "The engine uses swing structure, support/resistance, candle confirmation and EMA 9. " +
    "Ask specifically about entry, SL, TP, BUY, SELL, scanner, repainting, EMA or RR."
  );
}

function initializeQuestionBar() {
  const input =
    $("questionInput");

  const button =
    $("questionButton");

  const output =
    $("questionAnswer");

  if (
    !input ||
    !button
  ) {
    return;
  }

  const ask = () => {
    const answer =
      answerTradingQuestion(
        input.value
      );

    if (output) {
      output.textContent =
        answer;
    }

    input.value =
      "";
  };

  button.addEventListener(
    "click",
    ask
  );

  input.addEventListener(
    "keydown",
    event => {
      if (
        event.key ===
        "Enter"
      ) {
        ask();
      }
    }
  );
}


/* ============================================================
   TIMEFRAME BUTTON EVENTS
   ============================================================ */

function initializeTimeframeButtons() {
  $all(
    "[data-timeframe]"
  ).forEach(button => {
    button.addEventListener(
      "click",
      () => {
        selectTimeframe(
          button.dataset.timeframe
        );
      }
    );
  });
}


/* ============================================================
   MARKET SELECTOR EVENTS
   ============================================================ */

function initializeMarketSelector() {
  const select =
    $("market");

  if (!select) {
    return;
  }

  select.addEventListener(
    "change",
    event => {
      selectMarket(
        event.target.value
      );
    }
  );
}


/* ============================================================
   ANALYZE BUTTON
   ============================================================ */

function initializeAnalyzeButton() {
  const button =
    $("analyze") ||
    $("analyzeBtn") ||
    $("analyzeButton");

  if (!button) {
    return;
  }

  button.addEventListener(
    "click",
    () => {
      state.analysisGeneration++;

      runPrecisionAnalysis(
        true
      );
    }
  );
}


/* ============================================================
   ALERT BUTTON
   ============================================================ */

function initializeAlertControl() {
  const buttons =
    [
      $("alertButton"),
      $("enableAlerts"),
      $("notificationButton")
    ].filter(Boolean);

  buttons.forEach(button => {
    button.addEventListener(
      "click",
      async () => {
        state.alertsEnabled =
          true;

        if (
          "Notification" in
          window
        ) {
          try {
            await Notification.requestPermission();
          } catch {}
        }

        button.textContent =
          "🔔 ALERTS ON";
      }
    );
  });
}


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

  initializeMarketSelector();

  initializeTimeframeButtons();

  initializeAnalyzeButton();

  initializeQuestionBar();

  initializeAlertControl();

  updateSelectedMarketUI();

  showWaitState(
    "Connecting to live market data..."
  );

  connectDeriv();

  startAnalysisLoop();

  /*
   * Expose useful debugging helpers.
   */

  window.successfulPineScript =
    {
      state,

      config:
        CONFIG,

      analyze:
        runPrecisionAnalysis,

      scan:
        scanAllMarkets,

      selectMarket,

      selectTimeframe,

      generateSignal:
        generateSniperSignal
    };
}


/* ============================================================
   START
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
