import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizePluginTerminalProtocol,
  transitionPluginTerminalConnectionState,
} from './usePluginTerminalSessionLifecycle.ts';

const connectedState = {
  cwd: '/srv/old',
  title: 'old backend',
  cols: 120,
  rows: 40,
  alternateScreen: true,
};

test('disconnect clears connection-scoped terminal Provider metadata before publishing', () => {
  assert.deepEqual(
    transitionPluginTerminalConnectionState(connectedState, 'disconnected', true),
    {
      snapshotState: { cols: 120, rows: 40 },
      everConnected: true,
      eventType: 'disconnected',
    },
  );
});

test('reconnect clears stale backend metadata while retaining viewport dimensions', () => {
  assert.deepEqual(
    transitionPluginTerminalConnectionState(connectedState, 'connected', true),
    {
      snapshotState: { cols: 120, rows: 40 },
      everConnected: true,
      eventType: 'reconnected',
    },
  );
});

test('the initial connection preserves its initial cwd snapshot', () => {
  assert.deepEqual(
    transitionPluginTerminalConnectionState({ cwd: '/srv/initial' }, 'connected', false),
    {
      snapshotState: { cwd: '/srv/initial' },
      everConnected: true,
      eventType: 'connected',
    },
  );
});

test('a reconnecting transition clears stale metadata before any later disposal', () => {
  assert.deepEqual(
    transitionPluginTerminalConnectionState(connectedState, 'connecting', true),
    {
      snapshotState: { cols: 120, rows: 40 },
      everConnected: true,
    },
  );
});

test('transition snapshots remain writable for later cwd and title updates', () => {
  const transition = transitionPluginTerminalConnectionState(connectedState, 'connected', true);
  transition.snapshotState.cwd = '/srv/new';
  transition.snapshotState.title = 'new backend';

  assert.deepEqual(transition.snapshotState, {
    cols: 120,
    rows: 40,
    cwd: '/srv/new',
    title: 'new backend',
  });
});

test('terminal lifecycle snapshots preserve dynamic protocol identifiers', () => {
  assert.equal(
    normalizePluginTerminalProtocol('com.example.transport'),
    'com.example.transport',
  );
  assert.equal(normalizePluginTerminalProtocol('mosh'), 'mosh');
  assert.equal(normalizePluginTerminalProtocol(undefined), 'ssh');
});
