/** Host-only refusal before entering provider transport. A plain error string
 * or cancellation is not proof that a request was never sent. */
export class ModelRequestRefusal extends Error {
  readonly nonRetryable=true
  constructor(code:string){super(code);this.name='ModelRequestRefusal'}
}
