import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Host, ManagedSource, ProxyProfile } from './models';
import { deleteGroup, upsertGroup } from './vaultGroupAgentOps';

const hosts: Host[] = [
  { id: 'host-1', label: 'Prod', hostname: 'prod.test', username: 'root', group: 'prod/web', tags: [], os: 'linux' },
  { id: 'jump-1', label: 'Jump', hostname: 'jump.test', username: 'root', tags: [], os: 'linux' },
];
const proxyProfiles: ProxyProfile[] = [{
  id: 'proxy-1', label: 'Proxy', config: { type: 'socks5', host: '127.0.0.1', port: 1080 }, createdAt: 1,
}];

describe('vaultGroupAgentOps', () => {
  it('renames a group and descendants across configs, hosts, and managed sources', () => {
    const result = upsertGroup({
      groups: ['prod', 'prod/web'], configs: [{ path: 'prod/web', username: 'old' }], hosts,
      managedSources: [{ id: 'source-1', groupName: 'prod/web' } as ManagedSource],
    }, 'prod', '{"username":"deploy","proxyProfileId":"proxy-1","jumpHostIds":["jump-1"]}', [], proxyProfiles, { newPath: 'production' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.state.groups, ['production', 'production/web']);
    assert.equal(result.state.hosts[0]?.group, 'production/web');
    assert.equal(result.state.managedSources[0]?.groupName, 'production/web');
    assert.equal(result.config?.username, 'deploy');
  });

  it('rejects missing identities, proxy profiles, and jump hosts', () => {
    const state = { groups: ['prod'], configs: [], hosts, managedSources: [] };
    assert.equal(upsertGroup(state, 'prod', '{"identityId":"missing"}', [], proxyProfiles).ok, false);
    assert.equal(upsertGroup(state, 'prod', '{"proxyProfileId":"missing"}', [], proxyProfiles).ok, false);
    assert.equal(upsertGroup(state, 'prod', '{"jumpHostIds":["missing"]}', [], proxyProfiles).ok, false);
  });

  it('rejects jump hosts that do not resolve to SSH', () => {
    const localHost: Host = {
      id: 'local', label: 'Local', hostname: 'localhost', username: '', protocol: 'local', tags: [], os: 'linux',
    };
    const inheritedHost: Host = {
      id: 'inherited', label: 'Inherited', hostname: 'inherited.test', username: 'root', group: 'telnet/child', tags: [], os: 'linux',
    };
    const state = {
      groups: ['prod', 'telnet', 'telnet/child'],
      configs: [{ path: 'telnet', protocol: 'telnet' as const }],
      hosts: [...hosts, localHost, inheritedHost],
      managedSources: [],
    };

    const localResult = upsertGroup(state, 'prod', '{"jumpHostIds":["local"]}', [], proxyProfiles);
    const inheritedResult = upsertGroup(state, 'prod', '{"jumpHostIds":["inherited"]}', [], proxyProfiles);

    assert.equal(localResult.ok, false);
    assert.equal(inheritedResult.ok, false);
  });

  it('validates jump hosts against their destination group after a rename', () => {
    const jump: Host = {
      id: 'moving-jump', label: 'Moving jump', hostname: 'jump.test', username: 'root',
      group: 'ssh/prod', hostChain: { hostIds: [] }, tags: [], os: 'linux',
    };
    const toTelnet = upsertGroup({
      groups: ['ssh', 'ssh/prod', 'telnet'],
      configs: [{ path: 'ssh', protocol: 'ssh' }, { path: 'telnet', protocol: 'telnet' }],
      hosts: [jump],
      managedSources: [],
    }, 'ssh/prod', '{"jumpHostIds":["moving-jump"]}', [], proxyProfiles, { newPath: 'telnet/prod' });
    const toSsh = upsertGroup({
      groups: ['ssh', 'telnet', 'telnet/prod'],
      configs: [{ path: 'ssh', protocol: 'ssh' }, { path: 'telnet', protocol: 'telnet' }],
      hosts: [{ ...jump, group: 'telnet/prod' }],
      managedSources: [],
    }, 'telnet/prod', '{"jumpHostIds":["moving-jump"]}', [], proxyProfiles, { newPath: 'ssh/prod' });

    assert.equal(toTelnet.ok, false);
    assert.equal(toSsh.ok, true);
  });

  it('rejects group changes that introduce invalid inherited jump relationships', () => {
    const jump: Host = {
      id: 'moving-jump', label: 'Moving jump', hostname: 'jump.test', username: 'root',
      group: 'ssh/prod', tags: [], os: 'linux',
    };
    const outsideTarget: Host = {
      id: 'outside-target', label: 'Outside target', hostname: 'target.test', username: 'root',
      hostChain: { hostIds: [jump.id] }, tags: [], os: 'linux',
    };
    const renameResult = upsertGroup({
      groups: ['ssh', 'ssh/prod', 'telnet'],
      configs: [{ path: 'ssh', protocol: 'ssh' }, { path: 'telnet', protocol: 'telnet' }],
      hosts: [jump, outsideTarget],
      managedSources: [],
    }, 'ssh/prod', '{}', [], proxyProfiles, { newPath: 'telnet/prod' });
    const selfResult = upsertGroup({
      groups: ['prod'], configs: [], hosts: [{ ...jump, group: 'prod' }], managedSources: [],
    }, 'prod', '{"jumpHostIds":["moving-jump"]}', [], proxyProfiles);

    assert.equal(renameResult.ok, false);
    assert.equal(selfResult.ok, false);
  });

  it('keeps create distinct from update and rejects self-descendant moves', () => {
    const state = { groups: ['prod', 'prod/web'], configs: [{ path: 'prod' }], hosts, managedSources: [] };
    assert.equal(upsertGroup(state, 'prod', '{}', [], proxyProfiles, { create: true }).ok, false);
    assert.equal(upsertGroup(state, 'prod', '{}', [], proxyProfiles, { newPath: 'prod/archive' }).ok, false);
  });

  it('rejects renames whose descendants collide with existing groups or configs', () => {
    const groupCollision = upsertGroup({
      groups: ['prod', 'prod/web', 'archive/web'], configs: [], hosts, managedSources: [],
    }, 'prod', '{}', [], proxyProfiles, { newPath: 'archive' });
    assert.equal(groupCollision.ok, false);

    const configCollision = upsertGroup({
      groups: ['prod', 'prod/web'], configs: [{ path: 'archive/web' }], hosts, managedSources: [],
    }, 'prod', '{}', [], proxyProfiles, { newPath: 'archive' });
    assert.equal(configCollision.ok, false);
  });

  it('clears identity-derived defaults when replacing or detaching an identity', () => {
    const state = {
      groups: ['prod'],
      configs: [{ path: 'prod', identityId: 'old', username: 'old-user', authMethod: 'password' as const, savePassword: true }],
      hosts,
      managedSources: [],
    };
    const identity = { id: 'new', label: 'New', username: 'deploy', authMethod: 'key' as const, keyId: 'key-1', created: 1 };
    const replaced = upsertGroup(state, 'prod', '{"identityId":"new"}', [identity], proxyProfiles);
    assert.equal(replaced.ok, true);
    if (replaced.ok) {
      assert.equal(replaced.config?.username, 'deploy');
      assert.equal(replaced.config?.savePassword, undefined);
    }
    const detached = upsertGroup(state, 'prod', '{"identityId":""}', [identity], proxyProfiles);
    assert.equal(detached.ok, true);
    if (detached.ok) {
      assert.equal(detached.config?.identityId, '');
      assert.equal(detached.config?.username, undefined);
      assert.equal(detached.config?.authMethod, undefined);
    }
  });

  it('moves hosts to root by default and refuses managed group deletion', () => {
    const state = { groups: ['prod', 'prod/web'], configs: [{ path: 'prod' }], hosts, managedSources: [] };
    const removed = deleteGroup(state, 'prod', false);
    assert.equal(removed.ok, true);
    if (removed.ok) assert.equal(removed.state.hosts[0]?.group, undefined);
    const managed = deleteGroup({
      ...state, managedSources: [{ id: 'source-1', groupName: 'prod' } as ManagedSource],
    }, 'prod', false);
    assert.equal(managed.ok, false);
  });

  it('refuses to delete hosts that are still used as jump hosts', () => {
    const jump = { ...hosts[1]!, group: 'prod' };
    const target: Host = {
      id: 'target', label: 'Target', hostname: 'target.test', username: 'root',
      hostChain: { hostIds: [jump.id] }, tags: [], os: 'linux',
    };
    const result = deleteGroup({
      groups: ['prod'], configs: [], hosts: [jump, target], managedSources: [],
    }, 'prod', true);

    assert.equal(result.ok, false);
  });

  it('preserves managed status when deleting a subgroup under a managed parent', () => {
    const managedHosts = hosts.map((host) => host.group === 'prod/web' ? { ...host, managedSourceId: 'source-1' } : host);
    const result = deleteGroup({
      groups: ['prod', 'prod/web'], configs: [], hosts: managedHosts,
      managedSources: [{ id: 'source-1', groupName: 'prod' } as ManagedSource],
    }, 'prod/web', false);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.state.hosts[0]?.managedSourceId, 'source-1');
  });
});
