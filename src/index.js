export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // TradingView webhook
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const data = await request.json();

        if (!data || data.symbol !== "SOLUSDC") {
          return jsonResponse(
            { error: true, message: "Invalid payload" },
            400
          );
        }

        const payload = {
          ...data,
          receivedAt: new Date().toISOString()
        };

        await env.SOL_DATA.put(
          "latest",
          JSON.stringify(payload)
        );

        return jsonResponse({
          ok: true,
          message: "TradingView data saved",
          receivedAt: payload.receivedAt
        });

      } catch (err) {
        return jsonResponse(
          {
            error: true,
            message: err?.message ?? String(err)
          },
          500
        );
      }
    }

    // 讀取最新資料
    if (request.method === "GET" && url.pathname === "/latest") {
      const saved = await env.SOL_DATA.get("latest");

      if (!saved) {
        return jsonResponse(
          {
            error: true,
            message: "No TradingView data received yet"
          },
          404
        );
      }

      return new Response(saved, {
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-store"
        }
      });
    }

    // 健康檢查
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "SOL TradingView Webhook",
        time: new Date().toISOString()
      });
    }

    return jsonResponse({
      service: "SOL TradingView Indicator Bridge",
      endpoints: {
        webhook: "POST /webhook",
        latest: "GET /latest",
        health: "GET /health"
      }
    });
  }
};

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store"
      }
    }
  );
}        if (ema20 > ema50 && ema50 > ema200) {
          trend = "🟢 多頭排列";
        } else if (ema20 < ema50 && ema50 < ema200) {
          trend = "🔴 空頭排列";
        }

        output[interval] = {
          close: round(latest, 4),
          ema20: round(ema20, 4),
          ema50: round(ema50, 4),
          ema200: round(ema200, 4),
          rsi14: round(rsi14, 2),
          trend
        };
      }

      return jsonResponse({
        symbol,
        source: "Binance USDⓈ-M Futures",
        updatedAt: new Date().toISOString(),
        data: output
      });
    } catch (err) {
      return jsonResponse(
        {
          error: true,
          message: err?.message ?? String(err),
          time: new Date().toISOString()
        },
        500
      );
    }
  }
};

function ema(values, period) {
  const alpha = 2 / (period + 1);
  let current = values[0];

  for (let i = 1; i < values.length; i++) {
    current = values[i] * alpha + current * (1 - alpha);
  }

  return current;
}

function rsiWilder(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const currentGain = diff > 0 ? diff : 0;
    const currentLoss = diff < 0 ? -diff : 0;

    avgGain = ((avgGain * (period - 1)) + currentGain) / period;
    avgLoss = ((avgLoss * (period - 1)) + currentLoss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function round(value, digits = 4) {
  if (value === null || value === undefined) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }
  });
}
