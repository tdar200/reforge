import { z } from "zod";
import { createSessionToken, COOKIE_NAME } from "@/lib/auth";

const Body = z.object({ passcode: z.string() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad request" }, { status: 400 });
  if (parsed.data.passcode !== process.env.APP_PASSCODE) {
    return Response.json({ error: "wrong passcode" }, { status: 401 });
  }
  const token = await createSessionToken();
  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure`,
  );
  return res;
}
