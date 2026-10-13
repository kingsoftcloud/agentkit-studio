import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedSuccessorUI } from '../scripts/installed-update-successor.mjs';

const workspace = 'HTML 内容 AgentKit Studio, URL: dsh-app://app/\n外框 会话\nrow Mac 更新数据保留验收';
const host = 'HTML 内容 AgentKit Studio, URL: dsh-app://app/\n文本 Studio Host\n文本 已成功读取 Host 配置\n文本 已连接';

test('native Studio status and workspace captures prove connection and retained session together', () => {
  assert.equal(connectedSuccessorUI({ axText: workspace, hostAxText: host }, ['Mac 更新数据保留验收']), true);
  assert.equal(connectedSuccessorUI({ axText: workspace, hostAxText: host }, ['another profile session']), false);
  assert.equal(connectedSuccessorUI({ axText: workspace, hostAxText: host.replace('已连接', '未连接') }), false);
  assert.equal(connectedSuccessorUI({ axText: workspace, hostAxText: '已连接' }), false);
  assert.equal(connectedSuccessorUI({ axText: host, hostAxText: host }), false);
});
