import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

export const COOKIE_NAME = "reforge_session";
const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET!);

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ ok: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("365d")
    .sign(secret());
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try { await jwtVerify(token, secret()); return true; } catch { return false; }
}

export async function requireAuth(_req: Request): Promise<Response | null> {
  const jar = await cookies();
  const ok = await verifySessionToken(jar.get(COOKIE_NAME)?.value);
  return ok ? null : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
}
