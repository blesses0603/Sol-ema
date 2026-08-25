import { workerCore } from "./core.js";

export async function handleEmaRequest(request, env, ctx) {
  return workerCore.fetch(request, env, ctx);
}

export async function handleScheduled(event, env, ctx) {
  if (typeof workerCore.scheduled === "function") {
    return workerCore.scheduled(event, env, ctx);
  }
}
