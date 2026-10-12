import he from "he";
export const HN = "https://news.ycombinator.com";
export const itemLink = (id: number) =>
  `${HN}/item?id=${encodeURIComponent(id)}`;
export const userLink = (author: string) =>
  `${HN}/user?id=${encodeURIComponent(author)}`;
export function articleLink(url: string | null, id: number): string {
  try {
    const parsed = new URL(url ?? "");
    if (["https:", "http:"].includes(parsed.protocol)) return parsed.href;
  } catch {}
  return itemLink(id);
}
export function domain(url: string | null): string | null {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
export const decodeTitle = (text: string) => he.decode(text);
export function age(created: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now / 1000 - created) / 60));
  if (minutes < 60)
    return `${minutes || 1} minute${minutes === 1 || minutes === 0 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
