import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, createEmbedder, getFreshness, resolveConfig, search } from '../dist/index.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dewey-demo-'));
const notes = path.join(temp, 'notes');
fs.mkdirSync(notes);
const examples = {
  'recovery.md': '# Recovering from mistakes\nRestore the last backup to undo an accidental edit. Keep backups outside the notes folder.\n',
  'launch.md': '# Launch checklist\nThe release identifier is LANTERN-42. Test installation before announcing a release.\n',
  'garden.md': '# Garden\nWater the tomatoes in the morning.\n',
};
for (const [name, text] of Object.entries(examples)) fs.writeFileSync(path.join(notes, name), text);
try {
  const config = resolveConfig({ root: notes, dbPath: path.join(temp, 'index.db'), env: {} });
  console.log('Synthetic notes only. Uses the local embedding model; downloads it if missing.');
  const embed = createEmbedder(config);
  await buildIndex({ config, embed });
  for (const query of ['How can I undo a mistake?', 'LANTERN-42']) {
    const result = await search(query, { config, embed });
    console.log(JSON.stringify({ query, hits: result.hits.slice(0, 3), indexFreshness: getFreshness(config) }, null, 2));
  }
  for (const [name, text] of Object.entries(examples)) assert.equal(fs.readFileSync(path.join(notes, name), 'utf8'), text);
  console.log('PASS: all note bytes preserved. This example is not a benchmark.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
