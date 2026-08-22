#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const basePath = path.join(root, 'src-tauri', 'tauri.conf.json');
const outputPath = path.join(root, 'src-tauri', 'tauri.generated.conf.json');
const release = process.argv.includes('--release');
const publicKey = (process.env.TAURI_SIGNING_PUBLIC_KEY ?? '').trim();
const privateKey = (process.env.TAURI_SIGNING_PRIVATE_KEY ?? '').trim();
const endpoint = (process.env.TAURI_UPDATER_ENDPOINT ?? '').trim()
  || 'https://github.com/zouyuxuan122/Deepseek-Harness-EAC/releases/latest/download/latest.json';

if (release && !publicKey) {
  throw new Error('TAURI_SIGNING_PUBLIC_KEY is required for a release Tauri build');
}
if (release && !privateKey) {
  throw new Error('TAURI_SIGNING_PRIVATE_KEY is required for updater artifacts');
}
if (!/^https:\/\//i.test(endpoint)) {
  throw new Error('TAURI_UPDATER_ENDPOINT must use https://');
}

const config = JSON.parse(fs.readFileSync(basePath, 'utf8'));
config.plugins ??= {};
config.plugins.updater = {
  ...config.plugins.updater,
  pubkey: publicKey || '__TAURI_UPDATER_PUBLIC_KEY_REQUIRED__',
  endpoints: [endpoint],
};
// Map the staging directory contents directly into the resource root. A map
// per child directory makes Tauri retain the ../.tauri-staging source tree as
// an additional `_up_` resource, which duplicates native artifacts and causes
// linuxdeploy to inspect foreign-platform files.
config.bundle.resources = {
  '../.tauri-staging/': '',
};
if (!release) config.bundle.createUpdaterArtifacts = false;
fs.writeFileSync(outputPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log(`Tauri config generated: ${path.relative(root, outputPath)}`);
console.log(`Updater endpoint: ${endpoint}`);
console.log(`Updater signing key: ${publicKey ? 'configured' : 'not configured (development only)'}`);
