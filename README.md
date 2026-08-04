# GitHub ZIP Committer v7 — Git Push

Mobile-first Next.js app that replaces a GitHub repository with a ZIP build using a real Git workflow instead of creating one GitHub REST blob per file.

## Workflow

1. Type the repository name.
2. Choose the ZIP file.
3. Press **Push ZIP to GitHub**.
4. The server shallow-clones `main` into Vercel's writable `/tmp` directory.
5. It replaces the working tree with the ZIP while retaining protected paths not supplied by the ZIP.
6. It creates one local commit and performs one Smart HTTP Git push.

This mirrors the important behavior of GitHub Desktop or `git push` and avoids the REST `git.createBlob` loop that caused GitHub secondary-rate-limit failures.

## True replace behavior

The resulting repository contains:

```text
uploaded ZIP files
+ protected files from the existing repository when the ZIP does not replace them
```

Protected paths:

```text
.github/
.gitignore
vercel.json
docs/
README.md
```

Everything else is removed in the new commit.

The app rejects ZIP path traversal, case-only duplicate paths, and file/folder path collisions.

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
