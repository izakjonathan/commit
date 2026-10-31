import crypto from 'node:crypto';
import { MAX_ZIP_BYTES, CHUNK_BYTES } from './upload-limits.mjs';

export function validateRepo(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..') {
    throw new Error('Invalid repository name.');
  }
  return repo;
}

async function github(repo, suffix, options = {}) {
  const response = await fetch(`https://api.github.com/repos/izakjonathan/${validateRepo(repo)}/git/blobs${suffix}`, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
    cache: 'no-store'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`GitHub upload storage: ${data.message || response.status}`);
  return data;
}

function signature(payload) {
  return crypto.createHmac('sha256', process.env.GITHUB_TOKEN).update(payload).digest('hex');
}

export async function stageChunk(repo, bytes) {
  validateRepo(repo);
  if (!bytes.length || bytes.length > CHUNK_BYTES) throw new Error('Invalid upload chunk size.');
  const blob = await github(repo, '', { method: 'POST', body: JSON.stringify({ encoding: 'base64', content: bytes.toString('base64') }) });
  const payload = JSON.stringify({ repo, sha: blob.sha, size: bytes.length, expires: Date.now() + 60 * 60 * 1000 });
  return { payload, signature: signature(payload) };
}

export function validateChunks(repo, chunks, size) {
  validateRepo(repo);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ZIP_BYTES) throw new Error('ZIP must be 50 MB or smaller.');
  if (!Array.isArray(chunks) || chunks.length !== Math.ceil(size / CHUNK_BYTES)) throw new Error('Incomplete ZIP upload.');
  let total = 0;
  const validated = chunks.map((receipt, index) => {
    if (typeof receipt?.payload !== 'string' || receipt.payload.length > 500 || !/^[a-f0-9]{64}$/.test(receipt.signature || '')) throw new Error('Invalid upload receipt.');
    const expected = signature(receipt.payload);
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(receipt.signature, 'hex'))) throw new Error('Invalid upload receipt.');
    const part = JSON.parse(receipt.payload);
    const expectedSize = index === chunks.length - 1 ? size - index * CHUNK_BYTES : CHUNK_BYTES;
    if (part.repo !== repo || part.expires < Date.now() || !/^[a-f0-9]{40}$/.test(part.sha) || part.size !== expectedSize) throw new Error('Invalid or expired upload chunk. Please upload the ZIP again.');
    total += part.size;
    return part;
  });
  if (total !== size) throw new Error('ZIP upload size mismatch.');
  return validated;
}

export async function restoreZip(repo, chunks, size) {
  const parts = validateChunks(repo, chunks, size);
  const zip = Buffer.alloc(size);
  let offset = 0;
  for (const part of parts) {
    const data = await github(repo, `/${part.sha}`);
    const bytes = Buffer.from(data.content || '', 'base64');
    const hash = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (bytes.length !== part.size || hash !== part.sha) throw new Error('Upload chunk failed verification.');
    bytes.copy(zip, offset);
    offset += bytes.length;
  }
  return zip;
}
