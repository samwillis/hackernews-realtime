import type { Metadata } from "next";
import "./globals.css";
import { LiveProvider } from "./live-session";
export const metadata: Metadata = {
  title: "Hacker Realtime",
  description: "Hacker News, live. Powered by Neon Realtime.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LiveProvider
          fixture={
            process.env.HN_FIXTURE === "1" &&
            process.env.NODE_ENV !== "production"
          }
        >
          {children}
        </LiveProvider>
      </body>
    </html>
  );
}
