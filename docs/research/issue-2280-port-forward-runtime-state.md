# Issue #2280：端口转发运行状态调研

调研日期：2026-07-17
范围：Netcatty `v1.1.68` 与当前 `main` 的端口转发启动、停止、自动启动、跨窗口同步和后端生命周期；外部对照只采用官方源码或文档。

## 结论

Issue #2280 的现象可以由当前代码完整解释，并非单纯的显示延迟：**自动启动成功后，真实连接状态只写入了 localStorage，没有更新当前窗口正在订阅的内存状态。** 浏览器的 `storage` 事件不会回送给发起写入的同一窗口，因此页面仍显示 `inactive`；同时，后台连接表已经是 `active`，现有 4 秒核对逻辑看不到“后台连接表发生变化”，也就不会刷新页面。用户再次点“启动”时，服务层又把已有连接视为幂等成功并直接返回，但不会补发 `active`，所以页面无法自愈。

这条链路与 issue 中“自动启动后实际已经开启、界面显示未开启、无法停止”逐项一致。原始复现和截图见 [Issue #2280](https://github.com/binaricat/Netcatty/issues/2280)。报告使用的 `v1.1.68` 源码与当前 `main` 在这条链路上相同。

## 现有机制

### 1. 两套状态同时存在

- Electron 主进程的 `portForwardingTunnels` 保存真实 SSH 连接、监听端口和当前阶段；`listPortForwards()` 从这里返回运行中的隧道。[主进程实现](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/electron/bridges/portForwardingBridge.cjs#L28-L29) / [列表接口](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/electron/bridges/portForwardingBridge.cjs#L741-L753)
- Renderer 的 `activeConnections` 又维护一份连接表；React 页面显示的则是 `globalRules[].status`。页面状态只在 `setGlobalRules()` 通知订阅者后才会变化。[连接表](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/infrastructure/services/portForwardingService.ts#L48-L56) / [页面 store](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/application/state/usePortForwardingState.ts#L87-L120)
- `status` 和 `error` 还被放进持久化的规则对象；启动时再用 renderer 连接表覆盖它们。[规则模型](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/domain/models/portForwarding.ts#L5-L24) / [初始化](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/application/state/usePortForwardingState.ts#L122-L135)

因此当前不是“一个真相来源”，而是主进程、renderer 连接表、React 规则列表和 localStorage 四处互相同步。

### 2. Issue #2280 的确定性断点

自动启动绕过了 `usePortForwardingState.startTunnel()`，直接调用底层 `startPortForward()`；它的状态回调 `updateStoredRuleStatus()` 只执行 localStorage 写入。[自动启动回调](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/application/state/usePortForwardingAutoStart.ts#L190-L210) / [直接启动](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/application/state/usePortForwardingAutoStart.ts#L274-L327)

同一窗口的规则 store 只监听原生 `storage` 事件来接收外部窗口写入，没有同窗口通知通道。[storage 监听](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/application/state/usePortForwardingState.ts#L176-L199)

随后会出现一个稳定的错误状态：

1. 主进程隧道为 `active`；renderer `activeConnections` 也已被状态事件更新为 `active`。[状态事件处理](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/infrastructure/services/portForwardingService.ts#L674-L703)
2. React 的 `globalRules` 仍为 `inactive`，所以卡片只显示“启动”，不显示“停止”。[按钮条件](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/components/port-forwarding/RuleCard.tsx#L48-L49) / [启停按钮](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/components/port-forwarding/RuleCard.tsx#L132-L166)
3. 定时核对只在 renderer 连接表相对后端出现、消失或阶段改变时返回变化；此时两边都已经是 `active`，所以不会刷新 React store。[核对实现](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/infrastructure/services/portForwardingService.ts#L415-L499) / [页面刷新条件](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/application/state/usePortForwardingState.ts#L220-L246)
4. 用户点“启动”时，底层发现连接已存在便直接返回成功，但不调用状态回调，因此页面仍然无法恢复。[幂等早退](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/infrastructure/services/portForwardingService.ts#L519-L529)

### 3. 深挖后发现的其他准确性风险

这些不一定是本 issue 的首要触发条件，但如果目标是“状态准确无误”，应一起纳入修复边界：

- **停止失败仍显示已停止。** renderer 调用后端停止后，无论 `result.success` 是真是假，都会删除本地连接并通知 `inactive`；而主进程在清理失败时会返回 `success: false` 并保留隧道。两边会再次分叉。[renderer 停止](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/infrastructure/services/portForwardingService.ts#L788-L824) / [主进程失败语义](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/electron/bridges/portForwardingBridge.cjs#L46-L91)
- **跨窗口可能为同一规则创建多个隧道。** renderer 的幂等判断只看本窗口内存；主进程 `startPortForward` 不按 `ruleId` 去重。两个窗口在同步前并发启动时，主进程 Map 可留下多个 tunnel。普通停止只按单个 `tunnelId` 停止，虽然另有 `stopPortForwardByRuleId` 能全部清理。[启动登记](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/electron/bridges/portForwardingBridge.cjs#L99-L205) / [单 tunnel 停止](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/electron/bridges/portForwardingBridge.cjs#L704-L724) / [按规则停止](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/electron/bridges/portForwardingBridge.cjs#L771-L794)
- **恢复依赖从 tunnelId 反解 UUID。** 后端对象本身已有 `ruleId`，但列表接口不返回它；renderer 只能解析 `pf-{UUID}-{timestamp}`。导入或旧数据若不是标准 UUID，就无法恢复和核对。[反解逻辑](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/infrastructure/services/portForwardingService.ts#L346-L378) / [列表缺少 ruleId](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/electron/bridges/portForwardingBridge.cjs#L741-L753)
- **核对失败被当作“无需变化”。** bridge 不可用或查询抛错时返回空变化，页面会继续展示旧状态；目前没有 `unknown`/`unavailable` 阶段来表达“暂时无法确认”。[失败处理](https://github.com/binaricat/Netcatty/blob/892f3f6ff90157922cbcbdedb4aea055b6e00bd9/infrastructure/services/portForwardingService.ts#L427-L499)

## 成熟项目的做法

### OpenSSH：只有监听建立成功才算启动成功

OpenSSH 的 `ExitOnForwardFailure=yes` 会在任一动态、本地、远程转发无法建立监听时终止连接；与后台运行配合时，也会等待转发建立成功后才进入后台。[OpenBSD 官方 ssh_config(5)](https://man.openbsd.org/ssh_config.5#ExitOnForwardFailure)

可借鉴点：`active` 必须来自端口监听/远端 forward 确认，而不是来自“用户点过启动”或持久化标记；启动失败必须保留为可见错误。

### Tabby：运行集合只在资源真的建立后加入，停止后立即移除

Tabby 的本地/动态转发先等待 listener 的 `listening`，成功后才把 `ForwardedPort` 放进 `forwardedPorts`；失败则抛错，不登记为运行中。远程转发也只有服务器确认 `forwardTCPPort` 后才加入集合。停止时关闭真实 listener 或发出远程取消，然后从同一个运行集合移除。[Tabby `addPortForward` / `removePortForward`](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-ssh/src/session/ssh.ts#L786-L845) 转发对象本身持有 listener，SSH session 销毁时统一关闭所有 listener。[ForwardedPort](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-ssh/src/session/forwards.ts#L6-L54) / [session 清理](https://github.com/Eugeny/tabby/blob/14e2d60b9b6dee84a53c37f05eefeb803787de04/tabby-ssh/src/session/ssh.ts#L146-L150)

可借鉴点：配置列表与“当前运行集合”分开；运行集合里的对象就是可停止的真实资源，不需要再从配置状态猜测。

### VS Code：服务持有唯一运行表，并通过 opened/closed 事件驱动所有消费者

VS Code 的 tunnel service 暴露 `tunnels`、`onTunnelOpened`、`onTunnelClosed`、`openTunnel` 和 `closeTunnel`；内部 Map 保存真实 tunnel Promise，并对同一 tunnel 做引用计数。[接口与运行表](https://github.com/microsoft/vscode/blob/b1b978c118c517376df3d95696201265e0d84264/src/vs/platform/tunnel/common/tunnel.ts#L120-L144) / [内部 Map](https://github.com/microsoft/vscode/blob/b1b978c118c517376df3d95696201265e0d84264/src/vs/platform/tunnel/common/tunnel.ts#L224-L238) 只有 provider 成功返回真实 tunnel 后才发 `onTunnelOpened`；失败对象会从 Map 清除。最后一个引用释放或强制关闭时，先等待资源 dispose，再从 Map 删除并发 `onTunnelClosed`。[打开流程](https://github.com/microsoft/vscode/blob/b1b978c118c517376df3d95696201265e0d84264/src/vs/platform/tunnel/common/tunnel.ts#L352-L399) / [关闭流程](https://github.com/microsoft/vscode/blob/b1b978c118c517376df3d95696201265e0d84264/src/vs/platform/tunnel/common/tunnel.ts#L401-L466)

可借鉴点：真实资源由一个服务统一拥有；页面和其他窗口订阅同一组 opened/closed 事件，不能各自维护一个“差不多同步”的状态副本。

### Electerm：连接关闭直接关闭监听资源

Electerm 在本地监听的 `listen` 回调后才 resolve 启动；监听失败则 reject。SSH 连接关闭时，它会销毁所有活跃 socket 并关闭本地 listener；动态转发也在 SSH close 时关闭 SOCKS server。[Electerm 官方源码](https://github.com/electerm/electerm/blob/6fbddfe55c66bffcb5aaad23676c0dd006e16367/src/app/server/ssh-tunnel.js#L78-L139) / [SOCKS 生命周期](https://github.com/electerm/electerm/blob/6fbddfe55c66bffcb5aaad23676c0dd006e16367/src/app/server/ssh-tunnel.js#L142-L202)

可借鉴点：transport 生命周期直接决定转发是否存在；SSH close 与 listener close 是同一条清理链，而不是靠页面心跳推断。

## 建议的修复方向

### P0：修复 issue 的最小闭环

1. 自动启动必须走与手动启动相同的状态发布路径，成功、失败、重连都更新当前窗口的规则 store；不能只写 localStorage。
2. 已存在连接的幂等启动必须把当前真实状态回传给调用者，至少补发 `connecting`/`active`，让错误页面能自愈。
3. 后台核对后应以完整快照重新派生页面状态，不能只看 renderer 连接表是否变化；或者直接比较“后台快照”和“页面显示值”。
4. 停止只有在后端确认成功后才能发布 `inactive`；失败时保留原状态和可重试的停止按钮，并展示错误。

### P1：收敛为单一真相来源

1. 让主进程按 `ruleId` 持有且唯一化运行实例，列表接口直接返回 `ruleId`、`tunnelId`、明确阶段和错误，不再解析 tunnelId。
2. 把规则配置和运行状态拆开：持久化只保存配置与 `autoStart`；`status/error` 只由主进程运行快照和事件生成。
3. 主进程广播规则级状态变化给所有窗口；新窗口先取一次完整快照，再订阅增量事件，避免订阅与快照之间的竞态。
4. 正常停止也按 `ruleId` 操作，确保历史重复实例能一次收干净；主进程 start 对同一规则做幂等或串行化。
5. 查询失败时不要显示确定的“已停止”，应保持最后已知状态并标记“状态待确认”，直到重新取得后台快照。

## 必须覆盖的验证矩阵

- 自动启动：`inactive → connecting → active`，当前窗口不用切页或等待 storage 事件即可显示“停止”。
- Issue 原路径：启动自动启动规则，关闭主窗口但保留托盘进程，再打开窗口；页面状态与端口监听一致，且可停止。
- 完整退出后重启：旧连接已经清理，自动启动只创建一个新实例。
- 同规则双窗口同时启动：主进程最终只有一个运行实例；两个窗口都显示 active。
- 从另一窗口启动/停止：本窗口及时收到状态；漏掉事件后用完整快照仍能恢复。
- 启动监听失败（端口占用）、SSH 握手失败、远程 forward 被拒绝：不得显示 active。
- 停止时 listener/SSH 清理失败：不得显示 inactive；再次停止仍可操作。
- SSH 异常断开和自动重连：`active → connecting → active/error` 顺序一致，不出现幽灵 active。
- 非 UUID 的导入规则：仍能按显式 `ruleId` 恢复、核对和停止。
- 后台列表查询暂时失败后恢复：不得把未知误判成 inactive，恢复后与后台快照一致。

## 修复判定标准

不能只断言 localStorage 里的 `status` 变了。测试至少同时证明：主进程运行实例、renderer 收到的运行快照、页面规则状态、按钮动作四者一致；并用真实 TCP listener 验证 active 时端口可连接、inactive 时端口已释放。
