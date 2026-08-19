"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

type Settings = { calorieTarget: number; proteinTarget: number };

export default function SettingsPage() {
  const [s, setS] = useState<Settings>({ calorieTarget: 2000, proteinTarget: 170 });
  const [saved, setSaved] = useState(false);
  useEffect(() => { (async () => setS(await api<Settings>(`/api/settings`)))(); }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await api(`/api/settings`, { method: "PUT", body: JSON.stringify({ calorieTarget: Number(s.calorieTarget), proteinTarget: Number(s.proteinTarget) }) });
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  }
  return (
    <main className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Settings</h1>
      <form onSubmit={save} className="space-y-3">
        <label className="block">Calorie target
          <input className="mt-1 w-full rounded bg-neutral-800 p-2" inputMode="numeric"
            value={s.calorieTarget} onChange={(e) => setS({ ...s, calorieTarget: Number(e.target.value) })} />
        </label>
        <label className="block">Protein target (g)
          <input className="mt-1 w-full rounded bg-neutral-800 p-2" inputMode="numeric"
            value={s.proteinTarget} onChange={(e) => setS({ ...s, proteinTarget: Number(e.target.value) })} />
        </label>
        <button className="rounded bg-green-600 p-3 w-full">{saved ? "Saved ✓" : "Save"}</button>
      </form>
    </main>
  );
}
