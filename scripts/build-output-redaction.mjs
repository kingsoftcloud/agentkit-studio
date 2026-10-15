/** Mask browser launch tokens before build output reaches terminals or log files. */
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export function createBuildOutputRedactor() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const redact = text => text.replace(/([?&]token=)[A-Za-z0-9_-]+/gi, '$1[redacted]');
  return new Transform({
    transform(chunk, _encoding, done) {
      pending += decoder.write(chunk);
      const end = pending.lastIndexOf('\n');
      if (end >= 0) { this.push(redact(pending.slice(0, end + 1))); pending = pending.slice(end + 1); }
      done();
    },
    flush(done) {
      pending += decoder.end();
      if (pending) this.push(redact(pending));
      pending = ''; done();
    },
  });
}
