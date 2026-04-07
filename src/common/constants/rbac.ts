// --- SCOPE ---
export const PermissionScope = {
  SYSTEM: 'SYSTEM',
  ORGANIZATION: 'ORGANIZATION',
  WORKSPACE: 'WORKSPACE',
} as const;

export type PermissionScope = typeof PermissionScope[keyof typeof PermissionScope];

export const PermissionResource = {
  // --- SYSTEM SCOPE ---
  SYSTEM_USERS : 'SYSTEM_USERS',
  SYSTEM_ORGANIZATIONS: 'SYSTEM_ORGANIZATIONS',
  SYSTEM_BILLING: 'SYSTEM_BILLING',

  // --- ORGANIZATION SCOPE ---
  ORGANIZATION: 'ORGANIZATION',
  ORG_MEMBERS: 'ORG_MEMBERS',
  ORG_BILLING: 'ORG_BILLING',
  ORG_SETTINGS: 'ORG_SETTINGS',
  SUBSCRIPTION: 'SUBSCRIPTION',
  INTEGRATION: 'INTEGRATION',
  INVITATIONS: 'INVITATIONS',
  AUDIT_LOGS: 'AUDIT_LOGS',

  // --- WORKSPACE SCOPE ---
  WORKSPACE: 'WORKSPACE',
  WORKSPACE_SETTINGS: 'WORKSPACE_SETTINGS',
  WORKSPACE_MEMBERS: 'WORKSPACE_MEMBERS', // Alias for team management inside a workspace
  PROFILE_ACCESS: 'PROFILE_ACCESS',      // Granular assignment of social accounts
  SOCIAL_PROFILE: 'SOCIAL_PROFILE',      // Connected Facebook/X accounts
  POSTS: 'POSTS',
  APPROVAL: 'APPROVAL',                  // Kanban workflow
  CAMPAIGN: 'CAMPAIGN',                  // Grouping posts together
  CONTENT: 'CONTENT',                    // Media library / Assets
  SCHEDULING: 'SCHEDULING',              // Queue slots
  ANALYTICS: 'ANALYTICS',
  INBOX: 'INBOX',                        // Consolidated DMs and Messages
  COMMENTS: 'COMMENTS',                    // Public post replies
  INTERNAL_COMMENT: 'INTERNAL_COMMENT',  // Team chatter
  AI_CONTENT: 'AI_CONTENT',
  AI_USAGE: 'AI_USAGE',
  TEMPLATE: 'TEMPLATE',
  NOTIFICATION: 'NOTIFICATION',
} as const;

export type PermissionResource = typeof PermissionResource[keyof typeof PermissionResource];


export const PermissionAction = {
  // Standard CRUD
  CREATE : 'CREATE',
  READ : 'READ',
  UPDATE : 'UPDATE',
  DELETE : 'DELETE',
  MANAGE : 'MANAGE',

  // Domain-Specific (Workflow & Social)
  PUBLISH : 'PUBLISH',   // Send to social network
  APPROVE : 'APPROVE',   // Workflow approval
  REJECT : 'REJECT',     // Workflow rejection
  SUBMIT : 'SUBMIT',     // Send for review
  ASSIGN : 'ASSIGN',     // Task/Post delegation
  INVITE : 'INVITE',     // Add a user
  CONNECT : 'CONNECT',   // Link a social account (OAuth)
  DISCONNECT : 'DISCONNECT', // Unlink a social account
  EXPORT : 'EXPORT',
} as const;

export type PermissionAction = typeof PermissionAction[keyof typeof PermissionAction];

// --- UTILS ---
export const ALL_ACTIONS = Object.values(PermissionAction) as PermissionAction[];