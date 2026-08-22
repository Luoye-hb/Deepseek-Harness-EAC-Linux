import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ChromeInfo,
  DshDesktopApi,
  Unsubscribe,
} from '../../../shared/contract/desktop-api.js';
import type { UpdateKind, UpdateSnapshot } from '../../../shared/contract/update.js';
import { DropPathResolver } from './drop-paths.js';

type TauriEventPayload<T> = { payload: T };

function hostCall<T>(method: string, params: unknown = null): Promise<T> {
  return invoke<T>('desktop_host_call', { method, params });
}

function listenEvent<T>(
  event: string,
  callback: (payload: T) => void,
): Unsubscribe {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void listen<T>(event, (message: TauriEventPayload<T>) => {
    if (disposed) return;
    try {
      callback(message.payload);
    } catch {
      /* A page callback must not break the native event subscription. */
    }
  }).then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  });
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

function sessionLabel(sessionId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
    throw new Error('invalid float window session id');
  }
  return `float-${sessionId}`;
}

function localPageName(): string {
  return location.pathname.split('/').pop() ?? '';
}

function queryMode(): 'first' | 'rerun' {
  const injected = (window as Window & { __DSH_ONBOARD_MODE__?: unknown })
    .__DSH_ONBOARD_MODE__;
  return (injected === 'rerun' || new URLSearchParams(location.search).get('mode') === 'rerun')
    ? 'rerun'
    : 'first';
}

function updateKind(): UpdateKind {
  const value = new URLSearchParams(location.search).get('kind');
  return value === 'client' ? 'client' : 'agent';
}

const dropPaths = new DropPathResolver();

function nativeDropPaths(payload: { type?: unknown; paths?: unknown }): string[] {
  if (payload.type !== 'drop' || !Array.isArray(payload.paths)) return [];
  return payload.paths.filter(
    (path): path is string => typeof path === 'string' && path.length > 0,
  );
}

// Keep the compatibility method working even when an older plugin does not
// subscribe to files.onDrop and only calls getPathForFile from DOM drop code.
void listenEvent<{ type?: unknown; paths?: unknown }>('tauri://drag-drop', (payload) => {
  const paths = nativeDropPaths(payload);
  if (paths.length > 0) dropPaths.begin(paths);
});

function associateNativeDropFiles(event: DragEvent): void {
  dropPaths.associate(Array.from(event.dataTransfer?.files ?? []));
}

document.addEventListener('drop', associateNativeDropFiles, true);

function exposeRoleBridge(): void {
  const page = localPageName();
  const target = window as Window & {
    onboarding?: {
      list(): Promise<unknown>;
      submit(ids: unknown): Promise<unknown>;
      close(): void;
    };
    rc?: {
      action(action: string, value?: unknown): Promise<unknown>;
      close(): void;
    };
    update?: {
      readonly kind: UpdateKind;
      state(): Promise<UpdateSnapshot>;
      check(): Promise<UpdateSnapshot>;
      apply(version?: string): Promise<unknown>;
      cancel(jobId: string): Promise<unknown>;
      onState(callback: (state: UpdateSnapshot) => void): Unsubscribe;
      close(): void;
    };
    about?: {
      info(): Promise<unknown>;
      copy(text: string): Promise<unknown>;
      close(): void;
    };
  };
  if (page === 'onboarding.html') {
    target.onboarding = {
      list: () => hostCall('onboard:list', { mode: queryMode() }),
      submit: async (ids) => {
        const result = await hostCall('onboard:submit', {
          mode: queryMode(),
          ids,
        });
        await invoke('desktop_window_close', { label: 'wizard' });
        await invoke('desktop_window_show_main');
        return result;
      },
      close: () => {
        void hostCall('onboard:close', { mode: queryMode() })
          .catch(() => undefined)
          .then(() => invoke('desktop_window_close', { label: 'wizard' }))
          .then(() => invoke('desktop_window_show_main'));
      },
    };
  }
  if (page === 'recovery-center.html') {
    target.rc = {
      action: async (action, value) => {
        if (action === 'retry-boot') {
          return invoke('desktop_recovery_action', { action: 'reload' });
        }
        if (action === 'export-logs') {
          return invoke('desktop_recovery_action', { action: 'export-logs' });
        }
        if (action === 'safe-mode') {
          return invoke('desktop_recovery_action', { action: 'safe-mode' });
        }
        return hostCall('recovery:action', { action, value });
      },
      close: () => {
        void invoke('desktop_recovery_window_close');
      },
    };
  }
  if (page === 'update.html') {
    const kind = updateKind();
    const clientUpdateCall = <T>(method: string, args: Record<string, unknown> = {}) =>
      invoke<T>(`desktop_client_update_${method}`, args);
    target.update = {
      kind,
      state: () => kind === 'client'
        ? clientUpdateCall<UpdateSnapshot>('state')
        : hostCall('update:state', { kind }),
      check: () => kind === 'client'
        ? clientUpdateCall<UpdateSnapshot>('check')
        : hostCall('update:check', { kind }),
      apply: (version) => kind === 'client'
        ? clientUpdateCall('apply')
        : hostCall('update:apply', { kind, ...(version ? { version } : {}) }),
      cancel: (jobId) => kind === 'client'
        ? clientUpdateCall('cancel', { jobId })
        : hostCall('update:cancel', { jobId }),
      onState: (callback) => listenEvent<UpdateSnapshot>('update.state', (state) => {
        if (state.kind === kind) callback(state);
      }),
      close: () => {
        void invoke('desktop_window_close', { label: 'update' });
      },
    };
  }
  if (page === 'about.html') {
    target.about = {
      info: () => invoke('desktop_about_info'),
      copy: (value) => invoke('desktop_copy_text', { text: value }),
      close: () => {
        void invoke('desktop_window_close', { label: 'about' });
      },
    };
  }
}

export function createTauriDesktopApi(): DshDesktopApi {
  const api: DshDesktopApi = {
    appVersion: '',
    windowControls: {
      minimize: () => invoke('desktop_window_control', { action: 'minimize' }),
      toggleMaximize: () =>
        invoke('desktop_window_control', { action: 'toggle-maximize' }),
      close: () => invoke('desktop_window_control', { action: 'close' }),
      isMaximized: () =>
        invoke<boolean>('desktop_window_control', { action: 'is-maximized' }),
      onMaximizeChange: (callback) =>
        listenEvent<boolean>('window.maximized', callback),
    },
    menu: {
      action: (action, payload = {}) =>
        invoke('desktop_menu_action', { action, payload }),
    },
    getInfo: () =>
      invoke<ChromeInfo>('desktop_info').then((info) => {
        api.appVersion = info.appVersion ?? '';
        return info;
      }),
    refreshBalance: () => hostCall('balance:refresh'),
    restartService: () =>
      invoke('desktop_menu_action', { action: 'restart-service', payload: {} }),
    floatWindow: {
      open: (sessionId) =>
        invoke('desktop_window_open', {
          request: { kind: 'float', session_id: sessionId },
        }),
      close: () => {
        const sessionId = (
          window as Window & { __DSH_FLOAT__?: { sessionId?: string } }
        ).__DSH_FLOAT__?.sessionId;
        if (sessionId) {
          void invoke('desktop_window_close', { label: sessionLabel(sessionId) });
        }
      },
    },
    guard: {
      action: (action, value) => hostCall('guard:action', { action, value }),
    },
    pluginWizard: {
      open: () =>
        invoke('desktop_window_open', {
          request: { kind: 'wizard', mode: 'rerun' },
        }),
    },
    pluginManager: {
      list: () => hostCall('plugin:list'),
      setEnabled: (id, enabled) =>
        hostCall('plugin:set-enabled', { id, enabled }),
      setRemoved: (id, removed) =>
        hostCall('plugin:set-removed', { id, removed }),
    },
    pluginUpdates: {
      list: (force = false) => hostCall('plugin:updates', { force }),
      update: (id) => hostCall('plugin:update', { id }),
      setAutoUpdate: (enabled) =>
        hostCall('plugin:auto-update', { enabled }),
    },
    imagePaste: {
      save: (payload) => hostCall('image-paste:save', payload),
    },
    balancePrices: {
      get: (model) => hostCall('balance:prices:get', { model }),
      set: (model, prices) =>
        hostCall('balance:prices:set', { model, prices }),
      reset: (model) => hostCall('balance:prices:reset', { model }),
    },
    revertFiles: (changes) => hostCall('file:revert', { changes }),
    openPath: (path) => invoke('desktop_open_path', { path }),
    openExternal: (url) => invoke('desktop_open_external', { url }),
    copyText: (text) => invoke('desktop_copy_text', { text }),
    getPathForFile: (file) => dropPaths.resolve(file),
    files: {
      onDrop: (callback) => listenEvent<{ type?: string; paths?: readonly string[] }>(
          'tauri://drag-drop',
          (payload) => {
            const paths = nativeDropPaths(payload);
            const files = paths.map((path) => {
              const name = path.split(/[\\/]/).pop() ?? path;
              return { path, name };
            });
            if (files.length > 0) callback({ files });
          },
        ),
    },
    recovery: {
      getState: () => hostCall('recovery:state'),
      reload: () => invoke('desktop_recovery_action', { action: 'reload' }),
      restart: () => invoke('desktop_recovery_action', { action: 'restart' }),
      exportLogs: () =>
        invoke('desktop_recovery_action', { action: 'export-logs' }),
    },
  };
  listenEvent<{ data: unknown }>('balance.changed', (payload) => {
    try {
      window.dispatchEvent(
        new CustomEvent('dsh-balance-changed', { detail: payload.data }),
      );
    } catch {
      /* A compatibility event must not break the native subscription. */
    }
  });
  listenEvent<unknown>('service.state', (payload) => {
    try {
      window.dispatchEvent(
        new CustomEvent('dsh-service-state-changed', { detail: payload }),
      );
    } catch {
      /* A compatibility event must not break the native subscription. */
    }
  });
  const reportPageError = (message: string): void => {
    void invoke('desktop_page_error', { message }).catch(() => {});
  };
  window.addEventListener('error', (event) => {
    reportPageError(`window.onerror: ${String(event.message || event.error || 'unknown')}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportPageError(`unhandledrejection: ${String(event.reason?.message || event.reason || event)}`);
  });
  const heartbeat = (): void => {
    void invoke('desktop_renderer_heartbeat').catch(() => {});
  };
  heartbeat();
  window.setInterval(heartbeat, 5_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') heartbeat();
  });
  return api;
}

const globalWindow = window as Window & {
  dshDesktop?: DshDesktopApi;
};
if (!globalWindow.dshDesktop) {
  globalWindow.dshDesktop = createTauriDesktopApi();
}
exposeRoleBridge();
