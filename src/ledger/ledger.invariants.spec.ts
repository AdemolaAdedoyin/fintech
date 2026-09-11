import { BadRequestException } from '@nestjs/common';
import { Currency } from '@prisma/client';
import {
  MAX_MINOR_UNITS,
  MIN_MINOR_UNITS,
  normalizeLedgerTransactionInput,
} from './ledger.invariants';

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';

function validInput() {
  return {
    reference: '  ledger:test:1  ',
    currency: Currency.USD,
    description: '  Balanced posting  ',
    postings: [
      { accountId: ACCOUNT_A, amountMinor: -100n },
      { accountId: ACCOUNT_B, amountMinor: 100n },
    ],
  };
}

describe('ledger transaction invariants', () => {
  it('normalizes a balanced minor-unit transaction', () => {
    expect(normalizeLedgerTransactionInput(validInput())).toEqual({
      reference: 'ledger:test:1',
      currency: Currency.USD,
      description: 'Balanced posting',
      postings: [
        { accountId: ACCOUNT_A, amountMinor: -100n },
        { accountId: ACCOUNT_B, amountMinor: 100n },
      ],
    });
  });

  it('rejects unbalanced postings', () => {
    const input = validInput();
    input.postings[1] = { accountId: ACCOUNT_B, amountMinor: 99n };

    expect(() => normalizeLedgerTransactionInput(input)).toThrow(BadRequestException);
  });

  it('rejects duplicate accounts and zero postings', () => {
    const duplicate = validInput();
    duplicate.postings[1] = { accountId: ACCOUNT_A, amountMinor: 100n };
    expect(() => normalizeLedgerTransactionInput(duplicate)).toThrow(BadRequestException);

    const zero = validInput();
    zero.postings[0] = { accountId: ACCOUNT_A, amountMinor: 0n };
    expect(() => normalizeLedgerTransactionInput(zero)).toThrow(BadRequestException);
  });

  it('rejects invalid account IDs and oversized references', () => {
    const invalidId = validInput();
    invalidId.postings[0] = { accountId: 'not-a-uuid', amountMinor: -100n };
    expect(() => normalizeLedgerTransactionInput(invalidId)).toThrow(BadRequestException);

    const oversized = validInput();
    oversized.reference = 'x'.repeat(121);
    expect(() => normalizeLedgerTransactionInput(oversized)).toThrow(BadRequestException);
  });

  it('rejects postings outside the signed PostgreSQL BIGINT range', () => {
    const aboveMaximum = validInput();
    aboveMaximum.postings = [
      { accountId: ACCOUNT_A, amountMinor: -(MAX_MINOR_UNITS + 1n) },
      { accountId: ACCOUNT_B, amountMinor: MAX_MINOR_UNITS + 1n },
    ];
    expect(() => normalizeLedgerTransactionInput(aboveMaximum)).toThrow(BadRequestException);

    const belowMinimum = validInput();
    belowMinimum.postings = [
      { accountId: ACCOUNT_A, amountMinor: MIN_MINOR_UNITS - 1n },
      { accountId: ACCOUNT_B, amountMinor: -(MIN_MINOR_UNITS - 1n) },
    ];
    expect(() => normalizeLedgerTransactionInput(belowMinimum)).toThrow(BadRequestException);
  });
});
