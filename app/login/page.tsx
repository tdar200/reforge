"use client";
import { useState } from "react";
export default function Login() {
  const [pc, setPc] = useState(""); const [err, setErr] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: pc }) });
    if (res.ok) window.location.href = "/"; else setErr("Wrong passcode");
  }
  return (
    <main className="p-6 max-w-sm mx-auto pt-24">
      <h1 className="text-2xl font-bold mb-6">Reforge</h1>
      <form onSubmit={submit} className="space-y-4">
        <input type="password" inputMode="numeric" value={pc} onChange={(e) => setPc(e.target.value)}
          placeholder="Passcode" className="w-full rounded bg-neutral-800 p-3" />
        {err && <p className="text-red-400 text-sm">{err}</p>}
        <button className="w-full rounded bg-green-600 p-3 font-semibold">Unlock</button>
      </form>
    </main>
  );
}
