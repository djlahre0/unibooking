import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// `unibooking` is linked from the repo root via `file:..`, which npm installs
// as a symlink. Turbopack will not resolve modules outside its root, so the
// root must be the repository, not this directory — pinning it to `demo/`
// makes every `unibooking` import fail to resolve at build time.
const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  },
};

export default nextConfig;
