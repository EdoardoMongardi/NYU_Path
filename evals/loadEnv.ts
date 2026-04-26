// ============================================================
// Pre-load .env.local before any module that reads process.env
// ============================================================
// Imported as a side effect at the top of bakeoff entry scripts:
//   import "./loadEnv.js";
// ESM hoists all imports, so this side-effect import must come first.
// ============================================================

import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// override:true forces .env.local to win over any pre-set env var. The
// Claude Code harness pre-sets ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL to
// route through its own proxy; the user-supplied keys in .env.local must
// take precedence so the bakeoff hits the providers' production APIs
// directly. We also unset ANTHROPIC_BASE_URL to keep the SDK on its
// default endpoint (api.anthropic.com) regardless of harness state.
config({ path: join(REPO_ROOT, ".env.local"), override: true });
delete process.env.ANTHROPIC_BASE_URL;
