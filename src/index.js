export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // TradingView webhook
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const data = await request.json();

        if (!data || data.symbol !== "SOLUSDC") {
          return jsonResponse(
            {
              error: true,
              message: "Invalid payload"
            },
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

    // 讀取最新 TradingView 指標
    if (
      request.method === "GET" &&
      url.pathname === "/latest"
    ) {
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
          "content-type":
            "application/json; charset=UTF-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-store"
        }
      });
    }

    // 健康檢查
    if (
      request.method === "GET" &&
      url.pathname === "/health"
    ) {
      return jsonResponse({
        ok: true,
        service: "SOL TradingView Webhook",
        time: new Date().toISOString()
      });
    }

    // 首頁說明
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
        "content-type":
          "application/json; charset=UTF-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store"
      }
    }
  );
}
