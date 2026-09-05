# whale-summarizer（Kaz7.0 whale_summarizer 内部 service）

KazPlugins 正式 Cordis 插件：只挂 Kaz preset，模型不可见，不注册工具/提示段/RPC。

## 作用

在 Kaz 树形会话 close/promote 收口前，用“当前对话同 provider/model + 推理关闭”的
辅助 LLM 请求，为块的**直接 children** 生成带来源的语义摘要。

## 服务协议

```js
const result = await ctx.whaleSummarizer.summarize(
  {
    evidence: [
      { kind: "leaf", id: "ev-000001", text: "原文（level 0）", path: "scope-1/ev-000001" },
      { kind: "block", id: "scope-000002", text: "该 block 已有 summary", path: "scope-1/scope-000002" },
    ],
    refs: [
      { kind: "leaf", id: "ev-000001", path: "scope-1/ev-000001", seq: 11 },
      { kind: "block", id: "scope-000002", path: "scope-1/scope-000002" },
    ],
    purpose: "close-round", // close-round | close-planItem | close-goal | promote
    // opts?: { maxEvidenceChars, maxSummaryChars, maxAttempts, language }
  },
  { agent, signal },
);
// → { summary: string, sourceIds: string[] }
```

硬约束：每次只接收被收口/被升华块直接 children 的语义摘要；leaf=原文、
block=其 summary；不传整棵子树、全部历史、展开/分页；请求是单条独立 user
message，无主会话历史/system/tools/DSH purpose。

## 关键纪律

- provider/model 优先级：`agent.session.requestHeader().config` →
  `agent.options` → `ctx.agentDefaultModel.currentSelection()`。
- 推理显式 `reasoningEffort: "off"`，预检失败不发 LLM。
- 失败默认最多 3 次总尝试（可配置），同 provider/model/API；仍失败报错，
  **不自动确定性降级**，不 close / 不 promote。
- 作用域闸：非 Kaz / 非受控子代理调用返回 `WHALE_SUMMARIZER_SCOPE_DENIED`。

## 安装/回滚

见 `CANDIDATE.md`；回滚快照保留在 `KazPrivatePlugins/process/whale-summarizer/backups/`。

## 探针

```powershell
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\whale-summarizer\probe-core.mjs"
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\whale-summarizer\probe-service.mjs"
node "$env:USERPROFILE\.dsh\profiles\web\KazPlugins\whale-summarizer\probe-registration.mjs"
```

全部离线，无真实网络/API key 依赖。
