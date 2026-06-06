"use client";

import { useMemo, useState } from "react";
import JSZip from "jszip";

const DEFAULT_OWNER = "izakjonathan";
const DEFAULT_BRANCH = "main";
const DEFAULT_MESSAGE = "Replace project with latest ZIP build";
const DEFAULT_DELETE = ["app", "components", "data", "public"];

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
  const [zipFile, setZipFile] = useState(null);
  const [files, setFiles] = useState([]);
  const [stripPrefix, setStripPrefix] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const normalizedOwner = DEFAULT_OWNER;
  const normalizedRepo = cleanInput(repo).split("/").filter(Boolean).at(-1) || "";
  const normalizedBranch = DEFAULT_BRANCH;

  const summary = useMemo(() => {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const folders = new Set(files.map((file) => file.path.split("/")[0]).filter(Boolean));
    const hasPackageJson = files.some((file) => file.path === "package.json");
    return { total, folders: folders.size, hasPackageJson };
  }, [files]);

  async function handleZip(file) {
    setZipFile(file || null);
    setFiles([]);
    setStripPrefix("");
    setStatus("");

    if (!file) return;

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
    } catch (error) {
      setStatus(`Could not read ZIP: ${error.message}`);
    }
  }

  async function commitZip() {
    if (!normalizedRepo || !zipFile) {
      setStatus("Add the repository name and choose a ZIP first.");
      return;
    }

    if (!summary.hasPackageJson) {
      setStatus("The ZIP needs package.json at the root. If your ZIP has one wrapper folder, this app strips it automatically.");
      return;
    }

    setBusy(true);
    setStatus("Uploading ZIP and creating GitHub commit...");

    try {
      const form = new FormData();
      form.append("owner", normalizedOwner);
      form.append("repo", normalizedRepo);
      form.append("branch", normalizedBranch);
      form.append("message", DEFAULT_MESSAGE);
      form.append("replaceMode", "full");
      form.append("stripPrefix", stripPrefix);
      form.append("deletePaths", DEFAULT_DELETE.join("\n"));
      form.append("zip", zipFile);

      const res = await fetch("/api/commit-zip", {
        method: "POST",
        body: form
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Commit failed.");

      setStatus(
        `SUCCESS\n\nRepository: ${normalizedOwner}/${normalizedRepo}\nBranch: ${normalizedBranch}\nCommit: ${data.commitSha}\nFiles uploaded: ${data.filesUploaded}\nMode: ${data.mode}\nProtected paths preserved: ${data.preservedPaths || 0}\nStripped wrapper: ${data.stripPrefix || "none"}\n\nVercel should deploy automatically if connected.`
      );
    } catch (error) {
      setStatus(`ERROR\n\n${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="kicker">ZIP → GitHub Commit</div>
      <h1>Commit ZIP</h1>
      <p>
        Owner is fixed to <b>{DEFAULT_OWNER}</b>. Enter the repo name, choose your ZIP and press commit.
      </p>

      <section className="card">
        <h2>1. Repository</h2>
        <label>Repository name</label>
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="portfolio2"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck="false"
        />
        <small>Commits to {DEFAULT_OWNER}/{normalizedRepo || "repo-name"}:{DEFAULT_BRANCH}</small>
      </section>

      <section className="card">
        <h2>2. ZIP</h2>
        <input type="file" accept=".zip,application/zip" onChange={(e) => handleZip(e.target.files?.[0])} />

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
              <div className="stat"><b>{summary.hasPackageJson ? "Yes" : "No"}</b><span>package.json</span></div>
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
        <h2>3. Commit</h2>
        <p>
          This replaces the project with the ZIP contents on <b>{DEFAULT_BRANCH}</b>, while preserving protected repository files like .github, .gitignore, vercel.json, docs and README.md when they already exist.
        </p>
        <div className="actions">
          <button disabled={busy || !zipFile || !normalizedRepo} onClick={commitZip}>
            {busy ? "Committing..." : "Commit ZIP to GitHub"}
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
