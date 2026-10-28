import {vi} from 'vitest';
export const imageResource=()=>({mime:'image/png',bytes:Uint8Array.from([1,2,3])});
export function blobUrls(){
 let sequence=0;const create=vi.fn(()=>`blob:fixture-${++sequence}`),revoke=vi.fn();
 vi.stubGlobal('URL',class extends URL {static createObjectURL=create;static revokeObjectURL=revoke;});
 return {create,revoke};
}
