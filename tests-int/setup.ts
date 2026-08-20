import { readFileSync } from "node:fs";
import path from "node:path";

const envPath = path.resolve(__dirname, "../.env");
let raw = "";
try { raw = readFileSync(envPath, "utf8"); } catch { /* no .env */ }
for (const line of raw.split("\n")) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (!m) continue;
  const [, key] = m;
  let val = m[2].trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (process.env[key] === undefined) process.env[key] = val;
}
process.env.REFORGE_URL ||= "http://localhost:3100";
