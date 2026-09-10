// ============================================================
// SUCCESSFUL PINE SCRIPT
// DERIV LIVE MARKET DATA
// ============================================================

const DERIV_URL =
  "wss://api.derivws.com/trading/v1/options/ws/public";

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 2000;

let activeMarkets = [];
let selectedSymbol = null;

// ------------------------------------------------------------
// ELEMENTS
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// CONNECTION STATUS
// ------------------------------------------------------------

function setStatus(text) {

  if (connectionText) {
    connectionText.textContent = text;
  }

  console.log("[DERIV]", text);
}

// ------------------------------------------------------------
// CONNECT
// ------------------------------------------------------------

function connectDeriv() {

  clearTimeout(reconnectTimer);

  setStatus("Connecting to Deriv...");

  console.log("Opening Deriv WebSocket...");

  try {

    socket = new WebSocket(DERIV_URL);

  } catch (error) {

    console.error(
      "Could not create WebSocket:",
      error
    );

    reconnect();
    return;
  }

  // ----------------------------------------------------------
  // OPEN
  // ----------------------------------------------------------

  socket.onopen = function () {

    console.log(
      "================================"
    );

    console.log(
      "DERIV LIVE CONNECTION SUCCESSFUL"
    );

    console.log(
      "================================"
    );

    setStatus("LIVE • DERIV CONNECTED");

    reconnectDelay = 2000;

    requestActiveMarkets();
  };

  // ----------------------------------------------------------
  // MESSAGE
  // ----------------------------------------------------------

  socket.onmessage = function (event) {

    console.log(
      "DERIV:",
      event.data
    );

    let data;

    try {

      data = JSON.parse(event.data);

    } catch (error) {

      console.error(
        "Invalid Deriv response:",
        event.data
      );

      return;
    }

    // --------------------------------------------------------
    // API ERROR
    // --------------------------------------------------------

    if (data.error) {

      console.error(
        "DERIV API ERROR:",
        data.error
      );

      setStatus(
        "DERIV ERROR"
      );

      return;
    }

    // --------------------------------------------------------
    // ACTIVE MARKETS
    // --------------------------------------------------------

    if (
      data.msg_type === "active_symbols"
    ) {

      console.log(
        "ACTIVE MARKETS:",
        data.active_symbols
      );

      loadMarkets(
        data.active_symbols || []
      );

      return;
    }

    // --------------------------------------------------------
    // LIVE TICK
    // --------------------------------------------------------

    if (
      data.msg_type === "tick"
    ) {

      if (
        data.tick &&
        data.tick.quote !== undefined
      ) {

        updateLivePrice(
          data.tick.quote
        );
      }

      return;
    }
  };

  // ----------------------------------------------------------
  // ERROR
  // ----------------------------------------------------------

  socket.onerror = function (error) {

    console.error(
      "DERIV WEBSOCKET ERROR:",
      error
    );

    setStatus(
      "DERIV CONNECTION ERROR"
    );
  };

  // ----------------------------------------------------------
  // CLOSE
  // ----------------------------------------------------------

  socket.onclose = function (event) {

    console.warn(
      "DERIV CONNECTION CLOSED",
      event.code,
      event.reason
    );

    setStatus(
      "Disconnected • Reconnecting..."
    );

    reconnect();
  };
}

// ------------------------------------------------------------
// REQUEST ACTIVE MARKETS
// ------------------------------------------------------------

function requestActiveMarkets() {

  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {

    console.warn(
      "Cannot request markets: socket not open."
    );

    return;
  }

  const request = {

    active_symbols: "brief",

    req_id: 1
  };

  console.log(
    "Requesting active Deriv markets..."
  );

  socket.send(
    JSON.stringify(request)
  );
}

// ------------------------------------------------------------
// LOAD MARKETS
// ------------------------------------------------------------

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
          item.market ||
          "",

        subgroup:
          item.subgroup ||
          "",

        submarket:
          item.submarket ||
          "",

        suspended:
          item.is_trading_suspended === 1
      };

    })
    .filter(function (item) {

      return (
        item.symbol &&
        !item.suspended
      );

    });

  console.log(
    "Loaded markets:",
    activeMarkets.length
  );

  populateMarkets();

  // ----------------------------------------------------------
  // AUTOMATICALLY SELECT A DERIV SYNTHETIC
  // ----------------------------------------------------------

  const preferred =
    findPreferredMarket();

  if (preferred) {

    selectedSymbol =
      preferred.symbol;

    marketSelect.value =
      preferred.symbol;

    showSelectedMarket(
      preferred
    );

    subscribeToTicks(
      preferred.symbol
    );

  } else if (activeMarkets.length > 0) {

    selectedSymbol =
      activeMarkets[0].symbol;

    marketSelect.value =
      activeMarkets[0].symbol;

    showSelectedMarket(
      activeMarkets[0]
    );

    subscribeToTicks(
      activeMarkets[0].symbol
    );
  }
}

// ------------------------------------------------------------
// POPULATE MARKET DROPDOWN
// ------------------------------------------------------------

function populateMarkets() {

  if (!marketSelect) {

    console.error(
      "Market selector #market not found."
    );

    return;
  }

  marketSelect.innerHTML = "";

  const groups = {

    forex:
      document.createElement("optgroup"),

    indices:
      document.createElement("optgroup"),

    metals:
      document.createElement("optgroup"),

    crypto:
      document.createElement("optgroup"),

    synthetic:
      document.createElement("optgroup"),

    other:
      document.createElement("optgroup")
  };

  groups.forex.label =
    "FOREX CURRENCY PAIRS";

  groups.indices.label =
    "GLOBAL INDICES";

  groups.metals.label =
    "METALS / COMMODITIES";

  groups.crypto.label =
    "CRYPTOCURRENCIES";

  groups.synthetic.label =
    "DERIV SYNTHETIC INDICES";

  groups.other.label =
    "OTHER ACTIVE MARKETS";

  activeMarkets.forEach(
    function (market) {

      const option =
        document.createElement("option");

      option.value =
        market.symbol;

      option.textContent =
        market.name +
        "  [" +
        market.symbol +
        "]";

      const category =
        getCategory(market);

      groups[category].appendChild(
        option
      );
    }
  );

  Object.keys(groups).forEach(
    function (category) {

      if (
        groups[category].children.length
      ) {

        marketSelect.appendChild(
          groups[category]
        );
      }
    }
  );
}

// ------------------------------------------------------------
// CATEGORY
// ------------------------------------------------------------

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

  // Synthetic
  if (
    text.includes("volatility") ||
    text.includes("step index") ||
    text.includes("jump index") ||
    text.includes("boom") ||
    text.includes("crash") ||
    text.includes("range break") ||
    text.includes("high frequency") ||
    text.includes("skew")
  ) {

    return "synthetic";
  }

  // Forex
  if (
    market.type.toLowerCase()
      .includes("forex") ||

    market.market.toLowerCase()
      .includes("forex") ||

    text.includes("forex")
  ) {

    return "forex";
  }

  // Metals
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

  // Crypto
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

  // Indices
  if (
    text.includes("index") ||
    text.includes("indices") ||
    text.includes("nasdaq") ||
    text.includes("dow") ||
    text.includes("s&p") ||
    text.includes("wall street")
  ) {

    return "indices";
  }

  return "other";
}

// ------------------------------------------------------------
// PREFERRED MARKET
// ------------------------------------------------------------

function findPreferredMarket() {

  const names = [

    "volatility 10",

    "volatility 15",

    "volatility 25",

    "volatility 50",

    "step index",

    "eur/usd"
  ];

  for (
    let i = 0;
    i < names.length;
    i++
  ) {

    const found =
      activeMarkets.find(
        function (market) {

          return market.name
            .toLowerCase()
            .includes(
              names[i]
            );
        }
      );

    if (found) {
      return found;
    }
  }

  return null;
}

// ------------------------------------------------------------
// SELECT MARKET
// ------------------------------------------------------------

if (marketSelect) {

  marketSelect.addEventListener(
    "change",
    function () {

      const symbol =
        this.value;

      if (!symbol) {
        return;
      }

      selectedSymbol =
        symbol;

      const market =
        activeMarkets.find(
          function (item) {

            return (
              item.symbol === symbol
            );
          }
        );

      if (market) {

        showSelectedMarket(
          market
        );
      }

      subscribeToTicks(
        symbol
      );
    }
  );
}

// ------------------------------------------------------------
// SHOW SELECTED MARKET
// ------------------------------------------------------------

function showSelectedMarket(
  market
) {

  if (selectedMarketElement) {

    selectedMarketElement.textContent =
      market.name;
  }
}

// ------------------------------------------------------------
// SUBSCRIBE TO LIVE PRICE
// ------------------------------------------------------------

function subscribeToTicks(symbol) {

  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {

    console.warn(
      "Socket is not connected."
    );

    return;
  }

  console.log(
    "Subscribing to LIVE price:",
    symbol
  );

  // Remove previous tick subscriptions
  socket.send(
    JSON.stringify({
      forget_all: "ticks",
      req_id: 2
    })
  );

  // Subscribe to selected symbol
  socket.send(
    JSON.stringify({

      ticks: symbol,

      subscribe: 1,

      req_id: 3

    })
  );

  setStatus(
    "LIVE • " + symbol
  );
}

// ------------------------------------------------------------
// UPDATE PRICE
// ------------------------------------------------------------

function updateLivePrice(price) {

  if (!priceElement) {
    return;
  }

  const number =
    Number(price);

  if (!Number.isFinite(number)) {
    return;
  }

  priceElement.textContent =
    formatPrice(number);
}

// ------------------------------------------------------------
// PRICE FORMAT
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// TIMEFRAME
// ------------------------------------------------------------

if (timeframeSelect) {

  timeframeSelect.addEventListener(
    "change",
    function () {

      if (
        selectedTimeframeElement
      ) {

        selectedTimeframeElement
          .textContent =
          this.value;
      }
    }
  );
}

// ------------------------------------------------------------
// ANALYZE BUTTON
// ------------------------------------------------------------

if (analyzeButton) {

  analyzeButton.addEventListener(
    "click",
    function () {

      analyzeMarket();
    }
  );
}

// ------------------------------------------------------------
// ANALYSIS PLACEHOLDER
// ------------------------------------------------------------

function analyzeMarket() {

  console.log(
    "Analysis requested for:",
    selectedSymbol
  );

  const signal =
    document.getElementById(
      "signal"
    );

  const explanation =
    document.getElementById(
      "explanationText"
    );

  if (signal) {

    signal.textContent =
      "NO SETUP";
  }

  if (explanation) {

    explanation.textContent =
      "Live market data is connected. " +
      "The system is waiting for the " +
      "candle and market-structure " +
      "engine before generating a trade signal.";
  }
}

// ------------------------------------------------------------
// RECONNECT
// ------------------------------------------------------------

function reconnect() {

  clearTimeout(
    reconnectTimer
  );

  reconnectTimer =
    setTimeout(
      function () {

        connectDeriv();

      },
      reconnectDelay
    );

  reconnectDelay =
    Math.min(
      reconnectDelay * 1.5,
      30000
    );
}

// ------------------------------------------------------------
// START
// ------------------------------------------------------------

console.log(
  "SUCCESSFUL PINE SCRIPT STARTING..."
);

connectDeriv();
