// A WebSocket to the Durable Object, hibernation-safe, wrapped in a
// frame queue. From bothy's test/helpers/socket.ts (github.com/sybenx/bothy,
// MIT), trimmed to what this relay speaks.
import { env } from "cloudflare:test";

export type Frame = [string, ...unknown[]];

export interface RelayConn {
  send(message: unknown[]): void;
  nextMessage(timeoutMs?: number): Promise<Frame>;
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 3000;

export async function connectRelay(ip?: string): Promise<RelayConn> {
  const stub = env.SIGNER.get(env.SIGNER.idFromName("signer"));
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  const response = await stub.fetch("https://example.com/", { headers });
  const socket = response.webSocket;
  if (!socket) throw new Error("expected a websocket response");
  socket.accept();

  const queue: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    const frame = JSON.parse(event.data) as Frame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });

  return {
    send(message) {
      socket.send(JSON.stringify(message));
    },
    nextMessage(timeoutMs = DEFAULT_TIMEOUT_MS) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(onFrame);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`no message received from relay within ${timeoutMs}ms`));
        }, timeoutMs);
        function onFrame(frame: Frame) {
          clearTimeout(timer);
          resolve(frame);
        }
        waiters.push(onFrame);
      });
    },
    close() {
      socket.close(1000, "test done");
    },
  };
}
