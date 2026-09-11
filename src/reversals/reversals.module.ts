import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { UsersModule } from '../users/users.module';
import { ReversalsController } from './reversals.controller';
import { ReversalsService } from './reversals.service';

@Module({
  imports: [AuthModule, LedgerModule, UsersModule],
  controllers: [ReversalsController],
  providers: [ReversalsService],
  exports: [ReversalsService],
})
export class ReversalsModule {}
