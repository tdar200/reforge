"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
const tabs = [
  { href: "/", label: "Today" },
  { href: "/workout", label: "Workout" },
  { href: "/diet", label: "Diet" },
  { href: "/body", label: "Body" },
  { href: "/settings", label: "Settings" },
];
export function BottomNav() {
  const path = usePathname();
  if (path === "/login") return null;
  return (
    <nav className="fixed bottom-0 inset-x-0 grid grid-cols-5 border-t border-neutral-800 bg-neutral-900">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href}
          className={`py-3 text-center text-xs ${path === t.href ? "text-green-400" : "text-neutral-400"}`}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
