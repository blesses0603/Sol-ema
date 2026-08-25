import { workerCore } from "./core.js";

export async function handleBacktestRequest(request, env, ctx) {
  return workerCore.fetch(request, env, ctx);
}
