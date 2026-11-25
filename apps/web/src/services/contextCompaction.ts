import {
  buildCompactionUserPrompt,
  COMPACTION_SYSTEM_PROMPT,
  estimateMessageTokens,
  extractCompactionSummary,
  type CompactionBudget,
  type CompactionPlan,
  type ContextCheckpoint,
} from '@tavern-chat/core'
import { streamChatCompletion } from './llm/client.ts'
import type { ProviderConfig } from './settings.ts'

const makeCheckpointId = (): string =>
  'ckpt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

/**
 * 用当前对话模型执行高保真滚动压缩。原始消息不删除、不修改；
 * 只把早期历史折叠成 checkpoint.summary，供后续请求注入。
 */
export async function runCompaction({
  plan,
  provider,
  budget,
  customGatewayOrigin,
  signal,
  onProgress,
}: {
  plan: CompactionPlan
  provider: ProviderConfig
  budget: CompactionBudget
  customGatewayOrigin?: string
  signal?: AbortSignal
  onProgress?: (chunk: number, total: number) => void
}): Promise<ContextCheckpoint> {
  let rollingSummary = plan.previousCheckpoint?.summary ?? ''

  for (let index = 0; index < plan.chunks.length; index += 1) {
    onProgress?.(index + 1, plan.chunks.length)
    let raw = ''
    await streamChatCompletion({
      provider,
      messages: [
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildCompactionUserPrompt({
            previousSummary: rollingSummary || undefined,
            chunkText: plan.chunks[index] ?? '',
            chunkIndex: index,
            totalChunks: plan.chunks.length,
          }),
        },
      ],
      temperature: 0.2,
      maxTokens: budget.summaryMaxTokens,
      customGatewayOrigin,
      signal,
      onEvent: (event) => {
        if (event.type === 'delta') raw += event.text
      },
    })

    const extracted = extractCompactionSummary(raw)
    if (!extracted) {
      throw new Error('上下文压缩返回了空摘要')
    }
    rollingSummary = extracted
  }

  return {
    id: makeCheckpointId(),
    upToMessageId: plan.targetAnchorMessageId,
    ...(plan.previousCheckpoint ? { previousCheckpointId: plan.previousCheckpoint.id } : {}),
    summary: rollingSummary,
    coveredRounds: plan.coveredRounds,
    summaryTokens: estimateMessageTokens(rollingSummary),
    createdAt: Date.now(),
  }
}
