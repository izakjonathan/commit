# GitHub ZIP Committer

Mobile-first app for committing a ZIP build directly to GitHub.

## Current workflow

1. Type the repository name.
2. Choose the ZIP file.
3. Press **Commit ZIP to GitHub**.

The GitHub owner is set to `izakjonathan` by default. The app commits to the `main` branch and uses a default commit message automatically.

## Protected paths during replacement

During Full Repository Replace, the app preserves these existing repository paths unless the uploaded ZIP explicitly contains replacements for them:

```text
.github/
.gitignore
vercel.json
docs/
README.md
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
