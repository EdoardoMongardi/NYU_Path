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
  webpack: (config, { isServer, webpack }) => {
    config.resolve = config.resolve || {};
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    // The @nyupath/engine barrel (src/index.ts) re-exports server-only modules
    // (dpr/fingerprint.ts → "node:crypto"; catalog/RAG loaders → "node:fs", etc.).
    // Several CLIENT modules (e.g. lib/wizard/homeSchool.ts → SCHOOL_DISPLAY_NAMES,
    // lib/scenarios/scheduleDiff.ts → canonicalizeCourseId) import OTHER symbols
    // from that barrel, which dragged those node: builtins into the client bundle
    // and 500'd /chat with an UnhandledSchemeError (the engine has no
    // `sideEffects:false`, so the unused server re-exports aren't tree-shaken).
    // Those server-only code paths (computeDprFingerprint, loadCourses, RAG setup,
    // …) are NEVER executed in the browser — only their pure-data/pure-fn siblings
    // are — so stub Node core modules out of the CLIENT bundle: rewrite the `node:`
    // scheme to the bare specifier, then resolve each builtin to an empty module
    // client-side. The SERVER bundle is untouched (isServer), so the real
    // fingerprint/catalog calls in /api/* + orchestrator still work.
    if (!isServer) {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
          resource.request = resource.request.replace(/^node:/, "");
        }),
      );
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        crypto: false, fs: false, path: false, os: false, stream: false,
        util: false, url: false, zlib: false, http: false, https: false,
        net: false, tls: false, child_process: false, async_hooks: false,
        buffer: false, events: false, assert: false, querystring: false,
      };
    }
    return config;
  },
};

export default nextConfig;
