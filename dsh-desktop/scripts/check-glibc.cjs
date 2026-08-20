#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const DEFAULT_BASELINE = [2, 34];

function compareVersion(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseGlibcVersions(output) {
  return (output.match(/GLIBC_(\d+\.\d+(?:\.\d+)?)/g) || [])
    .map((value) => value.slice('GLIBC_'.length).split('.').map(Number))
    .sort(compareVersion);
}

function inspectFile(file, spawn = spawnSync) {
  if (!fs.existsSync(file)) return { error: `file does not exist: ${file}`, max: null };
  const result = spawn('objdump', ['-T', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) return { error: `objdump unavailable: ${result.error.message}`, max: null };
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    return { error: `objdump failed for ${file} (exit ${result.status})${detail ? `: ${detail}` : ''}`, max: null };
  }
  const versions = parseGlibcVersions(String(result.stdout || ''));
  return { error: null, max: versions.length ? versions[versions.length - 1] : null };
}

function maxGlibcRef(file) {
  const result = inspectFile(file);
  return result.error ? null : result.max;
}

function checkFile(file, baseline = DEFAULT_BASELINE) {
  const result = inspectFile(file);
  if (result.error) return { ok: false, skipped: false, message: result.error };
  if (result.max === null) {
    return { ok: true, skipped: false, message: `${file}: no GLIBC symbol references` };
  }
  if (compareVersion(result.max, baseline) > 0) {
    return { ok: false, skipped: false, message: `${file} requires GLIBC_${result.max.join('.')}, above GLIBC_${baseline.join('.')}` };
  }
  return { ok: true, skipped: false, message: `${file}: GLIBC_${result.max.join('.')} <= GLIBC_${baseline.join('.')}` };
}

function main(argv) {
  let baseline = DEFAULT_BASELINE;
  const files = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--baseline') {
      const value = argv[++index];
      const match = /^(\d+)\.(\d+)$/.exec(value || '');
      if (!match) {
        console.error(`invalid --baseline value: ${value || ''}`);
        return 2;
      }
      baseline = [Number(match[1]), Number(match[2])];
    } else {
      files.push(argv[index]);
    }
  }
  if (files.length === 0) {
    console.error('usage: node scripts/check-glibc.cjs [--baseline 2.34] <file> [file...]');
    return 2;
  }
  let failed = false;
  for (const file of files) {
    const result = checkFile(file, baseline);
    console.log(`${result.ok ? 'OK' : 'ERROR'}: ${result.message}`);
    failed ||= !result.ok;
  }
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { DEFAULT_BASELINE, checkFile, compareVersion, inspectFile, main, maxGlibcRef, parseGlibcVersions };
