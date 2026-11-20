import type { Channel } from './types'

type CredentialTarget = Pick<Channel, 'provider_type' | 'base_url'>

/** Saved secrets may only follow endpoint-path edits within the same provider/origin. */
export function canReuseChannelCredential(saved: CredentialTarget, target: CredentialTarget): boolean {
  if (saved.provider_type !== target.provider_type) return false
  try {
    const before = new URL(saved.base_url.trim())
    const after = new URL(target.base_url.trim())
    return [before, after].every(url =>
      (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password,
    ) && before.origin === after.origin
  } catch {
    return false
  }
}

export const CHANNEL_CREDENTIAL_TARGET_CHANGED = '服务地址或提供商已改变，请重新填写 API Key 后再保存、测试或拉取模型。'
