/** Shared contract for the built-in plugin onboarding window. */

export type OnboardingMode = 'first' | 'rerun';

export interface OnboardingListParams {
  readonly mode?: OnboardingMode;
}

export interface OnboardingSubmitParams {
  readonly mode?: OnboardingMode;
  readonly ids?: readonly unknown[];
}

export interface OnboardingCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly core: boolean;
  readonly recommended: boolean;
  readonly registryDisabled: boolean;
  readonly size: number;
}

export interface OnboardingListResult {
  readonly mode: OnboardingMode;
  readonly catalog: readonly OnboardingCatalogEntry[];
  readonly current: Readonly<Record<string, boolean>> | null;
}

export interface OnboardingSubmitResult {
  readonly ok: boolean;
  readonly applied?: number;
  readonly errors?: readonly string[];
}
