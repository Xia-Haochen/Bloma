import { expect, it } from 'vitest'
import { validateSoftwareCommand } from '../../../main/software/command-runtime'

it.each([['npm','ls','--global','--depth=0'],['npm','--global','list'],['npm','root','-g'],['pnpm','list','--global'],['yarn','list','--global']])('permits read-only package discovery: %j',(...command)=>{
  expect(validateSoftwareCommand(command)).toEqual(command)
})
it.each([['npm','install','-g','package'],['npm','-g','install','package'],['npm','install','--global=true','package'],['npm','--prefix','list','install','-g'],['npm','publish'],['npm','config','set','prefix','elsewhere']])('retains authorization for package mutations: %j',(...command)=>{
  expect(()=>validateSoftwareCommand(command)).toThrow('COMMAND_REQUIRES_SEPARATE_AUTHORIZATION')
})
