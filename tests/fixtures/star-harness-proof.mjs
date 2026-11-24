import { createHash } from 'node:crypto';
import { STAR_HARNESS_UI, STAR_HARNESS_CLIENT_FILE } from '../../src/host/services/star-harness-catalog.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const integrity = 'sha512-' + createHash('sha512').update('fixture').digest('base64');
const releaseFiles = (name, version, files) => ({ name, version, integrity,
  fileHashes: Object.fromEntries(Object.entries(files).map(([path, value]) => [path, sha256(value)])) });

/** Inert DSSE fixture. Tests explicitly inject a verifier and separately validate the manifest's digest. */
export function starHarnessProofFixture(version, files, { dependencies = {}, change = () => {} } = {}) {
  const uiSha256 = sha256(files[STAR_HARNESS_UI][STAR_HARNESS_CLIENT_FILE]);
  const manifest = {
    schemaVersion: 'agentkit.native-packages/v1', sourceCommit: 'c'.repeat(40),
    studio: { engineProtocol: 'agentkit.engine/v1', uiContract: 'agentkit.studio-harness-ui/v1', uiSha256 },
    packages: Object.entries(files).map(([name, rows]) => releaseFiles(name, version, rows)),
    dependencyPackages: Object.fromEntries(Object.entries(dependencies).map(([name, rows]) => {
      const version = JSON.parse(rows['package.json']).version;
      const { integrity, fileHashes } = releaseFiles(name, version, rows);
      return [`${name}@${version}`, { name, version, integrity, files: fileHashes }];
    })),
  };
  change(manifest);
  const wire = Buffer.from(JSON.stringify(manifest));
  const statement = {
    _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'manifest.json', digest: { sha256: sha256(wire) } }],
  };
  return { manifest: wire.toString('base64'), bundle: { dsseEnvelope: {
    payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
  } } };
}
