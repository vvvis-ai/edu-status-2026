import {MAX_FILES} from '../edu-shared.mjs';

const BATCH_SIZE = 32;
const RETRY_DELAY_MS = 20 * 60 * 1000;
const KOREA_OFFSET_MS = 9 * 60 * 60 * 1000;

function koreaYear(time) {
  return new Date(time + KOREA_OFFSET_MS).getUTCFullYear();
}

export function certificateRetentionExpired(env, course, time = Date.now()) {
  return Boolean(env.certificateRetentionEnabled && Number.isInteger(course?.year)
    && course.year >= 2000 && course.year < koreaYear(time));
}

// Claim a bounded group before touching the file store. A manual request stays
// eligible for retries even during the current education year.
const claimFiles = `
  UPDATE records SET data = json_set(data, '$.disposalAttemptAt', ?, '$.disposalAttemptId', ?)
  WHERE collection = 'files' AND id IN (
    SELECT file.id FROM records AS file
    LEFT JOIN records AS course ON course.collection = 'courses' AND course.id = json_extract(file.data, '$.courseId')
    WHERE file.collection = 'files'
      AND COALESCE(json_extract(file.data, '$.disposalAttemptAt'), '') < ?
      AND (? IS NULL OR json_extract(file.data, '$.disposalRequestId') = ?)
      AND (json_extract(file.data, '$.disposalRequestId') IS NOT NULL
        OR json_extract(file.data, '$.disposalAttemptId') IS NOT NULL
        OR (json_type(course.data, '$.year') = 'integer' AND json_extract(course.data, '$.year') BETWEEN 2000 AND ?))
    ORDER BY COALESCE(json_extract(file.data, '$.disposalAttemptAt'), ''), file.id
    LIMIT ?
  ) RETURNING id, data`;

const activeClaims = `collection = 'files' AND json_extract(data, '$.disposalAttemptId') = ?
  AND id IN (SELECT value FROM json_each(?))`;
const requestedIds = `SELECT json_extract(value, '$.id') FROM json_each(?)`;

function validStorageKey(id, file) {
  const parts = typeof file.key === 'string' && /^certificates\/([\w:-]+)\/([\w:-]+)\/([\w:-]+)\/([\w:-]+)\.(pdf|jpg|png|webp)$/.exec(file.key);
  return parts && file.key.length <= 512 && file.id === id && parts[1] === file.courseId
    && parts[2] === file.memberId && parts[3] === file.submissionId && parts[4] === id && parts[5] === file.ext;
}

async function finishDisposal(env, files, attemptId) {
  const completedAt = new Date().toISOString();
  const ids = JSON.stringify(files.map(file => file.id));
  const entries = files.map(file => {
    const requestId = file.disposalRequestId;
    return {
      id:crypto.randomUUID(), action:requestId ? 'certificate_manually_disposed' : 'certificate_disposed',
      actor:requestId ? 'admin' : 'system', createdAt:completedAt, version:1,
      detail:{fileId:file.id, courseId:file.courseId, submissionId:file.submissionId, size:file.size, ...(requestId ? {requestId} : {})},
    };
  });
  const results = await env.DB.batch([
    env.DB.prepare(`
      WITH disposed AS MATERIALIZED (
        SELECT id, json_extract(data, '$.submissionId') AS submissionId FROM records WHERE ${activeClaims}
      ), remaining AS MATERIALIZED (
        SELECT submission.id, (
          SELECT json_group_array(json(item.value))
          FROM json_each(submission.data, '$.files') AS item
          WHERE NOT EXISTS (SELECT 1 FROM disposed WHERE id = json_extract(item.value, '$.id') AND submissionId = submission.id)
        ) AS files
        FROM records AS submission
        WHERE submission.collection = 'submissions' AND submission.id IN (SELECT submissionId FROM disposed)
      )
      UPDATE records AS submission SET data = json_set(
        CASE WHEN json_array_length(remaining.files) = 0 THEN json_remove(submission.data, '$.manualDisposalId') ELSE submission.data END,
        '$.files', json(remaining.files), '$.attachmentsDisposedAt', ?, '$.version', submission.version + 1
      ), version = submission.version + 1
      FROM remaining WHERE submission.collection = 'submissions' AND submission.id = remaining.id
    `).bind(attemptId, ids, completedAt),
    env.DB.prepare(`INSERT INTO records(collection,id,data,version)
      SELECT 'audit', json_extract(entry.value, '$.id'), entry.value, 1 FROM json_each(?) AS entry
      WHERE json_extract(entry.value, '$.detail.fileId') IN (SELECT id FROM records WHERE ${activeClaims})
    `).bind(JSON.stringify(entries), attemptId, ids),
    env.DB.prepare(`DELETE FROM records WHERE ${activeClaims}`).bind(attemptId, ids),
  ]);
  if (results.some(result => result.success === false) || results[2]?.meta?.changes !== files.length) {
    throw new Error('수료증 파기 결과를 저장하지 못했습니다.');
  }
}

async function removeClaimedFiles(env, rows, attemptId) {
  const removed = [];
  for (const row of rows) {
    try {
      const file = JSON.parse(row.data);
      if (!validStorageKey(row.id, file)) throw new Error('수료증 저장 경로를 확인해 주세요.');
      await env.FILES.delete(file.key);
      removed.push(file);
    } catch {
      // Keep the claim so the scheduled worker can retry.
    }
  }
  if (!removed.length) return {deleted:0, failed:rows.length};
  try {
    await finishDisposal(env, removed, attemptId);
    return {deleted:removed.length, failed:rows.length - removed.length};
  } catch {
    // KV deletes are idempotent if the database could not commit.
    return {deleted:0, failed:rows.length};
  }
}

async function queueAttachmentDisposal(env, ids, requestId) {
  const entry = {
    id:requestId, action:'certificate_manual_disposal_requested', actor:'admin', createdAt:new Date().toISOString(), version:1,
    detail:{requestId, submissionCount:ids.length},
  };
  const selection = JSON.stringify(ids);
  // A stale submission or missing file aborts the entire selection before any
  // objects are deleted. The audit record gates both updates in the transaction.
  const [audit, submissions, files] = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO records(collection,id,data,version)
      SELECT 'audit', ?, json_set(?, '$.detail.fileCount', SUM(json_array_length(submission.data, '$.files'))), 1
      FROM json_each(?) AS selected
      JOIN records AS submission ON submission.collection = 'submissions'
        AND submission.id = json_extract(selected.value, '$.id') AND submission.version = json_extract(selected.value, '$.version')
      WHERE json_extract(submission.data, '$.manualDisposalId') IS NULL
        AND json_array_length(submission.data, '$.files') BETWEEN 1 AND ?
        AND json_array_length(submission.data, '$.files') = (
          SELECT COUNT(DISTINCT file.id) FROM json_each(submission.data, '$.files') AS attachment
          JOIN records AS file ON file.collection = 'files' AND file.id = json_extract(attachment.value, '$.id')
            AND json_extract(file.data, '$.submissionId') = submission.id
            AND json_extract(file.data, '$.courseId') = json_extract(submission.data, '$.courseId')
            AND json_extract(file.data, '$.memberId') = json_extract(submission.data, '$.memberId')
          WHERE json_extract(file.data, '$.disposalRequestId') IS NULL AND json_extract(file.data, '$.disposalAttemptId') IS NULL
        )
      HAVING COUNT(*) = ?
      RETURNING data
    `).bind(requestId, JSON.stringify(entry), selection, MAX_FILES, ids.length),
    env.DB.prepare(`
      UPDATE records SET data = json_set(data, '$.manualDisposalId', ?, '$.version', version + 1), version = version + 1
      WHERE collection = 'submissions' AND id IN (${requestedIds})
        AND EXISTS (SELECT 1 FROM records WHERE collection = 'audit' AND id = ?)
    `).bind(requestId, selection, requestId),
    env.DB.prepare(`
      UPDATE records SET data = json_set(data, '$.disposalRequestId', ?)
      WHERE collection = 'files' AND id IN (
        SELECT json_extract(attachment.value, '$.id')
        FROM records AS submission, json_each(submission.data, '$.files') AS attachment
        WHERE submission.collection = 'submissions' AND submission.id IN (${requestedIds})
          AND json_extract(submission.data, '$.manualDisposalId') = ?
      )
    `).bind(requestId, selection, requestId),
  ]);
  if ([audit, submissions, files].some(result => result.success === false)) throw new Error('첨부파일 파기 요청을 기록하지 못했습니다.');
  if (!audit.results.length) return 0;
  const {fileCount} = JSON.parse(audit.results[0].data).detail;
  if (submissions.meta.changes !== ids.length || files.meta.changes !== fileCount) throw new Error('첨부파일 파기 대상 수가 일치하지 않습니다.');
  return fileCount;
}

export async function disposeExpiredCertificates(env, time = Date.now(), requestId = null) {
  const attemptId = crypto.randomUUID();
  const attemptedAt = new Date(time).toISOString();
  const retryBefore = new Date(time - RETRY_DELAY_MS).toISOString();
  const claimed = await env.DB.prepare(claimFiles).bind(attemptedAt, attemptId, retryBefore, requestId, requestId, koreaYear(time) - 1, BATCH_SIZE).all();
  if (claimed.success === false) throw new Error('수료증 파기 대상을 가져오지 못했습니다.');
  return removeClaimedFiles(env, claimed.results, attemptId);
}

export async function disposeSelectedAttachments(env, selections) {
  const requestId = crypto.randomUUID();
  const fileCount = await queueAttachmentDisposal(env, selections, requestId);
  if (!fileCount) return null;
  let deleted = 0;
  try {
    ({deleted} = await disposeExpiredCertificates(env, Date.now(), requestId));
  } catch {
    // The request is durable even if the first processing attempt cannot run.
    console.error({event:'certificate_disposal_deferred', requestId});
  }
  return {submissionCount:selections.length, deleted, pending:fileCount - deleted, requestId};
}

export async function runCertificateDisposal(env) {
  const {deleted, failed} = await disposeExpiredCertificates(env);
  if (deleted || failed) console.info({event:'certificate_disposal', deleted, failed});
  if (failed) throw new Error('파기를 완료하지 못한 첨부파일은 다음 실행에 다시 처리합니다.');
}
