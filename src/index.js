export default {
  async fetch() {
    try {
      const url =
        "https://api.bybit.com/v5/market/kline" +
        "?category=linear" +
        "&symbol=SOLUSDT" +
        "&interval=15" +
        "&limit=5";

      const response = await fetch(url, {
        headers: {
          "Accept": "application/json"
        }
      });

      const text = await response.text();

      return new Response(text, {
        status: response.status,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-store"
        }
      });

    } catch (error) {
      return new Response(
        JSON.stringify({
          error: true,
          message: error.message
        }, null, 2),
        {
          status: 500,
          headers: {
            "content-type": "application/json; charset=UTF-8"
          }
        }
      );
    }
  }
};
