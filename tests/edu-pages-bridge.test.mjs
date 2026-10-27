import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {buildPagesBridge,validateWorkerOrigin} from '../scripts/build-pages-bridge.mjs';

test('Pages bridge accepts only a complete HTTPS origin without account information or URL suffixes',()=>{
  assert.equal(validateWorkerOrigin('https://education.example.com/'),'https://education.example.com');
  assert.equal(validateWorkerOrigin('https://education.example.com:8443'),'https://education.example.com:8443');
  for(const value of [undefined,null,{},'', 'http://education.example.com','javascript:alert(1)','//education.example.com',' https://education.example.com','https://education.example.com ','https://user:password@education.example.com','https://education.example.com/course','https://education.example.com/?x=1','https://education.example.com/#admin','https:\\education.example.com','https://education.example.com\\other','https://education.example.com?','https://education.example.com#'])assert.throws(()=>validateWorkerOrigin(value),/HTTPS origin/);
});

test('Pages bridge preserves both old entry routes and leaves application HTML and modules unchanged',async t=>{
  const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'.verification');
  await fs.mkdir(base,{recursive:true});
  const directory=await fs.mkdtemp(path.join(base,'pages-test-'));
  t.after(async()=>{
    if(!directory.startsWith(base+path.sep))throw new Error('시험 폴더 경로를 확인하세요.');
    await fs.rm(directory,{recursive:true,force:true});
  });
  const appFiles=['edustatus_all.html','edustatus_admin.html','edu-public.mjs','edu-admin.mjs'];
  const digest=async file=>createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex');
  const before=await Promise.all(appFiles.map(digest));
  const output=path.join(directory,'pages-bridge');
  const result=await buildPagesBridge({origin:'https://education.example.com',outputDirectory:output});
  assert.deepEqual((await fs.readdir(output)).sort(),['edustatus_admin.html','edustatus_all.html','index.html']);
  assert.equal(result.files.length,3);
  for(const [file,route] of [['index.html','edustatus_all.html'],['edustatus_all.html','edustatus_all.html'],['edustatus_admin.html','edustatus_admin.html']]) {
    const html=await fs.readFile(path.join(output,file),'utf8'),destination=`https://education.example.com/${route}`;
    assert.ok(html.includes(`<meta http-equiv="refresh" content="0; url=${destination}">`));
    assert.ok(html.includes(`<a href="${destination}">`));
    assert.ok(html.includes('자동으로 이동하지 않으면'));
    const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
    let navigated;
    vm.runInNewContext(script,{window:{location:{replace:value=>{navigated=value;}}}});
    assert.equal(navigated,destination);
    assert.ok(!html.includes('/api/'));
  }
  assert.deepEqual(await Promise.all(appFiles.map(digest)),before);
  await fs.writeFile(path.join(output,'unexpected.txt'),'must not be published');
  await assert.rejects(buildPagesBridge({origin:'https://education.example.com',outputDirectory:output}),/예상하지 않은 파일/);
});
