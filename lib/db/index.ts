import { drizzle } from "drizzle-orm/neon-http";
import { neon, neonConfig } from "@neondatabase/serverless";
import * as schema from "./schema";

// Every query is one HTTP request, so a link that drops while connecting fails it outright.
// Retry only failures that provably happened before the request reached Neon (DNS, connect
// timeout, TLS reset during the handshake) — anything later could have been applied already.
const PRE_SEND = /before secure TLS connection|UND_ERR_CONNECT_TIMEOUT|ENOTFOUND|EAI_AGAIN/;

neonConfig.fetchFunction = async (url: string, init: RequestInit) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      if (!PRE_SEND.test(`${String(cause)} ${(cause as { code?: string })?.code ?? ""}`)) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr;
};

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });
export * as schema from "./schema";
