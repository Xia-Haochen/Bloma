import {fileURLToPath} from 'node:url'
export default async ({test, page, expect, assert, phase}) => {
  if (phase === 'reopened') {
    await test('F-003 真实重开后读回文本', async () => {
      await expect(page.locator('#transcript')).toContainText('开会')
      await expect(page.locator('#reply')).toHaveText('收到，我们下周四下午三点开会。')
    })
    return
  }
  await test('F-001 固定语音真实转写', async () => {
    await page.locator('#input').setInputFiles(fileURLToPath(new URL('./voice-golden.wav', import.meta.url)))
    await expect(page.locator('#transcript')).toContainText('开会', {timeout: 60000})
  })
  await test('F-002 合成语音完整播放', async () => {
    await expect(page.locator('#status')).toHaveText('播放完成', {timeout: 30000})
    const state = await page.locator('#audio').evaluate(audio => ({
      ended: audio.ended, duration: audio.duration, time: audio.currentTime, muted: audio.muted,
    }))
    assert.equal(state.ended, true)
    assert.equal(state.muted, false)
    assert.ok(state.duration > 1 && state.time >= state.duration - .1)
  })
  await test('F-003 保存本轮对话', async () => {
    await expect(page.locator('#reply')).toHaveText('收到，我们下周四下午三点开会。')
  })
}
