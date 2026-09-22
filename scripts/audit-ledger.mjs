import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
try {
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
    const rows = await tx.$queryRaw`
      SELECT 'unbalanced_or_unsealed_transactions' AS check, count(*)::text AS failures FROM (
        SELECT t.id FROM "LedgerTransaction" t LEFT JOIN "LedgerPosting" p ON p."ledgerTransactionId"=t.id
        GROUP BY t.id HAVING t."sealedAt" IS NULL OR count(p.id)<2 OR coalesce(sum(p."amountMinor"),0)<>0
      ) a
      UNION ALL SELECT 'account_snapshot_mismatch', count(*)::text FROM (
        SELECT a.id FROM "LedgerAccount" a LEFT JOIN "LedgerPosting" p ON p."accountId"=a.id
        GROUP BY a.id HAVING a."balanceMinor"<>coalesce(sum(p."amountMinor"),0)
      ) a
      UNION ALL SELECT 'wallet_snapshot_mismatch', count(*)::text FROM "Wallet" w
        JOIN "LedgerAccount" a ON a.id=w."ledgerAccountId"
        WHERE w."currentBalanceMinor"<>a."balanceMinor" OR w.currency<>a.currency OR w."currentBalanceMinor"<0
      UNION ALL SELECT 'posting_currency_mismatch', count(*)::text FROM "LedgerPosting" p
        JOIN "LedgerAccount" a ON a.id=p."accountId"
        JOIN "LedgerTransaction" t ON t.id=p."ledgerTransactionId" WHERE a.currency<>t.currency
      UNION ALL SELECT 'successful_payment_missing_ledger', count(*)::text FROM "Payment" p
        LEFT JOIN "LedgerTransaction" t ON t.id=p."ledgerTransactionId"
        WHERE p.status='SUCCEEDED' AND (t.id IS NULL OR t."sealedAt" IS NULL OR t.reference<>p.reference)
    `;
    return rows;
  },{isolationLevel:'RepeatableRead',timeout:15000});
  console.log(JSON.stringify(result,null,2));
  if (result.some(row => row.failures !== '0')) process.exitCode=1;
} finally {await prisma.$disconnect();}
