import { DeviceMountController } from 'src/controllers/device-mount.controller.js';
import { DeviceMountService } from 'src/services/device-mount.service.js';
import request from 'supertest';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(DeviceMountController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(DeviceMountService);

  beforeAll(async () => {
    ctx = await controllerSetup(DeviceMountController, [{ provide: DeviceMountService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  const id = factory.uuid();

  describe('GET /libraries/:id/device-mount', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/libraries/invalid/device-mount');

      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
      expect(service.getStatus).not.toHaveBeenCalled();
    });

    it('should return the status when a device mount is tracked', async () => {
      const deviceMountStatus = {
        status: 'connected' as const,
        volumeId: 'VOLUME-1',
        identityMethod: 'filesystem-serial',
        identityConfidence: 'high',
        lastKnownPath: '/mnt/external/drive',
        lastSeenAt: new Date('2026-09-01T00:00:00Z'),
        assetCount: 10,
        pendingPath: null,
      };
      service.getStatus.mockResolvedValue(deviceMountStatus);

      const { status, body } = await request(ctx.getHttpServer()).get(`/libraries/${id}/device-mount`);

      expect(status).toBe(200);
      expect(body).toMatchObject({ status: 'connected', volumeId: 'VOLUME-1' });
      expect(service.getStatus).toHaveBeenCalledWith(id);
    });

    it('should 404 when the library has no tracked device mount', async () => {
      service.getStatus.mockResolvedValue(undefined);

      const { status } = await request(ctx.getHttpServer()).get(`/libraries/${id}/device-mount`);

      expect(status).toBe(404);
    });
  });

  describe('POST /libraries/:id/device-mount/confirm', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/libraries/invalid/device-mount/confirm');

      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
      expect(service.confirmPendingMatch).not.toHaveBeenCalled();
    });

    it('should confirm the pending match', async () => {
      const { status } = await request(ctx.getHttpServer()).post(`/libraries/${id}/device-mount/confirm`);

      expect(status).toBe(204);
      expect(service.confirmPendingMatch).toHaveBeenCalledWith(id);
    });
  });

  describe('POST /libraries/:id/device-mount/reject', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/libraries/invalid/device-mount/reject');

      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
      expect(service.rejectPendingMatch).not.toHaveBeenCalled();
    });

    it('should reject the pending match', async () => {
      const { status } = await request(ctx.getHttpServer()).post(`/libraries/${id}/device-mount/reject`);

      expect(status).toBe(204);
      expect(service.rejectPendingMatch).toHaveBeenCalledWith(id);
    });
  });
});
