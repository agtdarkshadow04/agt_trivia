import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isUuidV4 } from './api.js';
import { quizLengthsError } from './validation.js';

describe('shared validators', () => {
  it('requires a long quiz longer than a short one', () => {
    assert.equal(quizLengthsError(10, 30), null);
    assert.equal(quizLengthsError(10, 11), null);
    assert.deepEqual(quizLengthsError(10, 10), {
      field: 'quiz.longLength', code: 'out_of_range', message: 'quiz.longLength must be greater than quiz.shortLength (10).', params: { min: 11 },
    });
    assert.equal(quizLengthsError(30, 10)?.code, 'out_of_range');
  });

  it('accepts only UUIDv4 IDs (DATA-6, API-5)', () => {
    assert.equal(isUuidV4('3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e'), true);
    assert.equal(isUuidV4('3F2B8C1E-4D5A-4B6C-8D7E-9F0A1B2C3D4E'), true);
    assert.equal(isUuidV4('3f2b8c1e-4d5a-1b6c-8d7e-9f0a1b2c3d4e'), false, 'version 1');
    assert.equal(isUuidV4('3f2b8c1e-4d5a-4b6c-7d7e-9f0a1b2c3d4e'), false, 'wrong variant');
    assert.equal(isUuidV4('not-a-uuid'), false);
    assert.equal(isUuidV4(42), false);
  });
});
