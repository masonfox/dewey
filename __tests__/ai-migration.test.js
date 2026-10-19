import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { Job, JobType } from '../src/job.js';
import { migrateJob } from '../src/migrate.js';
import { extractAudioMetadata, extractDirectoryMetadata } from '../src/metadata.js';
vi.mock('../src/metadata.js', () => ({ extractAudioMetadata: vi.fn(), extractDirectoryMetadata: vi.fn() }));

let root;
let savedEnv;
const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
beforeEach(async () => {
  savedEnv = { ...process.env };
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dewey-ai-'));
  Object.assign(process.env, { SOURCE_DIR: path.join(root, 'incoming'), DEST_DIR: path.join(root, 'library'),
    PUID: '0', PGID: '0', AI_PROVIDER: 'openai-compatible', AI_MODEL: 'selected-migration-model', AI_BASE_URL: 'http://localhost:1234/v1' });
  await fs.ensureDir(process.env.SOURCE_DIR); await fs.ensureDir(process.env.DEST_DIR);
  const metadata = { hasMetadata: true, author: 'Embedded Author', title: 'Embedded Title', year: '2024', genre: 'Fiction' };
  extractAudioMetadata.mockResolvedValue(metadata); extractDirectoryMetadata.mockResolvedValue(metadata);
});
afterEach(async () => {
  await fs.remove(root);
  process.env = savedEnv;
});

test.each([JobType.FILE, JobType.DIRECTORY])('%s migration uses selected AI metadata and sanitizes paths', async type => {
  const source = path.join(process.env.SOURCE_DIR, type === JobType.FILE ? 'Heuristic Author - Heuristic Title.mp3' : 'Heuristic Author - Heuristic Title');
  const files = type === JobType.FILE ? [path.basename(source)] : ['01.mp3', '02.mp3'];
  if (type === JobType.DIRECTORY) await fs.ensureDir(source);
  for (const file of files) await fs.writeFile(type === JobType.FILE ? source : path.join(source, file), 'original audio bytes');
  const fetch = vi.fn(async () => Response.json({ id: 'chat_test', object: 'chat.completion', created: 1, model: 'selected-migration-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '{"author":"../AI/Author","title":"../../AI:Title"}' }, finish_reason: 'stop' }] }));
  vi.stubGlobal('fetch', fetch);
  expect(await migrateJob(new Job(source, type), log)).toMatchObject({ author: 'AI Author', title: 'AI Title', files: files.length });
  expect(fetch).toHaveBeenCalledOnce();
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.model).toBe('selected-migration-model');
  for (const context of ['Embedded Author', 'Embedded Title', '2024', 'Fiction', path.basename(source)]) expect(JSON.stringify(body)).toContain(context);
  for (const file of files) expect(await fs.readFile(path.join(process.env.DEST_DIR, 'AI Author', 'AI Title', file), 'utf8')).toBe('original audio bytes');
  expect(await fs.pathExists(source)).toBe(false);
});

test.each([JobType.FILE, JobType.DIRECTORY])('%s migration retains heuristics after provider authentication failure', async type => {
  const source = path.join(process.env.SOURCE_DIR, type === JobType.FILE ? 'Heuristic Author - Heuristic Title.mp3' : 'Heuristic Author - Heuristic Title');
  if (type === JobType.DIRECTORY) await fs.ensureDir(source);
  const file = type === JobType.FILE ? source : path.join(source, '01.mp3');
  await fs.writeFile(file, 'preserved bytes');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'rejected-secret' } }, { status: 401 })));
  const result = await migrateJob(new Job(source, type), log);
  expect(result).toMatchObject({ author: 'Heuristic Author', title: 'Heuristic Title', files: 1 });
  expect(await fs.readFile(path.join(process.env.DEST_DIR, result.author, result.title, path.basename(file)), 'utf8')).toBe('preserved bytes');
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain('rejected-secret');
});

test.each([
  ['nested', ['Parent Author', 'Nested Book'], 'PARENT_DIR: Parent Author'],
  ['top-level', ['Top Level Book'], null],
])('%s directory migration sends parent directory context to AI', async (_, segments, expected) => {
  const source = path.join(process.env.SOURCE_DIR, ...segments);
  await fs.ensureDir(source);
  await fs.writeFile(path.join(source, '01.mp3'), 'audio bytes');
  extractDirectoryMetadata.mockResolvedValue({ hasMetadata: false });
  const fetch = vi.fn(async () => Response.json({ id: 'chat_test', object: 'chat.completion', created: 1, model: 'selected-migration-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '{"author":"AI Author","title":"AI Title"}' }, finish_reason: 'stop' }] }));
  vi.stubGlobal('fetch', fetch);
  await migrateJob(new Job(source, JobType.DIRECTORY), log);
  const prompt = JSON.stringify(JSON.parse(fetch.mock.calls[0][1].body).messages);
  if (expected) expect(prompt).toContain(expected);
  else expect(prompt).not.toContain('PARENT_DIR');
});
