import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Hacker Realtime",
  description: "Hacker News, live. Powered by Neon Realtime.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
