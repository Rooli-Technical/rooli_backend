import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface ContextData {
  orgId: string;
  workspaceId?: string;
  role: any;
  memberId: string;
}

export const ActiveContext = createParamDecorator(
  (data: keyof ContextData | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const context = {
      orgId: request.orgId,
      workspaceId: request.workspaceId,
      role: request.currentRole,
      memberId: request.orgMember?.id,
    };

    return data ? context[data] : context;
  },
);