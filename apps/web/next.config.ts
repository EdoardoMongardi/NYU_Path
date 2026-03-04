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
    return config;
  },
};

export default nextConfig;
