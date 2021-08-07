import * as assert from 'assert'

export type Result<T, Err> = {ok: T} | {err: Err};

export function OK<T, E>(x: T) { return {ok: x}; }
export function Err<T, E>(x: E) { return {err: x}; }

export function assertOK<T, E>(r: Result<T, E>): T {
  if ('ok' in r) return r.ok;
  assert.fail("expected no error here");
}

export function assertErr<T, E>(r: Result<T, E>): E {
  if ('err' in r) return r.err;
  assert.fail("expected an error here");
}

export function fold<T, E, R>(
  r: Result<T, E>,
  ifOK: (val: T) => R,
  ifErr: (err: E) => R
) {
  return 'ok' in r ? ifOK(r.ok) : ifErr(r.err);
}

export function isOK<T, E>(r: Result<T, E>): r is {ok: T} {
  return fold(r, () => true, () => false);
}

export function isErr<T, E>(r: Result<T, E>): r is {err: E} {
  return fold(r, () => false, () => true);
}
