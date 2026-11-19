export interface ServerConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly snapshotEvery: number;
  readonly instanceId: string;
  readonly redisUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL ?? 'postgres://localhost:5432/collab',
    snapshotEvery: Number(env.SNAPSHOT_EVERY ?? 1000),
    instanceId: env.INSTANCE_ID ?? `instance-${process.pid}`,
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  };
}
