import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService {
  constructor(@Inject('REDIS_CLIENT') private readonly client: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }


  async set(key: string, value: string, ttlSeconds?: number): Promise<'OK'> {
    if (ttlSeconds) {
      return this.client.set(key, value, 'EX', ttlSeconds);
    }
    return this.client.set(key, value);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async decr(key: string): Promise<number> {
  return this.client.decr(key);
}

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    return this.client.expire(key, ttlSeconds);
  }

  // --- Lua Script helpers ---
  async loadScript(script: string): Promise<string> {
    const sha = await this.client.script('LOAD', script);
    return sha as string;
  }

  async flushScripts(): Promise<'OK'> {
    const result = await this.client.script('FLUSH');
    return result as 'OK';
  }

  async killScript(): Promise<'OK'> {
    const result = await this.client.script('KILL');
    return result as 'OK';
  }

  async eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<any> {
    return this.client.eval(script, numKeys, ...args);
  }

  async evalsha(
    sha: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<any> {
    return this.client.evalsha(sha, numKeys, ...args);
  }

  getClient(): Redis {
    return this.client; // expose raw Redis client for BullMQ Worker/Queue
  }
}
