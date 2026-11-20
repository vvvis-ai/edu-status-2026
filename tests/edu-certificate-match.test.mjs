import test from 'node:test';
import assert from 'node:assert/strict';
import {findCertificateMatch} from '../edu-certificate-match.mjs';

const member = {id:'m1',name:'가나준',active:true};
const course = {id:'c1',name:'적극행정 사이버교육',year:2026,published:true,details:['국민의 생활을 바꾸는 적극행정 (50분)'],requirement:'all'};
const fields = {name:'가 나 준',course:'제 7 기 국민의 생활을 바꾸는 적극행정',date:'2026-04-03'};

test('certificate matching uses the printed name, exact course or detail, and the completion year', () => {
  const data = {members:[member],courses:[course,{...course,id:'previous',year:2025}]};
  const match = findCertificateMatch(fields,data);
  assert.deepEqual([match.memberId,match.courseId,match.confirmed],['m1','c1',true]);
  assert.equal(findCertificateMatch({...fields,course:'적극행정'},data).courseId,'');
  assert.equal(findCertificateMatch({...fields,date:'2024-04-03'},data).courseId,'');
  assert.equal(findCertificateMatch({...fields,ocrFailed:true},data).confirmed,false);
});

test('duplicate names and course titles stay unresolved, and partial mandatory courses need confirmation', () => {
  assert.equal(findCertificateMatch(fields,{members:[member,{...member,id:'former',active:false}],courses:[course]}).memberId,'');
  assert.equal(findCertificateMatch(fields,{members:[member],courses:[course,{...course,id:'duplicate'}]}).courseId,'');
  const compound = {...course,details:[...course.details,'다른 적극행정 교육']};
  const partial = findCertificateMatch(fields,{members:[member],courses:[compound]});
  assert.equal(partial.courseId,'c1');
  assert.equal(partial.confirmed,false);
  assert.equal(findCertificateMatch({...fields,course:`${fields.course} / 다른 적극행정 교육`},{members:[member],courses:[compound]}).confirmed,true);
});
