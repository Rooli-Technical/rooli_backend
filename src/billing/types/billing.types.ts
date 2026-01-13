export interface PlanFeatures {
  // --- Core Features ---
  canRemoveBranding: boolean;
  whiteLabelReports: boolean;
  advancedAnalytics: boolean;
  approvalWorkflow: boolean;
  prioritySupport: boolean;
  mediaLibrary: boolean;
  
  // --- Module Access Flags ---
  hasCampaigns?: boolean;  
  hasLabels?: boolean;
  bulkScheduling?: boolean;
  queueScheduling?: boolean;
  aiContentGeneration?: boolean;

  // --- Enterprise Extras ---
  dedicatedAccountManager?: boolean;
  sla?: boolean;
  customIntegrations?: boolean;
}