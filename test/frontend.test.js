import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../server.js';

test('frontend is self-contained and preserves the restrictive CSP',async()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8').replace(/<!--[\s\S]*?-->/g,'');
 assert.doesNotMatch(html,/https?:\/\//i);
 assert.doesNotMatch(html,/@import\b/i);
 assert.doesNotMatch(html,/<link\b[^>]*rel\s*=\s*["']?stylesheet/i);
 assert.doesNotMatch(html,/<script\b[^>]*\bsrc\s*=/i);
 const server=createApp();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const r=await fetch(`http://127.0.0.1:${server.address().port}/`);assert.match(r.headers.get('content-security-policy'),/default-src 'none'/);assert.doesNotMatch(r.headers.get('content-security-policy'),/(?:font-src|img-src)\s+[^;]*(?:https?:|data:)/i)}finally{await new Promise(r=>server.close(r))}
});
