#!/usr/bin/env node
// Release pipeline helper: checks that the pushed tag matches package.json and
// prints that version's section of CHANGELOG.md, which becomes the GitHub
// Release body. Run from the repository root; handy locally to preview notes
// before tagging. Usage: release-notes.mjs v0.8.0
//
// A section starts at "## v<version>" (optionally followed by a date) and runs
// until the next "## " heading.
import { readFileSync } from 'node:fs';

function fail(message) {
  console.error(`release-notes: ${message}`);
  process.exit(1);
}

const tag = process.argv[2];
if (!tag) fail('missing tag argument, e.g. v0.8.0');

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
if (tag !== `v${version}`) fail(`tag ${tag} does not match package.json version ${version}`);

const lines = readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/);
const start = lines.findIndex((line) => line === `## ${tag}` || line.startsWith(`## ${tag} `));
if (start === -1) fail(`CHANGELOG.md has no "## ${tag}" section`);

const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith('## '));
const notes = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
if (!notes) fail(`CHANGELOG.md section ${tag} is empty`);

process.stdout.write(`${notes}\n`);
