/* =========================================================
   SUCCESSFUL PINE SCRIPT
   PROGRESSIVE LIVE SIGNAL ENGINE
   Deriv Public Market Data
   ========================================================= */

const DERIV_WS =
  "wss://api.derivws.com/trading/v1/options/ws/public";

let ws = null;
let selectedSymbol = "";
let selectedTimeframe = "M5";
let selectedPrice = 0;

let candles = [];
let candleCache = {};

let currentSignal = null;
let lastAlertKey = "";

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
  if (el) el.textContent = value;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundPrice(price) {
  if (!Number.isFinite(price)) return "-";

  if (price >= 1000) return price.toFixed(2);
  if (price >= 100) return price.toFixed(3);
  if (price >= 10) return price.toFixed(4);
  if (price >= 1) return price.toFixed(5);

  return price.toFixed(5);
}

/* =========================================================
   CONNECTION
   ========================================================= */

function updateConnection(text, live = false) {
  setText("connectionText", text);

  const dot = document.querySelector(".status-dot");

  if (dot) {
    dot.style.opacity = live ? "1" : "0.5";
  }
}

function connectDeriv() {
  updateConnection("Connecting to Deriv...", false);

  try {
    ws = new WebSocket(DERIV_WS);

    ws.onopen = () => {
      updateConnection("LIVE", true);
      loadMarkets();
    };

    ws.onmessage = handleMessage;

    ws.onerror = () => {
      updateConnection("Connection error", false);
    };

    ws.onclose = () => {
      updateConnection("Reconnecting...", false);

      setTimeout(() => {
        connectDeriv();
      }, 3000);
    };
  } catch (error) {
    console.error(error);
    updateConnection("Connection failed", false);
  }
}

/* =========================================================
   DERIV MESSAGE HANDLER
   ========================================================= */

function handleMessage(event) {
  let data;

  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }

  if (data.error) {
    console.error("Deriv error:", data.error);
    return;
  }

  if (data.msg_type === "active_symbols") {
    populateMarkets(data.active_symbols || []);
    return;
  }

  if (data.msg_type === "tick") {
    handleTick(data);
    return;
  }

  if (data.msg_type === "candles") {
    handleHistoricalCandles(data);
    return;
  }
}

/* =========================================================
   MARKET LOADING
   ========================================================= */

function loadMarkets() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(
    JSON.stringify({
      active_symbols: "full"
    })
  );
}

function populateMarkets(symbols) {
  const market = $("market");

  if (!market) return;

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

    if (!symbol) return;

    let group = "Other";

    if (
      type.includes("synthetic") ||
      /volatility|step|jump|boom|crash|range break/i.test(name)
    ) {
      group = "Deriv Synthetic Indices";
    } else if (
      type.includes("forex") ||
      /^[A-Z]{6}$/.test(symbol)
    ) {
      group = "Forex";
    } else if (
      type.includes("indices") ||
      type.includes("index") ||
      /nasdaq|dow|dax|s&p|spx|ftse|nikkei/i.test(name)
    ) {
      group = "Global Indices";
    } else if (
      type.includes("metal") ||
      /gold|silver|platinum|palladium/i.test(name)
    ) {
      group = "Metals";
    } else if (
      type.includes("commodity") ||
      /oil|gas|brent|crude/i.test(name)
    ) {
      group = "Commodities";
    } else if (
      type.includes("crypto") ||
      /bitcoin|ethereum|litecoin|crypto/i.test(name)
    ) {
      group = "Crypto";
    }

    groups[group].push({
      symbol,
      name
    });
  });

  Object.entries(groups).forEach(([groupName, items]) => {
    if (!items.length) return;

    const optgroup = document.createElement("optgroup");
    optgroup.label = groupName;

    items
      .sort((a, b) =>
        a.name.localeCompare(b.name)
      )
      .forEach(item => {
        const option =
          document.createElement("option");

        option.value = item.symbol;
        option.textContent =
          `${item.name} (${item.symbol})`;

        optgroup.appendChild(option);
      });

    market.appendChild(optgroup);
  });

  if (market.options.length > 0) {
    const firstOption =
      market.querySelector("option:not([disabled])");

    if (firstOption) {
      selectedSymbol = firstOption.value;
      market.value = selectedSymbol;

      subscribeToMarket(selectedSymbol);
    }
  }
}

/* =========================================================
   MARKET SELECTION
   ========================================================= */

const marketElement = $("market");

if (marketElement) {
  marketElement.addEventListener("change", () => {
    selectedSymbol = marketElement.value;

    candleCache = {};
    candles = [];
    currentSignal = null;
    lastAlertKey = "";

    setText("signal", "ANALYZING");
    setText("direction", "Waiting...");
    setText("setup", "Waiting for market structure...");
    setText("confidence", "-");
    setText("rr", "-");

    subscribeToMarket(selectedSymbol);
  });
}

function subscribeToMarket(symbol) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!symbol) return;

  try {
    ws.send(
      JSON.stringify({
        forget_all: "ticks"
      })
    );
  } catch {}

  ws.send(
    JSON.stringify({
      ticks: symbol,
      subscribe: 1
    })
  );

  requestHistoricalData(symbol);
}

/* =========================================================
   HISTORICAL DATA
   ========================================================= */

function requestHistoricalData(symbol) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(
    JSON.stringify({
      ticks_history: symbol,
      style: "candles",
      granularity: 60,
      count: 1000,
      end: "latest"
    })
  );
}

function handleHistoricalCandles(data) {
  if (!data.candles) return;

  candles = data.candles.map(c => ({
    time: Number(c.epoch),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));

  analyzeProgressively();
}

/* =========================================================
   LIVE TICKS
   ========================================================= */

function handleTick(data) {
  if (!data.tick) return;

  const tick = data.tick;

  selectedPrice = safeNumber(tick.quote);

  setText(
    "livePrice",
    roundPrice(selectedPrice)
  );

  setText(
    "marketName",
    selectedSymbol || tick.symbol || "Market"
  );

  updateCurrentMinuteCandle(
    selectedPrice,
    safeNumber(tick.epoch)
  );
}

function updateCurrentMinuteCandle(price, epoch) {
  const minute =
    Math.floor(epoch / 60) * 60;

  let last =
    candles[candles.length - 1];

  if (!last || last.time !== minute) {
    last = {
      time: minute,
      open: price,
      high: price,
      low: price,
      close: price
    };

    candles.push(last);

    if (candles.length > 1200) {
      candles.shift();
    }
  } else {
    last.high =
      Math.max(last.high, price);

    last.low =
      Math.min(last.low, price);

    last.close = price;
  }

  analyzeProgressively();
}

/* =========================================================
   TIMEFRAME AGGREGATION
   ========================================================= */

function aggregateCandles(source, minutes) {
  if (minutes === 1) return [...source];

  const result = [];
  const bucketSize = minutes * 60;

  for (const c of source) {
    const bucket =
      Math.floor(c.time / bucketSize) *
      bucketSize;

    let current =
      result[result.length - 1];

    if (!current || current.time !== bucket) {
      current = {
        time: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      };

      result.push(current);
    } else {
      current.high =
        Math.max(current.high, c.high);

      current.low =
        Math.min(current.low, c.low);

      current.close = c.close;
    }
  }

  return result;
}

/* =========================================================
   SWING DETECTION
   ========================================================= */

function detectSwings(data, left = 2, right = 2) {
  const highs = [];
  const lows = [];

  for (
    let i = left;
    i < data.length - right;
    i++
  ) {
    let high = true;
    let low = true;

    for (let j = 1; j <= left; j++) {
      if (data[i].high <= data[i - j].high)
        high = false;

      if (data[i].low >= data[i - j].low)
        low = false;
    }

    for (let j = 1; j <= right; j++) {
      if (data[i].high <= data[i + j].high)
        high = false;

      if (data[i].low >= data[i + j].low)
        low = false;
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

  return { highs, lows };
}

/* =========================================================
   1H STRUCTURE
   ========================================================= */

function get1HStructure() {
  const h1 =
    aggregateCandles(candles, 60);

  if (h1.length < 20) {
    return {
      direction: "NONE",
      pivot: null,
      previousPivot: null,
      highs: [],
      lows: []
    };
  }

  const swings =
    detectSwings(h1, 2, 2);

  const recentHighs =
    swings.highs.slice(-4);

  const recentLows =
    swings.lows.slice(-4);

  if (
    recentHighs.length < 2 ||
    recentLows.length < 2
  ) {
    return {
      direction: "NONE",
      pivot: null,
      previousPivot: null,
      highs: recentHighs,
      lows: recentLows
    };
  }

  const lastHigh =
    recentHighs[recentHighs.length - 1];

  const previousHigh =
    recentHighs[recentHighs.length - 2];

  const lastLow =
    recentLows[recentLows.length - 1];

  const previousLow =
    recentLows[recentLows.length - 2];

  let direction = "NONE";

  if (
    lastHigh.price > previousHigh.price &&
    lastLow.price > previousLow.price
  ) {
    direction = "BULLISH";
  }

  if (
    lastHigh.price < previousHigh.price &&
    lastLow.price < previousLow.price
  ) {
    direction = "BEARISH";
  }

  let pivot = null;

  if (direction === "BULLISH") {
    pivot = lastLow;
  }

  if (direction === "BEARISH") {
    pivot = lastHigh;
  }

  return {
    direction,
    pivot,
    previousPivot:
      direction === "BULLISH"
        ? previousLow
        : previousHigh,
    highs: recentHighs,
    lows: recentLows
  };
}

/* =========================================================
   LIQUIDITY SWEEP
   ========================================================= */

function detectLiquiditySweep(data, direction) {
  if (data.length < 8) {
    return null;
  }

  const recent =
    data.slice(-8, -1);

  const current =
    data[data.length - 1];

  const highest =
    Math.max(...recent.map(c => c.high));

  const lowest =
    Math.min(...recent.map(c => c.low));

  if (direction === "BULLISH") {
    if (
      current.low < lowest &&
      current.close > lowest
    ) {
      return {
        type: "SELL-SIDE LIQUIDITY SWEEP",
        price: current.low,
        time: current.time
      };
    }
  }

  if (direction === "BEARISH") {
    if (
      current.high > highest &&
      current.close < highest
    ) {
      return {
        type: "BUY-SIDE LIQUIDITY SWEEP",
        price: current.high,
        time: current.time
      };
    }
  }

  return null;
}

/* =========================================================
   BOS / CHOCH
   ========================================================= */

function detectStructureBreak(data, direction) {
  if (data.length < 10) {
    return null;
  }

  const swings =
    detectSwings(data, 2, 2);

  if (
    swings.highs.length < 2 ||
    swings.lows.length < 2
  ) {
    return null;
  }

  const last =
    data[data.length - 1];

  const previousHigh =
    swings.highs[swings.highs.length - 2];

  const previousLow =
    swings.lows[swings.lows.length - 2];

  if (direction === "BULLISH") {
    if (last.close > previousHigh.price) {
      return {
        type: "BOS",
        direction: "BULLISH",
        price: last.close,
        time: last.time
      };
    }
  }

  if (direction === "BEARISH") {
    if (last.close < previousLow.price) {
      return {
        type: "BOS",
        direction: "BEARISH",
        price: last.close,
        time: last.time
      };
    }
  }

  return null;
}

/* =========================================================
   DISPLACEMENT
   ========================================================= */

function detectDisplacement(data, direction) {
  if (data.length < 5) return false;

  const last =
    data[data.length - 1];

  const previous =
    data[data.length - 2];

  const range =
    last.high - last.low;

  const previousRange =
    previous.high - previous.low;

  if (previousRange <= 0) return false;

  const strong =
    range >= previousRange * 1.25;

  if (!strong) return false;

  if (
    direction === "BULLISH" &&
    last.close > last.open
  ) {
    return true;
  }

  if (
    direction === "BEARISH" &&
    last.close < last.open
  ) {
    return true;
  }

  return false;
}

/* =========================================================
   FVG
   ========================================================= */

function detectFVG(data, direction) {
  if (data.length < 3) return null;

  const a =
    data[data.length - 3];

  const b =
    data[data.length - 2];

  const c =
    data[data.length - 1];

  if (
    direction === "BULLISH" &&
    c.low > a.high
  ) {
    return {
      type: "BULLISH FVG",
      low: a.high,
      high: c.low,
      midpoint:
        (a.high + c.low) / 2
    };
  }

  if (
    direction === "BEARISH" &&
    c.high < a.low
  ) {
    return {
      type: "BEARISH FVG",
      low: c.high,
      high: a.low,
      midpoint:
        (c.high + a.low) / 2
    };
  }

  return null;
}

/* =========================================================
   SUPPLY / DEMAND
   ========================================================= */

function detectSupplyDemand(data, direction) {
  if (data.length < 5) return null;

  const last =
    data[data.length - 1];

  const previous =
    data[data.length - 2];

  if (
    direction === "BULLISH" &&
    previous.close < previous.open &&
    last.close > previous.high
  ) {
    return {
      type: "DEMAND",
      high: previous.high,
      low: previous.low
    };
  }

  if (
    direction === "BEARISH" &&
    previous.close > previous.open &&
    last.close < previous.low
  ) {
    return {
      type: "SUPPLY",
      high: previous.high,
      low: previous.low
    };
  }

  return null;
}

/* =========================================================
   CANDLE CONFIRMATION
   ========================================================= */

function candleConfirmation(data, direction) {
  if (!data.length) return null;

  const c =
    data[data.length - 1];

  const range =
    c.high - c.low;

  if (range <= 0) return null;

  const body =
    Math.abs(c.close - c.open);

  const upperWick =
    c.high - Math.max(c.open, c.close);

  const lowerWick =
    Math.min(c.open, c.close) - c.low;

  if (direction === "BULLISH") {
    if (
      lowerWick > body * 1.2 &&
      c.close > c.open
    ) {
      return "Bullish rejection";
    }

    if (
      body / range > 0.65 &&
      c.close > c.open
    ) {
      return "Bullish momentum candle";
    }
  }

  if (direction === "BEARISH") {
    if (
      upperWick > body * 1.2 &&
      c.close < c.open
    ) {
      return "Bearish rejection";
    }

    if (
      body / range > 0.65 &&
      c.close < c.open
    ) {
      return "Bearish momentum candle";
    }
  }

  return null;
}

/* =========================================================
   SUPPORT / RESISTANCE
   ========================================================= */

function detectSR(data) {
  if (data.length < 10) return null;

  const swings =
    detectSwings(data, 2, 2);

  const high =
    swings.highs.at(-1);

  const low =
    swings.lows.at(-1);

  return {
    resistance: high
      ? high.price
      : null,

    support: low
      ? low.price
      : null
  };
}

/* =========================================================
   PROGRESSIVE SETUP ENGINE
   ========================================================= */

function buildProgressiveSignal() {
  if (candles.length < 50) {
    return {
      stage: "NONE",
      direction: "NONE",
      reason: "Waiting for sufficient market data."
    };
  }

  const h1Structure =
    get1HStructure();

  if (
    h1Structure.direction === "NONE" ||
    !h1Structure.pivot
  ) {
    return {
      stage: "NONE",
      direction: "NONE",
      reason:
        "No confirmed 1H swing structure."
    };
  }

  const tfMinutes =
    TIMEFRAMES[selectedTimeframe] || 5;

  const data =
    aggregateCandles(
      candles,
      tfMinutes
    );

  if (data.length < 20) {
    return {
      stage: "NONE",
      direction: "NONE",
      reason:
        "Waiting for enough candles on selected timeframe."
    };
  }

  const direction =
    h1Structure.direction;

  const pivot =
    h1Structure.pivot;

  const current =
    data[data.length - 1];

  const sweep =
    detectLiquiditySweep(
      data,
      direction
    );

  const bos =
    detectStructureBreak(
      data,
      direction
    );

  const displacement =
    detectDisplacement(
      data,
      direction
    );

  const fvg =
    detectFVG(
      data,
      direction
    );

  const zone =
    detectSupplyDemand(
      data,
      direction
    );

  const candle =
    candleConfirmation(
      data,
      direction
    );

  const sr =
    detectSR(data);

  /*
   ---------------------------------------------------------
   PROGRESSIVE LOGIC

   WATCH:
   1H structure exists.

   C:
   Structure + price interaction/rejection/sweep/candle.

   B:
   Stronger structural confirmation.

   A:
   Multiple high-quality confirmations.

   IMPORTANT:
   The engine does NOT wait for A before producing a signal.
   ---------------------------------------------------------
  */

  let stage = "WATCH";

  const confirmations = [];

  if (sweep) {
    confirmations.push("Liquidity sweep");
  }

  if (bos) {
    confirmations.push("BOS");
  }

  if (displacement) {
    confirmations.push("Displacement");
  }

  if (fvg) {
    confirmations.push("FVG");
  }

  if (zone) {
    confirmations.push(zone.type);
  }

  if (candle) {
    confirmations.push(candle);
  }

  /*
   C SETUP
   */
  if (
    sweep ||
    candle ||
    zone
  ) {
    stage = "C";
  }

  /*
   B SETUP
   */
  if (
    (sweep && bos) ||
    (bos && displacement) ||
    (sweep && candle && displacement)
  ) {
    stage = "B";
  }

  /*
   A SETUP
   */
  if (
    sweep &&
    bos &&
    displacement &&
    (fvg || zone) &&
    candle
  ) {
    stage = "A";
  }

  /*
   Invalid / exhausted setup
   */
  const distanceFromPivot =
    Math.abs(
      current.close - pivot.price
    );

  const recentRange =
    Math.max(
      ...data
        .slice(-10)
        .map(c => c.high)
    ) -
    Math.min(
      ...data
        .slice(-10)
        .map(c => c.low)
    );

  if (
    recentRange > 0 &&
    distanceFromPivot >
      recentRange * 5
  ) {
    return {
      stage: "NONE",
      direction,
      reason:
        "Price has moved too far from the structural pivot."
    };
  }

  /*
   HIGH / MEDIUM / LOW QUALITY
   */
  let quality = "LOW";

  if (stage === "B") {
    quality = "MEDIUM";
  }

  if (stage === "A") {
    quality = "HIGH";
  }

  if (stage === "C") {
    quality = "LOW";
  }

  /*
   ENTRY
   */
  let entry = current.close;

  if (fvg) {
    entry = fvg.midpoint;
  } else if (zone) {
    entry =
      (zone.high + zone.low) / 2;
  }

  /*
   STOP LOSS
   */
  let sl;

  if (direction === "BULLISH") {
    sl =
      sweep?.price ??
      zone?.low ??
      pivot.price;

    sl -= recentRange * 0.05;
  } else {
    sl =
      sweep?.price ??
      zone?.high ??
      pivot.price;

    sl += recentRange * 0.05;
  }

  /*
   TARGETS
   */
  const risk =
    Math.abs(entry - sl);

  if (risk <= 0) {
    return {
      stage: "NONE",
      direction,
      reason:
        "Risk calculation invalid."
    };
  }

  let tp1;
  let tp2;

  if (direction === "BULLISH") {
    tp1 = entry + risk * 2;
    tp2 = entry + risk * 3;
  } else {
    tp1 = entry - risk * 2;
    tp2 = entry - risk * 3;
  }

  return {
    stage,
    quality,
    direction,
    pivot,
    entry,
    sl,
    tp1,
    tp2,
    rr: 3,
    sweep,
    bos,
    displacement,
    fvg,
    zone,
    candle,
    sr,
    confirmations,
    reason:
      confirmations.length
        ? confirmations.join(" + ")
        : "1H structural opportunity detected."
  };
}

/* =========================================================
   MAIN ANALYSIS
   ========================================================= */

function analyzeProgressively() {
  if (!selectedSymbol) return;

  const result =
    buildProgressiveSignal();

  currentSignal = result;

  updateDashboard(result);
  processAlert(result);
}

/* =========================================================
   DASHBOARD UPDATE
   ========================================================= */

function updateDashboard(result) {
  if (!result || result.stage === "NONE") {
    setText("signal", "NO SETUP");
    setText("direction", result?.direction || "NONE");
    setText(
      "setup",
      result?.reason || "No valid setup."
    );

    setText("confidence", "-");
    setText("rr", "-");

    setText("entry", "-");
    setText("sl", "-");
    setText("tp1", "-");
    setText("tp2", "-");

    setText("swing", "-");
    setText("structure", "-");
    setText("liquidity", "-");
    setText("sr", "-");

    setText("pattern", "-");
    setText("rejection", "-");
    setText("momentum", "-");
    setText("confirmation", "-");

    return;
  }

  const arrow =
    result.direction === "BULLISH"
      ? "BUY"
      : "SELL";

  setText(
    "signal",
    `${arrow} — ${result.stage} SETUP`
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
    result.quality || "EARLY"
  );

  setText(
    "rr",
    `1:${result.rr}`
  );

  setText(
    "entry",
    roundPrice(result.entry)
  );

  setText(
    "sl",
    roundPrice(result.sl)
  );

  setText(
    "tp1",
    roundPrice(result.tp1)
  );

  setText(
    "tp2",
    roundPrice(result.tp2)
  );

  setText(
    "swing",
    result.pivot
      ? roundPrice(result.pivot.price)
      : "-"
  );

  setText(
    "structure",
    result.bos
      ? result.bos.type
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
    result.candle || "Watching"
  );

  setText(
    "rejection",
    result.candle?.includes("rejection")
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
    result.confirmations.length
      ? result.confirmations.join(" → ")
      : "Early setup"
  );

  updateExplanation(result);
}

/* =========================================================
   EXPLANATION
   ========================================================= */

function updateExplanation(result) {
  const box = $("explanationText");

  if (!box) return;

  const direction =
    result.direction === "BULLISH"
      ? "BUY"
      : "SELL";

  let html = `
    <strong>${direction} ${result.stage} SETUP</strong><br><br>
  `;

  html += `
    The signal is progressive. The bot does not wait for every
    confirmation before notifying you.<br><br>
  `;

  html += `
    <strong>1H Structure:</strong>
    ${result.direction}<br>
  `;

  if (result.pivot) {
    html += `
      <strong>Structural Pivot:</strong>
      ${roundPrice(result.pivot.price)}<br>
    `;
  }

  if (result.sweep) {
    html += `
      <strong>Liquidity:</strong>
      ${result.sweep.type}<br>
    `;
  }

  if (result.bos) {
    html += `
      <strong>Structure Break:</strong>
      BOS confirmed<br>
    `;
  }

  if (result.displacement) {
    html += `
      <strong>Displacement:</strong>
      Confirmed<br>
    `;
  }

  if (result.fvg) {
    html += `
      <strong>FVG:</strong>
      ${roundPrice(result.fvg.low)}
      -
      ${roundPrice(result.fvg.high)}<br>
    `;
  }

  if (result.zone) {
    html += `
      <strong>Fresh Zone:</strong>
      ${result.zone.type}<br>
    `;
  }

  if (result.candle) {
    html += `
      <strong>Candle:</strong>
      ${result.candle}<br>
    `;
  }

  html += `<br>`;

  if (result.stage === "WATCH") {
    html += `
      <strong>STATUS:</strong>
      Early opportunity detected. Monitor for C/B/A confirmation.
    `;
  }

  if (result.stage === "C") {
    html += `
      <strong>STATUS:</strong>
      C setup detected. This is an early/high-risk opportunity.
      Further confirmation can upgrade it.
    `;
  }

  if (result.stage === "B") {
    html += `
      <strong>STATUS:</strong>
      B setup confirmed. Structure and additional confirmation
      are now aligned.
    `;
  }

  if (result.stage === "A") {
    html += `
      <strong>STATUS:</strong>
      A setup confirmed. Multiple conditions are aligned.
    `;
  }

  box.innerHTML = html;
}

/* =========================================================
   ALERT ENGINE
   ========================================================= */

function processAlert(result) {
  if (!result) return;

  if (result.stage === "NONE") {
    return;
  }

  /*
   IMPORTANT:
   Alert only when the setup stage changes.

   This prevents:
   C C C C C C
   on every tick.
  */

  const structureTime =
    result.pivot?.time || "none";

  const sweepTime =
    result.sweep?.time || "none";

  const bosTime =
    result.bos?.time || "none";

  const alertKey =
    [
      selectedSymbol,
      result.direction,
      structureTime,
      sweepTime,
      bosTime,
      result.stage
    ].join("|");

  if (alertKey === lastAlertKey) {
    return;
  }

  lastAlertKey = alertKey;

  const title =
    `${selectedSymbol} ${result.direction === "BULLISH" ? "BUY" : "SELL"} ${result.stage} SETUP`;

  const message = `
${result.stage} SETUP detected

Market: ${selectedSymbol}
Direction: ${result.direction === "BULLISH" ? "BUY" : "SELL"}

Entry: ${roundPrice(result.entry)}
SL: ${roundPrice(result.sl)}
TP1: ${roundPrice(result.tp1)}
TP2: ${roundPrice(result.tp2)}

RR: 1:${result.rr}

Reason:
${result.reason}
  `.trim();

  showInAppAlert(title, message);
  sendBrowserNotification(title, message);

  addHistory(
    result,
    title
  );
}

/* =========================================================
   IN-APP ALERT
   ========================================================= */

function showInAppAlert(title, message) {
  console.log(title, message);

  /*
   If your HTML already contains an alert system,
   this will use it where possible.
  */

  const alertBox =
    document.getElementById("alertBox");

  if (alertBox) {
    alertBox.innerHTML = `
      <strong>${title}</strong>
      <br>
      ${message.replace(/\n/g, "<br>")}
    `;

    alertBox.style.display = "block";
  }
}

/* =========================================================
   BROWSER NOTIFICATIONS
   ========================================================= */

function sendBrowserNotification(title, body) {
  if (
    typeof Notification === "undefined"
  ) {
    return;
  }

  if (Notification.permission === "granted") {
    new Notification(title, {
      body,
      tag: `${selectedSymbol}-${title}`
    });

    return;
  }

  /*
   Browsers often require notification permission
   to be requested from a user interaction.
  */

  if (Notification.permission === "default") {
    Notification.requestPermission()
      .then(permission => {
        if (permission === "granted") {
          new Notification(title, {
            body,
            tag: `${selectedSymbol}-${title}`
          });
        }
      })
      .catch(() => {});
  }
}

/* =========================================================
   SIGNAL HISTORY
   ========================================================= */

function addHistory(result, title) {
  const history =
    $("signalHistory");

  if (!history) return;

  const item =
    document.createElement("div");

  item.className =
    "history-item";

  item.innerHTML = `
    <strong>${title}</strong>
    <br>
    Entry: ${roundPrice(result.entry)}
    <br>
    SL: ${roundPrice(result.sl)}
    |
    TP1: ${roundPrice(result.tp1)}
    |
    TP2: ${roundPrice(result.tp2)}
    <br>
    ${result.reason}
  `;

  history.prepend(item);

  while (history.children.length > 30) {
    history.removeChild(
      history.lastChild
    );
  }
}

/* =========================================================
   TIMEFRAME BUTTONS
   ========================================================= */

document.querySelectorAll(
  "[data-timeframe]"
).forEach(button => {
  button.addEventListener(
    "click",
    () => {
      selectedTimeframe =
        button.dataset.timeframe;

      document.querySelectorAll(
        "[data-timeframe]"
      ).forEach(btn => {
        btn.classList.remove("active");
      });

      button.classList.add("active");

      analyzeProgressively();
    }
  );
});

/* =========================================================
   ANALYZE BUTTON
   ========================================================= */

const analyzeButton =
  document.getElementById("analyze");

if (analyzeButton) {
  analyzeButton.addEventListener(
    "click",
    () => {
      analyzeProgressively();

      /*
       User interaction makes this a good point
       to request notification permission.
      */

      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "default"
      ) {
        Notification.requestPermission()
          .catch(() => {});
      }
    }
  );
}

/* =========================================================
   START ENGINE
   ========================================================= */

connectDeriv();
