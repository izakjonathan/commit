import { stageChunk } from '../../../lib/zip-upload.mjs';
import { CHUNK_BYTES } from '../../../lib/upload-limits.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request) {
  if (!process.env.GITHUB_TOKEN) return Response.json({ error: 'Missing GITHUB_TOKEN.' }, { status: 500 });
  try {
    const repo = new URL(request.url).searchParams.get('repo');
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Missing upload chunk.');
    const buffers = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > CHUNK_BYTES) {
        await reader.cancel();
        return Response.json({ error: 'Upload chunk is too large.' }, { status: 413 });
      }
      buffers.push(Buffer.from(value));
    }
    return Response.json(await stageChunk(repo, Buffer.concat(buffers)));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
