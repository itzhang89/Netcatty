import test from "node:test";
import assert from "node:assert/strict";

import type { Host, PortForwardingRule } from "../../domain/models.ts";
import { STORAGE_KEY_PORT_FORWARDING } from "../../infrastructure/config/storageKeys.ts";
import {
  startPortForward,
  stopAndCleanupRuleAndWait,
} from "../../infrastructure/services/portForwardingService.ts";
import { createPortForwardingStorageSyncHandlers } from "./usePortForwardingState.ts";

const rule: PortForwardingRule = {
  id: "startup-rule",
  label: "Startup tunnel",
  type: "local",
  localPort: 18080,
  remoteHost: "127.0.0.1",
  remotePort: 8080,
  hostId: "host-1",
  autoStart: true,
  createdAt: 1,
  status: "inactive",
};

const host: Host = {
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
};

function installEnvironment() {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const backing = new Map<string, string>();
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;

  const storage: Storage = {
    get length() { return backing.size; },
    clear() { backing.clear(); },
    getItem(key) { return backing.get(key) ?? null; },
    key(index) { return Array.from(backing.keys())[index] ?? null; },
    removeItem(key) { backing.delete(key); },
    setItem(key, value) { backing.set(key, value); },
  };

  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
      },
    },
  });

  return {
    storage,
    emitStatus(status: PortForwardingRule["status"]) {
      statusListener?.(status);
    },
    restore() {
      if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

test("same-window auto-start status writes refresh the visible rule from the live tunnel", async (t) => {
  const env = installEnvironment();
  t.after(async () => {
    await stopAndCleanupRuleAndWait(rule.id);
    env.restore();
  });

  env.storage.setItem(STORAGE_KEY_PORT_FORWARDING, JSON.stringify([rule]));
  await startPortForward(rule, host, [host], [], [], () => undefined, true);
  env.emitStatus("active");

  const snapshots: PortForwardingRule[][] = [];
  const handlers = createPortForwardingStorageSyncHandlers({
    onRules: (rules) => snapshots.push(rules),
  });

  handlers.handleAdapterChange({
    type: "netcatty:local-storage-adapter-changed",
    detail: { key: STORAGE_KEY_PORT_FORWARDING },
  } as unknown as CustomEvent<{ key: string }>);

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.[0]?.status, "active");
});
