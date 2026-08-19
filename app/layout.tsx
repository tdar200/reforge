import "./globals.css";
import { BottomNav } from "@/components/BottomNav";
import { SwRegister } from "@/components/SwRegister";

export const metadata = { title: "Reforge", description: "Personal fitness tracker" };
export const viewport = { themeColor: "#0a0a0a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head><link rel="manifest" href="/manifest.webmanifest" /></head>
      <body className="min-h-dvh pb-16">
        {children}
        <BottomNav />
        <SwRegister />
      </body>
    </html>
  );
}
