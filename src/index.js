import { handleEmaRequest, handleScheduled } from "./ema.js";
import { handleBacktestRequest } from "./backtest.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === "/backtest" || pathname.startsWith("/backtest/")) {
      return handleBacktestRequest(request, env, ctx);
    }

    return handleEmaRequest(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  },
};
