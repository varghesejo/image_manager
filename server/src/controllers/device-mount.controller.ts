import { Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { DeviceMountStatusResponseDto } from 'src/dtos/device-mount.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { DeviceMountService } from 'src/services/device-mount.service.js';
import { UUIDParamDto } from 'src/validation.js';

/**
 * Work items 5 ("ask, don't guess" confirmation) and 6 (admin-UI drive status) of the PhotoManager plan. Kept as
 * its own controller rather than added to LibraryController, even though every route nests under a library ID -
 * per the plan's own risk notes, new PhotoManager functionality stays in separate modules where it can, to keep
 * upstream merge conflicts limited to files that genuinely need editing (base.service.ts and friends for wiring,
 * not every controller a feature happens to relate to).
 */
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
export class DeviceMountController {
  constructor(private service: DeviceMountService) {}

  @Get(':id/device-mount')
  @Authenticated({ permission: Permission.LibraryRead, admin: true })
  @Endpoint({
    summary: 'Retrieve device mount status',
    description:
      "Retrieve the tracked removable drive's status for an external library: connected, offline, or awaiting confirmation of a low-confidence match.",
    history: new HistoryBuilder().added('v3.2.0'),
  })
  async getDeviceMountStatus(@Param() { id }: UUIDParamDto): Promise<DeviceMountStatusResponseDto> {
    const status = await this.service.getStatus(id);
    if (!status) {
      throw new NotFoundException('This library has no tracked device mount');
    }
    return status;
  }

  @Post(':id/device-mount/confirm')
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Confirm a pending device match',
    description:
      "Confirm a low-confidence candidate match found by reconcile, relinking the library to it. See the 'pending-confirmation' status from the device mount status endpoint.",
    history: new HistoryBuilder().added('v3.2.0'),
  })
  async confirmDeviceMount(@Param() { id }: UUIDParamDto): Promise<void> {
    await this.service.confirmPendingMatch(id);
  }

  @Post(':id/device-mount/reject')
  @Authenticated({ permission: Permission.LibraryUpdate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Reject a pending device match',
    description: 'Reject a low-confidence candidate match found by reconcile, without relinking anything.',
    history: new HistoryBuilder().added('v3.2.0'),
  })
  async rejectDeviceMount(@Param() { id }: UUIDParamDto): Promise<void> {
    await this.service.rejectPendingMatch(id);
  }
}
