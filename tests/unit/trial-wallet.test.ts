import {expect,it} from 'vitest'
import {createTrialWallet} from '../../scripts/trial-wallet'

it('records live balance changes without turning them into usage or erasing unknown liability',async()=>{
  const records:unknown[]=[]
  let balance:unknown='58.77',reads=0,release!:()=>void
  const wallet=createTrialWallet({startBalance:58.96,record:r=>records.push(r),read:async()=>{reads++;await new Promise<void>(r=>{release=r});return balance}})
  const first=wallet.sample(),second=wallet.sample();expect(reads).toBe(1);release();await Promise.all([first,second])
  expect(wallet.snapshot()).toMatchObject({balance_rmb:58.77,balance_decrease_rmb:.19})
  expect(records[0]).toMatchObject({scope:'account_balance_change_not_per_request_bill'})
  balance=60;const next=wallet.sample();release();await next
  expect(wallet.snapshot()!.balance_decrease_rmb).toBe(-1.04)
})

it('retains the last observation timestamp and records a generic failure when the wallet becomes unavailable',async()=>{
  let now=1000,failed=false
  const records:any[]=[]
  const wallet=createTrialWallet({startBalance:30,now:()=>now,record:r=>records.push(r),read:async()=>{if(failed)throw Error('private provider detail');return '29.8'}})
  await wallet.sample();failed=true;now=2000;await wallet.sample()
  expect(wallet.snapshot()!.at).toBe(new Date(1000).toISOString())
  expect(wallet.snapshot()!.available).toBe(false)
  expect(records[1]).toMatchObject({status:'unavailable',at:new Date(2000).toISOString()})
  expect(JSON.stringify(records)).not.toContain('private')
})
