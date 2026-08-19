"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { todayIso } from "@/lib/today";
import { sumDiet } from "@/lib/logic";

type Entry = { id: number; name: string; kcal: number; proteinG: number };
type Preset = { id: number; name: string; kcal: number; proteinG: number };
type Settings = { calorieTarget: number; proteinTarget: number };

export default function Diet() {
  const date = todayIso();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [settings, setSettings] = useState<Settings>({ calorieTarget: 2000, proteinTarget: 170 });
  const [form, setForm] = useState({ name: "", kcal: "", proteinG: "" });

  async function load() {
    setEntries(await api<Entry[]>(`/api/diet?date=${date}`));
    setPresets(await api<Preset[]>(`/api/presets`));
    setSettings(await api<Settings>(`/api/settings`));
  }
  useEffect(() => { load(); }, []);

  const total = sumDiet(entries);

  async function add(name: string, kcal: number, proteinG: number) {
    await api(`/api/diet`, { method: "POST", body: JSON.stringify({ date, name, kcal, proteinG }) });
    load();
  }
  async function addFromForm(e: React.FormEvent) {
    e.preventDefault();
    await add(form.name, Number(form.kcal), Number(form.proteinG));
    setForm({ name: "", kcal: "", proteinG: "" });
  }
  async function savePreset() {
    if (!form.name) return;
    await api(`/api/presets`, { method: "POST", body: JSON.stringify({ name: form.name, kcal: Number(form.kcal), proteinG: Number(form.proteinG) }) });
    load();
  }
  async function del(id: number) { await api(`/api/diet/${id}`, { method: "DELETE" }); load(); }

  return (
    <main className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Diet · {date}</h1>
      <div className="flex gap-4 rounded bg-neutral-900 p-4">
        <div>{total.kcal} / {settings.calorieTarget} kcal</div>
        <div>{Math.round(total.proteinG)} / {settings.proteinTarget} g protein</div>
      </div>

      <form onSubmit={addFromForm} className="grid grid-cols-4 gap-2">
        <input className="col-span-4 rounded bg-neutral-800 p-2" placeholder="Food" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className="rounded bg-neutral-800 p-2" inputMode="numeric" placeholder="kcal" value={form.kcal} onChange={(e) => setForm({ ...form, kcal: e.target.value })} />
        <input className="rounded bg-neutral-800 p-2" inputMode="numeric" placeholder="protein" value={form.proteinG} onChange={(e) => setForm({ ...form, proteinG: e.target.value })} />
        <button className="rounded bg-green-600 p-2">Add</button>
        <button type="button" onClick={savePreset} className="rounded bg-neutral-700 p-2">Save preset</button>
      </form>

      {presets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button key={p.id} onClick={() => add(p.name, p.kcal, p.proteinG)} className="rounded-full bg-neutral-800 px-3 py-1 text-sm">
              {p.name} · {p.kcal}kcal
            </button>
          ))}
        </div>
      )}

      <ul className="space-y-2">
        {entries.map((en) => (
          <li key={en.id} className="flex justify-between rounded bg-neutral-900 p-3">
            <span>{en.name}</span>
            <span className="text-neutral-400">{en.kcal}kcal · {Math.round(en.proteinG)}g</span>
            <button onClick={() => del(en.id)} className="text-red-400">✕</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
