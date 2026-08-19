// Real dependency checkers for /api/health (27 §14).
import { connect as netConnect } from "node:net";
import type { Pool } from "pg";
import type { HealthCheckers } from "./modules/health/index.js";

function tcpCheck(host: string, port: number, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout connecting to ${host}:${port}`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function buildCheckers(input: {
  pool: Pool;
  natsUrl: string;
  temporalAddress: string;
}): HealthCheckers {
  const nats = new URL(input.natsUrl);
  const [temporalHost, temporalPort] = input.temporalAddress.split(":");
  return {
    postgres: async () => {
      await input.pool.query("SELECT 1");
    },
    nats: () => tcpCheck(nats.hostname, Number(nats.port || 4222)),
    temporal: () => tcpCheck(temporalHost!, Number(temporalPort ?? 7233)),
  };
}
