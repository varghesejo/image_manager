import { JobStatus } from 'src/enum.js';
import { DeviceMountService } from 'src/services/device-mount.service.js';
import { DeviceIdentityConfidence, DeviceIdentityMethod } from 'src/services/device-resolver/device-resolver.types.js';
import { newTestService } from 'test/utils.js';

const LIBRARY_ID = 'library-1';

const baseMount = {
  id: 'mount-1',
  libraryId: LIBRARY_ID,
  volumeId: 'KNOWN-VOLUME-ID',
  identityMethod: DeviceIdentityMethod.FilesystemSerial,
  identityConfidence: DeviceIdentityConfidence.High,
  lastKnownPath: '/mnt/external/old-mount',
  pendingPath: null,
  lastSeenAt: new Date('2026-09-01T00:00:00Z'),
  assetCount: 42,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};

/** Makes DeviceResolverService's strategies 1-3 fail, forcing it to fall through to the content-fingerprint one. */
function noHardwareSignal(mocks: ReturnType<typeof newTestService<DeviceMountService>>['mocks']) {
  mocks.volumeInfo.getFilesystemSerial.mockResolvedValue(null);
  mocks.volumeInfo.getUsbHardwareSerial.mockResolvedValue(null);
  mocks.volumeInfo.readMarkerFile.mockResolvedValue(null);
}

describe(DeviceMountService.name, () => {
  describe('handleReconcile', () => {
    it('discovers candidate roots itself and delegates to reconcilePath', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      mocks.volumeInfo.listMountedVolumes.mockResolvedValue(['/mnt/external/new-mount']);
      mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
      mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
      mocks.volumeInfo.getFilesystemSerial.mockResolvedValue(baseMount.volumeId);
      mocks.library.get.mockResolvedValue({
        id: LIBRARY_ID,
        ownerId: 'owner-1',
        exclusionPatterns: [],
        importPaths: [],
      } as any);
      mocks.storage.crawl.mockResolvedValue([]);

      const status = await sut.handleReconcile({ id: LIBRARY_ID });

      expect(mocks.volumeInfo.listMountedVolumes).toHaveBeenCalled();
      expect(mocks.deviceMount.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ lastKnownPath: '/mnt/external/new-mount' }),
      );
      expect(status).toBe(JobStatus.Success);
    });

    it('succeeds without relinking when nothing matches', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      mocks.volumeInfo.listMountedVolumes.mockResolvedValue([]);
      mocks.deviceMount.getByLibraryId.mockResolvedValue(undefined);

      await expect(sut.handleReconcile({ id: LIBRARY_ID })).resolves.toBe(JobStatus.Success);
    });
  });

  it('does nothing for a library with no tracked device', async () => {
    const { sut, mocks } = newTestService(DeviceMountService);
    mocks.deviceMount.getByLibraryId.mockResolvedValue(undefined);

    const result = await sut.reconcilePath(LIBRARY_ID, ['/mnt/external/candidate']);

    expect(result).toEqual({ reason: 'not-tracked', relinked: false });
    expect(mocks.storage.stat).not.toHaveBeenCalled();
  });

  it('does nothing when the last-known path still exists', async () => {
    const { sut, mocks } = newTestService(DeviceMountService);
    mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
    mocks.storage.stat.mockResolvedValue({} as any);

    const result = await sut.reconcilePath(LIBRARY_ID, ['/mnt/external/candidate']);

    expect(result).toEqual({ reason: 'still-at-known-path', relinked: false });
    expect(mocks.volumeInfo.getFilesystemSerial).not.toHaveBeenCalled();
  });

  it('relinks the library and its assets when a candidate root matches the tracked volume', async () => {
    const { sut, mocks } = newTestService(DeviceMountService);
    mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
    mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
    mocks.volumeInfo.getFilesystemSerial.mockImplementation((root: string) =>
      Promise.resolve(root === '/mnt/external/new-mount' ? baseMount.volumeId : null),
    );
    mocks.library.get.mockResolvedValue({
      id: LIBRARY_ID,
      ownerId: 'owner-1',
      exclusionPatterns: [],
      importPaths: ['/mnt/external/old-mount/Photos', '/other/unrelated/path'],
    } as any);
    mocks.storage.crawl.mockResolvedValue([]);

    const result = await sut.reconcilePath(LIBRARY_ID, ['/mnt/external/unrelated', '/mnt/external/new-mount']);

    expect(result).toEqual({
      reason: 'relinked',
      relinked: true,
      oldPath: '/mnt/external/old-mount',
      newPath: '/mnt/external/new-mount',
    });

    // only the import path actually under the old mount gets rewritten; the unrelated one is untouched
    expect(mocks.library.update).toHaveBeenCalledWith(LIBRARY_ID, {
      importPaths: ['/mnt/external/new-mount/Photos', '/other/unrelated/path'],
    });

    expect(mocks.asset.rewriteOriginalPathPrefix).toHaveBeenCalledWith(
      LIBRARY_ID,
      '/mnt/external/old-mount',
      '/mnt/external/new-mount',
    );

    expect(mocks.deviceMount.upsert).toHaveBeenCalledWith({
      libraryId: LIBRARY_ID,
      volumeId: baseMount.volumeId,
      identityMethod: DeviceIdentityMethod.FilesystemSerial,
      identityConfidence: DeviceIdentityConfidence.High,
      lastKnownPath: '/mnt/external/new-mount',
    });
  });

  it('stops checking further candidates once a match is found', async () => {
    const { sut, mocks } = newTestService(DeviceMountService);
    mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
    mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
    mocks.volumeInfo.getFilesystemSerial
      .mockResolvedValueOnce(baseMount.volumeId)
      .mockResolvedValueOnce('should-not-be-reached');
    mocks.library.get.mockResolvedValue({
      id: LIBRARY_ID,
      ownerId: 'owner-1',
      exclusionPatterns: [],
      importPaths: [],
    } as any);
    mocks.storage.crawl.mockResolvedValue([]);

    await sut.reconcilePath(LIBRARY_ID, ['/mnt/external/first', '/mnt/external/second']);

    expect(mocks.volumeInfo.getFilesystemSerial).toHaveBeenCalledTimes(1);
  });

  it('reports no match when no candidate resolves to the tracked volume', async () => {
    const { sut, mocks } = newTestService(DeviceMountService);
    mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
    mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
    mocks.volumeInfo.getFilesystemSerial.mockResolvedValue('SOME-OTHER-VOLUME');

    const result = await sut.reconcilePath(LIBRARY_ID, ['/mnt/external/a', '/mnt/external/b']);

    expect(result).toEqual({ reason: 'no-match-found', relinked: false });
    expect(mocks.library.update).not.toHaveBeenCalled();
    expect(mocks.asset.rewriteOriginalPathPrefix).not.toHaveBeenCalled();
    expect(mocks.deviceMount.upsert).not.toHaveBeenCalled();
  });

  it('relinks a file renamed within the drive by matching its content checksum', async () => {
    const { sut, mocks } = newTestService(DeviceMountService);
    mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
    mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
    mocks.volumeInfo.getFilesystemSerial.mockResolvedValue(baseMount.volumeId);
    mocks.library.get.mockResolvedValue({
      id: LIBRARY_ID,
      ownerId: 'owner-1',
      exclusionPatterns: [],
      importPaths: [],
    } as any);
    // the file now lives at a different relative path than any asset is recorded at, so the prefix rewrite can't
    // find it - relinkByContent has to hash it and match by checksum instead.
    mocks.storage.crawl.mockResolvedValue(['/mnt/external/new-mount/Reorganized/vacation.jpg']);
    mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(undefined);
    mocks.crypto.hashFile.mockResolvedValue(Buffer.from('content-checksum'));
    mocks.asset.getByChecksum.mockResolvedValue({
      id: 'asset-42',
      originalPath: '/mnt/external/old-mount/Photos/vacation.jpg',
    } as any);

    await sut.reconcilePath(LIBRARY_ID, ['/mnt/external/new-mount']);

    expect(mocks.crypto.hashFile).toHaveBeenCalledWith('/mnt/external/new-mount/Reorganized/vacation.jpg');
    expect(mocks.asset.getByChecksum).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      libraryId: LIBRARY_ID,
      checksum: Buffer.from('content-checksum'),
    });
    expect(mocks.asset.update).toHaveBeenCalledWith({
      id: 'asset-42',
      originalPath: '/mnt/external/new-mount/Reorganized/vacation.jpg',
    });
  });

  it('skips the content-checksum fallback for a file already linked at its current path', async () => {
    const { sut, mocks } = newTestService(DeviceMountService);
    mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
    mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
    mocks.volumeInfo.getFilesystemSerial.mockResolvedValue(baseMount.volumeId);
    mocks.library.get.mockResolvedValue({
      id: LIBRARY_ID,
      ownerId: 'owner-1',
      exclusionPatterns: [],
      importPaths: [],
    } as any);
    mocks.storage.crawl.mockResolvedValue(['/mnt/external/new-mount/Photos/vacation.jpg']);
    mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue({ id: 'asset-42' } as any);

    await sut.reconcilePath(LIBRARY_ID, ['/mnt/external/new-mount']);

    expect(mocks.crypto.hashFile).not.toHaveBeenCalled();
    expect(mocks.asset.update).not.toHaveBeenCalled();
  });

  it('does not update an asset when no checksum match is found for an unlinked file', async () => {
    const { sut, mocks } = newTestService(DeviceMountService);
    mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
    mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
    mocks.volumeInfo.getFilesystemSerial.mockResolvedValue(baseMount.volumeId);
    mocks.library.get.mockResolvedValue({
      id: LIBRARY_ID,
      ownerId: 'owner-1',
      exclusionPatterns: [],
      importPaths: [],
    } as any);
    mocks.storage.crawl.mockResolvedValue(['/mnt/external/new-mount/Photos/new-file.jpg']);
    mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(undefined);
    mocks.crypto.hashFile.mockResolvedValue(Buffer.from('no-match'));
    mocks.asset.getByChecksum.mockResolvedValue(undefined);

    await sut.reconcilePath(LIBRARY_ID, ['/mnt/external/new-mount']);

    expect(mocks.asset.update).not.toHaveBeenCalled();
  });

  it('still relinks the asset paths and mount record when the library row is missing', async () => {
    const { sut, mocks } = newTestService(DeviceMountService);
    mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
    mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
    mocks.volumeInfo.getFilesystemSerial.mockResolvedValue(baseMount.volumeId);
    mocks.library.get.mockResolvedValue(undefined);

    const result = await sut.reconcilePath(LIBRARY_ID, ['/mnt/external/new-mount']);

    expect(result.relinked).toBe(true);
    expect(mocks.library.update).not.toHaveBeenCalled();
    expect(mocks.asset.rewriteOriginalPathPrefix).toHaveBeenCalledWith(
      LIBRARY_ID,
      '/mnt/external/old-mount',
      '/mnt/external/new-mount',
    );
  });

  describe('content fingerprint / "ask, don\'t guess" (work item 5)', () => {
    it('parks a high-ratio content-fingerprint match as pending instead of relinking it', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
      mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
      noHardwareSignal(mocks);
      mocks.library.get.mockResolvedValue({
        id: LIBRARY_ID,
        ownerId: 'owner-1',
        exclusionPatterns: [],
        importPaths: [],
      } as any);
      mocks.storage.crawl.mockResolvedValue([
        '/mnt/external/new-mount/a.jpg',
        '/mnt/external/new-mount/b.jpg',
        '/mnt/external/new-mount/c.jpg',
        '/mnt/external/new-mount/d.jpg',
      ]);
      mocks.crypto.hashFile.mockResolvedValue(Buffer.from('x'));
      mocks.asset.getByChecksum.mockResolvedValue({ id: 'asset-1' } as any); // every sampled file "matches"

      const result = await sut.reconcilePath(LIBRARY_ID, ['/mnt/external/new-mount']);

      expect(result).toEqual({
        reason: 'needs-confirmation',
        relinked: false,
        oldPath: '/mnt/external/old-mount',
        newPath: '/mnt/external/new-mount',
      });
      expect(mocks.deviceMount.setPendingMatch).toHaveBeenCalledWith(baseMount.id, '/mnt/external/new-mount');
      expect(mocks.deviceMount.upsert).not.toHaveBeenCalled();
      expect(mocks.library.update).not.toHaveBeenCalled();
    });

    it('does not park a match when the sampled ratio is below the threshold', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
      mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
      noHardwareSignal(mocks);
      mocks.library.get.mockResolvedValue({
        id: LIBRARY_ID,
        ownerId: 'owner-1',
        exclusionPatterns: [],
        importPaths: [],
      } as any);
      mocks.storage.crawl.mockResolvedValue(['/mnt/external/new-mount/a.jpg']);
      mocks.crypto.hashFile.mockResolvedValue(Buffer.from('x'));
      mocks.asset.getByChecksum.mockResolvedValue(undefined); // nothing matches

      const result = await sut.reconcilePath(LIBRARY_ID, ['/mnt/external/new-mount']);

      expect(result).toEqual({ reason: 'no-match-found', relinked: false });
      expect(mocks.deviceMount.setPendingMatch).not.toHaveBeenCalled();
    });

    it('confirms a pending match by re-resolving it, then relinks and clears the pending path', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      const pendingMount = { ...baseMount, pendingPath: '/mnt/external/pending-mount' };
      mocks.deviceMount.getByLibraryId.mockResolvedValue(pendingMount);
      noHardwareSignal(mocks);
      mocks.library.get.mockResolvedValue({
        id: LIBRARY_ID,
        ownerId: 'owner-1',
        exclusionPatterns: [],
        importPaths: ['/mnt/external/old-mount/Photos'],
      } as any);
      mocks.storage.crawl.mockResolvedValue(['/mnt/external/pending-mount/a.jpg']);
      mocks.crypto.hashFile.mockResolvedValue(Buffer.from('x'));
      mocks.asset.getByChecksum.mockResolvedValue({ id: 'asset-1' } as any);
      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(undefined);

      const result = await sut.confirmPendingMatch(LIBRARY_ID);

      expect(result).toEqual({
        reason: 'relinked',
        relinked: true,
        oldPath: '/mnt/external/old-mount',
        newPath: '/mnt/external/pending-mount',
      });
      expect(mocks.deviceMount.clearPendingMatch).toHaveBeenCalledWith(pendingMount.id);
      expect(mocks.asset.rewriteOriginalPathPrefix).toHaveBeenCalledWith(
        LIBRARY_ID,
        '/mnt/external/old-mount',
        '/mnt/external/pending-mount',
      );
    });

    it('clears a pending match without relinking when it no longer re-resolves', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      const pendingMount = { ...baseMount, pendingPath: '/mnt/external/pending-mount' };
      mocks.deviceMount.getByLibraryId.mockResolvedValue(pendingMount);
      noHardwareSignal(mocks);
      mocks.library.get.mockResolvedValue({
        id: LIBRARY_ID,
        ownerId: 'owner-1',
        exclusionPatterns: [],
        importPaths: [],
      } as any);
      mocks.storage.crawl.mockResolvedValue([]); // drive no longer has anything there

      const result = await sut.confirmPendingMatch(LIBRARY_ID);

      expect(result).toEqual({ reason: 'no-match-found', relinked: false });
      expect(mocks.deviceMount.clearPendingMatch).toHaveBeenCalledWith(pendingMount.id);
      expect(mocks.asset.rewriteOriginalPathPrefix).not.toHaveBeenCalled();
    });

    it('reports no pending match to confirm when there is none', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount); // pendingPath: null

      await expect(sut.confirmPendingMatch(LIBRARY_ID)).resolves.toEqual({
        reason: 'no-pending-match',
        relinked: false,
      });
      expect(mocks.deviceMount.clearPendingMatch).not.toHaveBeenCalled();
    });

    it('rejects a pending match by clearing it without relinking', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      const pendingMount = { ...baseMount, pendingPath: '/mnt/external/pending-mount' };
      mocks.deviceMount.getByLibraryId.mockResolvedValue(pendingMount);

      const result = await sut.rejectPendingMatch(LIBRARY_ID);

      expect(result).toEqual({ reason: 'no-match-found', relinked: false });
      expect(mocks.deviceMount.clearPendingMatch).toHaveBeenCalledWith(pendingMount.id);
      expect(mocks.asset.rewriteOriginalPathPrefix).not.toHaveBeenCalled();
    });

    it('reports no pending match to reject when there is none', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);

      await expect(sut.rejectPendingMatch(LIBRARY_ID)).resolves.toEqual({
        reason: 'no-pending-match',
        relinked: false,
      });
      expect(mocks.deviceMount.clearPendingMatch).not.toHaveBeenCalled();
    });
  });

  describe('getStatus (work item 6)', () => {
    it('returns undefined for a library with no tracked device', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      mocks.deviceMount.getByLibraryId.mockResolvedValue(undefined);

      await expect(sut.getStatus(LIBRARY_ID)).resolves.toBeUndefined();
    });

    it('reports "connected" when the last-known path exists', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
      mocks.storage.stat.mockResolvedValue({} as any);

      const status = await sut.getStatus(LIBRARY_ID);

      expect(status).toMatchObject({ status: 'connected', volumeId: baseMount.volumeId, pendingPath: null });
    });

    it('reports "offline" when the last-known path is missing and nothing is pending', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      mocks.deviceMount.getByLibraryId.mockResolvedValue(baseMount);
      mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));

      const status = await sut.getStatus(LIBRARY_ID);

      expect(status).toMatchObject({ status: 'offline' });
    });

    it('reports "pending-confirmation" whenever a pending path is set, regardless of disk state', async () => {
      const { sut, mocks } = newTestService(DeviceMountService);
      const pendingMount = { ...baseMount, pendingPath: '/mnt/external/pending-mount' };
      mocks.deviceMount.getByLibraryId.mockResolvedValue(pendingMount);
      mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));

      const status = await sut.getStatus(LIBRARY_ID);

      expect(status).toMatchObject({ status: 'pending-confirmation', pendingPath: '/mnt/external/pending-mount' });
    });
  });
});
