// All rows are fictional. DDL is copied verbatim from dsh-companion v0.7.20.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function makeFixture(path, now = Math.floor(Date.now() / 1000)) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw new Error('Refusing to overwrite an existing file: ' + path);
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./schema-v0.7.20.sql', import.meta.url), 'utf8'));
  const insert = (sql, ...args) => db.prepare(sql).run(...args);
  for (const [key, value] of [['compact_floor:main','240000'],['compact_backfill:cursor:main','125'],['compact_backfill:day:main',JSON.stringify({date:'2026-11-26',count:3})]]) insert('INSERT INTO schema_meta (key,value) VALUES (?,?)', key, value);
  const fixtureDay = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now * 1000));
  for (const row of [
    [Date.parse('2026-01-01T15:59:00Z'), '2026-01-01', 'main', 70, 1000],
    [Date.parse('2026-01-01T16:01:00Z'), '2026-01-02', 'main', 120, 2000],
    [Date.parse('2026-01-01T16:02:00Z'), '2026-01-02', 'main', 240, 3000],
    [Date.parse('2026-01-01T16:03:00Z'), '2026-01-02', 'task', 9000, 4000],
    [now * 1000, fixtureDay, 'main', 15, 5000],
  ]) insert('INSERT INTO token_usage (at,day_key,source,input_tokens,cache_hit_tokens) VALUES (?,?,?,?,?)', ...row);
  for (const r of [
    ['c1','nap','scheduled',100,'written',now-4200,now-4154],
    ['c2','deep','backfill',125,'compacted',now-2400,now-2311],
    ['c3','forget_flush','manual',170,'written',now-1600,now-1580],
    ['c4','deep','scheduled',210,'failed',now-900,now-886],
  ]) insert('INSERT INTO consolidations (id,scope,session_id,kind,trigger,upto_seq,status,started_at,finished_at) VALUES (?,\'main\',\'fixture\',?,?,?,?,?,?)', ...r);
  for (const r of [
    ['e1','c2','晨间回顾','整理了虚构项目的背景。','normal'],
    ['e2','c2','敏感回顾','敏感的虚构摘要。','sensitive'],
    ['e3','c2','SECRET_EPISODE_TITLE_X','SECRET_EPISODE_SUMMARY_X','secret'],
  ]) insert('INSERT INTO episodes (id,scope,session_id,consolidation_id,started_at,ended_at,title,summary,evidence,mood_evidence,salience,privacy,strength_days,last_reinforced_at,purge_payload) VALUES (?,\'main\',\'fixture\',?,?,?,?,?,\'EVIDENCE_PRIVATE_X\',\'MOOD_EVIDENCE_PRIVATE_X\',\'normal\',?,30,?,\'PURGE_PRIVATE_X\')', r[0],r[1],now-2400,now-2300,r[2],r[3],r[4],now-2300);
  for (const r of [
    ['f1','preference','喜欢在早晨散步','user_explicit','notable','normal','active'],
    ['f2','project','虚构项目偏好使用蓝色','inferred','normal','sensitive','active'],
    ['f3','identity','SECRET_FACT_STATEMENT_X','user_explicit','normal','secret','active'],
    ['f4','knowledge','旧的虚构记录','turn','normal','normal','tombstoned'],
    ['f5','other','完成 100% 的虚构示例','turn','normal','normal','active'],
    ['f6','other','完成 1000 的虚构示例','turn','normal','normal','active'],
  ]) insert('INSERT INTO facts (id,scope,kind,subject_text,predicate,statement,source_kind,source_excerpt,salience,privacy,observed_at,strength_days,last_reinforced_at,status,used_count,purge_payload) VALUES (?,\'main\',?,\'虚构人物\',\'likes\',?,?,\'SOURCE_EXCERPT_PRIVATE_X\',?,?,?,30,?,?,2,\'PURGE_PRIVATE_X\')', r[0],r[1],r[2],r[3],r[4],r[5],now-86400,now-7200,r[6]);
  for (const [i,action] of ['ADD','REINFORCE','UPDATE','TOMBSTONE','PURGED'].entries()) insert('INSERT INTO memory_events (at,action,table_name,row_id,actor,reason,detail_json) VALUES (?,?,?,?,?,?,?)', now-i*1000,action,'facts',['f1','f2','f3','f4','f1'][i],'consolidator','虚构测试事件','DETAIL_PRIVATE_X');
  for (const [at,id] of [[Date.parse('2026-01-01T15:59:00Z')/1000,'f1'],[Date.parse('2026-01-01T16:01:00Z')/1000,'f2']]) insert('INSERT INTO memory_events (at,action,table_name,row_id,actor,reason,detail_json) VALUES (?,\'ADD\',\'facts\',?,\'user\',\'跨日测试\',\'DETAIL_PRIVATE_X\')',at,id);
  insert('INSERT INTO reminders (id,kind,title,status) VALUES (?,?,?,?)','r1','todo','虚构提醒','pending');
  db.close();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] || './data/fixture.db'; makeFixture(path); console.log(`Fictional fixture created at ${path}`);
}
