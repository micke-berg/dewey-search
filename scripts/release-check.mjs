import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dewey-release-'));
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 300000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error));
  return result.stdout;
}
function npm(args, cwd = root) {
  assert.ok(process.env.npm_execpath, 'invoke through npm run release:check');
  return run([process.env.npm_execpath, ...args], cwd);
}
try {
  const pack = JSON.parse(npm(['pack', '--json', '--pack-destination', temp]))[0];
  const names = pack.files.map(f => f.path);
  for (const name of names) {
    assert.ok(name.startsWith('dist/') || name.startsWith('docs/') || ['README.md', 'LICENSE', 'package.json'].includes(name), name);
    assert.ok(!name.includes('.test.') && !name.includes('test-helpers'), name);
  }
  for (const required of ['dist/cli.js', 'dist/index.js', 'dist/index.d.ts']) assert.ok(names.includes(required), required);
  const consumer = path.join(temp, 'Consumer with spaces');
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}');
  npm(['install', '--omit=dev', '--no-audit', '--no-fund', path.join(temp, pack.filename)], consumer);
  const notes = path.join(consumer, 'OneDrive - Example', 'Notes');
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'lantern.md'), '# Lantern\r\nSynthetic blue lantern.\r\n');
  const cli = path.join(consumer, 'node_modules', '@micke-berg', 'dewey', 'dist', 'cli.js');
  assert.match(run([cli, '--help'], consumer), /dewey index/);
  assert.match(run([cli, 'status', '--notes', notes, '--db', path.join(consumer, 'index.db'), '--json'], consumer), /built/);
  fs.writeFileSync(path.join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { resolveConfig, buildIndex, search } from '@micke-berg/dewey';
const config = {...resolveConfig({root: ${JSON.stringify(notes)}, dbPath: ${JSON.stringify(path.join(consumer, 'index.db'))}, env: {}}), embedDims: 4};
const embed = async texts => texts.map(() => new Float32Array([1,0,0,0]));
await buildIndex({config, embed});
const result = await search('lantern', {config, embed});
assert.equal(result.hits[0].path, 'lantern.md');
`);
  run(['smoke.mjs'], consumer);
  assert.equal(fs.readFileSync(path.join(notes, 'lantern.md'), 'utf8'), '# Lantern\r\nSynthetic blue lantern.\r\n');
  npm(['uninstall', '@micke-berg/dewey', '--no-audit', '--no-fund'], consumer);
  assert.ok(!fs.existsSync(path.join(consumer, 'node_modules', '@micke-berg', 'dewey')));
  assert.ok(fs.existsSync(path.join(notes, 'lantern.md')));
  console.log(`PASS pack allowlist (${names.length} files), clean consumer install, CLI, native search, note preservation and uninstall on ${process.platform}/${process.arch} Node ${process.versions.node}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
