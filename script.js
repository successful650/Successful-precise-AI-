/*
  SUCCESSFUL PRECISE AI
  Deriv Live Market Engine - Version 1

  Features:
  - Loads active Deriv symbols automatically
  - Includes Synthetic Indices
  - Includes Volatility and 1-second Volatility
  - Includes Step and Jump indices when active
  - Excludes Boom/Crash by default
  - Streams live prices through WebSocket
*/

const DERIV_WS_URL =
  "wss://ws.binaryws.com/websockets/v3";

let ws = null;
let reconnectTimer = null;
let activeSymbols = [];
let currentSymbol = null;
let currentPrice = null;
let requestId = 1;

/* --------------------------------------------------
   DOM
-------------------------------------------------- */

const marketEl = document.getElementById("market");
const timeframeEl = document.getElementById("timeframe");
const analyzeBtn = document.getElementById("analyzeBtn");

const selectedMarket = document.getElementById("selectedMarket");
const selectedTimeframe = document.getElementById("selectedTimeframe");
const priceEl = document.getElementById("price");

const signalEl = document.getElementById("signal");
const gradeEl = document.getElementById("grade");
const directionEl = document.getElementById("direction");
const setupTypeEl = document.getElementById("setupType");
const confidenceEl = document.getElementById("confidence");
const rrEl = document.getElementById("rr");

const entryEl = document.getElementById("entry");
const slEl = document.getElementById("sl");
const tp1El = document.getElementById("tp1");
const tp2El = document.getElementById("tp2");

const swingEl = document.getElementById("swing");
const structureEl = document.getElementById("structure");
const liquidityEl = document.getElementById("liquidity");
const srEl = document.getElementById("sr");

const candleEl = document.getElementById("candle");
const rejectionEl = document.getElementById("rejection");
const momentumEl = document.getElementById("momentum");
const confirmationEl = document.getElementById("confirmation");

const explanationEl =
  document.getElementById("explanationText");

const historyList =
  document.getElementById("historyList");

const clearHistory =
  document.getElementById("clearHistory");

const connectionText =
  document.getElementById("connectionText");

const statusDot =
  document.querySelector(".status-dot");


/* --------------------------------------------------
   CONNECTION
-------------------------------------------------- */

function setConnectionStatus(connected, text) {

  if (connectionText) {
    connectionText.textContent = text;
  }

  if (statusDot) {
    statusDot.style.background =
      connected ? "#35d07f" : "#ff6577";
  }
}


/* --------------------------------------------------
   CONNECT TO DERIV
-------------------------------------------------- */

function connectDeriv() {

  if (ws &&
      (ws.readyState === WebSocket.OPEN ||
       ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setConnectionStatus(false, "Connecting...");

  ws = new WebSocket(DERIV_WS_URL);

  ws.onopen = () => {

    console.log("Deriv WebSocket connected");

    setConnectionStatus(true, "Deriv Live");

    requestActiveSymbols();
  };

  ws.onmessage = (event) => {

    try {

      const data = JSON.parse(event.data);

      handleDerivMessage(data);

    } catch (error) {

      console.error(
        "Invalid Deriv message:",
        error
      );

    }

  };

  ws.onerror = (error) => {

    console.error(
      "Deriv WebSocket error:",
      error
    );

    setConnectionStatus(
      false,
      "Connection Error"
    );

  };

  ws.onclose = () => {

    console.log(
      "Deriv WebSocket disconnected"
    );

    setConnectionStatus(
      false,
      "Reconnecting..."
    );

    scheduleReconnect();

  };

}


/* --------------------------------------------------
   RECONNECT
-------------------------------------------------- */

function scheduleReconnect() {

  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {

    reconnectTimer = null;

    connectDeriv();

  }, 3000);

}


/* --------------------------------------------------
   ACTIVE SYMBOLS
-------------------------------------------------- */

function requestActiveSymbols() {

  if (!ws ||
      ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify({

    active_symbols: "brief",

    product_type: "basic",

    req_id: requestId++

  }));

}


/* --------------------------------------------------
   HANDLE MESSAGES
-------------------------------------------------- */

function handleDerivMessage(data) {

  if (data.error) {

    console.error(
      "Deriv API error:",
      data.error
    );

    return;
  }

  if (data.msg_type === "active_symbols") {

    processActiveSymbols(
      data.active_symbols || []
    );

    return;
  }

  if (data.msg_type === "tick") {

    processTick(data.tick);

    return;
  }

}


/* --------------------------------------------------
   PROCESS SYMBOLS
-------------------------------------------------- */

function processActiveSymbols(symbols) {

  /*
    Deriv's newer API can use:

    underlying_symbol
    underlying_symbol_name
    underlying_symbol_type

    Older responses can use:

    symbol
    display_name
    symbol_type

    We support both.
  */

  activeSymbols = symbols
    .map(item => {

      return {

        symbol:
          item.underlying_symbol ||
          item.symbol,

        name:
          item.underlying_symbol_name ||
          item.display_name ||
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

        open:
          item.exchange_is_open !== 0,

        suspended:
          item.is_trading_suspended === 1

      };

    })
    .filter(item => item.symbol);

  populateDerivMarkets();

}


/* --------------------------------------------------
   FILTER SYNTHETIC INDICES
-------------------------------------------------- */

function isSynthetic(symbol) {

  const text = (

    symbol.name +
    " " +
    symbol.symbol +
    " " +
    symbol.type +
    " " +
    symbol.subgroup +
    " " +
    symbol.submarket

  ).toLowerCase();

  return (

    text.includes("synthetic") ||

    text.includes("volatility") ||

    text.includes("step index") ||

    text.includes("jump index") ||

    text.includes("range break") ||

    text.includes("high frequency vol") ||

    text.includes("skew step")

  );

}


/* --------------------------------------------------
   EXCLUDE BOOM / CRASH
-------------------------------------------------- */

function isBoomOrCrash(symbol) {

  const text = (

    symbol.name +
    " " +
    symbol.symbol +
    " " +
    symbol.type

  ).toLowerCase();

  return (

    text.includes("boom") ||
    text.includes("crash")

  );

}


/* --------------------------------------------------
   POPULATE MARKET SELECTOR
-------------------------------------------------- */

function populateDerivMarkets() {

  if (!marketEl) {
    return;
  }

  const previous =
    marketEl.value;

  marketEl.innerHTML = "";

  /*
    Add a synthetic-indices heading.
  */

  const syntheticGroup =
    document.createElement("optgroup");

  syntheticGroup.label =
    "DERIV SYNTHETIC INDICES";

  /*
    Keep synthetic indices.

    Boom/Crash are intentionally
    excluded from this first version.
  */

  const syntheticSymbols =
    activeSymbols
      .filter(isSynthetic)
      .filter(item =>
        !isBoomOrCrash(item)
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name)
      );

  syntheticSymbols.forEach(item => {

    const option =
      document.createElement("option");

    option.value =
      item.symbol;

    option.textContent =
      item.name;

    syntheticGroup.appendChild(option);

  });

  if (syntheticSymbols.length > 0) {

    marketEl.appendChild(
      syntheticGroup
    );

  }


  /*
    Add other active markets.
  */

  const otherGroup =
    document.createElement("optgroup");

  otherGroup.label =
    "OTHER ACTIVE MARKETS";

  const otherSymbols =
    activeSymbols
      .filter(item =>
        !isSynthetic(item)
      )
      .filter(item =>
        !isBoomOrCrash(item)
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name)
      );

  otherSymbols.forEach(item => {

    const option =
      document.createElement("option");

    option.value =
      item.symbol;

    option.textContent =
      item.name;

    otherGroup.appendChild(option);

  });

  if (otherSymbols.length > 0) {

    marketEl.appendChild(
      otherGroup
    );

  }


  /*
    If Deriv returns nothing,
    show a useful message.
  */

  if (marketEl.options.length === 0) {

    const option =
      document.createElement("option");

    option.textContent =
      "No active Deriv symbols found";

    option.value = "";

    marketEl.appendChild(option);

    setConnectionStatus(
      true,
      "No Symbols"
    );

    return;

  }


  /*
    Restore previous symbol
    if it still exists.
  */

  const exists =
    [...marketEl.options]
      .some(option =>
        option.value === previous
      );

  if (exists) {

    marketEl.value =
      previous;

  } else {

    /*
      Prefer Volatility 10
      if available.
    */

    const preferred =
      [...marketEl.options]
        .find(option =>
          option.textContent
            .toLowerCase()
            .includes("volatility 10")
        );

    if (preferred) {

      marketEl.value =
        preferred.value;

    } else {

      marketEl.selectedIndex = 0;

    }

  }


  selectedMarket.textContent =
    getSelectedMarketName();

  subscribeToSelectedSymbol();

}


/* --------------------------------------------------
   GET SELECTED MARKET NAME
-------------------------------------------------- */

function getSelectedMarketName() {

  const option =
    marketEl.options[
      marketEl.selectedIndex
    ];

  return option
    ? option.textContent
    : marketEl.value;

}


/* --------------------------------------------------
   SUBSCRIBE TO TICKS
-------------------------------------------------- */

function subscribeToSelectedSymbol() {

  if (!ws ||
      ws.readyState !== WebSocket.OPEN) {

    return;

  }

  const symbol =
    marketEl.value;

  if (!symbol) {
    return;
  }

  /*
    Ask Deriv to stop previous
    tick subscriptions.
  */

  try {

    ws.send(JSON.stringify({

      forget_all:
        "ticks"

    }));

  } catch (error) {

    console.warn(
      "Could not clear old subscription",
      error
    );

  }


  currentSymbol =
    symbol;

  currentPrice =
    null;

  setConnectionStatus(
    true,
    "Subscribing..."
  );


  ws.send(JSON.stringify({

    ticks: symbol,

    subscribe: 1,

    req_id: requestId++

  }));


  selectedMarket.textContent =
    getSelectedMarketName();

}


/* --------------------------------------------------
   PROCESS LIVE TICK
-------------------------------------------------- */

function processTick(tick) {

  if (!tick) {
    return;
  }

  currentPrice =
    Number(tick.quote);

  if (!Number.isFinite(currentPrice)) {
    return;
  }

  priceEl.textContent =
    formatLivePrice(
      currentPrice
    );

  setConnectionStatus(
    true,
    "Deriv Live"
  );

}


/* --------------------------------------------------
   FORMAT PRICE
-------------------------------------------------- */

function formatLivePrice(price) {

  const symbol =
    currentSymbol || "";

  const market =
    getSelectedMarketName()
      .toLowerCase();

  if (
    market.includes("volatility") ||
    market.includes("step") ||
    market.includes("jump") ||
    market.includes("range")
  ) {

    return price.toFixed(2);

  }

  if (
    symbol.includes("JPY")
  ) {

    return price.toFixed(3);

  }

  if (
    symbol.includes("BTC")
  ) {

    return price.toFixed(2);

  }

  return price.toFixed(5);

}


/* --------------------------------------------------
   DEMO ANALYSIS
--------------------------------------------------

   IMPORTANT:

   The price is now LIVE from Deriv.

   The actual A/B/C trading logic is
   still the next engine stage.

   We do NOT pretend that random data
   is real AI analysis.
-------------------------------------------------- */

function analyzeMarket() {

  if (!currentPrice) {

    explanationEl.textContent =
      "Waiting for live Deriv price data. " +
      "Select a market and wait for the live " +
      "price before requesting analysis.";

    return;

  }

  const market =
    getSelectedMarketName();

  const timeframe =
    timeframeEl.value;

  analyzeBtn.textContent =
    "ANALYZING...";


  setTimeout(() => {

    /*
      Temporary placeholder.

      We intentionally return NO SETUP
      until the real candle/structure engine
      is connected.
    */

    signalEl.textContent =
      "NO SETUP";

    gradeEl.textContent =
      "WAIT";

    gradeEl.className =
      "grade neutral";

    directionEl.textContent =
      "Waiting";

    setupTypeEl.textContent =
      "Live data ready";

    confidenceEl.textContent =
      "—";

    rrEl.textContent =
      "—";

    entryEl.textContent =
      "—";

    slEl.textContent =
      "—";

    tp1El.textContent =
      "—";

    tp2El.textContent =
      "—";

    swingEl.textContent =
      "Waiting";

    structureEl.textContent =
      "Waiting";

    liquidityEl.textContent =
      "Waiting";

    srEl.textContent =
      "Waiting";

    candleEl.textContent =
      "Waiting";

    rejectionEl.textContent =
      "Waiting";

    momentumEl.textContent =
      "Waiting";

    confirmationEl.textContent =
      "Waiting";


    explanationEl.textContent =

      `Live ${market} price data is connected ` +
      `on the ${timeframe} timeframe. ` +
      `The system will not generate a BUY or SELL ` +
      `signal until the required swing/pivot, ` +
      `market structure, support/resistance and ` +
      `candlestick confirmation conditions are met. ` +
      `Current live price: ${formatLivePrice(currentPrice)}. ` +
      `NO SETUP means no confirmed trade exists yet.`;


    analyzeBtn.textContent =
      "ANALYZE MARKET";

  }, 500);

}


/* --------------------------------------------------
   HISTORY
-------------------------------------------------- */

function addHistory(
  market,
  timeframe,
  direction,
  grade,
  entry
) {

  if (!historyList) {
    return;
  }

  const empty =
    historyList.querySelector(
      ".empty"
    );

  if (empty) {
    empty.remove();
  }

  const item =
    document.createElement("div");

  item.className =
    "history-item";

  item.textContent =

    `${new Date().toLocaleTimeString()} — ` +
    `${market} ${timeframe} — ` +
    `${direction} — ${grade} — ` +
    `Entry ${entry}`;

  historyList.prepend(item);

}


/* --------------------------------------------------
   EVENTS
-------------------------------------------------- */

marketEl.addEventListener(
  "change",
  () => {

    selectedMarket.textContent =
      getSelectedMarketName();

    subscribeToSelectedSymbol();

  }
);


timeframeEl.addEventListener(
  "change",
  () => {

    selectedTimeframe.textContent =
      timeframeEl.value;

  }
);


analyzeBtn.addEventListener(
  "click",
  analyzeMarket
);


if (clearHistory) {

  clearHistory.addEventListener(
    "click",
    () => {

      historyList.innerHTML =
        '<p class="empty">No signals yet.</p>';

    }
  );

}


/* --------------------------------------------------
   START
-------------------------------------------------- */

selectedTimeframe.textContent =
  timeframeEl.value;

setConnectionStatus(
  false,
  "Connecting..."
);

connectDeriv();
