import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const route = read("app/api/commit-zip/route.js");
const page = read("app/page.js");

const checks = [
  [
    "the working tree removes every project file except Git metadata",
    route.includes("async function removeWorkingFiles") &&
      route.includes('if (entry.name === ".git") continue;') &&
      !route.includes("PRESERVE_PATHS"),
  ],
  [
    "the uploaded ZIP must contain package.json and package-lock.json",
    route.includes('uploadedPaths.includes("package.json")') &&
      route.includes('uploadedPaths.includes("package-lock.json")'),
  ],
  [
    "the lockfile is validated before commit",
    route.includes("validateProjectFiles(workDir)"),
  ],
  [
    "the push remains a normal non-forced fast-forward",
    route.includes("force: false") && route.includes("singleBranch: true"),
  ],
  [
    "the interface accurately describes an exact ZIP replacement",
    page.includes("commit tree matches the ZIP exactly") &&
      !page.includes("Protected preserved"),
  ],
];

const failures = checks.filter(([, passed]) => !passed).map(([name]) => name);

if (failures.length > 0) {
  console.error("Commit-flow regression checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Commit-flow regression checks passed (${checks.length}).`);
