export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 401) { window.location.href = "/login"; throw new Error("unauthorized"); }
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}
