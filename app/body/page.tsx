"use client";
import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { api } from "@/lib/client";
import { todayIso } from "@/lib/today";

type Metric = { id: number; date: string; bodyweight: number | null; waist: number | null; chest: number | null; thigh: number | null; arm: number | null };
const FIELDS: (keyof Metric)[] = ["bodyweight", "waist", "chest", "thigh", "arm"];

export default function Body() {
  const [rows, setRows] = useState<Metric[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  async function load() { setRows(await api<Metric[]>(`/api/metrics`)); }
  useEffect(() => { load(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body: any = { date: todayIso() };
    for (const f of FIELDS) if (form[f]) body[f] = Number(form[f]);
    await api(`/api/metrics`, { method: "POST", body: JSON.stringify(body) });
    setForm({}); load();
  }

  return (
    <main className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Body metrics</h1>
      <form onSubmit={submit} className="grid grid-cols-3 gap-2">
        {FIELDS.map((f) => (
          <input key={f} className="rounded bg-neutral-800 p-2" inputMode="decimal" placeholder={f}
            value={form[f] ?? ""} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />
        ))}
        <button className="rounded bg-green-600 p-2 col-span-3">Log today</button>
      </form>

      {FIELDS.map((f) => (
        <div key={f}>
          <h2 className="text-sm text-neutral-400 capitalize">{f}</h2>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={rows.filter((r) => r[f] != null).map((r) => ({ date: r.date.slice(5), v: r[f] }))}>
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10 }} width={30} />
              <Tooltip />
              <Line type="monotone" dataKey="v" stroke="#22c55e" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ))}
    </main>
  );
}
