import { expect, it } from "vitest";
import { acquisitionFailure, acquisitionRetryAt, fallbackAcquisitionFailure } from "../src/main/article-acquisition";
import { HttpStatusError } from "../src/main/http";
import { RequestAbortedError } from "../src/main/cancellation";

it('retains temporary HTTP status and uses finite 1/5 minute backoff',()=>{
 expect(acquisitionFailure(new HttpStatusError(503))).toBe('http_503');
 expect(acquisitionFailure(new RequestAbortedError())).toBe('timeout');
 expect(acquisitionRetryAt('http_503',1,10)).toBe(60010);
 expect(acquisitionRetryAt('http_503',2,10)).toBe(300010);
 expect(acquisitionRetryAt('http_503',3,10)).toBeNull();
 for(const failure of ['http_403','http_404','access_challenge','robots_disallowed','unknown','summary']) expect(acquisitionRetryAt(failure,1,10)).toBeNull();
});
it('keeps original failure behind a readable Feed and never retries around explicit denial',()=>{
 expect(fallbackAcquisitionFailure([{stage:'static',reason:'no_content'},{stage:'render',reason:'network'}])).toBe('network');
 expect(fallbackAcquisitionFailure([{stage:'static',reason:'http',status:503},{stage:'feed',reason:'feed_body_missing'}])).toBe('http_503');
 expect(fallbackAcquisitionFailure([{stage:'static',reason:'network'},{stage:'render',reason:'http',status:403}])).toBe('http_403');
 expect(fallbackAcquisitionFailure([{stage:'feed',reason:'no_content'}])).toBe('feed_only');
});
