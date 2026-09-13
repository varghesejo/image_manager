import { createZodDto } from 'nestjs-zod';
import { isoDatetimeToDate } from 'src/validation.js';
import z from 'zod';

/**
 * Work item 6 (admin-UI drive status): what the device-mount status endpoint reports for a library.
 * - 'connected': the tracked drive's last-known path exists on disk right now.
 * - 'offline': the tracked drive isn't at its last-known path, and reconcile hasn't found (or confirmed) a
 *   replacement yet.
 * - 'pending-confirmation': reconcile found a candidate path via the low-confidence content-fingerprint
 *   strategy only - see DeviceMountTable.pendingPath - and is waiting on confirmPendingMatch/rejectPendingMatch
 *   (work item 5, "ask, don't guess") before relinking.
 */
const DeviceMountStatusSchema = z
  .object({
    status: z.enum(['connected', 'offline', 'pending-confirmation']).describe('Current drive status'),
    volumeId: z.string().describe('Resolved, OS-independent volume identity'),
    identityMethod: z.string().describe('How the volume was last identified (e.g. filesystem-serial)'),
    identityConfidence: z.string().describe('Confidence of the last identification (e.g. high)'),
    lastKnownPath: z.string().describe('Where the drive was last mounted'),
    lastSeenAt: isoDatetimeToDate.describe('When the drive was last seen'),
    assetCount: z.int().nullable().describe('Cached asset count for this library, if known'),
    pendingPath: z.string().nullable().describe('A low-confidence candidate path awaiting confirmation, if any'),
  })
  .meta({ id: 'DeviceMountStatusResponseDto' });

export class DeviceMountStatusResponseDto extends createZodDto(DeviceMountStatusSchema) {}

export type DeviceMountEntity = {
  volumeId: string;
  identityMethod: string;
  identityConfidence: string;
  lastKnownPath: string;
  lastSeenAt: Date;
  assetCount: number | null;
  pendingPath: string | null;
};

export function mapDeviceMountStatus(
  entity: DeviceMountEntity,
  isAtLastKnownPath: boolean,
): DeviceMountStatusResponseDto {
  const status = entity.pendingPath ? 'pending-confirmation' : isAtLastKnownPath ? 'connected' : 'offline';

  return {
    status,
    volumeId: entity.volumeId,
    identityMethod: entity.identityMethod,
    identityConfidence: entity.identityConfidence,
    lastKnownPath: entity.lastKnownPath,
    lastSeenAt: entity.lastSeenAt,
    assetCount: entity.assetCount,
    pendingPath: entity.pendingPath,
  };
}
