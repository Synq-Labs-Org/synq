# Revalidation: Mastra, Temporal, Qwen, Kimi, AI SDK (2026-10-10)

## Mastra
- **Versions:** `@mastra/core@1.75.0` (node ≥22.13, peer zod ^3.25 || ^4, ESM), `@mastra/memory@1.36.0`, `@mastra/libsql@1.25.1`, `mastra` CLI 1.33.0.
- **AgentController:** `import { AgentController } from '@mastra/core/agent-controller'`. GA on 2026-10-06; it was formerly "Harness", and `@mastra/core/harness` is now a deprecated alias.
- **Controller API:** `new AgentController({id, agent, storage, modes, subagents:[{id,description,instructions,allowedControllerTools,defaultModelId}], ...})` → `init()` → `createSession({resourceId})`.
- **Sessions:** `session.sendMessage`, `subscribe`, `permissions.setForTool({policy:'ask'|'deny'})`, `respondToToolApproval`. Session approvals are live-only and do not persist.
- **Supervisor pattern:** `new Agent({agents:{...}})`. `.network()` is deprecated.
- **Structured output:** `agent.generate(msg, {structuredOutput:{schema: zod}})` returns `.object`. `jsonPromptInjection` is a fallback.
- **Tool approval:** `createTool({requireApproval:true})`, then `approveToolCall` / `declineToolCall`.
- **Verified locally:** compiles with TypeScript 5.9.3 and zod 4.6.5 (0 errors) only with `skipLibCheck: true`.
- **Models:** any AI SDK model instance, or `{id:'custom/<m>', url, apiKey}`.

## AI SDK
- `ai@7.0.137`, `@ai-sdk/openai-compatible@3.0.67` (node ≥22, zod 4 ok).
- `createOpenAICompatible({name, baseURL, apiKey, supportsStructuredOutputs, includeUsage, transformRequestBody})`.

## Temporal
- **Versions:** `@temporalio/{client,worker,workflow,activity,testing}@1.24.0` (2026-09-15). Node 22 works; native prebuilds are available for darwin arm64.
- **Versioning:** `patched()` / `deprecatePatch()`. Worker Deployments are GA (`workerDeploymentOptions{version{deploymentName,buildId}, useWorkerVersioning, defaultVersioningBehavior PINNED|AUTO_UPGRADE}`). The old buildId versioning is deprecated.
- **Replay:** `Worker.runReplayHistory(opts, historyJson)` and `runReplayHistories`. Export histories with `temporal workflow show -o json` or `handle.fetchHistory()`.
- **Test environment:** `createTimeSkipping` downloads a Java server and is unsupported on ARM (Rosetta only). Use `createLocal({server:{executable:{type:'existing-path', path:'/opt/homebrew/bin/temporal'}}})` or `createFromExistingServer()`.
- **Messages:** `defineSignal`, `defineQuery`, `defineUpdate` with `setHandler(def, fn, {validator})`. Validators are synchronous and reject by throwing. Client side: `executeUpdate`, `startUpdate`, `executeUpdateWithStart`. Call `condition(allHandlersFinished)` before returning.
- **Schedules:** `client.schedule.create({scheduleId, spec:{intervals|cronExpressions}, action:{type:'startWorkflow',...}, policies:{overlap SKIP|BUFFER_ONE, catchupWindow}})` with pause, unpause, trigger, backfill and delete.
- **CLI:** 1.8.3 installed (bundles server 1.31.2); latest is 1.9.1.

## Qwen (Alibaba Model Studio, OpenAI-compatible)
- **Endpoints:** `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (Singapore legacy, still available), workspace domains `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`, US `https://dashscope-us.aliyuncs.com/compatible-mode/v1`. Keys are region-bound (a mismatch returns 401).
- **Bounty model:** id `qwen3.8-max` (snapshot `qwen3.8-max-2026-09-02`), 1M context. Supports structured outputs and function calling, but not `tool_choice:'required'`.
- **JSON Schema in Singapore:** the docs conflict, so verify live and fall back to `json_object` plus zod validation.

## Kimi (Moonshot)
- **Endpoints:** `https://api.moonshot.ai/v1` (international), `https://api.moonshot.cn/v1` (China). Supports OpenAI Chat, OpenAI Responses and Anthropic formats.
- **Models:** `kimi-k3` (1M context, always thinking, `reasoning_effort`), `kimi-k2.6`, `kimi-k2.7-code`. `response_format` supports `json_object` and `json_schema`; tools are supported.
- **Web search:** the built-in `$web_search` retires on 2026-10-20. Use `POST /v1/tools/search`, `/v1/tools/fetch` instead.
