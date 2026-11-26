import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeFixture } from '../scripts/make-fixture.js';
import { createApp } from '../server.js';

test('week covers seven Shanghai dates with exclusive midnight boundaries and no text', async () => {
  const dir=mkdtempSync(join(tmpdir(),'viz-week-')), path=join(dir,'fixture.db');
  makeFixture(path,Date.parse('2026-01-03T04:00:00Z')/1000);
  const db=new DatabaseSync(path);
  const add=db.prepare('INSERT INTO memory_events (at,action,table_name,row_id,actor,reason,detail_json) VALUES (?,?,?,?,?,?,?)');
  for(const iso of ['2025-12-27T15:59:59Z','2025-12-27T16:00:00Z','2026-01-01T15:59:00Z','2026-01-01T16:01:00Z','2026-01-03T15:59:59Z','2026-01-03T16:00:00Z'])
    add.run(Date.parse(iso)/1000,'DECAY','facts','f3','user','PRIVATE_WEEK_REASON_X','DETAIL_PRIVATE_X');
  db.close();
  const server=createApp({snapshot:path,clock:()=>new Date('2026-01-03T04:00:00Z')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    const response=await fetch(base+'/api/week');assert.equal(response.status,200);
    const text=await response.text(), data=JSON.parse(text);
    assert.deepEqual(data.days.map(d=>d.date),['2025-12-28','2025-12-29','2025-12-30','2025-12-31','2026-01-01','2026-01-02','2026-01-03']);
    assert.deepEqual(data.days.map(d=>d.counts.DECAY??0),[1,0,0,0,1,1,1]);
    for(const value of ['PRIVATE_WEEK_REASON_X','SECRET_FACT_STATEMENT_X','SECRET_EPISODE_TITLE_X','SECRET_EPISODE_SUMMARY_X','PURGE_PRIVATE_X','SOURCE_EXCERPT_PRIVATE_X','EVIDENCE_PRIVATE_X','MOOD_EVIDENCE_PRIVATE_X','DETAIL_PRIVATE_X','虚构测试事件'])assert.ok(!text.includes(value),value);
    for (const method of ['POST','PUT','DELETE','PATCH','HEAD','OPTIONS']) {const r=await fetch(base+'/api/week',{method});assert.equal(r.status,405);assert.equal(r.headers.get('allow'),'GET')}
  } finally {await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true})}
});
