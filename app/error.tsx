"use client";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <main className="hn-page">
      <header className="hn-header">
        <strong>Hacker News</strong>
      </header>
      <p className="empty">
        The live feed is temporarily unavailable.{" "}
        <button onClick={reset}>Try again</button> or{" "}
        <a href="https://news.ycombinator.com">read Hacker News</a>.
      </p>
    </main>
  );
}
