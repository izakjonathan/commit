import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import JSZip from "jszip";
import { restoreZip, validateChunks } from "../../../lib/zip-upload.mjs";

export const runtime = "nodejs";
export const maxDuration = 300;

const DEFAULT_OWNER = "izakjonathan";
const DEFAULT_BRANCH = "main";
const DEFAULT_AUTHOR_NAME = "GitHub ZIP Committer";
const DEFAULT_AUTHOR_EMAIL = "github-zip-committer@users.noreply.github.com";

function cleanInput(value) {
  return String(value || "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^\/+|\/+$/g, "");
}

function normalizePath(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function isNoise(filePath) {
  const p = filePath.toLowerCase();
  return (
    p.includes("__macosx/") ||
    p.endsWith(".ds_store") ||
    p.includes("node_modules/") ||
    p.includes(".git/") ||
    p.includes(".next/")
  );
}

function uploadPath(filePath, stripPrefix) {
  const clean = normalizePath(filePath);
  if (stripPrefix && clean.startsWith(stripPrefix + "/")) {
    return clean.slice(stripPrefix.length + 1);
  }
  return clean;
}

function findCaseOnlyDuplicates(paths) {
  const seen = new Map();
  const duplicates = [];

  for (const filePath of paths) {
    const key = filePath.toLowerCase();
    const existing = seen.get(key);
    if (existing && existing !== filePath) {
      duplicates.push([existing, filePath]);
    } else if (!existing) {
      seen.set(key, filePath);
    }
  }

  return duplicates;
}

function findPathCollisions(paths) {
  const pathSet = new Set(paths);
  const collisions = [];

  for (const filePath of paths) {
    const parts = filePath.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join("/");
      if (pathSet.has(parent)) collisions.push([parent, filePath]);
    }
  }

  return collisions;
}

function safeDestination(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(root, relativePath);
  if (destination !== resolvedRoot && !destination.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe ZIP path rejected: ${relativePath}`);
  }
  return destination;
}

async function removeWorkingFiles(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git") continue;
    await fs.promises.rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

async function validateProjectFiles(dir) {
  const packagePath = path.join(dir, "package.json");
  const lockPath = path.join(dir, "package-lock.json");

  try {
    JSON.parse(await fs.promises.readFile(packagePath, "utf8"));
  } catch {
    throw new Error("package.json must be valid JSON.");
  }

  try {
    const lock = JSON.parse(await fs.promises.readFile(lockPath, "utf8"));
    if (!Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 1) {
      throw new Error("package-lock.json does not contain a supported lockfileVersion.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("supported lockfileVersion")) throw error;
    throw new Error("package-lock.json must be present and valid JSON. Create the ZIP from a verified npm project.");
  }
}

function gitError(error, context) {
  const message = error?.data?.response || error?.message || String(error);
  const status = error?.statusCode ? `Git status ${error.statusCode}` : "Git operation failed";
  const hint = /401|authentication|credentials/i.test(message)
    ? "Check GITHUB_TOKEN and its repository Contents write permission."
    : /403|permission|protected branch/i.test(message)
      ? "Check token permission, branch protection, and whether the token may push to this repository."
      : /non-fast-forward|fetch first/i.test(message)
        ? "The branch changed during this upload. Retry once using the latest branch state."
        : "";
  return `${context}\n${status}: ${message}${hint ? `\n${hint}` : ""}`;
}

function auth() {
  return {
    username: process.env.GITHUB_TOKEN,
    password: "x-oauth-basic"
  };
}

export async function POST(request) {
  let workDir = "";

  try {
    if (!process.env.GITHUB_TOKEN) {
      return Response.json({ error: "Missing GITHUB_TOKEN." }, { status: 500 });
    }

    const body = await request.json();
    const owner = DEFAULT_OWNER;
    const repo = cleanInput(body.repo).split("/").filter(Boolean).at(-1);
    const branch = cleanInput(body.branch || DEFAULT_BRANCH);
    const message = String(body.message || "Replace project with latest ZIP build").trim();
    const stripPrefix = normalizePath(body.stripPrefix || "");
    if (!repo || !branch || !message) {
      return Response.json({ error: "Missing repo, branch or message." }, { status: 400 });
    }
    let zipBuffer;
    try {
      validateChunks(repo, body.chunks, body.size);
      zipBuffer = await restoreZip(repo, body.chunks, body.size);
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }

    workDir = path.join(os.tmpdir(), `github-zip-${crypto.randomUUID()}`);
    await fs.promises.mkdir(workDir, { recursive: true });

    const remoteUrl = `https://github.com/${owner}/${repo}.git`;

    try {
      await git.clone({
        fs,
        http,
        dir: workDir,
        url: remoteUrl,
        ref: branch,
        singleBranch: true,
        depth: 1,
        noTags: true,
        onAuth: auth
      });
    } catch (error) {
      return Response.json({ error: gitError(error, "Repository clone failed before commit.") }, { status: error.statusCode || 500 });
    }

    await removeWorkingFiles(workDir);

    const zip = await JSZip.loadAsync(zipBuffer);
    const uploadedPaths = [];

    for (const [relativePath, entry] of Object.entries(zip.files)) {
      const rawPath = normalizePath(relativePath);
      const filePath = uploadPath(rawPath, stripPrefix);

      if (!filePath || entry.dir || isNoise(filePath)) continue;
      uploadedPaths.push(filePath);
    }

    if (!uploadedPaths.length) {
      return Response.json({ error: "ZIP contained no uploadable files." }, { status: 400 });
    }

    const caseDuplicates = findCaseOnlyDuplicates(uploadedPaths);
    if (caseDuplicates.length) {
      const examples = caseDuplicates.slice(0, 5).map(([a, b]) => `${a}  ↔  ${b}`).join("\n");
      return Response.json({
        error: `The ZIP contains files or folders that only differ by upper/lowercase. Rename or remove one of each pair before committing:\n\n${examples}`
      }, { status: 400 });
    }

    const pathCollisions = findPathCollisions(uploadedPaths);
    if (pathCollisions.length) {
      const examples = pathCollisions.slice(0, 5).map(([a, b]) => `${a}  conflicts with  ${b}`).join("\n");
      return Response.json({
        error: `The ZIP contains file/folder path conflicts:\n\n${examples}`
      }, { status: 400 });
    }

    if (!uploadedPaths.includes("package.json") || !uploadedPaths.includes("package-lock.json")) {
      return Response.json({ error: "A verified replacement ZIP requires package.json and package-lock.json at repository root after wrapper stripping." }, { status: 400 });
    }

    for (const [relativePath, entry] of Object.entries(zip.files)) {
      const rawPath = normalizePath(relativePath);
      const filePath = uploadPath(rawPath, stripPrefix);
      if (!filePath || entry.dir || isNoise(filePath)) continue;

      const destination = safeDestination(workDir, filePath);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.writeFile(destination, Buffer.from(await entry.async("uint8array")));
    }

    await validateProjectFiles(workDir);

    const uploadedSet = new Set(uploadedPaths);

    const statusMatrix = await git.statusMatrix({ fs, dir: workDir });
    let addedPaths = 0;
    let updatedPaths = 0;
    let deletedPaths = 0;
    let unchangedUploadedPaths = 0;

    for (const [filePath, head, workdir, stage] of statusMatrix) {
      if (head === 0 && workdir === 2) addedPaths += 1;
      else if (head === 1 && workdir === 0) deletedPaths += 1;
      else if (head === 1 && workdir === 2) updatedPaths += 1;
      else if (head === 1 && workdir === 1 && uploadedSet.has(filePath)) unchangedUploadedPaths += 1;

      if (workdir === 0) {
        await git.remove({ fs, dir: workDir, filepath: filePath });
      } else if (head !== workdir || stage !== workdir) {
        await git.add({ fs, dir: workDir, filepath: filePath });
      }
    }

    if (addedPaths + updatedPaths + deletedPaths === 0) {
      const currentSha = await git.resolveRef({ fs, dir: workDir, ref: "HEAD" });
      return Response.json({
        ok: true,
        owner,
        repo,
        branch,
        commitSha: currentSha,
        filesUploaded: uploadedPaths.length,
        mode: "EXACT_GIT_PUSH_NO_CHANGES",
        addedPaths,
        updatedPaths,
        unchangedUploadedPaths,
        deletedPaths,
        stripPrefix
      });
    }

    const commitSha = await git.commit({
      fs,
      dir: workDir,
      message,
      author: {
        name: process.env.GIT_AUTHOR_NAME || DEFAULT_AUTHOR_NAME,
        email: process.env.GIT_AUTHOR_EMAIL || DEFAULT_AUTHOR_EMAIL
      }
    });

    try {
      await git.push({
        fs,
        http,
        dir: workDir,
        remote: "origin",
        ref: branch,
        remoteRef: branch,
        force: false,
        onAuth: auth
      });
    } catch (error) {
      return Response.json({ error: gitError(error, "Git push failed after local commit.") }, { status: error.statusCode || 500 });
    }

    return Response.json({
      ok: true,
      owner,
      repo,
      branch,
      commitSha,
      filesUploaded: uploadedPaths.length,
      mode: "EXACT_NON_FORCED_GIT_PUSH",
      addedPaths,
      updatedPaths,
      unchangedUploadedPaths,
      deletedPaths,
      stripPrefix
    });
  } catch (error) {
    return Response.json({
      error: `Unexpected commit error: ${error.message || error}`
    }, { status: 500 });
  } finally {
    if (workDir) {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
