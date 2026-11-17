import { expect, it } from 'vitest'
import { serializeRedactedJson } from '../../shared/redacted-json'
import { redactSoftwareOutput } from '../../main/software/process-manager'
it('preserves JSON shape and escaped text while removing credentials from values and credential fields',()=>{
  const original={message:'Cookie: session=secret\nnext "quoted" \\ path',nested:{api_key:'opaque-credential',count:0,passed:false},items:['password=hunter2',null]}
  const encoded=serializeRedactedJson(original,redactSoftwareOutput),parsed=JSON.parse(encoded)
  expect(parsed).toEqual({message:'Cookie: [REDACTED]\nnext "quoted" \\ path',nested:{api_key:'[REDACTED]',count:0,passed:false},items:['password=[REDACTED]',null]})
  expect(original.nested.api_key).toBe('opaque-credential')
})
