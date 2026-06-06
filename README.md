# GitHub ZIP Committer

Mobile-first app for committing a ZIP build directly to GitHub.

## Current workflow

1. Type the repository name.
2. Choose the ZIP file.
3. Press **Commit ZIP to GitHub**.

The GitHub owner is fixed to `izakjonathan`. The app commits to the `main` branch and uses a default commit message automatically.

## v6 true replace mode

The repository is rebuilt from the ZIP contents on each commit.

The new GitHub tree contains only:

```text
uploaded ZIP files
+ protected files copied from the existing repo when the ZIP does not replace them
```

Everything else in the repo is removed from the new commit.

Protected paths:

```text
.github/
.gitignore
vercel.json
docs/
README.md
```

The app also blocks ZIPs with case-only duplicate paths, because Vercel/Next.js can fail on paths like:

```text
app/api/check-repo/route.js
app/api/Check-repo/route.js
```

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Add your token to `.env.local`:

```bash
GITHUB_TOKEN=github_pat_...
```

GitHub token permissions:

- Contents: Read and write
- Metadata: Read
