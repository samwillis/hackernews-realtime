import { defineConfig } from "@neon/config";
// Keep schedules disabled in the shared policy, including preview checkouts.
// ingest:deploy enables only the explicit project/branch in .env.local.
export default defineConfig({
  preview: {
    realtime: {
      allowedOrigins: [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        ...(process.env.DEMO_ORIGIN ? [process.env.DEMO_ORIGIN] : []),
        ...(process.env.DEMO_ADDITIONAL_ORIGINS?.split(",").filter(Boolean) ??
          []),
      ],
    },
  },
  functions: {
    hningest: {
      name: "Hacker News ingestion",
      source: "./functions/ingest.ts",
      env: {
        INGEST_REQUEST_BUDGET_MS:
          process.env.INGEST_REQUEST_BUDGET_MS ?? "240000",
        INGEST_TENURE_MS: process.env.INGEST_TENURE_MS ?? "120000",
        INGEST_OVERLAP_MS: process.env.INGEST_OVERLAP_MS ?? "90000",
        INGEST_SMOOTHING_MS: process.env.INGEST_SMOOTHING_MS ?? "28000",
      },
    },
  },
  triggers: {
    hnminute: {
      type: "schedule",
      function: "hningest",
      cron: "* * * * *",
      enabled: false,
    },
  },
  branch: () => ({ functions: { hningest: { runtime: "nodejs24" } } }),
});
