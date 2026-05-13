#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { parseToolsetJs } from './index.js';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: toolset-parser <input.js|input.ts|input-dir> [output.json|output-dir]');
  process.exit(1);
}

const inputPath = path.resolve(args[0]);
const outputPath = args[1] ? path.resolve(args[1]) : undefined;

try {
  const parsed = fs.statSync(inputPath).isDirectory()
    ? parseDir(inputPath, outputPath)
    : [parseFile(inputPath, outputPath)];
  if (!parsed.length) console.log(`No .js/.ts toolsets found in ${inputPath}`);
  for (const { inputPath, outputPath, result } of parsed) {
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Parsed ${inputPath} -> ${outputPath}`);
  }
} catch (err) {
  if (err.name === 'ValidationError') {
    console.error('Validation error:', err.message);
    process.exit(1);
  }
  throw err;
}

function parseDir(inputDir, outputDir = inputDir) {
  const entries = fs
    .readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isToolsetSource(entry.name))
    .map((entry) => entry.name)
    .sort();

  fs.mkdirSync(outputDir, { recursive: true });
  return entries.map((name) =>
    parseFile(path.join(inputDir, name), path.join(outputDir, name.replace(/\.[jt]s$/, '.json'))),
  );
}

function parseFile(inputPath, outputPath = inputPath.replace(/\.[jt]s$/, '.json')) {
  if (!isToolsetSource(inputPath)) throw new Error(`Input file must use .js or .ts extension: ${inputPath}`);

  const content = fs.readFileSync(inputPath, 'utf8');
  try {
    return { inputPath, outputPath, result: parseToolsetJs(content, inputPath) };
  } catch (err) {
    err.message = `${inputPath}: ${err.message}`;
    throw err;
  }
}

function isToolsetSource(file) {
  return /\.[jt]s$/.test(file);
}
