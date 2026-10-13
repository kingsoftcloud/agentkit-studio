/**
 * Runtime-owned cloud endpoint policy.
 *
 * The public control plane is part of the product contract. The standard
 * intranet KOP and IAM origins are public service addresses (they are only
 * reachable from the internal network), so they are safe defaults here. A
 * trusted Host runtime may override them for a private deployment variant.
 * Every use still has to match the exact approved origin before cloud
 * credentials are signed onto it.
 */
const PUBLIC_KOP = new URL('https://aicp.api.ksyun.com');
const PUBLIC_IAM = new URL('https://iam.api.ksyun.com');
const DEFAULT_INNER_KOP = new URL('http://aicp.inner.api.ksyun.com');
const DEFAULT_INNER_IAM = new URL('http://iam.inner.api.ksyun.com');

function cleanOrigin(value, label) {
  if (!value) return null;
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`${label} must be an origin`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be a credential-free origin without a port or path`);
  }
  return url;
}

function sameOrigin(left, right) {
  return Boolean(left && right && left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port);
}

function isCleanOrigin(url) {
  return Boolean(url && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash);
}

export function createCloudEndpointPolicy({ innerKopUrl = '', innerIamUrl = '' } = {}) {
  // Empty values are treated the same as an omitted runtime override. This
  // keeps the normal installation zero-configuration while still allowing a
  // trusted deployment to select another exact origin.
  const innerKop = cleanOrigin(innerKopUrl || DEFAULT_INNER_KOP, 'inner KOP URL');
  const innerIam = cleanOrigin(innerIamUrl || DEFAULT_INNER_IAM, 'inner IAM URL');
  // A fallback must select another origin; accepting the public origin here
  // would turn an inner-account denial into an unbounded retry loop.
  if (sameOrigin(innerKop, PUBLIC_KOP) || sameOrigin(innerIam, PUBLIC_IAM)) {
    throw new Error('inner endpoints must differ from their public origins');
  }
  const isPublicKop = url => isCleanOrigin(url) && sameOrigin(url, PUBLIC_KOP);
  const isInnerKop = url => isCleanOrigin(url) && sameOrigin(url, innerKop);
  const isKop = url => isPublicKop(url) || isInnerKop(url);
  const isPublicIam = url => isCleanOrigin(url) && sameOrigin(url, PUBLIC_IAM);
  return Object.freeze({
    publicKop: PUBLIC_KOP,
    publicIam: PUBLIC_IAM,
    innerKop,
    innerIam,
    isPublicKop,
    isInnerKop,
    isKop,
    isPublicIam,
    isAllowedControlPlane: url => isPublicKop(url) || isInnerKop(url),
  });
}
