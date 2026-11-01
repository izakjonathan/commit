"use client";

import { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import { MAX_ZIP_BYTES, CHUNK_BYTES } from "../lib/upload-limits.mjs";

const DEFAULT_OWNER = "izakjonathan";
const DEFAULT_BRANCH = "main";
const DEFAULT_MESSAGE = "Replace project with latest ZIP build";

const RECENT_REPOS_KEY = "github-zip-committer:recent-repos:v1";

function repositoryName(value) {
  const parts = cleanInput(value).split("/").filter(Boolean);
  const name = (parts[0]?.toLowerCase() === DEFAULT_OWNER.toLowerCase()
    ? parts[1] : parts[0])?.replace(/\.git$/i, "") || "";
  return /^[A-Za-z0-9_.-]+$/.test(name) && name !== "." && name !== ".." ? name : "";
}

function normalizeRecentRepos(values) {
  if (!Array.isArray(values)) return [];
  const names = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const name = repositoryName(value);
    if (name && !names.some((existing) => existing.toLowerCase() === name.toLowerCase())) names.push(name);
    if (names.length === 3) break;
  }
  return names;
}

function readRecentRepos() {
  try { return normalizeRecentRepos(JSON.parse(window.localStorage.getItem(RECENT_REPOS_KEY) || "[]")); }
  catch { return []; }
}

async function readResponse(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Request failed (${response.status}). Please retry the upload.`); }
}

function cleanInput(value) {
  return String(value || "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^\/+|\/+$/g, "");
}

function cleanPath(path) {
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

function getUploadPath(path, stripPrefix) {
  const clean = cleanPath(path);
  if (stripPrefix && clean.startsWith(stripPrefix + "/")) {
    return clean.slice(stripPrefix.length + 1);
  }
  return clean;
}

function detectWrapperFolder(paths) {
  const files = paths.filter(Boolean);
  const hasRootPackage = files.includes("package.json");
  if (hasRootPackage) return "";

  const firstSegments = files
    .map((p) => p.split("/")[0])
    .filter(Boolean);

  const unique = [...new Set(firstSegments)];
  if (unique.length !== 1) return "";

  const wrapper = unique[0];
  if (files.includes(`${wrapper}/package.json`)) return wrapper;
  return "";
}

function formatSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function Home() {
  const [repo, setRepo] = useState("");
  const [recentRepos, setRecentRepos] = useState([]);

  useEffect(() => {
    setRecentRepos(readRecentRepos());
    function syncHistory(event) {
      if (event.key === RECENT_REPOS_KEY || event.key === null) setRecentRepos(readRecentRepos());
    }
    window.addEventListener("storage", syncHistory);
    return () => window.removeEventListener("storage", syncHistory);
  }, []);

  function rememberRepository(name) {
    const next = normalizeRecentRepos([name, ...readRecentRepos(), ...recentRepos]);
    setRecentRepos(next);
    try { window.localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(next)); }
    catch { /* Shortcuts still work for this session if storage is unavailable. */ }
  }
  const [zipFile, setZipFile] = useState(null);
  const [files, setFiles] = useState([]);
  const [stripPrefix, setStripPrefix] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const normalizedOwner = DEFAULT_OWNER;
  const normalizedRepo = repositoryName(repo);
  const normalizedBranch = DEFAULT_BRANCH;

  const summary = useMemo(() => {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const folders = new Set(files.map((file) => file.path.split("/")[0]).filter(Boolean));
    const hasPackageJson = files.some((file) => file.path === "package.json");
    const hasPackageLock = files.some((file) => file.path === "package-lock.json");
    return { total, folders: folders.size, hasPackageJson, hasPackageLock };
  }, [files]);

  async function handleZip(file) {
    setZipFile(null);
    setFiles([]);
    setStripPrefix("");
    setStatus("");

    if (!file) return;
    if (file.size > MAX_ZIP_BYTES) {
      setStatus("ZIP files must be 50 MB or smaller.");
      return;
    }

    try {
      const zip = await JSZip.loadAsync(file);
      const rawFiles = [];

      zip.forEach((relativePath, entry) => {
        const path = cleanPath(relativePath);
        if (!entry.dir && !isNoise(path)) {
          rawFiles.push({
            rawPath: path,
            path,
            size: entry._data?.uncompressedSize || 0
          });
        }
      });

      const wrapper = detectWrapperFolder(rawFiles.map((file) => file.path));
      setStripPrefix(wrapper);

      const next = rawFiles
        .map((file) => ({
          ...file,
          path: getUploadPath(file.rawPath, wrapper)
        }))
        .filter((file) => file.path && !isNoise(file.path))
        .sort((a, b) => a.path.localeCompare(b.path));

      setFiles(next);
      setZipFile(file);
    } catch (error) {
      setStatus(`Could not read ZIP: ${error.message}`);
    }
  }

  async function commitZip() {
    if (!normalizedRepo || !zipFile) {
      setStatus("Add the repository name and choose a ZIP first.");
      return;
    }

    if (!summary.hasPackageJson || !summary.hasPackageLock) {
      setStatus("The ZIP needs valid package.json and package-lock.json files at the root. If it has one wrapper folder, this app strips it automatically.");
      return;
    }

    setBusy(true);
    setStatus("Cloning repository, creating one Git commit and pushing...");

    try {
      const chunks = [];
      const count = Math.ceil(zipFile.size / CHUNK_BYTES);
      for (let i = 0; i < count; i++) {
        setStatus(`Uploading ZIP: ${Math.round(i / count * 100)}% (${i + 1}/${count})`);
        const response = await fetch(`/api/upload-chunk?repo=${encodeURIComponent(normalizedRepo)}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: zipFile.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)
        });
        const result = await readResponse(response);
        if (!response.ok) throw new Error(result.error || "ZIP upload failed. Please retry.");
        chunks.push(result);
      }
      setStatus("ZIP uploaded: 100%. Verifying ZIP, cloning repository and pushing one commit...");
      const res = await fetch("/api/commit-zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: normalizedRepo, branch: normalizedBranch,
          message: DEFAULT_MESSAGE, stripPrefix, chunks, size: zipFile.size })
      });

      const data = await readResponse(res);
      if (!res.ok) throw new Error(data.error || "Commit failed.");
      rememberRepository(normalizedRepo);

      setStatus(
        `SUCCESS\n\nRepository: ${normalizedOwner}/${normalizedRepo}\nBranch: ${normalizedBranch}\nCommit: ${data.commitSha}\nTransport: ${data.mode}\n\nAdded: ${data.addedPaths || 0}\nUpdated: ${data.updatedPaths || 0}\nUnchanged from ZIP: ${data.unchangedUploadedPaths || 0}\nDeleted from repo: ${data.deletedPaths || 0}\nFiles uploaded: ${data.filesUploaded}\nStripped wrapper: ${data.stripPrefix || "none"}\n\nThe commit tree matches the ZIP exactly. Vercel should deploy automatically if connected.`
      );
    } catch (error) {
      setStatus(`ERROR\n\n${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="kicker">ZIP → Git Push</div>
      <h1>Push ZIP</h1>

      <section className="card">
        <h2>1. Repository</h2>
        {recentRepos.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <label>Recent repositories</label>
            <div className="actions" role="group" aria-label="Recent repositories" style={{ marginTop: 0 }}>
              {recentRepos.map((name) => (
                <button
                  key={name.toLowerCase()}
                  type="button"
                  className={normalizedRepo.toLowerCase() === name.toLowerCase() ? undefined : "secondary"}
                  disabled={busy}
                  aria-pressed={normalizedRepo.toLowerCase() === name.toLowerCase()}
                  onClick={() => setRepo(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}
        <label htmlFor="repository-name">Repository name (or type manually)</label>
        <input
          id="repository-name"
          disabled={busy}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="blaa"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck="false"
        />
        <small>Creates one non-forced commit on {DEFAULT_OWNER}/{normalizedRepo || "repo-name"}:{DEFAULT_BRANCH}</small>
      </section>

      <section className="card">
        <h2>2. ZIP</h2>
        <input disabled={busy} type="file" accept=".zip,application/zip" onChange={(e) => handleZip(e.target.files?.[0])} />
        <small>ZIP files up to 50 MB. Upload progress is shown below.</small>

        {stripPrefix && (
          <div className="warning" style={{ marginTop: 14 }}>
            Detected wrapper folder: <b>{stripPrefix}</b>. It will be stripped so files upload to repository root.
          </div>
        )}

        {!!files.length && (
          <>
            <div className="stat-grid" style={{ marginTop: 14 }}>
              <div className="stat"><b>{files.length}</b><span>Files</span></div>
              <div className="stat"><b>{formatSize(summary.total)}</b><span>Total size</span></div>
              <div className="stat"><b>{summary.hasPackageJson && summary.hasPackageLock ? "Yes" : "No"}</b><span>Validated npm files</span></div>
            </div>
            <div className="file-list" style={{ marginTop: 14 }}>
              {files.slice(0, 250).map((file) => (
                <div className="file-row" key={file.path}>
                  <span>{file.path}</span>
                  <span className="file-size">{formatSize(file.size)}</span>
                </div>
              ))}
              {files.length > 250 && <div className="file-row">...and {files.length - 250} more files</div>}
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>3. Git push</h2>
        <div className="actions">
          <button disabled={busy || !zipFile || !normalizedRepo} onClick={commitZip}>
            {busy ? "Pushing..." : "Push ZIP to GitHub"}
          </button>
          <button className="secondary" onClick={() => setStatus("")}>Clear status</button>
        </div>
      </section>

      {status && <section className="card"><pre className="status">{status}</pre></section>}

      <section className="warning">
        Keep your GitHub token private. Do not make this app public unless you add authentication.
      </section>
    </main>
  );
}
