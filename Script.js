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

const explanationEl = document.getElementById("explanationText");
const historyList = document.getElementById("historyList");
const clearHistory = document.getElementById("clearHistory");

function randomPrice(market) {

  const prices = {
    XAUUSD: 3350,
    XAGUSD: 38,
    EURUSD: 1.1700,
    GBPUSD: 1.3500,
    USDJPY: 147.00,
    NAS100: 24000,
    US30: 45000,
    BTCUSD: 110000
  };

  const base = prices[market] || 100;

  return base + (Math.random() - 0.5) * base * 0.002;
}

function formatPrice(price, market) {

  if (["EURUSD", "GBPUSD"].includes(market)) {
    return price.toFixed(5);
  }

  if (market === "USDJPY") {
    return price.toFixed(3);
  }

  if (market === "XAGUSD") {
    return price.toFixed(3);
  }

  if (market === "BTCUSD") {
    return price.toFixed(2);
  }

  return price.toFixed(2);
}

function setStatus(element, value) {
  element.textContent = value;
}

function analyzeMarket() {

  const market = marketEl.value;
  const timeframe = timeframeEl.value;

  const price = randomPrice(market);

  selectedMarket.textContent = market;
  selectedTimeframe.textContent = timeframe;
  priceEl.textContent = formatPrice(price, market);

  analyzeBtn.textContent = "ANALYZING...";

  setTimeout(() => {

    /*
      DEMO ANALYSIS ENGINE

      This is intentionally not connected to live market data yet.
      The live Deriv WebSocket/API engine will replace this section
      in the next stage.
    */

    const random = Math.random();

    let direction;
    let grade;
    let setup;
    let confidence;

    if (random < 0.38) {

      direction = "BUY";
      grade = "A";
      setup = "Bullish Swing Reversal";
      confidence = 88;

    } else if (random < 0.76) {

      direction = "SELL";
      grade = "B";
      setup = "Bearish Swing Reversal";
      confidence = 76;

    } else {

      direction = "NO SETUP";
      grade = "WAIT";
      setup = "No Confirmed Setup";
      confidence = 42;

    }

    if (direction === "NO SETUP") {

      signalEl.textContent = "NO SETUP";
      gradeEl.textContent = "WAIT";

      gradeEl.className = "grade neutral";

      directionEl.textContent = "Waiting";
      setupTypeEl.textContent = setup;
      confidenceEl.textContent = confidence + "%";
      rrEl.textContent = "--";

      entryEl.textContent = "--";
      slEl.textContent = "--";
      tp1El.textContent = "--";
      tp2El.textContent = "--";

      swingEl.textContent = "Not confirmed";
      structureEl.textContent = "Neutral";
      liquidityEl.textContent = "Waiting";
      srEl.textContent = "Waiting";

      candleEl.textContent = "Waiting";
      rejectionEl.textContent = "Not confirmed";
      momentumEl.textContent = "Neutral";
      confirmationEl.textContent = "No";

      explanationEl.textContent =
        "No confirmed A/B setup is currently available. " +
        "The system is waiting for price to reach a meaningful swing/pivot " +
        "area and produce valid price-action and candlestick confirmation.";

    } else {

      const isBuy = direction === "BUY";

      const risk = price * 0.0015;

      const entry = price;
      const sl = isBuy ? price - risk : price + risk;
      const tp1 = isBuy ? price + risk * 2 : price - risk * 2;
      const tp2 = isBuy ? price + risk * 3 : price - risk * 3;

      signalEl.textContent = direction;
      gradeEl.textContent = grade + " SETUP";

      gradeEl.className = isBuy
        ? "grade buy"
        : "grade sell";

      directionEl.textContent = direction;
      setupTypeEl.textContent = setup;
      confidenceEl.textContent = confidence + "%";
      rrEl.textContent = "1:2 / 1:3";

      entryEl.textContent = formatPrice(entry, market);
      slEl.textContent = formatPrice(sl, market);
      tp1El.textContent = formatPrice(tp1, market);
      tp2El.textContent = formatPrice(tp2, market);

      swingEl.textContent = isBuy
        ? "Bullish swing"
        : "Bearish swing";

      structureEl.textContent = isBuy
        ? "Bullish"
        : "Bearish";

      liquidityEl.textContent = "Sweep detected";

      srEl.textContent = isBuy
        ? "Demand support"
        : "Supply resistance";

      candleEl.textContent = isBuy
        ? "Bullish rejection"
        : "Bearish rejection";

      rejectionEl.textContent = "Confirmed";

      momentumEl.textContent = isBuy
        ? "Bullish"
        : "Bearish";

      confirmationEl.textContent = "Confirmed";

      explanationEl.textContent =
        `${direction} setup detected on ${market} ${timeframe}. ` +
        `The demonstration engine identified a ${isBuy ? "bullish" : "bearish"} ` +
        `swing condition, market-structure alignment, liquidity behavior, ` +
        `support/resistance interaction and candlestick confirmation. ` +
        `Entry is around ${formatPrice(entry, market)}, with stop loss at ` +
        `${formatPrice(sl, market)}, TP1 at ${formatPrice(tp1, market)} ` +
        `and TP2 at ${formatPrice(tp2, market)}. ` +
        `Always verify the live market before taking a trade.`;

      addHistory(
        market,
        timeframe,
        direction,
        grade,
        formatPrice(entry, market)
      );
    }

    analyzeBtn.textContent = "ANALYZE MARKET";

  }, 700);
}

function addHistory(
  market,
  timeframe,
  direction,
  grade,
  entry
) {

  const empty = historyList.querySelector(".empty");

  if (empty) {
    empty.remove();
  }

  const item = document.createElement("div");

  item.className = "history-item";

  item.textContent =
    `${new Date().toLocaleTimeString()} — ` +
    `${market} ${timeframe} — ` +
    `${direction} — ${grade} — Entry ${entry}`;

  historyList.prepend(item);
}

marketEl.addEventListener("change", () => {

  selectedMarket.textContent = marketEl.value;

});

timeframeEl.addEventListener("change", () => {

  selectedTimeframe.textContent = timeframeEl.value;

});

analyzeBtn.addEventListener("click", analyzeMarket);

clearHistory.addEventListener("click", () => {

  historyList.innerHTML =
    '<p class="empty">No signals yet.</p>';

});

priceEl.textContent =
  formatPrice(
    randomPrice(marketEl.value),
    marketEl.value
  );
