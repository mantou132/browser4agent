#!/usr/bin/env node

/**
 * Seed local KV with toolsets from extension/public/toolsets.
 */

import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const toolsetsDir = join(__dirname, 'seed');

const files = readdirSync(toolsetsDir).filter((f) => f.endsWith('.json'));

for (const file of files) {
  const filePath = join(toolsetsDir, file);
  const { default: toolset } = await import(pathToFileURL(filePath).href, { with: { type: 'json' } });
  execSync(`npx wrangler kv key put "${toolset.name}" --path="${filePath}" --binding=MARKET_KV --local`);
  console.log(`✓ Seeded: ${toolset.name}`);
}

console.log(`\nDone. Seeded ${files.length} toolset(s) into local KV.`);
