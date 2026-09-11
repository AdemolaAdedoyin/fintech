import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const MAX_MEMORY = 64 * 1024 * 1024;

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derivedKey = await this.derive(password, salt);

    return [
      'scrypt',
      SCRYPT_N,
      SCRYPT_R,
      SCRYPT_P,
      salt.toString('base64url'),
      derivedKey.toString('base64url'),
    ].join('$');
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    const [algorithm, n, r, p, encodedSalt, encodedKey, ...extra] = encodedHash.split('$');

    if (
      algorithm !== 'scrypt' ||
      Number(n) !== SCRYPT_N ||
      Number(r) !== SCRYPT_R ||
      Number(p) !== SCRYPT_P ||
      !encodedSalt ||
      !encodedKey ||
      extra.length > 0
    ) {
      return false;
    }

    try {
      const salt = Buffer.from(encodedSalt, 'base64url');
      const expectedKey = Buffer.from(encodedKey, 'base64url');

      if (salt.length !== 16 || expectedKey.length !== KEY_LENGTH) {
        return false;
      }

      const actualKey = await this.derive(password, salt);
      return timingSafeEqual(actualKey, expectedKey);
    } catch {
      return false;
    }
  }

  private derive(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scrypt(
        password,
        salt,
        KEY_LENGTH,
        { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEMORY },
        (error, derivedKey) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(derivedKey);
        },
      );
    });
  }
}
