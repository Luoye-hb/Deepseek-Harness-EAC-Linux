export type {
  ChromeInfo,
  DesktopFilesApi,
  DesktopShell,
  DesktopWindowControlsApi,
  DshDesktopApi,
  Unsubscribe,
} from './desktop-api.js';
export type {
  DesktopDialogOptions,
  DesktopDialogResult,
  DesktopNotificationOptions,
  DesktopOs,
  DesktopPlatform,
  DesktopShortcut,
  DesktopWindow,
  DesktopWindowRole,
  DesktopWindowSpec,
} from './desktop-platform.js';
export {
  DESKTOP_HOST_DEFAULT_TIMEOUT_MS,
  DESKTOP_HOST_MAX_FRAME_BYTES,
  DESKTOP_HOST_PROTOCOL_VERSION,
} from './desktop-host.js';
export type {
  DesktopHostMethodMap,
  DesktopHostEvent,
  DesktopHostMessage,
  DesktopHostPingResult,
  DesktopHostRequest,
  DesktopHostResponse,
  DshStartParams,
  DshStartResult,
  DshStatusResult,
  DshStopResult,
} from './desktop-host.js';
export type {
  DesktopWindowDescriptor,
  DesktopWindowKind,
  DesktopWindowOpenRequest,
} from './windows.js';
export type {
  DesktopError,
  DesktopErrorCode,
} from './errors.js';
export type {
  UpdateApplyParams,
  UpdateCancelParams,
  UpdateCheckParams,
  UpdateJobResult,
  UpdateKind,
  UpdateProgress,
  UpdateSnapshot,
  UpdateState,
} from './update.js';
export type {
  DesktopBalanceChangedEvent,
  DesktopEvent,
  DesktopEventListener,
  DesktopEventMap,
  DesktopEventName,
  DesktopFilesDroppedEvent,
  DesktopMaximizeChangedEvent,
  DesktopRecoveryStateChangedEvent,
  DesktopServiceStateChangedEvent,
} from './events.js';
