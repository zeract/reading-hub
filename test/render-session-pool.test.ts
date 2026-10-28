import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const contexts=vi.hoisted(()=>new Map<string,any>());
vi.mock('electron',()=>({session:{fromPartition:(name:string,options:unknown)=>{
  expect(options).toEqual({cache:false});
  if(!contexts.has(name))contexts.set(name,Object.fromEntries(['clearStorageData','clearCache','clearAuthCache','closeAllConnections'].map(key=>[key,vi.fn().mockResolvedValue(undefined)])));
  return contexts.get(name);
}}}));
import {RenderSessionPool} from '../src/main/render-session-pool';
beforeEach(()=>{contexts.clear();vi.useFakeTimers();});
afterEach(()=>vi.useRealTimers());
const signal=()=>new AbortController().signal;
it('bounds context identities across repeated work and waits for every cleanup before reuse',async()=>{
  const pool=new RenderSessionPool(2,2);
  const first=await pool.acquire(signal()),second=await pool.acquire(signal());
  let finish!:()=>void;
  first.session.clearStorageData=vi.fn(()=>new Promise(resolve=>{finish=()=>resolve();}));
  let admitted=false;
  const next=pool.acquire(signal()).then(lease=>{admitted=true;return lease;});
  const cleaning=first.release();
  expect(first.release()).toBe(cleaning);
  await vi.advanceTimersByTimeAsync(0);expect(admitted).toBe(false);
  finish();await cleaning;
  const reused=await next;expect(reused.session).toBe(first.session);
  vi.mocked(first.session.clearStorageData).mockResolvedValue(undefined);
  await reused.release();await second.release();
  for(let i=0;i<100;i++){const lease=await pool.acquire(signal());await lease.release();}
  expect(contexts.size).toBe(2);
  for(const context of contexts.values())for(const method of Object.values(context))expect(method).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds queued work, removes cancelled waiters and quarantines failed contexts',async()=>{
  const pool=new RenderSessionPool(1,1),lease=await pool.acquire(signal());
  const caller=new AbortController();
  const cancelled=expect(pool.acquire(caller.signal)).rejects.toThrow('cancelled');
  await expect(pool.acquire(signal())).rejects.toThrow('等待中的请求过多');
  caller.abort(new Error('cancelled'));await cancelled;
  const waiting=expect(pool.acquire(signal())).rejects.toThrow('未能安全清理');
  vi.mocked(lease.session.clearCache).mockRejectedValue(new Error('native details'));
  await expect(lease.release()).rejects.toThrow('未能安全清理');await waiting;
  await expect(pool.acquire(signal())).rejects.toThrow('未能安全清理');
  expect(contexts.size).toBe(1);expect(vi.getTimerCount()).toBe(0);
});
it('drains detached cleanup on shutdown and rejects further admission',async()=>{
  const pool=new RenderSessionPool(1),lease=await pool.acquire(signal());
  let finish!:()=>void;
  vi.mocked(lease.session.clearStorageData).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const cleaning=lease.release();let closed=false;
  const closing=pool.close().then(()=>{closed=true;});
  await Promise.resolve();expect(closed).toBe(false);
  await expect(pool.acquire(signal())).rejects.toThrow('正在退出');
  finish();await cleaning;await closing;expect(closed).toBe(true);
});
