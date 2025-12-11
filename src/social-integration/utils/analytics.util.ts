export function logPlatformError(platform: string, entity: string, error: any) {
    const msg = error.response?.data?.error?.message || error.message;
    this.logger.error(`[${platform}] Failed sync for ${entity}: ${msg}`);
  }

  // Batching Utility to prevent API rate limiting
export async function processInBatches<T>(items: T[], handler: (item: T) => Promise<void>) {
    for (let i = 0; i < items.length; i += this.BATCH_SIZE) {
      const batch = items.slice(i, i + this.BATCH_SIZE);
      await Promise.allSettled(batch.map((item) => handler(item)));
    }
  }