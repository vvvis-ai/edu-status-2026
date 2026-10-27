import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export function createDatabase(filename) {
  const database = new DatabaseSync(filename);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  function statement(sql, values = []) {
    const execute = mode => {
      const prepared = database.prepare(sql);
      if (mode === 'all') {
        const results = prepared.all(...values);
        const changed = database.prepare('SELECT changes() AS count').get().count;
        return {success:true, results, meta:{changes:Number(changed)}};
      }
      const result=prepared.run(...values);
      return {success:true, results:[], meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};
    };
    return {
      bind(...args) { return statement(sql,args); },
      async first(column) { const row=database.prepare(sql).get(...values); return row ? column ? row[column] : {...row} : null; },
      async all() { return execute('all'); },
      async run() { return execute('run'); },
      _execute() { return execute(/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql) ? 'all' : 'run'); },
    };
  }
  return {
    prepare:statement,
    async exec(sql) { database.exec(sql); return {count:0,duration:0}; },
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE');
      try { const results=statements.map(s=>s._execute()); database.exec('COMMIT'); return results; }
      catch(error) { database.exec('ROLLBACK'); throw error; }
    },
    close() { database.close(); },
  };
}

export async function createFiles(directory) {
  const root=path.resolve(directory); await fs.mkdir(root,{recursive:true});
  function filePath(key) {
    const resolved=path.resolve(root,String(key));
    if (!resolved.startsWith(root+path.sep) || String(key).includes('\\') || String(key).includes('\0')) throw new Error('Invalid file key');
    return resolved;
  }
  return {
    async put(key,data,options={}) {
      const target=filePath(key); await fs.mkdir(path.dirname(target),{recursive:true});
      const temporary=`${target}.${crypto.randomUUID()}.tmp`;
      try {
        if (data?.getReader) await pipeline(Readable.fromWeb(data), (await import('node:fs')).createWriteStream(temporary));
        else await fs.writeFile(temporary,data instanceof ArrayBuffer?new Uint8Array(data):data);
        await fs.rename(temporary,target);
        await fs.writeFile(`${target}.metadata.json`,JSON.stringify(options.httpMetadata||{}));
      } catch(error) { await fs.rm(temporary,{force:true}); throw error; }
      const stat=await fs.stat(target); return {key,size:stat.size,httpMetadata:options.httpMetadata||{}};
    },
    async head(key) {
      try {
        const target=filePath(key),stat=await fs.stat(target);
        const httpMetadata=JSON.parse(await fs.readFile(`${target}.metadata.json`,'utf8'));
        return {key,size:stat.size,httpMetadata};
      } catch(error) { if(error.code==='ENOENT')return null; throw error; }
    },
    async get(key) {
      const info=await this.head(key); return info?{...info,body:Readable.toWeb(createReadStream(filePath(key)))}:null;
    },
    async delete(key) {
      if (Array.isArray(key)) { await Promise.all(key.map(k=>this.delete(k))); return; }
      const target=filePath(key); await fs.rm(target,{force:true}); await fs.rm(`${target}.metadata.json`,{force:true});
    },
  };
}

export async function createLocalEnvironment({dataDirectory,adminPassword,sessionSecret,seed,initialize=true}) {
  await fs.mkdir(dataDirectory,{recursive:true});
  const DB=createDatabase(path.join(dataDirectory,'education.sqlite'));
  await DB.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  if (initialize && seed && !(await DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection IN ('courses','members')").first('count'))) {
    const statements=[];
    for (const collection of ['courses','members']) for (const record of seed[collection]||[]) {
      statements.push(DB.prepare('INSERT INTO records(collection,id,data,version) VALUES(?,?,?,?)').bind(collection,String(record.id),JSON.stringify(record),record.version||1));
    }
    statements.push(DB.prepare('INSERT INTO records(collection,id,data,version) VALUES(?,?,?,?)').bind('meta','initial-import',JSON.stringify({source:seed.source,exportedAt:seed.exportedAt,importedAt:new Date().toISOString()}),1));
    await DB.batch(statements);
  }
  return {DB,FILES:await createFiles(path.join(dataDirectory,'files')),ADMIN_PASSWORD:adminPassword,SESSION_SECRET:sessionSecret,IS_LOCAL:true};
}
