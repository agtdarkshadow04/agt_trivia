import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CsvError, isEmptyRecord, parseCsv } from './csv.js';

describe('the CSV parser (RFC 4180, #22)', () => {
  it('reads plain and quoted fields, doubled quotes, commas and line breaks inside quotes', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,"x, y","say ""hi"""\n'), [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"']]);
    assert.deepEqual(parseCsv('"two\nlines",z'), [['two\nlines', 'z']]);
  });

  it('accepts CRLF and LF, strips a BOM, and keeps empty fields and rows', () => {
    assert.deepEqual(parseCsv('﻿a,b\r\n,\r\n"",x'), [['a', 'b'], ['', ''], ['', 'x']]);
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseCsv('a,'), [['a', '']]);
    assert.equal(isEmptyRecord(['', ' ', '']), true);
    assert.equal(isEmptyRecord(['', 'x']), false);
  });

  it('refuses an unclosed quote, a quote inside a field and text after a closing quote, naming the line', () => {
    assert.throws(() => parseCsv('a\n"open,b'), (error) => error instanceof CsvError && error.line === 2);
    assert.throws(() => parseCsv('ab"c'), CsvError);
    assert.throws(() => parseCsv('a\nb\n"x"y'), (error) => error instanceof CsvError && error.line === 3);
  });
});
