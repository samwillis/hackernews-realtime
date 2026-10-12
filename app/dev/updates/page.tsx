import { notFound } from "next/navigation";
import { fixture } from "@/lib/fixture";
import { UpdateFixture } from "./update-fixture";
export const dynamic = "force-dynamic";
export default function Page() {
  if (process.env.HN_FIXTURE !== "1" || process.env.NODE_ENV === "production")
    notFound();
  return (
    <UpdateFixture
      initialStories={fixture("top", 1).slice(0, 4)}
      initialNow={Date.now()}
    />
  );
}
