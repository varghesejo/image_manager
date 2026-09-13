<script lang="ts">
  import AdminCard from '$lib/components/AdminCard.svelte';
  import { handleConfirmDeviceMount, handleRejectDeviceMount } from '$lib/services/library.service';
  import { Badge, Button, Code, Stack, Text, type Color, type MaybePromise } from '@immich/ui';
  import { mdiHarddisk } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import { invalidate } from '$app/navigation';
  import { locale } from '$lib/stores/preferences.store';
  import { Status, type DeviceMountStatusResponseDto } from '@immich/sdk';

  interface Props {
    libraryId: string;
    statusPromise: MaybePromise<DeviceMountStatusResponseDto | undefined>;
  }

  const { libraryId, statusPromise }: Props = $props();

  const statusColor: Record<Status, Color> = {
    [Status.Connected]: 'success',
    [Status.Offline]: 'danger',
    [Status.PendingConfirmation]: 'warning',
  };

  const statusLabel = (status: Status) => {
    switch (status) {
      case Status.Connected: {
        return $t('admin.device_mount_status_connected');
      }
      case Status.Offline: {
        return $t('admin.device_mount_status_offline');
      }
      case Status.PendingConfirmation: {
        return $t('admin.device_mount_status_pending_confirmation');
      }
    }
  };

  let isSubmitting = $state(false);

  const onConfirm = async (pendingPath: string) => {
    isSubmitting = true;
    const success = await handleConfirmDeviceMount(libraryId, pendingPath);
    isSubmitting = false;
    if (success) {
      await invalidate('app:library:device-mount');
    }
  };

  const onReject = async () => {
    isSubmitting = true;
    const success = await handleRejectDeviceMount(libraryId);
    isSubmitting = false;
    if (success) {
      await invalidate('app:library:device-mount');
    }
  };
</script>

{#await statusPromise then status}
  {#if status}
    <AdminCard icon={mdiHarddisk} title={$t('admin.device_mount_status')}>
      <Stack gap={3}>
        <div>
          <Badge color={statusColor[status.status]}>{statusLabel(status.status)}</Badge>
        </div>

        <div>
          <Text size="small" color="secondary">{$t('admin.device_mount_last_known_path')}</Text>
          <Code>{status.lastKnownPath}</Code>
        </div>

        <div>
          <Text size="small" color="secondary">{$t('last_seen')}</Text>
          <Text>
            {DateTime.fromISO(status.lastSeenAt, { locale: $locale }).toLocaleString(DateTime.DATETIME_MED, {
              locale: $locale,
            })}
          </Text>
        </div>

        {#if status.status === Status.PendingConfirmation && status.pendingPath}
          <div class="rounded-lg bg-subtle p-3">
            <Text size="small" color="secondary">
              {$t('admin.device_mount_status_pending_confirmation_description')}
            </Text>
            <div class="mt-2">
              <Text size="small" color="secondary">{$t('admin.device_mount_pending_path')}</Text>
              <Code>{status.pendingPath}</Code>
            </div>
            <div class="mt-3 flex gap-2">
              <Button
                size="small"
                color="success"
                loading={isSubmitting}
                disabled={isSubmitting}
                onclick={() => onConfirm(status.pendingPath!)}
              >
                {$t('admin.device_mount_confirm')}
              </Button>
              <Button
                size="small"
                color="secondary"
                variant="outline"
                loading={isSubmitting}
                disabled={isSubmitting}
                onclick={onReject}
              >
                {$t('admin.device_mount_reject')}
              </Button>
            </div>
          </div>
        {/if}
      </Stack>
    </AdminCard>
  {/if}
{/await}
