/** Register the existing authenticated Connection Fetch download adapter. */
export async function registerBuildDownload(ctx, { studioBuildPromise, getPortableBundles }) {
  const { BUILD_DOWNLOAD_PATH, buildDownloadResponse } = await import('../../build-download-route.mjs');
  ctx.connection.fetch.register({
    path: BUILD_DOWNLOAD_PATH, methods: ['GET', 'HEAD'], requestBody: 'buffered',
    fetch: async request => {
      const bundleId = new URL(request.url).searchParams.get('bundleId');
      return buildDownloadResponse(request, bundleId ? { download: (agentId, buildId) => getPortableBundles().download(agentId, buildId, bundleId) } : (await studioBuildPromise).build);
    },
  });
}
