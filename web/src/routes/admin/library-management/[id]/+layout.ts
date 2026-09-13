import { getDeviceMountStatus, getLibrary, getLibraryStatistics, type LibraryResponseDto } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { LayoutLoad } from './$types';

export const load = (async ({ params: { id }, url, depends }) => {
  depends('app:library');
  depends('app:library:device-mount');
  await authenticate(url, { admin: true });

  let library: LibraryResponseDto;

  try {
    library = await getLibrary({ id });
  } catch {
    redirect(307, Route.libraries());
  }

  const statisticsPromise = getLibraryStatistics({ id });
  // Most libraries aren't drive-tracked, so a 404 here just means there's nothing to show.
  const deviceMountPromise = getDeviceMountStatus({ id }).catch(() => undefined);
  const $t = await getFormatter();

  return {
    library,
    statisticsPromise,
    deviceMountPromise,
    meta: {
      title: $t('admin.library_details'),
    },
  };
}) satisfies LayoutLoad;
