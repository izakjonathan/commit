import { Octokit } from "@octokit/rest";
import JSZip from "jszip";

export const runtime = "nodejs";

const PRESERVE_PATHS = [
  ".github",
  ".gitignore",
  "vercel.json",
  "docs",
  "README.md"
];

function isPreservedPath(path) {
  return PRESERVE_PATHS.some((preserve) => {
    return path === preserve || path.startsWith(`${preserve}/`);
  });
}
export const maxDuration = 60;

function cleanInput(value) {
  return String(value || "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^\/+|\/+$/g, "");
}

function normalizePath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function isNoise(path) {
  const p = path.toLowerCase();
  return (
    p.includes("__macosx/") ||
    p.endsWith(".ds_store") ||
    p.includes("node_modules/") ||
    p.includes(".git/") ||
    p.includes(".next/")
  );
}

function isBinaryPath(path) {
  return /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|woff|woff2|ttf|otf|mp4|mov|mp3|wav|avif|heic)$/i.test(path);
}

function shouldDeletePath(filePath, deletePaths) {
  return deletePaths.some((path) => {
    const clean = normalizePath(path).replace(/\/$/, "");
    return filePath === clean || filePath.startsWith(`${clean}/`);
  });
}

function uploadPath(path, stripPrefix) {
  const clean = normalizePath(path);
  if (stripPrefix && clean.startsWith(stripPrefix + "/")) {
    return clean.slice(stripPrefix.length + 1);
  }
  return clean;
}


function findCaseOnlyDuplicates(paths) {
  const seen = new Map();
  const duplicates = [];

  for (const path of paths) {
    const key = path.toLowerCase();
    const existing = seen.get(key);
    if (existing && existing !== path) {
      duplicates.push([existing, path]);
    } else if (!existing) {
      seen.set(key, path);
    }
  }

  return duplicates;
}

function githubError(error, context) {
  const status = error.status ? `GitHub status ${error.status}` : "GitHub request failed";
  const message = error.response?.data?.message || error.message || "Unknown error";
  const documentation = error.response?.data?.documentation_url ? `\nDocs: ${error.response.data.documentation_url}` : "";
  const hint = error.status === 404
    ? "Check owner, repository, branch, and token repository access."
    : error.status === 401
      ? "Bad credentials. Check GITHUB_TOKEN in Vercel and redeploy."
      : error.status === 403
        ? "Token lacks permission or rate limit was reached."
        : "";
  return `${context}\n${status}: ${message}${hint ? `\n${hint}` : ""}${documentation}`;
}

async function getRecursiveTree(octokit, owner, repo, treeSha) {
  const tree = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: "true"
  });
  return tree.data.tree || [];
}

async function createBlobItem(octokit, owner, repo, path, buffer) {
  const blob = await octokit.git.createBlob({
    owner,
    repo,
    content: isBinaryPath(path) ? buffer.toString("base64") : buffer.toString("utf8"),
    encoding: isBinaryPath(path) ? "base64" : "utf-8"
  });

  return {
    path,
    mode: "100644",
    type: "blob",
    sha: blob.data.sha
  };
}

export async function POST(request) {
  try {
    if (!process.env.GITHUB_TOKEN) {
      return Response.json({ error: "Missing GITHUB_TOKEN." }, { status: 500 });
    }

    const form = await request.formData();

    const owner = cleanInput(form.get("owner") || "izakjonathan").split("/")[0];
    const repo = cleanInput(form.get("repo")).split("/").filter(Boolean).at(-1);
    const branch = cleanInput(form.get("branch") || "main");
    const message = String(form.get("message") || "").trim();
    const replaceMode = String(form.get("replaceMode") || "full");
    const stripPrefix = normalizePath(form.get("stripPrefix") || "");
    const deletePaths = String(form.get("deletePaths") || "")
      .split(/\r?\n/)
      .map((x) => normalizePath(x.trim()))
      .filter(Boolean);

    const zipFile = form.get("zip");

    if (!owner || !repo || !branch || !message || !zipFile) {
      return Response.json({ error: "Missing owner, repo, branch, message or ZIP." }, { status: 400 });
    }

    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

    let branchData;
    try {
      branchData = await octokit.repos.getBranch({ owner, repo, branch });
    } catch (error) {
      return Response.json({ error: githubError(error, "Branch lookup failed before commit.") }, { status: error.status || 500 });
    }

    const parentCommitSha = branchData.data.commit.sha;

    let parentCommit;
    try {
      parentCommit = await octokit.git.getCommit({ owner, repo, commit_sha: parentCommitSha });
    } catch (error) {
      return Response.json({ error: githubError(error, "Parent commit lookup failed.") }, { status: error.status || 500 });
    }

    const baseTreeSha = parentCommit.data.tree.sha;

    const zipBuffer = Buffer.from(await zipFile.arrayBuffer());
    const zip = await JSZip.loadAsync(zipBuffer);

    const treeItems = [];
    const uploadedPaths = [];

    for (const [relativePath, entry] of Object.entries(zip.files)) {
      const rawPath = normalizePath(relativePath);
      const path = uploadPath(rawPath, stripPrefix);

      if (!path || entry.dir || isNoise(path)) continue;

      const buffer = Buffer.from(await entry.async("uint8array"));
      try {
        const item = await createBlobItem(octokit, owner, repo, path, buffer);
        treeItems.push(item);
        uploadedPaths.push(path);
      } catch (error) {
        return Response.json({ error: githubError(error, `Blob creation failed for ${path}.`) }, { status: error.status || 500 });
      }
    }

    if (!uploadedPaths.length) {
      return Response.json({ error: "ZIP contained no uploadable files." }, { status: 400 });
    }

    const caseDuplicates = findCaseOnlyDuplicates(uploadedPaths);
    if (caseDuplicates.length) {
      const examples = caseDuplicates.slice(0, 5).map(([a, b]) => `${a}  ↔  ${b}`).join("\n");
      return Response.json({
        error: `The ZIP contains files or folders that only differ by upper/lowercase. Vercel/Next.js rejects this because it can corrupt builds on case-insensitive filesystems. Rename or remove one of each pair before committing:\n\n${examples}`
      }, { status: 400 });
    }

    if (replaceMode === "full" && !uploadedPaths.includes("package.json")) {
      return Response.json({ error: "Full Repository Replace requires package.json at repository root after wrapper stripping." }, { status: 400 });
    }

    let newTree;
    let preservedPaths = 0;

    if (replaceMode === "full") {
      // Important: no base_tree. This creates a clean root tree.
      // Protected repository files are copied from the existing tree unless the ZIP replaces them.
      try {
        const existingTree = await getRecursiveTree(octokit, owner, repo, baseTreeSha);
        const uploadedSet = new Set(uploadedPaths);

        for (const item of existingTree) {
          if (
            item.type === "blob" &&
            isPreservedPath(item.path) &&
            !uploadedSet.has(item.path)
          ) {
            treeItems.push({
              path: item.path,
              mode: item.mode || "100644",
              type: "blob",
              sha: item.sha
            });
            preservedPaths += 1;
          }
        }

        newTree = await octokit.git.createTree({
          owner,
          repo,
          tree: treeItems
        });
      } catch (error) {
        return Response.json({ error: githubError(error, "Full replacement tree creation failed.") }, { status: error.status || 500 });
      }
    } else {
      let existingTree;
      try {
        existingTree = await getRecursiveTree(octokit, owner, repo, baseTreeSha);
      } catch (error) {
        return Response.json({ error: githubError(error, "Existing tree lookup failed.") }, { status: error.status || 500 });
      }

      const uploadedSet = new Set(uploadedPaths);

      for (const item of existingTree) {
        if (
          item.type === "blob" &&
          shouldDeletePath(item.path, deletePaths) &&
          !uploadedSet.has(item.path)
        ) {
          treeItems.push({
            path: item.path,
            mode: "100644",
            type: "blob",
            sha: null
          });
        }
      }

      try {
        newTree = await octokit.git.createTree({
          owner,
          repo,
          base_tree: baseTreeSha,
          tree: treeItems
        });
      } catch (error) {
        return Response.json({ error: githubError(error, "Selected replacement tree creation failed.") }, { status: error.status || 500 });
      }
    }

    let newCommit;
    try {
      newCommit = await octokit.git.createCommit({
        owner,
        repo,
        message,
        tree: newTree.data.sha,
        parents: [parentCommitSha]
      });
    } catch (error) {
      return Response.json({ error: githubError(error, "Commit creation failed.") }, { status: error.status || 500 });
    }

    try {
      await octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: newCommit.data.sha
      });
    } catch (error) {
      return Response.json({ error: githubError(error, "Branch update failed.") }, { status: error.status || 500 });
    }

    return Response.json({
      ok: true,
      commitSha: newCommit.data.sha,
      filesUploaded: uploadedPaths.length,
      mode: replaceMode === "full" ? "FULL_REPOSITORY_REPLACE" : "SELECTED_PATH_REPLACE",
      preservedPaths,
      stripPrefix
    });
  } catch (error) {
    return Response.json({
      error: `Unexpected commit error: ${error.message || error}`
    }, { status: 500 });
  }
}
