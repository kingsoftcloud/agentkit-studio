import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const run = promisify(execFile);

/** Verify the actual workspace and, when needed, the separate Studio status view. */
export function connectedSuccessorUI(observation, retainedSessionTitles = []) {
  const text = observation.axText;
  if (typeof text !== 'string' || !text.includes('dsh-app://app/') || !/(外框 会话|outline Sessions)/.test(text)) return false;
  const host = observation.hostAxText;
  const connected = /(Host 已连接|Host connected)/.test(text)
    || typeof host === 'string' && host.includes('dsh-app://app/')
      && /Studio Host[\s\S]*已成功读取 Host 配置[\s\S]*已连接/.test(host);
  return connected && retainedSessionTitles.every(title => text.includes(title));
}

/** LaunchServices does not preserve the qualification journal environment.
 * An operator may instead capture the successor's actual CUA window, while
 * this observer independently checks that the old process exited and the
 * installed executable restarted. Neither method launches a successor.
 */
export async function observeInstalledSuccessor({ file, install, originalPid, installedAt, retainedSessionTitles = [] }) {
  let observation;
  try { observation = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const time = Date.parse(observation.observedAt);
  if (observation.appPath !== install || !Number.isFinite(time) || time < installedAt || time > Date.now() + 5000) throw new Error('stale or foreign successor UI observation');
  const text = observation.axText;
  if (!connectedSuccessorUI(observation, retainedSessionTitles)) throw new Error('successor UI has not reached a connected workspace with the retained sessions');
  if (observation.hostAxText && !observation.hostScreenshotPath) throw new Error('separate Host status observation requires its native screenshot');
  if (observation.hostScreenshotPath) {
    const hostImage = await readFile(observation.hostScreenshotPath);
    if (!hostImage.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && !hostImage.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) throw new Error('Host status screenshot must be a native PNG or JPEG capture');
  }
  const screenshot = await readFile(observation.screenshotPath);
  const png = screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = screenshot.subarray(0, 3).equals(Buffer.from([255, 216, 255])) && screenshot.subarray(-2).equals(Buffer.from([255, 217]));
  if (!png && !jpeg) throw new Error('successor UI screenshot must be a native PNG or JPEG capture');
  const executable = join(install, 'Contents/MacOS/AgentKit Studio');
  const lines = (await run('/bin/ps', ['-ax', '-o', 'pid=,command='])).stdout.split('\n');
  const pids = lines.flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match?.[2] === executable ? [Number(match[1])] : [];
  });
  if (pids.includes(originalPid)) return null;
  if (pids.length !== 1) throw new Error('expected exactly one restarted installed application process');
  return { kind: 'native-ui-and-process', originalPid, successorPid: pids[0], observedAt: observation.observedAt,
    observationFile: file, screenshotPath: observation.screenshotPath,
    axSha256: createHash('sha256').update(text).digest('hex'), screenshotSha256: createHash('sha256').update(screenshot).digest('hex') };
}
