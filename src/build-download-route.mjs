/** Browser-native downloads on DSH's authenticated, same-origin Fetch carrier. */
export const BUILD_DOWNLOAD_PATH = '/api/agentkit.build.download';

export async function buildDownloadResponse(request, build) {
  const query = new URL(request.url).searchParams;
  const agentId = query.get('agentId') || '';
  const buildId = query.get('buildId') || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$/.test(agentId) || agentId.includes('..') || !/^build_[0-9a-f]{20}$/.test(buildId)) {
    return new Response('构建标识无效', { status: 400 });
  }
  try {
    const artifact = await build.download(agentId, buildId);
    return new Response(request.method === 'HEAD' ? null : Buffer.from(artifact.base64, 'base64'), {
      headers: {
        'content-type': artifact.contentType,
        'content-disposition': `attachment; filename="${artifact.filename}"`,
        'content-length': String(artifact.bytes),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    const status = error?.code === 'BUILD_NOT_FOUND' ? 404 : error?.code === 'BUILD_ARTIFACT_INVALID' ? 409 : 500;
    // Filesystem errors may contain the Host's home path.
    return new Response(status === 404 ? '构建产物不存在' : status === 409 ? '构建产物校验失败，请重新构建' : '构建产物下载失败', { status });
  }
}
