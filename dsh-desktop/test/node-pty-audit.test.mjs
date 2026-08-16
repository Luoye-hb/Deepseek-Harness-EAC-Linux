// TDD tests for the after-pack node-pty native module audit (3.0.1 Arch incident).
//
// Bug: the 3.0.1 Linux (Arch) package shipped without node-pty's linux-x64
// native module (build/Release/pty.node or prebuilds/linux-x64/pty.node).
// dsh-subprocess-local and better-sidebar then failed to load node-pty and
// dsh web exited with code 1 in a "启动失败" loop. The bundle manifest was
// written from the already-broken tree, so the boot integrity check treated
// the missing file as its own baseline and never flagged it.
//
// Fix: after-pack audits node-pty BEFORE writing the manifest and fails the
// build if the native module is absent; on Linux it also imports the module
// with the bundled Node to catch ABI mismatches.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditNodePty } from '../scripts/after-pack.js';

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-nodepty-'));
  const ptyDir = join(root, 'resources', 'app', 'node_modules', 'node-pty');
  mkdirSync(join(ptyDir, 'build', 'Release'), { recursive: true });
  mkdirSync(join(root, 'resources', 'node'), { recursive: true });
  writeFileSync(join(ptyDir, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'lib/index.js' }));
  return root;
}

test('auditNodePty throws when node-pty itself is missing from the payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-nodepty-'));
  try {
    assert.throws(() => auditNodePty(root, 'linux'), /node-pty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditNodePty throws when no linux-x64 pty.node is present (the 3.0.1 bug)', () => {
  const root = makeTree();
  try {
    assert.throws(() => auditNodePty(root, 'linux'), /pty\.node/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditNodePty accepts build/Release/pty.node and imports it with the bundled node',
  { skip: process.platform === 'win32' }, () => {
    const root = makeTree();
    try {
      writeFileSync(join(root, 'resources', 'app', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'x');
      const fakeNode = join(root, 'resources', 'node', 'node');
      writeFileSync(fakeNode, '#!/bin/sh\necho "node-pty loadable @ v22.0.0"\nexit 0\n');
      chmodSync(fakeNode, 0o755);
      auditNodePty(root, 'linux');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('auditNodePty throws when the bundled node cannot import pty.node',
  { skip: process.platform === 'win32' }, () => {
    const root = makeTree();
    try {
      writeFileSync(join(root, 'resources', 'app', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'x');
      const fakeNode = join(root, 'resources', 'node', 'node');
      writeFileSync(fakeNode, '#!/bin/sh\necho "NODE_MODULE_VERSION mismatch" >&2\nexit 1\n');
      chmodSync(fakeNode, 0o755);
      assert.throws(() => auditNodePty(root, 'linux'), /无法加载 node-pty/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('auditNodePty on linux throws when the bundled node binary is absent', () => {
  const root = makeTree();
  try {
    const prebuild = join(root, 'resources', 'app', 'node_modules', 'node-pty', 'prebuilds', 'linux-x64');
    mkdirSync(prebuild, { recursive: true });
    writeFileSync(join(prebuild, 'pty.node'), 'x');
    // resources/node/node intentionally not created
    assert.throws(() => auditNodePty(root, 'linux'), /捆绑 Node/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditNodePty on win32 only requires presence (no bundled-node import)', () => {
  const root = makeTree();
  try {
    writeFileSync(join(root, 'resources', 'app', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'x');
    auditNodePty(root, 'win32');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditNodePty on win32 throws when win32 pty.node is missing', () => {
  const root = makeTree();
  try {
    assert.throws(() => auditNodePty(root, 'win32'), /pty\.node/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
