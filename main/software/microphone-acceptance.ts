import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runHostSpeechProbe, saveMicrophoneEvidence, type SpeechVerificationResult, type SpeechVerificationSpec } from '../desktop/speech-verification'
import type { SoftwareRelease } from './release-store'

/** Domain adapter: the session owns identity, cancellation and publication;
 * this adapter only measures capture/ASR and assesses that observation. */
export const microphoneAcceptance = {
  id: 'microphone',
  version: 1,
  spec(candidate: SoftwareRelease): SpeechVerificationSpec {
    return JSON.parse(readFileSync(join(candidate.root, 'CORE_CHECK.json'), 'utf8')).speech
  },
  execute(candidate: SoftwareRelease, controlDir: string, signal: AbortSignal) {
    return runHostSpeechProbe({ projectId: candidate.projectId, root: candidate.root,
      speech: this.spec(candidate), microphone: true, controlDir, persistEvidence: false, signal })
  },
  canConfirm(result: SpeechVerificationResult): boolean {
    return result.status === 'passed' && result.tests?.length === 3 && result.tests.every(test => test.passed)
      && (result.real_decode_calls ?? 0) >= 4 && (result.microphone?.rms ?? 0) >= .001
      && typeof result.microphone?.text === 'string' && result.microphone.text.trim().length > 0
  },
  accept(candidate: SoftwareRelease, result: SpeechVerificationResult, feedback?: { attempt_id: string; candidate_id: string }) {
    if (feedback && !this.canConfirm(result)) throw Error('ASSISTED_OBSERVATION_NOT_CONFIRMABLE')
    saveMicrophoneEvidence(candidate.projectId, candidate.root, this.spec(candidate), result, feedback)
  },
}
