@Get('usage')
async getUsage(@CurrentUser() user: any, @Param('workspaceId') wsId: string) {
  const date = new Date();
  const keyBase = `quota:${wsId}`;
  const suffix = `${date.getFullYear()}-${date.getMonth() + 1}`;

  const [textUsed, imageUsed] = await Promise.all([
    this.redis.get(`${keyBase}:TEXT:${suffix}`),
    this.redis.get(`${keyBase}:IMAGE:${suffix}`)
  ]);

  const limits = this.quotaService.getPlanLimits(user);

  return {
    text: { used: Number(textUsed || 0), limit: limits.textLimit },
    image: { used: Number(imageUsed || 0), limit: limits.imageLimit }
  };
}