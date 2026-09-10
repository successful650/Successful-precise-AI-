/* =========================================================
   SUCCESSFUL PINE SCRIPT
   ADVANCED PROGRESSIVE LIVE SIGNAL ENGINE
   ---------------------------------------------------------
   FEATURES
   ---------------------------------------------------------
   ✓ Deriv public live market data
   ✓ Automatic reconnect
   ✓ Live ticks
   ✓ Historical 1-minute candles
   ✓ M1 / M5 / M15 / M30 / H1 / H2 / H4 / Daily
   ✓ Swing High / Swing Low
   ✓ HH / HL / LH / LL
   ✓ 1H structural swing requirement
   ✓ Precision Engine
       Depth      = 30
       Deviation  = 5
       Backstep   = 5
   ✓ Precision BUY / SELL confirmation
   ✓ Non-repainting confirmed signals
   ✓ BOS
   ✓ CHoCH
   ✓ CHoCH+
   ✓ Liquidity sweeps
   ✓ Support / Resistance
   ✓ Order Blocks
   ✓ Fair Value Gaps
   ✓ Supply / Demand
   ✓ Premium / Equilibrium / Discount
   ✓ Candle price action
   ✓ Displacement
   ✓ A+ / A / B / C grading
   ✓ Progressive:
       EARLY SETUP
       WAITING
       CONFIRMED
       INVALIDATED
   ✓ A+ / A / B / C notifications
   ✓ Upgrade notifications
   ✓ Duplicate-alert protection
   ✓ Detailed analyst explanation
   ✓ Entry / SL / BE / TP1 / TP2
   ✓ RR calculation
   ✓ Invalidation level
   ✓ Signal history
   ✓ Live dashboard
   ========================================================= */


/* =========================================================
   CONFIGURATION
   ========================================================= */

const DERIV_WS =
  "wss://api.derivws.com/trading/v1/options/ws/public";

/*
   Precision Engine settings requested.
*/
const PRECISION_CONFIG = {
  depth: 30,
  deviation: 5,
  backstep: 5
};

/*
   Minimum RR.
*/
const MIN_RR = 2;

/*
   Ideal RR.
*/
const IDEAL_RR = 3;

/*
   Number of historical 1-minute candles.
*/
const HISTORY_COUNT = 1500;

/*
   Swing settings.
*/
const SWING_LEFT = 2;
const SWING_RIGHT = 2;


/* =========================================================
   GLOBAL STATE
   ========================================================= */

let ws = null;

let selectedSymbol = "";
let selectedTimeframe = "M5";
let selectedPrice = 0;

let candles = [];
let candleCache = {};

let currentSignal = null;

let lastAlertKey = "";
let lastStage = "";
let lastGrade = "";

let reconnectTimer = null;

let manuallyClosed = false;

let subscriptionGeneration = 0;


/* =========================================================
   TIMEFRAMES
   ========================================================= */

const TIMEFRAMES = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H2: 120,
  H4: 240,
  Daily: 1440
};


/* =========================================================
   DOM HELPERS
   ========================================================= */

function $(id) {
  return document.getElementById(id);
}


function setText(id, value) {
  const el = $(id);

  if (el) {
    el.textContent =
      value === undefined ||
      value === null
        ? "-"
        : value;
  }
}


function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}


function roundPrice(price) {
  if (!Number.isFinite(Number(price))) {
    return "-";
  }

  const p = Number(price);

  if (p >= 1000) {
    return p.toFixed(2);
  }

  if (p >= 100) {
    return p.toFixed(3);
  }

  if (p >= 10) {
    return p.toFixed(4);
  }

  if (p >= 1) {
    return p.toFixed(5);
  }

  return p.toFixed(5);
}


function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


/* =========================================================
   CONNECTION
   ========================================================= */

function updateConnection(text, live = false) {
  setText("connectionText", text);

  const dot =
    document.querySelector(".status-dot");

  if (dot) {
    dot.style.opacity =
      live ? "1" : "0.5";
  }
}


function connectDeriv() {
  if (manuallyClosed) {
    return;
  }

  if (
    ws &&
    (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    )
  ) {
    return;
  }

  updateConnection(
    "Connecting to Deriv...",
    false
  );

  try {
    ws =
      new WebSocket(DERIV_WS);

    ws.onopen = () => {
      updateConnection(
        "LIVE",
        true
      );

      loadMarkets();
    };

    ws.onmessage =
      handleMessage;

    ws.onerror = error => {
      console.error(
        "Deriv WebSocket error:",
        error
      );

      updateConnection(
        "Connection error",
        false
      );
    };

    ws.onclose = () => {
      updateConnection(
        "Reconnecting...",
        false
      );

      if (!manuallyClosed) {
        scheduleReconnect();
      }
    };

  } catch (error) {
    console.error(error);

    updateConnection(
      "Connection failed",
      false
    );

    scheduleReconnect();
  }
}


function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer =
    setTimeout(() => {
      reconnectTimer = null;

      connectDeriv();
    }, 3000);
}


/* =========================================================
   DERIV MESSAGE HANDLER
   ========================================================= */

function handleMessage(event) {
  let data;

  try {
    data =
      JSON.parse(event.data);
  } catch {
    return;
  }

  if (data.error) {
    console.error(
      "Deriv error:",
      data.error
    );

    return;
  }

  if (
    data.msg_type ===
    "active_symbols"
  ) {
    populateMarkets(
      data.active_symbols || []
    );

    return;
  }

  if (
    data.msg_type === "tick"
  ) {
    handleTick(data);

    return;
  }

  if (
    data.msg_type === "candles"
  ) {
    handleHistoricalCandles(data);

    return;
  }
}


/* =========================================================
   MARKET LOADING
   ========================================================= */

function loadMarkets() {
  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  ws.send(
    JSON.stringify({
      active_symbols: "full"
    })
  );
}


function populateMarkets(symbols) {
  const market =
    $("market");

  if (!market) {
    return;
  }

  const oldSymbol =
    selectedSymbol;

  market.innerHTML = "";

  const groups = {
    "Deriv Synthetic Indices": [],
    Forex: [],
    "Global Indices": [],
    Metals: [],
    Commodities: [],
    Crypto: [],
    Other: []
  };


  symbols.forEach(item => {
    const symbol =
      item.underlying_symbol ||
      item.symbol ||
      "";

    const name =
      item.underlying_symbol_name ||
      item.display_name ||
      symbol;

    const type =
      String(
        item.underlying_symbol_type ||
        item.symbol_type ||
        ""
      ).toLowerCase();

    if (!symbol) {
      return;
    }

    let group =
      "Other";


    /*
       Synthetic markets.
    */
    if (
      type.includes("synthetic") ||
      /volatility|step|jump|boom|crash|range break/i
        .test(name)
    ) {
      group =
        "Deriv Synthetic Indices";
    }

    /*
       Forex.
    */
    else if (
      type.includes("forex") ||
      /^[A-Z]{6}$/.test(symbol)
    ) {
      group = "Forex";
    }

    /*
       Indices.
    */
    else if (
      type.includes("indices") ||
      type.includes("index") ||
      /nasdaq|dow|dax|s&p|spx|ftse|nikkei/i
        .test(name)
    ) {
      group =
        "Global Indices";
    }

    /*
       Metals.
    */
    else if (
      type.includes("metal") ||
      /gold|silver|platinum|palladium/i
        .test(name)
    ) {
      group =
        "Metals";
    }

    /*
       Commodities.
    */
    else if (
      type.includes("commodity") ||
      /oil|gas|brent|crude/i
        .test(name)
    ) {
      group =
        "Commodities";
    }

    /*
       Crypto.
    */
    else if (
      type.includes("crypto") ||
      /bitcoin|ethereum|litecoin|crypto/i
        .test(name)
    ) {
      group =
        "Crypto";
    }


    groups[group].push({
      symbol,
      name
    });
  });


  Object.entries(groups)
    .forEach(
      ([groupName, items]) => {

        if (!items.length) {
          return;
        }

        const optgroup =
          document.createElement(
            "optgroup"
          );

        optgroup.label =
          groupName;


        items
          .sort(
            (a, b) =>
              a.name.localeCompare(
                b.name
              )
          )
          .forEach(item => {

            /*
               Boom/Crash remain visible
               because the user requested
               all markets to remain selectable.
            */

            const option =
              document.createElement(
                "option"
              );

            option.value =
              item.symbol;

            option.textContent =
              `${item.name} (${item.symbol})`;

            optgroup.appendChild(
              option
            );
          });


        market.appendChild(
          optgroup
        );
      }
    );


  if (!market.options.length) {
    return;
  }


  /*
     Preserve selected market after
     reconnect/reload where possible.
  */

  const matching =
    [...market.options]
      .find(
        option =>
          option.value === oldSymbol
      );


  if (matching) {
    selectedSymbol =
      oldSymbol;

    market.value =
      oldSymbol;

    subscribeToMarket(
      oldSymbol
    );

    return;
  }


  const firstOption =
    market.querySelector(
      "option"
    );


  if (firstOption) {
    selectedSymbol =
      firstOption.value;

    market.value =
      selectedSymbol;

    subscribeToMarket(
      selectedSymbol
    );
  }
}


/* =========================================================
   MARKET SELECTION
   ========================================================= */

const marketElement =
  $("market");


if (marketElement) {

  marketElement.addEventListener(
    "change",
    () => {

      selectedSymbol =
        marketElement.value;

      resetAnalysisState();

      subscribeToMarket(
        selectedSymbol
      );
    }
  );
}


function resetAnalysisState() {
  candleCache = {};

  candles = [];

  currentSignal = null;

  lastAlertKey = "";

  lastStage = "";

  lastGrade = "";

  setText(
    "signal",
    "ANALYZING"
  );

  setText(
    "direction",
    "Waiting..."
  );

  setText(
    "setup",
    "Waiting for market structure..."
  );

  setText(
    "confidence",
    "-"
  );

  setText(
    "rr",
    "-"
  );

  setText(
    "entry",
    "-"
  );

  setText(
    "sl",
    "-"
  );

  setText(
    "tp1",
    "-"
  );

  setText(
    "tp2",
    "-"
  );
}


/* =========================================================
   SUBSCRIBE
   ========================================================= */

function subscribeToMarket(symbol) {
  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  if (!symbol) {
    return;
  }


  subscriptionGeneration++;


  /*
     Clear old tick subscriptions.
  */

  try {
    ws.send(
      JSON.stringify({
        forget_all: "ticks"
      })
    );
  } catch {}


  /*
     Subscribe to selected symbol.
  */

  ws.send(
    JSON.stringify({
      ticks: symbol,
      subscribe: 1
    })
  );


  /*
     Load historical 1-minute
     candles.
  */

  requestHistoricalData(
    symbol
  );
}


/* =========================================================
   HISTORICAL DATA
   ========================================================= */

function requestHistoricalData(
  symbol
) {
  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  ws.send(
    JSON.stringify({
      ticks_history: symbol,
      style: "candles",
      granularity: 60,
      count: HISTORY_COUNT,
      end: "latest"
    })
  );
}


function handleHistoricalCandles(data) {
  if (!data.candles) {
    return;
  }


  candles =
    data.candles
      .map(c => ({
        time:
          Number(c.epoch),

        open:
          Number(c.open),

        high:
          Number(c.high),

        low:
          Number(c.low),

        close:
          Number(c.close)
      }))
      .filter(
        c =>
          Number.isFinite(c.time) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)
      );


  /*
     Sort chronologically.
  */

  candles.sort(
    (a, b) =>
      a.time - b.time
  );


  analyzeProgressively();
}


/* =========================================================
   LIVE TICKS
   ========================================================= */

function handleTick(data) {
  if (!data.tick) {
    return;
  }

  const tick =
    data.tick;

  selectedPrice =
    safeNumber(
      tick.quote
    );


  setText(
    "livePrice",
    roundPrice(
      selectedPrice
    )
  );


  setText(
    "marketName",
    selectedSymbol ||
      tick.symbol ||
      "Market"
  );


  updateCurrentMinuteCandle(
    selectedPrice,
    safeNumber(
      tick.epoch
    )
  );
}


/* =========================================================
   UPDATE CURRENT 1-MINUTE CANDLE
   ========================================================= */

function updateCurrentMinuteCandle(
  price,
  epoch
) {
  if (!price || !epoch) {
    return;
  }


  const minute =
    Math.floor(epoch / 60) * 60;


  let last =
    candles[
      candles.length - 1
    ];


  if (
    !last ||
    last.time !== minute
  ) {

    last = {
      time: minute,
      open: price,
      high: price,
      low: price,
      close: price
    };


    candles.push(
      last
    );


    if (
      candles.length >
      HISTORY_COUNT + 100
    ) {
      candles.shift();
    }

  } else {

    last.high =
      Math.max(
        last.high,
        price
      );

    last.low =
      Math.min(
        last.low,
        price
      );

    last.close =
      price;
  }


  analyzeProgressively();
}


/* =========================================================
   CANDLE HELPERS
   ========================================================= */

function getClosedCandles(data) {
  if (!data || data.length < 2) {
    return [];
  }

  /*
     The final candle is treated as
     live/unclosed.

     Confirmed logic uses candles
     before it.
  */

  return data.slice(
    0,
    -1
  );
}


function getLastClosedCandle(data) {
  const closed =
    getClosedCandles(data);

  return closed.length
    ? closed[closed.length - 1]
    : null;
}


/* =========================================================
   TIMEFRAME AGGREGATION
   ========================================================= */

function aggregateCandles(
  source,
  minutes
) {
  if (
    !source ||
    !source.length
  ) {
    return [];
  }


  if (minutes === 1) {
    return [...source];
  }


  const result = [];

  const bucketSize =
    minutes * 60;


  for (const c of source) {

    const bucket =
      Math.floor(
        c.time / bucketSize
      ) *
      bucketSize;


    let current =
      result[
        result.length - 1
      ];


    if (
      !current ||
      current.time !== bucket
    ) {

      current = {
        time: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      };


      result.push(
        current
      );

    } else {

      current.high =
        Math.max(
          current.high,
          c.high
        );

      current.low =
        Math.min(
          current.low,
          c.low
        );

      current.close =
        c.close;
    }
  }


  return result;
}


/* =========================================================
   SWING DETECTION
   ========================================================= */

function detectSwings(
  data,
  left = SWING_LEFT,
  right = SWING_RIGHT
) {
  const highs = [];
  const lows = [];


  if (
    !data ||
    data.length <
      left + right + 1
  ) {
    return {
      highs,
      lows
    };
  }


  for (
    let i = left;
    i <
      data.length - right;
    i++
  ) {

    let high = true;
    let low = true;


    for (
      let j = 1;
      j <= left;
      j++
    ) {

      if (
        data[i].high <=
        data[i - j].high
      ) {
        high = false;
      }


      if (
        data[i].low >=
        data[i - j].low
      ) {
        low = false;
      }
    }


    for (
      let j = 1;
      j <= right;
      j++
    ) {

      if (
        data[i].high <=
        data[i + j].high
      ) {
        high = false;
      }


      if (
        data[i].low >=
        data[i + j].low
      ) {
        low = false;
      }
    }


    if (high) {
      highs.push({
        index: i,
        time: data[i].time,
        price: data[i].high
      });
    }


    if (low) {
      lows.push({
        index: i,
        time: data[i].time,
        price: data[i].low
      });
    }
  }


  return {
    highs,
    lows
  };
}


/* =========================================================
   CLASSIFY SWINGS
   HH / HL / LH / LL
   ========================================================= */

function classifySwings(
  swings
) {
  const labels = [];


  const highs =
    swings.highs || [];

  const lows =
    swings.lows || [];


  for (
    let i = 1;
    i < highs.length;
    i++
  ) {

    labels.push({
      type:
        highs[i].price >
        highs[i - 1].price
          ? "HH"
          : "LH",

      price:
        highs[i].price,

      time:
        highs[i].time
    });
  }


  for (
    let i = 1;
    i < lows.length;
    i++
  ) {

    labels.push({
      type:
        lows[i].price >
        lows[i - 1].price
          ? "HL"
          : "LL",

      price:
        lows[i].price,

      time:
        lows[i].time
    });
  }


  return labels.sort(
    (a, b) =>
      a.time - b.time
  );
}


/* =========================================================
   1H STRUCTURE
   ========================================================= */

function get1HStructure() {

  /*
     IMPORTANT:
     1H structure is calculated
     from closed 1H candles only.
  */

  const h1 =
    aggregateCandles(
      getClosedCandles(candles),
      60
    );


  if (h1.length < 30) {

    return {
      direction: "NONE",
      pivot: null,
      previousPivot: null,
      highs: [],
      lows: [],
      swingLabels: [],
      confirmed: false
    };
  }


  const swings =
    detectSwings(
      h1,
      2,
      2
    );


  const recentHighs =
    swings.highs.slice(-6);

  const recentLows =
    swings.lows.slice(-6);


  if (
    recentHighs.length < 2 ||
    recentLows.length < 2
  ) {

    return {
      direction: "NONE",
      pivot: null,
      previousPivot: null,
      highs: recentHighs,
      lows: recentLows,
      swingLabels:
        classifySwings(swings),
      confirmed: false
    };
  }


  const lastHigh =
    recentHighs[
      recentHighs.length - 1
    ];

  const previousHigh =
    recentHighs[
      recentHighs.length - 2
    ];


  const lastLow =
    recentLows[
      recentLows.length - 1
    ];

  const previousLow =
    recentLows[
      recentLows.length - 2
    ];


  let direction =
    "NONE";


  /*
     Bullish:
     HH + HL
  */

  if (
    lastHigh.price >
      previousHigh.price &&
    lastLow.price >
      previousLow.price
  ) {
    direction =
      "BULLISH";
  }


  /*
     Bearish:
     LH + LL
  */

  if (
    lastHigh.price <
      previousHigh.price &&
    lastLow.price <
      previousLow.price
  ) {
    direction =
      "BEARISH";
  }


  /*
     If structure is mixed,
     use the most recent meaningful
     structural event rather than
     forcing a direction.
  */

  if (
    direction === "NONE"
  ) {

    const highChange =
      lastHigh.price -
      previousHigh.price;

    const lowChange =
      lastLow.price -
      previousLow.price;


    if (
      highChange > 0 &&
      lowChange >= 0
    ) {
      direction =
        "BULLISH";
    }

    else if (
      highChange < 0 &&
      lowChange <= 0
    ) {
      direction =
        "BEARISH";
    }
  }


  let pivot = null;

  let previousPivot = null;


  if (
    direction === "BULLISH"
  ) {

    pivot =
      lastLow;

    previousPivot =
      previousLow;
  }


  if (
    direction === "BEARISH"
  ) {

    pivot =
      lastHigh;

    previousPivot =
      previousHigh;
  }


  return {
    direction,

    pivot,

    previousPivot,

    highs:
      recentHighs,

    lows:
      recentLows,

    swingLabels:
      classifySwings(swings),

    confirmed:
      Boolean(pivot)
  };
}


/* =========================================================
   PRECISION ENGINE
   ---------------------------------------------------------
   Requested:
       DEPTH = 30
       DEVIATION = 5
       BACKSTEP = 5

   This is a browser-side confirmed swing
   implementation inspired by the requested
   Precision signal concept.

   It does NOT repaint confirmed signals.
   ========================================================= */

function precisionEngine(
  data
) {
  const result = {
    highs: [],
    lows: [],
    buy: null,
    sell: null,
    direction: "NONE"
  };


  if (
    !data ||
    data.length <
      PRECISION_CONFIG.depth
  ) {
    return result;
  }


  /*
     Step 1:
     Detect larger structural swings.

     Depth 30 = minimum observation
     window.

     Deviation 5 = minimum relative
     movement requirement.

     Backstep 5 = prevent closely
     duplicated swing points.
  */

  const rawHighs = [];
  const rawLows = [];


  const depth =
    PRECISION_CONFIG.depth;

  const deviation =
    PRECISION_CONFIG.deviation;

  const backstep =
    PRECISION_CONFIG.backstep;


  for (
    let i = depth;
    i < data.length;
    i++
  ) {

    const start =
      Math.max(
        0,
        i - depth
      );

    const window =
      data.slice(
        start,
        i
      );


    if (!window.length) {
      continue;
    }


    const highest =
      Math.max(
        ...window.map(
          c => c.high
        )
      );

    const lowest =
      Math.min(
        ...window.map(
          c => c.low
        )
      );


    const range =
      highest - lowest;


    if (range <= 0) {
      continue;
    }


    /*
       Local high.
    */

    const candidate =
      data[i];


    const highDeviation =
      Math.abs(
        candidate.high -
        lowest
      );


    const lowDeviation =
      Math.abs(
        highest -
        candidate.low
      );


    if (
      candidate.high >=
        highest &&
      highDeviation >=
        range *
          (deviation / 100)
    ) {

      rawHighs.push({
        index: i,
        time: candidate.time,
        price: candidate.high
      });
    }


    if (
      candidate.low <=
        lowest &&
      lowDeviation >=
        range *
          (deviation / 100)
    ) {

      rawLows.push({
        index: i,
        time: candidate.time,
        price: candidate.low
      });
    }
  }


  /*
     Apply backstep filtering.
  */

  for (
    const point of rawHighs
  ) {

    const previous =
      result.highs[
        result.highs.length - 1
      ];


    if (
      !previous ||
      point.index -
        previous.index >=
        backstep
    ) {

      result.highs.push(
        point
      );

    } else if (
      point.price >
      previous.price
    ) {

      result.highs[
        result.highs.length - 1
      ] = point;
    }
  }


  for (
    const point of rawLows
  ) {

    const previous =
      result.lows[
        result.lows.length - 1
      ];


    if (
      !previous ||
      point.index -
        previous.index >=
        backstep
    ) {

      result.lows.push(
        point
      );

    } else if (
      point.price <
      previous.price
    ) {

      result.lows[
        result.lows.length - 1
      ] = point;
    }
  }


  /*
     Precision confirmation:
     BUY:
       confirmed swing high exists
       and a CLOSED candle closes
       above it.

     SELL:
       confirmed swing low exists
       and a CLOSED candle closes
       below it.

     Wick alone does not trigger.
  */

  const closed =
    getClosedCandles(data);


  if (
    closed.length < 2
  ) {
    return result;
  }


  const last =
    closed[
      closed.length - 1
    ];


  const previous =
    closed[
      closed.length - 2
    ];


  const recentHigh =
    result.highs[
      result.highs.length - 1
    ];


  const recentLow =
    result.lows[
      result.lows.length - 1
    ];


  /*
     BUY precision confirmation.
  */

  if (
    recentHigh &&
    last.close >
      recentHigh.price &&
    previous.close <=
      recentHigh.price
  ) {

    result.buy = {
      type:
        "PRECISION BUY",

      price:
        last.close,

      swing:
        recentHigh.price,

      time:
        last.time
    };

    result.direction =
      "BULLISH";
  }


  /*
     SELL precision confirmation.
  */

  if (
    recentLow &&
    last.close <
      recentLow.price &&
    previous.close >=
      recentLow.price
  ) {

    result.sell = {
      type:
        "PRECISION SELL",

      price:
        last.close,

      swing:
        recentLow.price,

      time:
        last.time
    };

    result.direction =
      "BEARISH";
  }


  return result;
}


/* =========================================================
   LIQUIDITY SWEEP
   ========================================================= */

function detectLiquiditySweep(
  data,
  direction
) {
  const closed =
    getClosedCandles(data);


  if (
    closed.length < 10
  ) {
    return null;
  }


  const current =
    closed[
      closed.length - 1
    ];


  const recent =
    closed.slice(
      -9,
      -1
    );


  const highest =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );


  const lowest =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );


  /*
     Bullish setup:
     sweep sell-side liquidity
     then close back above it.
  */

  if (
    direction === "BULLISH" &&
    current.low <
      lowest &&
    current.close >
      lowest
  ) {

    return {
      type:
        "SELL-SIDE LIQUIDITY SWEEP",

      price:
        current.low,

      time:
        current.time
    };
  }


  /*
     Bearish setup:
     sweep buy-side liquidity
     then close back below it.
  */

  if (
    direction === "BEARISH" &&
    current.high >
      highest &&
    current.close <
      highest
  ) {

    return {
      type:
        "BUY-SIDE LIQUIDITY SWEEP",

      price:
        current.high,

      time:
        current.time
    };
  }


  return null;
}


/* =========================================================
   BOS / CHOCH / CHOCH+
   ========================================================= */

function detectStructureEvent(
  data,
  direction
) {
  const closed =
    getClosedCandles(data);


  if (
    closed.length < 15
  ) {
    return null;
  }


  const swings =
    detectSwings(
      closed,
      2,
      2
    );


  if (
    swings.highs.length < 2 ||
    swings.lows.length < 2
  ) {
    return null;
  }


  const last =
    closed[
      closed.length - 1
    ];


  const previous =
    closed[
      closed.length - 2
    ];


  const lastHigh =
    swings.highs[
      swings.highs.length - 1
    ];


  const previousHigh =
    swings.highs[
      swings.highs.length - 2
    ];


  const lastLow =
    swings.lows[
      swings.lows.length - 1
    ];


  const previousLow =
    swings.lows[
      swings.lows.length - 2
    ];


  /*
     Determine previous structural trend.
  */

  let previousTrend =
    "NONE";


  if (
    lastHigh.price >
      previousHigh.price &&
    lastLow.price >
      previousLow.price
  ) {
    previousTrend =
      "BULLISH";
  }


  if (
    lastHigh.price <
      previousHigh.price &&
    lastLow.price <
      previousLow.price
  ) {
    previousTrend =
      "BEARISH";
  }


  /*
     Bullish break.
  */

  if (
    direction === "BULLISH" &&
    last.close >
      previousHigh.price &&
    previous.close <=
      previousHigh.price
  ) {

    return {
      type:
        previousTrend ===
        "BEARISH"
          ? "CHoCH+"
          : "BOS",

      direction:
        "BULLISH",

      price:
        last.close,

      level:
        previousHigh.price,

      time:
        last.time
    };
  }


  /*
     Bearish break.
  */

  if (
    direction === "BEARISH" &&
    last.close <
      previousLow.price &&
    previous.close >=
      previousLow.price
  ) {

    return {
      type:
        previousTrend ===
        "BULLISH"
          ? "CHoCH+"
          : "BOS",

      direction:
        "BEARISH",

      price:
        last.close,

      level:
        previousLow.price,

      time:
        last.time
    };
  }


  /*
     Detect opposite break as CHoCH.
  */

  if (
    direction === "BULLISH" &&
    last.close >
      lastHigh.price
  ) {

    return {
      type: "CHoCH",
      direction: "BULLISH",
      price: last.close,
      level: lastHigh.price,
      time: last.time
    };
  }


  if (
    direction === "BEARISH" &&
    last.close <
      lastLow.price
  ) {

    return {
      type: "CHoCH",
      direction: "BEARISH",
      price: last.close,
      level: lastLow.price,
      time: last.time
    };
  }


  return null;
}


/* =========================================================
   DISPLACEMENT
   ========================================================= */

function detectDisplacement(
  data,
  direction
) {
  const closed =
    getClosedCandles(data);


  if (
    closed.length < 6
  ) {
    return null;
  }


  const current =
    closed[
      closed.length - 1
    ];


  const previous =
    closed[
      closed.length - 2
    ];


  const recent =
    closed.slice(
      -6,
      -1
    );


  const averageRange =
    recent.reduce(
      (sum, c) =>
        sum +
        (c.high - c.low),
      0
    ) /
    recent.length;


  const range =
    current.high -
    current.low;


  if (
    averageRange <= 0
  ) {
    return null;
  }


  const strong =
    range >=
    averageRange * 1.25;


  const body =
    Math.abs(
      current.close -
      current.open
    );


  const bodyRatio =
    range > 0
      ? body / range
      : 0;


  if (
    !strong ||
    bodyRatio < 0.55
  ) {
    return null;
  }


  if (
    direction === "BULLISH" &&
    current.close >
      current.open
  ) {

    return {
      direction:
        "BULLISH",

      time:
        current.time,

      strength:
        range /
        averageRange
    };
  }


  if (
    direction === "BEARISH" &&
    current.close <
      current.open
  ) {

    return {
      direction:
        "BEARISH",

      time:
        current.time,

      strength:
        range /
        averageRange
    };
  }


  return null;
}


/* =========================================================
   FAIR VALUE GAP
   ========================================================= */

function detectFVG(
  data,
  direction
) {
  const closed =
    getClosedCandles(data);


  if (
    closed.length < 3
  ) {
    return null;
  }


  const a =
    closed[
      closed.length - 3
    ];

  const b =
    closed[
      closed.length - 2
    ];

  const c =
    closed[
      closed.length - 1
    ];


  /*
     Bullish FVG:
     candle 3 low > candle 1 high.
  */

  if (
    direction === "BULLISH" &&
    c.low > a.high
  ) {

    return {
      type:
        "BULLISH FVG",

      low:
        a.high,

      high:
        c.low,

      midpoint:
        (
          a.high +
          c.low
        ) / 2,

      time:
        c.time
    };
  }


  /*
     Bearish FVG.
  */

  if (
    direction === "BEARISH" &&
    c.high < a.low
  ) {

    return {
      type:
        "BEARISH FVG",

      low:
        c.high,

      high:
        a.low,

      midpoint:
        (
          c.high +
          a.low
        ) / 2,

      time:
        c.time
    };
  }


  return null;
}


/* =========================================================
   ORDER BLOCK
   ========================================================= */

function detectOrderBlock(
  data,
  direction
) {
  const closed =
    getClosedCandles(data);


  if (
    closed.length < 8
  ) {
    return null;
  }


  const displacement =
    detectDisplacement(
      data,
      direction
    );


  if (!displacement) {
    return null;
  }


  const displacementIndex =
    closed.findIndex(
      c =>
        c.time ===
        displacement.time
    );


  if (
    displacementIndex <= 0
  ) {
    return null;
  }


  /*
     The last opposite candle
     before displacement is treated
     as the candidate OB.
  */

  for (
    let i =
      displacementIndex - 1;
    i >=
      Math.max(
        0,
        displacementIndex - 5
      );
    i--
  ) {

    const c =
      closed[i];


    if (
      direction === "BULLISH" &&
      c.close < c.open
    ) {

      return {
        type:
          "BULLISH ORDER BLOCK",

        high:
          c.high,

        low:
          c.low,

        midpoint:
          (
            c.high +
            c.low
          ) / 2,

        time:
          c.time
      };
    }


    if (
      direction === "BEARISH" &&
      c.close > c.open
    ) {

      return {
        type:
          "BEARISH ORDER BLOCK",

        high:
          c.high,

        low:
          c.low,

        midpoint:
          (
            c.high +
            c.low
          ) / 2,

        time:
          c.time
      };
    }
  }


  return null;
}


/* =========================================================
   SUPPLY / DEMAND
   ========================================================= */

function detectSupplyDemand(
  data,
  direction
) {
  const closed =
    getClosedCandles(data);


  if (
    closed.length < 5
  ) {
    return null;
  }


  const last =
    closed[
      closed.length - 1
    ];


  const previous =
    closed[
      closed.length - 2
    ];


  if (
    direction === "BULLISH" &&
    previous.close <
      previous.open &&
    last.close >
      previous.high
  ) {

    return {
      type: "DEMAND",

      high:
        previous.high,

      low:
        previous.low,

      time:
        previous.time
    };
  }


  if (
    direction === "BEARISH" &&
    previous.close >
      previous.open &&
    last.close <
      previous.low
  ) {

    return {
      type: "SUPPLY",

      high:
        previous.high,

      low:
        previous.low,

      time:
        previous.time
    };
  }


  return null;
}


/* =========================================================
   CANDLE CONFIRMATION
   ========================================================= */

function candleConfirmation(
  data,
  direction
) {
  const closed =
    getClosedCandles(data);


  if (!closed.length) {
    return null;
  }


  const c =
    closed[
      closed.length - 1
    ];


  const range =
    c.high -
    c.low;


  if (
    range <= 0
  ) {
    return null;
  }


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


  const bodyRatio =
    body / range;


  /*
     Bullish rejection.
  */

  if (
    direction === "BULLISH" &&
    lowerWick >=
      body * 1.2 &&
    c.close >
      c.open
  ) {

    return {
      type:
        "Bullish rejection",

      time:
        c.time
    };
  }


  /*
     Bullish momentum.
  */

  if (
    direction === "BULLISH" &&
    bodyRatio >= 0.65 &&
    c.close >
      c.open
  ) {

    return {
      type:
        "Bullish momentum candle",

      time:
        c.time
    };
  }


  /*
     Bearish rejection.
  */

  if (
    direction === "BEARISH" &&
    upperWick >=
      body * 1.2 &&
    c.close <
      c.open
  ) {

    return {
      type:
        "Bearish rejection",

      time:
        c.time
    };
  }


  /*
     Bearish momentum.
  */

  if (
    direction === "BEARISH" &&
    bodyRatio >= 0.65 &&
    c.close <
      c.open
  ) {

    return {
      type:
        "Bearish momentum candle",

      time:
        c.time
    };
  }


  return null;
}


/* =========================================================
   SUPPORT / RESISTANCE
   ========================================================= */

function detectSR(
  data
) {
  const closed =
    getClosedCandles(data);


  if (
    closed.length < 10
  ) {
    return null;
  }


  const swings =
    detectSwings(
      closed,
      2,
      2
    );


  const high =
    swings.highs.at(-1);


  const low =
    swings.lows.at(-1);


  return {
    resistance:
      high
        ? high.price
        : null,

    support:
      low
        ? low.price
        : null
  };
}


/* =========================================================
   PREMIUM / EQUILIBRIUM / DISCOUNT
   ========================================================= */

function getPremiumDiscount(
  data
) {
  const closed =
    getClosedCandles(data);


  if (
    closed.length < 10
  ) {
    return null;
  }


  const recent =
    closed.slice(-50);


  const high =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );


  const low =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );


  const equilibrium =
    (
      high + low
    ) / 2;


  const price =
    closed[
      closed.length - 1
    ].close;


  let zone =
    "EQUILIBRIUM";


  if (
    price >
    equilibrium
  ) {
    zone =
      "PREMIUM";
  }


  if (
    price <
    equilibrium
  ) {
    zone =
      "DISCOUNT";
  }


  return {
    high,
    low,
    equilibrium,
    zone
  };
}


/* =========================================================
   1H PIVOT CONFIRMATION
   ========================================================= */

function confirm1HPivot(
  h1Structure,
  direction,
  price
) {
  if (
    !h1Structure ||
    !h1Structure.confirmed ||
    !h1Structure.pivot
  ) {
    return {
      confirmed: false,
      reason:
        "No confirmed 1H swing pivot."
    };
  }


  if (
    direction === "BULLISH"
  ) {

    /*
       Price must be above
       the bullish structural pivot.
    */

    if (
      price >=
      h1Structure.pivot.price
    ) {

      return {
        confirmed: true,
        reason:
          "Price is respecting the confirmed 1H bullish pivot."
      };
    }
  }


  if (
    direction === "BEARISH"
  ) {

    if (
      price <=
      h1Structure.pivot.price
    ) {

      return {
        confirmed: true,
        reason:
          "Price is respecting the confirmed 1H bearish pivot."
      };
    }
  }


  return {
    confirmed: false,
    reason:
      "Price has invalidated the current 1H pivot relationship."
  };
}


/* =========================================================
   INVALIDATION
   ========================================================= */

function getInvalidation(
  direction,
  pivot,
  zone,
  sweep
) {
  if (
    direction === "BULLISH"
  ) {

    return (
      sweep?.price ??
      zone?.low ??
      pivot?.price ??
      null
    );
  }


  if (
    direction === "BEARISH"
  ) {

    return (
      sweep?.price ??
      zone?.high ??
      pivot?.price ??
      null
    );
  }


  return null;
}


/* =========================================================
   QUALITY SCORING
   ========================================================= */

function calculateScore(
  data
) {
  let score = 0;

  const factors = [];


  if (
    data.h1PivotConfirmed
  ) {

    score += 2;

    factors.push(
      "1H pivot"
    );
  }


  if (
    data.precision
  ) {

    score += 2;

    factors.push(
      "Precision"
    );
  }


  if (
    data.sweep
  ) {

    score += 2;

    factors.push(
      "Liquidity sweep"
    );
  }


  if (
    data.structureEvent
  ) {

    score += 2;

    factors.push(
      data.structureEvent.type
    );
  }


  if (
    data.displacement
  ) {

    score += 2;

    factors.push(
      "Displacement"
    );
  }


  if (
    data.fvg
  ) {

    score += 1;

    factors.push(
      "FVG"
    );
  }


  if (
    data.orderBlock
  ) {

    score += 1;

    factors.push(
      "Order Block"
    );
  }


  if (
    data.zone
  ) {

    score += 1;

    factors.push(
      data.zone.type
    );
  }


  if (
    data.candle
  ) {

    score += 2;

    factors.push(
      data.candle.type
    );
  }


  if (
    data.sr
  ) {

    score += 1;

    factors.push(
      "Support/Resistance"
    );
  }


  /*
     Grade thresholds.

     A+ = exceptional alignment
     A  = strong alignment
     B  = moderate confirmation
     C  = early/high-risk
  */

  let grade =
    "C";


  if (
    score >= 11
  ) {

    grade =
      "A+";

  } else if (
    score >= 8
  ) {

    grade =
      "A";

  } else if (
    score >= 5
  ) {

    grade =
      "B";

  } else {

    grade =
      "C";
  }


  return {
    score,
    grade,
    factors
  };
}


/* =========================================================
   TRADE PLAN
   ========================================================= */

function createTradePlan(
  direction,
  current,
  pivot,
  sweep,
  zone,
  fvg,
  orderBlock,
  sr
) {

  /*
     Prefer a structural zone for entry.
  */

  let entry =
    current.close;


  if (fvg) {

    entry =
      fvg.midpoint;

  } else if (
    orderBlock
  ) {

    entry =
      orderBlock.midpoint;

  } else if (
    zone
  ) {

    entry =
      (
        zone.high +
        zone.low
      ) / 2;
  }


  /*
     Recent volatility.
  */

  const recentRange =
    Math.max(
      0.00000001,
      Math.max(
        ...candles
          .slice(-20)
          .map(
            c => c.high
          )
      ) -
      Math.min(
        ...candles
          .slice(-20)
          .map(
            c => c.low
          )
      )
    );


  let sl;


  if (
    direction === "BULLISH"
  ) {

    sl =
      sweep?.price ??
      orderBlock?.low ??
      zone?.low ??
      pivot?.price ??
      sr?.support ??
      current.low;


    /*
       Small structural buffer.
    */

    sl -=
      recentRange * 0.02;
  }


  else {

    sl =
      sweep?.price ??
      orderBlock?.high ??
      zone?.high ??
      pivot?.price ??
      sr?.resistance ??
      current.high;


    sl +=
      recentRange * 0.02;
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


  /*
     Minimum target 1:2.
  */

  if (
    direction === "BULLISH"
  ) {

    tp1 =
      entry +
      risk * MIN_RR;

    tp2 =
      entry +
      risk * IDEAL_RR;

  } else {

    tp1 =
      entry -
      risk * MIN_RR;

    tp2 =
      entry -
      risk * IDEAL_RR;
  }


  const be =
    entry;


  /*
     TP zone around TP2.
  */

  const tpZone = {
    low:
      Math.min(
        tp1,
        tp2
      ),

    high:
      Math.max(
        tp1,
        tp2
      )
  };


  return {
    entry,
    sl,
    be,
    tp1,
    tp2,
    tpZone,

    risk,

    rr1:
      MIN_RR,

    rr2:
      IDEAL_RR
  };
}


/* =========================================================
   PROGRESSIVE SETUP ENGINE
   ========================================================= */

function buildProgressiveSignal() {

  if (
    candles.length < 100
  ) {

    return {
      stage: "NONE",
      grade: "C",
      direction: "NONE",

      reason:
        "Waiting for sufficient live market data."
    };
  }


  /*
     1H structure is mandatory.
  */

  const h1Structure =
    get1HStructure();


  if (
    h1Structure.direction ===
      "NONE" ||
    !h1Structure.pivot
  ) {

    return {
      stage: "NONE",

      grade: "C",

      direction: "NONE",

      reason:
        "NO SETUP — waiting for a confirmed 1H swing structure."
    };
  }


  const tfMinutes =
    TIMEFRAMES[
      selectedTimeframe
    ] || 5;


  const data =
    aggregateCandles(
      candles,
      tfMinutes
    );


  if (
    data.length < 30
  ) {

    return {
      stage: "NONE",

      grade: "C",

      direction:
        h1Structure.direction,

      reason:
        "Waiting for enough candles on the selected timeframe."
    };
  }


  const direction =
    h1Structure.direction;


  const current =
    data[
      data.length - 1
    ];


  const closed =
    getLastClosedCandle(
      data
    );


  if (!closed) {

    return {
      stage: "EARLY",

      grade: "C",

      direction,

      reason:
        "Waiting for the first confirmed closed candle."
    };
  }


  /*
     1H pivot.
  */

  const h1Pivot =
    confirm1HPivot(
      h1Structure,
      direction,
      current.close
    );


  /*
     Precision.
  */

  const precision =
    precisionEngine(
      data
    );


  const precisionConfirmed =
    direction === "BULLISH"
      ? Boolean(
          precision.buy
        )
      : Boolean(
          precision.sell
        );


  /*
     Liquidity.
  */

  const sweep =
    detectLiquiditySweep(
      data,
      direction
    );


  /*
     Structure.
  */

  const structureEvent =
    detectStructureEvent(
      data,
      direction
    );


  /*
     Displacement.
  */

  const displacement =
    detectDisplacement(
      data,
      direction
    );


  /*
     FVG.
  */

  const fvg =
    detectFVG(
      data,
      direction
    );


  /*
     Order Block.
  */

  const orderBlock =
    detectOrderBlock(
      data,
      direction
    );


  /*
     Supply/Demand.
  */

  const zone =
    detectSupplyDemand(
      data,
      direction
    );


  /*
     Candle.
  */

  const candle =
    candleConfirmation(
      data,
      direction
    );


  /*
     S/R.
  */

  const sr =
    detectSR(
      data
    );


  /*
     Premium / Equilibrium /
     Discount.
  */

  const pd =
    getPremiumDiscount(
      data
    );


  /*
     Collect confirmation data.
  */

  const analysisData = {
    h1PivotConfirmed:
      h1Pivot.confirmed,

    precision:
      precisionConfirmed,

    sweep,

    structureEvent,

    displacement,

    fvg,

    orderBlock,

    zone,

    candle,

    sr
  };


  const scoring =
    calculateScore(
      analysisData
    );


  let grade =
    scoring.grade;


  /*
     Force C when 1H pivot is
     not respected.

     This prevents a strong-looking
     lower-timeframe setup from
     overriding the mandatory
     1H requirement.
  */

  if (
    !h1Pivot.confirmed
  ) {

    grade =
      "C";
  }


  /*
     If Precision confirms direction,
     it is an independent signal source.
  */

  let precisionSignal =
    null;


  if (
    precision.buy
  ) {

    precisionSignal =
      precision.buy;
  }


  if (
    precision.sell
  ) {

    precisionSignal =
      precision.sell;
  }


  /*
     Count core confirmations.
  */

  let coreConfirmations =
    0;


  if (
    h1Pivot.confirmed
  ) {
    coreConfirmations++;
  }


  if (
    precisionConfirmed
  ) {
    coreConfirmations++;
  }


  if (
    sweep
  ) {
    coreConfirmations++;
  }


  if (
    structureEvent
  ) {
    coreConfirmations++;
  }


  if (
    displacement
  ) {
    coreConfirmations++;
  }


  if (
    fvg ||
    orderBlock ||
    zone
  ) {
    coreConfirmations++;
  }


  if (
    candle
  ) {
    coreConfirmations++;
  }


  /*
     Progressive stages.

     EARLY:
     1H structure exists but
     little confirmation.

     WAITING:
     location/price-action
     developing.

     CONFIRMED:
     C/B/A/A+.

     INVALIDATED:
     pivot has been broken.
  */

  let stage =
    "EARLY SETUP";


  if (
    !h1Pivot.confirmed
  ) {

    stage =
      "INVALIDATED";

  } else if (
    coreConfirmations <= 1
  ) {

    stage =
      "EARLY SETUP";

  } else if (
    coreConfirmations === 2
  ) {

    stage =
      "WAITING FOR CONFIRMATION";

  } else {

    stage =
      "CONFIRMED";
  }


  /*
     A+ definition.

     Requires the strongest combination:
       1H pivot
       Precision
       Liquidity
       Structure
       Displacement
       Location
       Candle confirmation
  */

  const aPlus =
    h1Pivot.confirmed &&
    precisionConfirmed &&
    Boolean(sweep) &&
    Boolean(structureEvent) &&
    Boolean(displacement) &&
    Boolean(
      fvg ||
      orderBlock ||
      zone
    ) &&
    Boolean(candle);


  if (
    aPlus
  ) {

    grade =
      "A+";

    stage =
      "CONFIRMED";
  }


  /*
     If A/A+/B/C has sufficient
     evidence, it is a confirmed
     setup.

     C remains a higher-risk
     confirmed opportunity once
     there are at least 3
     meaningful factors.
  */

  if (
    coreConfirmations >= 3
  ) {

    stage =
      "CONFIRMED";
  }


  /*
     Trade plan.
  */

  const plan =
    createTradePlan(
      direction,
      current,
      h1Structure.pivot,
      sweep,
      zone,
      fvg,
      orderBlock,
      sr
    );


  if (!plan) {

    return {
      stage: "NONE",

      grade,

      direction,

      reason:
        "Risk calculation is invalid."
    };
  }


  /*
     Invalidation.
  */

  const invalidation =
    getInvalidation(
      direction,
      h1Structure.pivot,
      zone || orderBlock,
      sweep
    );


  /*
     Strong invalidation check.

     Bullish:
     closed candle below 1H pivot.

     Bearish:
     closed candle above 1H pivot.
  */

  let invalidated =
    false;


  if (
    direction === "BULLISH" &&
    closed.close <
      h1Structure.pivot.price
  ) {

    invalidated =
      true;
  }


  if (
    direction === "BEARISH" &&
    closed.close >
      h1Structure.pivot.price
  ) {

    invalidated =
      true;
  }


  if (
    invalidated
  ) {

    stage =
      "INVALIDATED";
  }


  /*
     Confirmation list.
  */

  const confirmations = [];


  if (
    h1Pivot.confirmed
  ) {

    confirmations.push(
      "1H swing pivot"
    );
  }


  if (
    precisionConfirmed
  ) {

    confirmations.push(
      precisionSignal?.type ||
      "Precision confirmation"
    );
  }


  if (
    sweep
  ) {

    confirmations.push(
      sweep.type
    );
  }


  if (
    structureEvent
  ) {

    confirmations.push(
      structureEvent.type
    );
  }


  if (
    displacement
  ) {

    confirmations.push(
      "Displacement"
    );
  }


  if (
    fvg
  ) {

    confirmations.push(
      fvg.type
    );
  }


  if (
    orderBlock
  ) {

    confirmations.push(
      orderBlock.type
    );
  }


  if (
    zone
  ) {

    confirmations.push(
      zone.type
    );
  }


  if (
    candle
  ) {

    confirmations.push(
      candle.type
    );
  }


  /*
     Quality.
  */

  let quality =
    "LOW";


  if (
    grade === "B"
  ) {

    quality =
      "MEDIUM";
  }


  if (
    grade === "A"
  ) {

    quality =
      "HIGH";
  }


  if (
    grade === "A+"
  ) {

    quality =
      "VERY HIGH";
  }


  /*
     Final reason.
  */

  let reason;


  if (
    stage === "INVALIDATED"
  ) {

    reason =
      `1H pivot invalidated. ${direction} setup is no longer valid.`;

  } else if (
    !confirmations.length
  ) {

    reason =
      "1H structural opportunity detected.";

  } else {

    reason =
      confirmations.join(
        " + "
      );
  }


  return {

    stage,

    grade,

    quality,

    direction,

    pivot:
      h1Structure.pivot,

    previousPivot:
      h1Structure.previousPivot,

    h1Structure,

    h1Pivot,

    precision,

    precisionConfirmed,

    precisionSignal,

    sweep,

    structureEvent,

    displacement,

    fvg,

    orderBlock,

    zone,

    candle,

    sr,

    premiumDiscount:
      pd,

    confirmations,

    score:
      scoring.score,

    entry:
      plan.entry,

    sl:
      plan.sl,

    be:
      plan.be,

    tp1:
      plan.tp1,

    tp2:
      plan.tp2,

    tpZone:
      plan.tpZone,

    rr:
      plan.rr2,

    rr1:
      plan.rr1,

    rr2:
      plan.rr2,

    risk:
      plan.risk,

    invalidation,

    reason,

    candleTime:
      closed.time
  };
}


/* =========================================================
   MAIN ANALYSIS
   ========================================================= */

function analyzeProgressively() {
  if (!selectedSymbol) {
    return;
  }


  const result =
    buildProgressiveSignal();


  currentSignal =
    result;


  updateDashboard(
    result
  );


  processAlert(
    result
  );
}


/* =========================================================
   DASHBOARD UPDATE
   ========================================================= */

function updateDashboard(
  result
) {

  if (
    !result ||
    result.stage ===
      "NONE"
  ) {

    setText(
      "signal",
      "NO SETUP"
    );

    setText(
      "direction",
      result?.direction ||
        "NONE"
    );

    setText(
      "setup",
      result?.reason ||
        "No valid setup."
    );

    setText(
      "confidence",
      "-"
    );

    setText(
      "rr",
      "-"
    );

    setText(
      "entry",
      "-"
    );

    setText(
      "sl",
      "-"
    );

    setText(
      "tp1",
      "-"
    );

    setText(
      "tp2",
      "-"
    );

    setText(
      "swing",
      "-"
    );

    setText(
      "structure",
      "-"
    );

    setText(
      "liquidity",
      "-"
    );

    setText(
      "sr",
      "-"
    );

    setText(
      "pattern",
      "-"
    );

    setText(
      "rejection",
      "-"
    );

    setText(
      "momentum",
      "-"
    );

    setText(
      "confirmation",
      "-"
    );

    return;
  }


  const arrow =
    result.direction ===
      "BULLISH"
      ? "BUY"
      : "SELL";


  /*
     Signal label.
  */

  setText(
    "signal",
    `${arrow} — ${result.grade} ${result.stage}`
  );


  setText(
    "direction",
    arrow
  );


  setText(
    "setup",
    result.reason
  );


  setText(
    "confidence",
    result.quality ||
      result.grade
  );


  setText(
    "rr",
    `1:${result.rr}`
  );


  setText(
    "entry",
    roundPrice(
      result.entry
    )
  );


  setText(
    "sl",
    roundPrice(
      result.sl
    )
  );


  setText(
    "tp1",
    roundPrice(
      result.tp1
    )
  );


  setText(
    "tp2",
    roundPrice(
      result.tp2
    )
  );


  setText(
    "swing",
    result.pivot
      ? roundPrice(
          result.pivot.price
        )
      : "-"
  );


  setText(
    "structure",
    result.structureEvent
      ? result.structureEvent.type
      : `${result.direction} 1H STRUCTURE`
  );


  setText(
    "liquidity",
    result.sweep
      ? result.sweep.type
      : "Watching"
  );


  setText(
    "sr",
    result.sr
      ? `S: ${roundPrice(result.sr.support)} | R: ${roundPrice(result.sr.resistance)}`
      : "Watching"
  );


  setText(
    "pattern",
    result.candle
      ? result.candle.type
      : "Watching"
  );


  setText(
    "rejection",
    result.candle &&
    result.candle.type
      .toLowerCase()
      .includes(
        "rejection"
      )
      ? "YES"
      : "Watching"
  );


  setText(
    "momentum",
    result.displacement
      ? "CONFIRMED"
      : "Watching"
  );


  setText(
    "confirmation",
    result.confirmations &&
    result.confirmations.length
      ? result.confirmations.join(
          " → "
        )
      : "Early setup"
  );


  /*
     Additional optional dashboard
     fields if they exist in HTML.
  */

  setText(
    "grade",
    result.grade
  );


  setText(
    "score",
    result.score
      ? `${result.score}`
      : "-"
  );


  setText(
    "be",
    roundPrice(
      result.be
    )
  );


  setText(
    "invalidation",
    roundPrice(
      result.invalidation
    )
  );


  setText(
    "tpZone",
    result.tpZone
      ? `${roundPrice(result.tpZone.low)} - ${roundPrice(result.tpZone.high)}`
      : "-"
  );


  setText(
    "precision",
    result.precisionConfirmed
      ? (
          result.precisionSignal?.type ||
          "CONFIRMED"
        )
      : "Watching"
  );


  setText(
    "premiumDiscount",
    result.premiumDiscount
      ? result.premiumDiscount.zone
      : "-"
  );


  updateExplanation(
    result
  );
}


/* =========================================================
   AI ANALYST / EXPLANATION
   ========================================================= */

function generateAnalystSummary(
  result
) {
  if (!result) {
    return "No current market setup.";
  }


  if (
    result.stage ===
    "INVALIDATED"
  ) {

    return (
      `${result.direction} setup invalidated because the confirmed 1H structural pivot was broken. ` +
      `Wait for a new confirmed swing and fresh setup.`
    );
  }


  const direction =
    result.direction ===
      "BULLISH"
      ? "BUY"
      : "SELL";


  const location =
    result.premiumDiscount
      ? result.premiumDiscount.zone
      : "unknown location";


  let summary =
    `${direction} ${result.grade} setup. `;


  summary +=
    `The 1H structure is ${result.direction}. `;


  summary +=
    `Price is currently in ${location}. `;


  if (
    result.precisionConfirmed
  ) {

    summary +=
      `The Precision Engine has confirmed the ${direction} direction from a confirmed swing. `;
  }


  if (
    result.sweep
  ) {

    summary +=
      `Liquidity was swept before the setup developed. `;
  }


  if (
    result.structureEvent
  ) {

    summary +=
      `${result.structureEvent.type} confirms structural movement. `;
  }


  if (
    result.displacement
  ) {

    summary +=
      `Displacement confirms strong directional intent. `;
  }


  if (
    result.fvg
  ) {

    summary +=
      `An FVG provides a potential retracement location. `;
  }


  if (
    result.orderBlock
  ) {

    summary +=
      `An Order Block provides an additional POI. `;
  }


  if (
    result.candle
  ) {

    summary +=
      `${result.candle.type} confirms price action. `;
  }


  summary +=
    `The planned entry is ${roundPrice(result.entry)}, ` +
    `SL is ${roundPrice(result.sl)}, ` +
    `TP1 is ${roundPrice(result.tp1)}, ` +
    `and TP2 is ${roundPrice(result.tp2)}. `;


  summary +=
    `Risk-to-reward is approximately 1:${result.rr}.`;


  return summary;
}


function updateExplanation(
  result
) {
  const box =
    $("explanationText");


  if (!box) {
    return;
  }


  if (
    !result ||
    result.stage ===
      "NONE"
  ) {

    box.innerHTML =
      `<strong>AI ANALYST</strong><br><br>${escapeHTML(
        result?.reason ||
        "Waiting for live market data."
      )}`;

    return;
  }


  const direction =
    result.direction ===
      "BULLISH"
      ? "BUY"
      : "SELL";


  let html = `
    <strong>${escapeHTML(direction)} ${escapeHTML(result.grade)} SETUP</strong>
    <br><br>
  `;


  html += `
    <strong>Analyst:</strong>
    ${escapeHTML(
      generateAnalystSummary(result)
    )}
    <br><br>
  `;


  html += `
    <strong>1H Structure:</strong>
    ${escapeHTML(result.direction)}
    <br>
  `;


  if (
    result.pivot
  ) {

    html += `
      <strong>1H Structural Pivot:</strong>
      ${roundPrice(result.pivot.price)}
      <br>
    `;
  }


  if (
    result.precisionConfirmed
  ) {

    html += `
      <strong>Precision Engine:</strong>
      ${escapeHTML(
        result.precisionSignal?.type ||
        "Confirmed"
      )}
      <br>
      <small>
        Depth ${PRECISION_CONFIG.depth} |
        Deviation ${PRECISION_CONFIG.deviation} |
        Backstep ${PRECISION_CONFIG.backstep}
      </small>
      <br>
    `;
  }


  if (
    result.sweep
  ) {

    html += `
      <strong>Liquidity:</strong>
      ${escapeHTML(
        result.sweep.type
      )}
      <br>
    `;
  }


  if (
    result.structureEvent
  ) {

    html += `
      <strong>Structure:</strong>
      ${escapeHTML(
        result.structureEvent.type
      )}
      <br>
    `;
  }


  if (
    result.displacement
  ) {

    html += `
      <strong>Displacement:</strong>
      CONFIRMED
      <br>
    `;
  }


  if (
    result.fvg
  ) {

    html += `
      <strong>FVG:</strong>
      ${roundPrice(result.fvg.low)}
      -
      ${roundPrice(result.fvg.high)}
      <br>
    `;
  }


  if (
    result.orderBlock
  ) {

    html += `
      <strong>Order Block:</strong>
      ${escapeHTML(
        result.orderBlock.type
      )}
      |
      ${roundPrice(result.orderBlock.low)}
      -
      ${roundPrice(result.orderBlock.high)}
      <br>
    `;
  }


  if (
    result.zone
  ) {

    html += `
      <strong>Fresh Zone:</strong>
      ${escapeHTML(
        result.zone.type
      )}
      <br>
    `;
  }


  if (
    result.candle
  ) {

    html += `
      <strong>Candle Confirmation:</strong>
      ${escapeHTML(
        result.candle.type
      )}
      <br>
    `;
  }


  if (
    result.premiumDiscount
  ) {

    html += `
      <strong>Market Location:</strong>
      ${escapeHTML(
        result.premiumDiscount.zone
      )}
      <br>
    `;
  }


  html += `
    <br>
    <strong>ENTRY:</strong>
    ${roundPrice(result.entry)}
    <br>

    <strong>SL:</strong>
    ${roundPrice(result.sl)}
    <br>

    <strong>BE:</strong>
    ${roundPrice(result.be)}
    <br>

    <strong>TP1:</strong>
    ${roundPrice(result.tp1)}
    <br>

    <strong>TP2:</strong>
    ${roundPrice(result.tp2)}
    <br>

    <strong>RR:</strong>
    1:${result.rr}
    <br>

    <strong>Invalidation:</strong>
    ${roundPrice(result.invalidation)}
    <br>
  `;


  html += `
    <br>
    <strong>CONFIRMATIONS:</strong>
    ${escapeHTML(
      result.confirmations.join(
        " → "
      )
    )}
    <br><br>
  `;


  if (
    result.stage ===
    "EARLY SETUP"
  ) {

    html += `
      <strong>STATUS:</strong>
      Early setup detected. Continue monitoring.
    `;
  }


  else if (
    result.stage ===
    "WAITING FOR CONFIRMATION"
  ) {

    html += `
      <strong>STATUS:</strong>
      Waiting for additional confirmation.
      Do not assume the setup is fully confirmed yet.
    `;
  }


  else if (
    result.grade ===
    "C"
  ) {

    html += `
      <strong>STATUS:</strong>
      C setup confirmed.
      This is the highest-risk grade.
      Wait for improvement if you want stronger confirmation.
    `;
  }


  else if (
    result.grade ===
    "B"
  ) {

    html += `
      <strong>STATUS:</strong>
      B setup confirmed.
      Additional confirmation may upgrade it to A/A+.
    `;
  }


  else if (
    result.grade ===
    "A"
  ) {

    html += `
      <strong>STATUS:</strong>
      A setup confirmed.
      Multiple conditions are aligned.
    `;
  }


  else if (
    result.grade ===
    "A+"
  ) {

    html += `
      <strong>STATUS:</strong>
      A+ setup confirmed.
      Strong multi-factor alignment detected.
    `;
  }


  box.innerHTML =
    html;
}


/* =========================================================
   ALERT ENGINE
   ========================================================= */

function processAlert(
  result
) {
  if (!result) {
    return;
  }


  /*
     No alerts for nothing.
  */

  if (
    result.stage ===
      "NONE"
  ) {
    return;
  }


  /*
     Explicit invalidation alert.
  */

  if (
    result.stage ===
    "INVALIDATED"
  ) {

    const invalidationKey =
      [
        selectedSymbol,
        result.direction,
        result.pivot?.time,
        "INVALIDATED"
      ].join("|");


    if (
      invalidationKey !==
      lastAlertKey
    ) {

      lastAlertKey =
        invalidationKey;


      const title =
        `${selectedSymbol} ${result.direction} SETUP INVALIDATED`;


      const message =
        `The 1H structural pivot has been invalidated.\n\n` +
        `Wait for a fresh setup.`;


      showInAppAlert(
        title,
        message
      );


      sendBrowserNotification(
        title,
        message
      );
    }


    return;
  }


  /*
     Only A+, A, B and C confirmed
     setups generate trading alerts.

     EARLY and WAITING states
     update the dashboard but do
     not spam trade notifications.
  */

  if (
    result.stage !==
    "CONFIRMED"
  ) {
    return;
  }


  if (
    ![
      "A+",
      "A",
      "B",
      "C"
    ].includes(
      result.grade
    )
  ) {
    return;
  }


  /*
     Unique alert identity.

     It includes:
       market
       direction
       grade
       candle
       structural pivot
       precision event
       structure event
  */

  const alertKey =
    [
      selectedSymbol,

      result.direction,

      result.grade,

      result.pivot?.time ||
        "none",

      result.candleTime ||
        "none",

      result.precisionSignal?.time ||
        "none",

      result.structureEvent?.time ||
        "none",

      result.structureEvent?.type ||
        "none",

      result.sweep?.time ||
        "none"
    ].join("|");


  if (
    alertKey ===
    lastAlertKey
  ) {

    return;
  }


  /*
     Detect grade upgrade.
  */

  const gradeRank = {
    C: 1,
    B: 2,
    A: 3,
    "A+": 4
  };


  const previousRank =
    gradeRank[
      lastGrade
    ] || 0;


  const currentRank =
    gradeRank[
      result.grade
    ] || 0;


  const upgraded =
    currentRank >
    previousRank &&
    lastGrade;


  lastAlertKey =
    alertKey;


  lastGrade =
    result.grade;


  const arrow =
    result.direction ===
      "BULLISH"
      ? "BUY"
      : "SELL";


  let title =
    `${selectedSymbol} ${arrow} ${result.grade} SETUP`;


  if (
    upgraded
  ) {

    title +=
      ` — UPGRADED FROM ${lastGrade}`;
  }


  const message = `
${result.grade} SETUP CONFIRMED

Market: ${selectedSymbol}

Direction: ${arrow}

Timeframe: ${selectedTimeframe}

1H Structure: ${result.direction}

Entry: ${roundPrice(result.entry)}

SL: ${roundPrice(result.sl)}

BE: ${roundPrice(result.be)}

TP1: ${roundPrice(result.tp1)}

TP2: ${roundPrice(result.tp2)}

RR: 1:${result.rr}

Score: ${result.score}

Reason:
${result.reason}

Confirmations:
${result.confirmations.join(" + ")}
  `.trim();


  showInAppAlert(
    title,
    message
  );


  sendBrowserNotification(
    title,
    message
  );


  addHistory(
    result,
    title
  );
}


/* =========================================================
   IN-APP ALERT
   ========================================================= */

function showInAppAlert(
  title,
  message
) {
  console.log(
    title,
    message
  );


  const alertBox =
    $("alertBox");


  if (
    alertBox
  ) {

    alertBox.innerHTML = `
      <strong>
        ${escapeHTML(title)}
      </strong>

      <br>

      ${escapeHTML(message)
        .replace(/\n/g, "<br>")}
    `;


    alertBox.style.display =
      "block";
  }


  /*
     Optional custom alert hook.
  */

  if (
    typeof window.onTradingSignal ===
    "function"
  ) {

    try {
      window.onTradingSignal({
        title,
        message,
        signal:
          currentSignal
      });
    } catch (
      error
    ) {

      console.error(
        error
      );
    }
  }
}


/* =========================================================
   BROWSER NOTIFICATIONS
   ========================================================= */

function sendBrowserNotification(
  title,
  body
) {
  if (
    typeof Notification ===
    "undefined"
  ) {
    return;
  }


  if (
    Notification.permission ===
    "granted"
  ) {

    try {

      new Notification(
        title,
        {
          body,

          tag:
            `${selectedSymbol}-${title}`,

          renotify:
            true
        }
      );

    } catch (
      error
    ) {

      console.error(
        "Notification error:",
        error
      );
    }


    return;
  }


  /*
     Browser permission normally
     requires a user interaction.
  */

  if (
    Notification.permission ===
    "default"
  ) {

    Notification.requestPermission()
      .then(
        permission => {

          if (
            permission ===
            "granted"
          ) {

            try {

              new Notification(
                title,
                {
                  body,

                  tag:
                    `${selectedSymbol}-${title}`,

                  renotify:
                    true
                }
              );

            } catch {}
          }
        }
      )
      .catch(
        () => {}
      );
  }
}


/* =========================================================
   ENABLE NOTIFICATIONS
   ========================================================= */

function requestNotificationPermission() {
  if (
    typeof Notification ===
    "undefined"
  ) {
    return;
  }


  if (
    Notification.permission ===
    "default"
  ) {

    Notification.requestPermission()
      .catch(
        () => {}
      );
  }
}


/*
   If the HTML has a notification
   button, support common IDs.
*/

[
  "enableNotifications",
  "notificationButton",
  "notifications"
].forEach(id => {

  const button =
    $(id);

  if (
    button &&
    !button.dataset.notificationBound
  ) {

    button.dataset.notificationBound =
      "true";


    button.addEventListener(
      "click",
      requestNotificationPermission
    );
  }
});


/* =========================================================
   SIGNAL HISTORY
   ========================================================= */

function addHistory(
  result,
  title
) {
  const history =
    $("signalHistory");


  if (!history) {
    return;
  }


  const item =
    document.createElement(
      "div"
    );


  item.className =
    "history-item";


  item.innerHTML = `
    <strong>
      ${escapeHTML(title)}
    </strong>

    <br>

    Entry:
    ${roundPrice(result.entry)}

    <br>

    SL:
    ${roundPrice(result.sl)}

    |

    TP1:
    ${roundPrice(result.tp1)}

    |

    TP2:
    ${roundPrice(result.tp2)}

    <br>

    RR:
    1:${escapeHTML(result.rr)}

    <br>

    ${escapeHTML(result.reason)}
  `;


  history.prepend(
    item
  );


  while (
    history.children.length >
    30
  ) {

    history.removeChild(
      history.lastChild
    );
  }
}


/* =========================================================
   TIMEFRAME BUTTONS
   ========================================================= */

document
  .querySelectorAll(
    "[data-timeframe]"
  )
  .forEach(
    button => {

      button.addEventListener(
        "click",
        () => {

          selectedTimeframe =
            button.dataset.timeframe;


          document
            .querySelectorAll(
              "[data-timeframe]"
            )
            .forEach(
              btn => {

                btn.classList
                  .remove(
                    "active"
                  );
              }
            );


          button.classList
            .add(
              "active"
            );


          resetAnalysisState();

          analyzeProgressively();
        }
      );
    }
  );


/* =========================================================
   ANALYZE BUTTON
   ========================================================= */

const analyzeButton =
  $("analyze");


if (
  analyzeButton
) {

  analyzeButton.addEventListener(
    "click",
    () => {

      requestNotificationPermission();

      analyzeProgressively();
    }
  );
}


/* =========================================================
   ANALYST CHAT SUPPORT
   ---------------------------------------------------------
   If the HTML contains:
       analystInput
       analystSend

   the bot answers using current
   live market state.
   ========================================================= */

function answerAnalystQuestion(
  question
) {
  const q =
    String(
      question || ""
    )
    .trim()
    .toLowerCase();


  if (!currentSignal) {
    return "I am waiting for live market data.";
  }


  const r =
    currentSignal;


  if (
    q.includes("signal") ||
    q.includes("setup")
  ) {

    return (
      `${r.direction} ${r.grade} ${r.stage}. ` +
      `${r.reason}`
    );
  }


  if (
    q.includes("entry")
  ) {

    return (
      `Current planned entry: ${roundPrice(r.entry)}. ` +
      `The entry is based on the detected structural POI.`
    );
  }


  if (
    q.includes("stop") ||
    q.includes("sl")
  ) {

    return (
      `Current stop loss: ${roundPrice(r.sl)}. ` +
      `Invalidation: ${roundPrice(r.invalidation)}.`
    );
  }


  if (
    q.includes("take profit") ||
    q.includes("tp")
  ) {

    return (
      `TP1: ${roundPrice(r.tp1)}. ` +
      `TP2: ${roundPrice(r.tp2)}.`
    );
  }


  if (
    q.includes("precision")
  ) {

    return r.precisionConfirmed
      ? (
          `Precision is CONFIRMED using the ${r.precisionSignal?.type || "confirmed swing break"}. ` +
          `Parameters: Depth ${PRECISION_CONFIG.depth}, Deviation ${PRECISION_CONFIG.deviation}, Backstep ${PRECISION_CONFIG.backstep}.`
        )
      : (
          `Precision confirmation has not triggered yet. ` +
          `The engine is waiting for a confirmed swing break on a closed candle.`
        );
  }


  if (
    q.includes("1h") ||
    q.includes("pivot") ||
    q.includes("swing")
  ) {

    return (
      `The 1H structure is ${r.h1Structure?.direction || "NONE"}. ` +
      `The structural pivot is ${roundPrice(r.pivot?.price)}.`
    );
  }


  if (
    q.includes("liquidity")
  ) {

    return r.sweep
      ? `Liquidity event: ${r.sweep.type} at ${roundPrice(r.sweep.price)}.`
      : "No confirmed liquidity sweep is currently detected.";
  }


  if (
    q.includes("fvg")
  ) {

    return r.fvg
      ? (
          `FVG detected: ${roundPrice(r.fvg.low)} - ${roundPrice(r.fvg.high)}.`
        )
      : "No fresh FVG is currently detected.";
  }


  if (
    q.includes("order block") ||
    q.includes("ob")
  ) {

    return r.orderBlock
      ? (
          `${r.orderBlock.type}: ` +
          `${roundPrice(r.orderBlock.low)} - ${roundPrice(r.orderBlock.high)}.`
        )
      : "No fresh Order Block is currently detected.";
  }


  if (
    q.includes("why") ||
    q.includes("reason")
  ) {

    return generateAnalystSummary(
      r
    );
  }


  if (
    q.includes("buy")
  ) {

    return (
      `BUY status: ${
        r.direction === "BULLISH"
          ? "Bullish conditions are active."
          : "The current 1H direction is not bullish."
      }`
    );
  }


  if (
    q.includes("sell")
  ) {

    return (
      `SELL status: ${
        r.direction === "BEARISH"
          ? "Bearish conditions are active."
          : "The current 1H direction is not bearish."
      }`
    );
  }


  return (
    `Current analysis: ${r.direction} ${r.grade} ${r.stage}. ` +
    `${r.reason}`
  );
}


/* =========================================================
   CHAT EVENT BINDINGS
   ========================================================= */

const analystSend =
  $("analystSend");


const analystInput =
  $("analystInput");


if (
  analystSend &&
  analystInput
) {

  analystSend.addEventListener(
    "click",
    () => {

      const answer =
        answerAnalystQuestion(
          analystInput.value
        );


      const output =
        $("analystResponse");


      if (output) {
        output.textContent =
          answer;
      }
    }
  );


  analystInput.addEventListener(
    "keydown",
    event => {

      if (
        event.key ===
        "Enter"
      ) {

        event.preventDefault();

        analystSend.click();
      }
    }
  );
}


/* =========================================================
   OPTIONAL AUTO ANALYSIS
   ========================================================= */

let analysisTimer =
  null;


function startAutoAnalysis() {

  if (
    analysisTimer
  ) {
    return;
  }


  /*
     Re-analyze every minute.

     Live ticks still trigger
     immediate analysis.
  */

  analysisTimer =
    setInterval(
      () => {

        if (
          selectedSymbol
        ) {

          analyzeProgressively();
        }

      },
      60000
    );
}


startAutoAnalysis();


/* =========================================================
   VISIBILITY HANDLING
   ========================================================= */

document.addEventListener(
  "visibilitychange",
  () => {

    /*
       When the page becomes visible
       again, immediately refresh
       the analysis.
    */

    if (
      !document.hidden
    ) {

      analyzeProgressively();
    }
  }
);


/* =========================================================
   CONNECTION HEALTH CHECK
   ========================================================= */

setInterval(
  () => {

    if (
      !selectedSymbol
    ) {
      return;
    }


    if (
      !ws ||
      ws.readyState !==
      WebSocket.OPEN
    ) {

      connectDeriv();
    }

  },
  10000
);


/* =========================================================
   DEBUG / EXTERNAL API
   ========================================================= */

/*
   Makes the live analyst available
   to other UI components.

   Example:
       window.SuccessfulPineScript.getSignal()
*/

window.SuccessfulPineScript = {

  getSignal() {
    return currentSignal;
  },


  getPrice() {
    return selectedPrice;
  },


  getSymbol() {
    return selectedSymbol;
  },


  getTimeframe() {
    return selectedTimeframe;
  },


  analyze() {
    analyzeProgressively();

    return currentSignal;
  },


  ask(question) {
    return answerAnalystQuestion(
      question
    );
  },


  enableNotifications() {
    requestNotificationPermission();
  },


  precisionConfig:
    PRECISION_CONFIG
};


/* =========================================================
   START ENGINE
   ========================================================= */

connectDeriv();


/* =========================================================
   END
   ========================================================= */
