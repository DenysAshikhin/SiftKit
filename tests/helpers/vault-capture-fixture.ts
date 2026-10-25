import type { CaptureSubmissionDto } from '@siftkit/contracts';

import type { AssistantImageCapability, AssistantImageCapabilityProvider } from '../../src/assistant/images/image-capability.ts';
import { DEFAULT_ASSISTANT_CONFIG } from '../../src/config/defaults.ts';
import type { AssistantConfig } from '../../src/config/types.ts';

export const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAf'
  + 'FcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const BASE_HASH = 'f0e1d2c3b4a59687';
/** 4 flipped bits: 93.75 %, above the 92 % default threshold. */
export const NEAR_HASH = 'f0e1d2c3b4a59688';
/** 6 flipped bits: 90.625 %, below the threshold. */
export const DISTINCT_HASH = 'f0e1d2c3b4a59798';

export const SCREENSHOTS_ENABLED: AssistantConfig = {
  ...DEFAULT_ASSISTANT_CONFIG,
  Enabled: true,
  Observation: { ...DEFAULT_ASSISTANT_CONFIG.Observation, ScreenshotsEnabled: true },
};

export class StubImageCapability implements AssistantImageCapabilityProvider {
  private capable: boolean;

  constructor(capable: boolean) {
    this.capable = capable;
  }

  setCapable(capable: boolean): void {
    this.capable = capable;
  }

  read(): AssistantImageCapability {
    return { instanceId: this.capable ? 'inference:1' : null, visionCapable: this.capable, healthy: this.capable };
  }
}

type CaptureOverrides = Partial<Pick<CaptureSubmissionDto, 'capturedAtUtc' | 'pixelSha256' | 'perceptualHash' | 'foregroundContextKey' | 'reason'>> & {
  readonly title?: string | null;
  readonly processName?: string | null;
};

export function vaultCaptureDto(overrides: CaptureOverrides = {}): CaptureSubmissionDto {
  return {
    schemaVersion: 1,
    capturedAtUtc: overrides.capturedAtUtc ?? '2026-10-24T08:59:30.000Z',
    reason: overrides.reason ?? 'window_change',
    display: {
      id: 'DISPLAY1', name: 'Generic PnP Monitor', primary: true,
      pixelWidth: 3840, pixelHeight: 2160, logicalWidth: 2560, logicalHeight: 1440, scaleFactor: 1.5,
    },
    foregroundContextKey: overrides.foregroundContextKey ?? 'app:code|siftkit',
    foreground: {
      processName: overrides.processName === undefined ? 'Code.exe' : overrides.processName,
      executablePath: null,
      applicationId: 'app:code',
      normalizedTitle: overrides.title === undefined ? 'SiftKit - Visual Studio Code' : overrides.title,
      fullscreen: false,
    },
    pixelSha256: overrides.pixelSha256 ?? '1'.padStart(64, '0'),
    perceptualHash: overrides.perceptualHash ?? BASE_HASH,
    imageDataUrl: PNG_DATA_URL,
  };
}
