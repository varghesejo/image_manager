import { Injectable } from '@nestjs/common';
import { OnJob } from 'src/decorators.js';
import { DeviceMountStatusResponseDto, mapDeviceMountStatus } from 'src/dtos/device-mount.dto.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { DeviceResolverService } from 'src/services/device-resolver/device-resolver.service.js';
import {
  ContentFingerprintMatch,
  ContentFingerprintMatcher,
  DeviceIdentity,
  DeviceIdentityConfidence,
  DeviceIdentityMethod,
} from 'src/services/device-resolver/device-resolver.types.js';
import type { JobOf } from 'src/types.js';

/** How many files to sample when checking a mount's content against a library's known assets (strategy 4). */
const CONTENT_FINGERPRINT_SAMPLE_SIZE = 20;

export type ReconcileReason =
  'not-tracked' | 'still-at-known-path' | 'relinked' | 'no-match-found' | 'needs-confirmation' | 'no-pending-match';

export interface ReconcileResult {
  reason: ReconcileReason;
  relinked: boolean;
  oldPath?: string;
  newPath?: string;
}

/**
 * Phase 1, work item 4 of the PhotoManager plan: when a removable drive backing a library reconnects under a
 * different OS-assigned mount path or drive letter, this is what keeps the library pointed at it without
 * losing track of already-indexed assets.
 *
 * Immich's own external-library scan identifies assets by exact `originalPath` equality (see
 * `LibraryService.processEntity` and `AssetRepository.filterNewExternalAssetPaths`/`detectOfflineExternalAssets`)
 * - its per-asset "checksum" for external assets is a hash of the path string, not file content
 * (`ChecksumAlgorithm.sha1Path`), so it can't be reused to recognize a file that moved to a new path. If a
 * reconnect changes the mount path, every asset's recorded path goes stale: the scan marks them offline, then
 * rediscovers the same files as brand-new assets at the new path - which is what forces a full
 * thumbnail/ML/metadata reprocessing (immich-app/immich#17290).
 *
 * The fix here is a hybrid, applied *before* the next scan runs so no asset ever goes offline or gets
 * rediscovered: recognize the reconnect via DeviceResolverService (unchanged - still the cheap, content-free way
 * to answer "which library does this newly-mounted drive belong to"), then relink in two passes. First, a bulk
 * path-prefix rewrite across the library's import paths and every asset's `originalPath` - free of file reads,
 * and sufficient whenever the drive's internal folder structure didn't change. Second, a content-checksum
 * fallback (relinkByContent) for anything the prefix rewrite couldn't follow, i.e. a file also renamed or moved
 * within the drive - this is why external assets are now checksummed from file content rather than path (see
 * LibraryService.processEntity).
 *
 * Wired to run automatically via the job queue (this codebase's only cross-service coordination mechanism, since
 * services don't inject one another): LibraryService queues JobName.DeviceMountReconcile for every library right
 * before it queues the files-sync job, both from its periodic scan-all cron (handleQueueScanAll) and from the
 * existing manual "scan this library now" trigger (queueScan / POST /libraries/:id/scan) - so that same endpoint
 * doubles as a manual "rescan my drive now" button, with no new endpoint needed. `handleReconcile` below is what
 * that job calls into; it discovers candidate mount roots itself via VolumeInfoRepository.listMountedVolumes()
 * rather than requiring a caller to enumerate them.
 *
 * Work items 5 and 6 build on this: `confirmPendingMatch`/`rejectPendingMatch` resolve a low-confidence match
 * `reconcilePath` parked instead of auto-relinking (see DeviceMountTable.pendingPath), and `getStatus` is what
 * the admin-UI status endpoint reads.
 *
 * This is also where DeviceResolverService's strategy 4 (content fingerprint) finally gets wired up - work item 2
 * left it as an injected port specifically so it could be implemented once there was a database to check against.
 * `matchContentFingerprint` below is that implementation, reusing the same checksum infrastructure as
 * `relinkByContent`. One consequence of how strategy 4 identifies a match: since there's no real "volume id" for
 * a fingerprint match, `DeviceIdentity.id` is the *library* id it matched, not a volumeId - `matchesTrackedDevice`
 * is what accounts for that when deciding if a resolved identity is the device this library is tracking.
 */
@Injectable()
export class DeviceMountService extends BaseService {
  @OnJob({ name: JobName.DeviceMountReconcile, queue: QueueName.Library })
  async handleReconcile(job: JobOf<JobName.DeviceMountReconcile>): Promise<JobStatus> {
    const candidateRoots = await this.volumeInfoRepository.listMountedVolumes();
    const result = await this.reconcilePath(job.id, candidateRoots);

    if (result.relinked) {
      this.logger.log(`Relinked library ${job.id} from ${result.oldPath} to ${result.newPath}`);
    }

    return JobStatus.Success;
  }

  async reconcilePath(libraryId: string, candidateRoots: string[]): Promise<ReconcileResult> {
    const mount = await this.deviceMountRepository.getByLibraryId(libraryId);
    if (!mount) {
      return { reason: 'not-tracked', relinked: false };
    }

    if (await this.pathExists(mount.lastKnownPath)) {
      return { reason: 'still-at-known-path', relinked: false };
    }

    const resolver = new DeviceResolverService(this.volumeInfoRepository);
    const contentMatcher = this.contentMatcherFor(libraryId);

    for (const root of candidateRoots) {
      const identity = await resolver.resolve(root, { contentMatcher });
      if (!identity || !this.matchesTrackedDevice(identity, libraryId, mount.volumeId)) {
        continue;
      }

      // "Ask, don't guess" (work item 5): a content-fingerprint-only match is circumstantial, not proof - don't
      // relink automatically. Record it and wait for confirmPendingMatch/rejectPendingMatch instead.
      if (identity.confidence === DeviceIdentityConfidence.Low) {
        await this.deviceMountRepository.setPendingMatch(mount.id, root);
        return { reason: 'needs-confirmation', relinked: false, oldPath: mount.lastKnownPath, newPath: root };
      }

      await this.relink(libraryId, mount.lastKnownPath, root, identity);
      return { reason: 'relinked', relinked: true, oldPath: mount.lastKnownPath, newPath: root };
    }

    return { reason: 'no-match-found', relinked: false };
  }

  /**
   * Confirms a pending low-confidence match (work item 5): re-resolves the pending path - the drive should still
   * be connected there - and, if it still checks out, relinks exactly as a high/medium-confidence match would.
   * Re-resolving rather than trusting the stored identity blindly means a drive that was unplugged in the
   * meantime doesn't get relinked against stale information.
   */
  async confirmPendingMatch(libraryId: string): Promise<ReconcileResult> {
    const mount = await this.deviceMountRepository.getByLibraryId(libraryId);
    if (!mount?.pendingPath) {
      return { reason: 'no-pending-match', relinked: false };
    }

    const pendingPath = mount.pendingPath;
    const resolver = new DeviceResolverService(this.volumeInfoRepository);
    const contentMatcher = this.contentMatcherFor(libraryId);
    const identity = await resolver.resolve(pendingPath, { contentMatcher });

    if (!identity || !this.matchesTrackedDevice(identity, libraryId, mount.volumeId)) {
      await this.deviceMountRepository.clearPendingMatch(mount.id);
      return { reason: 'no-match-found', relinked: false };
    }

    await this.relink(libraryId, mount.lastKnownPath, pendingPath, identity);
    await this.deviceMountRepository.clearPendingMatch(mount.id);
    return { reason: 'relinked', relinked: true, oldPath: mount.lastKnownPath, newPath: pendingPath };
  }

  /** Rejects a pending low-confidence match (work item 5): clears it without relinking anything. */
  async rejectPendingMatch(libraryId: string): Promise<ReconcileResult> {
    const mount = await this.deviceMountRepository.getByLibraryId(libraryId);
    if (!mount?.pendingPath) {
      return { reason: 'no-pending-match', relinked: false };
    }

    await this.deviceMountRepository.clearPendingMatch(mount.id);
    return { reason: 'no-match-found', relinked: false };
  }

  /** Work item 6 (admin-UI drive status): current status for a library's tracked device, if it has one. */
  async getStatus(libraryId: string): Promise<DeviceMountStatusResponseDto | undefined> {
    const mount = await this.deviceMountRepository.getByLibraryId(libraryId);
    if (!mount) {
      return undefined;
    }

    const isAtLastKnownPath = await this.pathExists(mount.lastKnownPath);
    return mapDeviceMountStatus(mount, isAtLastKnownPath);
  }

  private async relink(libraryId: string, oldPath: string, newPath: string, identity: DeviceIdentity): Promise<void> {
    const library = await this.libraryRepository.get(libraryId);
    if (library) {
      await this.libraryRepository.update(libraryId, {
        importPaths: library.importPaths.map((importPath) => rewritePrefix(importPath, oldPath, newPath)),
      });
    }

    // Fast path: handles the common case of a whole-drive remount where every file's relative path is unchanged -
    // one bulk UPDATE, no file reads.
    await this.assetRepository.rewriteOriginalPathPrefix(libraryId, oldPath, newPath);

    // Fallback: catches files that were also renamed/moved within the drive, which the prefix rewrite above can't
    // follow since it only knows the old and new *mount point*, not the old and new path of any individual file.
    if (library) {
      await this.relinkByContent(library, newPath);
    }

    await this.deviceMountRepository.upsert({
      libraryId,
      volumeId: identity.id,
      identityMethod: identity.method,
      identityConfidence: identity.confidence,
      lastKnownPath: newPath,
    });
  }

  /**
   * Re-identifies files by content checksum rather than path, so a file renamed or moved to a different folder
   * within the same drive still gets recognized as the asset it already is instead of offlined-then-rediscovered.
   * Relies on external assets being checksummed from file content (see LibraryService.processEntity) - a checksum
   * match against an existing asset in this library means "this is that asset, just not at its recorded path
   * anymore", so its `originalPath` gets corrected in place.
   *
   * Walks every file under `newRoot` (library.exclusionPatterns applied, same as a normal scan), skipping any file
   * that already has an asset row at its exact current path - only files that are NOT already correctly linked pay
   * the cost of a content hash.
   */
  private async relinkByContent(
    library: { id: string; ownerId: string; exclusionPatterns: string[] },
    newRoot: string,
  ): Promise<void> {
    const filePaths = await this.storageRepository.crawl({
      pathsToCrawl: [newRoot],
      exclusionPatterns: library.exclusionPatterns,
      includeHidden: false,
    });

    for (const filePath of filePaths) {
      const alreadyLinked = await this.assetRepository.getByLibraryIdAndOriginalPath(library.id, filePath);
      if (alreadyLinked) {
        continue;
      }

      const checksum = await this.cryptoRepository.hashFile(filePath);
      const match = await this.assetRepository.getByChecksum({
        ownerId: library.ownerId,
        libraryId: library.id,
        checksum,
      });
      if (match && match.originalPath !== filePath) {
        await this.assetRepository.update({ id: match.id, originalPath: filePath });
      }
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await this.storageRepository.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A resolved identity is "the device this library is tracking" if it matches `volumeId` - except a content-
   * fingerprint identity, which never has a real volume id: DeviceResolverService sets its `id` to the matched
   * library's id instead (see device-resolver.service.ts). So for that method specifically, the check is against
   * `libraryId` (the library being reconciled) rather than the mount's stored `volumeId`.
   */
  private matchesTrackedDevice(identity: DeviceIdentity, libraryId: string, volumeId: string): boolean {
    return identity.method === DeviceIdentityMethod.ContentFingerprint
      ? identity.id === libraryId
      : identity.id === volumeId;
  }

  /** Builds a ContentFingerprintMatcher scoped to one library, for DeviceResolverService's strategy 4. */
  private contentMatcherFor(libraryId: string): ContentFingerprintMatcher {
    return { match: (mountPath) => this.matchContentFingerprint(libraryId, mountPath) };
  }

  /**
   * Implements DeviceResolverService's content-fingerprint port (work item 2 left this as an injected port until
   * there was a database to check against). Hashes a small sample of files under `mountPath` - not every file,
   * to keep the cost of checking a candidate with no hardware signal at all bounded - and reports what fraction
   * already have a matching checksum recorded somewhere in this library. Reuses the same checksum infrastructure
   * as `relinkByContent`.
   */
  private async matchContentFingerprint(libraryId: string, mountPath: string): Promise<ContentFingerprintMatch | null> {
    const library = await this.libraryRepository.get(libraryId);
    if (!library) {
      return null;
    }

    const filePaths = await this.storageRepository.crawl({
      pathsToCrawl: [mountPath],
      exclusionPatterns: library.exclusionPatterns,
      includeHidden: false,
    });
    const sample = filePaths.slice(0, CONTENT_FINGERPRINT_SAMPLE_SIZE);
    if (sample.length === 0) {
      return null;
    }

    let matched = 0;
    for (const filePath of sample) {
      const checksum = await this.cryptoRepository.hashFile(filePath);
      const asset = await this.assetRepository.getByChecksum({ ownerId: library.ownerId, libraryId, checksum });
      if (asset) {
        matched++;
      }
    }

    return { libraryId, matchRatio: matched / sample.length };
  }
}

/** Replaces `oldPrefix` with `newPrefix` at the start of `value`, leaving it untouched if the prefix doesn't match. */
function rewritePrefix(value: string, oldPrefix: string, newPrefix: string): string {
  return value.startsWith(oldPrefix) ? newPrefix + value.slice(oldPrefix.length) : value;
}
