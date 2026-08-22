import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import * as adapter from '../platform/electron-fallback/index.js';

class FakeBrowserWindow extends EventEmitter {
  static nextId = 1;
  static latest: FakeBrowserWindow | null = null;

  readonly id = FakeBrowserWindow.nextId++;
  readonly options: Record<string, unknown>;
  loadedUrl = '';
  shown = false;
  hidden = false;
  destroyed = false;
  maximized = false;

  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    FakeBrowserWindow.latest = this;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  show(): void {
    this.shown = true;
  }

  hide(): void {
    this.hidden = true;
  }

  focus(): void {}

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }

  destroy(): void {
    this.close();
  }

  minimize(): void {}

  isMaximized(): boolean {
    return this.maximized;
  }

  maximize(): void {
    this.maximized = true;
    this.emit('maximize');
  }

  unmaximize(): void {
    this.maximized = false;
    this.emit('unmaximize');
  }

  loadURL(url: string): Promise<void> {
    this.loadedUrl = url;
    return Promise.resolve();
  }
}

class FakeNotification extends EventEmitter {
  static last: FakeNotification | null = null;
  readonly options: Record<string, unknown>;
  shown = false;

  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    FakeNotification.last = this;
  }

  show(): void {
    this.shown = true;
  }
}

test('Electron fallback adapter wraps windows and translates lifecycle events', async () => {
  const fakeDeps = {
    BrowserWindow: FakeBrowserWindow,
    clipboard: { writeText: () => {} },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    globalShortcut: { register: () => true, unregister: () => {} },
    Notification: FakeNotification,
    shell: {
      openExternal: async () => {},
      openPath: async () => '',
      showItemInFolder: () => {},
    },
  };
  const platform = new adapter.ElectronDesktopPlatform({ dependencies: fakeDeps });
  const window = await platform.createWindow({
    role: 'main',
    url: 'http://127.0.0.1:6100/',
    width: 900,
    height: 700,
    resizable: false,
    frameless: true,
  });
  const native = FakeBrowserWindow.latest;
  assert.ok(native);
  assert.equal(native.loadedUrl, 'http://127.0.0.1:6100/');
  assert.equal(native.options.width, 900);
  assert.equal(native.options.height, 700);
  assert.equal(native.options.resizable, false);
  assert.equal(native.options.frame, false);
  assert.equal(platform.getWindow(window.id), window);

  let maximized = 0;
  const unsubscribe = window.on('maximized', () => {
    maximized += 1;
  });
  native.maximize();
  assert.equal(window.isMaximized(), true);
  assert.equal(maximized, 1);
  unsubscribe();
  native.unmaximize();
  assert.equal(maximized, 1);

  native.close();
  assert.equal(platform.getWindow(window.id), null);
});

test('Electron fallback adapter routes system capabilities through injected dependencies', async () => {
  const calls: string[] = [];
  let dialogArgs: unknown[] = [];
  const fakeDeps = {
    BrowserWindow: FakeBrowserWindow,
    clipboard: { writeText: (text: string) => calls.push(`clipboard:${text}`) },
    dialog: {
      showMessageBox: async (...args: unknown[]) => {
        dialogArgs = args;
        return { response: 1, checkboxChecked: true };
      },
    },
    globalShortcut: {
      register: (accelerator: string) => {
        calls.push(`register:${accelerator}`);
        return true;
      },
      unregister: (accelerator: string) => calls.push(`unregister:${accelerator}`),
    },
    Notification: FakeNotification,
    shell: {
      openExternal: async (url: string) => calls.push(`external:${url}`),
      openPath: async (path: string) => {
        calls.push(`path:${path}`);
        return '';
      },
      showItemInFolder: (path: string) => calls.push(`folder:${path}`),
    },
  };
  const platform = new adapter.ElectronDesktopPlatform({ dependencies: fakeDeps });
  const parent = await platform.createWindow({ role: 'main' });

  await platform.openExternal('https://example.test');
  await platform.openPath('/tmp/example.txt');
  await platform.showItemInFolder('/tmp/archive.zip');
  await platform.writeClipboard('copied');
  const result = await platform.showDialog({
    type: 'question',
    title: 'Confirm',
    message: 'Continue?',
    buttons: ['No', 'Yes'],
    checkboxLabel: 'Remember',
    checkboxChecked: false,
    parentWindowId: parent.id,
  });
  assert.deepEqual(result, { response: 1, checkboxChecked: true });
  assert.equal(dialogArgs.length, 2);

  let clicked = 0;
  await platform.showNotification({
    title: 'Notice',
    body: 'Body',
    onClick: () => {
      clicked += 1;
    },
  });
  assert.equal(FakeNotification.last?.shown, true);
  FakeNotification.last?.emit('click');
  assert.equal(clicked, 1);

  const removeShortcut = platform.registerShortcut({
    accelerator: 'Ctrl+Shift+P',
    handler: () => {},
  });
  removeShortcut();
  assert.deepEqual(calls, [
    'external:https://example.test',
    'path:/tmp/example.txt',
    'folder:/tmp/archive.zip',
    'clipboard:copied',
    'register:Ctrl+Shift+P',
    'unregister:Ctrl+Shift+P',
  ]);
});

test('Electron fallback adapter exposes failed shell paths as errors', async () => {
  const fakeDeps = {
    BrowserWindow: FakeBrowserWindow,
    clipboard: { writeText: () => {} },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    globalShortcut: { register: () => true, unregister: () => {} },
    Notification: FakeNotification,
    shell: {
      openExternal: async () => {},
      openPath: async () => 'permission denied',
      showItemInFolder: () => {},
    },
  };
  const platform = new adapter.ElectronDesktopPlatform({ dependencies: fakeDeps });
  await assert.rejects(platform.openPath('/root/secret'), /permission denied/);
});
