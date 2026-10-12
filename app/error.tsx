"use client";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <main className="hn-page">
      <header className="hn-header">
        <a href="/" className="logo" aria-label="Hacker Realtime home">
          RT
        </a>
        <a href="/" className="site-title">
          Hacker Realtime
        </a>
      </header>
      <p className="empty">
        The live page is temporarily unavailable.{" "}
        <button onClick={reset}>Try again</button> or{" "}
        <a href="https://news.ycombinator.com">read Hacker News</a>.
      </p>
    </main>
  );
}
