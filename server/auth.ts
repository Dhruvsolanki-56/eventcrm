import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

const passwordHashOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const dummyPasswordHash = await argon2.hash(randomBytes(32).toString('hex'), passwordHashOptions);

export type LoginPasswordUser = { password_hash: string; disabled_at?: string | null } | undefined;
export type PasswordVerifier = (hash: string, password: string) => Promise<boolean>;

export async function verifyLoginPassword(
  user: LoginPasswordUser,
  password: string,
  verifier: PasswordVerifier = argon2.verify,
  dummyHash = dummyPasswordHash,
) {
  const matches = await verifier(user?.password_hash ?? dummyHash, password);
  return Boolean(user && !user.disabled_at && matches);
}
