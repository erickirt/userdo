import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import jwt, { JwtData } from '@tsndr/cloudflare-worker-jwt';
import { UserDODatabase, TableOptions } from './database/index';

// --- User Schema ---
const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  passwordHash: z.string(),
  salt: z.string(),
  createdAt: z.string(),
  refreshTokens: z.array(z.string()).default([]),
});
type User = z.infer<typeof UserSchema>;

// --- Zod Schemas for endpoint validation ---
const SignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
const LoginSchema = SignupSchema;
const InitSchema = UserSchema;

// --- Password Hashing ---
const PASSWORD_CONFIG = {
  iterations: 100_000,
  saltLength: 16,
};

const RESERVED_PREFIX = "__";
const AUTH_DATA_KEY = "__user";
const RATE_LIMIT_KEY = "__rl";
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60_000; // 1 minute

function isReservedKey(key: string): boolean {
  return key.startsWith(RESERVED_PREFIX);
}

type JwtPayload = {
  sub: string;
  email: string;
};

export interface Env {
  JWT_SECRET: string;
  USERDO: DurableObjectNamespace<UserDO>;
  ASSETS?: Fetcher;
}

// Hash email for use as DO ID to prevent PII leaking in logs
export async function hashEmailForId(email: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(email.toLowerCase());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  const hashHex = Array.from(hashArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return hashHex;
}

// Helper function to get UserDO with automatic email hashing
// Maintains almost the same API as env.MY_APP_DO.get(env.MY_APP_DO.idFromName(email))
export async function getUserDO<T extends UserDO>(
  namespace: DurableObjectNamespace,
  email: string
): Promise<T> {
  const hashedEmail = await hashEmailForId(email);
  return namespace.get(namespace.idFromName(hashedEmail)) as unknown as T;
}

const getDO = async (env: Env, email: string): Promise<UserDO> => {
  const hashedEmail = await hashEmailForId(email);
  return env.USERDO.get(env.USERDO.idFromName(hashedEmail)) as unknown as UserDO;
};

async function hashPassword(
  password: string
): Promise<{ hash: string; salt: string }> {
  const encoder = new TextEncoder();
  const saltBytes = crypto.getRandomValues(new Uint8Array(PASSWORD_CONFIG.saltLength));
  const salt = btoa(String.fromCharCode(...saltBytes));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: PASSWORD_CONFIG.iterations, hash: 'SHA-256' }, key, 256);
  const hash = btoa(String.fromCharCode(...new Uint8Array(derivedBits)));
  return { hash, salt };
}

async function verifyPassword(
  password: string, salt: string, expectedHash: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const saltBytes = Uint8Array.from(atob(salt), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: PASSWORD_CONFIG.iterations, hash: 'SHA-256' }, key, 256);
  const hash = btoa(String.fromCharCode(...new Uint8Array(derivedBits)));
  return hash === expectedHash;
}

// Atomic migration helper (outside the class)
export async function migrateUserEmail(
  { env, oldEmail, newEmail }:
    { env: Env; oldEmail: string; newEmail: string }
): Promise<{ ok: boolean; error?: string }> {
  oldEmail = oldEmail.toLowerCase();
  newEmail = newEmail.toLowerCase();
  const oldDO = await getDO(env, oldEmail);
  const newDO = await getDO(env, newEmail);
  try {
    const user = await oldDO.raw();
    user.email = newEmail;
    await newDO.init(user);
    await oldDO.deleteUser();
    return { ok: true };
  } catch (err) {
    // Optionally, add rollback logic here
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export class UserDO extends DurableObject {
  protected state: DurableObjectState;
  protected storage: DurableObjectStorage;
  protected env: Env;
  protected database: UserDODatabase;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.database = new UserDODatabase(
      this.storage,
      this.getCurrentUserId(),
      this.broadcast.bind(this)
    );
  }

  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    const record = await this.storage.get<{
      count: number;
      resetAt: number
    }>(RATE_LIMIT_KEY);
    if (record && record.resetAt > now) {
      if (record.count >= RATE_LIMIT_MAX) {
        throw new Error('Too many requests');
      }
      record.count += 1;
      await this.storage.put(RATE_LIMIT_KEY, record);
    } else {
      const resetAt = now + RATE_LIMIT_WINDOW;
      await this.storage.put(RATE_LIMIT_KEY, { count: 1, resetAt });
    }
  }

  private async generateTokens(user: User): Promise<{ token: string; refreshToken: string }> {
    const accessExp = Math.floor(Date.now() / 1000) + 15 * 60;
    const token = await jwt.sign(
      {
        sub: user.id,
        email: user.email,
        exp: accessExp,
      },
      this.env.JWT_SECRET,
    );

    const refreshExp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const refreshToken = await jwt.sign(
      {
        sub: user.id,
        type: 'refresh',
        exp: refreshExp,
      },
      this.env.JWT_SECRET,
    );

    return { token, refreshToken };
  }

  async signup(
    { email, password }:
      { email: string; password: string }
  ): Promise<{
    user: User;
    token: string;
    refreshToken: string
  }> {
    email = email.toLowerCase();
    await this.checkRateLimit();
    const parsed = SignupSchema.safeParse({ email, password });
    if (!parsed.success) {
      throw new Error('Invalid input: ' + JSON.stringify(parsed.error.flatten()));
    }
    // Check if user already exists
    const existing = await this.storage.get<User>(AUTH_DATA_KEY);
    if (existing) throw new Error('Email already registered');
    const id = this.state.id.toString();
    const createdAt = new Date().toISOString();
    const { hash, salt } = await hashPassword(password);
    const user: User = {
      id,
      email,
      passwordHash: hash,
      salt,
      createdAt,
      refreshTokens: []
    };
    await this.storage.put(AUTH_DATA_KEY, user);

    const { token, refreshToken } = await this.generateTokens(user);

    // Store refresh token
    if (!user.refreshTokens) user.refreshTokens = [];
    user.refreshTokens.push(refreshToken);
    await this.storage.put(AUTH_DATA_KEY, user);

    return { user, token, refreshToken };
  }

  async login(
    { email, password }:
      { email: string; password: string }
  ): Promise<{
    user: User;
    token: string;
    refreshToken: string
  }> {
    email = email.toLowerCase();
    await this.checkRateLimit();
    const parsed = LoginSchema.safeParse({ email, password });
    if (!parsed.success) {
      throw new Error('Invalid input: ' + JSON.stringify(parsed.error.flatten()));
    }
    const user = await this.storage.get<User>(AUTH_DATA_KEY);
    if (!user || user.email !== email) throw new Error('Invalid credentials');
    const ok = await verifyPassword(password, user.salt, user.passwordHash);
    if (!ok) throw new Error('Invalid credentials');

    const { token, refreshToken } = await this.generateTokens(user);

    // Store refresh token
    if (!user.refreshTokens) user.refreshTokens = [];
    user.refreshTokens.push(refreshToken);
    await this.storage.put(AUTH_DATA_KEY, user);

    return { user, token, refreshToken };
  }

  async raw(): Promise<User> {
    const user = await this.storage.get<User>(AUTH_DATA_KEY);
    if (!user) throw new Error('User not found');
    return user;
  }

  async init(user: User): Promise<{ ok: boolean }> {
    const parsed = InitSchema.safeParse(user);
    if (!parsed.success) {
      throw new Error('Invalid input: ' + JSON.stringify(parsed.error.flatten()));
    }
    await this.storage.put(AUTH_DATA_KEY, user);
    return { ok: true };
  }

  async deleteUser(): Promise<{ ok: boolean }> {
    await this.storage.delete(AUTH_DATA_KEY);
    return { ok: true };
  }

  // Change password method
  async changePassword(
    { oldPassword, newPassword }:
      { oldPassword: string; newPassword: string }
  ): Promise<{ ok: boolean }> {
    const user = await this.storage.get<User>(AUTH_DATA_KEY);
    if (!user) throw new Error('User not found');
    // Validate old password
    const ok = await verifyPassword(oldPassword, user.salt, user.passwordHash);
    if (!ok) throw new Error('Invalid current password');
    // Validate new password
    const parsed = SignupSchema.shape.password.safeParse(newPassword);
    if (!parsed.success) {
      throw new Error('Invalid new password: ' + JSON.stringify(parsed.error.flatten()));
    }
    // Hash new password
    const { hash, salt } = await hashPassword(newPassword);
    user.passwordHash = hash;
    user.salt = salt;
    await this.storage.put(AUTH_DATA_KEY, user);
    return { ok: true };
  }

  // Reset password method (for use after verifying a reset token)
  async resetPassword(
    { newPassword }: { newPassword: string }
  ): Promise<{ ok: boolean }> {
    const user = await this.storage.get<User>(AUTH_DATA_KEY);
    if (!user) throw new Error('User not found');
    // Validate new password
    const parsed = SignupSchema.shape.password.safeParse(newPassword);
    if (!parsed.success) {
      throw new Error('Invalid new password: ' + JSON.stringify(parsed.error.flatten()));
    }
    // Hash new password
    const { hash, salt } = await hashPassword(newPassword);
    user.passwordHash = hash;
    user.salt = salt;
    await this.storage.put(AUTH_DATA_KEY, user);
    return { ok: true };
  }

  // Generate password reset token (expires in 1 hour)
  async generatePasswordResetToken(): Promise<{ resetToken: string }> {
    const user = await this.storage.get<User>(AUTH_DATA_KEY);
    if (!user) throw new Error('User not found');

    const resetExp = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour
    const resetToken = await jwt.sign({
      sub: user.id,
      email: user.email,
      type: 'password_reset',
      exp: resetExp
    }, this.env.JWT_SECRET);

    return { resetToken };
  }

  // Reset password with token verification
  async resetPasswordWithToken(
    { resetToken, newPassword }: { resetToken: string; newPassword: string }
  ): Promise<{ ok: boolean }> {
    try {
      const verify = await jwt.verify(resetToken, this.env.JWT_SECRET) as JwtData<JwtPayload & { type: string }, {}>;
      if (!verify || !verify.payload || verify.payload.type !== 'password_reset') {
        throw new Error('Invalid reset token');
      }

      // Token is valid, proceed with password reset
      return await this.resetPassword({ newPassword });
    } catch (err) {
      throw new Error('Invalid or expired reset token');
    }
  }

  async verifyToken(
    { token }: { token: string }
  ): Promise<{
    ok: boolean;
    user?: { id: string; email: string }
    error?: string
  }> {
    try {
      const verify = await jwt.verify(
        token, this.env.JWT_SECRET
      ) as JwtData<JwtPayload, {}>;
      if (!verify) throw new Error('Invalid token');
      const { payload } = verify;
      if (!payload) throw new Error('Invalid token');
      const { sub, email } = payload as JwtPayload;
      if (!sub || !email) throw new Error('Invalid token');

      const user = await this.storage.get<User>(AUTH_DATA_KEY);
      if (!user) throw new Error('User not found');
      if (payload.sub !== user.id) {
        throw new Error('Token subject mismatch');
      }
      return { ok: true, user: { id: user.id, email: user.email } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async set(
    key: string,
    value: unknown
  ): Promise<{ ok: boolean }> {
    if (isReservedKey(key)) throw new Error("Key is reserved");
    await this.storage.put(key, value);

    // Broadcast KV change
    this.broadcast(`kv:${key}`, { key, value });

    return { ok: true };
  }

  async get(
    key: string
  ): Promise<unknown> {
    if (isReservedKey(key)) throw new Error("Key is reserved");
    const value = await this.storage.get(key);
    return value;
  }

  async refreshToken(
    { refreshToken }: { refreshToken: string }
  ): Promise<{ token: string }> {
    try {
      const verify = await jwt.verify(
        refreshToken, this.env.JWT_SECRET
      ) as JwtData<JwtPayload & { type: string }, {}>;

      if (!verify || !verify.payload || verify.payload.type !== 'refresh') {
        throw new Error('Invalid refresh token');
      }

      const user = await this.storage.get<User>(AUTH_DATA_KEY);
      if (!user) throw new Error('User not found');

      // Verify refresh token is in user's list
      if (!user.refreshTokens.includes(refreshToken)) {
        throw new Error('Refresh token not found');
      }

      // Generate new access token
      const accessExp = Math.floor(Date.now() / 1000) + 15 * 60;
      const token = await jwt.sign({
        sub: user.id,
        email: user.email,
        exp: accessExp
      }, this.env.JWT_SECRET);

      return { token };
    } catch (err) {
      throw new Error('Invalid refresh token');
    }
  }

  async revokeRefreshToken(
    { refreshToken }: { refreshToken: string }
  ): Promise<{ ok: boolean }> {
    const user = await this.storage.get<User>(AUTH_DATA_KEY);
    if (!user) throw new Error('User not found');

    user.refreshTokens = user.refreshTokens.filter(token => token !== refreshToken);
    await this.storage.put(AUTH_DATA_KEY, user);
    return { ok: true };
  }

  async revokeAllRefreshTokens(): Promise<{ ok: boolean }> {
    const user = await this.storage.get<User>(AUTH_DATA_KEY);
    if (!user) throw new Error('User not found');

    user.refreshTokens = [];
    await this.storage.put(AUTH_DATA_KEY, user);
    return { ok: true };
  }

  async logout(): Promise<{ ok: boolean }> {
    return this.revokeAllRefreshTokens();
  }

  public table<T extends z.ZodSchema>(
    name: string,
    schema: T,
    options?: TableOptions
  ) {
    return this.database.table(name, schema, options);
  }

  public get db() {
    return this.database.raw;
  }

  protected getCurrentUserId(): string {
    return this.state.id.toString();
  }

  // WebSocket connection handling using Hibernation API
  async fetch(request: Request): Promise<Response> {
    // Handle WebSocket upgrades directly in the UserDO
    if (request.headers.get('upgrade') === 'websocket') {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      // Use hibernation API - this makes the WebSocket hibernatable
      this.ctx.acceptWebSocket(server);

      console.log('🔌 WebSocket accepted by UserDO with hibernation');

      // Send welcome message
      server.send(JSON.stringify({
        event: 'connected',
        message: 'WebSocket connected to UserDO!',
        timestamp: Date.now()
      }));

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // Handle other requests normally
    return new Response('Not Found', { status: 404 });
  }

  // WebSocket message handler (called by runtime when hibernated)
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    try {
      const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
      const parsed = JSON.parse(data);
      console.log('📨 UserDO WebSocket message received:', parsed);

      // Echo back
      ws.send(JSON.stringify({
        event: 'echo',
        original: parsed,
        message: 'Message received by UserDO',
        timestamp: Date.now()
      }));
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  }

  // WebSocket close handler (called by runtime when hibernated)
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    console.log('🔌 UserDO WebSocket closed:', { code, reason, wasClean });
  }

  // Broadcast to all connected WebSocket clients using hibernation API
  protected broadcast(event: string, data: any): void {
    const message = JSON.stringify({ event, data, timestamp: Date.now() });

    // Use hibernation API to get all connected WebSockets
    const webSockets = this.ctx.getWebSockets();

    console.log(`📡 UserDO Broadcasting to ${webSockets.length} WebSocket clients:`, { event, data });

    for (const ws of webSockets) {
      try {
        ws.send(message);
      } catch (error) {
        console.error('Broadcast error:', error);
        // WebSocket will be automatically cleaned up by runtime
      }
    }
  }

}

export default {};
