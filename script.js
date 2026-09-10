const DERIV_URL =
  "wss://api.derivws.com/trading/v1/options/ws/public";

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 2000;

let activeMarkets = [];
let selectedSymbol = null;

let candles = {
  M1: [],
  M5: [],
  M15: [],
  M30: [],
  H1: [],
  H2: [],
  H4: [],
  Daily: []
};

let currentTicks = [];
let lastAnalysisTime = 0;

const connectionText =
  document.getElementById("connectionText");

const marketSelect =
  document.getElementById("market");

const priceElement =
  document.getElementById("price");

const selectedMarketElement =
  document.getElementById("selectedMarket");

const timeframeSelect =
  document.getElementById("timeframe");

const selectedTimeframeElement =
  document.getElementById("selectedTimeframe");

const analyzeButton =
  document.getElementById("analyzeBtn");

function setStatus(text) {
  if (connectionText) {
    connectionText.textContent = text;
  }

  console.log("[DERIV]", text);
}

function connectDeriv() {
  clearTimeout(reconnectTimer);

  setStatus("Connecting to Deriv...");

  try {
    socket = new WebSocket(DERIV_URL);
  } catch (error) {
    console.error(error);
    reconnect();
    return;
  }

  socket.onopen = function () {
    console.log("DERIV LIVE CONNECTION SUCCESSFUL");

    setStatus("LIVE • DERIV CONNECTED");

    reconnectDelay = 2000;

    requestActiveMarkets();
  };

  socket.onmessage = function (event) {
    let data;

    try {
      data = JSON.parse(event.data);
    } catch (error) {
      console.error("Invalid response:", event.data);
      return;
    }

    console.log("DERIV:", data);

    if (data.error) {
      console.error("DERIV ERROR:", data.error);
      return;
    }

    if (data.msg_type === "active_symbols") {
      loadMarkets(data.active_symbols || []);
      return;
    }

    if (data.msg_type === "tick") {
      handleTick(data);
      return;
    }

    if (data.msg_type === "history") {
      handleHistory(data);
      return;
    }

    if (data.msg_type === "candles") {
      handleHistory(data);
      return;
    }
  };

  socket.onerror = function (error) {
    console.error("DERIV WEBSOCKET ERROR:", error);
    setStatus("DERIV CONNECTION ERROR");
  };

  socket.onclose = function () {
    console.warn("DERIV CONNECTION CLOSED");

    setStatus("Disconnected • Reconnecting...");

    reconnect();
  };
}


/* =========================
   ACTIVE MARKETS
========================= */

function requestActiveMarkets() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    active_symbols: "brief",
    req_id: 1
  }));
}

function loadMarkets(symbols) {
  activeMarkets = symbols
    .map(function (item) {
      return {
        symbol:
          item.underlying_symbol ||
          item.symbol,

        name:
          item.underlying_symbol_name ||
          item.display_name ||
          item.underlying_symbol ||
          item.symbol,

        type:
          item.underlying_symbol_type ||
          item.symbol_type ||
          "",

        market:
          item.market || "",

        subgroup:
          item.subgroup || "",

        submarket:
          item.submarket || "",

        suspended:
          item.is_trading_suspended === 1
      };
    })
    .filter(function (item) {
      return item.symbol && !item.suspended;
    });

  console.log(
    "Loaded Deriv markets:",
    activeMarkets.length
  );

  populateMarkets();

  const preferred = findPreferredMarket();

  if (preferred) {
    selectMarket(preferred.symbol);
  } else if (activeMarkets.length) {
    selectMarket(activeMarkets[0].symbol);
  }
}

function populateMarkets() {
  if (!marketSelect) return;

  marketSelect.innerHTML = "";

  const groups = {
    forex: document.createElement("optgroup"),
    indices: document.createElement("optgroup"),
    metals: document.createElement("optgroup"),
    crypto: document.createElement("optgroup"),
    synthetic: document.createElement("optgroup"),
    other: document.createElement("optgroup")
  };

  groups.forex.label = "FOREX";
  groups.indices.label = "GLOBAL INDICES";
  groups.metals.label = "METALS / COMMODITIES";
  groups.crypto.label = "CRYPTO";
  groups.synthetic.label = "DERIV SYNTHETIC INDICES";
  groups.other.label = "OTHER MARKETS";

  activeMarkets.forEach(function (market) {
    const option =
      document.createElement("option");

    option.value = market.symbol;

    option.textContent =
      market.name +
      " [" +
      market.symbol +
      "]";

    groups[getCategory(market)]
      .appendChild(option);
  });

  Object.keys(groups).forEach(function (key) {
    if (groups[key].children.length) {
      marketSelect.appendChild(groups[key]);
    }
  });
}

function getCategory(market) {
  const text = (
    market.name +
    " " +
    market.type +
    " " +
    market.market +
    " " +
    market.subgroup +
    " " +
    market.submarket
  ).toLowerCase();

  if (
    text.includes("volatility") ||
    text.includes("step index") ||
    text.includes("jump index") ||
    text.includes("boom") ||
    text.includes("crash") ||
    text.includes("range break") ||
    text.includes("high frequency")
  ) {
    return "synthetic";
  }

  if (
    text.includes("forex")
  ) {
    return "forex";
  }

  if (
    text.includes("gold") ||
    text.includes("silver") ||
    text.includes("platinum") ||
    text.includes("palladium") ||
    text.includes("metal") ||
    text.includes("commodity")
  ) {
    return "metals";
  }

  if (
    text.includes("crypto") ||
    text.includes("bitcoin") ||
    text.includes("ethereum") ||
    text.includes("litecoin") ||
    text.includes("dogecoin") ||
    text.includes("ripple") ||
    text.includes("solana")
  ) {
    return "crypto";
  }

  if (
    text.includes("index") ||
    text.includes("nasdaq") ||
    text.includes("dow") ||
    text.includes("s&p") ||
    text.includes("wall street")
  ) {
    return "indices";
  }

  return "other";
}

function findPreferredMarket() {
  const preferredNames = [
    "volatility 10",
    "volatility 15",
    "volatility 25",
    "volatility 50",
    "step index",
    "eur/usd"
  ];

  for (let name of preferredNames) {
    const found = activeMarkets.find(function (market) {
      return market.name
        .toLowerCase()
        .includes(name);
    });

    if (found) return found;
  }

  return null;
}


/* =========================
   MARKET SELECTION
========================= */

if (marketSelect) {
  marketSelect.addEventListener(
    "change",
    function () {
      selectMarket(this.value);
    }
  );
}

function selectMarket(symbol) {
  if (!symbol) return;

  selectedSymbol = symbol;

  const market =
    activeMarkets.find(function (item) {
      return item.symbol === symbol;
    });

  if (market) {
    showSelectedMarket(market);
  }

  subscribeToTicks(symbol);

  requestHistoricalCandles(symbol);
}

function showSelectedMarket(market) {
  if (selectedMarketElement) {
    selectedMarketElement.textContent =
      market.name;
  }
}


/* =========================
   LIVE TICKS
========================= */

function subscribeToTicks(symbol) {
  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  socket.send(JSON.stringify({
    forget_all: "ticks",
    req_id: 2
  }));

  socket.send(JSON.stringify({
    ticks: symbol,
    subscribe: 1,
    req_id: 3
  }));

  setStatus("LIVE • " + symbol);
}

function handleTick(data) {
  if (!data.tick) return;

  const price =
    Number(data.tick.quote);

  const epoch =
    Number(data.tick.epoch) ||
    Math.floor(Date.now() / 1000);

  if (!Number.isFinite(price)) return;

  updateLivePrice(price);

  currentTicks.push({
    time: epoch,
    price: price
  });

  if (currentTicks.length > 1000) {
    currentTicks.shift();
  }

  updateLiveCandle(price, epoch);

  const now = Date.now();

  if (now - lastAnalysisTime > 5000) {
    lastAnalysisTime = now;
    analyzeMarket();
  }
}

function updateLivePrice(price) {
  if (!priceElement) return;

  priceElement.textContent =
    formatPrice(price);
}

function formatPrice(price) {
  if (price >= 1000) {
    return price.toLocaleString(
      undefined,
      {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }
    );
  }

  if (price >= 100) {
    return price.toFixed(2);
  }

  if (price >= 10) {
    return price.toFixed(3);
  }

  if (price >= 1) {
    return price.toFixed(5);
  }

  return price.toFixed(8);
}


/* =========================
   HISTORICAL CANDLES
========================= */

function requestHistoricalCandles(symbol) {
  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  console.log(
    "Requesting historical candles:",
    symbol
  );

  socket.send(JSON.stringify({
    ticks_history: symbol,
    style: "candles",
    granularity: 60,
    count: 500,
    end: "latest",
    req_id: 10
  }));
}

function handleHistory(data) {
  if (!data) return;

  const source =
    data.candles ||
    data.history?.candles;

  if (!Array.isArray(source)) {
    console.warn(
      "No candle data returned."
    );
    return;
  }

  const parsed =
    source
      .map(function (candle) {
        return {
          time: Number(candle.epoch),
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close)
        };
      })
      .filter(function (candle) {
        return (
          Number.isFinite(candle.open) &&
          Number.isFinite(candle.high) &&
          Number.isFinite(candle.low) &&
          Number.isFinite(candle.close)
        );
      });

  if (!parsed.length) return;

  candles.M1 = parsed;

  buildAllTimeframes();

  console.log(
    "M1 candles loaded:",
    candles.M1.length
  );

  analyzeMarket();
}


/* =========================
   BUILD TIMEFRAMES
========================= */

function buildAllTimeframes() {
  candles.M5 =
    aggregateCandles(
      candles.M1,
      5
    );

  candles.M15 =
    aggregateCandles(
      candles.M1,
      15
    );

  candles.M30 =
    aggregateCandles(
      candles.M1,
      30
    );

  candles.H1 =
    aggregateCandles(
      candles.M1,
      60
    );

  candles.H2 =
    aggregateCandles(
      candles.M1,
      120
    );

  candles.H4 =
    aggregateCandles(
      candles.M1,
      240
    );

  candles.Daily =
    aggregateCandles(
      candles.M1,
      1440
    );
}

function aggregateCandles(
  source,
  minutes
) {
  if (!source.length) return [];

  const result = [];
  const interval =
    minutes * 60;

  let current = null;

  source.forEach(function (candle) {
    const bucket =
      Math.floor(
        candle.time / interval
      ) * interval;

    if (
      !current ||
      current.time !== bucket
    ) {
      current = {
        time: bucket,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      };

      result.push(current);
    } else {
      current.high =
        Math.max(
          current.high,
          candle.high
        );

      current.low =
        Math.min(
          current.low,
          candle.low
        );

      current.close =
        candle.close;
    }
  });

  return result;
}


/* =========================
   LIVE CANDLE UPDATE
========================= */

function updateLiveCandle(
  price,
  epoch
) {
  if (!candles.M1.length) return;

  const minute =
    Math.floor(epoch / 60) * 60;

  let last =
    candles.M1[
      candles.M1.length - 1
    ];

  if (last.time === minute) {
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

    last.close = price;
  } else {
    candles.M1.push({
      time: minute,
      open: price,
      high: price,
      low: price,
      close: price
    });

    if (candles.M1.length > 1000) {
      candles.M1.shift();
    }
  }

  buildAllTimeframes();
}


/* =========================
   SWING DETECTION
========================= */

function findSwingPoints(data) {
  const swings = [];

  if (data.length < 5) {
    return swings;
  }

  for (
    let i = 2;
    i < data.length - 2;
    i++
  ) {
    const c = data[i];

    const isHigh =
      c.high > data[i - 1].high &&
      c.high > data[i - 2].high &&
      c.high >= data[i + 1].high &&
      c.high >= data[i + 2].high;

    const isLow =
      c.low < data[i - 1].low &&
      c.low < data[i - 2].low &&
      c.low <= data[i + 1].low &&
      c.low <= data[i + 2].low;

    if (isHigh) {
      swings.push({
        type: "HIGH",
        price: c.high,
        time: c.time,
        index: i
      });
    }

    if (isLow) {
      swings.push({
        type: "LOW",
        price: c.low,
        time: c.time,
        index: i
      });
    }
  }

  return swings;
}


/* =========================
   1H STRUCTURE
========================= */

function analyze1HStructure() {
  const h1 = candles.H1;

  if (h1.length < 10) {
    return {
      direction: "UNKNOWN",
      text: "Waiting for 1H structure"
    };
  }

  const swings =
    findSwingPoints(h1);

  const highs =
    swings.filter(
      s => s.type === "HIGH"
    );

  const lows =
    swings.filter(
      s => s.type === "LOW"
    );

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {
    return {
      direction: "UNKNOWN",
      text: "1H swing confirmation pending"
    };
  }

  const h1a =
    highs[highs.length - 2];

  const h1b =
    highs[highs.length - 1];

  const l1a =
    lows[lows.length - 2];

  const l1b =
    lows[lows.length - 1];

  if (
    h1b.price > h1a.price &&
    l1b.price > l1a.price
  ) {
    return {
      direction: "BULLISH",
      text:
        "1H structure: Higher High + Higher Low"
    };
  }

  if (
    h1b.price < h1a.price &&
    l1b.price < l1a.price
  ) {
    return {
      direction: "BEARISH",
      text:
        "1H structure: Lower High + Lower Low"
    };
  }

  return {
    direction: "RANGE",
    text:
      "1H structure: Range / mixed swings"
  };
}


/* =========================
   SUPPORT & RESISTANCE
========================= */

function findSupportResistance(data) {
  if (data.length < 5) {
    return {
      support: null,
      resistance: null
    };
  }

  const swings =
    findSwingPoints(data);

  const highs =
    swings.filter(
      s => s.type === "HIGH"
    );

  const lows =
    swings.filter(
      s => s.type === "LOW"
    );

  return {
    support:
      lows.length
        ? lows[lows.length - 1].price
        : null,

    resistance:
      highs.length
        ? highs[highs.length - 1].price
        : null
  };
}


/* =========================
   CANDLE CONFIRMATION
========================= */

function candleConfirmation(data) {
  if (data.length < 3) {
    return {
      direction: "NONE",
      pattern: "Waiting",
      strength: 0
    };
  }

  const c =
    data[data.length - 2];

  const previous =
    data[data.length - 3];

  const body =
    Math.abs(c.close - c.open);

  const range =
    c.high - c.low;

  if (range <= 0) {
    return {
      direction: "NONE",
      pattern: "Neutral",
      strength: 0
    };
  }

  const upperWick =
    c.high -
    Math.max(c.open, c.close);

  const lowerWick =
    Math.min(c.open, c.close) -
    c.low;

  const bullish =
    c.close > c.open;

  const bearish =
    c.close < c.open;

  const strongBull =
    bullish &&
    body / range >= 0.60 &&
    c.close > previous.high;

  const strongBear =
    bearish &&
    body / range >= 0.60 &&
    c.close < previous.low;

  const bullishPin =
    lowerWick > body * 2 &&
    c.close > c.open;

  const bearishPin =
    upperWick > body * 2 &&
    c.close < c.open;

  if (strongBull) {
    return {
      direction: "BUY",
      pattern: "Bullish Displacement",
      strength: 3
    };
  }

  if (strongBear) {
    return {
      direction: "SELL",
      pattern: "Bearish Displacement",
      strength: 3
    };
  }

  if (bullishPin) {
    return {
      direction: "BUY",
      pattern: "Bullish Rejection",
      strength: 2
    };
  }

  if (bearishPin) {
    return {
      direction: "SELL",
      pattern: "Bearish Rejection",
      strength: 2
    };
  }

  return {
    direction: "NONE",
    pattern: "No candle confirmation",
    strength: 0
  };
}


/* =========================
   A / B / C SETUP ENGINE
========================= */

function generateSetup() {
  const tf =
    timeframeSelect
      ? timeframeSelect.value
      : "M15";

  const data =
    candles[tf] || candles.M15;

  if (data.length < 10) {
    return {
      setup: "C",
      direction: "NONE",
      confidence: 0,
      reason:
        "Not enough candle data"
    };
  }

  const structure =
    analyze1HStructure();

  const sr =
    findSupportResistance(data);

  const candle =
    candleConfirmation(data);

  const price =
    data[data.length - 1].close;

  let score = 0;

  let direction = "NONE";

  if (
    structure.direction ===
    candle.direction
  ) {
    score += 4;
    direction =
      structure.direction === "BULLISH"
        ? "BUY"
        : "SELL";
  }

  if (
    candle.strength >= 2
  ) {
    score += 2;
  }

  if (
    direction === "BUY" &&
    sr.support !== null &&
    price >= sr.support
  ) {
    score += 2;
  }

  if (
    direction === "SELL" &&
    sr.resistance !== null &&
    price <= sr.resistance
  ) {
    score += 2;
  }

  let setup = "C";

  if (score >= 8) {
    setup = "A";
  } else if (score >= 5) {
    setup = "B";
  }

  if (
    direction === "NONE" ||
    structure.direction === "RANGE" ||
    structure.direction === "UNKNOWN"
  ) {
    setup = "C";
  }

  return {
    setup,
    direction,
    confidence: Math.min(
      95,
      score * 10
    ),
    structure,
    candle,
    support: sr.support,
    resistance: sr.resistance,
    price
  };
}


/* =========================
   TRADE LEVELS
========================= */

function calculateTradeLevels(result) {
  if (
    result.direction === "NONE" ||
    result.setup === "C"
  ) {
    return null;
  }

  const entry =
    result.price;

  const support =
    result.support;

  const resistance =
    result.resistance;

  let sl;
  let tp1;
  let tp2;

  if (
    result.direction === "BUY"
  ) {
    sl =
      support !== null &&
      support < entry
        ? support
        : entry * 0.998;

    const risk =
      entry - sl;

    tp1 =
      entry + risk * 2;

    tp2 =
      entry + risk * 3;
  } else {
    sl =
      resistance !== null &&
      resistance > entry
        ? resistance
        : entry * 1.002;

    const risk =
      sl - entry;

    tp1 =
      entry - risk * 2;

    tp2 =
      entry - risk * 3;
  }

  return {
    entry,
    sl,
    tp1,
    tp2,
    rr1: "1:2",
    rr2: "1:3"
  };
}


/* =========================
   UPDATE DASHBOARD
========================= */

function updateDashboard(
  result,
  levels
) {
  const signal =
    document.getElementById(
      "signal"
    );

  const direction =
    document.getElementById(
      "direction"
    );

  const setup =
    document.getElementById(
      "setup"
    );

  const confidence =
    document.getElementById(
      "confidence"
    );

  const rr =
    document.getElementById(
      "rr"
    );

  const explanation =
    document.getElementById(
      "explanationText"
    );

  const swing =
    document.getElementById(
      "swing"
    );

  const structure =
    document.getElementById(
      "structure"
    );

  const liquidity =
    document.getElementById(
      "liquidity"
    );

  const sr =
    document.getElementById(
      "sr"
    );

  const pattern =
    document.getElementById(
      "pattern"
    );

  const rejection =
    document.getElementById(
      "rejection"
    );

  const momentum =
    document.getElementById(
      "momentum"
    );

  const confirmation =
    document.getElementById(
      "confirmation"
    );

  if (result.setup === "C") {
    if (signal)
      signal.textContent =
        "NO SETUP";

    if (direction)
      direction.textContent =
        "WAIT";

    if (setup)
      setup.textContent =
        "C / HIGH RISK";

    if (confidence)
      confidence.textContent =
        result.confidence + "%";

    if (rr)
      rr.textContent =
        "—";

    if (explanation) {
      explanation.textContent =
        "No A/B-quality setup is currently confirmed. " +
        "The engine is waiting for valid 1H structure, " +
        "support/resistance and candle confirmation.";
    }

    return;
  }

  if (signal) {
    signal.textContent =
      result.direction;
  }

  if (direction) {
    direction.textContent =
      result.direction;
  }

  if (setup) {
    setup.textContent =
      result.setup + " SETUP";
  }

  if (confidence) {
    confidence.textContent =
      result.confidence + "%";
  }

  if (rr) {
    rr.textContent =
      "1:2 / 1:3";
  }

  if (levels) {
    const entry =
      document.getElementById("entry");

    const sl =
      document.getElementById("sl");

    const tp1 =
      document.getElementById("tp1");

    const tp2 =
      document.getElementById("tp2");

    if (entry)
      entry.textContent =
        formatPrice(levels.entry);

    if (sl)
      sl.textContent =
        formatPrice(levels.sl);

    if (tp1)
      tp1.textContent =
        formatPrice(levels.tp1);

    if (tp2)
      tp2.textContent =
        formatPrice(levels.tp2);
  }

  if (swing)
    swing.textContent =
      "1H swing confirmed";

  if (structure)
    structure.textContent =
      result.structure.text;

  if (liquidity)
    liquidity.textContent =
      "Swing liquidity monitored";

  if (sr)
    sr.textContent =
      "S: " +
      formatOptional(result.support) +
      " / R: " +
      formatOptional(result.resistance);

  if (pattern)
    pattern.textContent =
      result.candle.pattern;

  if (rejection)
    rejection.textContent =
      result.candle.strength >= 2
        ? "Confirmed"
        : "Waiting";

  if (momentum)
    momentum.textContent =
      result.candle.strength === 3
        ? "Strong"
        : result.candle.strength === 2
        ? "Moderate"
        : "Weak";

  if (confirmation)
    confirmation.textContent =
      "Confirmed";

  if (explanation) {
    explanation.textContent =
      result.direction +
      " setup detected from " +
      result.setup +
      "-grade conditions. " +
      result.structure.text +
      ". Candle confirmation: " +
      result.candle.pattern +
      ".";
  }
}

function formatOptional(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return "—";
  }

  return formatPrice(value);
}


/* =========================
   MAIN ANALYSIS
========================= */

function analyzeMarket() {
  if (!selectedSymbol) {
    return;
  }

  const result =
    generateSetup();

  const levels =
    calculateTradeLevels(result);

  updateDashboard(
    result,
    levels
  );

  console.log(
    "ANALYSIS RESULT:",
    result
  );

  if (levels) {
    console.log(
      "TRADE LEVELS:",
      levels
    );
  }
}


/* =========================
   TIMEFRAME
========================= */

if (timeframeSelect) {
  timeframeSelect.addEventListener(
    "change",
    function () {
      if (selectedTimeframeElement) {
        selectedTimeframeElement.textContent =
          this.value;
      }

      analyzeMarket();
    }
  );
}


/* =========================
   ANALYZE BUTTON
========================= */

if (analyzeButton) {
  analyzeButton.addEventListener(
    "click",
    function () {
      analyzeMarket();
    }
  );
}


/* =========================
   RECONNECT
========================= */

function reconnect() {
  clearTimeout(reconnectTimer);

  reconnectTimer =
    setTimeout(function () {
      connectDeriv();
    }, reconnectDelay);

  reconnectDelay =
    Math.min(
      reconnectDelay * 1.5,
      30000
    );
}


/* =========================
   START
========================= */

console.log(
  "SUCCESSFUL PINE SCRIPT STARTING..."
);

connectDeriv();
