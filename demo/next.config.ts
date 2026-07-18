import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// The repo root also has a package-lock.json, so Next can't infer the workspace
// root. Pin it to this demo directory to silence the multi-lockfile warning and
// keep local + Vercel builds identical.
const nextConfig: NextConfig = {
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
};

export default nextConfig;
