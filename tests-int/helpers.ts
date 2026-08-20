const BASE = () => process.env.REFORGE_URL || "http://localhost:3100";

export async function loginCookie(): Promise<string> {
  const res = await fetch(`${BASE()}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode: process.env.APP_PASSCODE }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = /reforge_session=[^;]+/.exec(setCookie);
  if (!m) throw new Error(`no reforge_session cookie in: ${setCookie}`);
  return m[0];
}

export async function api(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  const res = await fetch(`${BASE()}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: unknown = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}
