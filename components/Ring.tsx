"use client";
export function Ring({ value, max, label, unit }: { value: number; max: number; label: string; unit: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const r = 52, c = 2 * Math.PI * r, off = c - (pct / 100) * c;
  return (
    <div className="flex flex-col items-center">
      <svg width="128" height="128" className="-rotate-90">
        <circle cx="64" cy="64" r={r} stroke="#27272a" strokeWidth="12" fill="none" />
        <circle cx="64" cy="64" r={r} stroke="#22c55e" strokeWidth="12" fill="none"
          strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round" />
      </svg>
      <div className="-mt-20 text-center rotate-0">
        <div className="text-2xl font-bold">{Math.round(value)}</div>
        <div className="text-xs text-neutral-400">/ {max} {unit}</div>
      </div>
      <div className="mt-8 text-sm text-neutral-300">{label}</div>
    </div>
  );
}
