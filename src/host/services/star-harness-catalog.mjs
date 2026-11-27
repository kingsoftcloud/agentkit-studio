import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { verify } from 'sigstore';

if (process.versions.electron) {
  const require = createRequire(import.meta.url);
  const fromSigstore = createRequire(require.resolve('sigstore'));
  const fromVerifier = createRequire(fromSigstore.resolve('@sigstore/verify'));
  const { crypto } = fromVerifier('@sigstore/core');
  const originalVerify = crypto.verify;
  // Sigstore's Rekor and DSSE checks rely on Node's implicit SHA-256 for EC
  // keys. Electron requires the digest to be passed explicitly.
  crypto.verify = (data, key, signature, algorithm) => originalVerify(data, key, signature,
    algorithm === undefined && key?.asymmetricKeyType === 'ec' ? 'sha256' : algorithm);
}

const repository = 'kingsoftcloud/ksadk-harness';
const releasePrefix = 'https://github.com/' + repository + '/releases/download/';
const workflow = 'https://github.com/' + repository + '/.github/workflows/publish-npm.yml@refs/tags/v';
const manifestName = 'studio-harness-release.json';
const bundleName = 'studio-harness-release.bundle.json';
const artifactLimit = 8 * 1024 * 1024;

export const STAR_HARNESS_PACKAGE = '@kingsoftcloud/agentkit-harness-node';
export const STAR_HARNESS_CORE = '@kingsoftcloud/agentkit-harness-core';
export const STAR_HARNESS_UI = '@kingsoftcloud/agentkit-harness-ui';
export const STAR_HARNESS_CLIENT_FILE = 'dist/studio-client.mjs';
export const STAR_HARNESS_UI_CONTRACT = 'agentkit.studio-harness-ui/v1';
export const STAR_HARNESS_ENGINE_PROTOCOL = 'agentkit.engine/v1';
export const starHarnessVersion = version => typeof version === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version);
export function compareStarHarnessVersions(a, b) {
  const [majorA, minorA, patchA] = a.split('.').map(Number);
  const [majorB, minorB, patchB] = b.split('.').map(Number);
  return majorA - majorB || minorA - minorB || patchA - patchB;
}

const sha256 = /^[a-f0-9]{64}$/;
const integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;
const packageName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;
const dependencyVersion = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

async function releaseArtifact(fetchImpl, version, name, signal) {
  const response = await fetchImpl(releasePrefix + 'v' + version + '/' + name, {
    signal: AbortSignal.any([AbortSignal.timeout(15000), signal].filter(Boolean)),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Object.assign(Error('StarOrigin Harness release evidence unavailable'), { status: response.status });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > artifactLimit) throw Error('StarOrigin Harness release evidence exceeds its size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function fetchStarHarnessProof(version, { fetchImpl, signal }) {
  if (!starHarnessVersion(version)) throw Error('Invalid StarOrigin Harness version');
  const [manifest, bundle] = await Promise.all([
    releaseArtifact(fetchImpl, version, manifestName, signal), releaseArtifact(fetchImpl, version, bundleName, signal),
  ]);
  return { manifest: manifest.toString('base64'), bundle: JSON.parse(bundle) };
}

function validFiles(files) {
  return object(files) && sha256.test(files['package.json'] ?? '')
    && Object.values(files).every(value => typeof value === 'string' && sha256.test(value));
}

export async function verifyStarHarnessProof(version, proof, { verifySignature = verify, cachePath, offline = false } = {}) {
  if (!starHarnessVersion(version) || typeof proof?.manifest !== 'string' || proof.manifest.length > artifactLimit * 2
    || !object(proof.bundle)) throw Error('Invalid StarOrigin Harness release evidence');
  const bytes = Buffer.from(proof.manifest, 'base64');
  const bundle = proof.bundle;
  if (bytes.length > artifactLimit || bundle.dsseEnvelope?.payloadType !== 'application/vnd.in-toto+json')
    throw Error('Invalid StarOrigin Harness attestation format');
  await verifySignature(bundle, {
    certificateIdentityURI: workflow + version, certificateIssuer: 'https://token.actions.githubusercontent.com',
    tlogThreshold: 1, timeout: 10000, retry: 1, tufCachePath: cachePath, tufForceCache: offline,
  });
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (statement._type !== 'https://in-toto.io/Statement/v1' || statement.predicateType !== 'https://slsa.dev/provenance/v1'
    || !statement.subject?.some(subject => subject.name === 'manifest.json' && subject.digest?.sha256 === digest))
    throw Error('StarOrigin Harness manifest differs from the attested artifact');

  const manifest = JSON.parse(bytes);
  const studio = manifest.studio;
  if (manifest.schemaVersion !== 'agentkit.native-packages/v1' || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '')
    || studio?.engineProtocol !== STAR_HARNESS_ENGINE_PROTOCOL || studio.uiContract !== STAR_HARNESS_UI_CONTRACT
    || !sha256.test(studio.uiSha256 ?? '') || !Array.isArray(manifest.packages) || manifest.packages.length !== 3)
    throw Error('StarOrigin Harness release has an incompatible upgrade contract');

  const names = [STAR_HARNESS_CORE, STAR_HARNESS_PACKAGE, STAR_HARNESS_UI];
  const packages = Object.fromEntries(manifest.packages.map(pin => [pin.name, { ...pin, files: pin.fileHashes }]));
  for (const name of names) {
    const pin = packages[name];
    if (!pin || pin.version !== version || !integrity.test(pin.integrity ?? '') || !validFiles(pin.files))
      throw Error('StarOrigin Harness package pins must match the release version');
  }
  if (packages[STAR_HARNESS_UI].files[STAR_HARNESS_CLIENT_FILE] !== studio.uiSha256)
    throw Error('StarOrigin Harness UI digest does not match its package');
  const dependencies = { [STAR_HARNESS_CORE]: version };
  const dependencyPackages = manifest.dependencyPackages;
  if (!object(dependencyPackages)) throw Error('Invalid StarOrigin Harness dependency evidence');
  for (const [key, pin] of Object.entries(dependencyPackages)) {
    if (!object(pin) || !packageName.test(pin.name ?? '') || names.includes(pin.name)
      || !dependencyVersion.test(pin.version ?? '') || key !== pin.name + '@' + pin.version
      || Object.hasOwn(dependencies, pin.name) || !integrity.test(pin.integrity ?? '') || !validFiles(pin.files))
      throw Error('StarOrigin Harness dependency pins are invalid or ambiguous');
    Object.defineProperty(dependencies, pin.name, { value: pin.version, enumerable: true });
  }
  return { packages, dependencies, dependencyPackages, uiSha256: studio.uiSha256 };
}
