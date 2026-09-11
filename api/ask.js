// ============================================================
// SUCCESSFUL PINE SCRIPT — AI QUESTION BACKEND
// Vercel Serverless Function
// File: /api/ask.js
// ============================================================

export default async function handler(req, res) {
  // ----------------------------------------------------------
  // CORS
  // ----------------------------------------------------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const body = req.body || {};

    const question = String(body.question || "").trim();
    const analysis = body.analysis || {};
    const market = body.market || {};
    const candles = Array.isArray(body.candles)
      ? body.candles
      : [];

    if (!question) {
      return res.status(400).json({
        error: "Please enter a question."
      });
    }

    // --------------------------------------------------------
    // Build a STRICT market context.
    // The AI is instructed not to invent market information.
    // --------------------------------------------------------
    const marketContext = {
      symbol: market.symbol || "Unknown",
      name: market.name || "",
      price: market.price ?? null,

      timeframe:
        analysis.timeframe || "Unknown",

      signal:
        analysis.signal || "WAIT",

      grade:
        analysis.grade || "NONE",

      direction:
        analysis.direction || "NONE",

      entry:
        analysis.entry ?? null,

      stopLoss:
        analysis.sl ?? null,

      breakEven:
        analysis.be ?? null,

      takeProfit1:
        analysis.tp1 ?? null,

      takeProfit2:
        analysis.tp2 ?? null,

      rr:
        analysis.rr ?? null,

      htfBias:
        analysis.htfBias || "Unknown",

      oneHourStructure:
        analysis.oneHStructure || "Unknown",

      structure:
        analysis.structure || "Unknown",

      liquidity:
        analysis.liquidity || "Unknown",

      supportResistance:
        analysis.sr || "Unknown",

      supplyDemand:
        analysis.supplyDemand || "Unknown",

      orderBlock:
        analysis.ob || "Unknown",

      fairValueGap:
        analysis.fvg || "Unknown",

      candlePattern:
        analysis.pattern || "Unknown",

      candleConfirmation:
        analysis.confirmation || "Unknown",

      invalidation:
        analysis.invalidation || "Unknown",

      explanation:
        analysis.explanation || ""
    };

    // --------------------------------------------------------
    // If no AI API key is configured, use safe local response.
    // --------------------------------------------------------
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(200).json({
        success: true,
        source: "local-engine",
        answer: buildLocalAnswer(
          question,
          marketContext
        )
      });
    }

    // --------------------------------------------------------
    // AI PROMPT
    // --------------------------------------------------------
    const systemPrompt = `
You are the AI assistant inside SUCCESSFUL PINE SCRIPT,
a live trading-analysis dashboard.

Your job is to explain the bot's ACTUAL analysis clearly.

IMPORTANT RULES:

1. NEVER invent a price, signal, setup, candle,
   market structure, indicator reading or confirmation.

2. ONLY use information supplied in the market context.

3. If the supplied information is insufficient,
   clearly say that the data is insufficient.

4. Do not guarantee profit.

5. Do not claim a trade is confirmed when the engine
   says WAIT or NO CONFIRMED SETUP.

6. Explain trading concepts in simple language.

7. If the user asks why there is no trade, explain which
   required confirmations are missing.

8. If the user asks about a BUY or SELL signal, explain:
   - direction
   - HTF bias
   - 1H structure
   - liquidity
   - BOS/CHoCH
   - support/resistance
   - supply/demand
   - OB
   - FVG
   - candlestick confirmation
   - entry
   - SL
   - BE
   - TP1
   - TP2
   - RR
   - invalidation

9. A+ and A are stronger setups.
   B is moderate.
   C is higher risk.

10. If there is no confirmed setup, say:
   "WAIT — NO CONFIRMED SETUP."

11. Keep answers practical and concise unless the user
    asks for a detailed explanation.

12. This is analysis/education, not a guarantee or financial
    promise.
`;

    const userPrompt = `
USER QUESTION:
${question}

ACTUAL BOT MARKET CONTEXT:
${JSON.stringify(marketContext, null, 2)}

RECENT CLOSED CANDLES:
${JSON.stringify(candles.slice(-30), null, 2)}

Answer the user's question using ONLY the supplied data.
`;

    // --------------------------------------------------------
    // OPENAI API
    // --------------------------------------------------------
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },

        body: JSON.stringify({
          model:
            process.env.OPENAI_MODEL ||
            "gpt-4o-mini",

          temperature: 0.2,

          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: userPrompt
            }
          ],

          max_tokens: 700
        })
      }
    );

    if (!response.ok) {
      const errorText =
        await response.text();

      console.error(
        "AI API ERROR:",
        errorText
      );

      return res.status(502).json({
        error:
          "AI service temporarily unavailable.",
        fallback: buildLocalAnswer(
          question,
          marketContext
        )
      });
    }

    const data = await response.json();

    const answer =
      data?.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      return res.status(200).json({
        success: true,
        source: "local-engine",
        answer: buildLocalAnswer(
          question,
          marketContext
        )
      });
    }

    return res.status(200).json({
      success: true,
      source: "ai",
      answer
    });

  } catch (error) {
    console.error(
      "QUESTION BACKEND ERROR:",
      error
    );

    return res.status(500).json({
      error: "Internal server error.",
      answer:
        "I could not process that question right now. Please try again."
    });
  }
}


// ============================================================
// SAFE LOCAL FALLBACK
// ============================================================

function buildLocalAnswer(
  question,
  a
) {
  const q = question.toLowerCase();

  // ----------------------------------------------------------
  // NO SETUP
  // ----------------------------------------------------------
  if (
    a.signal === "WAIT" ||
    a.signal === "NO SETUP" ||
    a.direction === "NONE"
  ) {
    return `
WAIT — NO CONFIRMED SETUP.

Current market: ${a.symbol}
Timeframe: ${a.timeframe}
HTF bias: ${a.htfBias}
1H structure: ${a.oneHourStructure}

The engine does not currently have enough confirmed
conditions to produce a Precision BUY/SELL signal.

Current structure:
${a.structure}

Liquidity:
${a.liquidity}

Candlestick confirmation:
${a.candleConfirmation}

The correct action is to wait for additional confirmation
rather than force a trade.
`.trim();
  }

  // ----------------------------------------------------------
  // SIGNAL QUESTION
  // ----------------------------------------------------------
  if (
    q.includes("signal") ||
    q.includes("trade") ||
    q.includes("buy") ||
    q.includes("sell")
  ) {
    return `
Current Precision analysis:

Market: ${a.symbol}
Timeframe: ${a.timeframe}
Signal: ${a.signal}
Direction: ${a.direction}
Grade: ${a.grade}

HTF bias: ${a.htfBias}
1H structure: ${a.oneHourStructure}

Structure: ${a.structure}
Liquidity: ${a.liquidity}
Support/Resistance: ${a.supportResistance}
Supply/Demand: ${a.supplyDemand}
Order Block: ${a.orderBlock}
FVG: ${a.fairValueGap}

Candlestick pattern:
${a.candlePattern}

Confirmation:
${a.candleConfirmation}

Entry: ${a.entry}
SL: ${a.stopLoss}
BE: ${a.breakEven}
TP1: ${a.takeProfit1}
TP2: ${a.takeProfit2}
RR: ${a.rr}

Invalidation:
${a.invalidation}

Explanation:
${a.explanation}
`.trim();
  }

  // ----------------------------------------------------------
  // STRUCTURE
  // ----------------------------------------------------------
  if (
    q.includes("structure") ||
    q.includes("bos") ||
    q.includes("choch") ||
    q.includes("trend")
  ) {
    return `
Current structure:

HTF bias: ${a.htfBias}
1H structure: ${a.oneHourStructure}
Current structure: ${a.structure}

Liquidity:
${a.liquidity}

The engine uses closed candles and confirmed swing
information. It does not treat an unclosed candle as
confirmed structure.
`.trim();
  }

  // ----------------------------------------------------------
  // CANDLE
  // ----------------------------------------------------------
  if (
    q.includes("candle") ||
    q.includes("candlestick") ||
    q.includes("pattern")
  ) {
    return `
Current candlestick information:

Pattern:
${a.candlePattern}

Confirmation:
${a.candleConfirmation}

The candle information above comes from the bot's
closed-candle analysis.
`.trim();
  }

  // ----------------------------------------------------------
  // ENTRY
  // ----------------------------------------------------------
  if (
    q.includes("entry") ||
    q.includes("stop") ||
    q.includes("sl") ||
    q.includes("take profit") ||
    q.includes("tp") ||
    q.includes("risk")
  ) {
    return `
Current trade levels:

Entry: ${a.entry}
Stop Loss: ${a.stopLoss}
Break Even: ${a.breakEven}
TP1: ${a.takeProfit1}
TP2: ${a.takeProfit2}
RR: ${a.rr}

Invalidation:
${a.invalidation}

These levels are valid only while the setup remains
confirmed and has not been invalidated.
`.trim();
  }

  // ----------------------------------------------------------
  // DEFAULT
  // ----------------------------------------------------------
  return `
Current market analysis:

Market: ${a.symbol}
Price: ${a.price}
Timeframe: ${a.timeframe}

Signal: ${a.signal}
Grade: ${a.grade}
HTF bias: ${a.htfBias}
1H structure: ${a.oneHourStructure}

Structure:
${a.structure}

Liquidity:
${a.liquidity}

Support/Resistance:
${a.supportResistance}

Supply/Demand:
${a.supplyDemand}

OB:
${a.orderBlock}

FVG:
${a.fairValueGap}

Candlestick:
${a.candlePattern}

Confirmation:
${a.candleConfirmation}

Explanation:
${a.explanation}
`.trim();
}
