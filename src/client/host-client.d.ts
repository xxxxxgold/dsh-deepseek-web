/**
 * 宿主（DSH 0.2.1-rc.2）client 半侧模块的本地类型声明。
 *
 * 为什么需要这个文件：上游 `@deepseek-ai/dsh-client-ui-*` 与
 * `@deepseek-ai/dsh-api-session-controller` 只随包发布编译产物 lib/client.js，
 * 整个 lib 目录下没有任何 .d.ts（`find lib -name '*.d.ts' | wc -l` 为 0）。
 * 因此插件侧惯用的 `import type {} from '…/client'` 声明合并全部落空，
 * `ctx.slots` / `ctx.sessions` / `ctx.uiConversation` 在类型层不可见，
 * `tsc` 会报 TS2307 与 TS2339，而运行时完全正常。
 *
 * 这里按宿主运行时**实际注入**的服务补回最小类型面，只声明本插件真正用到的成员。
 * 成员名逐一对宿主各包的 lib/client.js 核对过：`uiConversation`、`binding`、
 * `activate`、`flush`、`rebuild` 均在其中真实出现。宿主将来随包发布类型声明后，
 * 删除本文件即可，插件源码无需改动。
 *
 * 注意：本文件是 **ambient 声明文件**，顶层不得出现 import/export 语句，
 * 否则 `declare module 'x'` 会退化为模块增强，对不存在的模块仍报 TS2307。
 *
 * @module dsh-deepseek-web-xxxxxgold/client/host-client
 */

declare namespace HostClient {
  /** 会话列表快照；`ids` 是当前可见会话。 */
  interface SessionListSnapshotLike {
    readonly ids: readonly string[]
  }

  /** 会话列表服务：`ctx.sessions.list`。 */
  interface SessionListLike {
    getSnapshot(): SessionListSnapshotLike
    subscribe(listener: () => void): () => void
  }

  /** 单个会话的 binding；`blank` 表示从未使用过的空会话。 */
  interface SessionBindingLike {
    readonly session: { getSnapshot(): { readonly blank: boolean } }
    readonly eventSource: {
      getSnapshot(): { readonly entries: readonly unknown[] }
      subscribe(listener: () => void): () => void
    }
  }

  /** `@deepseek-ai/dsh-api-session-controller/client` 注入的 `sessions` 服务。 */
  interface ISessions {
    readonly list: SessionListLike
    binding(sessionId: string): SessionBindingLike | undefined
  }

  /** `@deepseek-ai/dsh-client-ui-conversation/client` 注入的 `uiConversation` 服务。 */
  interface UiConversation {
    /** 非活动会话会抛错——这正是「只对当前显示的会话生效」的判定点。 */
    binding(sessionId: string): unknown
  }

  /** `@deepseek-ai/dsh-client-ui-renderer/client` 注入的 `slots` 服务。 */
  interface Slots {
    /** 等槽位宿主出现后再注册；回调返回退订函数。 */
    inject(name: string, register: () => () => void): void
    /** 注册一个槽位条目，返回退订函数。 */
    register<P extends object>(
      slot: { readonly name: string; readonly key: string },
      component: (props: P) => import('react').JSX.Element,
    ): () => void
  }
  /**
   * 宿主 client 上下文：cordis 原 `Context` 之上多出的三个宿主注入服务。
   *
   * 不能直接对 `@deepseek-ai/cordis` 做 `declare module` 增强——该包自身的
   * 声明合并走的是相对路径 `./context.ts`（见 events.d.ts / fiber.d.ts），
   * 用包名声明会被当成全新模块，反而把 `effect` / `inject` / `logger` 抹掉。
   */
  interface Context extends import('@deepseek-ai/cordis').Context {
    readonly slots: Slots
    readonly sessions: ISessions
    readonly uiConversation: UiConversation
  }
}

declare module '@deepseek-ai/dsh-client-ui-plugin-manager/client' {
  /** Plugin Manager 传给 `plugins.row.config` 槽位组件的 props。 */
  export interface PluginConfigViewProps {
    readonly view: 'summary' | 'page'
    readonly form?: {
      readonly state: {
        readonly value: unknown
        readonly user?: unknown
        readonly revision?: number
        readonly writable?: boolean
      }
      mutate(ops: readonly unknown[], revision: number | undefined): Promise<boolean>
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-renderer/client' {}
declare module '@deepseek-ai/dsh-client-ui-settings/client' {}
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {}
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  export type ISessions = HostClient.ISessions
}
