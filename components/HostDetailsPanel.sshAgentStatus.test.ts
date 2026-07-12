import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./HostDetailsPanel.tsx', import.meta.url), 'utf8');

test('SSH agent availability ignores stale async responses', () => {
  assert.match(source, /let cancelled = false/);
  assert.match(source, /if \(!cancelled\) setSshAgentStatus\(status\)/);
  assert.match(source, /return \(\) => \{\s*cancelled = true/);
});
