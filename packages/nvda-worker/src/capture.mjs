// capture.mjs — standalone NVDA capture CLI.
// Usage: node capture.mjs <url> <outFile> [steps]
// MUST run in an interactive desktop session (NVDA needs a real desktop).
import { writeFileSync } from "node:fs";
import { captureWithNvda } from "./capture-core.mjs";

async function main() {
  const url = process.argv[2] || "https://example.com";
  const outFile = process.argv[3] || "transcript.json";
  const steps = Number(process.argv[4] || 150);

  console.log("capturing", url);
  const result = await captureWithNvda(url, { steps });
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log("WROTE", outFile, "-", result.transcript.length, "phrases");
}

main().catch((e) => { console.error("CAPTURE_ERROR", (e && e.stack) || e); process.exitCode = 1; });
