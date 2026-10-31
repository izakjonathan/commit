import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { MAX_ZIP_BYTES, CHUNK_BYTES } from '../lib/upload-limits.mjs';
import { stageChunk, restoreZip, validateChunks } from '../lib/zip-upload.mjs';

process.env.GITHUB_TOKEN = 'test-token-only';
const blobs = new Map();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (options.method === 'POST') {
    const data = JSON.parse(options.body);
    const bytes = Buffer.from(data.content, 'base64');
    assert.ok(bytes.length <= CHUNK_BYTES);
    const sha = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    blobs.set(sha, data.content);
    return Response.json({ sha });
  }
  const sha = String(url).split('/').at(-1);
  return Response.json({ content: blobs.get(sha) });
};
try {
  // A real ZIP padded with an incompressible media asset to exactly the limit.
  const zip = new JSZip();
  zip.file('package.json', '{"name":"upload-test"}');
  zip.file('package-lock.json', '{"lockfileVersion":3}');
  zip.file('video.mp4', Buffer.alloc(0));
  const overhead = (await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })).length;
  zip.file('video.mp4', crypto.randomBytes(MAX_ZIP_BYTES - overhead));
  const source = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  assert.equal(source.length, MAX_ZIP_BYTES);
  const receipts = [];
  for (let start = 0; start < source.length; start += CHUNK_BYTES) {
    receipts.push(await stageChunk('test-repo', source.subarray(start, start + CHUNK_BYTES)));
  }
  assert.equal(receipts.length, 25);
  assert.deepEqual(await restoreZip('test-repo', receipts, source.length), source);
  const loaded = await JSZip.loadAsync(source);
  assert.equal((await loaded.file('video.mp4').async('nodebuffer')).length, MAX_ZIP_BYTES - overhead);
  assert.throws(() => validateChunks('test-repo', receipts, MAX_ZIP_BYTES + 1), /50 MB/);
  assert.throws(() => validateChunks('other-repo', receipts, source.length), /Invalid/);
  assert.throws(() => validateChunks('test-repo', receipts.slice(1), source.length), /Incomplete/);
  const tampered = structuredClone(receipts);
  tampered[0].payload = tampered[0].payload.replace('test-repo', 'evil-repo');
  assert.throws(() => validateChunks('test-repo', tampered, source.length), /Invalid/);
  const small = Buffer.from('small last chunk');
  const smallReceipt = await stageChunk('test-repo', small);
  assert.deepEqual(await restoreZip('test-repo', [smallReceipt], small.length), small);
  const corruptSha = JSON.parse(smallReceipt.payload).sha;
  blobs.set(corruptSha, Buffer.from('corrupt').toString('base64'));
  await assert.rejects(restoreZip('test-repo', [smallReceipt], small.length), /verification/);
  console.log('Upload tests passed: exact 50 MB ZIP, small ZIP, over limit, tampering, missing chunks, repository binding and corruption.');
} finally { globalThis.fetch = originalFetch; }
