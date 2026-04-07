export type MetaSendMode = 'PAGE_SEND_API' | 'IG_MESSAGING_API';

export type MetaRecipient = {
  // Instagram-scoped ID (IGSID) / PSID depending on product.
  id: string;
};

export type MetaAttachmentType = 'image' | 'video' | 'audio' | 'file';

export type MetaSendTextRequest = {
  accessToken: string;
  recipient: MetaRecipient;
  text: string;
  // for IG_MESSAGING_API mode, you must provide igId (the IG professional account id)
  igId?: string;
  // for PAGE_SEND_API mode, you can optionally provide pageId
  pageId?: string;
  messagingType?: 'RESPONSE' | 'UPDATE' | 'MESSAGE_TAG'; // Messenger Platform concept
};

export type MetaSendAttachmentRequest = {
  accessToken: string;
  recipient: MetaRecipient;
  type: MetaAttachmentType;
  url: string;
  igId?: string;
  pageId?: string;
  isReusable?: boolean;
};

export type MetaSendResult = {
  provider: 'META';
  messageId?: string;
  recipientId?: string;
  raw: any;
};

export type MetaProfileResult = {
  id: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
  raw: any;
};
