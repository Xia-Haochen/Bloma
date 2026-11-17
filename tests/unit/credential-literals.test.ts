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
it('keeps default parameters, destructuring, class fields and JSX credentials blocking',()=>{
 const rows=credentialLiterals('main.tsx',`function login(password='real-value') {}
 const {token='real-value'}={};
 class Configuration { secret='real-value' }
 const element=<Client password="real-value" />;`)
 expect(rows).toEqual([1,2,3,4].map(line=>({line,synthetic:false})))
})
