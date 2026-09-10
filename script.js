/* =========================================================
   SUCCESSFUL PRECISE AI
   DERIV LIVE MARKET DATA ENGINE
   ========================================================= */

"use strict";

/* ---------------------------------------------------------
   CONNECTION SETTINGS
--------------------------------------------------------- */

const DERIV_PUBLIC_WS =
    "wss://api.derivws.com/trading/v1/options/ws/public";

const DERIV_LEGACY_WS =
    "wss://ws.binaryws.com/websockets/v3";

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let usingLegacyEndpoint = false;

let activeMarkets = [];
let selectedSymbol = null;
let currentPrice = null;

const MAX_RECONNECT_DELAY = 15000;

/* ---------------------------------------------------------
   SAFE DOM HELPERS
--------------------------------------------------------- */

function el(id) {
    return document.getElementById(id);
}

function setText(id, text) {
    const element = el(id);
    if (element) element.textContent = text;
}

/* ---------------------------------------------------------
   CONNECTION STATUS
--------------------------------------------------------- */

function setConnectionStatus(message, connected = false) {
    const possibleIds = [
        "connectionStatus",
        "status",
        "connection-status"
    ];

    let found = false;

    possibleIds.forEach(id => {
        const element = el(id);

        if (element) {
            element.textContent = message;
            found = true;

            if (connected) {
                element.classList.add("connected");
                element.classList.remove("disconnected");
            } else {
                element.classList.remove("connected");
                element.classList.add("disconnected");
            }
        }
    });

    console.log("[Deriv]", message);
}

/* ---------------------------------------------------------
   ERROR DISPLAY
--------------------------------------------------------- */

function showConnectionError(message) {
    console.error("[Deriv Error]", message);

    setConnectionStatus(
        "Deriv Error: " + message,
        false
    );
}

/* ---------------------------------------------------------
   CONNECT TO DERIV
--------------------------------------------------------- */

function connectDeriv() {

    clearTimeout(reconnectTimer);

    setConnectionStatus(
        usingLegacyEndpoint
            ? "Connecting to Deriv..."
            : "Connecting to Deriv..."
    );

    const endpoint = usingLegacyEndpoint
        ? DERIV_LEGACY_WS
        : DERIV_PUBLIC_WS;

    console.log("[Deriv] Connecting:", endpoint);

    try {
        ws = new WebSocket(endpoint);
    } catch (error) {
        console.error(error);
        scheduleReconnect();
        return;
    }

    ws.onopen = function () {

        console.log("[Deriv] WebSocket connected");

        reconnectAttempts = 0;

        setConnectionStatus(
            "Deriv Live",
            true
        );

        requestActiveSymbols();
    };

    ws.onmessage = function (event) {

        try {

            const data = JSON.parse(event.data);

            console.log("[Deriv message]", data);

            handleDerivMessage(data);

        } catch (error) {

            console.error(
                "[Deriv] Invalid message:",
                error
            );
        }
    };

    ws.onerror = function (error) {

        console.error(
            "[Deriv WebSocket Error]",
            error
        );

        setConnectionStatus(
            "Deriv connection error",
            false
        );
    };

    ws.onclose = function (event) {

        console.warn(
            "[Deriv] Connection closed:",
            event.code,
            event.reason
        );

        setConnectionStatus(
            "Reconnecting to Deriv...",
            false
        );

        /*
         * If the new endpoint fails repeatedly,
         * try the legacy public endpoint as a fallback.
         */

        if (
            !usingLegacyEndpoint &&
            reconnectAttempts >= 2
        ) {
            console.log(
                "[Deriv] Trying legacy endpoint..."
            );

            usingLegacyEndpoint = true;
        }

        scheduleReconnect();
    };
}

/* ---------------------------------------------------------
   RECONNECT
--------------------------------------------------------- */

function scheduleReconnect() {

    clearTimeout(reconnectTimer);

    reconnectAttempts++;

    const delay = Math.min(
        2000 * reconnectAttempts,
        MAX_RECONNECT_DELAY
    );

    console.log(
        `[Deriv] Reconnecting in ${delay / 1000}s`
    );

    reconnectTimer = setTimeout(
        connectDeriv,
        delay
    );
}

/* ---------------------------------------------------------
   REQUEST ACTIVE SYMBOLS
--------------------------------------------------------- */

function requestActiveSymbols() {

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn(
            "[Deriv] Cannot request symbols. Socket not open."
        );
        return;
    }

    let request;

    if (usingLegacyEndpoint) {

        request = {
            active_symbols: "brief",
            product_type: "basic",
            req_id: 1
        };

    } else {

        /*
         * Current Deriv API
         */

        request = {
            active_symbols: "brief",
            req_id: 1
        };
    }

    console.log(
        "[Deriv] Requesting active symbols:",
        request
    );

    ws.send(
        JSON.stringify(request)
    );
}

/* ---------------------------------------------------------
   HANDLE DERIV MESSAGES
--------------------------------------------------------- */

function handleDerivMessage(data) {

    /*
     * API ERROR
     */

    if (data.error) {

        console.error(
            "[Deriv API Error]",
            data.error
        );

        showConnectionError(
            data.error.message ||
            data.error.code ||
            "API request failed"
        );

        return;
    }

    /*
     * ACTIVE SYMBOLS
     */

    if (
        data.msg_type === "active_symbols" ||
        Array.isArray(data.active_symbols)
    ) {

        processActiveSymbols(
            data.active_symbols || []
        );

        return;
    }

    /*
     * LIVE TICK
     */

    if (
        data.msg_type === "tick" &&
        data.tick
    ) {

        processTick(
            data.tick
        );

        return;
    }
}

/* ---------------------------------------------------------
   PROCESS ACTIVE SYMBOLS
--------------------------------------------------------- */

function processActiveSymbols(symbols) {

    console.log(
        `[Deriv] Received ${symbols.length} active symbols`
    );

    activeMarkets = symbols
        .map(normalizeSymbol)
        .filter(Boolean);

    /*
     * Remove duplicates
     */

    const unique = new Map();

    activeMarkets.forEach(market => {

        if (
            market.symbol &&
            !unique.has(market.symbol)
        ) {
            unique.set(
                market.symbol,
                market
            );
        }
    });

    activeMarkets = Array.from(
        unique.values()
    );

    /*
     * Sort alphabetically
     */

    activeMarkets.sort(
        (a, b) =>
            a.name.localeCompare(b.name)
    );

    console.log(
        "[Deriv] Usable markets:",
        activeMarkets
    );

    populateMarketSelector();

    /*
     * Automatically select a useful market
     */

    autoSelectPreferredMarket();
}

/* ---------------------------------------------------------
   NORMALIZE SYMBOL
--------------------------------------------------------- */

function normalizeSymbol(item) {

    if (!item) return null;

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
        item.market ||
        "";

    if (!symbol) return null;

    return {
        symbol: symbol,
        name: name,
        type: String(type).toLowerCase(),
        market: String(
            item.market || ""
        ).toLowerCase(),

        subgroup:
            String(
                item.subgroup || ""
            ).toLowerCase(),

        submarket:
            String(
                item.submarket || ""
            ).toLowerCase(),

        pipSize:
            item.pip_size ||
            item.pip ||
            null
    };
}

/* ---------------------------------------------------------
   MARKET CLASSIFICATION
--------------------------------------------------------- */

function classifyMarket(market) {

    const text = (
        market.name + " " +
        market.symbol + " " +
        market.type + " " +
        market.market + " " +
        market.subgroup + " " +
        market.submarket
    ).toLowerCase();

    /*
     * BOOM / CRASH
     */

    if (
        text.includes("boom") ||
        text.includes("crash")
    ) {
        return "Boom & Crash";
    }

    /*
     * VOLATILITY
     */

    if (
        text.includes("volatility") ||
        text.includes("vol ")
    ) {

        if (
            text.includes("(1s)") ||
            text.includes("1s") ||
            text.includes("1-second") ||
            text.includes("1 second")
        ) {
            return "Volatility Indices — 1s";
        }

        return "Volatility Indices";
    }

    /*
     * STEP
     */

    if (
        text.includes("step")
    ) {
        return "Step Indices";
    }

    /*
     * JUMP
     */

    if (
        text.includes("jump")
    ) {
        return "Jump Indices";
    }

    /*
     * RANGE BREAK
     */

    if (
        text.includes("range break")
    ) {
        return "Range Break";
    }

    /*
     * HIGH FREQUENCY VOL
     */

    if (
        text.includes("high frequency") ||
        text.includes("hf vol")
    ) {
        return "High Frequency Volatility";
    }

    /*
     * SYNTHETIC
     */

    if (
        text.includes("synthetic") ||
        market.type.includes("synthetic")
    ) {
        return "Other Synthetic Indices";
    }

    /*
     * FOREX
     */

    if (
        market.type.includes("forex") ||
        market.market.includes("forex") ||
        text.includes("major_pairs") ||
        text.includes("minor_pairs") ||
        text.includes("exotic_pairs")
    ) {
        return "Forex Currency Pairs";
    }

    /*
     * CRYPTO
     */

    if (
        market.type.includes("crypto") ||
        market.market.includes("crypto") ||
        text.includes("bitcoin") ||
        text.includes("ethereum") ||
        text.includes("crypto")
    ) {
        return "Crypto";
    }

    /*
     * METALS
     */

    if (
        text.includes("gold") ||
        text.includes("silver") ||
        text.includes("platinum") ||
        text.includes("palladium") ||
        text.includes("metal") ||
        market.submarket.includes("metals")
    ) {
        return "Metals";
    }

    /*
     * INDICES
     */

    if (
        market.type.includes("indices") ||
        market.market.includes("indices") ||
        text.includes("index") ||
        text.includes("indices")
    ) {
        return "Indices";
    }

    /*
     * STOCKS
     */

    if (
        market.type.includes("stock") ||
        market.market.includes("stocks") ||
        text.includes("stock")
    ) {
        return "Stocks";
    }

    return "Other Active Markets";
}

/* ---------------------------------------------------------
   POPULATE MARKET SELECTOR
--------------------------------------------------------- */

function populateMarketSelector() {

    const marketSelect = el("market");

    if (!marketSelect) {

        console.error(
            "Market selector #market was not found."
        );

        return;
    }

    marketSelect.innerHTML = "";

    /*
     * Group order
     */

    const groupOrder = [
        "Forex Currency Pairs",
        "Indices",
        "Metals",
        "Crypto",
        "Volatility Indices",
        "Volatility Indices — 1s",
        "Step Indices",
        "Jump Indices",
        "Boom & Crash",
        "Range Break",
        "High Frequency Volatility",
        "Other Synthetic Indices",
        "Stocks",
        "Other Active Markets"
    ];

    const groups = {};

    groupOrder.forEach(
        group => {
            groups[group] = [];
        }
    );

    activeMarkets.forEach(market => {

        const category =
            classifyMarket(market);

        if (!groups[category]) {
            groups[category] = [];
        }

        groups[category].push(
            market
        );
    });

    /*
     * Create option groups
     */

    Object.keys(groups).forEach(
        category => {

            const markets =
                groups[category];

            if (!markets.length) {
                return;
            }

            const optgroup =
                document.createElement(
                    "optgroup"
                );

            optgroup.label =
                `${category} (${markets.length})`;

            markets.forEach(
                market => {

                    const option =
                        document.createElement(
                            "option"
                        );

                    option.value =
                        market.symbol;

                    option.textContent =
                        `${market.name} — ${market.symbol}`;

                    option.dataset.type =
                        market.type;

                    option.dataset.category =
                        category;

                    optgroup.appendChild(
                        option
                    );
                }
            );

            marketSelect.appendChild(
                optgroup
            );
        }
    );

    /*
     * Market selection listener
     */

    marketSelect.onchange =
        function () {

            const symbol =
                this.value;

            if (!symbol) return;

            subscribeToMarket(
                symbol
            );
        };

    console.log(
        "[Deriv] Market selector populated."
    );
}

/* ---------------------------------------------------------
   AUTO SELECT PREFERRED MARKET
--------------------------------------------------------- */

function autoSelectPreferredMarket() {

    const marketSelect =
        el("market");

    if (!marketSelect) return;

    if (!activeMarkets.length) {
        return;
    }

    /*
     * Try Volatility 10 first
     */

    let preferred =
        activeMarkets.find(
            m =>
                /volatility\s*10(?!\d)/i.test(
                    m.name
                ) &&
                !/1s|1-second/i.test(
                    m.name
                )
        );

    /*
     * Then Volatility 10 1s
     */

    if (!preferred) {

        preferred =
            activeMarkets.find(
                m =>
                    /volatility\s*10/i.test(
                        m.name
                    )
            );
    }

    /*
     * Then any volatility
     */

    if (!preferred) {

        preferred =
            activeMarkets.find(
                m =>
                    classifyMarket(m)
                        .includes(
                            "Volatility"
                        )
            );
    }

    /*
     * Finally first available market
     */

    if (!preferred) {
        preferred =
            activeMarkets[0];
    }

    marketSelect.value =
        preferred.symbol;

    subscribeToMarket(
        preferred.symbol
    );
}

/* ---------------------------------------------------------
   SUBSCRIBE TO LIVE TICKS
--------------------------------------------------------- */

function subscribeToMarket(symbol) {

    if (
        !ws ||
        ws.readyState !== WebSocket.OPEN
    ) {

        console.warn(
            "[Deriv] Socket not ready."
        );

        return;
    }

    selectedSymbol =
        symbol;

    /*
     * Clear previous tick subscriptions
     */

    try {

        ws.send(
            JSON.stringify({
                forget_all: "ticks",
                req_id: 10
            })
        );

    } catch (error) {

        console.warn(
            "[Deriv] Could not clear old tick subscription",
            error
        );
    }

    /*
     * Subscribe to selected market
     */

    const request = {
        ticks: symbol,
        subscribe: 1,
        req_id: 11
    };

    console.log(
        "[Deriv] Subscribing to:",
        symbol
    );

    ws.send(
        JSON.stringify(request)
    );

    /*
     * Reset displayed price
     */

    setText(
        "price",
        "Waiting for price..."
    );

    setText(
        "currentPrice",
        "Waiting for price..."
    );

    /*
     * Show selected market
     */

    const market =
        activeMarkets.find(
            m =>
                m.symbol === symbol
        );

    if (market) {

        setText(
            "selectedMarket",
            market.name
        );

        setText(
            "marketName",
            market.name
        );
    }
}

/* ---------------------------------------------------------
   PROCESS LIVE TICK
--------------------------------------------------------- */

function processTick(tick) {

    if (
        !tick ||
        tick.quote === undefined
    ) {
        return;
    }

    /*
     * Ignore ticks from a different market
     */

    if (
        selectedSymbol &&
        tick.symbol &&
        tick.symbol !== selectedSymbol
    ) {
        return;
    }

    currentPrice =
        Number(tick.quote);

    const formatted =
        formatPrice(
            currentPrice
        );

    /*
     * Update common price elements
     */

    setText(
        "price",
        formatted
    );

    setText(
        "currentPrice",
        formatted
    );

    setText(
        "livePrice",
        formatted
    );

    /*
     * Update timestamp
     */

    const time =
        tick.epoch
            ? new Date(
                tick.epoch * 1000
            ).toLocaleTimeString()
            : new Date()
                .toLocaleTimeString();

    setText(
        "priceTime",
        "Live: " + time
    );

    setText(
        "lastUpdate",
        "Updated: " + time
    );

    /*
     * Store latest tick for analysis engine
     */

    window.successfulPreciseAI = {
        symbol: selectedSymbol,
        price: currentPrice,
        epoch: tick.epoch || null
    };
}

/* ---------------------------------------------------------
   PRICE FORMAT
--------------------------------------------------------- */

function formatPrice(price) {

    if (!Number.isFinite(price)) {
        return "--";
    }

    if (price >= 1000) {
        return price.toFixed(2);
    }

    if (price >= 100) {
        return price.toFixed(3);
    }

    if (price >= 10) {
        return price.toFixed(3);
    }

    if (price >= 1) {
        return price.toFixed(5);
    }

    return price.toFixed(8);
}

/* ---------------------------------------------------------
   BASIC LIVE STATUS
--------------------------------------------------------- */

function updateLiveStatus() {

    if (
        ws &&
        ws.readyState === WebSocket.OPEN
    ) {

        setConnectionStatus(
            "Deriv Live",
            true
        );

    } else {

        setConnectionStatus(
            "Deriv Offline",
            false
        );
    }
}

/* ---------------------------------------------------------
   PAGE INITIALIZATION
--------------------------------------------------------- */

function initializeSuccessfulPreciseAI() {

    console.log(
        "===================================="
    );

    console.log(
        "SUCCESSFUL PRECISE AI"
    );

    console.log(
        "Deriv Live Market Engine Starting..."
    );

    console.log(
        "===================================="
    );

    /*
     * Make sure the market selector exists.
     */

    const marketSelect =
        el("market");

    if (marketSelect) {

        marketSelect.innerHTML =
            `<option value="">
                Loading Deriv markets...
            </option>`;
    }

    /*
     * Connect to Deriv
     */

    connectDeriv();

    /*
     * Keep status fresh
     */

    setInterval(
        updateLiveStatus,
        5000
    );
}

/* ---------------------------------------------------------
   START
--------------------------------------------------------- */

if (
    document.readyState === "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        initializeSuccessfulPreciseAI
    );

} else {

    initializeSuccessfulPreciseAI();
}
