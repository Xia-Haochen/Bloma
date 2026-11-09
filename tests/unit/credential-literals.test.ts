import {expect,it} from 'vitest'
import {credentialLiterals} from '../../main/verification/credential-literals'
it('distinguishes real bindings from comments, script examples and narrow synthetic test data',()=>{
 expect(credentialLiterals('main.js',`// password='comment'
 const cleanup="delete config where password='example'";
 const password='real-value';`)).toEqual([{line:3,synthetic:false}])
 expect(credentialLiterals('tests/check.mjs',`test('login',()=>{const password='synthetic-password'})`)).toEqual([{line:1,synthetic:true}])
 expect(credentialLiterals('main.js',`const password='synthetic-password'`)[0].synthetic).toBe(false)
 expect(credentialLiterals('tests/config.js',`export const password='synthetic-password'`)[0].synthetic).toBe(false)
 expect(credentialLiterals('tests/check.mjs',`test('login',()=>{const password='real-password'})`)[0].synthetic).toBe(false)
})
