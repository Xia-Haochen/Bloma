export const TRIAL_MINIMUM_OUTPUT_TOKENS = 2048

/** Initial request must fit even before the monetary state file exists. This is
 * an affordability bound, not a replacement for atomic monetary admission. */
export function trialOutputCap(capRmb:number,configured:number,rate:{context_tokens:number;input_rmb_per_million:number;output_rmb_per_million:number}):number{
  if(!Number.isFinite(capRmb)||capRmb<=0||!Number.isSafeInteger(Math.round(capRmb*1e6))||!Number.isSafeInteger(configured)||configured<1
    ||!Number.isSafeInteger(rate.context_tokens)||rate.context_tokens<1||!Number.isFinite(rate.input_rmb_per_million)||rate.input_rmb_per_million<0
    ||!Number.isFinite(rate.output_rmb_per_million)||rate.output_rmb_per_million<=0)throw Error('TRIAL_OUTPUT_QUOTE_INVALID')
  const input=Math.ceil(rate.context_tokens*rate.input_rmb_per_million),available=Math.floor(capRmb*1e6)-input
  let limit=Math.min(configured,Math.floor(available/rate.output_rmb_per_million))
  while(limit>0&&Math.ceil(limit*rate.output_rmb_per_million)>available)limit--
  if(limit<TRIAL_MINIMUM_OUTPUT_TOKENS)throw Error('TRIAL_CAP_BELOW_COMPLETE_INPUT_RESERVE')
  return limit
}
