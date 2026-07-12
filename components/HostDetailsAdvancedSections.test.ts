import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./HostDetailsAdvancedSections.tsx', import.meta.url), 'utf8');

test('advanced host settings expose per-host SSH connection timeouts', () => {
  assert.match(source, /hostDetails\.section\.sshTimeouts/);
  assert.match(source, /value=\{form\.sshTcpConnectTimeoutSeconds \?\?/);
  assert.match(source, /update\("sshTcpConnectTimeoutSeconds", value\)/);
  assert.match(source, /value=\{form\.sshAuthReadyTimeoutSeconds \?\?/);
  assert.match(source, /update\("sshAuthReadyTimeoutSeconds", value\)/);
  assert.equal(source.match(/!Number\.isFinite\(value\)/g)?.length, 2);
});

test('editing enabled SSH agent controls persists the enabled state', () => {
  assert.match(source, /enabled=\{form\.useSshAgent === true\}/);
  assert.match(source, /useSshAgent: true,\s*identityAgent:/);
  assert.match(source, /useSshAgent: true,\s*identitiesOnly:/);
});
