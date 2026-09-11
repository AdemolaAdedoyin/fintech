import { BadRequestException } from '@nestjs/common';
import { Currency } from '@prisma/client';
import { isUUID } from 'class-validator';

export interface LedgerPostingInput {
  accountId: string;
  amountMinor: bigint;
}

export interface LedgerTransactionInput {
  reference: string;
  currency: Currency;
  description?: string;
  postings: LedgerPostingInput[];
}

export interface NormalizedLedgerTransactionInput {
  reference: string;
  currency: Currency;
  description?: string;
  postings: LedgerPostingInput[];
}

const MAX_POSTINGS = 50;
export const MIN_MINOR_UNITS = -9_223_372_036_854_775_808n;
export const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;

export function isSupportedMinorUnitValue(value: bigint): boolean {
  return value >= MIN_MINOR_UNITS && value <= MAX_MINOR_UNITS;
}

export function normalizeLedgerTransactionInput(
  input: LedgerTransactionInput,
): NormalizedLedgerTransactionInput {
  const reference = input.reference.trim();
  if (reference.length === 0 || reference.length > 120) {
    throw new BadRequestException('Ledger reference must be between 1 and 120 characters');
  }

  const description = input.description?.trim();
  if (description && description.length > 255) {
    throw new BadRequestException('Ledger description cannot exceed 255 characters');
  }

  if (!Array.isArray(input.postings) || input.postings.length < 2) {
    throw new BadRequestException('A ledger transaction requires at least two postings');
  }

  if (input.postings.length > MAX_POSTINGS) {
    throw new BadRequestException(`A ledger transaction cannot exceed ${MAX_POSTINGS} postings`);
  }

  const accountIds = new Set<string>();
  let total = 0n;

  const postings = input.postings.map((posting) => {
    if (!isUUID(posting.accountId, '4')) {
      throw new BadRequestException('Ledger posting account IDs must be UUID v4 values');
    }

    if (typeof posting.amountMinor !== 'bigint') {
      throw new BadRequestException('Ledger posting amounts must use bigint minor units');
    }

    if (posting.amountMinor === 0n) {
      throw new BadRequestException('Ledger postings cannot have a zero amount');
    }

    if (!isSupportedMinorUnitValue(posting.amountMinor)) {
      throw new BadRequestException('Ledger posting amount exceeds the supported BIGINT range');
    }

    if (accountIds.has(posting.accountId)) {
      throw new BadRequestException('A ledger transaction can post to an account only once');
    }

    accountIds.add(posting.accountId);
    total += posting.amountMinor;

    return {
      accountId: posting.accountId,
      amountMinor: posting.amountMinor,
    };
  });

  if (total !== 0n) {
    throw new BadRequestException('Ledger postings must sum to zero');
  }

  return {
    reference,
    currency: input.currency,
    ...(description ? { description } : {}),
    postings,
  };
}
