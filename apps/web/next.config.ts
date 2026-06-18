import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile workspace packages so Next.js processes their TypeScript
  transpilePackages: ["@nyupath/engine", "@nyupath/shared"],
  // unpdf uses pdfjs-dist internally which has a web worker that the bundler
  // can't bundle for server routes. Mark both as external so Node.js resolves
  // them at runtime from node_modules instead.
  serverExternalPackages: ["unpdf", "pdfjs-dist"],
  // Use Webpack instead of Turbopack for dev (Turbopack can't resolve
  // ESM .js extension imports in TypeScript packages)
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    // NOTE: client code must NOT import the "@nyupath/engine" barrel — it
    // eagerly pulls server-only modules (schoolConfigLoader/dataLoader →
    // node:fs/url; dpr/fingerprint → node:crypto) that run Node APIs at import
    // time and break the browser bundle. Client modules import the pure,
    // Node-free subset from "@nyupath/engine/client" instead (see
    // packages/engine/src/client.ts). That keeps node: builtins out of the
    // client bundle WITHOUT stubbing them (stubbing turned the compile error
    // into a runtime `fileURLToPath is not a function`), so no resolve.fallback
    // hack is needed here.
    return config;
  },
};

export default nextConfig;
