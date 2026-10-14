import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsDownloadEvidence } from '../src/windows-update-evidence.mjs';
const log = 'Full: 100,000 KB, To download: 10,000 KB (10%)';
const state = {phase:'verifying',transferredBytes:10240000,totalDownloadBytes:10240000};
test('a differential plan alone is not real transferred bytes',()=>{
  assert.equal(windowsDownloadEvidence({log,states:[],fullBytes:102400000}).kind,'not-established');
  assert.equal(windowsDownloadEvidence({log,states:[{...state,transferredBytes:100}],fullBytes:102400000}).kind,'not-established');
});
test('completed native differential transfer is smaller than the public full installer',()=>{
  assert.deepEqual(windowsDownloadEvidence({log,states:[state],fullBytes:102400000}),{
    kind:'native-differential',transferredBytes:10240000,fullBytes:102400000,ratioPercent:10,actualCompletedProgress:true});
});
test('full fallback cannot pass differential qualification even after a plan or progress',()=>{
  assert.equal(windowsDownloadEvidence({log:log+' Cannot download differentially',states:[state],fullBytes:102400000}).kind,'full-fallback');
  assert.equal(windowsDownloadEvidence({log,states:[state],fullBytes:10240000}).kind,'not-established');
});
