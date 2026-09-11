import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes passwords with scrypt without storing plaintext', async () => {
    const password = 'correct-horse-battery-staple';
    const encoded = await service.hash(password);

    expect(encoded).toMatch(/^scrypt\$/);
    expect(encoded).not.toContain(password);
    expect(encoded.split('$')).toHaveLength(6);
  });

  it('verifies the correct password and rejects a wrong password', async () => {
    const encoded = await service.hash('correct-horse-battery-staple');

    await expect(service.verify('correct-horse-battery-staple', encoded)).resolves.toBe(true);
    await expect(service.verify('wrong-password', encoded)).resolves.toBe(false);
  });

  it('rejects malformed or unsupported hashes safely', async () => {
    await expect(service.verify('password', 'bcrypt$invalid')).resolves.toBe(false);
    await expect(service.verify('password', 'scrypt$1$1$1$bad$bad')).resolves.toBe(false);
  });
});
