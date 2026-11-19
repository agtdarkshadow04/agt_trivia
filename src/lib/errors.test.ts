import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from './client.js';
import { errorText, fieldErrorText } from './errors.js';

const translations = {
  errors: { rate_limited: 'Wait {{retryAfterSeconds}} s.', csrf: 'Blocked.' },
  fieldErrors: { too_short: '{{field}} needs {{min}}.' },
  unexpectedError: 'Oops.',
};

describe('translated errors (I18N-6)', () => {
  it('translates a known code with its params, and falls back to the English message for an unknown one', () => {
    assert.equal(errorText(new ApiError(429, 'Too many.', 'rate_limited', [], { retryAfterSeconds: 42 }), translations), 'Wait 42 s.');
    assert.equal(errorText(new ApiError(418, 'Newer server text.', 'brand_new_code'), translations), 'Newer server text.');
    assert.equal(errorText(new Error('bug'), translations), 'Oops.');
    assert.equal(errorText(undefined, translations), 'Oops.');
  });

  it('translates a field error with its label', () => {
    assert.equal(fieldErrorText({ field: 'password', code: 'too_short', message: 'English.', params: { min: 12 } }, 'Password', translations), 'Password needs 12.');
    assert.equal(fieldErrorText({ field: 'x', code: 'unknown', message: 'English.' }, 'X', translations), 'English.');
  });
});
