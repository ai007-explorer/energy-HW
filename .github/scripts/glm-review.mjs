// .github/scripts/glm-review.mjs
// Review PR diffs with Zhipu GLM; write the result to the file path given as the first argument.
// Uses node:https directly (generous timeout + auto-retry for cross-ocean connections), no external deps.
// Env vars:
//   ZHIPUAI_API_KEY  Zhipu API key (required)
//   ZHIPU_BASE_URL   default https://open.bigmodel.cn/api/paas/v4
//   ZHIPU_MODEL      default glm-4.6
//   PR_NUMBER        PR number (optional)
//   META_FILE        PR metadata JSON ({title, body}) path (optional, takes precedence over the two below)
//   PR_TITLE/PR_BODY PR metadata (optional fallback)
//   DIFF_FILE        diff file path (required)

import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";

const apiKey = process.env.ZHIPUAI_API_KEY;
const baseUrl = (process.env.ZHIPU_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, "");
const model = process.env.ZHIPU_MODEL || "glm-5";
const diffFile = process.env.DIFF_FILE;
const outFile = process.argv[2];

if (!apiKey) {
  console.error("ZHIPUAI_API_KEY is not set");
  process.exit(2);
}
if (!diffFile) {
  console.error("DIFF_FILE is not set");
  process.exit(2);
}
if (!outFile) {
  console.error("usage: node glm-review.mjs <output-file>");
  process.exit(2);
}

const diff = readFileSync(diffFile, "utf8");
if (!diff.trim()) {
  console.log("Empty diff, skipping review.");
  writeFileSync(outFile, "");
  process.exit(0);
}

// Prefer reading PR title/body from a metadata JSON (supports issue_comment trigger,
// avoids multiline env issues); fall back to PR_TITLE / PR_BODY env vars.
let prTitle = process.env.PR_TITLE || "";
let prBody = (process.env.PR_BODY || "").slice(0, 2000);
if (process.env.META_FILE) {
  try {
    const meta = JSON.parse(readFileSync(process.env.META_FILE, "utf8"));
    prTitle = prTitle || meta.title || "";
    prBody = prBody || (meta.body || "").slice(0, 2000);
  } catch (e) {
    console.error("Failed to read META_FILE:", e.message);
  }
}
const prNumber = process.env.PR_NUMBER || "(unknown)";

const system =
  "You are a senior Node.js / Express code reviewer reviewing the repository " +
  "ai007-explorer/energy-HW (Huawei Digital Energy competitive intelligence platform energy-intel: " +
  "Node.js ESM + Express, uses @anthropic-ai/sdk for competitor analysis, node-cron for scheduled crawling/sending, " +
  "resend for email, deployed on Railway). " +
  "Give actionable, specific feedback only on this diff; avoid generic statements.";

const user = `Please review the code changes of the following Pull Request.

PR #${prNumber}: ${prTitle}
${prBody ? `\nPR description:\n${prBody}\n` : ""}
Diff:
\`\`\`diff
${diff}
\`\`\`

Review focus (project-specific):
1. Security: never hardcode ANTHROPIC_API_KEY, Resend API keys, auth tokens, or subscriber emails; logs and errors must not leak secrets or personal data.
2. Correctness: Express routes and middleware, async error handling (avoid uncaught rejections crashing the process), Anthropic SDK calls and timeouts.
3. Scheduled tasks: node-cron expressions (Beijing time vs UTC), crawl/send ordering, failure retry and dedup (avoid duplicate emails).
4. Data compatibility: impact of changes to projection.json / subscriber data structures on existing data; field consistency between gen_projection.py and server.js.
5. Robustness: external API failures, missing Railway env vars, edge cases (empty subscriber list / empty competitor feed).
6. Maintainability: naming, duplication, obvious simplifications.

Output format (concise Markdown, English):
- **Summary**: 1-2 sentences on what this PR does.
- **Findings**: group as 🔴Must fix / 🟡Suggested / 🟢Looks good; each with file:line and rationale; omit levels with no issues.
- Focus only on this diff; keep a friendly tone.`;

const payload = {
  model,
  messages: [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  temperature: 0.2,
  max_tokens: 1500,
};

// node:https direct connection with overall timeout; handshake not bound by undici's default 10s limit.
function postChat(timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + "/chat/completions");
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, data }));
      }
    );
    const timer = setTimeout(() => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on("close", () => clearTimeout(timer));
    req.write(body);
    req.end();
  });
}

const MAX_ATTEMPTS = 4;
let result;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    result = await postChat(180000);
    break;
  } catch (err) {
    console.error(`Attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
    if (attempt === MAX_ATTEMPTS) {
      console.error("Max retries reached, giving up.");
      console.error(
        "Troubleshooting: if errors are consistently timeout/ECONNRESET, it is usually unstable cross-ocean " +
          "connectivity from the GitHub runner (US) to open.bigmodel.cn.\n" +
          "Re-run the workflow; if it persists long-term, consider a self-hosted runner or a proxy."
      );
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, attempt * 4000));
  }
}

if (result.status >= 400) {
  console.error(`Zhipu API returned ${result.status}: ${result.data.slice(0, 500)}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(result.data);
} catch {
  console.error("Cannot parse response JSON:", result.data.slice(0, 500));
  process.exit(1);
}

const content = data?.choices?.[0]?.message?.content?.trim() || "";
if (!content) {
  console.error("GLM returned empty content:", JSON.stringify(data).slice(0, 500));
  process.exit(1);
}

const body = `### 🤖 GLM Code Review (\`${model}\`)

${content}
`;
writeFileSync(outFile, body, "utf8");
console.log(`Review done, written to ${outFile} (${content.length} chars)`);
