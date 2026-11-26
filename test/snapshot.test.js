import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, utimesSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeFixture } from '../scripts/make-fixture.js';

test('snapshot is atomic, private, throttled, and preserves old file on failure',()=>{
  const dir=mkdtempSync(join(tmpdir(),'viz-snapshot-'));
  try {
    const source=join(dir,'production.db'), dest=join(dir,"snap'shot.db"), bin=join(dir,'bin');
    mkdirSync(bin); makeFixture(source); const cli=join(bin,'sqlite3');
    // Linux CI may lack the sqlite3 executable. This shim executes its VACUUM statement
    // using the same SQLite API, including a read-only connection to the source.
    writeFileSync(cli,`#!/usr/bin/env node\nconst {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[3],{readOnly:true});try{db.exec(process.argv[4])}finally{db.close()}\n`);chmodSync(cli,0o755);
    const env={...process.env,PATH:bin+':'+process.env.PATH};
    const run=()=>spawnSync('sh',['scripts/snapshot.sh',source,dest],{env,encoding:'utf8'});
    let r=run();assert.equal(r.status,0,r.stderr);assert.equal(statSync(dest).mode&0o777,0o600);let db=new DatabaseSync(dest,{readOnly:true});assert.equal(db.prepare('SELECT COUNT(id) AS n FROM facts').get().n,6);db.close();
    const firstStat=statSync(dest);r=run();assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/skipped/);assert.equal(statSync(dest).ino,firstStat.ino);
    const sourceDb=new DatabaseSync(source);sourceDb.prepare('INSERT INTO schema_meta (key,value) VALUES (?,?)').run('test-marker','updated');sourceDb.close();
    const old=new Date(Date.now()-700000);utimesSync(dest,old,old);r=run();assert.equal(r.status,0,r.stderr);assert.notEqual(statSync(dest).ino,firstStat.ino);db=new DatabaseSync(dest,{readOnly:true});assert.equal(db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('test-marker').value,'updated');db.close();
    const original=readFileSync(dest);utimesSync(dest,old,old);writeFileSync(cli,'#!/bin/sh\nexit 1\n');chmodSync(cli,0o755);r=run();assert.notEqual(r.status,0);assert.deepEqual(readFileSync(dest),original);assert.ok(!readdirSync(dir).some(n=>n.includes('.tmp.')||n.endsWith('.lock')));
    r=spawnSync('sh',['scripts/snapshot.sh',source,source],{env,encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/must differ/);
  } finally {rmSync(dir,{recursive:true,force:true})}
});
