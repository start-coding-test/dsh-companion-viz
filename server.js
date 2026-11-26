import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(new URL('./public/index.html', import.meta.url));
const PRIVATE = '（私密）';
const shanghaiOffset = new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Shanghai', timeZoneName:'longOffset'});
function localMidnight(utcMidnight) {
  let result = utcMidnight;
  for (let i = 0; i < 4; i++) {
    const zone = shanghaiOffset.formatToParts(new Date(result)).find(p => p.type === 'timeZoneName')?.value;
    const match = zone?.match(/^GMT([+-])(\d{2}):(\d{2})(?:\x3a(\d{2}))?$/);
    if (!match) throw new Error('Unsupported Shanghai offset');
    const seconds = (Number(match[2])*3600 + Number(match[3])*60 + Number(match[4] || 0)) * (match[1] === '+' ? 1 : -1);
    const next = utcMidnight - seconds * 1000;
    if (next === result) break;
    result = next;
  }
  return result / 1000;
}
export function shanghaiDayBounds(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date');
  const utc = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0,10) !== date) throw new Error('Invalid date');
  return [localMidnight(utc), localMidnight(utc + 86400000)];
}
function today() { return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); }
function meta(db, key) { return db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key)?.value ?? null; }
function numberOrNull(x) { if (x === null || String(x).trim() === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; }
function dayMeta(db) { try { const j=JSON.parse(meta(db,'compact_backfill:day:main')); return j && typeof j === 'object' ? {date: typeof j.date === 'string' ? j.date : null, count: numberOrNull(j.count)} : null; } catch { return null; } }
function fact(row) {
  const { privacy, ...r } = row;
  if (privacy === 'secret') return {id:r.id,status:r.status,observed_at:r.observed_at,last_reinforced_at:r.last_reinforced_at,created_at:r.created_at,updated_at:r.updated_at,statement:PRIVATE};
  return {...r, sensitive:privacy === 'sensitive'};
}
function episode(row) {
  const {privacy,...r}=row;
  if (privacy === 'secret') return {id:r.id,status:r.status,started_at:r.started_at,ended_at:r.ended_at,created_at:r.created_at,title:PRIVATE,summary:PRIVATE};
  return {...r,sensitive:privacy === 'sensitive'};
}
const factColumns = 'id, scope, kind, statement, source_kind, salience, privacy, status, observed_at, last_reinforced_at, used_count, created_at, updated_at';
const eventColumns = `e.id, e.at, e.action, e.table_name, e.row_id, e.actor,
 CASE WHEN f.privacy = ? OR ep.privacy = ? OR (e.table_name = ? AND f.id IS NULL) OR (e.table_name = ? AND ep.id IS NULL) THEN ? ELSE e.reason END AS reason,
 CASE WHEN e.table_name = ? AND f.privacy = ? THEN ? WHEN e.table_name = ? THEN f.statement ELSE NULL END AS statement,
 CASE WHEN f.privacy = ? OR ep.privacy = ? THEN 1 ELSE 0 END AS sensitive`;
const eventJoins = ' FROM memory_events e LEFT JOIN facts f ON e.table_name = ? AND e.row_id = f.id LEFT JOIN episodes ep ON e.table_name = ? AND e.row_id = ep.id';
const eventArgs = ['secret','secret','facts','episodes',PRIVATE,'facts','secret',PRIVATE,'facts','sensitive','sensitive','facts','episodes'];
function events(db, where, params) { return db.prepare(`SELECT ${eventColumns}${eventJoins} WHERE ${where} ORDER BY e.at ASC, e.id ASC`).all(...eventArgs,...params).map(r=>({...r,sensitive:!!r.sensitive})); }
function json(res,status,data) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data)); }
function pageNum(v) { const n=Number(v ?? 1); if (!Number.isSafeInteger(n) || n<1 || n>1000000) throw new Error('Invalid page'); return n; }
export function createApp({snapshot = process.env.VIZ_SNAPSHOT || './data/snapshot.db'} = {}) {
  return createServer((req,res) => {
    if (req.method !== 'GET') { res.setHeader('Allow','GET'); return json(res,405,{error:'Only GET is supported'}); }
    const url = new URL(req.url,'http://localhost');
    if (url.pathname === '/') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"}); return res.end(html); }
    if (!url.pathname.startsWith('/api/')) return json(res,404,{error:'Not found'});
    let stat; try { stat=statSync(snapshot); if (!stat.isFile()) throw new Error(); } catch { return json(res,200,{available:false,message:'快照不存在，请先生成快照。',snapshot_mtime:null}); }
    if (url.pathname === '/api/status') return json(res,200,{available:true,snapshot_mtime:stat.mtime.toISOString()});
    let db;
    try {
      db = new DatabaseSync(snapshot,{readOnly:true});
      if (url.pathname === '/api/today') {
        const date=url.searchParams.get('date') || today(); const [start,end]=shanghaiDayBounds(date);
        const todayMainUsage=db.prepare('SELECT SUM(input_tokens) AS total FROM token_usage WHERE source = ? AND day_key = ?').get('main',date).total ?? 0;
        const counts=db.prepare('SELECT action, COUNT(id) AS count FROM memory_events WHERE at >= ? AND at < ? GROUP BY action ORDER BY action').all(start,end);
        const latest=db.prepare('SELECT id, kind, trigger, status, started_at, finished_at FROM consolidations ORDER BY started_at DESC, id DESC LIMIT ?').get(1) ?? null;
        const reminders=db.prepare('SELECT COUNT(id) AS count FROM reminders WHERE status IN (?,?,?)').get('pending','snoozed','delivering').count;
        return json(res,200,{available:true,date,today_main_usage:todayMainUsage,compact_floor:numberOrNull(meta(db,'compact_floor:main')),counts,backfill_cursor:numberOrNull(meta(db,'compact_backfill:cursor:main')),backfill_day:dayMeta(db),latest,reminders});
      }
      if (url.pathname === '/api/events') { const [start,end]=shanghaiDayBounds(url.searchParams.get('date')||today()); const action=url.searchParams.get('action'); return json(res,200,{events:events(db,`e.at >= ? AND e.at < ?${action ? ' AND e.action = ?' : ''}`,action?[start,end,action]:[start,end])}); }
      if (url.pathname === '/api/timeline') {
        const rows=db.prepare('SELECT id, scope, kind, trigger, status, upto_seq, started_at, finished_at FROM consolidations ORDER BY upto_seq ASC, started_at ASC, id ASC').all();
        const watermark=db.prepare('SELECT MAX(upto_seq) AS value FROM consolidations WHERE scope = ? AND kind <> ? AND status IN (?,?)').get('main','forget_flush','written','compacted').value;
        return json(res,200,{consolidations:rows,watermark,backfill_cursor:numberOrNull(meta(db,'compact_backfill:cursor:main'))});
      }
      let match=url.pathname.match(/^\/api\/consolidations\/([^/]+)\/episodes$/);
      if (match) { const rows=db.prepare('SELECT id, status, started_at, ended_at, created_at, title, summary, privacy FROM episodes WHERE consolidation_id = ? ORDER BY started_at ASC, id ASC').all(decodeURIComponent(match[1])); return json(res,200,{episodes:rows.map(episode)}); }
      if (url.pathname === '/api/facts') {
        const conditions=[],args=[];
        for (const key of ['scope','kind','source_kind','salience']) { const val=url.searchParams.get(key); if (val) {conditions.push(`${key} = ?`); args.push(val);} }
        if (args.length) { conditions.push('privacy <> ?'); args.push('secret'); }
        const status=url.searchParams.get('status') ?? 'active'; if (status && status !== 'all') {conditions.push('status = ?');args.push(status);}
        const q=url.searchParams.get('q'); if (q) {conditions.push("privacy <> ? AND statement LIKE ? ESCAPE '\\'"); args.push('secret',`%${q.replace(/[\\%_]/g,'\\$&')}%`);}
        const where=conditions.length?' WHERE '+conditions.join(' AND '):''; const page=pageNum(url.searchParams.get('page')); const total=db.prepare(`SELECT COUNT(id) AS count FROM facts${where}`).get(...args).count;
        const rows=db.prepare(`SELECT ${factColumns} FROM facts${where} ORDER BY last_reinforced_at DESC, id ASC LIMIT ? OFFSET ?`).all(...args,50,(page-1)*50);
        return json(res,200,{facts:rows.map(fact),page,page_size:50,total});
      }
      match=url.pathname.match(/^\/api\/facts\/([^/]+)\/events$/);
      if (match) return json(res,200,{events:events(db,'e.table_name = ? AND e.row_id = ?',['facts',decodeURIComponent(match[1])])});
      return json(res,404,{error:'Not found'});
    } catch (err) { if (err.message === 'Invalid date' || err.message === 'Invalid page' || err instanceof URIError) return json(res,400,{error:'Invalid request'}); console.error('Snapshot read failed:',err.message);return json(res,503,{error:'无法读取快照，请检查快照文件和表结构。'}); }
    finally { db?.close(); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port=Number(process.env.VIZ_PORT || 50090);
  if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('Invalid VIZ_PORT');
  createApp().listen(port,'127.0.0.1',()=>console.log(`Listening at http://127.0.0.1:${port}`));
}
