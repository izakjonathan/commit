# GitHub ZIP Committer v7.0.2 — Exact Git Push

Mobile-first Next.js app that creates one normal, non-forced Git commit from a verified ZIP build. The resulting repository tree matches the ZIP exactly.

## Workflow

1. Type the repository name.
2. Choose the ZIP file.
3. Press **Push ZIP to GitHub**.
4. The server shallow-clones `main` into Vercel's writable `/tmp` directory.
5. It removes all current working-tree files except Git metadata, then writes the ZIP exactly.
6. It creates one local commit and performs one Smart HTTP Git push.

This mirrors the important behavior of GitHub Desktop or `git push` and avoids the REST `git.createBlob` loop that caused GitHub secondary-rate-limit failures.

## Exact replacement behavior

The resulting repository contains:

```text
uploaded ZIP files only
```

No application files are preserved from the existing repository. This prevents stale configuration—such as an old `vercel.json` Cron—from surviving a newer ZIP that intentionally omits it.

The ZIP must contain valid `package.json` and `package-lock.json` at its project root. The app rejects malformed lockfiles before it creates a commit.

The app rejects ZIP path traversal, case-only duplicate paths, file/folder path collisions, and invalid npm project metadata.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Required:

```bash
GITHUB_TOKEN=github_pat_...
```

Optional commit identity:

```bash
GITHUB_USERNAME=izakjonathan
GIT_AUTHOR_NAME="Izak Hyllested"
GIT_AUTHOR_EMAIL="YOUR_GITHUB_NOREPLY_EMAIL"
```

GitHub token permissions:

- Contents: Read and write
- Metadata: Read

The token must be allowed to push to the target branch. Branch protection rules can still reject the push.

## Vercel constraints

- Uses the Node.js runtime, not Edge.
- Uses ephemeral writable `/tmp` storage.
- Uses a shallow single-branch clone to minimize disk, network, and execution time.
- The combined repository checkout and ZIP must fit within the available `/tmp` space and function duration.

## Security

Keep the app private or add authentication before public deployment. The GitHub token remains server-side and must never be exposed to the browser.


## Vercel build hotfix

The Node HTTP client is imported from the public package export `isomorphic-git/http/node`. Do not append `/index.js`; modern package export maps reject that internal path during Next.js builds.
